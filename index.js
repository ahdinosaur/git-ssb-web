var fs = require('fs')
var http = require('http')
var path = require('path')
var url = require('url')
var qs = require('querystring')
var util = require('util')
var ref = require('ssb-ref')
var pull = require('pull-stream')
var ssbGit = require('ssb-git-repo')
var toPull = require('stream-to-pull-stream')
var cat = require('pull-cat')
var GitRepo = require('pull-git-repo')
var u = require('./lib/util')
var markdown = require('./lib/markdown')
var paginate = require('pull-paginate')
var asyncMemo = require('asyncmemo')
var multicb = require('multicb')
var schemas = require('ssb-msg-schemas')
var Issues = require('ssb-issues')
var PullRequests = require('ssb-pull-requests')
var paramap = require('pull-paramap')
var Mentions = require('ssb-mentions')
var many = require('pull-many')
var ident = require('pull-identify-filetype')
var mime = require('mime-types')
var moment = require('moment')
var LRUCache = require('lrucache')

var hlCssPath = path.resolve(require.resolve('highlight.js'), '../../styles')
var emojiPath = path.resolve(require.resolve('emoji-named-characters'), '../pngs')

function ParamError(msg) {
  var err = Error.call(this, msg)
  err.name = ParamError.name
  return err
}
util.inherits(ParamError, Error)

function parseAddr(str, def) {
  if (!str) return def
  var i = str.lastIndexOf(':')
  if (~i) return {host: str.substr(0, i), port: str.substr(i+1)}
  if (isNaN(str)) return {host: str, port: def.port}
  return {host: def.host, port: str}
}

function tryDecodeURIComponent(str) {
  if (!str || (str[0] == '%' && ref.isBlobId(str)))
    return str
  try {
    str = decodeURIComponent(str)
  } finally {
    return str
  }
}

function getContentType(filename) {
  var ext = u.getExtension(filename)
  return contentTypes[ext] || u.imgMimes[ext] || 'text/plain; charset=utf-8'
}

var contentTypes = {
  css: 'text/css'
}

function readReqForm(req, cb) {
  pull(
    toPull(req),
    pull.collect(function (err, bufs) {
      if (err) return cb(err)
      var data
      try {
        data = qs.parse(Buffer.concat(bufs).toString('ascii'))
      } catch(e) {
        return cb(e)
      }
      cb(null, data)
    })
  )
}

var msgTypes = {
  'git-repo': true,
  'git-update': true,
  'issue': true,
  'pull-request': true
}

module.exports = {
  name: 'git-ssb-web',
  version: require('./package').version,
  manifest: {},
  init: function (ssb, config) {
    var web = new GitSSBWeb(ssb, config)
    return {}
  }
}

function GitSSBWeb(ssb, config) {
  this.ssb = ssb
  this.config = config

  if (config.logging && config.logging.level)
    this.logLevel = this.logLevels.indexOf(config.logging.level)
  this.ssbAppname = config.appname || 'ssb'
  this.isPublic = config.public
  this.getVotes = require('./lib/votes')(ssb)
  this.getMsg = asyncMemo({cache: new LRUCache(100)}, this.getMsgRaw)
  this.issues = Issues.init(ssb)
  this.pullReqs = PullRequests.init(ssb)
  this.getRepo = asyncMemo({
    cache: new LRUCache(32)
  }, function (id, cb) {
    if (id[0] === '#') return ssbGit.getRepo(ssb, id, {live: true}, cb)
    this.getMsg(id, function (err, msg) {
      if (err) return cb(err)
      if (msg.private && this.isPublic) return cb(new Error('Private Repo'))
      ssbGit.getRepo(ssb, msg, {live: true}, cb)
    })
  })

  this.about = function (id, cb) { cb(null, {name: id}) }
  ssb.whoami(function (err, feed) {
    this.myId = feed.id
    this.about = require('./lib/about')(ssb, this.myId)
  }.bind(this))

  this.i18n = require('./lib/i18n')(path.join(__dirname, 'locale'), 'en')
  this.users = require('./lib/users')(this)
  this.repos = require('./lib/repos')(this)

  var webConfig = config['git-ssb-web'] || {}

  if (webConfig.computeIssueCounts !== false) {
    this.indexCache = require('./lib/index-cache')(ssb)
  }

  this.serveAcmeChallenge = require('./lib/acme-challenge')(ssb)

  var addr = parseAddr(config.listenAddr, {
    host: webConfig.host || 'localhost',
    port: webConfig.port || 7718
  })
  this.listen(addr.host, addr.port)

  this.monitorSsbClient()
}

var G = GitSSBWeb.prototype

G.logLevels = ['error', 'warning', 'notice', 'info']
G.logLevel = G.logLevels.indexOf('notice')

G.log = function (level) {
  if (this.logLevels.indexOf(level) > this.logLevel) return
  console.log.apply(console, [].slice.call(arguments, 1))
}

G.listen = function (host, port) {
  this.httpServer = http.createServer(G_onRequest.bind(this))
  this.httpServer.listen(port, host, function () {
    var hostName = ~host.indexOf(':') ? '[' + host + ']' : host
    this.log('notice', 'Listening on http://' + hostName + ':' + port + '/')
  }.bind(this))
}

G.getRepoName = function (ownerId, repoId, cb) {
  if (!repoId) return cb(null, '?')
  if (repoId[0] === '#') return cb(null, repoId)
  this.about.getName({
    owner: ownerId,
    target: repoId
  }, cb)
}

G.getRepoFullName = function (author, repoId, cb) {
  var done = multicb({ pluck: 1, spread: true })
  this.getRepoName(author, repoId, done())
  this.about.getName(author, done())
  done(cb)
}

G.addAuthorName = function () {
  var about = this.about
  return paramap(function (msg, cb) {
    var author = msg && msg.value && msg.value.author
    if (!author) return cb(null, msg)
    about.getName(author, function (err, authorName) {
      msg.authorName = authorName
      cb(err, msg)
    })
  }, 8)
}

/* Serving a request */

function serve(req, res) {
  return pull(
    pull.filter(function (data) {
      if (Array.isArray(data)) {
        res.writeHead.apply(res, data)
        return false
      }
      return true
    }),
    toPull(res)
  )
}

function G_onRequest(req, res) {
  this.log('info', req.method, req.url)

  if (req.url.startsWith('/.well-known/acme-challenge'))
    return this.serveAcmeChallenge(req, res)

  req._u = url.parse(req.url, true)
  var locale = req._u.query.locale ||
    (/locale=([^;]*)/.exec(req.headers.cookie) || [])[1]
  var reqLocales = req.headers['accept-language']
  var locales = reqLocales ? reqLocales.split(/, */).map(function (item) {
    return item.split(';')[0]
  }) : []
  req._locale = locales[0] || locale || this.i18n.fallback

  this.i18n.pickCatalog(reqLocales, locale, function (err, t) {
    if (err) return pull(this.serveError(req, err, 500), serve(req, res))
    req._t = t
    pull(this.handleRequest(req), serve(req, res))
  }.bind(this))
}

G.handleRequest = function (req) {
  var path = req._u.pathname.slice(1)
  var dirs = ref.isLink(path) ? [path] :
    path.split(/\/+/).map(tryDecodeURIComponent)
  var dir = dirs[0]

  if (req.method == 'POST')
    return this.handlePOST(req, dir)

  if (dir == '')
    return this.serveIndex(req)
  else if (dir == 'search')
    return this.serveSearch(req)
  else if (dir[0] === '#')
    return this.serveChannel(req, dir, dirs.slice(1))
  else if (ref.isBlobId(dir))
    return this.serveBlob(req, dir)
  else if (ref.isMsgId(dir))
    return this.serveMessage(req, dir, dirs.slice(1))
  else if (ref.isFeedId(dir))
    return this.users.serveUserPage(req, dir, dirs.slice(1))
  else if (dir == 'static')
    return this.serveFile(req, dirs)
  else if (dir == 'highlight')
    return this.serveFile(req, [hlCssPath].concat(dirs.slice(1)), true)
  else if (dir == 'emoji')
    return this.serveFile(req, [emojiPath].concat(dirs.slice(1)), true)
  else
    return this.serve404(req)
}

G.handlePOST = function (req, dir) {
  var self = this
  if (self.isPublic)
    return self.serveBuffer(405, req._t('error.POSTNotAllowed'))
  return u.readNext(function (cb) {
    readReqForm(req, function (err, data) {
      if (err) return cb(null, self.serveError(req, err, 400))
      if (!data) return cb(null, self.serveError(req,
        new ParamError(req._t('error.MissingData')), 400))

      switch (data.action) {
        case 'fork-prompt':
          return cb(null, self.serveRedirect(req,
            u.encodeLink([data.id, 'fork'])))

        case 'fork':
          if (!data.id)
            return cb(null, self.serveError(req,
              new ParamError(req._t('error.MissingId')), 400))
          return ssbGit.createRepo(self.ssb, {upstream: data.id},
            function (err, repo) {
              if (err) return cb(null, self.serveError(req, err))
              cb(null, self.serveRedirect(req, u.encodeLink(repo.id)))
            })

        case 'vote':
          var voteValue = +data.value || 0
          if (!data.id)
            return cb(null, self.serveError(req,
              new ParamError(req._t('error.MissingId')), 400))
          var msg = schemas.vote(data.id, voteValue)
          return self.ssb.publish(msg, function (err) {
            if (err) return cb(null, self.serveError(req, err))
            cb(null, self.serveRedirect(req, req.url))
          })

      case 'repo-name':
        if (!data.id)
          return cb(null, self.serveError(req,
            new ParamError(req._t('error.MissingId')), 400))
        if (!data.name)
          return cb(null, self.serveError(req,
            new ParamError(req._t('error.MissingName')), 400))
        var msg = schemas.name(data.id, data.name)
        return self.ssb.publish(msg, function (err) {
          if (err) return cb(null, self.serveError(req, err))
          cb(null, self.serveRedirect(req, req.url))
        })

      case 'comment':
        if (!data.id)
          return cb(null, self.serveError(req,
            new ParamError(req._t('error.MissingId')), 400))
        var msg = schemas.post(data.text, data.id, data.branch || data.id)
        msg.issue = data.issue
        msg.repo = data.repo
        if (data.open != null)
          Issues.schemas.reopens(msg, data.id)
        if (data.close != null)
          Issues.schemas.closes(msg, data.id)
        var mentions = Mentions(data.text)
        if (mentions.length)
          msg.mentions = mentions
        return self.ssb.publish(msg, function (err) {
          if (err) return cb(null, self.serveError(req, err))
          cb(null, self.serveRedirect(req, req.url))
        })

      case 'line-comment':
        if (!data.repo)
          return cb(null, self.serveError(req,
            new ParamError('missing repo id'), 400))
        if (!data.commitId)
          return cb(null, self.serveError(req,
            new ParamError('missing commit id'), 400))
        if (!data.updateId)
          return cb(null, self.serveError(req,
            new ParamError('missing update id'), 400))
        if (!data.filePath)
          return cb(null, self.serveError(req,
            new ParamError('missing file path'), 400))
        if (!data.line)
          return cb(null, self.serveError(req,
            new ParamError('missing line number'), 400))
        var lineNumber = Number(data.line)
        if (isNaN(lineNumber))
          return cb(null, self.serveError(req,
            new ParamError('bad line number'), 400))
        var msg = {
          type: 'line-comment',
          text: data.text,
          repo: data.repo,
          updateId: data.updateId,
          commitId: data.commitId,
          filePath: data.filePath,
          line: lineNumber,
        }
        msg.issue = data.issue
        var mentions = Mentions(data.text)
        if (mentions.length)
          msg.mentions = mentions
        return self.ssb.publish(msg, function (err) {
          if (err) return cb(null, self.serveError(req, err))
          cb(null, self.serveRedirect(req, req.url))
        })

      case 'line-comment-reply':
        if (!data.root)
          return cb(null, self.serveError(req,
            new ParamError('missing thread root'), 400))
        if (!data.branch)
          return cb(null, self.serveError(req,
            new ParamError('missing thread branch'), 400))
        if (!data.text)
          return cb(null, self.serveError(req,
            new ParamError('missing post text'), 400))
        var msg = {
          type: 'post',
          root: data.root,
          branch: data.branch,
          text: data.text,
        }
        var mentions = Mentions(data.text)
        if (mentions.length)
          msg.mentions = mentions
        return self.ssb.publish(msg, function (err) {
          if (err) return cb(null, self.serveError(req, err))

          cb(null, self.serveRedirect(req, req.url))
        })

      case 'new-issue':
        var msg = Issues.schemas.new(dir, data.text)
        var mentions = Mentions(data.text)
        if (mentions.length)
          msg.mentions = mentions
        return self.ssb.publish(msg, function (err, msg) {
          if (err) return cb(null, self.serveError(req, err))
          cb(null, self.serveRedirect(req, u.encodeLink(msg.key)))
        })

      case 'new-pull':
        var msg = PullRequests.schemas.new(dir, data.branch,
          data.head_repo, data.head_branch, data.text)
        var mentions = Mentions(data.text)
        if (mentions.length)
          msg.mentions = mentions
        return self.ssb.publish(msg, function (err, msg) {
          if (err) return cb(null, self.serveError(req, err))
          cb(null, self.serveRedirect(req, u.encodeLink(msg.key)))
        })

      case 'markdown':
        return cb(null, self.serveMarkdown(data.text, {id: data.repo}))

      default:
        cb(null, self.serveBuffer(400, req._t('error.UnknownAction', data)))
      }
    })
  })
}

G.serveFile = function (req, dirs, outside) {
  var filename = path.resolve.apply(path, [__dirname].concat(dirs))
  // prevent escaping base dir
  if (!outside && filename.indexOf('../') === 0)
    return this.serveBuffer(403, req._t("error.403Forbidden"))

  return u.readNext(function (cb) {
    fs.stat(filename, function (err, stats) {
      cb(null, err ?
        err.code == 'ENOENT' ? this.serve404(req)
        : this.serveBuffer(500, err.message)
      : u.ifModifiedSince(req, stats.mtime) ?
        pull.once([304])
      : stats.isDirectory() ?
        this.serveBuffer(403, req._t('error.DirectoryNotListable'))
      : cat([
        pull.once([200, {
          'Content-Type': getContentType(filename),
          'Content-Length': stats.size,
          'Last-Modified': stats.mtime.toGMTString()
        }]),
        toPull(fs.createReadStream(filename))
      ]))
    }.bind(this))
  }.bind(this))
}

G.serveBuffer = function (code, buf, contentType, headers) {
  headers = headers || {}
  headers['Content-Type'] = contentType || 'text/plain; charset=utf-8'
  headers['Content-Length'] = Buffer.byteLength(buf)
  return pull.values([
    [code, headers],
    buf
  ])
}

G.serve404 = function (req) {
  return this.serveBuffer(404, req._t("error.404NotFound"))
}

G.serveRedirect = function (req, path) {
  return this.serveBuffer(302,
    '<!doctype><html><head>' +
    '<title>' + req._t('Redirect') + '</title></head><body>' +
    '<p><a href="' + u.escape(path) + '">' +
      req._t('Continue') + '</a></p>' +
    '</body></html>', 'text/html; charset=utf-8', {Location: path})
}

G.serveMarkdown = function (text, repo) {
  return this.serveBuffer(200, markdown(text, repo),
    'text/html; charset=utf-8')
}

G.renderError = function (err, tag) {
  tag = tag || 'h3'
  return '<' + tag + '>' + err.name + '</' + tag + '>' +
    '<pre>' + u.escape(err.stack) + '</pre>'
}

G.renderTry = function (read) {
  var self = this
  var ended
  return function (end, cb) {
    if (ended) return cb(ended)
    read(end, function (err, data) {
      if (err === true)
        cb(true)
      else if (err) {
        ended = true
        cb(null, self.renderError(err))
      } else
        cb(null, data)
    })
  }
}

G.serveTemplate = function (req, title, code, read) {
  var self = this
  if (read === undefined)
    return this.serveTemplate.bind(this, req, title, code)
  var q = req._u.query.q && u.escape(req._u.query.q) || ''
  var app = 'git ssb'
  var appName = this.ssbAppname
  if (req._t) app = req._t(app)
  return cat([
    pull.values([
      [code || 200, {
        'Content-Type': 'text/html'
      }],
      '<!doctype html><html><head><meta charset=utf-8>',
      '<title>' + app + (title != undefined ? ' - ' + title : '') + '</title>',
      '<link rel=stylesheet href="/static/styles.css"/>',
      '<link rel=stylesheet href="/highlight/foundation.css"/>',
      '</head>\n',
      '<body>',
      '<header>'
    ]),
    self.isPublic ? null : u.readOnce(function (cb) {
      self.about(self.myId, function (err, about) {
        if (err) return cb(err)
        cb(null,
          '<a href="' + u.encodeLink(self.myId) + '">' +
            (about.image ?
              '<img class="profile-icon icon-right"' +
              ' src="/' + encodeURIComponent(about.image) + '"' +
              ' alt="' + u.escape(about.name) + '">' : u.escape(about.name)) +
          '</a>')
      })
    }),
    pull.once(
      '<form action="/search" method="get">' +
      '<h1><a href="/">' + app +
        (appName == 'ssb' ? '' : ' <sub>' + appName + '</sub>') +
      '</a></h1> ' +
      '<input class="search-bar" name="q" size="60"' +
        ' placeholder=" Search" value="' + q + '" />' +
      '</form>' +
      '</header>' +
      '<article><hr />'),
    this.renderTry(read),
    pull.once('<hr/><p style="font-size: .8em;">Built with <a href="http://git-ssb.celehner.com">git-ssb-web</a></p></article></body></html>')
  ])
}

G.serveError = function (req, err, status) {
  return pull(
    pull.once(this.renderError(err, 'h2')),
    this.serveTemplate(req, err.name, status || 500)
  )
}

G.renderObjectData = function (obj, filename, repo, rev, path) {
  var ext = u.getExtension(filename)
  return u.readOnce(function (cb) {
    u.readObjectString(obj, function (err, buf) {
      buf = buf.toString('utf8')
      if (err) return cb(err)
      cb(null, (ext == 'md' || ext == 'markdown')
        ? markdown(buf, {repo: repo, rev: rev, path: path})
        : buf.length > 1000000 ? ''
        : renderCodeTable(buf, ext))
    })
  })
}

function renderCodeTable(buf, ext) {
  return '<pre><table class="code">' +
    u.highlight(buf, ext).split('\n').map(function (line, i) {
      i++
      return '<tr id="L' + i + '">' +
        '<td class="code-linenum">' + '<a href="#L' + i + '">' + i + '</td>' +
        '<td class="code-text">' + line + '</td></tr>'
    }).join('') +
    '</table></pre>'
}

/* Feed */

G.renderFeed = function (req, feedId, filter) {
  var query = req._u.query
  var opts = {
    reverse: !query.forwards,
    lt: query.lt && +query.lt || Date.now(),
    gt: query.gt ? +query.gt : -Infinity,
    id: feedId
  }
  return pull(
    feedId ? this.ssb.createUserStream(opts) : this.ssb.createFeedStream(opts),
    u.decryptMessages(this.ssb),
    u.readableMessages(),
    pull.filter(function (msg) {
      var c = msg.value.content
      return c.type in msgTypes
        || (c.type == 'post' && c.repo && c.issue)
    }),
    typeof filter == 'function' ? filter(opts) : filter,
    pull.take(100),
    this.addAuthorName(),
    query.forwards && u.pullReverse(),
    paginate(
      function (first, cb) {
        if (!query.lt && !query.gt) return cb(null, '')
        var gt = feedId ? first.value.sequence : first.value.timestamp + 1
        query.gt = gt
        query.forwards = 1
        delete query.lt
        cb(null, '<a href="?' + qs.stringify(query) + '">' +
          req._t('Next') + '</a>')
      },
      paramap(this.renderFeedItem.bind(this, req), 8),
      function (last, cb) {
        query.lt = feedId ? last.value.sequence : last.value.timestamp - 1
        delete query.gt
        delete query.forwards
        cb(null, '<a href="?' + qs.stringify(query) + '">' +
          req._t('Previous') + '</a>')
      },
      function (cb) {
        if (query.forwards) {
          delete query.gt
          delete query.forwards
          query.lt = opts.gt + 1
        } else {
          delete query.lt
          query.gt = opts.lt - 1
          query.forwards = 1
        }
        cb(null, '<a href="?' + qs.stringify(query) + '">' +
          req._t(query.forwards ? 'Older' : 'Newer') + '</a>')
      }
    )
  )
}

G.renderFeedItem = function (req, msg, cb) {
  var self = this
  var c = msg.value.content
  var msgDate = moment(new Date(msg.value.timestamp)).fromNow()
  var msgDateLink = u.link([msg.key], msgDate, false, 'class="date"')
  var author = msg.value.author
  var authorLink = u.link([msg.value.author], msg.authorName)
  var privateIconMaybe = msg.value.private ? ' ' + u.privateIcon(req) : ''
  switch (c.type) {
    case 'git-repo':
      var done = multicb({ pluck: 1, spread: true })
      self.getRepoName(author, msg.key, done())
      if (c.upstream) {
        return self.getMsg(c.upstream, function (err, upstreamMsg) {
          if (err) return cb(null, self.serveError(req, err))
          self.getRepoName(upstreamMsg.value.author, c.upstream, done())
          done(function (err, repoName, upstreamName) {
            cb(null, '<section class="collapse">' +
              req._t('Forked', {
                name: authorLink,
                upstream: u.link([c.upstream], upstreamName),
                repo: u.link([msg.key], repoName)
              }) + ' ' + msgDateLink + privateIconMaybe + '</section>')
          })
        })
      } else {
        return done(function (err, repoName) {
          if (err) return cb(err)
          var repoLink = u.link([msg.key], repoName)
          cb(null, '<section class="collapse">' +
            req._t('CreatedRepo', {
              name: authorLink,
              repo: repoLink
            }) + ' ' + msgDateLink + privateIconMaybe +
            (msg.value.private ?
              '<br>' + req._t('repo.Recipients') + '<ul>' +
              (Array.isArray(c.recps) ? c.recps : []).map(function (feed) {
                return '<li>' + u.link([feed], feed) + '</li>'
              }).join('') + '</ul>'
            : '') +
          '</section>')
        })
      }
    case 'git-update':
      return self.getRepoName(author, c.repo, function (err, repoName) {
        if (err) return cb(err)
        var repoLink = u.link([c.repo], repoName)
        cb(null, '<section class="collapse">' +
          req._t('Pushed', {
            name: authorLink,
            repo: repoLink
          }) + ' ' + msgDateLink + privateIconMaybe + '</section>')
      })
    case 'issue':
    case 'pull-request':
      var issueLink = u.link([msg.key], u.messageTitle(msg))
      // TODO: handle hashtag in project property
      return self.getMsg(c.project, function (err, projectMsg) {
        if (err) return cb(null,
          self.repos.serveRepoNotFound(req, c.repo, err))
        self.getRepoName(projectMsg.value.author, c.project,
          function (err, repoName) {
            if (err) return cb(err)
            var repoLink = u.link([c.project], repoName)
            cb(null, '<section class="collapse">' +
              req._t('OpenedIssue', {
                name: authorLink,
                type: req._t(c.type == 'pull-request' ?
                  'pull request' : 'issue.'),
                title: issueLink,
                project: repoLink
              }) + ' ' + msgDateLink + privateIconMaybe + '</section>')
          })
      })
    case 'about':
      return cb(null, '<section class="collapse">' +
        req._t('Named', {
          author: authorLink,
          target: '<tt>' + u.escape(c.about) + '</tt>',
          name: u.link([c.about], c.name)
        }) + ' ' + msgDateLink + privateIconMaybe + '</section>')
    case 'post':
      return this.pullReqs.get(c.issue, function (err, pr) {
        if (err) return cb(err)
        var type = pr.msg.value.content.type == 'pull-request' ?
          'pull request' : 'issue.'
        var changed = self.issues.isStatusChanged(msg, pr)
        return cb(null, '<section class="collapse">' +
          req._t(changed == null ? 'CommentedOn' :
              changed ? 'ReopenedIssue' : 'ClosedIssue', {
            name: authorLink,
            type: req._t(type),
            title: u.link([pr.id], pr.title, true)
          }) + ' ' + msgDateLink + privateIconMaybe +
          (c.text ? '<blockquote>' + markdown(c.text) + '</blockquote>' : '') +
          '</section>')
      })
    default:
      return cb(null, u.json(msg))
  }
}

/* Index */

G.serveIndex = function (req) {
  return this.serveTemplate(req)(this.renderFeed(req))
}

G.serveChannel = function (req, id, path) {
  var self = this
  return u.readNext(function (cb) {
    self.getRepo(id, function (err, repo) {
      if (err) return cb(null, self.serveError(req, err))
      cb(null, self.repos.serveRepoPage(req, GitRepo(repo), path))
    })
  })
}

G.serveMessage = function (req, id, path) {
  var self = this
  return u.readNext(function (cb) {
    self.getMsg(id, function (err, msg) {
      if (err) return cb(null, self.serveError(req, err))
      var c = msg && msg.value && msg.value.content || {}
      switch (c.type) {
        case 'git-repo':
          return self.getRepo(id, function (err, repo) {
            if (err) return cb(null, self.serveError(req, err))
            cb(null, self.repos.serveRepoPage(req, GitRepo(repo), path))
          })
        case 'git-update':
          return self.getRepo(c.repo, function (err, repo) {
            if (err) return cb(null,
              self.repos.serveRepoNotFound(req, c.repo, err))
            cb(null, self.repos.serveRepoUpdate(req,
              GitRepo(repo), msg, path))
          })
        case 'issue':
          return self.getRepo(c.project, function (err, repo) {
            if (err) return cb(null,
              self.repos.serveRepoNotFound(req, c.project, err))
            self.issues.get(id, function (err, issue) {
              if (err) return cb(null, self.serveError(req, err))
              cb(null, self.repos.issues.serveRepoIssue(req,
                GitRepo(repo), issue, path))
            })
          })
        case 'pull-request':
          return self.getRepo(c.repo, function (err, repo) {
            if (err) return cb(null,
              self.repos.serveRepoNotFound(req, c.project, err))
            self.pullReqs.get(id, function (err, pr) {
              if (err) return cb(null, self.serveError(req, err))
              cb(null, self.repos.pulls.serveRepoPullReq(req,
                GitRepo(repo), pr, path))
            })
          })
        case 'line-comment':
          return self.getRepo(c.repo, function (err, repo) {
            if (err) return cb(null,
              self.repos.serveRepoNotFound(req, c.repo, err))
            return cb(null,
              self.repos.serveRepoCommit(req, GitRepo(repo), c.commitId, c.filename))
          })
        case 'issue-edit':
          if (ref.isMsgId(c.issue)) {
            return self.pullReqs.get(c.issue, function (err, issue) {
              if (err) return cb(err)
              self.getRepo(issue.project, function (err, repo) {
                if (err) {
                  if (!repo) return cb(null,
                    self.repos.serveRepoNotFound(req, c.repo, err))
                  return cb(null, self.serveError(req, err))
                }
                cb(null, self.repos.serveIssueOrPullRequest(req, GitRepo(repo),
                  issue, path, id))
              })
            })
          }
          // fallthrough
        case 'post':
          if (ref.isMsgId(c.issue) && ref.isMsgId(c.repo)) {
            // comment on an issue
            var done = multicb({ pluck: 1, spread: true })
            self.getRepo(c.repo, done())
            self.pullReqs.get(c.issue, done())
            return done(function (err, repo, issue) {
              if (err) {
                if (!repo) return cb(null,
                  self.repos.serveRepoNotFound(req, c.repo, err))
                return cb(null, self.serveError(req, err))
              }
              cb(null, self.repos.serveIssueOrPullRequest(req, GitRepo(repo),
                issue, path, id))
            })
          } else if (ref.isMsgId(c.root)) {
            // comment on issue from patchwork?
            return self.getMsg(c.root, function (err, root) {
              var rc = root.value && root.value.content && root.value.content
              if (err) return cb(null, self.serveError(req, err))
              var repoId = rc.repo || rc.project
              if (!ref.isMsgId(repoId))
                return cb(null, self.serveGenericMessage(req, msg, path))
              self.getRepo(repoId, function (err, repo) {
                if (err) return cb(null, self.serveError(req, err))
                switch (rc && rc.type) {
                  case 'issue':
                    return self.issues.get(c.root, function (err, issue) {
                      if (err) return cb(null, self.serveError(req, err))
                      return cb(null,
                        self.repos.issues.serveRepoIssue(req,
                          GitRepo(repo), issue, path, id))
                    })
                  case 'pull-request':
                    return self.pullReqs.get(c.root, function (err, pr) {
                      if (err) return cb(null, self.serveError(req, err))
                      return cb(null,
                        self.repos.pulls.serveRepoPullReq(req,
                          GitRepo(repo), pr, path, id))
                    })
                  case 'line-comment':
                    return cb(null,
                      self.repos.serveRepoCommit(req, GitRepo(repo), rc.commitId, rc.filename))
                  default:
                    return cb(null, self.serveGenericMessage(req, msg, path))
                }
              })
            })
          }
          // fallthrough
        default:
          if (ref.isMsgId(c.repo))
            return self.getRepo(c.repo, function (err, repo) {
              if (err) return cb(null,
                self.repos.serveRepoNotFound(req, c.repo, err))
              cb(null, self.repos.serveRepoSomething(req,
                GitRepo(repo), id, msg, path))
            })
          else
            return cb(null, self.serveGenericMessage(req, msg, path))
      }
    })
  })
}

G.serveGenericMessage = function (req, msg, path) {
  return this.serveTemplate(req, msg.key)(pull.once(
    '<section><h2>' + u.link([msg.key]) + '</h2>' +
    u.json(msg.value) +
    '</section>'))
}

/* Search */

G.serveSearch = function (req) {
  var self = this
  var q = String(req._u.query.q || '')
  if (!q) return this.serveIndex(req)
  var qId = q.replace(/^ssb:\/*/, '')
  if (ref.type(qId))
    return this.serveRedirect(req, encodeURIComponent(qId))

  var search = new RegExp(q, 'i')
  return this.serveTemplate(req, req._t('Search') + ' &middot; ' + q, 200)(
    this.renderFeed(req, null, function (opts) {
      return function (read) {
        return pull(
          many([
            self.getMsgs('about', opts),
            read
          ]),
          pull.filter(function (msg) {
            var c = msg.value.content
            return (
              search.test(msg.key) ||
              c.text && search.test(c.text) ||
              c.name && search.test(c.name) ||
              c.title && search.test(c.title))
          })
        )
      }
    })
  )
}

G.getMsgRaw = function (key, cb) {
  var self = this
  this.ssb.get(key, function (err, value) {
    if (err) return cb(err)
    u.decryptMessage(self.ssb, {key: key, value: value}, cb)
  })
}

G.getMsgs = function (type, opts) {
  return this.ssb.messagesByType({
    type: type,
    reverse: opts.reverse,
    lt: opts.lt,
    gt: opts.gt,
  })
}

G.serveBlobNotFound = function (req, repoId, err) {
  return this.serveTemplate(req, req._t('error.BlobNotFound'), 404)(pull.once(
    '<h2>' + req._t('error.BlobNotFound') + '</h2>' +
    '<p>' + req._t('error.BlobNotFoundInRepo', {
      repo: u.link([repoId])
    }) + '</p>' +
    '<pre>' + u.escape(err.stack) + '</pre>'
  ))
}

G.serveRaw = function (length, contentType) {
  var headers = {
    'Content-Type': contentType || 'text/plain; charset=utf-8',
    'Cache-Control': 'max-age=31536000'
  }
  if (length != null)
    headers['Content-Length'] = length
  return function (read) {
    return cat([pull.once([200, headers]), read])
  }
}

G.getBlob = function (req, key, cb) {
  var blobs = this.ssb.blobs
  // use size to check for blob's presence, since has or want may broadcast
  blobs.size(key, function (err, size) {
    if (typeof size === 'number') cb(null, blobs.get(key))
    else blobs.want(key, function (err, got) {
      if (err) cb(err)
      else if (!got) cb(new Error(req._t('error.MissingBlob', {key: key})))
      else cb(null, blobs.get(key))
    })
  })
}

G.serveBlob = function (req, key) {
  var self = this
  return u.readNext(function (cb) {
    self.getBlob(req, key, function (err, read) {
      if (err) cb(null, self.serveError(req, err))
      else if (!read) cb(null, self.serve404(req))
      else cb(null, identToResp(read))
    })
  })
}

function identToResp(read) {
  var ended, type, queue
  var id = ident(function (_type) {
    type = _type && mime.lookup(_type)
  })(read)
  return function (end, cb) {
    if (ended) return cb(ended)
    if (end) id(end, function (end) {
      cb(end === true ? null : end)
    })
    else if (queue) {
      var _queue = queue
      queue = null
      cb(null, _queue)
    }
    else if (!type)
      id(null, function (end, data) {
        if (ended = end) return cb(end)
        queue = data
        cb(null, [200, {
          'Content-Type': type || 'text/plain; charset=utf-8',
          'Cache-Control': 'max-age=31536000'
        }])
      })
    else
      id(null, cb)
  }
}

G.monitorSsbClient = function () {
  pull(
    function (abort, cb) {
      if (abort) throw abort
      setTimeout(function () {
        cb(null, 'keepalive')
      }, 15e3)
    },
    this.ssb.gossip.ping(),
    pull.drain(null, function (err) {
      // exit when the rpc connection ends
      if (err) console.error(err)
      console.error('sbot client connection closed. aborting')
      process.exit(1)
    })
  )
}

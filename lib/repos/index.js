var url = require('url')
var pull = require('pull-stream')
var once = pull.once
var cat = require('pull-cat')
var paramap = require('pull-paramap')
var multicb = require('multicb')
var JsDiff = require('diff')
var GitRepo = require('pull-git-repo')
var gitPack = require('pull-git-pack')
var u = require('../util')
var paginate = require('../paginate')
var markdown = require('../markdown')
var forms = require('../forms')
var ssbRef = require('ssb-ref')
var zlib = require('zlib')
var toPull = require('stream-to-pull-stream')
var h = require('pull-hyperscript')

module.exports = function (web) {
  return new RepoRoutes(web)
}

function RepoRoutes(web) {
  this.web = web
  this.issues = require('./issues')(this, web)
  this.pulls = require('./pulls')(this, web)
}

var R = RepoRoutes.prototype

function getRepoObjectString(repo, id, mode, cb) {
  if (!id) return cb(null, '')
  if (mode == 0160000) return cb(null,
    'Subproject commit ' + id)
  repo.getObjectFromAny(id, function (err, obj) {
    if (err) return cb(err)
    u.readObjectString(obj, cb)
  })
}

/* Repo */

R.serveRepoPage = function (req, repo, path) {
  var self = this
  var defaultBranch = 'master'
  var query = req._u.query

  if (query.rev != null) {
    // Allow navigating revs using GET query param.
    // Replace the branch in the path with the rev query value
    path[0] = path[0] || 'tree'
    path[1] = query.rev
    req._u.pathname = u.encodeLink([repo.id].concat(path))
    delete req._u.query.rev
    delete req._u.search
    return self.web.serveRedirect(req, url.format(req._u))
  }

  // get branch
  return path[1] ?
    R_serveRepoPage2.call(self, req, repo, path) :
    u.readNext(function (cb) {
      // TODO: handle this in pull-git-repo or ssb-git-repo
      repo.getSymRef('HEAD', true, function (err, ref) {
        if (err) return cb(err)
        repo.resolveRef(ref, function (err, rev) {
          path[1] = rev ? ref : null
          cb(null, R_serveRepoPage2.call(self, req, repo, path))
        })
      })
    })
}

function R_serveRepoPage2(req, repo, path) {
  var branch = path[1]
  var filePath = path.slice(2)
  switch (path[0]) {
    case undefined:
    case '':
      return this.serveRepoTree(req, repo, branch, [])
    case 'activity':
      return this.serveRepoActivity(req, repo, branch)
    case 'commits':
      return this.serveRepoCommits(req, repo, branch)
    case 'commit':
      return this.serveRepoCommit(req, repo, path[1])
    case 'tag':
      return this.serveRepoTag(req, repo, branch, filePath)
    case 'tree':
      return this.serveRepoTree(req, repo, branch, filePath)
    case 'blob':
      return this.serveRepoBlob(req, repo, branch, filePath)
    case 'raw':
      return this.serveRepoRaw(req, repo, branch, filePath)
    case 'digs':
      return this.serveRepoDigs(req, repo)
    case 'fork':
      return this.serveRepoForkPrompt(req, repo)
    case 'forks':
      return this.serveRepoForks(req, repo)
    case 'issues':
      switch (path[1]) {
        case 'new':
          if (filePath.length == 0)
            return this.issues.serveRepoNewIssue(req, repo)
          break
        default:
          return this.issues.serveRepoIssues(req, repo, false)
      }
    case 'pulls':
      return this.issues.serveRepoIssues(req, repo, true)
    case 'compare':
      return this.pulls.serveRepoCompare(req, repo)
    case 'comparing':
      return this.pulls.serveRepoComparing(req, repo)
    case 'info':
      switch (path[1]) {
        case 'refs':
          return this.serveRepoRefs(req, repo)
        default:
          return this.web.serve404(req)
      }
    case 'objects':
      switch (path[1]) {
        case 'info':
          switch (path[2]) {
            case 'packs':
              return this.serveRepoPacksInfo(req, repo)
            default:
              return this.web.serve404(req)
          }
        case 'pack':
          return this.serveRepoPack(req, repo, filePath.join('/'))
        default:
          var hash = path[1] + path[2]
          if (hash.length === 40) {
            return this.serveRepoObject(req, repo, hash)
          }
          return this.web.serve404(req)
      }
    case 'HEAD':
      return this.serveRepoHead(req, repo)
    default:
      return this.web.serve404(req)
  }
}

R.serveRepoNotFound = function (req, id, err) {
  return this.web.serveTemplate(req, req._t('error.RepoNotFound'), 404)
  (pull.values([
    '<h2>' + req._t('error.RepoNotFound') + '</h2>',
    '<p>' + req._t('error.RepoNameNotFound') + '</p>',
    '<pre>' + u.escape(err.stack) + '</pre>'
  ]))
}

R.renderRepoPage = function (req, repo, page, branch, titleTemplate, body) {
  var self = this
  var gitUrl = 'ssb://' + repo.id
  var host = req.headers.host || '127.0.0.1:7718'
  var path = '/' + encodeURIComponent(repo.id)
  var httpUrl = 'http://' + encodeURI(host) + path
  var digsPath = [repo.id, 'digs']
  var cloneUrls = '<span class="clone-urls">' +
    '<select class="custom-dropdown clone-url-protocol" ' +
     'onchange="this.nextSibling.value=this.value;this.nextSibling.select()">' +
      '<option selected="selected" value="' + gitUrl + '">SSB</option>' +
      '<option class="http-clone-url" value="' + httpUrl + '">HTTP</option>' +
    '</select>' +
    '<input class="clone-url" readonly="readonly" ' +
      'value="ssb://' + repo.id + '" size="45" ' +
      'onclick="this.select()"/>' +
    '<script>' +
      'var httpOpt = document.querySelector(".http-clone-url")\n' +
      'if (location.protocol === "https:") httpOpt.text = "HTTPS"\n' +
      'httpOpt.value = location.origin + "' + path + '"\n' +
    '</script>' +
    '</span>'

  var done = multicb({ pluck: 1, spread: true })
  self.web.getRepoName(repo.feed, repo.id, done())
  self.web.about.getName(repo.feed, done())
  self.web.getVotes(repo.id, done())

  if (repo.upstream) {
    self.web.getRepoName(repo.upstream.feed, repo.upstream.id, done())
    self.web.about.getName(repo.upstream.feed, done())
  }

  return u.readNext(function (cb) {
    done(function (err, repoName, authorName, votes,
        upstreamName, upstreamAuthorName) {
      if (err) return cb(null, self.web.serveError(req, err))
      var upvoted = votes.upvoters[self.web.myId] > 0
      var upstreamLink = !repo.upstream ? '' :
        u.link([repo.upstream])
      var title = titleTemplate ? titleTemplate
        .replace(/%\{repo\}/g, repoName)
        .replace(/%\{author\}/g, authorName)
        : authorName + '/' + repoName
      var isPublic = self.web.isPublic
      cb(null, self.web.serveTemplate(req, title)(cat([
        pull.once(
          '<div class="repo-title">' +
          '<form class="right-bar" action="" method="post">' +
            '<button class="btn" name="action" value="vote" ' +
            (isPublic ? 'disabled="disabled"' : ' type="submit"') + '>' +
              '<i>✌</i> ' + req._t(!isPublic && upvoted ? 'Undig' : 'Dig') +
              '</button>' +
            (isPublic ? '' : '<input type="hidden" name="value" value="' +
                (upvoted ? '0' : '1') + '">' +
              '<input type="hidden" name="id" value="' +
                u.escape(repo.id) + '">') + ' ' +
            '<strong>' + u.link(digsPath, votes.upvotes) + '</strong> ' +
            (isPublic ? '' : '<button class="btn" type="submit" ' +
                ' name="action" value="fork-prompt">' +
              '<i>⑂</i> ' + req._t('Fork') +
              '</button>') + ' ' +
            u.link([repo.id, 'forks'], '+', false, ' title="' +
              req._t('Forks') + '"') +
          '</form>' +
          forms.name(req, !isPublic, repo.id, repoName, 'repo-name',
            null, req._t('repo.Rename'),
            '<h2 class="bgslash">' + u.link([repo.feed], authorName) + ' / ' +
              u.link([repo.id], repoName) + '</h2>') +
          '</div>' +
          (repo.upstream ? '<small class="bgslash">' + req._t('ForkedFrom', {
            repo: u.link([repo.upstream.feed], upstreamAuthorName) + '/' +
              u.link([repo.upstream.id], upstreamName)
          }) + '</small>' : '') +
          u.nav([
            [[repo.id], req._t('Code'), 'code'],
            [[repo.id, 'activity'], req._t('Activity'), 'activity'],
            [[repo.id, 'commits', branch||''], req._t('Commits'), 'commits'],
            [[repo.id, 'issues'], req._t('Issues'), 'issues'],
            [[repo.id, 'pulls'], req._t('PullRequests'), 'pulls']
          ], page, cloneUrls)),
        body
      ])))
    })
  })
}

R.serveEmptyRepo = function (req, repo) {
  if (repo.feed != this.web.myId)
    return this.renderRepoPage(req, repo, 'code', null, null, pull.once(
      '<section>' +
      '<h3>' + req._t('EmptyRepo') + '</h3>' +
      '</section>'))

  var gitUrl = 'ssb://' + repo.id
  return this.renderRepoPage(req, repo, 'code', null, null, pull.once(
    '<section>' +
    '<h3>' + req._t('initRepo.GettingStarted') + '</h3>' +
    '<h4>' + req._t('initRepo.CreateNew') + '</h4><pre>' +
    'touch ' + req._t('initRepo.README') + '.md\n' +
    'git init\n' +
    'git add ' + req._t('initRepo.README') + '.md\n' +
    'git commit -m "' + req._t('initRepo.InitialCommit') + '"\n' +
    'git remote add origin ' + gitUrl + '\n' +
    'git push -u origin master</pre>\n' +
    '<h4>' + req._t('initRepo.PushExisting') + '</h4>\n' +
    '<pre>git remote add origin ' + gitUrl + '\n' +
    'git push -u origin master</pre>' +
    '</section>'))
}

R.serveRepoTree = function (req, repo, rev, path) {
  var type = repo.isCommitHash(rev) ? 'Tree' : 'Branch'
  var title = (path.length ? path.join('/') + ' · ' : '') +
    '%{author}/%{repo}' +
    (repo.head == 'refs/heads/' + rev ? '' : '@' + rev)
  return this.renderRepoPage(req, repo, 'code', rev, title, cat([
    pull.once('<section class="branch-info light-grey"><form action="" method="get">' +
      '<h3>' + req._t(type) + ': '),
    this.revMenu(req, repo, rev),
    pull.once('</h3></form>'),
    type == 'Branch' && renderRepoLatest(req, repo, rev),
    pull.once('</section>'),
    rev ? cat([
      pull.once('<section class="files">'),
      renderRepoTree(req, repo, rev, path),
      pull.once('</section>'),
      this.renderRepoReadme(req, repo, rev, path)
    ]) : this.serveEmptyRepo(req, repo)
  ]))
}

/* Repo activity */

R.serveRepoActivity = function (req, repo, branch) {
  var self = this
  var title = req._t('Activity') + ' · %{author}/%{repo}'
  return self.renderRepoPage(req, repo, 'activity', branch, title, cat([
    pull.once('<h3>' + req._t('Activity') + '</h3>'),
    pull(
      self.web.ssb.links({
        dest: repo.id,
        rel: 'repo',
        values: true,
        reverse: true
      }),
      pull.asyncMap(renderRepoUpdate.bind(self, req, repo, false))
    ),
    u.readOnce(function (cb) {
      var done = multicb({ pluck: 1, spread: true })
      self.web.about.getName(repo.feed, done())
      self.web.getMsg(repo.id, done())
      done(function (err, authorName, msg) {
        if (err) return cb(err)
        self.web.renderFeedItem(req, {
          key: repo.id,
          value: msg,
          authorName: authorName
        }, cb)
      })
    })
  ]))
}

function renderRepoUpdate(req, repo, full, msg, cb) {
  var c = msg.value.content

  if (c.type != 'git-update') {
    return ''
    // return renderFeedItem(msg, cb)
    // TODO: render post, issue, pull-request
  }

  var branches = []
  var tags = []
  if (c.refs) for (var name in c.refs) {
    var m = name.match(/^refs\/(heads|tags)\/(.*)$/) || [,, name]
    ;(m[1] == 'tags' ? tags : branches)
      .push({name: m[2], value: c.refs[name]})
  }
  var numObjects = c.objects ? Object.keys(c.objects).length : 0

  var dateStr = new Date(msg.value.timestamp).toLocaleString(req._locale)

  this.web.about.getName(msg.value.author, function (err, name) {
    if (err) return cb(err)
    cb(null, '<section class="collapse">' +
      u.link([msg.key], dateStr) + '<br>' +
      u.link([msg.value.author], name) + '<br>' +

      branches.map(function (update) {
        if (!update.value) {
          return '<s>' + u.escape(update.name) + '</s><br/>'
        } else {
          var commitLink = u.link([repo.id, 'commit', update.value])
          var branchLink = u.link([repo.id, 'tree', update.name])
          return branchLink + ' &rarr; <tt>' + commitLink + '</tt><br/>'
        }
      }).join('') +
      tags.map(function (update) {
        return update.value
          ? u.link([repo.id, 'tag', update.value], update.name)
          : '<s>' + u.escape(update.name) + '</s>'
      }).join(', ') +
      '</section>')
  })
}

/* Repo commits */

R.serveRepoCommits = function (req, repo, branch) {
  var query = req._u.query
  var title = req._t('Commits') + ' · %{author}/%{repo}'
  return this.renderRepoPage(req, repo, 'commits', branch, title, cat([
    pull.once('<h3>' + req._t('Commits') + '</h3>'),
    pull(
      repo.readLog(query.start || branch),
      pull.take(20),
      paramap(repo.getCommitParsed.bind(repo), 8),
      paginate(
        !query.start ? '' : function (first, cb) {
          cb(null, '&hellip;')
        },
        pull.map(renderCommit.bind(this, req, repo)),
        function (commit, cb) {
          cb(null, commit.parents && commit.parents[0] ?
            '<a href="?start=' + commit.id + '">' +
              req._t('Older') + '</a>' : '')
        }
      )
    )
  ]))
}

function renderCommit(req, repo, commit) {
  var commitPath = [repo.id, 'commit', commit.id]
  var treePath = [repo.id, 'tree', commit.id]
  return '<section class="collapse">' +
    '<strong>' + u.link(commitPath, commit.title) + '</strong><br>' +
    '<tt>' + commit.id + '</tt> ' +
      u.link(treePath, req._t('Tree')) + '<br>' +
    u.escape(commit.author.name) + ' &middot; ' +
    commit.author.date.toLocaleString(req._locale) +
    (commit.separateAuthor ? '<br>' + req._t('CommittedOn', {
      name: u.escape(commit.committer.name),
      date: commit.committer.date.toLocaleString(req._locale)
    }) : '') +
    '</section>'
}

/* Branch menu */

R.formatRevOptions = function (currentName) {
  return function (name) {
    var htmlName = u.escape(name)
    return '<option value="' + htmlName + '"' +
      (name == currentName ? ' selected="selected"' : '') +
      '>' + htmlName + '</option>'
  }
}

R.formatRevType = function(req, type) {
  return (
    type == 'heads' ? req._t('Branches') :
    type == 'tags' ? req._t('Tags') :
    type)
}

R.revMenu = function (req, repo, currentName) {
  var self = this
  return u.readOnce(function (cb) {
    repo.getRefNames(function (err, refs) {
      if (err) return cb(err)
      cb(null, '<select class="custom-dropdown" name="rev" onchange="this.form.submit()">' +
        Object.keys(refs).map(function (group) {
          return '<optgroup ' +
            'label="' + self.formatRevType(req, group) + '">' +
            refs[group].map(self.formatRevOptions(currentName)).join('') +
            '</optgroup>'
        }).join('') +
        '</select><noscript> ' +
        '<input type="submit" value="' + req._t('Go') + '"/></noscript>')
    })
  })
}

/* Repo tree */

function renderRepoLatest(req, repo, rev) {
  if (!rev) return pull.empty()
  return u.readOnce(function (cb) {
    repo.getCommitParsed(rev, function (err, commit) {
      if (err) return cb(err)
      var commitPath = [repo.id, 'commit', commit.id]
      var actor = commit.separateAuthor ? 'author' : 'committer'
      var actionKey = actor.slice(0,1).toUpperCase() + actor.slice(1) + 'ReleasedCommit'
      cb(null,
        '<div class="mt1">' +
          '<span>' +
            req._t(actionKey, {
              name: u.escape(commit[actor].name),
              commitName: u.link(commitPath, commit.title)
            }) +
          '</span>' +
          '<tt class="float-right">' +
            req._t('LatestOn', {
              commitId: commit.id.slice(0, 7),
              date: commit[actor].date.toLocaleString(req._locale)
            }) +
          '</tt>' +
        '</div>'
      )
    })
  })
}

// breadcrumbs
function linkPath(basePath, path) {
  path = path.slice()
  var last = path.pop()
  return path.map(function (dir, i) {
    return u.link(basePath.concat(path.slice(0, i+1)), dir)
  }).concat(last).join(' / ')
}

function renderRepoTree(req, repo, rev, path) {
  var source =  repo.readDir(rev,path)
  var pathLinks = path.length === 0 ? '' :
    ': ' + linkPath([repo.id, 'tree'], [rev].concat(path))

  var location = once('')
  if (path.length !== 0) {
    var link = linkPath([repo.id, 'tree'], [rev].concat(path))
    location = h('div', {class: 'fileLocation'}, `${req._t('Files')}: ${link}`)
  }

  return cat([
    location,
    h('table', {class: "files w-100"}, u.sourceMap(source, file =>
      h('tr', [
        h('td', [
          h('i', fileIcon(file))
        ]),
        h('td', u.link(filePath(file), file.name))
      ])
    ))
  ])

  function fileIcon(file) {
    return fileType(file) === 'tree' ? '📁' : '📄'
  }

  function filePath(file) {
    var type = fileType(file)
    return [repo.id, type, rev].concat(path, file.name)
  }

  function fileType(file) {
    if (file.mode === 040000) return 'tree'
    else if (file.mode === 0160000) return 'commit'
    else return 'blob'
  }
}

/* Repo readme */

R.renderRepoReadme = function (req, repo, branch, path) {
  var self = this
  return u.readNext(function (cb) {
    pull(
      repo.readDir(branch, path),
      pull.filter(function (file) {
        return /readme(\.|$)/i.test(file.name)
      }),
      pull.take(1),
      pull.collect(function (err, files) {
        if (err) return cb(null, pull.empty())
        var file = files[0]
        if (!file)
          return cb(null, pull.once(path.length ? '' :
            '<p>' + req._t('NoReadme') + '</p>'))
        repo.getObjectFromAny(file.id, function (err, obj) {
          if (err) return cb(err)
          cb(null, cat([
            pull.once('<section class="readme">'),
            self.web.renderObjectData(obj, file.name, repo, branch, path),
            pull.once('</section>')
          ]))
        })
      })
    )
  })
}

/* Repo commit */

R.serveRepoCommit = function (req, repo, rev) {
  var self = this
  return u.readNext(function (cb) {
    repo.getCommitParsed(rev, function (err, commit) {
      if (err) return cb(err)
      var commitPath = [repo.id, 'commit', commit.id]
      var treePath = [repo.id, 'tree', commit.id]
      var title = u.escape(commit.title) + ' · ' +
        '%{author}/%{repo}@' + commit.id.substr(0, 8)
      cb(null, self.renderRepoPage(req, repo, null, rev, title, cat([
        pull.once(
        '<h3>' + u.link(commitPath,
          req._t('CommitRev', {rev: rev})) + '</h3>' +
        '<section class="collapse">' +
        '<div class="right-bar">' +
          u.link(treePath, req._t('BrowseFiles')) +
        '</div>' +
        '<h4>' + u.linkify(u.escape(commit.title)) + '</h4>' +
        (commit.body ? u.linkify(u.pre(commit.body)) : '') +
        (commit.separateAuthor ? req._t('AuthoredOn', {
          name: u.escape(commit.author.name),
          date: commit.author.date.toLocaleString(req._locale)
        }) + '<br/>' : '') +
        req._t('CommittedOn', {
          name: u.escape(commit.committer.name),
          date: commit.committer.date.toLocaleString(req._locale)
        }) + '<br/>' +
        commit.parents.map(function (id) {
          return req._t('Parent') + ': ' +
            u.link([repo.id, 'commit', id], id)
        }).join('<br>') +
        '</section>' +
        '<section><h3>' + req._t('FilesChanged') + '</h3>'),
        // TODO: show diff from all parents (merge commits)
        self.renderDiffStat(req, [repo, repo], [commit.parents[0], commit.id]),
        pull.once('</section>')
      ])))
    })
  })
}

/* Repo tag */

R.serveRepoTag = function (req, repo, rev, path) {
  var self = this
  return u.readNext(function (cb) {
    repo.getTagParsed(rev, function (err, tag) {
      if (err) {
        if (/Expected tag, got commit/.test(err.message)) {
          req._u.pathname = u.encodeLink([repo.id, 'commit', rev].concat(path))
          return cb(null, self.web.serveRedirect(req, url.format(req._u)))
        }
        return cb(null, self.web.serveError(req, err))
      }

      var title = req._t('TagName', {
        tag: u.escape(tag.tag)
      }) + ' · %{author}/%{repo}'
      var body = (tag.title + '\n\n' +
        tag.body.replace(/-----BEGIN PGP SIGNATURE-----\n[^.]*?\n-----END PGP SIGNATURE-----\s*$/, '')).trim()
      var date = tag.tagger.date
      cb(null, self.renderRepoPage(req, repo, 'tags', tag.object, title,
        pull.once(
          '<section class="collapse">' +
          '<h3>' + u.link([repo.id, 'tag', rev], tag.tag) + '</h3>' +
          req._t('TaggedOn', {
            name: u.escape(tag.tagger.name),
            date: date && date.toLocaleString(req._locale)
          }) + '<br/>' +
        u.link([repo.id, tag.type, tag.object]) +
        u.linkify(u.pre(body)) +
        '</section>')))
    })
  })
}


/* Diff stat */

R.renderDiffStat = function (req, repos, treeIds) {
  if (treeIds.length == 0) treeIds = [null]
  var id = treeIds[0]
  var lastI = treeIds.length - 1
  var oldTree = treeIds[0]
  var changedFiles = []
  var source = GitRepo.diffTrees(repos, treeIds, true)

  return cat([
    h('table', u.sourceMap(source, item => {
      var filename = u.escape(item.filename = item.path.join('/'))
      var oldId = item.id && item.id[0]
      var newId = item.id && item.id[lastI]
      var oldMode = item.mode && item.mode[0]
      var newMode = item.mode && item.mode[lastI]
      var action =
        !oldId && newId ? req._t('action.added') :
        oldId && !newId ? req._t('action.deleted') :
        oldMode != newMode ? req._t('action.changedMode', {
          old: oldMode.toString(8),
          new: newMode.toString(8)
        }) : req._t('changed')
      if (item.id)
        changedFiles.push(item)
      var blobsPath = item.id[1]
        ? [repos[1].id, 'blob', treeIds[1]]
        : [repos[0].id, 'blob', treeIds[0]]
      var rawsPath = item.id[1]
        ? [repos[1].id, 'raw', treeIds[1]]
        : [repos[0].id, 'raw', treeIds[0]]
      item.blobPath = blobsPath.concat(item.path)
      item.rawPath = rawsPath.concat(item.path)
      var fileHref = item.id ?
        '#' + encodeURIComponent(item.path.join('/')) :
        u.encodeLink(item.blobPath)

      return h('tr', [
        h('td', [
          h('a', {href: fileHref}, filename)
        ]),
        h('td', action)
      ])
    })),
    pull(
      pull.values(changedFiles),
      paramap(function (item, cb) {
        var extension = u.getExtension(item.filename)
        if (extension in u.imgMimes) {
          var filename = u.escape(item.filename)
          return cb(null,
            '<pre><table class="code">' +
            '<tr><th id="' + u.escape(item.filename) + '">' +
              filename + '</th></tr>' +
            '<tr><td><img src="' + u.encodeLink(item.rawPath) + '"' +
            ' alt="' + filename + '"/></td></tr>' +
            '</table></pre>')
        }
        var done = multicb({ pluck: 1, spread: true })
        var mode0 = item.mode && item.mode[0]
        var modeI = item.mode && item.mode[lastI]
        var isSubmodule = (modeI == 0160000)
        getRepoObjectString(repos[0], item.id[0], mode0, done())
        getRepoObjectString(repos[1], item.id[lastI], modeI, done())
        done(function (err, strOld, strNew) {
          if (err) return cb(err)
          cb(null, htmlLineDiff(req, item.filename, item.filename,
            strOld, strNew,
            u.encodeLink(item.blobPath), !isSubmodule))
        })
      }, 4)
    )
  ])
}

function htmlLineDiff(req, filename, anchor, oldStr, newStr, blobHref,
    showViewLink) {
  return '<pre><table class="code">' +
    '<tr><th colspan=3 id="' + u.escape(anchor) + '">' + filename +
    (showViewLink === false ? '' :
      '<span class="right-bar">' +
        '<a href="' + blobHref + '">' + req._t('View') + '</a> ' +
      '</span>') +
    '</th></tr>' +
    (oldStr.length + newStr.length > 200000
      ? '<tr><td class="diff-info">' + req._t('diff.TooLarge') + '<br>' +
        req._t('diff.OldFileSize', {bytes: oldStr.length}) + '<br>' +
        req._t('diff.NewFileSize', {bytes: newStr.length}) + '</td></tr>'
      : tableDiff(oldStr, newStr, filename)) +
    '</table></pre>'
}

function tableDiff(oldStr, newStr, filename) {
  var diff = JsDiff.structuredPatch('', '', oldStr, newStr)
  var groups = diff.hunks.map(function (hunk) {
    var oldLine = hunk.oldStart
    var newLine = hunk.newStart
    var header = '<tr class="diff-hunk-header"><td colspan=2></td><td>' +
      '@@ -' + oldLine + ',' + hunk.oldLines + ' ' +
      '+' + newLine + ',' + hunk.newLines + ' @@' +
      '</td></tr>'
    return [header].concat(hunk.lines.map(function (line) {
      var s = line[0]
      if (s == '\\') return
      var html = u.highlight(line, u.getExtension(filename))
      var trClass = s == '+' ? 'diff-new' : s == '-' ? 'diff-old' : ''
      var lineNums = [s == '+' ? '' : oldLine++, s == '-' ? '' : newLine++]
      var id = [filename].concat(lineNums).join('-')
      return '<tr id="' + u.escape(id) + '" class="' + trClass + '">' +
        lineNums.map(function (num) {
          return '<td class="code-linenum">' +
            (num ? '<a href="#' + encodeURIComponent(id) + '">' +
              num + '</a>' : '') + '</td>'
        }).join('') +
        '<td class="code-text">' + html + '</td></tr>'
    }))
  })
  return [].concat.apply([], groups).join('')
}

/* An unknown message linking to a repo */

R.serveRepoSomething = function (req, repo, id, msg, path) {
  return this.renderRepoPage(req, repo, null, null, null,
    pull.once('<section><h3>' + u.link([id]) + '</h3>' +
      u.json(msg) + '</section>'))
}

/* Repo update */

function objsArr(objs) {
  return Array.isArray(objs) ? objs :
    Object.keys(objs).map(function (sha1) {
      var obj = Object.create(objs[sha1])
      obj.sha1 = sha1
      return obj
    })
}

R.serveRepoUpdate = function (req, repo, id, msg, path) {
  var self = this
  var raw = req._u.query.raw != null
  var title = req._t('Update') + ' · %{author}/%{repo}'

  if (raw)
    return self.renderRepoPage(req, repo, 'activity', null, title, pull.once(
      '<a href="?" class="raw-link header-align">' +
        req._t('Info') + '</a>' +
      '<h3>' + req._t('Update') + '</h3>' +
      '<section class="collapse">' +
        u.json({key: id, value: msg}) + '</section>'))

  // convert packs to old single-object style
  if (msg.content.indexes) {
    for (var i = 0; i < msg.content.indexes.length; i++) {
      msg.content.packs[i] = {
        pack: {link: msg.content.packs[i].link},
        idx: msg.content.indexes[i]
      }
    }
  }

  var commits = cat([
    msg.content.objects && pull(
      pull.values(msg.content.objects),
      pull.filter(function (obj) { return obj.type == 'commit' }),
      paramap(function (obj, cb) {
        self.web.getBlob(req, obj.link || obj.key, function (err, readObject) {
          if (err) return cb(err)
          GitRepo.getCommitParsed({read: readObject}, cb)
        })
      }, 8)
    ),
    msg.content.packs && pull(
      pull.values(msg.content.packs),
      paramap(function (pack, cb) {
        var done = multicb({ pluck: 1, spread: true })
        self.web.getBlob(req, pack.pack.link, done())
        self.web.getBlob(req, pack.idx.link, done())
        done(function (err, readPack, readIdx) {
          if (err) return cb(self.web.renderError(err))
          cb(null, gitPack.decodeWithIndex(repo, readPack, readIdx))
        })
      }, 4),
      pull.flatten(),
      pull.asyncMap(function (obj, cb) {
        if (obj.type == 'commit')
          GitRepo.getCommitParsed(obj, cb)
        else
          pull(obj.read, pull.drain(null, cb))
      }),
      pull.filter()
    )
  ])

  return self.renderRepoPage(req, repo, 'activity', null, title, cat([
    pull.once('<a href="?raw" class="raw-link header-align">' +
      req._t('Data') + '</a>' +
      '<h3>' + req._t('Update') + '</h3>'),
    pull(
      pull.once({key: id, value: msg}),
      pull.asyncMap(renderRepoUpdate.bind(self, req, repo, true))
    ),
    (msg.content.objects || msg.content.packs) &&
      pull.once('<h3>' + req._t('Commits') + '</h3>'),
    pull(commits, pull.map(function (commit) {
      return renderCommit(req, repo, commit)
    }))
  ]))
}

/* Blob */

R.serveRepoBlob = function (req, repo, rev, path) {
  var self = this
  return u.readNext(function (cb) {
    repo.getFile(rev, path, function (err, object) {
      if (err) return cb(null, self.web.serveBlobNotFound(req, repo.id, err))
      var type = repo.isCommitHash(rev) ? 'Tree' : 'Branch'
      var pathLinks = path.length === 0 ? '' :
        ': ' + linkPath([repo.id, 'tree'], [rev].concat(path))
      var rawFilePath = [repo.id, 'raw', rev].concat(path)
      var dirPath = path.slice(0, path.length-1)
      var filename = path[path.length-1]
      var extension = u.getExtension(filename)
      var title = (path.length ? path.join('/') + ' · ' : '') +
        '%{author}/%{repo}' +
        (repo.head == 'refs/heads/' + rev ? '' : '@' + rev)
      cb(null, self.renderRepoPage(req, repo, 'code', rev, title, cat([
        pull.once('<section><form action="" method="get">' +
          '<h3>' + req._t(type) + ': ' + rev + ' '),
        self.revMenu(req, repo, rev),
        pull.once('</h3></form>'),
        type == 'Branch' && renderRepoLatest(req, repo, rev),
        pull.once('</section><section class="collapse">' +
          '<h3>' + req._t('Files') + pathLinks + '</h3>' +
          '<div>' + object.length + ' bytes' +
          '<span class="raw-link">' +
            u.link(rawFilePath, req._t('Raw')) + '</span>' +
          '</div></section>' +
          '<section>'),
        extension in u.imgMimes
        ? pull.once('<img src="' + u.encodeLink(rawFilePath) +
          '" alt="' + u.escape(filename) + '" />')
        : self.web.renderObjectData(object, filename, repo, rev, dirPath),
        pull.once('</section>')
      ])))
    })
  })
}

/* Raw blob */

R.serveRepoRaw = function (req, repo, branch, path) {
  var self = this
  return u.readNext(function (cb) {
    repo.getFile(branch, path, function (err, object) {
      if (err) return cb(null,
        self.web.serveBuffer(404, req._t('error.BlobNotFound')))
      var extension = u.getExtension(path[path.length-1])
      var contentType = u.imgMimes[extension]
      cb(null, pull(object.read, self.web.serveRaw(object.length, contentType)))
    })
  })
}

/* Digs */

R.serveRepoDigs = function serveRepoDigs (req, repo) {
  var self = this
  return u.readNext(cb => {
    var title = req._t('Digs') + ' · %{author}/%{repo}'
    self.web.getVotes(repo.id, (err, votes) => {
      cb(null, self.renderRepoPage(req, repo, null, null, title,
        h('section', [
          h('h3', req._t('Digs')),
          h('div', `${req._t('Total')}: ${votes.upvotes}`),
          h('ul', u.paraSourceMap(Object.keys(votes.upvoters), (feedId, cb) => {
            self.web.about.getName(feedId, (err, name) => {
              cb(null, h('li', u.link([feedId], name)))
            })
          }))
        ])
      ))
    })
  })
}

/* Forks */

R.getForks = function (repo, includeSelf) {
  var self = this
  return pull(
    cat([
      includeSelf && pull.once(repo.id),
      // get downstream repos
      pull(
        self.web.ssb.links({
          dest: repo.id,
          rel: 'upstream'
        }),
        pull.map('key')
      ),
      // look for other repos that previously had pull requests to this one
      pull(
        self.web.ssb.links({
          dest: repo.id,
          values: true,
          rel: 'project'
        }),
        pull.filter(function (msg) {
          var c = msg && msg.value && msg.value.content
          return c && c.type == 'pull-request'
        }),
        pull.map(function (msg) { return msg.value.content.head_repo })
      )
    ]),
    pull.unique(),
    paramap(function (key, cb) {
      self.web.ssb.get(key, function (err, value) {
        if (err) cb(err)
        else cb(null, {key: key, value: value})
      })
    }, 4),
    pull.filter(function (msg) {
      var c = msg && msg.value && msg.value.content
      return c && c.type == 'git-repo'
    }),
    paramap(function (msg, cb) {
      self.web.getRepoFullName(msg.value.author, msg.key,
          function (err, repoName, authorName) {
        if (err) return cb(err)
        cb(null, {
          key: msg.key,
          value: msg.value,
          repoName: repoName,
          authorName: authorName
        })
      })
    }, 8)
  )
}

R.serveRepoForks = function (req, repo) {
  var hasForks
  var title = req._t('Forks') + ' · %{author}/%{repo}'
  return this.renderRepoPage(req, repo, null, null, title, cat([
    pull.once('<h3>' + req._t('Forks') + '</h3>'),
    pull(
      this.getForks(repo),
      pull.map(function (msg) {
        hasForks = true
        return '<section class="collapse">' +
          u.link([msg.value.author], msg.authorName) + ' / ' +
          u.link([msg.key], msg.repoName) +
          '<span class="right-bar">' +
          u.timestamp(msg.value.timestamp, req) +
          '</span></section>'
      })
    ),
    u.readOnce(function (cb) {
      cb(null, hasForks ? '' : req._t('NoForks'))
    })
  ]))
}

R.serveRepoForkPrompt = function (req, repo) {
  var title = req._t('Fork') + ' · %{author}/%{repo}'
  return this.renderRepoPage(req, repo, null, null, title, pull.once(
    '<form action="" method="post" onreset="history.back()">' +
    '<h3>' + req._t('ForkRepoPrompt') + '</h3>' +
    '<p>' + u.hiddenInputs({ id: repo.id }) +
    '<button class="btn open" type="submit" name="action" value="fork">' +
      req._t('Fork') +
    '</button>' +
    ' <button class="btn" type="reset">' +
      req._t('Cancel') + '</button>' +
    '</p></form>'
  ))
}

R.serveIssueOrPullRequest = function (req, repo, issue, path, id) {
  return issue.msg.value.content.type == 'pull-request'
    ? this.pulls.serveRepoPullReq(req, repo, issue, path, id)
    : this.issues.serveRepoIssue(req, repo, issue, path, id)
}

function getRepoLastMod(repo, cb) {
  repo.getState(function (err, state) {
    if (err) return cb(err)
    var lastMod = new Date(Math.max.apply(Math, state.refs.map(function (ref) {
      return ref.link.value.timestamp
    }))) || new Date()
    cb(null, lastMod)
  })
}

R.serveRepoRefs = function (req, repo) {
  var self = this
  return u.readNext(function (cb) {
    getRepoLastMod(repo, function (err, lastMod) {
      if (err) return cb(null, self.web.serveError(req, err, 500))
      if (u.ifModifiedSince(req, lastMod)) {
        return cb(null, pull.once([304]))
      }
      repo.getState(function (err, state) {
        if (err) return cb(null, self.web.serveError(req, err, 500))
        var buf = state.refs.sort(function (a, b) {
          return a.name > b.name ? 1 : a.name < b.name ? -1 : 0
        }).map(function (ref) {
          return ref.hash + '\t' + ref.name + '\n'
        }).join('')
        cb(null, pull.values([[200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': Buffer.byteLength(buf),
          'Last-Modified': lastMod.toGMTString()
        }], buf]))
      })
    })
  })
}

R.serveRepoObject = function (req, repo, sha1) {
  var self = this
  if (!/[0-9a-f]{20}/.test(sha1)) return pull.once([401])
  return u.readNext(function (cb) {
    repo.getObjectFromAny(sha1, function (err, obj) {
      if (err) return cb(null, pull.once([404]))
      cb(null, cat([
        pull.once([200, {
          'Content-Type': 'application/x-git-loose-object',
          'Cache-Control': 'max-age=31536000'
        }]),
        pull(
          cat([
            pull.values([obj.type, ' ', obj.length.toString(10), '\0']),
            obj.read
          ]),
          toPull(zlib.createDeflate())
        )
      ]))
    })
  })
}

R.serveRepoHead = function (req, repo) {
  var self = this
  return u.readNext(function (cb) {
    repo.getHead(function (err, name) {
      if (err) return cb(null, pull.once([500]))
      return cb(null, self.web.serveBuffer(200, 'ref: ' + name))
    })
  })
}

R.serveRepoPacksInfo = function (req, repo) {
  var self = this
  return u.readNext(function (cb) {
    getRepoLastMod(repo, function (err, lastMod) {
      if (err) return cb(null, self.web.serveError(req, err, 500))
      if (u.ifModifiedSince(req, lastMod)) {
        return cb(null, pull.once([304]))
      }
      cb(null, cat([
        pull.once([200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Last-Modified': lastMod.toGMTString()
        }]),
        pull(
          repo.packs(),
          pull.map(function (pack) {
            var sha1 = pack.sha1
            if (!sha1) {
              // make up a sha1 and hope git doesn't notice
              var packId = new Buffer(pack.packId.substr(1, 44), 'base64')
              sha1 = packId.slice(0, 20).toString('hex')
            }
            return 'P pack-' + sha1 + '.pack\n'
          })
        )
      ]))
    })
  })
}

R.serveRepoPack = function (req, repo, name) {
  var m = name.match(/^pack-(.*)\.(pack|idx)$/)
  if (!m) return pull.once([400])
  var hex;
  try {
    hex = new Buffer(m[1], 'hex')
  } catch(e) {
    return pull.once([400])
  }

  var self = this
  return u.readNext(function (cb) {
    pull(
      repo.packs(),
      pull.filter(function (pack) {
        var sha1 = pack.sha1
          ? new Buffer(pack.sha1, 'hex')
          : new Buffer(pack.packId.substr(1, 44), 'base64').slice(0, 20)
        return sha1.equals(hex)
      }),
      pull.take(1),
      pull.collect(function (err, packs) {
        if (err) return console.error(err), cb(null, pull.once([500]))
        if (packs.length < 1) return cb(null, pull.once([404]))
          var pack = packs[0]

        if (m[2] === 'pack') {
          repo.getPackfile(pack.packId, function (err, read) {
            if (err) return cb(err)
            cb(null, pull(read,
              self.web.serveRaw(null, 'application/x-git-packed-objects')
            ))
          })
        }

        if (m[2] === 'idx') {
          repo.getPackIndex(pack.idxId, function (err, read) {
            if (err) return cb(err)
            cb(null, pull(read,
              self.web.serveRaw(null, 'application/x-git-packed-objects-toc')
            ))
          })
        }
      })
    )
  })
}

var fs = require('fs')
var http = require('http')
var path = require('path')
var url = require('url')
var ref = require('ssb-ref')
var pull = require('pull-stream')
var ssbGit = require('ssb-git-repo')
var toPull = require('stream-to-pull-stream')
var cat = require('pull-cat')
var Repo = require('pull-git-repo')
var ssbAbout = require('./about')
var marked = require('ssb-marked')
var asyncMemo = require('./async-memo')

marked.setOptions({
  gfm: true,
  mentions: true,
  tables: true,
  breaks: true,
  pedantic: false,
  sanitize: true,
  smartLists: true,
  smartypants: false
})

function parseAddr(str, def) {
  if (!str) return def
  var i = str.lastIndexOf(':')
  if (~i) return {host: str.substr(0, i), port: str.substr(i+1)}
  if (isNaN(str)) return {host: str, port: def.port}
  return {host: def.host, port: str}
}

function link(parts, html) {
  var href = '/' + parts.map(encodeURIComponent).join('/')
  var innerHTML = html || escapeHTML(parts[parts.length-1])
  return '<a href="' + href + '">' + innerHTML + '</a>'
}

function timestamp(time) {
  time = Number(time)
  var d = new Date(time)
  return '<span title="' + time + '">' + d.toLocaleString() + '</span>'
}

function pre(text) {
  return '<pre>' + escapeHTML(text) + '</pre>'
}

function json(obj) {
  return pre(JSON.stringify(obj, null, 2))
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeHTMLStream() {
  return pull.map(function (buf) {
    return escapeHTML(buf.toString('utf8'))
  })
}

function readNext(fn) {
  var next
  return function (end, cb) {
    if (next) return next(end, cb)
    fn(function (err, _next) {
      if (err) return cb(err)
      next = _next
      next(null, cb)
    })
  }
}

function readOnce(fn) {
  var ended
  return function (end, cb) {
    fn(function (err, data) {
      if (err || ended) return cb(err || ended)
      ended = true
      cb(null, data)
    })
  }
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

var hasOwnProp = Object.prototype.hasOwnProperty

function getContentType(filename) {
  var ext = filename.split('.').pop()
  return hasOwnProp.call(contentTypes, ext)
    ? contentTypes[ext]
    : 'text/plain'
}

var contentTypes = {
  css: 'text/css'
}

var msgTypes = {
  'git-repo': true,
  'git-update': true
}

var refLabels = {
  heads: 'Branches'
}

module.exports = function (listenAddr, cb) {
  var ssb, reconnect, myId, getRepo
  var about = function (id, cb) { cb(null, {name: id}) }

  var addr = parseAddr(listenAddr, {host: 'localhost', port: 7718})
  http.createServer(onRequest).listen(addr.port, addr.host, onListening)

  var server = {
    setSSB: function (_ssb, _reconnect) {
      ssb = _ssb
      reconnect = _reconnect
      ssb.whoami(function (err, feed) {
        myId = feed.id
        about = ssbAbout(ssb, ssb.id)
      })
      getRepo = asyncMemo(function (id, cb) {
        ssbGit.getRepo(ssb, id, {live: true}, cb)
      })
    }
  }

  function onListening() {
    var host = ~addr.host.indexOf(':') ? '[' + addr.host + ']' : addr.host
    console.error('Listening on http://' + host + ':' + addr.port + '/')
    cb(null, server)
  }

  /* Serving a request */

  function onRequest(req, res) {
    console.log(req.method, req.url)
    pull(
      handleRequest(req),
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

  function handleRequest(req) {
    var u = url.parse(req.url)
    var dirs = u.pathname.slice(1).split(/\/+/)
    switch (dirs[0]) {
      case '':
        return serveIndex(req)
      case 'static':
        return serveFile(req, dirs)
      default:
        dirs = dirs.map(tryDecodeURIComponent)
        if (ref.isMsgId(dirs[0]))
          return serveRepoPage(dirs[0], dirs.slice(1))
        else if (ref.isFeedId(dirs[0]))
          return serveUserPage(dirs[0])
        else
          return serve404(req)
    }
  }

  function serveFile(req, dirs) {
    var filename = path.join.apply(path, [__dirname].concat(dirs))
    return readNext(function (cb) {
      fs.stat(filename, function (err, stats) {
        cb(null, err ?
          err.code == 'ENOENT' ? serve404(req)
          : servePlainError(500, err.message)
        : stats.isDirectory() ?
          servePlainError(403, 'Directory not listable')
        : cat([
          pull.once([200, {
            'Content-Type': getContentType(filename),
            'Content-Length': stats.size,
            'Last-Modified': stats.mtime.toGMTString()
          }]),
          toPull(fs.createReadStream(filename))
        ]))
      })
    })
  }

  function servePlainError(code, msg) {
    return pull.values([
      [code, {
        'Content-Length': msg.length,
        'Content-Type': 'text/plain'
      }],
      msg
    ])
  }

  function serve404(req) {
    return servePlainError(404, '404 Not Found')
  }

  function renderTry(read) {
    var ended
    return function (end, cb) {
      if (ended) return cb(ended)
      read(end, function (err, data) {
        if (err === true)
          cb(true)
        else if (err) {
          ended = true
          cb(null,
            '<h3>' + err.name + '</h3>' +
            '<pre>' + escapeHTML(err.stack) + '</pre>')
        } else
          cb(null, data)
      })
    }
  }

  function serveTemplate(title, code, read) {
    if (read === undefined) return serveTemplate.bind(this, title, code)
    return cat([
      pull.values([
        [code || 200, {
          'Content-Type': 'text/html'
        }],
        '<!doctype html><html><head><meta charset=utf-8>',
        '<title>' + escapeHTML(title || 'git ssb') + '</title>',
        '<link rel=stylesheet href="/static/styles.css?' + Math.random() + '"/>',
        '</head>\n',
        '<body>',
        '<h1><a href="/">git ssb</a></h1>']),
      renderTry(read),
      pull.once('</body></html>')
    ])
  }

  function serveError(id, err) {
    if (err.message == 'stream is closed')
      reconnect()
    return pull(
      pull.once(
        '<h2>' + err.name + '</h3>' +
        '<pre>' + escapeHTML(err.stack) + '</pre>'),
      serveTemplate(err.name, 500)
    )
  }

  /* Feed */

  function renderFeed(feedId) {
    var opts = {
      reverse: true,
      id: feedId
    }
    return pull(
      feedId ? ssb.createUserStream(opts) : ssb.createLogStream(opts),
      pull.filter(function (msg) {
        return msg.value.content.type in msgTypes
      }),
      pull.take(20),
      pull.asyncMap(function (msg, cb) {
        about.getName(msg.value.author, function (err, name) {
        if (err) return cb(err)
          switch (msg.value.content.type) {
            case 'git-repo': return renderRepoCreated(msg, name, cb)
            case 'git-update': return renderUpdate(msg, name, cb)
          }
        })
      })
    )
  }

  function renderRepoCreated(msg, authorName, cb) {
    var repoLink = link([msg.key])
    var authorLink = link([msg.value.author], authorName)
    cb(null, '<p>' + timestamp(msg.value.timestamp) + '<br>' +
      authorLink + ' created repo ' + repoLink + '</p>')
  }

  function renderUpdate(msg, authorName, cb) {
    var repoLink = link([msg.value.content.repo])
    var authorLink = link([msg.value.author], authorName)
    cb(null, '<p>' + timestamp(msg.value.timestamp) + '<br>' +
      authorLink + ' pushed to ' + repoLink + '</p>')
  }

  /* Index */

  function serveIndex() {
    return serveTemplate('git ssb')(renderFeed())
  }

  function serveUserPage(feedId) {
    return serveTemplate(feedId)(cat([
      readOnce(function (cb) {
        about.getName(feedId, function (err, name) {
          cb(null, '<h2>' + link([feedId], name) + '</h2>' +
          '<p><small><code>' + feedId + '</code></small></p>')
        })
      }),
      renderFeed(feedId),
    ]))
  }

  /* Repo */

  function serveRepoPage(id, path) {
    var defaultBranch = 'master'
    return readNext(function (cb) {
      getRepo(id, function (err, repo) {
        if (err) {
          if (0)
            cb(null, serveRepoNotFound(id, err))
          else
            cb(null, serveError(id, err))
          return
        }
        repo = Repo(repo)
        cb(null, (function () {
          var branch = path[1] || defaultBranch
          var filePath = path.slice(2)
          switch (path[0]) {
            case undefined:
              return serveRepoTree(repo, branch, [])
            case 'activity':
              return serveRepoActivity(repo, branch)
            case 'commits':
              return serveRepoCommits(repo, branch)
            case 'commit':
              return serveRepoCommit(repo, path[1])
            case 'tree':
              return serveRepoTree(repo, branch, filePath)
            case 'blob':
              return serveBlob(repo, branch, filePath)
            default:
              return serve404(req)
          }
        })())
      })
    })
  }

  function serveRepoNotFound(id, err) {
    return serveTemplate('Repo not found', 404, pull.values([
      '<h2>Repo not found</h2>',
      '<p>Repo ' + id + ' was not found</p>',
      '<pre>' + escapeHTML(err.stack) + '</pre>',
    ]))
  }

  function renderRepoPage(repo, branch, body) {
    var gitUrl = 'ssb://' + repo.id
    var gitLink = '<code>' + gitUrl + '</code>'

    return serveTemplate(repo.id)(cat([
      pull.values([
        '<h2>' + link([repo.id]) + '</h2>' +
        '<p>git URL: ' + gitLink + '</p>']),
      readOnce(function (cb) {
        about.getName(repo.feed, function (err, name) {
          cb(null, '<p>Author: ' + link([repo.feed], name) + '</p>')
        })
      }),
      pull.once(
        '<p>' + link([repo.id], 'Code') + ' ' +
          link([repo.id, 'activity'], 'Activity') + ' ' +
          link([repo.id, 'commits', branch], 'Commits') + '</p>' +
        '<hr/>'
      ),
      body
    ]))
  }

  function serveRepoTree(repo, rev, path) {
    var type = repo.isCommitHash(rev) ? 'Tree' : 'Branch'
    return renderRepoPage(repo, rev, cat([
      pull.once('<h3>' + type + ': ' + rev + ' '),
      revMenu(repo, rev),
      pull.once('</h3>'),
      type == 'Branch' && renderRepoLatest(repo, rev),
      renderRepoTree(repo, rev, path),
      renderRepoReadme(repo, rev, path),
    ]))
  }

  /* Repo activity */

  function serveRepoActivity(repo, branch) {
    return renderRepoPage(repo, branch, cat([
      pull.once('<h3>Activity</h3>'),
      pull(
        ssb.links({
          type: 'git-update',
          dest: repo.id,
          source: repo.feed,
          rel: 'repo',
          values: true,
          reverse: true,
          limit: 8
        }),
        pull.map(renderRepoUpdate)
      )
    ]))

    function renderRepoUpdate(msg) {
      var c = msg.value.content

      var refs = c.refs ? Object.keys(c.refs).map(function (ref) {
        return {name: ref, value: c.refs[ref]}
      }) : []
      var numObjects = c.objects ? Object.keys(c.objects).length : 0

      return '<p>' + timestamp(msg.value.timestamp) + '<br>' +
        (numObjects ? 'Pushed ' + numObjects + ' objects<br>' : '') +
        refs.map(function (update) {
          var name = escapeHTML(update.name)
          if (!update.value) {
            return 'Deleted ' + name
          } else {
            var commitLink = link([repo.id, 'commit', update.value])
            return name + ' &rarr; ' + commitLink
          }
        }).join('<br>') +
        '</p>'
    }
  }

  /* Repo commits */

  function serveRepoCommits(repo, branch) {
    return renderRepoPage(repo, branch, cat([
      pull.once('<h3>Commits</h3><ul>'),
      pull(
        repo.readLog(branch),
        pull.asyncMap(function (hash, cb) {
          repo.getCommitParsed(hash, function (err, commit) {
            if (err) return cb(err)
            var commitPath = [repo.id, 'commit', commit.id]
            var treePath = [repo.id, 'tree', commit.id]
            cb(null, '<li>' +
              '<strong>' + link(commitPath, escapeHTML(commit.title)) + '</strong><br>' +
              '<code>' + commit.id + '</code> ' +
                link(treePath, 'Tree') + '<br>' +
              (commit.separateAuthor ? escapeHTML(commit.author.name) + ' authored on ' + commit.author.date.toLocaleString() + '<br>' : '') +
              escapeHTML(commit.committer.name) + ' committed on ' + commit.committer.date.toLocaleString() +
              '</li>')
          })
        })
      ),
      pull.once('</ul>')
    ]))
  }

  /* Repo tree */

  function revMenu(repo, currentName) {
    var baseHref = '/' + encodeURIComponent(repo.id) + '/tree/'
    var onchange = 'location.href="' + baseHref + '" + this.value'
    var currentGroup
    return cat([
      pull.once('<select onchange="' + escapeHTML(onchange) + '">'),
      pull(
        repo.refs(),
        pull.map(function (ref) {
          var m = ref.name.match(/^refs\/([^\/]*)\/(.*)$/) || [,, ref.name]
          var group = m[1]
          var name = m[2]

          var optgroup = (group === currentGroup) ? '' :
            (currentGroup ? '</optgroup>' : '') +
            '<optgroup label="' + (refLabels[group] || group) + '">'
          currentGroup = group
          var selected = (name == currentName) ? ' selected="selected"' : ''
          var htmlName = escapeHTML(name)
          return optgroup +
            '<option value="' + htmlName + '"' + selected + '>' +
              htmlName + '</option>'
        })
      ),
      readOnce(function (cb) {
        cb(null, currentGroup ? '</optgroup>' : '')
      }),
      pull.once('</select>')
    ])
  }

  function renderRepoLatest(repo, rev) {
    return readOnce(function (cb) {
      repo.getCommitParsed(rev, function (err, commit) {
        if (err) return cb(err)
        var commitPath = [repo.id, 'commit', commit.id]
        cb(null, '<p>' +
          'Latest: <strong>' + link(commitPath, escapeHTML(commit.title)) +
          '</strong><br>' +
          '<code>' + commit.id + '</code><br> ' +
          escapeHTML(commit.committer.name) + ' committed on ' +
          commit.committer.date.toLocaleString() +
          (commit.separateAuthor ? '<br>' +
            escapeHTML(commit.author.name) + ' authored on ' +
            commit.author.date.toLocaleString() : '') +
        '</p>')
      })
    })
  }

  // breadcrumbs
  function linkPath(basePath, path) {
    path = path.slice()
    var last = path.pop()
    return path.map(function (dir, i) {
      return link(basePath.concat(path.slice(0, i+1)), dir)
    }).concat(last).join(' / ')
  }

  function renderRepoTree(repo, rev, path) {
    var pathLinks = linkPath([repo.id, 'tree'], [rev].concat(path))
    return cat([
      pull.once('<h3>Files: ' + pathLinks + '</h3><ul>'),
      pull(
        repo.readDir(rev, path),
        pull.map(function (file) {
          var type = (file.mode === 040000) ? 'tree' : 'blob'
          var filePath = [repo.id, type, rev].concat(path, file.name)
          return '<li>' + link(filePath) + '</li>'
        })
      ),
      pull.once('</ul>')
    ])
  }

  /* Repo readme */

  function renderRepoReadme(repo, branch, path) {
    return readNext(function (cb) {
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
            return cb(null, pull.once(path.length ? '' : '<p>No readme</p>'))
          repo.getObject(file.id, function (err, obj) {
            if (err) return cb(null, pull.empty())
            cb(null, cat([
              pull.once('<h4>' + escapeHTML(file.name) + '</h4>'),
              pull.once('<blockquote>'),
              /\.md|\/.markdown/i.test(file.name) ?
                readOnce(function (cb) {
                  pull(obj.read, pull.collect(function (err, bufs) {
                    if (err) return cb(err)
                    var buf = Buffer.concat(bufs, obj.length)
                    cb(null, marked(buf.toString()))
                  }))
                })
              : cat([
                pull.once('<pre>'),
                pull(obj.read, escapeHTMLStream()),
                pull.once('</pre>')
              ]),
              pull.once('</blockquote>')
            ]))
          })
        })
      )
    })
  }

  /* Repo commit */

  function serveRepoCommit(repo, rev) {
    return renderRepoPage(repo, rev, cat([
      pull.once('<h3>Commit ' + rev + '</h3>'),
      readOnce(function (cb) {
        repo.getCommitParsed(rev, function (err, commit) {
          if (err) return cb(err)
          var commitPath = [repo.id, 'commit', commit.id]
          var treePath = [repo.id, 'tree', commit.tree]
          cb(null,
            '<p><strong>' + link(commitPath, escapeHTML(commit.title)) +
              '</strong></p>' +
            pre(commit.body) +
            '<p>' +
            (commit.separateAuthor ? escapeHTML(commit.author.name) +
              ' authored on ' + commit.author.date.toLocaleString() + '<br>'
              : '') +
            escapeHTML(commit.committer.name) + ' committed on ' +
              commit.committer.date.toLocaleString() + '</p>' +
            '<p>' + commit.parents.map(function (id) {
              return 'Parent: ' + link([repo.id, 'commit', id], id)
            }).join('<br>') + '</p>' +
            '<p>' +
              (commit.tree ? 'Tree: ' + link(treePath) : 'No tree') +
            '</p>')
        })
      })
    ]))
  }

  /* Blob */

  function serveBlob(repo, branch, path) {
    return readNext(function (cb) {
      repo.getFile(branch, path, function (err, object) {
        if (err) return cb(null, serveBlobNotFound(repoId, err))
        cb(null, serveObjectRaw(object))
      })
    })
  }

  function serveBlobNotFound(repoId, err) {
    return serveTemplate(400, 'Blob not found', pull.values([
      '<h2>Blob not found</h2>',
      '<p>Blob in repo ' + link([repoId]) + ' was not found</p>',
      '<pre>' + escapeHTML(err.stack) + '</pre>'
    ]))
  }

  function serveObjectRaw(object) {
    return cat([
      pull.once([200, {
        'Content-Length': object.length,
        'Content-Type': 'text/plain'
      }]),
      object.read
    ])
  }

}

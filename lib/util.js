var pull = require('pull-stream')
var catMap = require('pull-cat-map')
var paramap = require('pull-paramap')
var Highlight = require('highlight.js')
var u = exports

u.imgMimes = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  tif: 'image/tiff',
  svg: 'image/svg+xml',
  bmp: 'image/bmp'
}

u.getExtension = function(filename) {
  return (/\.([^.]+)$/.exec(filename) || [,filename])[1]
}

u.readNext = function (fn) {
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

u.readOnce = function (fn) {
  var ended
  return function (end, cb) {
    fn(function (err, data) {
      if (err || ended) return cb(err || ended)
      ended = true
      cb(null, data)
    })
  }
}

u.escape = function (str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

u.encodeLink = function (url) {
  if (!Array.isArray(url)) url = [url]
  return '/' + url.map(encodeURIComponent).join('/')
}

u.link = function (parts, text, raw, props) {
  if (text == null) text = parts[parts.length-1]
  if (!raw) text = u.escape(text)
  return '<a href="' + u.encodeLink(parts) + '"' +
    (props ? ' ' + props : '') +
    '>' + text + '</a>'
}

u.timestamp = function (time, req) {
  time = Number(time)
  var d = new Date(time)
  return '<span title="' + time + '">' +
    d.toLocaleString(req._locale) + '</span>'
}

u.nav = function (links, page, after) {
  return ['<nav>'].concat(
    links.map(function (link) {
      var href = typeof link[0] == 'string' ? link[0] : u.encodeLink(link[0])
      var props = link[2] == page ? ' class="active"' : ''
      return '<a href="' + href + '"' + props + '>' + link[1] + '</a>'
    }), after || '', '</nav>').join('')
}

u.hiddenInputs = function (values) {
  return Object.keys(values).map(function (key) {
    return '<input type="hidden"' +
      ' name="' + u.escape(key) + '"' +
      ' value="' + u.escape(values[key]) + '"/>'
  }).join('')
}

u.highlight = function(code, lang) {
  if (code.length > 100000) return u.escape(code)
  try {
    return lang
      ? Highlight.highlight(lang, code).value
      : Highlight.highlightAuto(code).value
  } catch(e) {
    if (/^Unknown language/.test(e.message))
      return u.escape(code)
    throw e
  }
}

u.pre = function (text) {
  return '<pre>' + u.escape(text) + '</pre>'
}

u.json = function (obj) {
  return u.linkify(u.pre(JSON.stringify(obj, null, 2)))
}

u.linkify = function (text) {
  // regex is from ssb-ref
  return text.replace(/(@|%|&|&amp;)[A-Za-z0-9\/+]{43}=\.[\w\d]+/g, function (str) {
    return '<a href="/' + encodeURIComponent(str) + '">' + str + '</a>'
  })
}

u.readObjectString = function (obj, cb) {
  pull(obj.read, pull.collect(function (err, bufs) {
    if (err) return cb(err)
    cb(null, Buffer.concat(bufs, obj.length).toString('utf8'))
  }))
}

u.pullReverse = function () {
  return function (read) {
    return u.readNext(function (cb) {
      pull(read, pull.collect(function (err, items) {
        cb(err, items && pull.values(items.reverse()))
      }))
    })
  }
}

function compareMsgs(a, b) {
  return (a.value.timestamp - b.value.timestamp) || (a.key - b.key)
}

u.pullSort = function (comparator, descending) {
  return function (read) {
    return u.readNext(function (cb) {
      pull(read, pull.collect(function (err, items) {
        if (err) return cb(err)
        items.sort(comparator)
        if (descending) items.reverse()
        cb(null, pull.values(items))
      }))
    })
  }
}

u.sortMsgs = function (descending) {
  return u.pullSort(compareMsgs, descending)
}

u.truncate = function (str, len) {
  str = String(str)
  return str.length < len ? str : str.substr(0, len) + '…'
}

u.messageTitle = function (msg) {
  var c = msg.value.content
  return u.truncate(c.title || c.text || msg.key, 40)
}

u.ifModifiedSince = function (req, lastMod) {
  var ifModSince = req.headers['if-modified-since']
  if (!ifModSince) return false
  var d = new Date(ifModSince)
  return d && Math.floor(d/1000) >= Math.floor(lastMod/1000)
}

u.decryptMessages = function (sbot) {
  return paramap(function (msg, cb) {
    var c = msg && msg.value && msg.value.content
    if (c && typeof c === 'string' && c.slice(-4) === '.box') {
      sbot.private.unbox(msg.value.content, function (err, content) {
        if (err) return cb(null, msg) // leave message encrypted
        var msg1 = {}
        for (var k in msg) msg1[k] = msg[k]
        msg1.value = {}
        for (var j in msg.value) msg1.value[j] = msg.value[j]
        msg1.value.private = true
        msg1.value.content = content
        if (!content.recps) {
          sbot.whoami(function (err, feed) {
            if (err) return cb(err)
            content.recps = [msg1.value.author]
            if (feed.id !== msg1.value.author) content.recps.push(feed.id)
            cb(null, msg1)
          })
        } else cb(null, msg1)
      })
    } else cb(null, msg)
  }, 4)
}

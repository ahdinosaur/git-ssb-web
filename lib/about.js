var pull = require('pull-stream')
var cat = require('pull-cat')
var u = require('./util')
var ref = require('ssb-ref')
var asyncMemo = require('asyncmemo')

function mixin(a, b) {
  if (b) for (var k in b) a[k] = b[k]
}

module.exports = function (sbot, source) {
  var abouts = {/* link: {feed: name} */}
  var msgs = {/* key: content */}

  pull(
    sbot.createLogStream({old: false}),
    u.decryptMessages(sbot),
    u.readableMessages(),
    pull.drain(processMsg, function (err) {
      if (err) console.error('about', err)
    })
  )

  var getAboutInfo = asyncMemo(function (id, cb) {
    var abt = abouts[id] = {}
    var _err
    var w = 1
    if (ref.isMsg(id)) {
      w++
      sbot.get(id, function (err, value) {
        if (err) {
          console.error('about: missing message', id, err)
          if (!--w) next()
          return
        }
        u.decryptMessage(sbot, {key: id, value: value}, function (err, msg) {
          if (err) console.error('decrypt failed', id, err)
          else if (u.isMessageReadable(msg)) {
            msgs[id] = msg && msg.value && msg.value.content
          }
          if (!--w) next()
        })
      })
    }
    pull(
      sbot.links({
        rel: 'about',
        values: true,
        dest: id
      }),
      u.decryptMessages(sbot),
      u.readableMessages(),
      pull.drain(processMsg, function (err) {
        _err = err
        if (!--w) next()
      })
    )
    function next() {
      cb(_err, abt)
    }
  })

  function processMsg(msg) {
    var c = msg.value.content
    if (!c) return

    // handle receiving a message after receiving a link to it
    if (msg.key in abouts) msgs[msg.key] = c

    var target = c.about
    if (!target) return
    var abt = abouts[target]
    if (!abt) return
    var ab = abt[msg.value.author] || (abt[msg.value.author] = {})
    for (var key in c) {
      if (key === 'about' || key === 'type') continue
      var val = c[key]
      if (!val) delete ab[key]
      else {
        if (key === 'image' && typeof val === 'object' && val.link) {
          val = val.link
        }
        ab[key] = val
      }
    }
  }

  function getAbout(dest, cb) {
    if (!dest) return cb(null, {})
    var target = dest.target || dest
    getAboutInfo(target, function (err, info) {
      if (err) return cb(err)
      // order of preference: source, owner, any, msg
      var ab = {}
      mixin(ab, msgs[target])
      for (var feed in info) mixin(ab, info[feed])
      mixin(ab, info[dest.owner || dest])
      mixin(ab, info[source])
      if (!ab.name) ab.name = u.truncate(target, 20)
      cb(null, ab)
    })
  }

  getAbout.getName = function (id, cb) {
    getAbout(id, function (err, about) {
      cb(err, about && about.name)
    })
  }

  return getAbout
}

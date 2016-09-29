/* ssb-about
 * factored out of ssb-notifier
 *
 * TODO:
 * - publish as own module
 * - handle live updates and reconnecting
 * - deprecate when ssb-names is used in scuttlebot
 */

var pull = require('pull-stream')
var cat = require('pull-cat')
var asyncMemo = require('asyncmemo')
var u = require('./util')
var ref = require('ssb-ref')

function getLink(obj) {
  return typeof obj === 'string' ? obj : obj ? obj.link : null
}

module.exports = function (sbot, id) {
  var getAbout = asyncMemo(getAboutFull, sbot, id)

  getAbout.getName = function (id, cb) {
    getAbout(id, function (err, about) {
      cb(err, about && about.name)
    })
  }

  getAbout.getImage = function (id, cb) {
    getAbout(id, function (err, about) {
      cb(err, about && about.image)
    })
  }

  return getAbout
}

// Get About info (name and icon) for a feed.
function getAboutFull(sbot, source, dest, cb) {
  var info = {}
  var target = dest && dest.target || dest
  var owner = dest && dest.owner || dest

  pull(
    cat([
      // First get About info that we gave them.
      sbot.links({
        source: source,
        dest: target,
        rel: 'about',
        values: true,
        reverse: true
      }),
      // If that isn't enough, then get About info that they gave themselves.
      sbot.links({
        source: owner,
        dest: target,
        rel: 'about',
        values: true,
        reverse: true
      }),
      // If that isn't enough, then get About info from other feeds
      sbot.links({
        dest: target,
        rel: 'about',
        values: true,
        reverse: true
      }),
      // Finally, get About info from the thing itself (if possible)
      u.readOnce(function (cb) {
        if (ref.isMsg(target)) {
          sbot.get(target, function (err, value) {
            cb(null, {key: target, value: value})
          })
        } else {
          cb()
        }
      })
    ]),
    pull.filter(function (msg) {
      return msg && msg.value && msg.value.content
    }),
    pull.drain(function (msg) {
      if (info.name && info.image) return false
      var c = msg.value.content
      if (!info.name && c.name)
        info.name = c.name
      if (!info.image && c.image)
        info.image = getLink(c.image)
    }, function (err) {
        if (err && err !== true) return cb(err)
        if (!info.name) info.name = u.truncate(target, 20)
        cb(null, info)
    })
  )

  // Keep updated as changes are made
  pull(
    sbot.links({
      dest: target,
      rel: 'about',
      live: true,
      old: false,
      values: true,
    }),
    pull.drain(function (msg) {
      if (!msg.value) return
      var c = msg.value.content
      if (!c) return
      if (msg.value.author == source || msg.value.author == owner) {
        // TODO: give about from source (self) priority over about from owner
        if (c.name)
          info.name = c.name
        if (c.image)
          info.image = getLink(c.image)
      } else {
        if (c.name && !info.name)
          info.name = c.name
        if (c.image && !info.image)
          info.image = getLink(c.image)
      }
    }, function (err) {
      if (err) console.error('about', err)
    })
  )
}

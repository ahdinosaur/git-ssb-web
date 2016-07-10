var pull = require('pull-stream')
var asyncMemo = require('asyncmemo')

module.exports = function (sbot) {
  return asyncMemo(getVotes, sbot)
}

function getVotes(sbot, id, cb) {
  var upvoters, downvoters
  var result = {
    upvoters: upvoters = {},
    downvoters: downvoters = {},
    upvotes: 0,
    downvotes: 0
  }

  pull(
    sbot.links({dest: id, rel: 'vote', values: true, live: true}),
    pull.drain(processMsg, function (err) {
      if (err) console.error('vote', err)
    })
  )

  function processMsg(msg) {
    if (!msg) return
    if (msg.sync) return cb(null, result)
    if (!msg.value) return
    var vote = ((msg.value.content || 0).vote || 0).value
    var author = msg.value.author

    // remove old vote, if any
    if (author in upvoters) {
      result.upvotes--
      delete result.upvoters[author]
    } else if (author in downvoters) {
      result.downvotes--
      delete result.downvoters[author]
    }

    // add new vote
    if (vote > 0) {
      result.upvoters[author] = vote
      result.upvotes++
    } else if (vote < 0) {
      result.downvoters[author] = vote
      result.downvotes++
    }
  }
}

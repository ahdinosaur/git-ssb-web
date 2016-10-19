var pull = require('pull-stream')
var asyncMemo = require('asyncmemo')

module.exports = function (sbot) {
  var votes = {}

  pull(
    sbot.links({rel: 'vote', values: true, old: false}),
    pull.drain(processMsg, function (err) {
      if (err) console.error('vote', err)
    })
  )

  return asyncMemo(function (id, cb) {
    var result = votes[id] = {
      upvoters: {},
      downvoters: {},
      upvotes: 0,
      downvotes: 0
    }

    pull(
      sbot.links({dest: id, rel: 'vote', values: true}),
      pull.drain(processMsg, function (err) {
        cb(err, result)
      })
    )
  })

  function processMsg(msg) {
    var c = msg.value.content
    if (!c || !c.vote) return
    var result = votes[c.vote.link]
    if (!result) return
    var vote = c.vote.value
    var author = msg.value.author

    // remove old vote, if any
    if (author in result.upvoters) {
      result.upvotes--
      delete result.upvoters[author]
    } else if (author in result.downvoters) {
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

var pull = require('pull-stream')
var cat = require('pull-cat')

// work around sync not getting emitted
function logt(sbot, opt) {
  if (!opt.live) return sbot.messagesByType(opt)
  var optOld = {}, optNew = {}
  for (var k in opt) optOld[k] = opt[k], optNew[k] = opt[k]
  optOld.live = false, optOld.old = true
  optNew.live = true, optNew.old = false
  return cat([
    sbot.messagesByType(optOld),
    pull.once({sync: true}),
    sbot.messagesByType(optNew)
  ])
}

// Keep track of the set of open issues and pull-requests for each repo.
// This is like a 2P-set, where an issue/pull-request message adds to the set
// and a link rel issues with property close: true is a remove from the set.

module.exports = function (sbot) {
  var repos = {/* issue/pr id : repo id */}
  var repoIssues = {/* repo id : {issue id} */}
  var repoPRs = {/* repo id : {pr id} */}
  var closed = {/* issue/pr id */}
  var waiting = 3
  var start = new Date

  pull(
    logt(sbot, {
      type: 'issue',
      live: true,
    }),
    pull.drain(function (msg) {
      if (msg.sync) return sync()
      if (msg.key in closed) return delete closed[msg.key]
      var repoId = msg.value.content.project || msg.value.content.repo
      var issues = repoIssues[repoId] || (repoIssues[repoId] = {count: 0})
      issues[msg.key] = true
      repos[msg.key] = repoId
      issues.count++
    }, function (err) {
      if (err) console.error(err.stack || err)
    })
  )

  pull(
    logt(sbot, {
      type: 'pull-request',
      live: true,
    }),
    pull.drain(function (msg) {
      if (msg.sync) return sync()
      if (msg.key in closed) return delete closed[msg.key]
      var repoId = msg.value.content.repo
      var prs = repoPRs[repoId] || (repoPRs[repoId] = {count: 0})
      prs[msg.key] = true
      repos[msg.key] = repoId
      prs.count++
    }, function (err) {
      if (err) console.error(err.stack || err)
    })
  )

  pull(
    sbot.links({
      rel: 'issues',
      values: true,
      live: true,
    }),
    pull.map(function (msg) {
      if (msg.sync) return sync()
      return msg.value.content.issues
    }),
    pull.flatten(),
    pull.filter(function (issue) {
      return issue.open === false
    }),
    pull.drain(function (update) {
      var id = update.link
      var repoId = repos[id]
      if (repoId) {
        var issues, prs
        if ((issues = repoIssues[repoId]) && issues[id])
          delete issues[id], issues.count--
        if ((prs = repoPRs[repoId]) && prs[id])
          delete prs[id], prs.count--
      } else {
        closed[id] = true
      }
    }, function (err) {
      if (err) console.error(err.stack || err)
    })
  )

  function sync() {
    if (--waiting) return
    console.log('Issues state synced', -(start -= new Date)/1000 + 's')
  }

  return {
    getIssuesCount: function (repoId, placeholder) {
      if (waiting) return placeholder || NaN
      var issue = repoIssues[repoId]
      return issue ? issue.count : 0
    },
    getPRsCount: function (repoId, placeholder) {
      if (waiting) return placeholder || NaN
      var pr = repoPRs[repoId]
      return pr ? pr.count : 0
    },
  }
}

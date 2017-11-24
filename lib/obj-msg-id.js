// get a id of a git-update message that includes a packfile that pushed the
// given commit, or from which such a message may be reached by following
// repoBranch links.
module.exports = function (repo, commitId, cb) {
  // TODO: get packfile contents
  var msgsByObj = repo && repo._msgsByObject
  var msg = msgsByObj && msgsByObj[commitId]
  if (!msg) return cb()
  // TODO: examine index file to see if object is in there
  // but not mentioned in the message
  cb(null, msg.key)
}

### Line comment

```
{
  "type": "line-comment",
  "text": string,
  "mentions": Links,
  "repo": MsgId,
  "updateId": MsgId,
  "commitId": string,
  "filePath": string,
  "line": number,
}
```
`repo`: id of `git-repo`
`text`: text of the comment
`mentions`: mentions links associated with the text, as done with `post` messages
`updateId`: id of a `git-update` message that pushed the git commit, git trees, and git blobs needed to render the diff.
`commitId`: commit that the comment is on
`filePath`: path to the file that the comment is on
`line`: line number of the file that the comment is on

A reply to a line comment should be a message of type `post` with `root`
property set to the id of the `line-comment` message. `branch` property should follow the semantics of `branch` used in other `post` message threads.

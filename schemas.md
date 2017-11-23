### Line comment

```
{
  "type": "line-comment",
  "text": string,
  "repo": MsgId,
  "updateId": MgsIds,
  "line": number,
}
```
`repo`: id of `git-repo`
`updateId`: id of a `git-update` message that pushed the git commit, git trees, and git blobs needed to render the diff.
`commitId`: commit that the comment is on
`filePath`: path to the file that the comment is on
`line`: line number of the file that the comment is on

Replies to a line comment should be messages of type `post` with `root`
linking to the `line-comment` message.

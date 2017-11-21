var h = require('pull-hyperscript')
var u = require('./util')
var forms = exports

forms.post = function (req, repo, placeholder, rows) {
  return '<input type="radio" class="tab-radio" id="tab1" name="tab" checked="checked"/>' +
  '<input type="radio" class="tab-radio" id="tab2" name="tab"/>' +
  '<div id="tab-links" class="tab-links" style="display:none">' +
    '<label for="tab1" id="write-tab-link" class="tab1-link">' +
      req._t('post.Write') + '</label>' +
    '<label for="tab2" id="preview-tab-link" class="tab2-link">' +
      req._t('post.Preview') + '</label>' +
  '</div>' +
  (repo ?
    '<input type="hidden" id="repo-id" value="' + repo.id + '"/>'
  : '') +
  '<div id="write-tab" class="tab1">' +
    '<textarea id="post-text" name="text" class="wide-input"' +
    ' rows="' + (rows||4) + '" cols="77"' +
    (placeholder ? ' placeholder="' + placeholder + '"' : '') +
    '></textarea>' +
  '</div>' +
  '<div class="preview-text tab2" id="preview-tab"></div>' +
  '<script>' + issueCommentScript + '</script>'
}

forms.name = function (req, enabled, id, name, action, inputId, title, header) {
  if (!inputId) inputId = action

  if (!enabled) {
    return h('form', {class: 'petname', action: '', method: 'post'}, [
      header,
      h('br', {clear: 'all'})
    ])
  }

  return h('form', {class: 'petname', action: '', method: 'post'}, [
    h('input', {
      type: 'checkbox', class: 'name-checkbox', id: inputId,
      onfocus: 'this.form.name.focus()'
    }),
    h('input', {
      class: 'name', name: 'name', value: u.escape(name),
      onkeyup: 'if (event.keyCode == 27) this.form.reset()'
    }),
    h('input', {type: 'hidden', name: 'action', value: action}),
    h('input', {type: 'hidden', name: 'id', value: u.escape(id)}),
    h('label', {class: 'name-toggle', for: inputId, title: title}, [
      h('i', '✍')
    ]),
    h('input', {class: 'btn name-btn', type: 'submit', value: req._t('Rename')}),
    header
  ])
}

var issueCommentScript = '(' + function () {
  var $ = document.getElementById.bind(document)
  $('tab-links').style.display = 'block'
  $('preview-tab-link').onclick = function (e) {
    with (new XMLHttpRequest()) {
      open('POST', '', true)
      onload = function() {
        $('preview-tab').innerHTML = responseText
      }
      send('action=markdown' +
        '&repo=' + encodeURIComponent($('repo-id').value) +
        '&text=' + encodeURIComponent($('post-text').value))
    }
  }
}.toString() + ')()'

var issueCommentButtonScript = '(' + function () {
  var btn = document.getElementById('comment-close-btn')
  document.getElementById('post-text').onkeyup = function (e) {
    btn.setAttribute('value', this.value
      ? btn.getAttribute('data-value-withcomment')
      : btn.getAttribute('data-value-nocomment'))
  }
}.toString() + ')()'

forms.issueComment = function (req, issue, repo, branch, type) {
  return '<section><form action="" method="post">' +
    '<input type="hidden" name="action" value="comment">' +
    '<input type="hidden" name="id" value="' + issue.id + '">' +
    '<input type="hidden" name="issue" value="' + issue.id + '">' +
    '<input type="hidden" name="repo" value="' + repo.id + '">' +
    '<input type="hidden" name="branch" value="' + branch + '">' +
    forms.post(req, repo) +
    '<input type="submit" class="btn open" value="' +
    req._t('issue.Comment') + '" />' +
    '<input id="comment-close-btn" type="submit" class="btn"' +
    ' name="' + (issue.open ? 'close' : 'open') + '"' +
    ' value="' + req._t(issue.open ? 'issue.Close' : 'issue.Reopen',
      {type: type}) + '"' +
    ' data-value-nocomment="' + req._t(issue.open ?
      'issue.Close' : 'issue.Reopen',
      {type: type}) + '"' +
    ' data-value-withcomment="' + req._t(issue.open ?
      'issue.CommentAndClose' : 'issue.CommentAndReopen',
      {type: type}) + '"' +
    '/>' +
    '<script>' + issueCommentButtonScript + '</script>' +
    '</form></section>'
}

forms.lineComment = function (req, repo, repoBranch, commitId, filePath, line) {
  return '<section><form action="" method="post">' +
    '<input type="hidden" name="action" value="line-comment">' +
    '<input type="hidden" name="repoBranch" value="' + repoBranch.join(',') + '">' +
    '<input type="hidden" name="repo" value="' + repo.id + '">' +
    '<input type="hidden" name="commitId" value="' + commitId + '">' +
    '<input type="hidden" name="filePath" value="' + filePath + '">' +
    '<input type="hidden" name="line" value="' + line + '">' +
    forms.post(req, repo) +
    '<input type="submit" class="btn open" value="' +
    req._t('issue.LineComment') + '" />' +
    '</form></section>'
}

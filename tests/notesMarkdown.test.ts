import { test } from 'node:test'
import assert from 'node:assert/strict'
import { noteToHtml, resolveWikiLink } from '../src/renderer/notesMarkdown.ts'

test('wiki links render as note links, but not inside code', () => {
  const html = noteToHtml('See [[Runbook]], [[Hosts/web (pplm)|the web box]] and [[Runbook#Restart]].\n\n`[[not a link]]`\n')
  assert.match(html, /<a class="wikilink" href="#" data-note="Runbook">Runbook<\/a>/)
  assert.match(html, /data-note="Hosts\/web \(pplm\)">the web box<\/a>/)
  assert.match(html, /data-note="Runbook">Runbook#Restart<\/a>/)
  assert.match(html, /<code>\[\[not a link\]\]<\/code>/)
})

test('frontmatter is hidden and GitHub-flavoured Markdown renders', () => {
  const html = noteToHtml('---\nec2_key: pplm/us-west-1/i-1\n---\n# Host\n\n- [ ] restart\n- [x] patch\n')
  assert.doesNotMatch(html, /ec2_key/)
  assert.match(html, /<h1>Host<\/h1>/)
  assert.match(html, /type="checkbox"/)
})

test('a wiki link resolves by path or by file name anywhere', () => {
  const paths = ['Runbook.md', 'EC2 Remote/Hosts/web (pplm).md', 'Daily/2026-10-18.md']
  assert.equal(resolveWikiLink('runbook', paths), 'Runbook.md')
  assert.equal(resolveWikiLink('web (pplm)', paths), 'EC2 Remote/Hosts/web (pplm).md')
  assert.equal(resolveWikiLink('Daily/2026-10-18', paths), 'Daily/2026-10-18.md')
  assert.equal(resolveWikiLink('missing', paths), null)
})

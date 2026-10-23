import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { LinkFolder, LinkItem } from '../src/shared/links.ts'
import { browserFor, cleanTag, findSaved, panelEntries, parseAppInfo, parseFrontPage, savedItem, scriptProblem, tagSuggestions } from '../src/shared/linksPanel.ts'
import { checkCombo, checkGlobalCombo } from '../src/shared/keyCombos.ts'

const link = (id: string, extra: Partial<LinkItem> = {}): LinkItem => ({ id, type: 'link', kind: 'link', title: id, url: `https://${id}.example.com/`, addedAt: 1000, updatedAt: 1000, ...extra })
const folder = (id: string, name: string, parentId?: string, order = 0): LinkFolder => ({ id, type: 'folder', name, order, updatedAt: 0, ...(parentId ? { parentId } : {}) })

test('browsers: Safari and Chromium dictionaries, Firefox family unreadable, anything else not a browser', () => {
  assert.equal(browserFor('com.apple.Safari')?.script, 'tell application id "com.apple.Safari" to return (URL of current tab of front window) & linefeed & (name of current tab of front window)')
  for (const id of ['com.google.Chrome', 'company.thebrowser.Browser', 'company.thebrowser.dia', 'com.brave.Browser', 'com.microsoft.edgemac']) {
    assert.match(browserFor(id)?.script ?? '', /active tab of front window\) & linefeed & \(title of active tab/, id)
  }
  assert.deepEqual(browserFor('app.zen-browser.zen'), { name: 'Zen', script: null })
  assert.deepEqual(browserFor('org.mozilla.firefox'), { name: 'Firefox', script: null })
  assert.equal(browserFor('dev.warp.Warp-Stable'), null)
  // Never a script for a name from outside the table, even one that looks like a property of every object.
  assert.equal(browserFor('constructor'), null)
  assert.equal(browserFor('" to do shell script "x'), null)
})

test('front app from lsappinfo, page from the script', () => {
  const info = '"Google Chrome" ASN:0x0-0x1a01a: (in front) \n    bundleID="com.google.Chrome"\n    bundle path="/Applications/Google Chrome.app"\n'
  assert.deepEqual(parseAppInfo(info), { name: 'Google Chrome', bundleId: 'com.google.Chrome' })
  assert.deepEqual(parseAppInfo('[ NULL ] ASN:0x0-0x1: \n bundleID=[ NULL ]'), { name: '', bundleId: '' })
  assert.deepEqual(parseFrontPage('https://www.speedtest.net/result/19821881827\nSpeedtest by Ookla - The Global Broadband Speed Test\n'), { url: 'https://www.speedtest.net/result/19821881827', title: 'Speedtest by Ookla - The Global Broadband Speed Test' })
  assert.deepEqual(parseFrontPage('missing value\nmissing value\n'), { url: '', title: '' })
  assert.deepEqual(parseFrontPage('favorites://\nFavorites'), { url: 'favorites://', title: 'Favorites' })
  assert.deepEqual(parseFrontPage('not a url\nx'), { url: '', title: 'x' })
  assert.equal(scriptProblem('execution error: Not authorized to send Apple events to Safari. (-1743)'), 'not-allowed')
  assert.equal(scriptProblem("execution error: Google Chrome got an error: Can’t get window 1. Invalid index. (-1719)"), 'no-window')
  assert.equal(scriptProblem('something else'), 'failed')
})

test('saving: a page already kept is found by any spelling of its address and updated, not added again', () => {
  const kept = link('a', { url: 'https://www.Example.com/docs/', title: 'Docs', tags: ['old'], note: 'n', starred: true, folderId: 'f1', description: 'd' })
  const links = [kept, link('b'), { ...link('c'), kind: 'note' as const, url: undefined }]
  assert.equal(findSaved(links, 'https://example.com/docs')?.id, 'a')
  assert.equal(findSaved(links, '  '), undefined)
  assert.equal(findSaved(links, 'https://example.com/other'), undefined)

  const updated = savedItem(kept, { url: 'https://example.com/docs', title: '  New name ', note: '', tags: ['#aws / iam', 'aws/iam', ''], folderId: undefined, starred: false }, 5000, () => 'new')
  assert.equal(updated.id, 'a')
  assert.equal(updated.title, 'New name')
  assert.equal(updated.addedAt, 1000, 'keeps when it was first saved')
  assert.equal(updated.url, 'https://www.Example.com/docs/', 'keeps its own spelling of the same address')
  assert.equal(updated.description, 'd', 'keeps what the form does not show')
  assert.deepEqual(updated.tags, ['aws/iam'])
  for (const k of ['note', 'folderId', 'starred'] as const) assert.equal(k in updated, false, `${k} cleared`)

  const fresh = savedItem(undefined, { url: 'https://new.example.org/x', title: '', note: 'why', tags: [], starred: true }, 7000, () => 'id1')
  assert.deepEqual(fresh, { id: 'id1', type: 'link', kind: 'link', url: 'https://new.example.org/x', title: 'new.example.org', addedAt: 7000, updatedAt: 7000, note: 'why', starred: true })
})

test('tags: cleaned as typed, suggested by match then use', () => {
  assert.equal(cleanTag('  ##Work /  AWS  Accounts/ '), 'Work/AWS Accounts')
  assert.equal(cleanTag('///'), '')
  const all = [{ path: 'aws', count: 3 }, { path: 'aws/iam', count: 9 }, { path: 'AI', count: 29 }, { path: 'Rivian', count: 215 }]
  assert.deepEqual(tagSuggestions(all, '', []), ['Rivian', 'AI', 'aws/iam', 'aws'])
  assert.deepEqual(tagSuggestions(all, 'iam', []), ['aws/iam'])
  assert.deepEqual(tagSuggestions(all, 'aw', ['AI']), ['aws', 'aws/iam'])
})

test('search list: collections first, recent items, scopes and keywords', () => {
  const folders = [folder('f1', 'Tech Stuff', undefined, 1), folder('f2', 'Commands', 'f1'), folder('f3', 'Rules Of Life', undefined, 2)]
  const links = [
    link('rivian1', { tags: ['Rivian'], addedAt: 10 }),
    link('rivian2', { tags: ['Rivian/R1S'], addedAt: 20, openedAt: 900 }),
    link('ai', { tags: ['AI'], addedAt: 30, title: 'Claude docs' }),
    link('cmd', { kind: 'file', url: undefined, path: '/x/Useful Commands.txt', title: 'Useful Commands.txt', folderId: 'f2', addedAt: 40 }),
    link('life', { folderId: 'f3', addedAt: 50, keyword: 'rules' }),
    link('gone', { archived: true, tags: ['AI'], addedAt: 60 })
  ]
  const shape = (e: ReturnType<typeof panelEntries>[number]): string => (e.kind === 'tag' ? `#${e.path}:${e.count}` : e.kind === 'folder' ? `/${e.folder.name}:${e.count}` : e.item.id)

  // Nothing typed: top-level tags by size, top-level folders in order, then the latest used (archived left out).
  assert.deepEqual(panelEntries(links, folders, '', null).map(shape), ['#Rivian:2', '#AI:1', '/Tech Stuff:1', '/Rules Of Life:1', 'rivian2', 'life', 'cmd', 'ai', 'rivian1'])
  // Inside a tag: the tags below it, then its items.
  assert.deepEqual(panelEntries(links, folders, '', { kind: 'tag', path: 'Rivian' }).map(shape), ['#Rivian/R1S:1', 'rivian2', 'rivian1'])
  // Inside a folder: its subfolders and everything below it.
  assert.deepEqual(panelEntries(links, folders, '', { kind: 'folder', id: 'f1' }).map(shape), ['/Commands:1', 'cmd'])
  // Typed: matching tags and folders, then items; a nested tag is found by its own name.
  assert.deepEqual(panelEntries(links, folders, 'r1s', null).map(shape), ['#Rivian/R1S:1', 'rivian2'])
  assert.deepEqual(panelEntries(links, folders, 'command', null).map(shape), ['/Commands:1', 'cmd'])
  // A keyword typed exactly beats everything.
  assert.equal(shape(panelEntries(links, folders, 'rules', null)[0]), 'life')
  assert.deepEqual(panelEntries(links, folders, 'claude', { kind: 'tag', path: 'Rivian' }), [])
})

test('keys: the Links panels may take ⌃ + letter, with a warning; global keys never share a combination', () => {
  assert.match((checkGlobalCombo('ctrl+s', undefined) as { reason: string }).reason, /terminal control key/)
  const ok = checkGlobalCombo('ctrl+s', undefined, { controlLetters: true })
  assert.equal(ok.ok, true)
  assert.match(ok.ok ? ok.notes.join(' ') : '', /Anybox/)
  const taken = checkGlobalCombo('ctrl+f', undefined, { controlLetters: true, others: [{ combo: 'ctrl+f', does: 'searches Links' }] })
  assert.equal(taken.ok, false)
  assert.match(taken.ok ? '' : taken.reason, /already searches Links/)
  const section = checkCombo('ctrl+cmd+s', 'notes', undefined, [{ combo: 'ctrl+cmd+s', does: 'saves the page in front to Links' }])
  assert.equal(section.ok, false)
  assert.match(section.ok ? '' : section.reason, /saves the page in front to Links, from any app/)
})

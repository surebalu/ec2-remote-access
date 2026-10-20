import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cloudName, displayPath, favoritePatch, formatDate, formatSize, freeName, isBundle, kindOf, parentOf, pathSteps, placeKind, sortEntries } from '../src/shared/finder.ts'

const e = (name: string, type: 'file' | 'dir' = 'file', size = 0, mtime = 0) => ({ name, path: `/x/${name}`, type, size, mtime, mode: 0 })

test('cloud folders and well-known places are named and drawn as Finder does', () => {
  assert.equal(cloudName('GoogleDrive-me@example.com'), 'Google Drive - me@example.com')
  assert.equal(cloudName('OneDrive-Personal'), 'OneDrive - Personal')
  assert.equal(cloudName('Dropbox'), 'Dropbox')
  assert.equal(cloudName('SomeVendor-Work'), 'Some Vendor - Work')
  assert.equal(placeKind('/Users/me/Downloads', '/Users/me'), 'downloads')
  assert.equal(placeKind('/Applications', '/Users/me'), 'applications')
  assert.equal(placeKind('/Users/me/Documents/Work', '/Users/me'), 'folder')
})

test('Kind and Size columns: folders, applications, extensions and decimal units', () => {
  assert.equal(kindOf(e('Docs', 'dir')), 'Folder')
  assert.equal(kindOf(e('Xcode.app', 'dir')), 'Application')
  assert.equal(isBundle(e('Xcode.app', 'dir')), true)
  assert.equal(kindOf(e('scan.PDF')), 'PDF document')
  assert.equal(kindOf(e('photo.png')), 'PNG image')
  assert.equal(kindOf(e('notes.md')), 'Markdown')
  assert.equal(kindOf(e('report.xlsx')), 'Spreadsheet')
  assert.equal(kindOf(e('thing.xyz')), 'XYZ file')
  assert.equal(kindOf(e('Makefile')), 'Document')
  assert.equal(formatSize(e('Docs', 'dir')), '--')
  assert.equal(formatSize(e('a', 'file', 1)), '1 byte')
  assert.equal(formatSize(e('a', 'file', 999)), '999 bytes')
  assert.equal(formatSize(e('a', 'file', 4_200)), '4 KB')
  assert.equal(formatSize(e('a', 'file', 1_234_567)), '1.2 MB')
  assert.equal(formatSize(e('a', 'file', 250_000_000)), '250 MB')
})

test('dates read Today / Yesterday / Mon D, YYYY at time', () => {
  const now = new Date(2026, 9, 19, 12, 0).getTime()
  assert.match(formatDate(new Date(2026, 9, 19, 9, 41).getTime(), now, 'en-US'), /^Today at 9:41\sAM$/)
  assert.match(formatDate(new Date(2026, 9, 18, 23, 5).getTime(), now, 'en-US'), /^Yesterday at 11:05\sPM$/)
  assert.match(formatDate(new Date(2025, 11, 13, 19, 10).getTime(), now, 'en-US'), /^Dec 13, 2025 at 7:10\sPM$/)
})

test('sorting mixes folders with files, numbers in order; the path bar and parent folder', () => {
  const list = [e('file10'), e('file2'), e('Alpha', 'dir'), e('beta', 'file', 5, 300)]
  assert.deepEqual(sortEntries(list, { key: 'name', dir: 1 }).map((x) => x.name), ['Alpha', 'beta', 'file2', 'file10'])
  assert.deepEqual(sortEntries(list, { key: 'name', dir: -1 }).map((x) => x.name), ['file10', 'file2', 'beta', 'Alpha'])
  assert.equal(sortEntries(list, { key: 'mtime', dir: -1 })[0].name, 'beta')
  assert.deepEqual(pathSteps('/Users/me/Docs').map((s) => s.name), ['Macintosh HD', 'Users', 'me', 'Docs'])
  assert.equal(pathSteps('/Users/me/Docs').at(-1)!.path, '/Users/me/Docs')
  assert.equal(parentOf('/Users/me/Docs'), '/Users/me')
  assert.equal(parentOf('/Users'), '/')
  assert.equal(parentOf('/'), '/')
  assert.equal(freeName('untitled folder', ['untitled folder', 'Untitled Folder 2']), 'untitled folder 3')
  assert.equal(freeName('untitled folder', []), 'untitled folder')
})

test('favorites: adding shows a hidden one again; removing a Finder favorite only hides it here', () => {
  assert.deepEqual(favoritePatch({ finderExtra: [], finderHidden: ['/a'] }, '/a', true), { finderExtra: ['/a'], finderHidden: [] })
  assert.deepEqual(favoritePatch({ finderExtra: ['/a'], finderHidden: [] }, '/a', true), { finderExtra: ['/a'], finderHidden: [] }, 'no duplicates')
  assert.deepEqual(favoritePatch({ finderExtra: ['/a'], finderHidden: [] }, '/a', false), { finderExtra: [], finderHidden: ['/a'] })
  assert.deepEqual(favoritePatch({}, '/b', false), { finderExtra: [], finderHidden: ['/b'] })
})

test('folders read short in the launcher: cloud drives by name, home as ~, long paths cut in the middle', () => {
  const home = '/Users/me'
  assert.equal(displayPath('/Users/me/Library/CloudStorage/GoogleDrive-me@example.com/Shared drives/Quality (Shared)', home), 'Google Drive/Shared drives/Quality (Shared)')
  assert.equal(displayPath('/Users/me/Library/CloudStorage/OneDrive-Contoso/Docs', home), 'OneDrive/Docs')
  assert.equal(displayPath('/Users/me/Library/Mobile Documents/com~apple~CloudDocs/Taxes', home), 'iCloud Drive/Taxes')
  assert.equal(displayPath('/Users/me/Documents', home), '~/Documents')
  assert.equal(displayPath('/Applications', home), '/Applications')
  const long = displayPath('/Users/me/Documents/Surendra-Personal/codebase/Mainspring/remote-access-tool/src/renderer/launcher', home, 40)
  assert.ok(long.length <= 40, long)
  assert.ok(long.startsWith('~/…/') && long.endsWith('/renderer/launcher'), long)
})

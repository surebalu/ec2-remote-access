import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanFolder, dailyNoteRel, frontmatterKey, hostNoteRel, notePath, safeFileName } from '../src/main/notesPaths.ts'

test('notes stay inside the notes folder and are Markdown files', () => {
  assert.equal(notePath('/vault', 'EC2 Remote/Hosts/web (pplm).md'), '/vault/EC2 Remote/Hosts/web (pplm).md')
  assert.equal(notePath('/vault', '/Daily/2026-10-18.md'), '/vault/Daily/2026-10-18.md')
  for (const bad of ['../outside.md', 'a/../../outside.md', '..\\outside.md', '', 'notes.txt', '.obsidian/app.json']) {
    assert.throws(() => notePath('/vault', bad), undefined, bad)
  }
  assert.throws(() => notePath('/vault', '/etc/passwd'), undefined)
})

test('host notes are named after the host and its account, and found again by their ec2_key', () => {
  assert.equal(hostNoteRel('EC2 Remote/Hosts', { name: 'MSPROD-25x-3DSpace', instanceId: 'i-0edf', profile: 'pplm' }), 'EC2 Remote/Hosts/MSPROD-25x-3DSpace (pplm).md')
  assert.equal(hostNoteRel('', { name: '', instanceId: 'i-0edf', profile: 'qplm' }), 'EC2 Remote/Hosts/i-0edf (qplm).md')
  assert.equal(hostNoteRel('Servers', { name: 'nas: box/1', instanceId: 'x', profile: 'servers', manual: true }), 'Servers/nas- box-1.md')
  assert.equal(frontmatterKey('---\nec2_key: pplm/us-west-1/i-0edf\naccount: pplm\n---\n# x'), 'pplm/us-west-1/i-0edf')
  assert.equal(frontmatterKey('# no frontmatter\nec2_key: nope'), null)
  assert.equal(safeFileName('a/b:c*d?'), 'a-b-c-d-')
})

test('folders are cleaned, and the daily note follows Obsidian\'s daily-notes folder', () => {
  assert.equal(cleanFolder(' Work / Hosts '), 'Work/Hosts')
  assert.equal(cleanFolder('../../etc'), 'etc')
  assert.equal(cleanFolder(''), 'EC2 Remote/Hosts')
  const day = new Date(2026, 9, 18, 9, 30)
  assert.equal(dailyNoteRel({ folder: 'Journal/Daily' }, day), 'Journal/Daily/2026-10-18.md')
  assert.equal(dailyNoteRel({}, day), '2026-10-18.md')
  assert.equal(dailyNoteRel(null, day), 'EC2 Remote/Daily/2026-10-18.md')
})

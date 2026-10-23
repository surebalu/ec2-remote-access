import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agoLabel, boardStep, linkFileDest, mergeStamps } from '../src/shared/dataFolder.ts'
import { applyOps, DELETED, emptyDoc, itemsOf, mergeDocs, putOp, type RecordItem } from '../src/shared/records.ts'

test('boards: the later save wins, a later deletion removes both copies', () => {
  assert.equal(boardStep(200, 100), 'push')
  assert.equal(boardStep(100, 200), 'pull')
  assert.equal(boardStep(-1, 50), 'pull', 'only in the data folder')
  assert.equal(boardStep(50, -1), 'push', 'only on this Mac')
  assert.equal(boardStep(100, 100), 'keep')
  assert.equal(boardStep(100, 90, 150), 'delete')
  assert.equal(boardStep(-1, 90, 150), 'delete', 'deleted here, still in the folder')
  assert.equal(boardStep(300, 90, 150), 'push', 'saved again after the deletion was recorded')
  assert.equal(boardStep(-1, -1, 150), 'keep')
})

test('deletion lists merge to the later time, and say which side lacked what', () => {
  assert.deepEqual(mergeStamps({ a: 1, b: 5 }, { b: 3, c: 2 }), { merged: { a: 1, b: 5, c: 2 }, aChanged: true, bChanged: true })
  assert.deepEqual(mergeStamps({ a: 1 }, { a: 1 }), { merged: { a: 1 }, aChanged: false, bChanged: false })
  assert.deepEqual(mergeStamps({}, { a: 1 }), { merged: { a: 1 }, aChanged: true, bChanged: false })
})

test('Links files keep their folders in the data folder; strays go to Other', () => {
  const from = '/Users/me/Documents/EC2 Remote Access/Links Files'
  assert.equal(linkFileDest(`${from}/Tech Stuff/Commands/Useful Commands.txt`, from, '/Volumes/home/EC2/Links Files'), '/Volumes/home/EC2/Links Files/Tech Stuff/Commands/Useful Commands.txt')
  assert.equal(linkFileDest('/tmp/x/report.pdf', `${from}/`, '/Volumes/home/EC2/Links Files/'), '/Volumes/home/EC2/Links Files/Other/report.pdf')
})

test('two copies of a list merged while apart: both sides’ edits survive, deletions win over older copies', () => {
  const item = (id: string, at: number, title = id): RecordItem & { title: string } => ({ id, type: 'task', updatedAt: at, title })
  let mac = applyOps(emptyDoc(), [putOp(item('a', 10)), putOp(item('b', 10)), putOp(item('c', 10))], 10)
  let nas = structuredClone(mac)
  // Apart: this Mac renames a and deletes b; the other side renames c and adds d.
  mac = applyOps(mac, [putOp(item('a', 20, 'a from the Mac')), { op: 'delete', id: 'b' }], 20)
  nas = applyOps(nas, [putOp(item('c', 30, 'c from the other Mac')), putOp(item('d', 30))], 30)
  const here = mergeDocs(mac, nas)
  const there = mergeDocs(nas, mac)
  assert.ok(here.changed && there.changed)
  const titles = (d: typeof here.doc): string[] => itemsOf<RecordItem & { title: string }>(d, 'task').map((t) => t.title).sort()
  assert.deepEqual(titles(here.doc), ['a from the Mac', 'c from the other Mac', 'd'])
  assert.deepEqual(titles(there.doc), titles(here.doc), 'both sides end up the same')
  assert.equal(here.doc.items.b.type, DELETED, 'the deletion is kept as a marker')
  // Merged again with nothing new: no change, so nothing is written.
  assert.equal(mergeDocs(here.doc, there.doc).changed, false)
})

test('last sync as words', () => {
  const now = 1_000_000_000
  assert.equal(agoLabel(now - 10_000, now), 'just now')
  assert.equal(agoLabel(now - 5 * 60_000, now), '5 min ago')
  assert.equal(agoLabel(now - 3 * 3600_000, now), '3 h ago')
  assert.equal(agoLabel(now - 3 * 86400_000, now), '3 days ago')
})

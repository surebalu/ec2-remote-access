import { test } from 'node:test'
import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { walk } from '../src/main/storage/scanner.ts'

const MB = 1_000_000

/** A small disk: big and small files, a hidden cache, an app, a hard link and two identical files. */
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ec2ra-scan-'))
  const fill = (n: number, seed = 1): Buffer => { const b = Buffer.alloc(n); for (let i = 0; i < n; i += 4096) b[i] = (i / 4096 + seed) & 0xff; return b }
  await mkdir(join(root, 'Movies/Trips'), { recursive: true })
  await writeFile(join(root, 'Movies/Trips/holiday.mp4'), fill(3 * MB))
  await writeFile(join(root, 'Movies/Trips/copy of holiday.mp4'), fill(3 * MB))
  await writeFile(join(root, 'Movies/notes.txt'), 'small')
  await mkdir(join(root, '.cache/tool'), { recursive: true })
  await writeFile(join(root, '.cache/tool/blob.bin'), fill(2 * MB, 7))
  await mkdir(join(root, 'Big.app/Contents'), { recursive: true })
  await writeFile(join(root, 'Big.app/Contents/binary'), fill(4 * MB, 3))
  await mkdir(join(root, 'Downloads'), { recursive: true })
  await writeFile(join(root, 'Downloads/setup.dmg'), fill(5 * MB, 9))
  await link(join(root, 'Downloads/setup.dmg'), join(root, 'Downloads/setup-link.dmg'))
  for (let i = 0; i < 20; i++) await writeFile(join(root, `Downloads/small-${i}.txt`), fill(8000, i))
  await mkdir(join(root, 'project/node_modules/dep/node_modules'), { recursive: true })
  await writeFile(join(root, 'project/node_modules/dep/index.js'), fill(1_200_000, 4))
  await mkdir(join(root, 'Shared'), { recursive: true })
  return root
}

test('a scan counts every byte once, keeps big files by name and folds small ones into their folder', async () => {
  const root = await fixture()
  try {
    const tree = await walk({ root, closed: [{ path: join(root, 'Shared'), reason: 'cloud' }] })
    const view = tree.view(0)
    const names = view.children.map((c) => c.name)
    assert.ok(names.includes('Movies') && names.includes('Downloads') && names.includes('.cache') && names.includes('Big.app'))
    // The hard link's bytes count once: the folder holds one 5 MB image, not two.
    const downloads = tree.view(tree.find(join(root, 'Downloads')))
    assert.ok(downloads.node.size < 5.6 * MB, `downloads ${downloads.node.size}`)
    assert.ok(downloads.small.files >= 20, 'small files counted together')
    assert.equal(downloads.children.filter((c) => c.name.startsWith('small-')).length, 0, 'small files have no names')
    // Everything beneath adds up to the root.
    assert.equal(view.children.reduce((s, c) => s + c.size, 0) + view.small.bytes, view.node.size)
    // A closed folder is listed but not read.
    assert.equal(tree.node(tree.find(join(root, 'Shared'))).closed, 'cloud')
    assert.equal(tree.node(tree.find(join(root, 'Big.app'))).package, true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('large files, search and hidden items come from the tree, leaving packages out', async () => {
  const root = await fixture()
  try {
    const tree = await walk({ root })
    const large = tree.largest(2.5 * MB, 10)
    assert.deepEqual(large.map((f) => f.name).sort(), ['copy of holiday.mp4', 'holiday.mp4', 'setup.dmg'])
    assert.ok(!large.some((f) => f.path.includes('Big.app')), 'files inside an app are its own')
    assert.deepEqual(tree.search('.mp4', 0, 10).map((f) => f.name).sort(), ['copy of holiday.mp4', 'holiday.mp4'])
    assert.deepEqual(tree.search('.dmg .mp4', 0, 10).length, 3)
    assert.deepEqual(tree.search('"trips"', 0, 10).map((f) => f.name), ['Trips'])
    assert.deepEqual(tree.search('holiday', 0, 10).length, 2)
    assert.deepEqual(tree.hidden(MB, 10).map((h) => h.name), ['.cache'])
    assert.deepEqual(tree.named(['node_modules'], 0).map((n) => n.path), [join(root, 'project/node_modules')], 'nested node_modules are part of the outer one')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('identical files are found by content; the oldest copy is the one to keep', async () => {
  const root = await fixture()
  try {
    const tree = await walk({ root })
    const groups = await tree.duplicates([])
    assert.equal(groups.length, 1)
    assert.deepEqual(groups[0].files.map((f) => f.name).sort(), ['copy of holiday.mp4', 'holiday.mp4'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('what went to the Trash leaves the tree and its folders\' totals', async () => {
  const root = await fixture()
  try {
    const tree = await walk({ root })
    const before = tree.size[0]
    const movie = tree.find(join(root, 'Movies/Trips/holiday.mp4'))
    const size = tree.size[movie]
    assert.equal(tree.remove(join(root, 'Movies/Trips')), true)
    assert.ok(tree.size[0] <= before - size)
    assert.equal(tree.find(join(root, 'Movies/Trips')), -1)
    assert.equal(tree.search('.mp4', 0, 10).length, 0)
    assert.equal(tree.remove(join(root, 'nope')), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a scan can be stopped', async () => {
  const root = await fixture()
  try {
    const ac = new AbortController()
    ac.abort()
    await assert.rejects(walk({ root, signal: ac.signal }), /cancelled/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

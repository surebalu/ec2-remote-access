import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, readdir, rm, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { transferSafely } from '../src/main/sftp/safeTransfer.ts'
import { localDestination, remoteDestination } from '../src/main/sftp/destinations.ts'
import type { SFTPWrapper } from 'ssh2'

async function directory(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'ec2ra-transfer-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}

test('replace publishes a complete file, retains permissions, and removes its temporary sibling', async (t) => {
  const dir = await directory(t)
  const path = join(dir, 'config.json')
  await writeFile(path, 'original', { mode: 0o600 })
  const result = await transferSafely(path, localDestination(async (temp) => {
    await writeFile(temp, 'complete', { flag: 'wx' })
    assert.equal(await readFile(path, 'utf8'), 'original')
  }), async () => 'replace', () => false, () => {})
  assert.equal(result, 'done')
  assert.equal(await readFile(path, 'utf8'), 'complete')
  assert.equal((await lstat(path)).mode & 0o777, 0o600)
  assert.deepEqual(await readdir(dir), ['config.json'])
})

test('keep both chooses an unused numbered name without modifying the original', async (t) => {
  const dir = await directory(t)
  const path = join(dir, 'report.txt')
  await writeFile(path, 'original')
  await writeFile(join(dir, 'report (1).txt'), 'previous copy')
  let selected = ''
  await transferSafely(path, localDestination((temp) => writeFile(temp, 'new', { flag: 'wx' })), async () => 'keep-both', () => false, (p) => { selected = p })
  assert.equal(selected, join(dir, 'report (2).txt'))
  assert.equal(await readFile(path, 'utf8'), 'original')
  assert.equal(await readFile(selected, 'utf8'), 'new')
  assert.equal((await readdir(dir)).length, 3)
})

test('skip does not start a stream', async (t) => {
  const dir = await directory(t)
  const path = join(dir, 'existing')
  await writeFile(path, 'original')
  const result = await transferSafely(path, localDestination(async () => { assert.fail('must not write') }), async () => 'skip', () => false, () => {})
  assert.equal(result, 'skipped')
  assert.equal(await readFile(path, 'utf8'), 'original')
})

test('stream failure cleans partial bytes and leaves the previous destination intact', async (t) => {
  const dir = await directory(t)
  const path = join(dir, 'existing')
  await writeFile(path, 'original')
  await assert.rejects(transferSafely(path, localDestination(async (temp) => {
    await writeFile(temp, 'partial')
    throw new Error('connection lost')
  }), async () => 'replace', () => false, () => {}), /connection lost/)
  assert.equal(await readFile(path, 'utf8'), 'original')
  assert.deepEqual(await readdir(dir), ['existing'])
})

test('cancellation after streaming prevents publication', async (t) => {
  const dir = await directory(t)
  const path = join(dir, 'existing')
  await writeFile(path, 'original')
  let cancelled = false
  await assert.rejects(transferSafely(path, localDestination(async (temp) => {
    await writeFile(temp, 'complete')
    cancelled = true
  }), async () => 'replace', () => cancelled, () => {}), /cancelled/)
  assert.equal(await readFile(path, 'utf8'), 'original')
  assert.deepEqual(await readdir(dir), ['existing'])
})

test('a destination appearing mid-transfer cannot be overwritten without approval', async (t) => {
  const dir = await directory(t)
  const path = join(dir, 'new-file')
  await assert.rejects(transferSafely(path, localDestination(async (temp) => {
    await writeFile(temp, 'transfer')
    await writeFile(path, 'concurrent writer')
  }), async () => { assert.fail('destination was absent at the initial check') }, () => false, () => {}), { code: 'EEXIST' })
  assert.equal(await readFile(path, 'utf8'), 'concurrent writer')
  assert.deepEqual(await readdir(dir), ['new-file'])
})

test('cancellation during a conflict prompt does not start writing', async (t) => {
  const dir = await directory(t)
  const path = join(dir, 'existing')
  await writeFile(path, 'original')
  let cancelled = false
  await assert.rejects(transferSafely(path, localDestination(async () => { assert.fail('must not write') }), async () => {
    cancelled = true
    return 'replace'
  }, () => cancelled, () => {}), /cancelled/)
  assert.equal(await readFile(path, 'utf8'), 'original')
})

test('SFTP permission errors are not mistaken for missing files', async () => {
  const error = Object.assign(new Error('Permission denied'), { code: 3 })
  const sftp = { lstat: (_p: string, cb: (err: Error) => void) => cb(error) } as unknown as SFTPWrapper
  await assert.rejects(remoteDestination(sftp, async () => {}).exists('/private'), /Permission denied/)
})

test('servers without atomic replace fail safely without unlinking the destination', async () => {
  const removed: string[] = []
  const sftp = {
    lstat: (_p: string, cb: (err: undefined, info: { mode: number }) => void) => cb(undefined, { mode: 0o100600 }),
    chmod: (_p: string, _mode: number, cb: () => void) => cb(),
    ext_openssh_rename: () => { throw new Error('unsupported extension') },
    unlink: (p: string, cb: () => void) => { removed.push(p); cb() }
  } as unknown as SFTPWrapper
  await assert.rejects(transferSafely('/remote/config', remoteDestination(sftp, async () => {}), async () => 'replace', () => false, () => {}), /Keep both/)
  assert.equal(removed.length, 1)
  assert.match(removed[0], /\.part$/)
  assert.notEqual(removed[0], '/remote/config')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { hmacSha256Hex, sha256Hex, sha256Sync } from '../src/shared/sha256.ts'

const node = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

test('known vectors', () => {
  assert.equal(sha256Sync(new Uint8Array()), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(sha256Sync(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(sha256Sync(new TextEncoder().encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
})

test('every length around the padding boundaries matches node:crypto', () => {
  const data = randomBytes(300)
  for (let n = 0; n <= 300; n++) assert.equal(sha256Sync(data.subarray(0, n)), node(data.subarray(0, n)), `length ${n}`)
})

test('a view into a larger buffer hashes only its own bytes', () => {
  const data = randomBytes(1000)
  const view = new Uint8Array(data.buffer, data.byteOffset + 17, 500)
  assert.equal(sha256Sync(view), node(view))
})

test('a real STEP file: the JavaScript digest and crypto.subtle agree with node:crypto', async () => {
  const step = new Uint8Array(readFileSync('node_modules/occt-import-js/test/testfiles/cax-if/as1_pe_203.stp'))
  assert.equal(sha256Sync(step), node(step))
  assert.equal(await sha256Hex(step), node(step))
})

test('HMAC-SHA-256 matches node:crypto for short, block-sized and long keys and messages', () => {
  // RFC 4231 test case 2.
  assert.equal(hmacSha256Hex('Jefe', 'what do ya want for nothing?'), '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843')
  for (const key of ['', 'k', 'x'.repeat(64), 'y'.repeat(65), randomBytes(40).toString('hex'), 'héllo ключ']) {
    for (const msg of ['', 'links-file:abc123', 'z'.repeat(200), 'ünïcode ✓']) {
      assert.equal(hmacSha256Hex(key, msg), createHmac('sha256', key).update(msg).digest('hex'), `key ${key.length}, message ${msg.length}`)
    }
  }
})

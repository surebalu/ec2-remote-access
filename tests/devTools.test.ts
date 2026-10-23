import { test } from 'node:test'
import assert from 'node:assert/strict'
import { convertTimestamp, decodeBase64, encodeBase64, inspectJwt, MAX_TOOL_INPUT, transformText } from '../src/shared/devTools.ts'

test('JSON formatting preserves structures and reports malformed input', async () => {
  const input = '{"ok":true,"items":[1,null,"é"],"nested":{"a":2}}'
  const pretty = await transformText('json', input)
  assert.ok(pretty.includes('\n  "ok": true'))
  assert.deepEqual(JSON.parse(pretty), JSON.parse(input))
  assert.equal(await transformText('json', pretty, 'minify'), input)
  assert.equal(await transformText('json', 'null'), 'null')
  await assert.rejects(transformText('json', '{"ok":}'), SyntaxError)
})

test('Base64 round-trips Unicode and rejects invalid alphabet and binary non-UTF8', () => {
  for (const input of ['', 'hello world', '工程师 👩🏽‍💻\nCafé\u0000']) assert.equal(decodeBase64(encodeBase64(input)), input)
  assert.equal(encodeBase64('hello world'), 'aGVsbG8gd29ybGQ=')
  assert.throws(() => decodeBase64('%%%'), /valid Base64/)
  assert.throws(() => decodeBase64('/w=='), /UTF-8/)
  assert.throws(() => decodeBase64('a'), /valid Base64/)
})

test('JSON whitespace transforms preserve large IDs, duplicate keys, escapes and numeric notation', async () => {
  const input = '{"id":9007199254740993,"n":1.20e+40,"n":-0,"s":"spaces  and \\"quotes\\"","empty":[{},[]]}'
  const pretty = await transformText('json', input)
  assert.equal(await transformText('json', pretty, 'minify'), input)
  assert.ok(pretty.includes('9007199254740993'))
  await assert.rejects(transformText('json', '['.repeat(129) + ']'.repeat(129)), /nesting/)
})

test('URL component encoding preserves literal plus and Unicode', async () => {
  const input = 'a+b & c=東京/🧪'
  assert.equal(await transformText('url', await transformText('url', input), 'decode'), input)
  assert.equal(await transformText('url', 'a+b', 'decode'), 'a+b')
  await assert.rejects(transformText('url', '%FF', 'decode'), /valid URL/)
})

test('JWT inspection labels claims unverified and decodes base64url with UTC dates', () => {
  const enc = (obj: unknown) => encodeBase64(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  const payload = { sub: '例', iat: 0, exp: 1700000000 }
  const result = JSON.parse(inspectJwt(`${enc({ alg: 'none' })}.${enc(payload)}.`))
  assert.match(result.verification, /Not verified/)
  assert.deepEqual(result.payload, payload)
  assert.equal(result.datesUTC.iat, '1970-01-01T00:00:00.000Z')
  assert.equal(result.datesUTC.exp, '2023-11-14T22:13:20.000Z')
  assert.throws(() => inspectJwt('one.two'), /three/)
  assert.throws(() => inspectJwt(`${enc([])}.${enc(null)}.`), /objects/)
})

test('timestamps use explicit units, timezone offsets and valid calendar dates', () => {
  assert.match(convertTimestamp('0', 'seconds'), /1970-01-01T00:00:00.000Z/)
  assert.match(convertTimestamp('-1', 'seconds'), /1969-12-31T23:59:59.000Z/)
  assert.match(convertTimestamp('1700000000000', 'milliseconds'), /2023-11-14T22:13:20.000Z/)
  assert.match(convertTimestamp('2026-10-22T10:30:00-04:00', 'seconds'), /2026-10-22T14:30:00.000Z/)
  assert.match(convertTimestamp('2024-02-29T23:59:59Z', 'seconds'), /2024-02-29/)
  for (const invalid of ['', '2026-10-22', '2026-10-22T10:30:00', '2026-02-30T00:00:00Z', '2026-10-22T24:00:00Z', '999999999999999999']) assert.throws(() => convertTimestamp(invalid, 'seconds'), undefined, invalid)
})

test('UUID generation bounds counts and sets RFC version and variant bits', async () => {
  const uuids = (await transformText('uuid', '100')).split('\n')
  assert.equal(uuids.length, 100)
  assert.equal(new Set(uuids).size, 100)
  for (const uuid of uuids) assert.match(uuid, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/)
  for (const count of ['0', '-1', '101', '2.5', 'NaN']) await assert.rejects(transformText('uuid', count), /1 to 100/)
})

test('SHA-256 matches standard vectors including empty input', async () => {
  assert.equal(await transformText('hash', ''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(await transformText('hash', 'abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

test('oversized payloads are rejected before parsing or encoding', async () => {
  await assert.rejects(transformText('base64', 'x'.repeat(MAX_TOOL_INPUT + 1)), /200,000/)
})

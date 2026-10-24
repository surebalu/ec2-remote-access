import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authorizeUrl, BOX_LOOPBACK, boxError, linkFileKey, needsRefresh, parseBoxApp, partRanges, redirectFor, syncDoc, tokensFrom, type RemoteDoc } from '../src/shared/box.ts'
import { mergeDocs, type RecordDoc } from '../src/shared/records.ts'

const app = { clientId: 'a'.repeat(32), clientSecret: 'b'.repeat(32) }

test('the Box app file, plain JSON only', () => {
  assert.deepEqual(parseBoxApp(JSON.stringify({ clientId: ` ${app.clientId} `, clientSecret: app.clientSecret })), app)
  assert.throws(() => parseBoxApp('{\\rtf1\\ansi { "clientId": "x" }'), /not JSON/, 'a TextEdit rich-text file says so')
  assert.throws(() => parseBoxApp(JSON.stringify({ clientId: 'short', clientSecret: app.clientSecret })), /clientId and clientSecret/)
  assert.equal(parseBoxApp(JSON.stringify({ ...app, loopback: 'http://localhost:53682/box/callback' })).loopback, 'http://localhost:53682/box/callback')
  assert.throws(() => parseBoxApp(JSON.stringify({ ...app, loopback: 'http://evil.example/box/callback' })), /loopback must be/)
  assert.equal(redirectFor(undefined, true, 'http://localhost:53682/box/callback'), 'http://localhost:53682/box/callback')
})

test('sign-in: where Box sends the browser back, and the address that asks', () => {
  assert.equal(redirectFor(undefined, true), BOX_LOOPBACK)
  assert.equal(redirectFor('https://raspberrypi.taila52c1d.ts.net', false), 'https://raspberrypi.taila52c1d.ts.net/box/callback')
  assert.equal(redirectFor('http://127.0.0.1:8321/', false), 'http://127.0.0.1:8321/box/callback')
  assert.throws(() => redirectFor('http://192.168.0.121:8321', false), /https/, 'plain http on the network is refused')
  assert.throws(() => redirectFor('https://evil.example/x', false), /https/)
  const u = new URL(authorizeUrl(app, BOX_LOOPBACK, 'state-1'))
  assert.equal(u.origin + u.pathname, 'https://account.box.com/api/oauth2/authorize')
  assert.deepEqual(Object.fromEntries(u.searchParams), { response_type: 'code', client_id: app.clientId, redirect_uri: BOX_LOOPBACK, state: 'state-1' })
})

test('tokens: lifetimes, refreshing early, and Box errors in words', () => {
  const t = tokensFrom({ access_token: 'A', refresh_token: 'R', expires_in: 3600 }, 1_000_000)
  assert.equal(t.expiresAt, 1_000_000 + 3_600_000)
  assert.equal(needsRefresh(t, t.expiresAt - 10 * 60_000), false)
  assert.equal(needsRefresh(t, t.expiresAt - 60_000), true)
  assert.throws(() => tokensFrom({ error: 'invalid_grant', error_description: 'Auth code expired' }), /Auth code expired/)
  assert.match(boxError(401, {}), /Sign in to Box again/)
  assert.match(boxError(403, { message: 'Access denied' }), /Read and write all files/)
  assert.match(boxError(503, {}), /next sync/)
})

test('Links files keep their folders in Box', () => {
  assert.deepEqual(linkFileKey('/Users/me/Links Files/Docs/a b.pdf', '/Users/me/Links Files/'), ['Docs', 'a b.pdf'])
  assert.deepEqual(linkFileKey('/elsewhere/x.png', '/Users/me/Links Files'), ['Other', 'x.png'])
})

// ----- the shared document, against a pretend Box that checks versions as Box does (If-Match) -----

const item = (id: string, updatedAt: number, title = id) => ({ id, type: 'task', title, updatedAt })
const doc = (rev: number, ...items: ReturnType<typeof item>[]): RecordDoc => ({ rev, items: Object.fromEntries(items.map((i) => [i.id, i])) }) as unknown as RecordDoc

function fakeBox(initial: RecordDoc | null): RemoteDoc & { text: string | null; writes: number; meddle?: () => void; otherWrites: (d: RecordDoc) => void } {
  let version = 0
  const box = {
    text: initial ? JSON.stringify(initial) : null as string | null,
    writes: 0,
    meddle: undefined as undefined | (() => void),
    /** Another computer saves: a new version, so a write naming the old one is refused. */
    otherWrites(d: RecordDoc) { box.text = JSON.stringify(d); version++ },
    async read() { return box.text === null ? null : { text: box.text, etag: String(version) } },
    async write(text: string, etag: string | null) {
      box.meddle?.()
      box.meddle = undefined
      if ((etag === null) !== (box.text === null) || (etag !== null && etag !== String(version))) return 'conflict' as const
      box.text = text
      version++
      box.writes++
      return 'ok' as const
    }
  }
  return box
}

function local(start: RecordDoc) {
  let mine = start
  return { mine: () => mine, adopt: async (theirs: RecordDoc) => { mine = mergeDocs(mine, theirs).doc } }
}

test('the first computer creates the file; the next one takes it and adds its own', async () => {
  const box = fakeBox(null)
  const a = local(doc(1, item('t1', 10)))
  assert.equal(await syncDoc(box, a.mine, a.adopt), 'created')
  const b = local(doc(1, item('t2', 20)))
  assert.equal(await syncDoc(box, b.mine, b.adopt), 'pushed')
  assert.deepEqual(Object.keys(b.mine().items).sort(), ['t1', 't2'])
  assert.equal(await syncDoc(box, a.mine, a.adopt), 'pulled')
  assert.deepEqual(Object.keys(a.mine().items).sort(), ['t1', 't2'])
  assert.equal(await syncDoc(box, a.mine, a.adopt), 'pulled', 'nothing new: nothing written')
  assert.equal(box.writes, 2)
})

test('a write that meets another computer\'s newer one reads again and keeps both', async () => {
  const box = fakeBox(doc(1, item('t1', 10)))
  const a = local(doc(1, item('t1', 10), item('mine', 30)))
  // Between this computer's read and its write, another one saves an edit of t1.
  box.meddle = () => box.otherWrites(doc(2, item('t1', 40, 'edited elsewhere')))
  const result = await syncDoc(box, a.mine, a.adopt)
  assert.equal(result, 'pushed')
  assert.equal(box.writes, 1, 'the refused write was not counted; the second one went through')
  const final = JSON.parse(box.text!) as RecordDoc
  assert.equal((final.items.t1 as unknown as { title: string }).title, 'edited elsewhere', 'the other computer\'s edit survives')
  assert.ok(final.items.mine, 'and this computer\'s new item too')
})

test('a records file Box cannot parse is left alone', async () => {
  const box = fakeBox(null)
  box.text = 'not json'
  const a = local(doc(1, item('t1', 10)))
  await assert.rejects(syncDoc(box, a.mine, a.adopt), /could not be read/)
  assert.equal(box.text, 'not json')
})

test('a large file goes up in Box\'s part size, the last part shorter', () => {
  assert.deepEqual(partRanges(20, 8), [[0, 7], [8, 15], [16, 19]])
  assert.deepEqual(partRanges(16, 8), [[0, 7], [8, 15]])
  assert.deepEqual(partRanges(0, 8), [])
  const big = partRanges(94_371_840, 8_388_608)
  assert.equal(big.length, 12)
  assert.equal(big.at(-1)![1], 94_371_839)
  assert.ok(big.every(([a, b], i) => i === 0 || a === big[i - 1][1] + 1), 'no gaps, no overlaps')
})

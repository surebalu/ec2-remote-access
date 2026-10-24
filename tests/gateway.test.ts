import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'
import { createGatewayServer, type GatewayHandlers } from '../src/gateway/server.ts'
import { createGatewayHost } from '../src/gateway/host.ts'

type Msg = { t: string; id?: number; result?: unknown; message?: string; channel?: string; payload?: unknown }

async function start(overrides: Partial<Record<string, (...a: unknown[]) => Promise<unknown>>> = {}, staticDir?: string, resumeGraceMs?: number, allowTerminals?: () => boolean) {
  const closed: string[] = []
  const handlers = {
    'settings:get': async () => ({ theme: 'dark' }),
    'ssh:open': async (req: { sessionId: string }) => ({ sessionId: req.sessionId, route: 'ssm' }),
    'ssh:close': async (id: string) => { closed.push(`ssh:${id}`) },
    'sftp:open': async () => ({ sessionId: 'sftp-1' }),
    'sftp:close': async (id: string) => { closed.push(`sftp:${id}`) },
    'rdp:prepare': async (req: { sessionId: string }) => ({ sessionId: req.sessionId, proxyUrl: 'ws://127.0.0.1:5555/rdp', token: 'x' }),
    'rdp:release': async (id: string) => { closed.push(`rdp:${id}`) },
    'vnc:prepare': async (req: { sessionId: string }) => ({ sessionId: req.sessionId, url: 'ws://127.0.0.1:5555/vnc/abcdefghijklmnopqrstuvwxyz012345', destination: '100.64.0.1:5900', route: 'direct', title: 'mac' }),
    'vnc:release': async (id: string) => { closed.push(`vnc:${id}`) },
    'ec2:start': async () => { throw new Error('boom') },
    ...overrides
  } as unknown as GatewayHandlers
  const gw = createGatewayServer({ handlers, token: 'secret', staticDir, rdpTarget: async () => null, log: () => undefined, resumeGraceMs, allowTerminals })
  const { port } = await gw.listen(0, '127.0.0.1')
  return { gw, port, closed }
}

function client(port: number, token: string, clientId?: string): Promise<{ ws: WebSocket; next: () => Promise<Msg>; call: (channel: string, ...args: unknown[]) => Promise<Msg> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}${clientId ? `&client=${clientId}` : ''}`)
  const inbox: Msg[] = []
  const waiters: ((m: Msg) => void)[] = []
  ws.on('message', (d) => { const m = JSON.parse(d.toString()) as Msg; const w = waiters.shift(); if (w) w(m); else inbox.push(m) })
  const next = (): Promise<Msg> => (inbox.length ? Promise.resolve(inbox.shift()!) : new Promise((r) => waiters.push(r)))
  let id = 0
  const call = async (channel: string, ...args: unknown[]): Promise<Msg> => { ws.send(JSON.stringify({ t: 'call', id: ++id, channel, args })); return next() }
  return once(ws, 'open').then(() => ({ ws, next, call }))
}

test('rejects the upgrade without the right token', async () => {
  const { gw, port } = await start()
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=wrong`)
  const [err] = await once(ws, 'error') as [Error]
  assert.match(err.message, /401/)
  await gw.close()
})

test('dispatches calls, returns results and errors, relays broadcasts', async () => {
  const { gw, port } = await start()
  const c = await client(port, 'secret')
  assert.equal((await c.next()).t, 'hello')
  const ok = await c.call('settings:get')
  assert.deepEqual(ok, { t: 'result', id: 1, result: { theme: 'dark' } })
  const bad = await c.call('ec2:start', 'k')
  assert.deepEqual(bad, { t: 'error', id: 2, message: 'boom' })
  const unknown = await c.call('nope:nope')
  assert.equal(unknown.t, 'error')
  gw.broadcast('tunnels:changed', [{ id: 't1' }])
  assert.deepEqual(await c.next(), { t: 'event', channel: 'tunnels:changed', payload: [{ id: 't1' }] })
  c.ws.close()
  await gw.close()
})

test('refuses browser upgrades from a foreign origin, accepts same-origin and origin-less clients', async () => {
  const { gw, port } = await start()
  const bad = new WebSocket(`ws://127.0.0.1:${port}/ws?token=secret`, { headers: { origin: 'https://evil.example' } })
  const [err] = await once(bad, 'error') as [Error]
  assert.match(err.message, /403/)
  const good = new WebSocket(`ws://127.0.0.1:${port}/ws?token=secret`, { headers: { origin: `http://127.0.0.1:${port}` } })
  await once(good, 'open')
  good.close()
  await gw.close()
})

test('reports connected clients with addresses and honours forwarded headers', async () => {
  const seen: { address: string; since: number }[][] = []
  const handlers = { 'settings:get': async () => ({}) } as unknown as GatewayHandlers
  const gw = createGatewayServer({ handlers, token: 'secret', log: () => undefined, onClientsChanged: (c) => seen.push(c) })
  const { port } = await gw.listen(0, '127.0.0.1')
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=secret`, { headers: { 'x-forwarded-for': '100.64.0.9', 'x-forwarded-host': 'mac.tail1234.ts.net', 'x-forwarded-proto': 'https', origin: 'https://mac.tail1234.ts.net' } })
  await once(ws, 'open')
  assert.equal(seen.at(-1)?.[0].address, '100.64.0.9')
  ws.close()
  await once(ws, 'close')
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(seen.at(-1), [])
  await gw.close()
})

test('rewrites the RDP proxy URL to the gateway origin', async () => {
  const { gw, port } = await start()
  const c = await client(port, 'secret')
  await c.next()
  const r = await c.call('rdp:prepare', { sessionId: 'rdp-1' })
  assert.equal((r.result as { proxyUrl: string }).proxyUrl, `ws://127.0.0.1:${port}/rdp?token=secret`)
  c.ws.close()
  // Behind `tailscale serve` the forwarded headers describe the public HTTPS origin.
  const fwd = new WebSocket(`ws://127.0.0.1:${port}/ws?token=secret`, { headers: { 'x-forwarded-host': 'mac.tail1234.ts.net', 'x-forwarded-proto': 'https' } })
  await once(fwd, 'open')
  const got = new Promise<Msg>((res) => fwd.on('message', (d) => { const m = JSON.parse(d.toString()) as Msg; if (m.t === 'result') res(m) }))
  fwd.send(JSON.stringify({ t: 'call', id: 1, channel: 'rdp:prepare', args: [{ sessionId: 'rdp-2' }] }))
  assert.equal(((await got).result as { proxyUrl: string }).proxyUrl, 'wss://mac.tail1234.ts.net/rdp?token=secret')
  fwd.close()
  await gw.close()
})

test('screen sharing: the session URL points at the gateway, and its socket reaches that session on the local proxy', async () => {
  // Stands in for the local proxy (rdp/cleanpath.ts), which relays /vnc/<session> to the host's RFB port.
  const proxy = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(proxy, 'listening')
  const proxyPort = (proxy.address() as { port: number }).port
  const paths: string[] = []
  proxy.on('connection', (ws, req) => {
    paths.push(req.url ?? '')
    ws.send(Buffer.from('RFB 003.889\n'))
    ws.on('message', (d) => ws.send(Buffer.concat([Buffer.from('echo:'), d as Buffer])))
  })
  const closed: string[] = []
  const handlers = {
    'vnc:prepare': async (req: { sessionId: string }) => ({ sessionId: req.sessionId, url: `ws://127.0.0.1:${proxyPort}/vnc/abcdefghijklmnopqrstuvwxyz012345`, destination: '100.64.0.1:5900', route: 'direct', title: 'mac' }),
    'vnc:release': async (id: string) => { closed.push(id) }
  } as unknown as GatewayHandlers
  const gw = createGatewayServer({ handlers, token: 'secret', rdpTarget: async () => `ws://127.0.0.1:${proxyPort}/rdp`, log: () => undefined })
  const { port } = await gw.listen(0, '127.0.0.1')
  const c = await client(port, 'secret')
  await c.next()
  const r = await c.call('vnc:prepare', { sessionId: 'vnc-1', instanceKey: 'tailnet/n1' })
  const url = (r.result as { url: string }).url
  assert.equal(url, `ws://127.0.0.1:${port}/vnc?token=secret&s=abcdefghijklmnopqrstuvwxyz012345`)

  const screen = new WebSocket(url)
  const got: string[] = []
  screen.on('message', (d) => got.push(d.toString()))
  await once(screen, 'open')
  screen.send(Buffer.from('RFB 003.008\n'))
  for (let i = 0; i < 50 && got.length < 2; i++) await new Promise((res) => setTimeout(res, 10))
  assert.deepEqual(got, ['RFB 003.889\n', 'echo:RFB 003.008\n'], 'bytes pass both ways unchanged')
  assert.deepEqual(paths, ['/vnc/abcdefghijklmnopqrstuvwxyz012345'])
  screen.close()

  // Without the gateway token, or with a malformed session, there is no relay.
  const refused = new WebSocket(`ws://127.0.0.1:${port}/vnc?token=nope&s=abcdefghijklmnopqrstuvwxyz012345`)
  await once(refused, 'error')
  const malformed = new WebSocket(`ws://127.0.0.1:${port}/vnc?token=secret&s=../rdp`)
  await once(malformed, 'error')
  assert.equal(paths.length, 1)

  c.ws.close()
  await once(c.ws, 'close')
  await new Promise((res) => setTimeout(res, 20))
  assert.deepEqual(closed, ['vnc-1'], 'the page going away ends its screen sharing session')
  await gw.close()
  proxy.close()
})

test('closes sessions a socket opened when it disconnects, but not ones it closed itself', async () => {
  const { gw, port, closed } = await start()
  const c = await client(port, 'secret')
  await c.next()
  await c.call('ssh:open', { sessionId: 'ssh-a' })
  await c.call('ssh:open', { sessionId: 'ssh-b' })
  await c.call('sftp:open', { instanceKey: 'k' })
  await c.call('rdp:prepare', { sessionId: 'rdp-1' })
  await c.call('vnc:prepare', { sessionId: 'vnc-1', instanceKey: 'tailnet/n1' })
  await c.call('ssh:close', 'ssh-b')
  c.ws.close()
  await once(c.ws, 'close')
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(closed.sort(), ['rdp:rdp-1', 'sftp:sftp-1', 'ssh:ssh-a', 'ssh:ssh-b', 'vnc:vnc-1'])
  await gw.close()
})

test('serves the UI with a browser-friendly CSP and falls back to the app shell', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ec2ra-static-'))
  await writeFile(join(dir, 'index.html'), `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' ws://127.0.0.1:*"><div id=root></div>`)
  const { gw, port } = await start({}, dir)
  const index = await fetch(`http://127.0.0.1:${port}/`)
  assert.match(await index.text(), /connect-src 'self' ws: wss: data: blob:/)
  const deep = await fetch(`http://127.0.0.1:${port}/some/route`)
  assert.equal(deep.status, 200)
  const escape = await fetch(`http://127.0.0.1:${port}/..%2f..%2fetc/passwd`)
  assert.equal(escape.status, 200, 'traversal attempts get the app shell, never a file outside staticDir')
  assert.match(await escape.text(), /id=root/)
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json() as { ok: boolean }
  assert.equal(health.ok, true)
  assert.equal((await fetch(`http://127.0.0.1:${port}/auth?token=secret`)).status, 204)
  assert.equal((await fetch(`http://127.0.0.1:${port}/auth?token=nope`)).status, 401)
  await gw.close()
  await rm(dir, { recursive: true, force: true })
})

test('a page can tell it is older than the gateway: the hello names the build, and an old build’s files are not found', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ec2ra-build-'))
  await mkdir(join(dir, 'assets'))
  await writeFile(join(dir, 'assets', 'index-NEW123.js'), 'console.log(1)')
  await writeFile(join(dir, 'index.html'), `<script type="module" crossorigin src="./assets/index-NEW123.js"></script><div id=root></div>`)
  const { gw, port } = await start({}, dir)
  const c = await client(port, 'secret')
  const hello = await c.next()
  assert.deepEqual(hello, { t: 'hello', protocol: 1, build: 'index-NEW123.js' })
  c.ws.close()
  const current = await fetch(`http://127.0.0.1:${port}/assets/index-NEW123.js`)
  assert.equal(current.status, 200)
  assert.match(current.headers.get('content-type') ?? '', /javascript/)
  const old = await fetch(`http://127.0.0.1:${port}/assets/VncTab-OLD456.js`)
  assert.equal(old.status, 404, 'a file of an older build is not answered with the app page')
  assert.match(await old.text(), /older version/)
  assert.equal((await fetch(`http://127.0.0.1:${port}/assets/../index.html`)).status, 200, 'paths are normalised before the check')
  assert.equal((await fetch(`http://127.0.0.1:${port}/some/route`)).status, 200, 'other unknown paths still get the app')
  // A new build replaces index.html: the next hello names it.
  await new Promise((r) => setTimeout(r, 20))
  await writeFile(join(dir, 'index.html'), `<script type="module" crossorigin src="./assets/index-NEWER789.js"></script>`)
  const c2 = await client(port, 'secret')
  assert.equal(((await c2.next()) as { build?: string }).build, 'index-NEWER789.js')
  c2.ws.close()
  await gw.close()
  await rm(dir, { recursive: true, force: true })
})

test('gateway host seals and opens credentials with its key file, rejecting foreign blobs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ec2ra-host-'))
  const host = createGatewayHost(dir, () => undefined, () => undefined)
  const sealed = host.encrypt('{"user":"Administrator","password":"p@ss"}')!
  assert.equal(host.decrypt(sealed), '{"user":"Administrator","password":"p@ss"}')
  assert.throws(() => host.decrypt(Buffer.from('v10not-electron-safeStorage')), /Not a gateway-encrypted/)
  assert.equal(await host.pickPaths({ title: 't', kind: 'file' }), null)
  assert.equal(await host.askQuestion({ title: 't', message: 'm', buttons: ['Keep both', 'Replace'], defaultId: 0 }), 0)
  assert.equal(host.voice, null, 'no microphone or speech recognizer on the gateway')
  await rm(dir, { recursive: true, force: true })
})

test('a paired page can neither dictate with the computer’s microphone nor receive its transcripts', async () => {
  let started = false
  const { gw, port } = await start({ 'voice:start': async () => { started = true; return { id: 'v1' } }, 'voice:status': async () => ({ available: true }) })
  const c = await client(port, 'secret')
  assert.equal((await c.next()).t, 'hello')
  for (const channel of ['voice:status', 'voice:start', 'voice:stop', 'voice:cancel', 'voice:openPrivacy']) {
    const r = await c.call(channel, 'v1')
    assert.equal(r.t, 'error', channel)
    assert.match(r.message ?? '', /Dictation runs in the Mac app; on iPhone or iPad use the keyboard’s microphone key/)
  }
  assert.equal(started, false)
  gw.broadcast('voice:event', { id: 'v1', kind: 'final', text: 'words said at the Mac' })
  gw.broadcast('voice:key', { key: 'dictation', down: true })
  gw.broadcast('tunnels:changed', [])
  assert.equal((await c.next()).channel, 'tunnels:changed', 'only the public event arrives')
  c.ws.close()
  await gw.close()
})

test('a page that reconnects within the grace period keeps its sessions', async () => {
  const { gw, port, closed } = await start({}, undefined, 200)
  const a = await client(port, 'secret', 'page-1')
  await a.next()
  await a.call('ssh:open', { sessionId: 'ssh-a' })
  a.ws.close()
  await once(a.ws, 'close')
  await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual(closed, [], 'nothing closes while the page may still come back')
  const b = await client(port, 'secret', 'page-1')
  await b.next()
  await new Promise((r) => setTimeout(r, 300))
  assert.deepEqual(closed, [], 'the resumed page owns the session again')
  b.ws.close()
  await once(b.ws, 'close')
  await new Promise((r) => setTimeout(r, 300))
  assert.deepEqual(closed, ['ssh:ssh-a'], 'closed once the grace period runs out')
  await gw.close()
})

test('another page cannot claim sessions, and shutdown closes parked ones', async () => {
  const { gw, port, closed } = await start({}, undefined, 60_000)
  const a = await client(port, 'secret', 'page-1')
  await a.next()
  await a.call('ssh:open', { sessionId: 'ssh-a' })
  a.ws.close()
  await once(a.ws, 'close')
  const other = await client(port, 'secret', 'page-2')
  await other.next()
  other.ws.close()
  await once(other.ws, 'close')
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(closed, [])
  await gw.close()
  assert.deepEqual(closed, ['ssh:ssh-a'])
})

test('a paired page can neither open a shell on this computer nor see one, nor fill or open downloads', async () => {
  let opened = false
  const { gw, port } = await start({ 'term:open': async () => { opened = true; return {} }, 'browser:fill': async () => ['password'] })
  const c = await client(port, 'secret')
  assert.equal((await c.next()).t, 'hello')
  for (const channel of ['term:open', 'term:write', 'term:git', 'browser:fill', 'browser:logins', 'browser:openDownload']) {
    const r = await c.call(channel, { id: 'x', cols: 80, rows: 24 })
    assert.equal(r.t, 'error', channel)
    assert.match(r.message ?? '', /only available in the Mac app|Terminals from paired devices are off/)
  }
  assert.equal(opened, false)
  gw.broadcast('term:event', { id: 'x', type: 'data', data: 'secret output' })
  gw.broadcast('web:download', { name: 'a.pdf' })
  gw.broadcast('tunnels:changed', [])
  const m = await c.next()
  assert.equal(m.channel, 'tunnels:changed', 'only the public event arrives')
  c.ws.close()
  await gw.close()
})

test('with terminals allowed, a page gets its own shells and only their output; it cannot change the permission', async () => {
  let allowed = true
  const closed: string[] = []
  const saved: unknown[] = []
  const settings: unknown[] = []
  const { gw, port } = await start({
    'term:open': async (req: { id: string }) => ({ shell: '/bin/zsh', integration: true, cwd: '/home/pi', id: req.id }),
    'term:close': async (id: string) => { closed.push(id) },
    'term:saveState': async (st: unknown) => { saved.push(st) },
    'term:loadState': async () => ({ tabs: ['the computer\'s own layout'] }),
    'settings:set': async (patch: unknown) => { settings.push(patch); return patch }
  }, undefined, undefined, () => allowed)
  const a = await client(port, 'secret')
  const b = await client(port, 'secret')
  assert.equal((await a.next()).t, 'hello')
  assert.equal((await b.next()).t, 'hello')
  assert.deepEqual(await a.call('term:available'), { t: 'result', id: 1, result: true })
  assert.equal((await a.call('term:open', { id: 'pa', cols: 80, rows: 24 })).t, 'result')
  // The computer's saved layout is neither read nor replaced by a paired page.
  assert.deepEqual((await a.call('term:loadState')).result, null)
  await a.call('term:saveState', { tabs: [] })
  assert.deepEqual(saved, [])
  // A page cannot widen its own access, directly or through settings.
  assert.equal((await a.call('phone:terminals', true)).t, 'error')
  await a.call('settings:set', { phoneTerminals: true, theme: 'dark' })
  assert.deepEqual(settings, [{ theme: 'dark' }])
  // Output of a shell goes only to the page that opened it; the computer's own shells reach nobody.
  gw.broadcast('term:event', { id: 'desk', type: 'data', data: 'mac only' })
  gw.broadcast('term:event', { id: 'pa', type: 'data', data: 'for a' })
  gw.broadcast('tunnels:changed', [])
  const aFirst = await a.next()
  assert.equal(aFirst.channel, 'term:event')
  assert.deepEqual(aFirst.payload, { id: 'pa', type: 'data', data: 'for a' }, 'its own shell, not the computer\'s')
  assert.equal((await a.next()).channel, 'tunnels:changed')
  const bFirst = await b.next()
  assert.equal(bFirst.channel, 'tunnels:changed', 'the other page sees neither shell')
  // Turning terminals off closes the shells pages opened and refuses new ones.
  allowed = false
  gw.closeTerminals()
  assert.deepEqual(closed, ['pa'])
  assert.equal((await b.call('term:open', { id: 'pb', cols: 80, rows: 24 })).t, 'error')
  assert.deepEqual((await b.call('term:available')).result, false)
  a.ws.close()
  b.ws.close()
  await gw.close()
})

test('serves a Links file to a page by a signature of that one file, with byte ranges; never active content inline', async () => {
  const { hmacSha256Hex } = await import('../src/shared/sha256.ts')
  const dir = await mkdtemp(join(tmpdir(), 'ec2ra-linkfile-'))
  await writeFile(join(dir, 'spec.pdf'), '%PDF-1.4 the bytes of a pdf')
  await writeFile(join(dir, 'page.html'), '<script>alert(1)</script>')
  const files: Record<string, { path: string; name: string }> = { pdf1: { path: join(dir, 'spec.pdf'), name: 'spec ü.pdf' }, html1: { path: join(dir, 'page.html'), name: 'page.html' } }
  const gw = createGatewayServer({ handlers: {} as GatewayHandlers, token: 'secret', staticDir: dir, log: () => undefined, linkFile: async (id) => files[id] ?? null })
  const { port } = await gw.listen(0, '127.0.0.1')
  try {
    // The page signs with the JavaScript HMAC (renderer/wsApi.ts); the server checks with node:crypto's.
    const url = (id: string, sig = hmacSha256Hex('secret', `links-file:${id}`)): string => `http://127.0.0.1:${port}/links/file/${id}?sig=${sig}`
    const ok = await fetch(url('pdf1'))
    assert.equal(ok.status, 200)
    assert.equal(ok.headers.get('content-type'), 'application/pdf')
    assert.equal(ok.headers.get('content-disposition'), `inline; filename*=UTF-8''${encodeURIComponent('spec ü.pdf')}`)
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(await ok.text(), '%PDF-1.4 the bytes of a pdf')
    const part = await fetch(url('pdf1'), { headers: { range: 'bytes=0-3' } })
    assert.equal(part.status, 206)
    assert.equal(part.headers.get('content-range'), 'bytes 0-3/27')
    assert.equal(await part.text(), '%PDF')
    const tail = await fetch(url('pdf1'), { headers: { range: 'bytes=-3' } })
    assert.equal(await tail.text(), 'pdf')
    assert.equal((await fetch(url('pdf1'), { headers: { range: 'bytes=90-' } })).status, 416)
    // A signature for another file, for another token, or none at all, is refused; so is the token itself.
    assert.equal((await fetch(url('pdf1', hmacSha256Hex('secret', 'links-file:html1')))).status, 403)
    assert.equal((await fetch(url('pdf1', hmacSha256Hex('other', 'links-file:pdf1')))).status, 403)
    assert.equal((await fetch(`http://127.0.0.1:${port}/links/file/pdf1`)).status, 403)
    assert.equal((await fetch(`http://127.0.0.1:${port}/links/file/pdf1?token=secret`)).status, 403)
    assert.equal((await fetch(url('missing'))).status, 404)
    const html = await fetch(url('html1'))
    assert.equal(html.headers.get('content-type'), 'application/octet-stream')
    assert.match(html.headers.get('content-disposition') ?? '', /^attachment;/, 'HTML downloads instead of running on the gateway origin')
  } finally {
    await gw.close()
    await rm(dir, { recursive: true, force: true })
  }
})

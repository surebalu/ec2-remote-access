import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { createGatewayServer, type GatewayHandlers } from '../src/gateway/server.ts'
import { createGatewayHost } from '../src/gateway/host.ts'

type Msg = { t: string; id?: number; result?: unknown; message?: string; channel?: string; payload?: unknown }

async function start(overrides: Partial<Record<string, (...a: unknown[]) => Promise<unknown>>> = {}, staticDir?: string) {
  const closed: string[] = []
  const handlers = {
    'settings:get': async () => ({ theme: 'dark' }),
    'ssh:open': async (req: { sessionId: string }) => ({ sessionId: req.sessionId, route: 'ssm' }),
    'ssh:close': async (id: string) => { closed.push(`ssh:${id}`) },
    'sftp:open': async () => ({ sessionId: 'sftp-1' }),
    'sftp:close': async (id: string) => { closed.push(`sftp:${id}`) },
    'rdp:prepare': async (req: { sessionId: string }) => ({ sessionId: req.sessionId, proxyUrl: 'ws://127.0.0.1:5555/rdp', token: 'x' }),
    'rdp:release': async (id: string) => { closed.push(`rdp:${id}`) },
    'ec2:start': async () => { throw new Error('boom') },
    ...overrides
  } as unknown as GatewayHandlers
  const gw = createGatewayServer({ handlers, token: 'secret', staticDir, rdpTarget: async () => null, log: () => undefined })
  const { port } = await gw.listen(0, '127.0.0.1')
  return { gw, port, closed }
}

function client(port: number, token: string): Promise<{ ws: WebSocket; next: () => Promise<Msg>; call: (channel: string, ...args: unknown[]) => Promise<Msg> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`)
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

test('rewrites the RDP proxy URL to the gateway origin', async () => {
  const { gw, port } = await start()
  const c = await client(port, 'secret')
  await c.next()
  const r = await c.call('rdp:prepare', { sessionId: 'rdp-1' })
  assert.equal((r.result as { proxyUrl: string }).proxyUrl, `ws://127.0.0.1:${port}/rdp?token=secret`)
  c.ws.close()
  await gw.close()
})

test('closes sessions a socket opened when it disconnects, but not ones it closed itself', async () => {
  const { gw, port, closed } = await start()
  const c = await client(port, 'secret')
  await c.next()
  await c.call('ssh:open', { sessionId: 'ssh-a' })
  await c.call('ssh:open', { sessionId: 'ssh-b' })
  await c.call('sftp:open', { instanceKey: 'k' })
  await c.call('rdp:prepare', { sessionId: 'rdp-1' })
  await c.call('ssh:close', 'ssh-b')
  c.ws.close()
  await once(c.ws, 'close')
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(closed.sort(), ['rdp:rdp-1', 'sftp:sftp-1', 'ssh:ssh-a', 'ssh:ssh-b'])
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
  await rm(dir, { recursive: true, force: true })
})

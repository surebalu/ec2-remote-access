/**
 * HTTP + WebSocket front for the connection engine, for browsers (phone, tablet, another Mac) instead of Electron.
 *
 *   GET  /            the built renderer (out/renderer) with a CSP that allows same-origin WebSockets
 *   GET  /auth?token= 204 when the token is right, 401 otherwise (the page checks before opening the socket)
 *   WS   /ws?token=…  RPC: {t:'call',id,channel,args} -> {t:'result',id,result} | {t:'error',id,message}
 *                     and pushed events {t:'event',channel,payload} (the IpcEvents channels)
 *   WS   /rdp?token=… transparent relay to the local RDCleanPath proxy so IronRDP in the browser reaches it
 *
 * Auth is a single shared bearer token in the query string; the intended deployment sits behind Tailscale (or
 * `tailscale serve` for HTTPS), so the token is a second lock rather than the only one. Sessions a socket opened
 * (SSH / SFTP / RDP) are closed when that socket goes away, so a phone losing signal does not leak connections.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import type { IpcApi } from '../shared/ipc'

export type GatewayHandlers = { [K in keyof IpcApi]: (...args: Parameters<IpcApi[K]>) => ReturnType<IpcApi[K]> }
type AnyHandler = (...args: unknown[]) => Promise<unknown>

export interface GatewayOptions {
  handlers: GatewayHandlers
  token: string
  /** Directory of the built renderer to serve at '/'. Omit to serve only the API (tests). */
  staticDir?: string
  /** Returns the local RDCleanPath proxy URL (ws://127.0.0.1:<port>/rdp) or null when RDP is unavailable. */
  rdpTarget?: () => Promise<string | null>
  log?: (line: string) => void
  /** Called with the connected RPC clients whenever the set changes. */
  onClientsChanged?: (clients: { address: string; since: number }[]) => void
}

export interface Gateway {
  server: Server
  /** Push an IpcEvents message to every connected browser. */
  broadcast(channel: string, payload: unknown): void
  listen(port: number, host: string): Promise<{ port: number; host: string }>
  close(): Promise<void>
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain'
}

/** Which calls open a long-lived session, where its id lives, and which call closes it. */
const SESSION_OPENERS: Record<string, { idFrom: 'args' | 'result'; closer: keyof IpcApi }> = {
  'ssh:open': { idFrom: 'args', closer: 'ssh:close' },
  'sftp:open': { idFrom: 'result', closer: 'sftp:close' },
  'rdp:prepare': { idFrom: 'args', closer: 'rdp:release' }
}
const SESSION_CLOSERS = new Set<string>(Object.values(SESSION_OPENERS).map((x) => x.closer))

export function createGatewayServer(opts: GatewayOptions): Gateway {
  const log = opts.log ?? ((l: string): void => console.log(l))
  const clients = new Map<WebSocket, { address: string; since: number }>()
  const notifyClients = (): void => opts.onClientsChanged?.(Array.from(clients.values()))
  /** Public host the browser used (behind `tailscale serve` that is the forwarded host, not 127.0.0.1). */
  const publicHost = (req: IncomingMessage): string => String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost')
  const remoteAddress = (req: IncomingMessage): string =>
    String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress?.replace(/^::ffff:/, '') || 'unknown'
  const rpc = new WebSocketServer({ noServer: true })
  const relay = new WebSocketServer({ noServer: true })

  const server = createServer((req, res) => {
    void serveStatic(req, res)
  })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.searchParams.get('token') !== opts.token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    // Browsers always send Origin on WebSocket upgrades; it must be the page we served, not some other site the
    // phone has open. Non-browser clients (tests, scripts) send none and are allowed through on the token alone.
    const origin = req.headers.origin
    if (origin) {
      let originHost = ''
      try { originHost = new URL(origin).host } catch { /* malformed */ }
      if (originHost !== publicHost(req)) {
        log(`[gateway] refused upgrade from origin ${origin} (expected ${publicHost(req)})`)
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
    }
    if (url.pathname === '/ws') rpc.handleUpgrade(req, socket, head, (ws) => onRpcConnection(ws, req))
    else if (url.pathname === '/rdp' && opts.rdpTarget) relay.handleUpgrade(req, socket, head, (ws) => void onRdpConnection(ws))
    else {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
    }
  })

  async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return }
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/auth') { res.writeHead(url.searchParams.get('token') === opts.token ? 204 : 401, { 'cache-control': 'no-store' }).end(); return }
    if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, clients: clients.size })); return }
    if (!opts.staticDir) { res.writeHead(404).end(); return }
    let rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '')
    if (rel === '/' || rel === '\\') rel = '/index.html'
    const file = join(opts.staticDir, rel)
    if (!file.startsWith(opts.staticDir) || !existsSync(file) || !statSync(file).isFile()) {
      // Unknown paths fall back to the app shell so a bookmarked route still loads.
      const index = join(opts.staticDir, 'index.html')
      if (!existsSync(index)) { res.writeHead(404).end(); return }
      return sendIndex(res, index)
    }
    if (rel === '/index.html') return sendIndex(res, file)
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' })
    if (req.method === 'HEAD') return void res.end()
    createReadStream(file).pipe(res)
  }

  function sendIndex(res: ServerResponse, file: string): void {
    // The Electron CSP only whitelists ws://127.0.0.1; a browser needs the gateway's own origin (plain or TLS).
    const html = readFileSync(file, 'utf8').replace(/connect-src [^;"]*/, "connect-src 'self' ws: wss: data: blob:")
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' }).end(html)
  }

  function onRpcConnection(ws: WebSocket, req: IncomingMessage): void {
    clients.set(ws, { address: remoteAddress(req), since: Date.now() })
    notifyClients()
    const owned = new Map<string, keyof IpcApi>()
    const forwardedProto = String(req.headers['x-forwarded-proto'] ?? '')
    const secure = forwardedProto === 'https' || forwardedProto === 'wss' || 'encrypted' in req.socket
    const publicWsBase = `${secure ? 'wss' : 'ws'}://${publicHost(req)}`
    ws.send(JSON.stringify({ t: 'hello', protocol: 1 }))

    ws.on('message', (raw: RawData) => {
      let msg: { t?: string; id?: number; channel?: string; args?: unknown[] }
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (msg.t !== 'call' || typeof msg.id !== 'number' || typeof msg.channel !== 'string') return
      const { id, channel } = msg
      const fn = (opts.handlers as Record<string, AnyHandler | undefined>)[channel]
      if (!fn) { ws.send(JSON.stringify({ t: 'error', id, message: `Unknown channel ${channel}` })); return }
      const args = Array.isArray(msg.args) ? msg.args : []
      void fn(...args).then(
        (result) => {
          const opener = SESSION_OPENERS[channel]
          if (opener) {
            const sid = opener.idFrom === 'args' ? (args[0] as { sessionId?: string } | undefined)?.sessionId : (result as { sessionId?: string } | undefined)?.sessionId
            if (sid) owned.set(sid, opener.closer)
          }
          if (SESSION_CLOSERS.has(channel) && typeof args[0] === 'string') owned.delete(args[0])
          if (channel === 'rdp:prepare' && result && typeof result === 'object' && 'proxyUrl' in result) {
            ;(result as { proxyUrl: string }).proxyUrl = `${publicWsBase}/rdp?token=${encodeURIComponent(opts.token)}`
          }
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'result', id, result: result ?? null }))
        },
        (e: Error) => {
          if (e.message !== 'cancelled') log(`[gateway ${channel}] ${e.message}`)
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'error', id, message: e.message }))
        }
      )
    })

    ws.on('close', () => {
      clients.delete(ws)
      notifyClients()
      for (const [sid, closer] of owned) {
        const close = (opts.handlers as Record<string, AnyHandler>)[closer]
        void close(sid).catch(() => undefined)
      }
      owned.clear()
    })
  }

  async function onRdpConnection(client: WebSocket): Promise<void> {
    const target = await opts.rdpTarget!().catch(() => null)
    if (!target) { client.close(1011, 'RDP proxy unavailable'); return }
    const upstream = new WebSocket(target)
    const queue: RawData[] = []
    client.on('message', (d) => { if (upstream.readyState === WebSocket.OPEN) upstream.send(d); else queue.push(d) })
    upstream.on('open', () => { for (const d of queue) upstream.send(d); queue.length = 0 })
    upstream.on('message', (d) => { if (client.readyState === WebSocket.OPEN) client.send(d) })
    const closeBoth = (): void => { client.close(); upstream.close() }
    client.on('close', closeBoth); upstream.on('close', closeBoth)
    client.on('error', closeBoth); upstream.on('error', closeBoth)
  }

  return {
    server,
    broadcast(channel, payload) {
      const data = JSON.stringify({ t: 'event', channel, payload })
      for (const c of clients.keys()) if (c.readyState === WebSocket.OPEN) c.send(data)
    },
    listen: (port, host) =>
      new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          const a = server.address()
          resolve({ port: typeof a === 'object' && a ? a.port : port, host })
        })
      }),
    close: () =>
      new Promise((resolve) => {
        for (const c of clients.keys()) c.close(1001, 'Gateway shutting down')
        rpc.close(); relay.close()
        server.close(() => resolve())
      })
  }
}

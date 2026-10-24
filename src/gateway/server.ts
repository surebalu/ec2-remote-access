/**
 * HTTP + WebSocket front for the connection engine, for browsers (phone, tablet, another Mac) instead of Electron.
 *
 *   GET  /            the built renderer (out/renderer) with a CSP that allows same-origin WebSockets
 *   GET  /auth?token= 204 when the token is right, 401 otherwise (the page checks before opening the socket)
 *   WS   /ws?token=…  RPC: {t:'call',id,channel,args} -> {t:'result',id,result} | {t:'error',id,message}
 *                     and pushed events {t:'event',channel,payload} (the IpcEvents channels)
 *   WS   /rdp?token=… transparent relay to the local RDCleanPath proxy so IronRDP in the browser reaches it
 *   WS   /vnc?token=…&s=<session token>  the same for screen sharing: relayed to the proxy's /vnc/<session token>
 *
 * Auth is a single shared bearer token in the query string; the intended deployment sits behind Tailscale (or
 * `tailscale serve` for HTTPS), so the token is a second lock rather than the only one. Sessions a socket opened
 * (SSH / SFTP / RDP) are closed when that socket goes away, so a phone losing signal does not leak connections.
 * A page that identifies itself (`/ws?client=<id>`, random per page load) gets a grace period instead: iOS suspends
 * a backgrounded app's sockets within seconds, and the same page reconnecting within `resumeGraceMs` keeps its
 * terminals and desktops rather than finding them closed.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
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
  /** Returns the local RDCleanPath proxy URL (ws://127.0.0.1:<port>/rdp; screen sharing is its /vnc/<token>) or null when RDP is unavailable. */
  rdpTarget?: () => Promise<string | null>
  log?: (line: string) => void
  /** How long sessions of a disconnected, self-identified page stay open for it to reconnect. Default 10 minutes. */
  resumeGraceMs?: number
  /** Called with the connected RPC clients whenever the set changes. */
  onClientsChanged?: (clients: { address: string; since: number }[]) => void
  /**
   * Whether paired pages may open shells on this machine (the Terminal tab), asked on every call. Off unless the
   * machine's owner turned it on there: the Mac's Settings → Phone access, or the gateway's --allow-terminals.
   */
  allowTerminals?: () => boolean
  /**
   * Box's answer after a sign-in started from a page here (main/box.ts boxCallback): the page to show. Box redirects
   * the browser without the gateway's token; the sign-in's own state is what proves the answer is ours.
   */
  boxCallback?: (query: URLSearchParams) => Promise<string>
  /**
   * A Links file by its item id, as a path on this machine (its own copy or Box's, boxSync.ts linkFileLocal), for
   * /links/file/<id>: a page here (a phone's Safari) opens the files Links keeps. null when there is none.
   */
  linkFile?: (id: string) => Promise<{ path: string; name: string } | null>
}

/**
 * Types a page's file may show as, in the browser: passive ones only. Anything else (HTML, SVG, scripts, unknown)
 * downloads as an attachment, since a file shown inline on the gateway's origin could read its token.
 */
const INLINE: Record<string, string> = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.heic': 'image/heic', '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.wav': 'audio/wav', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8', '.json': 'text/plain; charset=utf-8'
}

/** The signature a /links/file link carries: that one file's id signed with the gateway's token (renderer/wsApi.ts makes it). */
export const linkFileSignature = (token: string, id: string): Buffer => createHmac('sha256', token).update(`links-file:${id}`).digest()

export interface Gateway {
  server: Server
  /** Push an IpcEvents message to every connected browser. */
  broadcast(channel: string, payload: unknown): void
  /** Closes every terminal a paired page opened (terminals were just turned off). */
  closeTerminals(): void
  listen(port: number, host: string): Promise<{ port: number; host: string }>
  close(): Promise<void>
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain'
}

type Opened = { sessionId?: string; id?: string } | undefined

/** Which calls open a long-lived session, where its id lives, and which call closes it. */
const SESSION_OPENERS: Record<string, { id: (args: unknown[], result: unknown) => string | undefined; closer: keyof IpcApi }> = {
  'ssh:open': { id: (a) => (a[0] as Opened)?.sessionId, closer: 'ssh:close' },
  'sftp:open': { id: (_a, r) => (r as Opened)?.sessionId, closer: 'sftp:close' },
  'rdp:prepare': { id: (a) => (a[0] as Opened)?.sessionId, closer: 'rdp:release' },
  'vnc:prepare': { id: (a) => (a[0] as Opened)?.sessionId, closer: 'vnc:release' },
  'term:open': { id: (a) => (a[0] as Opened)?.id, closer: 'term:close' }
}
const SESSION_CLOSERS = new Set<string>(Object.values(SESSION_OPENERS).map((x) => x.closer))

/**
 * What stays with the person at the computer, never with whoever holds the pairing link: the desktop browser's
 * 1Password fill, downloads and pages, the phone-access settings themselves (so a paired page cannot widen its own
 * access), and dictation (voice:*), which would otherwise switch on the computer's microphone from afar and relay what
 * is said there. Shells on this machine (term:*) are refused too unless `allowTerminals` says otherwise.
 */
export function desktopOnly(channel: string): boolean {
  return channel.startsWith('web:') || channel.startsWith('voice:') || ['browser:fill', 'browser:logins', 'browser:openDownload', 'browser:cancelDownload', 'browser:share', 'browser:paneTargets', 'browser:frontPage', 'data:pickFolder', 'data:setFolder', 'data:copyLinkFiles', 'data:reveal', 'phone:configure', 'phone:rotateToken', 'phone:terminals', 'app:reveal', 'app:emojiPanel', 'app:pointer', 'local:open', 'local:quickLook', 'maccal:ask', 'maccal:settings'].includes(channel) || channel.startsWith('finder:') || channel.startsWith('storage:') || channel.startsWith('launcher:') || channel.startsWith('wm:') || channel.startsWith('cad:') || channel.startsWith('setup:') || channel === 'links:openFile' || channel.startsWith('linksPanel:') || channel.startsWith('tools:') || channel.startsWith('ext:')
}

export function createGatewayServer(opts: GatewayOptions): Gateway {
  const log = opts.log ?? ((l: string): void => console.log(l))
  const clients = new Map<WebSocket, { address: string; since: number; owned?: Map<string, keyof IpcApi> }>()
  const terminalsAllowed = (): boolean => opts.allowTerminals?.() === true
  const notifyClients = (): void => opts.onClientsChanged?.(Array.from(clients.values(), ({ address, since }) => ({ address, since })))
  /** Public host the browser used (behind `tailscale serve` that is the forwarded host, not 127.0.0.1). */
  const publicHost = (req: IncomingMessage): string => String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost')
  const remoteAddress = (req: IncomingMessage): string =>
    String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress?.replace(/^::ffff:/, '') || 'unknown'
  const resumeGraceMs = opts.resumeGraceMs ?? 10 * 60_000
  /** Sessions per self-identified page, kept across its reconnects; `timer` runs while it is disconnected. */
  const pages = new Map<string, { owned: Map<string, keyof IpcApi>; timer?: ReturnType<typeof setTimeout> }>()
  const closeOwned = (owned: Map<string, keyof IpcApi>): void => {
    for (const [sid, closer] of owned) {
      const close = (opts.handlers as Record<string, AnyHandler>)[closer]
      void close(sid).catch(() => undefined)
    }
    owned.clear()
  }
  let shuttingDown = false
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
    else if (url.pathname === '/vnc' && opts.rdpTarget && /^[A-Za-z0-9_-]{16,64}$/.test(url.searchParams.get('s') ?? '')) {
      const session = url.searchParams.get('s')!
      relay.handleUpgrade(req, socket, head, (ws) => void onRdpConnection(ws, (proxy) => proxy.replace(/\/rdp$/, `/vnc/${session}`)))
    }
    else {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
    }
  })

  /**
   * A Links file for a page here. The link carries a signature of that one file's id (not the token, which would sit
   * in Safari's history), checked in constant time. Byte ranges, which Safari needs to play a video.
   */
  async function serveLinkFile(req: IncomingMessage, res: ServerResponse, id: string, sig: string): Promise<void> {
    const want = linkFileSignature(opts.token, id)
    const got = /^[0-9a-f]{64}$/.test(sig) ? Buffer.from(sig, 'hex') : Buffer.alloc(0)
    const text = (status: number, message: string): void => { res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end(message) }
    if (got.length !== want.length || !timingSafeEqual(got, want)) { text(403, 'This link is not valid here.'); return }
    let file: { path: string; name: string } | null
    try {
      file = await opts.linkFile!(id)
    } catch (e) {
      text(502, `The file could not be fetched: ${(e as Error).message}`)
      return
    }
    if (!file || !existsSync(file.path)) { text(404, 'This file is not on this computer, and not in Box yet.'); return }
    const size = statSync(file.path).size
    const type = INLINE[extname(file.name).toLowerCase()]
    const headers: Record<string, string | number> = {
      'content-type': type ?? 'application/octet-stream',
      'content-disposition': `${type ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store', 'accept-ranges': 'bytes'
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
      if (start > end || start >= size) { res.writeHead(416, { 'content-range': `bytes */${size}` }).end(); return }
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 })
      if (req.method === 'HEAD') { res.end(); return }
      createReadStream(file.path, { start, end }).pipe(res)
      return
    }
    res.writeHead(200, { ...headers, 'content-length': size })
    if (req.method === 'HEAD') { res.end(); return }
    createReadStream(file.path).pipe(res)
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return }
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/auth') { res.writeHead(url.searchParams.get('token') === opts.token ? 204 : 401, { 'cache-control': 'no-store' }).end(); return }
    const linkFile = /^\/links\/file\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname)
    if (linkFile && opts.linkFile) { await serveLinkFile(req, res, linkFile[1], url.searchParams.get('sig') ?? ''); return }
    if (url.pathname === '/box/callback' && opts.boxCallback) {
      const page = await opts.boxCallback(url.searchParams)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page)
      return
    }
    if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, clients: clients.size })); return }
    if (!opts.staticDir) { res.writeHead(404).end(); return }
    let rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '')
    if (rel === '/' || rel === '\\') rel = '/index.html'
    const file = join(opts.staticDir, rel)
    // A build's files are named by their content, so one asked for and not here belongs to an older build (a page
    // left open across an update). Not found is the honest answer; the app shell in its place would fail as a script.
    if (rel.startsWith('/assets/') && (!file.startsWith(opts.staticDir) || !existsSync(file) || !statSync(file).isFile())) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end('Not found: this file belongs to an older version of the app. Reload the page.')
      return
    }
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

  /**
   * The build being served, named by its entry script (`assets/index-<hash>.js`), so a page can tell it is older than
   * the gateway after an update (renderer/wsApi.ts). Read again when index.html changes; '' without a renderer.
   */
  let build = { mtime: 0, name: '' }
  function currentBuild(): string {
    if (!opts.staticDir) return ''
    const index = join(opts.staticDir, 'index.html')
    try {
      const mtime = statSync(index).mtimeMs
      if (mtime !== build.mtime) build = { mtime, name: /assets\/(index-[\w-]+\.js)/.exec(readFileSync(index, 'utf8'))?.[1] ?? '' }
    } catch {
      return ''
    }
    return build.name
  }

  function sendIndex(res: ServerResponse, file: string): void {
    // The Electron CSP only whitelists ws://127.0.0.1; a browser needs the gateway's own origin (plain or TLS).
    const html = readFileSync(file, 'utf8').replace(/connect-src [^;"]*/, "connect-src 'self' ws: wss: data: blob:")
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' }).end(html)
  }

  function onRpcConnection(ws: WebSocket, req: IncomingMessage): void {
    clients.set(ws, { address: remoteAddress(req), since: Date.now() })
    ;(ws as WebSocket & { pageId?: string }).pageId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('client')?.slice(0, 64) || undefined
    notifyClients()
    const pageId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('client')?.slice(0, 64) || null
    let page = pageId ? pages.get(pageId) : undefined
    if (pageId && !page) pages.set(pageId, (page = { owned: new Map() }))
    if (page?.timer) {
      clearTimeout(page.timer)
      page.timer = undefined
      if (page.owned.size) log(`[gateway] client resumed with ${page.owned.size} session(s)`)
    }
    const owned = page?.owned ?? new Map<string, keyof IpcApi>()
    clients.get(ws)!.owned = owned
    const forwardedProto = String(req.headers['x-forwarded-proto'] ?? '')
    const secure = forwardedProto === 'https' || forwardedProto === 'wss' || 'encrypted' in req.socket
    const publicWsBase = `${secure ? 'wss' : 'ws'}://${publicHost(req)}`
    ws.send(JSON.stringify({ t: 'hello', protocol: 1, build: currentBuild() }))

    ws.on('message', (raw: RawData) => {
      let msg: { t?: string; id?: number; channel?: string; args?: unknown[] }
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (msg.t !== 'call' || typeof msg.id !== 'number' || typeof msg.channel !== 'string') return
      const { id, channel } = msg
      const reply = (result: unknown): void => { ws.send(JSON.stringify({ t: 'result', id, result: result ?? null })) }
      if (desktopOnly(channel) || (channel.startsWith('term:') && channel !== 'term:available' && !terminalsAllowed())) {
        const message = channel.startsWith('term:') ? 'Terminals from paired devices are off. Turn them on on the computer running the app.'
          : channel.startsWith('voice:') ? 'Dictation runs in the Mac app; on iPhone or iPad use the keyboard’s microphone key.'
            : 'That is only available in the Mac app.'
        ws.send(JSON.stringify({ t: 'error', id, message }))
        return
      }
      if (channel === 'term:available') return reply(terminalsAllowed())
      // A paired page's terminal layout is its own; it must not replace the computer's saved one.
      if (channel === 'term:loadState') return reply(null)
      if (channel === 'term:saveState') return reply(null)
      // Only the Mac's own window sets these: which shells a phone may open, and where the Mac keeps a copy of its data.
      if (channel === 'settings:set' && msg.args?.[0] && typeof msg.args[0] === 'object') { delete (msg.args[0] as Record<string, unknown>).phoneTerminals; delete (msg.args[0] as Record<string, unknown>).dataDir }
      const fn = (opts.handlers as Record<string, AnyHandler | undefined>)[channel]
      if (!fn) { ws.send(JSON.stringify({ t: 'error', id, message: `Unknown channel ${channel}` })); return }
      const args = Array.isArray(msg.args) ? msg.args : []
      void fn(...args).then(
        (result) => {
          const opener = SESSION_OPENERS[channel]
          if (opener) {
            const sid = opener.id(args, result)
            if (sid) owned.set(sid, opener.closer)
          }
          if (SESSION_CLOSERS.has(channel) && typeof args[0] === 'string') owned.delete(args[0])
          if (channel === 'rdp:prepare' && result && typeof result === 'object' && 'proxyUrl' in result) {
            ;(result as { proxyUrl: string }).proxyUrl = `${publicWsBase}/rdp?token=${encodeURIComponent(opts.token)}`
          }
          // The local proxy's address means nothing to a phone: the same session goes through this server instead.
          if (channel === 'vnc:prepare' && result && typeof result === 'object' && 'url' in result) {
            const session = /\/vnc\/([A-Za-z0-9_-]+)$/.exec((result as { url: string }).url)?.[1] ?? ''
            ;(result as { url: string }).url = `${publicWsBase}/vnc?token=${encodeURIComponent(opts.token)}&s=${session}`
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
      if (!pageId || !page || !owned.size || resumeGraceMs <= 0 || shuttingDown) {
        closeOwned(owned)
        if (pageId) pages.delete(pageId)
        return
      }
      // A newer socket from the same page may already be open (reconnect raced the close); it owns them now.
      if ([...clients.keys()].some((c) => (c as WebSocket & { pageId?: string }).pageId === pageId)) return
      const p = page
      p.timer = setTimeout(() => { closeOwned(p.owned); pages.delete(pageId) }, resumeGraceMs)
    })
  }

  /** Relays a page's WebSocket to the local proxy: RDCleanPath as it is, or (with `path`) one screen-sharing session. */
  async function onRdpConnection(client: WebSocket, path?: (proxy: string) => string): Promise<void> {
    const proxy = await opts.rdpTarget!().catch(() => null)
    if (!proxy) { client.close(1011, 'RDP proxy unavailable'); return }
    const target = path ? path(proxy) : proxy
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
      if (desktopOnly(channel)) return
      const data = JSON.stringify({ t: 'event', channel, payload })
      // A shell's output goes only to the page that opened it (never the computer's own terminals, nor other phones).
      const term = channel.startsWith('term:') ? (payload as { id?: string } | undefined)?.id : undefined
      if (channel.startsWith('term:') && (!term || !terminalsAllowed())) return
      for (const [c, info] of clients) if (c.readyState === WebSocket.OPEN && (!term || info.owned?.has(term))) c.send(data)
    },
    closeTerminals() {
      const close = (opts.handlers as Record<string, AnyHandler>)['term:close']
      const maps = [...[...clients.values()].map((c) => c.owned), ...[...pages.values()].map((p) => p.owned)]
      for (const owned of maps) {
        if (!owned) continue
        for (const [sid, closer] of owned) {
          if (closer !== 'term:close') continue
          owned.delete(sid)
          void close?.(sid).catch(() => undefined)
        }
      }
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
        shuttingDown = true
        for (const p of pages.values()) { clearTimeout(p.timer); closeOwned(p.owned) }
        pages.clear()
        for (const c of clients.keys()) c.close(1001, 'Gateway shutting down')
        rpc.close(); relay.close()
        server.close(() => resolve())
      })
  }
}

/**
 * Local RDCleanPath proxy for the IronRDP web client.
 *
 * The IronRDP browser client cannot open TCP sockets, so it speaks to a "gateway" over WebSocket:
 *   1. client -> proxy : RDCleanPath request  (version, destination, proxy_auth, x224 connection request)
 *   2. proxy  -> server: TCP connect, forward the X.224 request, read the X.224 confirm, TLS handshake
 *   3. proxy  -> client: RDCleanPath response (x224 confirm, server certificate chain, server address)
 *   4. bytes are relayed transparently: WebSocket <-> TLS socket. NLA/CredSSP is done by the client.
 * This module runs that gateway on 127.0.0.1 inside the app; nothing leaves the machine except the TLS
 * connection to the EC2 instance itself.
 */
import { WebSocketServer, type WebSocket } from 'ws'
import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket, type DetailedPeerCertificate, type ConnectionOptions } from 'node:tls'
import { der, decodeInteger, readAll, readTlv } from './der'
import { log } from '../log'

/**
 * A relay is declared stalled when the client has been sending input for this long without a single byte back.
 * An idle desktop is silent in both directions, so idleness alone never trips it; a dead SSM tunnel or a half-open
 * socket does, because the server never answers the user's clicks.
 */
const STALL_MS = 30_000
/** Live relays per proxy token, so a dying SSM tunnel can cut them and let the client reconnect promptly. */
const activeRelays = new Map<string, Set<() => void>>()

/** Tears down every relay for a token (e.g. when its session-manager-plugin exits). Returns how many were cut. */
export function dropConnections(token: string, why: string): number {
  const set = activeRelays.get(token)
  if (!set || set.size === 0) return 0
  log('rdp-proxy', `cutting ${set.size} relay(s)`, { token: token.slice(0, 8), why })
  for (const close of Array.from(set)) close()
  return set.size
}

const VERSION_1 = 3390
const GENERAL_ERROR = 1
const NEGOTIATION_ERROR = 2

export interface CleanPathTarget {
  host: string
  port: number
  onClose?: () => void
}

const targets = new Map<string, CleanPathTarget>()
/** Human-readable reason for the last failure per token; the RDCleanPath error PDU itself carries only a code. */
const lastErrors = new Map<string, string>()

export function lastErrorFor(token: string): string | undefined {
  return lastErrors.get(token)
}
let server: WebSocketServer | null = null
let port = 0

export function registerTarget(token: string, target: CleanPathTarget): void {
  targets.set(token, target)
}
export function unregisterTarget(token: string): void {
  targets.delete(token)
  lastErrors.delete(token)
}

export async function ensureProxy(): Promise<string> {
  if (server) return `ws://127.0.0.1:${port}/rdp`
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((res, rej) => {
    server!.once('listening', () => res())
    server!.once('error', rej)
  })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  server.on('connection', (ws) => {
    const ctx: { token?: string } = {}
    void handle(ws, ctx).catch((e) => {
      const msg = friendlyTls((e as Error).message)
      if (ctx.token) lastErrors.set(ctx.token, msg)
      sendError(ws, GENERAL_ERROR, msg)
    })
  })
  return `ws://127.0.0.1:${port}/rdp`
}

export function stopProxy(): void {
  server?.close()
  server = null
}

interface Request {
  version: number
  destination?: string
  proxyAuth?: string
  x224: Buffer
}

function decodeRequest(buf: Buffer): Request {
  const outer = readTlv(buf)
  if (!outer || outer.tlv.tag !== 0x30) throw new Error('RDCleanPath: not a SEQUENCE')
  const req: Partial<Request> = {}
  for (const f of readAll(outer.tlv.value)) {
    const inner = readAll(f.value)[0]
    switch (f.tag & 0x1f) {
      case 0:
        req.version = decodeInteger(inner.value)
        break
      case 2:
        req.destination = inner.value.toString('utf8')
        break
      case 3:
        req.proxyAuth = inner.value.toString('utf8')
        break
      case 6:
        req.x224 = Buffer.from(inner.value)
        break
    }
  }
  if (req.version !== VERSION_1) throw new Error(`RDCleanPath: unsupported version ${req.version}`)
  if (!req.x224) throw new Error('RDCleanPath: missing X.224 connection request')
  return req as Request
}

function encodeResponse(x224Confirm: Buffer, chain: Buffer[], serverAddr: string): Buffer {
  return der.sequence(
    der.ctx(0, der.integer(VERSION_1)),
    der.ctx(6, der.octets(x224Confirm)),
    der.ctx(7, der.sequence(...chain.map((c) => der.octets(c)))),
    der.ctx(9, der.utf8(serverAddr))
  )
}

function encodeError(code: number, tlsAlert?: number): Buffer {
  const fields = [der.ctx(0, der.integer(code))]
  if (tlsAlert !== undefined) fields.push(der.ctx(3, der.integer(tlsAlert)))
  return der.sequence(der.ctx(0, der.integer(VERSION_1)), der.ctx(1, der.sequence(...fields)))
}

function friendlyTls(msg: string): string {
  if (/KEY_USAGE_BIT_INCORRECT/.test(msg)) return `TLS handshake rejected the server certificate (key usage does not allow signing) and no compatible cipher fallback worked. ${msg}`
  if (/ECONNREFUSED/.test(msg)) return 'Connection refused: nothing is listening on that port (is RDP enabled / is the port right?).'
  if (/timed out|ETIMEDOUT/.test(msg)) return 'Connection timed out: host unreachable from this Mac (VPN? firewall?).'
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return 'Hostname could not be resolved.'
  return msg
}

/**
 * Electron's BoringSSL enforces the certificate keyUsage bit for the negotiated key exchange. Windows' self-signed
 * "Remote Desktop" certificates often carry keyEncipherment only, which breaks (EC)DHE signing. Fall back to
 * TLS 1.2 with RSA key exchange, which such certificates do permit.
 */
async function tlsHandshake(raw: Socket): Promise<TLSSocket> {
  const attempt = (opts: ConnectionOptions): Promise<TLSSocket> =>
    new Promise((res, rej) => {
      const t = tlsConnect({ socket: raw, rejectUnauthorized: false, ...opts }, () => res(t))
      t.once('error', rej)
    })
  try {
    // TLS 1.2 on purpose: under TLS 1.3 BoringSSL rejects Windows' self-signed RDP certificates (KEY_USAGE_BIT_INCORRECT).
    return await attempt({ minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' })
  } catch (e) {
    const msg = (e as Error).message
    if (!/KEY_USAGE_BIT_INCORRECT|WRONG_SIGNATURE_TYPE|handshake failure/i.test(msg)) throw e
    // The socket may now hold garbage from the failed attempt; a fresh TCP connection is needed for a retry.
    throw new RetryWithRsaKex(msg)
  }
}

class RetryWithRsaKex extends Error {}

function sendError(ws: WebSocket, code: number, message: string): void {
  console.error('[rdp-proxy]', message)
  try {
    ws.send(encodeError(code), { binary: true })
  } finally {
    setTimeout(() => ws.close(), 100)
  }
}

/** Waits for the first complete DER element on the socket. */
function readPdu(ws: WebSocket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let acc = Buffer.alloc(0)
    const onMsg = (data: Buffer | ArrayBuffer | Buffer[]): void => {
      const chunk = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
      acc = Buffer.concat([acc, chunk])
      const r = readTlv(acc)
      if (r) {
        ws.off('message', onMsg)
        resolve(acc.subarray(0, r.end))
      }
    }
    ws.on('message', onMsg)
    ws.once('close', () => reject(new Error('client closed before RDCleanPath request')))
    ws.once('error', reject)
  })
}

/** Reads one TPKT-framed PDU (X.224 connection confirm) from the TCP socket. */
function readTpkt(sock: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let acc = Buffer.alloc(0)
    let timer: ReturnType<typeof setTimeout> | undefined
    const onData = (d: Buffer): void => {
      acc = Buffer.concat([acc, d])
      if (acc.length >= 4) {
        const len = acc.readUInt16BE(2)
        if (acc.length >= len) {
          sock.off('data', onData)
          sock.pause()
          clearTimeout(timer)
          resolve(acc.subarray(0, len))
        }
      }
    }
    sock.on('data', onData)
    sock.once('error', reject)
    sock.once('close', () => reject(new Error('server closed during X.224 negotiation')))
    timer = setTimeout(() => reject(new Error('timeout waiting for X.224 confirm')), 15_000)
    sock.once('close', () => clearTimeout(timer))
  })
}

function certChain(tls: TLSSocket): Buffer[] {
  const out: Buffer[] = []
  let cert: DetailedPeerCertificate | undefined = tls.getPeerCertificate(true)
  const seen = new Set<string>()
  while (cert && cert.raw && !seen.has(cert.fingerprint256)) {
    seen.add(cert.fingerprint256)
    out.push(Buffer.from(cert.raw))
    cert = cert.issuerCertificate && cert.issuerCertificate !== cert ? cert.issuerCertificate : undefined
  }
  return out
}

async function connectAndNegotiate(target: CleanPathTarget, x224: Buffer): Promise<{ raw: Socket; confirm: Buffer }> {
  const raw = await new Promise<Socket>((res, rej) => {
    const s = netConnect({ host: target.host, port: target.port })
    s.setNoDelay(true)
    s.once('connect', () => res(s))
    s.once('error', rej)
    s.setTimeout(20_000, () => rej(new Error(`TCP connect to ${target.host}:${target.port} timed out`)))
  })
  raw.setTimeout(0)
  // Detects a peer that vanished at the IP level (direct route, or a dead local listener) within ~1 minute.
  raw.setKeepAlive(true, 30_000)
  // X.224 negotiation happens in the clear.
  raw.write(x224)
  const confirm = await readTpkt(raw)
  return { raw, confirm }
}

async function handle(ws: WebSocket, ctx: { token?: string }): Promise<void> {
  const req = decodeRequest(await readPdu(ws))
  ctx.token = req.proxyAuth
  const target = req.proxyAuth ? targets.get(req.proxyAuth) : undefined
  if (!target) {
    sendError(ws, GENERAL_ERROR, 'RDCleanPath: unknown or expired session token')
    return
  }
  if (req.proxyAuth) lastErrors.delete(req.proxyAuth)

  let { raw, confirm } = await connectAndNegotiate(target, req.x224)
  // RDP_NEG_RSP: byte 11 = type (0x02 = response, 0x03 = failure), bytes 15..18 = selected protocol.
  if (confirm.length >= 19 && confirm[11] === 0x03) {
    raw.destroy()
    sendError(ws, NEGOTIATION_ERROR, `server refused negotiation (failure code ${confirm.readUInt32LE(15)})`)
    return
  }
  const selected = confirm.length >= 19 && confirm[11] === 0x02 ? confirm.readUInt32LE(15) : 0
  if (selected === 0) {
    raw.destroy()
    sendError(ws, NEGOTIATION_ERROR, 'server selected legacy RDP security; TLS/NLA is required')
    return
  }

  let tls: TLSSocket
  try {
    raw.resume()
    tls = await tlsHandshake(raw)
  } catch (e) {
    if (!(e instanceof RetryWithRsaKex)) throw e
    console.warn('[rdp-proxy] retrying TLS with RSA key exchange:', e.message.split('\n')[0])
    raw.destroy()
    ;({ raw, confirm } = await connectAndNegotiate(target, req.x224))
    raw.resume()
    tls = await new Promise<TLSSocket>((res, rej) => {
      const t = tlsConnect(
        {
          socket: raw,
          rejectUnauthorized: false,
          minVersion: 'TLSv1.2',
          maxVersion: 'TLSv1.2',
          ciphers: 'AES256-GCM-SHA384:AES128-GCM-SHA256:AES256-SHA256:AES128-SHA256:AES256-SHA:AES128-SHA'
        },
        () => res(t)
      )
      t.once('error', rej)
    })
  }

  // Probe the far side at the TCP layer so a silently-dead SSM tunnel (idle-timed-out, or the plugin's WebSocket to
  // AWS dropped) becomes a socket error within ~1 min instead of an indefinite freeze.
  tls.setKeepAlive(true, 30_000)
  ws.send(encodeResponse(confirm, certChain(tls), `${target.host}:${target.port}`), { binary: true })

  // Transparent relay from here on. Byte counters let us tell the user roughly *when* the server dropped us.
  const startedAt = Date.now()
  const shortToken = (ctx.token ?? '').slice(0, 8)
  log('rdp-proxy', 'relay open', { token: shortToken, target: `${target.host}:${target.port}` })
  let up = 0
  let down = 0
  let clientClosed = false
  let noted = false
  /** Set when the client sends while nothing has come back yet; cleared by the next server byte. */
  let waitingSince: number | null = null
  let lastDown = Date.now()
  const phase = (): string => {
    if (down === 0) return 'right after the TLS handshake, before the server sent anything'
    if (up + down < 4096) return 'during the security handshake (NLA/CredSSP)'
    return 'after the session was established'
  }
  const note = (why: string): void => {
    if (noted || clientClosed || !ctx.token) return
    noted = true
    const msg = `${target.host}:${target.port} ${why} ${phase()} (${up} B sent, ${down} B received).`
    lastErrors.set(ctx.token, msg)
    console.warn('[rdp-proxy]', msg)
  }
  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
    const chunk = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
    up += chunk.length
    if (waitingSince === null) waitingSince = Date.now()
    tls.write(chunk)
  })
  tls.on('data', (d: Buffer) => {
    down += d.length
    lastDown = Date.now()
    waitingSince = null
    if (ws.readyState === ws.OPEN) ws.send(d, { binary: true })
  })
  let closed = false
  const closeAll = (): void => {
    if (closed) return
    closed = true
    clearInterval(watchdog)
    if (ctx.token) activeRelays.get(ctx.token)?.delete(closeAll)
    log('rdp-proxy', 'relay closed', {
      token: shortToken, target: `${target.host}:${target.port}`, up, down,
      seconds: Math.round((Date.now() - startedAt) / 1000), silentForSeconds: Math.round((Date.now() - lastDown) / 1000), byClient: clientClosed
    })
    tls.destroy()
    if (ws.readyState === ws.OPEN) ws.close()
    target.onClose?.()
  }
  if (ctx.token) {
    const set = activeRelays.get(ctx.token) ?? new Set()
    activeRelays.set(ctx.token, set)
    set.add(closeAll)
  }
  const watchdog = setInterval(() => {
    if (waitingSince !== null && Date.now() - waitingSince > STALL_MS) {
      note(`stopped responding: ${Math.round(STALL_MS / 1000)} s of input with no reply`)
      log('rdp-proxy', 'stall detected, cutting relay so the client reconnects', { token: shortToken, silentForSeconds: Math.round((Date.now() - lastDown) / 1000) })
      closeAll()
    }
  }, 5_000)
  tls.on('close', () => {
    note('closed the connection')
    closeAll()
  })
  tls.on('error', (e) => {
    note(`connection failed: ${friendlyTls(e.message)}`)
    closeAll()
  })
  ws.on('close', () => {
    clientClosed = true
    closeAll()
  })
  ws.on('error', closeAll)
}

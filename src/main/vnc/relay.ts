/**
 * Screen sharing (VNC/RFB) relay for the in-page noVNC client, which cannot open TCP sockets: each WebSocket carries
 * one RFB stream, byte for byte, to the host the session was prepared for. It rides on the RDP proxy's localhost
 * WebSocket server (rdp/cleanpath.ts routes `/vnc/<token>` here), so the gateway and the CSP need no second port.
 * Unlike RDCleanPath, RFB has no room for a token in-band; the one-time token is the URL path.
 */
import type { WebSocket } from 'ws'
import { connect as netConnect } from 'node:net'
import { log } from '../log'

export interface VncTarget {
  host: string
  port: number
}

const targets = new Map<string, VncTarget>()
const relays = new Map<string, Set<() => void>>()
const lastErrors = new Map<string, string>()

/** Bytes the browser has not taken yet before the host's socket is paused, so a slow phone does not buffer a screenful per frame. */
const HIGH_WATER = 4 * 1024 * 1024
const CONNECT_TIMEOUT_MS = 15_000

export function registerVncTarget(token: string, target: VncTarget): void {
  targets.set(token, target)
  lastErrors.delete(token)
}

export function unregisterVncTarget(token: string): void {
  targets.delete(token)
  lastErrors.delete(token)
  for (const close of Array.from(relays.get(token) ?? [])) close()
  relays.delete(token)
}

export function vncLastErrorFor(token: string): string | undefined {
  return lastErrors.get(token)
}

/** What a failed connect means for someone trying to see a screen, in their terms. */
export function describeConnectError(code: string | undefined, host: string, port: number): string {
  if (code === 'ECONNREFUSED') {
    return `Nothing is accepting screen sharing on ${host}:${port}. On a Mac turn on Screen Sharing or Remote Management (System Settings → General → Sharing); on Windows or Linux start a VNC server.`
  }
  if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EHOSTDOWN') {
    return `${host}:${port} did not answer. Check that the computer is awake and online in Tailscale.`
  }
  if (code === 'ENOTFOUND') return `${host} could not be found.`
  return `Could not reach ${host}:${port}${code ? ` (${code})` : ''}.`
}

export function relayVnc(ws: WebSocket, token: string): void {
  const target = targets.get(token)
  if (!target) {
    ws.close(4001, 'Unknown or expired screen sharing session')
    return
  }
  const where = `${target.host}:${target.port}`
  const short = token.slice(0, 8)
  const sock = netConnect({ host: target.host, port: target.port })
  sock.setNoDelay(true)
  sock.setTimeout(CONNECT_TIMEOUT_MS, () => sock.destroy(Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' })))
  const pending: Buffer[] = []
  let connected = false
  let up = 0
  let down = 0
  let closed = false
  const startedAt = Date.now()

  const close = (): void => {
    if (closed) return
    closed = true
    clearInterval(drain)
    relays.get(token)?.delete(close)
    sock.destroy()
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close()
    log('vnc', 'relay closed', { token: short, target: where, up, down, seconds: Math.round((Date.now() - startedAt) / 1000) })
  }
  const set = relays.get(token) ?? new Set()
  relays.set(token, set)
  set.add(close)

  // Backpressure: pause the host while the page has a lot unread, resume once it has caught up.
  const drain = setInterval(() => {
    if (sock.isPaused() && ws.bufferedAmount < HIGH_WATER / 4) sock.resume()
  }, 50)

  sock.on('connect', () => {
    connected = true
    sock.setTimeout(0)
    // A VNC session can sit idle for hours while someone reads the screen; keepalive spots a peer that vanished.
    sock.setKeepAlive(true, 30_000)
    for (const chunk of pending) sock.write(chunk)
    pending.length = 0
    log('vnc', 'relay open', { token: short, target: where })
  })
  sock.on('data', (d: Buffer) => {
    down += d.length
    if (ws.readyState !== ws.OPEN) return
    ws.send(d, { binary: true })
    if (ws.bufferedAmount > HIGH_WATER) sock.pause()
  })
  sock.on('error', (e: NodeJS.ErrnoException) => {
    const msg = connected ? `The connection to ${where} was lost (${e.code ?? e.message}).` : describeConnectError(e.code, target.host, target.port)
    lastErrors.set(token, msg)
    log('vnc', 'relay error', { token: short, target: where, error: e.code ?? e.message, connected })
  })
  sock.on('close', close)
  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
    const chunk = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
    up += chunk.length
    if (connected) sock.write(chunk)
    else pending.push(chunk)
  })
  ws.on('close', close)
  ws.on('error', close)
}

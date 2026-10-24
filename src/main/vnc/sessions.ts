import { randomBytes } from 'node:crypto'
import type { VncPrepareRequest, VncPrepared } from '@shared/types'
import { findInstance } from '../aws/inventory'
import { decideRoute } from '../connect/route'
import { startPortForward, type SsmHandle } from '../ssm/session'
import { getSettings } from '../store'
import { addTunnel, closeTunnel, updateTunnel } from '../tunnels'
import { freePort, uid } from '../util'
import { ensureProxy } from '../rdp/cleanpath'
import { registerVncTarget, unregisterVncTarget, vncLastErrorFor } from './relay'
import { log } from '../log'

interface Live {
  token: string
  tunnelId?: string
  ssm?: SsmHandle
}
const live = new Map<string, Live>()

/**
 * Resolves the path to a host's screen-sharing port (direct, which is how Tailscale machines and hand-added servers
 * are reached, or an SSM port-forward for an EC2 instance) and returns the WebSocket the page's VNC client opens.
 */
export async function prepareVnc(req: VncPrepareRequest): Promise<VncPrepared> {
  // A reconnect prepares again under the same session id: the previous token and tunnel go first.
  if (live.has(req.sessionId)) await releaseVnc(req.sessionId)
  const inst = findInstance(req.instanceKey)
  const route = decideRoute(inst, req.forceRoute)
  if (route.route === 'unreachable' || route.route === 'not-running') throw new Error(route.reason)
  const remotePort = req.port ?? getSettings().overrides[inst.key]?.vncPort ?? 5900
  const proxy = await ensureProxy()
  const token = randomBytes(24).toString('base64url')
  const title = inst.tailnet ? inst.name : `${inst.name} @ ${inst.profile}`
  const entry: Live = { token }
  live.set(req.sessionId, entry)

  let host: string
  let port: number
  if (route.route === 'ssm') {
    const localPort = await freePort()
    const tunnelId = uid('vnc')
    entry.tunnelId = tunnelId
    addTunnel({ id: tunnelId, instanceKey: inst.key, title, kind: 'vnc', localPort, remotePort, status: 'starting', startedAt: Date.now() })
    try {
      entry.ssm = await startPortForward(inst, remotePort, localPort, (line) => updateTunnel(tunnelId, { message: line }))
    } catch (e) {
      updateTunnel(tunnelId, { status: 'error', message: (e as Error).message })
      live.delete(req.sessionId)
      throw e
    }
    addTunnel({ id: tunnelId, instanceKey: inst.key, title, kind: 'vnc', localPort, remotePort, status: 'ready', message: 'screen sharing', startedAt: Date.now() }, entry.ssm)
    host = '127.0.0.1'
    port = localPort
  } else {
    host = route.host!
    port = remotePort
  }
  registerVncTarget(token, { host, port })
  log('vnc', 'prepared', { sessionId: req.sessionId, token: token.slice(0, 8), instance: inst.key, route: route.route, target: `${host}:${port}` })
  return { sessionId: req.sessionId, url: proxy.replace(/\/rdp$/, `/vnc/${token}`), destination: `${host}:${port}`, route: route.route, title }
}

export async function releaseVnc(sessionId: string): Promise<void> {
  const entry = live.get(sessionId)
  if (!entry) return
  live.delete(sessionId)
  unregisterVncTarget(entry.token)
  if (entry.tunnelId) await closeTunnel(entry.tunnelId)
  else await entry.ssm?.terminate()
}

export async function releaseAllVnc(): Promise<void> {
  await Promise.all(Array.from(live.keys()).map((k) => releaseVnc(k)))
}

export function vncLastError(sessionId: string): string | undefined {
  const entry = live.get(sessionId)
  return entry ? vncLastErrorFor(entry.token) : undefined
}

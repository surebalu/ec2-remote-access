import { randomBytes } from 'node:crypto'
import type { RdpPrepareRequest, RdpPrepared } from '@shared/types'
import { findInstance } from '../aws/inventory'
import { decideRoute, defaultRdpUser } from '../connect/route'
import { startPortForward, type SsmHandle } from '../ssm/session'
import { getSettings } from '../store'
import { addTunnel, closeTunnel, updateTunnel } from '../tunnels'
import { freePort, uid } from '../util'
import { ensureProxy, registerTarget, unregisterTarget, lastErrorFor } from './cleanpath'

interface Live {
  token: string
  tunnelId?: string
  ssm?: SsmHandle
}
const live = new Map<string, Live>()

/** Resolves the network path (direct or SSM port-forward) and registers it with the local RDCleanPath proxy. */
export async function prepareRdp(req: RdpPrepareRequest): Promise<RdpPrepared> {
  // A reconnect re-prepares under the same session id: drop the previous token/tunnel first.
  if (live.has(req.sessionId)) await releaseRdp(req.sessionId)
  const inst = findInstance(req.instanceKey)
  const route = decideRoute(inst, req.forceRoute)
  if (route.route === 'unreachable' || route.route === 'not-running') throw new Error(route.reason)
  const remotePort = req.port ?? getSettings().overrides[inst.key]?.rdpPort ?? 3389
  const proxyUrl = await ensureProxy()
  const token = randomBytes(24).toString('base64url')
  const title = `${inst.name} @ ${inst.profile}`
  const entry: Live = { token }
  live.set(req.sessionId, entry)

  let host: string
  let port: number
  if (route.route === 'ssm') {
    const localPort = await freePort()
    const tunnelId = uid('rdp')
    entry.tunnelId = tunnelId
    addTunnel({ id: tunnelId, instanceKey: inst.key, title, kind: 'rdp', localPort, remotePort, status: 'starting', startedAt: Date.now() })
    try {
      entry.ssm = await startPortForward(inst, remotePort, localPort, (line) => updateTunnel(tunnelId, { message: line }))
    } catch (e) {
      updateTunnel(tunnelId, { status: 'error', message: (e as Error).message })
      live.delete(req.sessionId)
      throw e
    }
    addTunnel({ id: tunnelId, instanceKey: inst.key, title, kind: 'rdp', localPort, remotePort, status: 'ready', message: 'embedded RDP', startedAt: Date.now() }, entry.ssm)
    host = '127.0.0.1'
    port = localPort
  } else {
    host = route.host!
    port = remotePort
  }
  registerTarget(token, { host, port })
  return {
    sessionId: req.sessionId,
    token,
    proxyUrl,
    destination: `${host}:${port}`,
    route: route.route,
    title,
    user: req.user || defaultRdpUser(inst)
  }
}

export async function releaseRdp(sessionId: string): Promise<void> {
  const entry = live.get(sessionId)
  if (!entry) return
  live.delete(sessionId)
  unregisterTarget(entry.token)
  if (entry.tunnelId) await closeTunnel(entry.tunnelId)
  else await entry.ssm?.terminate()
}

export async function releaseAllRdp(): Promise<void> {
  await Promise.all(Array.from(live.keys()).map((k) => releaseRdp(k)))
}

export function rdpLastError(sessionId: string): string | undefined {
  const entry = live.get(sessionId)
  return entry ? lastErrorFor(entry.token) : undefined
}

import { createServer } from 'node:net'
import type { PortForwardRequest, Tunnel } from '@shared/types'
import { findInstance } from './aws/inventory'
import { decideRoute } from './connect/route'
import { startPortForward } from './ssm/session'
import { addTunnel, listTunnels, updateTunnel } from './tunnels'
import { freePort, uid } from './util'

/** session-manager-plugin reports a busy port only after the SSM session is already open; check first. */
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.unref()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
}

/** User-requested SSM port forward (databases, web consoles, anything on a private port) shown in the tunnel bar. */
export async function openPortForward(req: PortForwardRequest): Promise<Tunnel> {
  const inst = findInstance(req.instanceKey)
  const route = decideRoute(inst, 'ssm')
  if (route.route !== 'ssm') {
    throw new Error(`Port forwarding runs over SSM Session Manager, and ${inst.name} has no online SSM agent (${route.reason}).`)
  }
  const target = req.remoteHost?.trim() || undefined
  const same = listTunnels().find(
    (t) => t.kind === 'port' && t.instanceKey === inst.key && t.remotePort === req.remotePort && t.remoteHost === target && t.status !== 'closed' && t.status !== 'error'
  )
  if (same && (!req.localPort || req.localPort === same.localPort)) return same
  if (req.localPort && !(await portIsFree(req.localPort))) {
    throw new Error(`localhost:${req.localPort} is already in use. Pick another local port or leave it empty for any free port.`)
  }
  const localPort = req.localPort ?? (await freePort())
  const id = uid('port')
  const title = req.name?.trim() || `${inst.name}${target ? ` → ${target}` : ''}:${req.remotePort}`
  const tunnel: Tunnel = { id, instanceKey: inst.key, title, kind: 'port', localPort, remotePort: req.remotePort, remoteHost: target, status: 'starting', startedAt: Date.now() }
  addTunnel(tunnel)
  try {
    const handle = await startPortForward(inst, req.remotePort, localPort, (line) => updateTunnel(id, { message: line }), target)
    const ready: Tunnel = { ...tunnel, status: 'ready', message: `Forwarding localhost:${localPort} to ${target ?? inst.name}:${req.remotePort}`, startedAt: Date.now() }
    addTunnel(ready, handle)
    return ready
  } catch (e) {
    updateTunnel(id, { status: 'error', message: (e as Error).message })
    throw e
  }
}

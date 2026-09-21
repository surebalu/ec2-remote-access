import type { Tunnel } from '@shared/types'
import { host } from './host'
import type { SsmHandle } from './ssm/session'

const tunnels = new Map<string, { tunnel: Tunnel; handle?: SsmHandle }>()

function broadcast(): void {
  host().broadcast('tunnels:changed', listTunnels())
}

export function listTunnels(): Tunnel[] {
  return Array.from(tunnels.values()).map((t) => t.tunnel)
}

export function addTunnel(tunnel: Tunnel, handle?: SsmHandle): void {
  tunnels.set(tunnel.id, { tunnel, handle })
  handle?.child.on('exit', () => {
    const t = tunnels.get(tunnel.id)
    if (t && t.tunnel.status !== 'closed') {
      t.tunnel.status = 'closed'
      t.tunnel.message = 'session-manager-plugin exited'
      broadcast()
    }
  })
  broadcast()
}

export function updateTunnel(id: string, patch: Partial<Tunnel>): void {
  const t = tunnels.get(id)
  if (!t) return
  Object.assign(t.tunnel, patch)
  broadcast()
}

export async function closeTunnel(id: string): Promise<void> {
  const t = tunnels.get(id)
  if (!t) return
  await t.handle?.terminate()
  tunnels.delete(id)
  broadcast()
}

export async function closeAllTunnels(): Promise<void> {
  await Promise.all(Array.from(tunnels.keys()).map((id) => closeTunnel(id)))
}

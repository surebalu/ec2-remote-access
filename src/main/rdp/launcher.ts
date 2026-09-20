import { app } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RdpOpenRequest, Tunnel } from '@shared/types'
import { findInstance } from '../aws/inventory'
import { decideRoute, defaultRdpUser } from '../connect/route'
import { startPortForward } from '../ssm/session'
import { getSettings } from '../store'
import { addTunnel, updateTunnel } from '../tunnels'
import { freePort, uid } from '../util'

export const WINDOWS_APP = '/Applications/Windows App.app'

export function hasWindowsApp(): boolean {
  return existsSync(WINDOWS_APP) || existsSync('/Applications/Microsoft Remote Desktop.app')
}

function rdpClientName(): string {
  return existsSync(WINDOWS_APP) ? 'Windows App' : 'Microsoft Remote Desktop'
}

function writeRdpFile(id: string, host: string, port: number, user: string, title: string): string {
  const dir = join(app.getPath('userData'), 'rdp')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${id.replace(/[^\w.-]/g, '_')}.rdp`)
  const lines = [
    `full address:s:${host}:${port}`,
    `username:s:${user}`,
    'prompt for credentials:i:1',
    'authentication level:i:0',
    'screen mode id:i:2',
    'use multimon:i:0',
    'smart sizing:i:1',
    'dynamic resolution:i:1',
    'session bpp:i:32',
    'audiomode:i:0',
    'redirectclipboard:i:1',
    'autoreconnection enabled:i:1',
    'networkautodetect:i:1',
    'bandwidthautodetect:i:1',
    'drivestoredirect:s:',
    `alternate shell:s:`,
    `remoteapplicationname:s:${title}`
  ]
  writeFileSync(file, lines.join('\r\n') + '\r\n')
  return file
}

function openWith(appName: string, file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn('open', ['-a', appName, file], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    c.stderr.on('data', (d) => (err += d))
    c.on('error', reject)
    c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `open exited ${code}`))))
  })
}

export async function openRdp(req: RdpOpenRequest): Promise<Tunnel | null> {
  const inst = findInstance(req.instanceKey)
  const route = decideRoute(inst, req.forceRoute)
  if (route.route === 'unreachable' || route.route === 'not-running') throw new Error(route.reason)
  if (!hasWindowsApp()) throw new Error('Windows App is not installed. Install it from the Mac App Store.')
  const s = getSettings()
  const user = req.user || defaultRdpUser(inst)
  const remotePort = req.port ?? s.overrides[inst.key]?.rdpPort ?? 3389
  const title = `${inst.name} @ ${inst.profile}`

  if (route.route === 'direct') {
    const file = writeRdpFile(inst.key, route.host!, remotePort, user, title)
    await openWith(rdpClientName(), file)
    return null
  }

  const localPort = await freePort()
  const tunnel: Tunnel = {
    id: uid('rdp'),
    instanceKey: inst.key,
    title,
    kind: 'rdp',
    localPort,
    remotePort,
    status: 'starting',
    startedAt: Date.now()
  }
  addTunnel(tunnel)
  try {
    const handle = await startPortForward(inst, remotePort, localPort, (line) => updateTunnel(tunnel.id, { message: line }))
    addTunnel({ ...tunnel, status: 'ready', message: `localhost:${localPort} -> ${inst.instanceId}:${remotePort}` }, handle)
    const file = writeRdpFile(inst.key, 'localhost', localPort, user, title)
    await openWith(rdpClientName(), file)
    return { ...tunnel, status: 'ready' }
  } catch (e) {
    updateTunnel(tunnel.id, { status: 'error', message: (e as Error).message })
    throw e
  }
}

/**
 * "Phone access": the gateway (src/gateway/server.ts) hosted inside the desktop app, so a phone on the same
 * Tailscale network or Wi-Fi can open the same UI in its browser while the Mac is running. Settings hold the
 * on/off switch, port and bind mode; the shared token lives in `<userData>/gateway.token` so the standalone
 * gateway and the in-app one accept the same phone.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import type { PhoneAccessStatus, Settings } from '@shared/types'
import { createGatewayServer, type Gateway } from '../gateway/server'
import { host } from './host'
import { ensureProxy } from './rdp/cleanpath'
import { getSettings, setSettings } from './store'
import { serveDisable, serveEnable, tailscaleInfo, type TailscaleInfo } from './tailscale'

let gateway: Gateway | null = null
let bound: { host: string; port: number } | null = null
let clients: PhoneAccessStatus['clients'] = []
let lastError: string | undefined
let ts: TailscaleInfo | null = null
/** Set while `tailscale serve` is publishing our port, so stop() can withdraw it. */
let serving: string | null = null

const tokenFile = (): string => join(host().userDataDir(), 'gateway.token')

export function phoneToken(): string {
  const f = tokenFile()
  if (!existsSync(f)) writeFileSync(f, randomBytes(24).toString('base64url'), { mode: 0o600 })
  return readFileSync(f, 'utf8').trim()
}

/** IPv4 addresses a phone could use: Tailscale (CGNAT 100.64/10) first, then LAN. */
export function reachableAddresses(): { tailscale: string[]; lan: string[] } {
  const tailscale: string[] = []
  const lan: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.internal || i.family !== 'IPv4') continue
      const [a, b] = i.address.split('.').map(Number)
      if (a === 100 && b >= 64 && b <= 127) tailscale.push(i.address)
      else lan.push(i.address)
    }
  }
  return { tailscale, lan }
}

/** Forward an IpcEvents message to connected phones (electronHost.broadcast calls this alongside the windows). */
export function broadcastToPhones(channel: string, payload: unknown): void {
  gateway?.broadcast(channel, payload)
}

export function phoneStatus(): PhoneAccessStatus {
  const s = getSettings()
  const addrs = reachableAddresses()
  const token = phoneToken()
  const urls: string[] = []
  if (bound) {
    if (serving) urls.push(`https://${serving}/#token=${token}`)
    else {
      const hosts = bound.host === '0.0.0.0' ? [...addrs.tailscale, ...addrs.lan] : [bound.host]
      for (const h of hosts) urls.push(`http://${h}:${bound.port}/#token=${token}`)
    }
  }
  return {
    enabled: s.phoneAccessEnabled, running: !!gateway, port: bound?.port ?? s.phoneAccessPort, bind: s.phoneAccessBind,
    tailscaleAvailable: addrs.tailscale.length > 0 || !!ts?.running, tailscaleHostname: ts?.dnsName,
    tailscaleHttps: (ts?.certDomains.length ?? 0) > 0, urls, token, clients, error: lastError
  }
}

/** Refreshes the cached Tailscale view (CLI presence, MagicDNS name, whether HTTPS certs are enabled). */
export async function refreshTailscale(): Promise<void> {
  ts = await tailscaleInfo()
}

export async function startPhoneAccess(): Promise<PhoneAccessStatus> {
  if (gateway) return phoneStatus()
  const s = getSettings()
  const addrs = reachableAddresses()
  await refreshTailscale()
  const https = s.phoneAccessBind === 'https'
  // 'https': loopback only, published by `tailscale serve`. 'tailscale': that interface only. 'all': every interface.
  const bindHost = https ? '127.0.0.1' : s.phoneAccessBind === 'tailscale' && addrs.tailscale.length ? addrs.tailscale[0] : '0.0.0.0'
  // handlers.ts imports this module for the phone:* channels; resolve it lazily to avoid an import cycle.
  const { handlers } = await import('./handlers')
  const gw = createGatewayServer({
    handlers, token: phoneToken(), staticDir: join(__dirname, '../renderer'), rdpTarget: ensureProxy,
    onClientsChanged: (list) => { clients = list; host().broadcast('phone:changed', phoneStatus()) },
    log: (l) => console.log(l)
  })
  try {
    bound = await gw.listen(s.phoneAccessPort, bindHost)
    gateway = gw
    lastError = undefined
  } catch (e) {
    lastError = (e as Error).message
    bound = null
    return phoneStatus()
  }
  if (https) {
    if (!ts?.cli) lastError = 'Tailscale CLI not found. Install Tailscale from tailscale.com/download and sign in.'
    else if (!ts.running || !ts.dnsName) lastError = 'Tailscale is not running or has no MagicDNS name. Open Tailscale, sign in, and enable MagicDNS in the admin console.'
    else if (ts.certDomains.length === 0) lastError = 'HTTPS certificates are not enabled for your tailnet. In the Tailscale admin console open DNS → HTTPS Certificates → Enable HTTPS, then switch this off and on.'
    else {
      try {
        await serveEnable(ts.cli, bound.port)
        serving = ts.dnsName
      } catch (e) {
        lastError = (e as Error).message
      }
    }
    if (lastError) console.warn(`[phone-access] ${lastError}`)
  }
  return phoneStatus()
}

export async function stopPhoneAccess(): Promise<PhoneAccessStatus> {
  const gw = gateway
  gateway = null
  bound = null
  clients = []
  if (serving && ts?.cli) await serveDisable(ts.cli)
  serving = null
  await gw?.close()
  return phoneStatus()
}

/** Applies a settings patch (enabled / port / bind) and restarts the server as needed. */
export async function configurePhoneAccess(patch: Partial<Pick<Settings, 'phoneAccessEnabled' | 'phoneAccessPort' | 'phoneAccessBind'>>): Promise<PhoneAccessStatus> {
  setSettings(patch)
  await stopPhoneAccess()
  if (getSettings().phoneAccessEnabled) return startPhoneAccess()
  return phoneStatus()
}

/** New token; already-paired phones must scan again. */
export async function rotatePhoneToken(): Promise<PhoneAccessStatus> {
  writeFileSync(tokenFile(), randomBytes(24).toString('base64url'), { mode: 0o600 })
  const wasRunning = !!gateway
  await stopPhoneAccess()
  return wasRunning ? startPhoneAccess() : phoneStatus()
}

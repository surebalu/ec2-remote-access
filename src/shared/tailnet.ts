import type { Instance } from './types'

/**
 * Machines on the Tailscale network, as hosts. Screens (Edovia) lists a tailnet through Tailscale's admin API with an
 * OAuth client the user creates (Devices: Read), which leaves out machines shared from other tailnets. This app runs
 * where Tailscale already runs (the Mac, the Pi gateway), so it reads `tailscale status --json` instead: no client
 * secret to create, and shared machines are included.
 */
export const TAILNET_PROFILE = 'tailscale'
/** The hosts-list group they appear under (the `region` of a hand-added server, `group:Tailscale` as a filter). */
export const TAILNET_GROUP = 'Tailscale'

export const tailnetKey = (id: string): string => `tailnet/${id}`
export const isTailnetKey = (key: string): boolean => key.startsWith('tailnet/')

/** What `tailscale status --json` says about one node (only the fields used here). */
export interface TailnetNode {
  ID?: string
  HostName?: string
  DNSName?: string
  OS?: string
  TailscaleIPs?: string[] | null
  Online?: boolean
  LastSeen?: string
  Tags?: string[] | null
  ShareeNode?: boolean
}

export interface TailnetStatusJson {
  BackendState?: string
  Self?: TailnetNode
  Peer?: Record<string, TailnetNode> | null
  CurrentTailnet?: { Name?: string; MagicDNSSuffix?: string } | null
}

export interface TailnetState {
  /** Tailscale is installed where the app's engine runs (the Mac, or the gateway's machine). */
  installed: boolean
  /** Connected to its tailnet. */
  running: boolean
  /** The tailnet's name (the owner's login for a personal tailnet). */
  tailnet?: string
  devices: Instance[]
  error?: string
}

/** Phones, tablets and TVs run no screen-sharing, SSH or RDP server, so there is nothing to open on them. */
const NOT_A_COMPUTER = /^(ios|ipados|android|tvos)$/i

/** Tailscale names iPhones "localhost"; the MagicDNS name ("iphone182") is the better label then. */
export function deviceName(n: TailnetNode): string {
  const dns = (n.DNSName ?? '').split('.')[0]
  const host = (n.HostName ?? '').trim()
  return !host || host === 'localhost' ? dns || host || 'Unnamed' : host
}

export function osLabel(os: string | undefined): string {
  const o = (os ?? '').toLowerCase()
  return o === 'macos' ? 'macOS' : o === 'windows' ? 'Windows' : o === 'linux' ? 'Linux' : o === 'freebsd' ? 'FreeBSD' : os || 'Unknown'
}

/** Presents a tailnet machine as an Instance, like a hand-added server: routed directly to its Tailscale address. */
export function nodeToInstance(n: TailnetNode, self: boolean): Instance | null {
  if (!n.ID || NOT_A_COMPUTER.test(n.OS ?? '')) return null
  const ipv4 = (n.TailscaleIPs ?? []).find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip))
  const address = ipv4 ?? n.TailscaleIPs?.[0]
  if (!address) return null
  const dnsName = (n.DNSName ?? '').replace(/\.$/, '')
  const os = osLabel(n.OS)
  const online = self || n.Online === true
  const tags: Record<string, string> = { OS: os, Tailscale: dnsName || address }
  if (n.Tags?.length) tags.Tags = n.Tags.join(', ')
  if (self) tags.Note = 'This computer'
  if (n.ShareeNode) tags.Shared = 'Shared from another tailnet'
  return {
    key: tailnetKey(n.ID),
    profile: TAILNET_PROFILE,
    region: TAILNET_GROUP,
    instanceId: dnsName || address,
    name: deviceName(n),
    platform: os === 'Windows' ? 'windows' : 'linux',
    platformDetails: os,
    osHint: os,
    state: online ? 'running' : 'stopped',
    instanceType: '',
    publicIp: address,
    publicDns: dnsName || undefined,
    ssmOnline: false,
    tags,
    manual: true,
    tailnet: { os, online, self: self || undefined, dnsName: dnsName || undefined, lastSeen: online || !n.LastSeen || n.LastSeen.startsWith('0001-') ? undefined : n.LastSeen }
  }
}

/** Reads `tailscale status --json` into hosts: computers only, this one first, then online ones, then by name. */
export function parseTailnetStatus(json: TailnetStatusJson): TailnetState {
  const running = json.BackendState === 'Running'
  const devices: Instance[] = []
  if (running) {
    const self = json.Self ? nodeToInstance(json.Self, true) : null
    if (self) devices.push(self)
    for (const n of Object.values(json.Peer ?? {})) {
      const d = nodeToInstance(n, false)
      if (d) devices.push(d)
    }
  }
  devices.sort((a, b) => Number(!!b.tailnet?.self) - Number(!!a.tailnet?.self) || Number(!!b.tailnet?.online) - Number(!!a.tailnet?.online) || a.name.localeCompare(b.name))
  return { installed: true, running, tailnet: json.CurrentTailnet?.Name || undefined, devices }
}

/** What opening a tailnet machine means: its screen for a Mac, Remote Desktop for Windows, a terminal otherwise. */
export function defaultSessionFor(i: Pick<Instance, 'platform' | 'tailnet'>): 'vnc' | 'rdp' | 'ssh' {
  if (i.tailnet?.os === 'macOS') return 'vnc'
  return i.platform === 'windows' ? 'rdp' : 'ssh'
}

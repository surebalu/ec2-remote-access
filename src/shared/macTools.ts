/**
 * The launcher's Mac tools beyond search, as Raycast has them: Kill Process, My IP, Speed Test, Downloads, Quit All
 * Apps. Main (main/macTools.ts) runs macOS's own programs; the parsing and wording are here, pure, for
 * tests/macTools.test.ts.
 */

export interface ProcessInfo {
  pid: number
  ppid: number
  user: string
  /** Per cent of one core, as Activity Monitor shows it. */
  cpu: number
  /** Resident memory in bytes. */
  memory: number
  /** The program's name (an app's name for its main process). */
  name: string
  /** The executable's path. */
  command: string
  /** The .app it belongs to, for its icon. */
  app?: string
}

/** `ps -axo pid=,ppid=,user=,%cpu=,rss=,comm=`: comm is the executable's full path, and may contain spaces. */
export function parseProcesses(text: string): ProcessInfo[] {
  const out: ProcessInfo[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line)
    if (!m) continue
    const command = m[6].trim()
    const app = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(command)?.[1]
    const base = command.split('/').pop() ?? command
    out.push({
      pid: Number(m[1]), ppid: Number(m[2]), user: m[3], cpu: Number(m[4]), memory: Number(m[5]) * 1024, command,
      name: app ? app.split('/').pop()!.replace(/\.app$/i, '') : base,
      ...(app ? { app } : {})
    })
  }
  return out
}

/** Busiest first, then the largest; the user's own processes before the system's at equal use. */
export function sortProcesses(list: ProcessInfo[], user: string): ProcessInfo[] {
  return [...list].sort((a, b) => b.cpu - a.cpu || b.memory - a.memory || Number(b.user === user) - Number(a.user === user) || a.name.localeCompare(b.name))
}

export interface SpeedResult {
  /** Bits per second. */
  download: number
  upload: number
  /** Round trips per minute under load (Apple's "responsiveness"), and the idle round trip in milliseconds. */
  rpm: number
  idleMs: number
  interface: string
  server: string
}

/** `networkQuality -c`'s JSON (macOS 12 and later; the field names have stayed the same). */
export function parseSpeedTest(text: string): SpeedResult | null {
  let j: Record<string, unknown>
  try { j = JSON.parse(text) as Record<string, unknown> } catch { return null }
  const n = (k: string): number => (typeof j[k] === 'number' ? (j[k] as number) : Number(j[k]) || 0)
  if (!('dl_throughput' in j) && !('ul_throughput' in j)) return null
  return {
    download: n('dl_throughput'), upload: n('ul_throughput'), rpm: Math.round(n('responsiveness')), idleMs: Math.round(n('base_rtt')),
    interface: String(j.interface_name ?? ''), server: String(j.test_endpoint ?? '')
  }
}

/** 412 Mbps, 1.2 Gbps, 850 kbps. */
export function formatBits(bps: number): string {
  if (!bps) return '0 Mbps'
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(2)} Gbps`
  if (bps >= 1e6) return `${bps >= 1e8 ? Math.round(bps / 1e6) : (bps / 1e6).toFixed(1)} Mbps`
  return `${Math.round(bps / 1e3)} kbps`
}

/** Apple's own words for responsiveness (System Settings → Network's Wi-Fi details use the same bands). */
export function rpmWord(rpm: number): string {
  return rpm >= 1000 ? 'High' : rpm >= 300 ? 'Medium' : 'Low'
}

export interface AddressRow {
  /** What it is: "Public IPv4", "Wi-Fi (en0)", "Tailscale", "Router". */
  label: string
  address: string
  note?: string
}

export interface NetworkInfo {
  addresses: AddressRow[]
  /** Set when the public address could not be read (offline, or the lookup timed out). */
  publicError?: string
}

/** A Mac interface's name in words. */
export function interfaceLabel(name: string, address: string, wifi: string | null): string {
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) return 'Tailscale'
  if (name === wifi) return `Wi-Fi (${name})`
  if (/^en\d+$/.test(name)) return `Ethernet (${name})`
  if (/^utun\d+$/.test(name)) return `VPN (${name})`
  if (/^bridge\d+$/.test(name)) return `Bridge (${name})`
  return name
}

export interface DownloadItem {
  name: string
  path: string
  size: number
  dir: boolean
  /** When it arrived in Downloads (Spotlight's date added), else its creation time. */
  added: number
}

/** Partial downloads and hidden files are not offered. */
export const isFinishedDownload = (name: string): boolean => !name.startsWith('.') && !/\.(download|crdownload|part|partial)$/i.test(name) && name !== 'Icon\r'

export interface QuitAllPlan {
  apps: { pid: number; name: string }[]
  /** Kept open: this app, Finder, and those that would take the Mac's tools with them. */
  kept: string[]
}

/** The apps Quit All Apps leaves open (by bundle id). */
const KEEP = new Set(['com.apple.finder', 'com.mainspring.ec2-remote-access', 'com.github.Electron', 'com.apple.loginwindow'])

export function quitAllPlan(running: { id: string; name: string; pid: number; type: string }[], keep: string[] = []): QuitAllPlan {
  const extra = new Set(keep)
  const apps: QuitAllPlan['apps'] = []
  const kept: string[] = []
  for (const a of running) {
    if (a.type !== 'Foreground' || !a.pid) continue
    if (KEEP.has(a.id) || extra.has(a.id) || extra.has(a.name)) kept.push(a.name)
    else apps.push({ pid: a.pid, name: a.name })
  }
  return { apps: apps.sort((a, b) => a.name.localeCompare(b.name)), kept }
}

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
  /** Apple's word for the responsiveness (High, Medium, Low) and the round trip under load, in milliseconds. */
  rating?: string
  workingMs?: number
  /** Who carries the connection and where (ipinfo.io), this Mac's public and local addresses. */
  isp?: string
  location?: string
  externalIp?: string
  internalIp?: string
}

/** One progress reading while the test runs, in megabits a second. */
export interface SpeedSample { t: number; down: number; up: number; rpm: number }

/** A speed test as the launcher shows it: the readings so far, then the result (or why there is none). */
export interface SpeedRun {
  id: string
  started: number
  ended?: number
  samples: SpeedSample[]
  result?: SpeedResult
  error?: string
  /** False when no terminal could be made for networkQuality: no readings until it ends. */
  live: boolean
}

const PROGRESS = /Downlink: ([\d.]+) Mbps, (\d+) RPM - Uplink: ([\d.]+) Mbps, (\d+) RPM/g

/**
 * networkQuality's live line, which it writes only to a terminal, again and again over itself:
 * "Downlink: 565.641 Mbps, 0 RPM - Uplink: 73.016 Mbps, 0 RPM".
 */
export function parseSpeedProgress(text: string): { down: number; up: number; rpm: number }[] {
  return [...text.matchAll(PROGRESS)].map((m) => ({ down: Number(m[1]), up: Number(m[3]), rpm: Number(m[2]) }))
}

/** "342.614 Mbps", "1.098 Gbps", "850.2 Kbps" in bits a second. */
export function capacityBps(text: string): number {
  const m = /([\d.]+)\s*([KMG])bps/i.exec(text)
  if (!m) return 0
  return Math.round(Number(m[1]) * ({ K: 1e3, M: 1e6, G: 1e9 } as Record<string, number>)[m[2].toUpperCase()])
}

/** The summary networkQuality ends with (and, with -v, its endpoint and interface). */
export function parseSpeedSummary(text: string): SpeedResult | null {
  const plain = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '\n')
  const line = (label: string): string => new RegExp(`^\\s*${label}:\\s*(.+)$`, 'm').exec(plain)?.[1].trim() ?? ''
  const summary = plain.slice(Math.max(0, plain.lastIndexOf('==== SUMMARY ====')))
  const sline = (label: string): string => new RegExp(`^\\s*${label}:\\s*(.+)$`, 'm').exec(summary)?.[1].trim() ?? ''
  const down = sline('Downlink capacity')
  const up = sline('Uplink capacity')
  if (!down && !up) return null
  const resp = /^(\w+)\s*\(([\d.]+) milliseconds \| (\d+) RPM\)/.exec(sline('Responsiveness'))
  const idle = /([\d.]+) milliseconds/.exec(sline('Idle Latency'))
  return {
    download: capacityBps(down), upload: capacityBps(up), rpm: resp ? Number(resp[3]) : 0, idleMs: idle ? Math.round(Number(idle[1]) * 10) / 10 : 0,
    rating: resp?.[1] ?? '', workingMs: resp ? Math.round(Number(resp[2]) * 10) / 10 : undefined,
    interface: line('Interface'), server: line('Test Endpoint')
  }
}

/** The gauge's marks, as Raycast's: equal steps on the dial, each ten or five times the last. */
export const GAUGE_TICKS = [0, 1, 5, 10, 50, 100, 500, 1000]

/** Where on the dial (0…1) a speed in megabits a second goes: straight between two marks, the end beyond 1000. */
export function gaugeFraction(mbps: number): number {
  if (!(mbps > 0)) return 0
  const t = GAUGE_TICKS
  for (let i = 1; i < t.length; i++) {
    if (mbps <= t[i]) return (i - 1 + (mbps - t[i - 1]) / (t[i] - t[i - 1])) / (t.length - 1)
  }
  return 1
}

/** What the connection is good for, as Raycast lists it: the levels each needs, down and up, in megabits a second. */
export const SPEED_NEEDS = {
  voice: [{ label: 'SD', down: 0.1, up: 0.1 }, { label: 'HD', down: 0.5, up: 0.5 }],
  video: [{ label: '480', down: 1, up: 1 }, { label: '720', down: 2.6, up: 1.8 }, { label: '1080', down: 3.8, up: 3 }, { label: '4K', down: 15, up: 12 }],
  streaming: [{ label: '480', down: 3, up: 0 }, { label: '720', down: 5, up: 0 }, { label: '1080', down: 8, up: 0 }, { label: '4K', down: 25, up: 0 }]
} as const

export function speedCapabilities(downBps: number, upBps: number): Record<keyof typeof SPEED_NEEDS, { label: string; ok: boolean }[]> {
  const d = downBps / 1e6
  const u = upBps / 1e6
  const check = (list: readonly { label: string; down: number; up: number }[]): { label: string; ok: boolean }[] => list.map((x) => ({ label: x.label, ok: d >= x.down && u >= x.up }))
  return { voice: check(SPEED_NEEDS.voice), video: check(SPEED_NEEDS.video), streaming: check(SPEED_NEEDS.streaming) }
}

/** "AS5650 Frontier Communications of America, Inc." → "Frontier Communications of America". */
export const ispName = (org: string): string => org.replace(/^AS\d+\s+/, '').replace(/,?\s+(Inc|LLC|Ltd|Corp|Corporation|Co)\.?$/i, '').trim()

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

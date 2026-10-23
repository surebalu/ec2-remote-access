/**
 * The Storage tool's Apps and Monitor rooms (Unused Apps, Uninstaller, Leftovers, Startup Items, Monitor, Optimize):
 * pure rules and parsers for what main/storage/macApps.ts and monitor.ts read from macOS (mdls, lsappinfo, ps,
 * vm_stat, netstat, ioreg, launchd plists). Nothing here touches the Mac, so tests/macApps.test.ts covers it.
 */

export interface MacApp {
  path: string
  name: string
  id: string
  version: string
  size: number
  /** When Spotlight last saw it opened (ms), or 0 when it has no record. */
  lastUsed: number
  /** Built only for Intel Macs, so it runs through Rosetta. */
  intelOnly: boolean
  running: boolean
  /** It carries a system extension, which macOS removes only when Finder moves the app to the Trash. */
  systemExtension: boolean
  /** Only an administrator can move it (installed by a package as root). */
  admin: boolean
  apple: boolean
}

/** The values `mdls -raw -nullMarker ''` printed for several names and files, in order (separated by NUL). */
export function splitMdls(text: string, names: number, files: number): string[][] {
  const vals = text.split('\0')
  const out: string[][] = []
  for (let f = 0; f < files; f++) out.push(vals.slice(f * names, f * names + names).map((v) => v.trim()))
  return out
}

/** An mdls list value, '(\n    arm64,\n    x86_64\n)', as its items. */
export const mdlsList = (v: string): string[] => v.replace(/^\(|\)$/g, '').split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean)

/** An mdls date, '2026-10-21 14:03:11 +0000', in ms (0 for none). */
export function mdlsDate(v: string): number {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{4})$/.exec(v.trim())
  if (!m) return 0
  const t = Date.parse(`${m[1]}T${m[2]}${m[3].slice(0, 3)}:${m[3].slice(3)}`)
  return Number.isFinite(t) ? t : 0
}

/** Only Intel code: x86_64 and nothing for Apple silicon. */
export const isIntelOnly = (archs: string[]): boolean => archs.length > 0 && archs.every((a) => /x86_64|i386/.test(a))

/** How sure the app is that a Library item belongs to an app. */
export type Confidence = 'sure' | 'likely' | 'maybe'

/** The name a Library entry goes by, without the suffix its kind of folder adds (com.x.y.plist → com.x.y). */
export const entryKey = (name: string): string => name.replace(/\.(plist|savedState|binarycookies|sfl\d?|db|lock)$/i, '')

/**
 * Whether a Library entry belongs to an app, and how sure that is: named for its bundle id (or a part of it, or a
 * group container ending in it) is sure; named for the app itself is likely; only the same vendor prefix is a maybe,
 * never ticked.
 */
export function belongsTo(entry: string, app: { id: string; name: string }): Confidence | null {
  const e = entryKey(entry).toLowerCase()
  const id = app.id.toLowerCase()
  const name = app.name.replace(/\.app$/i, '').toLowerCase()
  if (id && (e === id || e.startsWith(`${id}.`) || e.endsWith(`.${id}`) || e === `group.${id}`)) return 'sure'
  if (name.length > 2 && (e === name || e === name.replace(/\s+/g, '') || e === name.replace(/\s+/g, '-'))) return 'likely'
  const vendor = id.split('.').slice(0, 2).join('.')
  if (id.split('.').length > 2 && vendor.length > 5 && e.startsWith(`${vendor}.`) && !vendor.startsWith('com.apple')) return 'maybe'
  return null
}

/** Top-level domains bundle ids start with: a name like warp.log.old.0 is a file, not an app's identifier. */
const TLDS = new Set('com org net io dev app co ai me us uk de fr jp cn ru info biz xyz tv cc ch nl se no fi dk eu ca au in br es it pl pt kr tw hk sg nz be at cz il za mx ar gov edu pro tech so to gg ly sh is im fm am li lu md nu pw sc st vc ws design tools works pub bot cloud studio games software network digital space site online fun one inc ltd llc global mobi page'.split(' '))

/** Identifiers of command-line tools and libraries, which leave caches no app accounts for. */
const TOOL_PREFIXES = ['org.swift.', 'org.llvm.', 'org.python.', 'org.nodejs.', 'org.rust-lang.', 'org.golang.', 'com.github.git', 'org.git-scm.', 'org.gnu.', 'org.homebrew.', 'sh.brew.']

/**
 * Whether a Library entry is left over from an app that is gone: a reverse-DNS name no installed app, package,
 * helper or library inside an app accounts for. Sure when nothing from its vendor is installed; a maybe when the vendor
 * has other apps here (they may share it). Apple's and command-line tools' are never leftovers, and names that are not
 * bundle ids are never guessed at. `embedded` holds the lower-cased names of the frameworks and helpers inside installed
 * apps: a cache named com.bugsnag.Bugsnag belongs to whichever app carries Bugsnag.framework.
 */
export function leftoverOf(entry: string, installed: string[], embedded: Set<string> = new Set()): { verdict: Confidence; id: string } | 'owned' | null {
  let key = entryKey(entry)
  // Group containers: TEAMID.com.vendor.app, group.com.vendor.app.
  key = key.replace(/^[A-Z0-9]{10}\./, '').replace(/^groups?\./, '')
  if (!/^[a-z][a-z0-9-]*(\.[A-Za-z0-9_-]+){2,}$/i.test(key)) return null
  const k = key.toLowerCase()
  if (!TLDS.has(k.split('.')[0])) return null
  if (k.startsWith('com.apple.') || k.startsWith('apple.') || TOOL_PREFIXES.some((p) => k.startsWith(p))) return null
  for (const raw of installed) {
    const id = raw.toLowerCase()
    if (k === id || k.startsWith(`${id}.`) || id.startsWith(`${k}.`)) return 'owned'
  }
  if (k.split('.').slice(1).some((part) => embedded.has(part))) return 'owned'
  const vendor = k.split('.').slice(0, 2).join('.')
  const sameVendor = installed.some((i) => i.toLowerCase().startsWith(`${vendor}.`))
  return { verdict: sameVendor ? 'maybe' : 'sure', id: key }
}

const GENERIC = new Set(['app', 'apps', 'mac', 'macos', 'osx', 'desktop', 'client', 'helper', 'agent', 'launcher', 'updater', 'direct', 'setapp', 'default', 'main', 'gui', 'pro', 'lite'])

/** A guessed app name from a bundle id: com.vendor.SomeApp → SomeApp; com.vendor.app.2 → vendor. */
export function nameFromId(id: string): string {
  const parts = id.split('.')
  const pick = parts.slice(2).find((p) => !/^\d+$/.test(p) && !GENERIC.has(p.toLowerCase())) ?? parts[1] ?? id
  return pick.replace(/[-_]/g, ' ')
}

/** The Library folders an app keeps its things in, what each holds, and whether it is safe to clear (ticked). */
export const LIBRARY_PLACES: { dir: string; tick: boolean; note: string }[] = [
  { dir: 'Caches', tick: true, note: 'Caches are rebuilt whenever an app needs them.' },
  { dir: 'Logs', tick: true, note: 'Logs are diagnostic records, not documents.' },
  { dir: 'Preferences', tick: true, note: 'A preferences file holds settings, not documents.' },
  { dir: 'Preferences/ByHost', tick: true, note: 'Settings for this Mac alone.' },
  { dir: 'Saved Application State', tick: true, note: 'Saved state only reopens an app\'s windows where they were.' },
  { dir: 'HTTPStorages', tick: true, note: 'Cookies and web storage only keep sign-ins and site data.' },
  { dir: 'Cookies', tick: true, note: 'Cookies only keep sign-ins and site data.' },
  { dir: 'LaunchAgents', tick: true, note: 'Starts a helper when you log in. Removed, it stops at your next login.' },
  { dir: 'Application Support', tick: false, note: 'Application Support can hold documents, libraries and settings someone made, so it is never ticked for you.' },
  { dir: 'Containers', tick: false, note: 'A container holds everything a sandboxed app saved, documents included, so it is never ticked for you.' },
  { dir: 'Group Containers', tick: false, note: 'A group container holds what an app shares with its extensions and sister apps, documents included, so it is never ticked for you.' },
  { dir: 'WebKit', tick: false, note: 'WebKit data can hold what an app saved inside its web views, so it is never ticked for you.' },
  { dir: 'Application Scripts', tick: false, note: 'Scripts someone added for the app, so it is never ticked for you.' }
]

/** The system-wide folders (only an administrator can change them) where installers put an app's helpers. */
export const SYSTEM_PLACES = ['/Library/Application Support', '/Library/Caches', '/Library/Preferences', '/Library/LaunchAgents', '/Library/LaunchDaemons', '/Library/PrivilegedHelperTools', '/Library/Logs']

// ----- Startup items -----

export type LaunchScope = 'user-agent' | 'agent' | 'daemon' | 'helper'

export interface LaunchItem {
  path: string
  label: string
  scope: LaunchScope
  /** The program it starts (ProgramArguments[0] or Program). */
  program: string
  /** What it runs is no longer there, so launchd has nothing to start. */
  missing: boolean
  apple: boolean
  /** The app or vendor it belongs to, or why it belongs to none. */
  owner: string
  /** Running now (user agents only: launchctl list). */
  loaded?: boolean
  runAtLoad: boolean
  keepAlive: boolean
}

/** The program a launchd plist starts. */
export function launchProgram(plist: Record<string, unknown>): string {
  const args = plist.ProgramArguments
  if (Array.isArray(args) && typeof args[0] === 'string') return args[0]
  return typeof plist.Program === 'string' ? plist.Program : ''
}

/** The app a program lives in (/Applications/Foo.app/Contents/… → Foo), or ''. */
export const appOfProgram = (program: string): string => /\/([^/]+)\.app\//.exec(program)?.[1] ?? ''

/**
 * Who a startup item belongs to: the app its program lives in, else the one installed app whose bundle id its label
 * starts with, else the vendor's apps (a suite shares its helpers), else nobody.
 */
export function startupOwner(label: string, program: string, apps: { id: string; name: string }[]): string {
  const inApp = appOfProgram(program)
  if (inApp) return inApp
  const l = label.toLowerCase()
  const exact = apps.find((a) => a.id && (l === a.id.toLowerCase() || l.startsWith(`${a.id.toLowerCase()}.`)))
  if (exact) return exact.name
  const vendor = l.split('.').slice(0, 2).join('.')
  const family = apps.filter((a) => a.id.toLowerCase().startsWith(`${vendor}.`))
  if (family.length === 1) return family[0].name
  if (family.length > 1) return `${family.length} apps from ${vendor.split('.')[1]}`
  return ''
}

/** `systemextensionsctl list`: '*\t*\tTEAMID\tcom.x.driver (1.0/1)\tName\t[activated enabled]' rows. */
export function parseSystemExtensions(text: string): { id: string; name: string; state: string }[] {
  const out: { id: string; name: string; state: string }[] = []
  for (const line of text.split('\n')) {
    const m = /\t([A-Z0-9]{10}|-)\t(\S+) \([^)]*\)\t([^\t]*)\t\[([^\]]+)\]/.exec(line)
    if (m) out.push({ id: m[2], name: m[3].trim() || m[2], state: m[4] })
  }
  return out
}

// ----- Monitor -----

export interface MemoryInfo { total: number; used: number; app: number; wired: number; compressed: number; cached: number; free: number; swap: number; pressure: 'normal' | 'warn' | 'critical' }

/** vm_stat's page counts ('Pages free: 12345.') by name. */
export function parseVmStat(text: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of text.split('\n')) {
    const m = /^"?([^":]+)"?:\s+(\d+)\.?$/.exec(line.trim())
    if (m) out[m[1].trim()] = Number(m[2])
  }
  return out
}

/** Memory as Activity Monitor splits it, from vm_stat pages. */
export function memoryFrom(vm: Record<string, number>, pageSize: number, total: number, swapUsed: number, pressureLevel: number): MemoryInfo {
  const p = (k: string): number => (vm[k] ?? 0) * pageSize
  const wired = p('Pages wired down')
  const compressed = p('Pages occupied by compressor')
  const app = Math.max(0, p('Anonymous pages') - p('Pages purgeable'))
  const cached = p('File-backed pages') + p('Pages purgeable')
  const used = Math.min(total, app + wired + compressed)
  return { total, used, app, wired, compressed, cached, free: Math.max(0, total - used), swap: swapUsed, pressure: pressureLevel >= 4 ? 'critical' : pressureLevel >= 2 ? 'warn' : 'normal' }
}

/** `sysctl vm.swapusage`: 'total = 2048.00M  used = 1024.50M  free = …' → bytes used. */
export function parseSwap(text: string): number {
  const m = /used = ([\d.]+)([KMG])/.exec(text)
  if (!m) return 0
  return Number(m[1]) * (m[2] === 'G' ? 1024 ** 3 : m[2] === 'M' ? 1024 ** 2 : 1024)
}

/** Bytes in and out over the network (netstat -ibn): Ethernet and Wi-Fi only, since a VPN's tunnel carries the same bytes again. */
export function parseNetstat(text: string): { rx: number; tx: number } {
  const seen = new Set<string>()
  let rx = 0
  let tx = 0
  const lines = text.split('\n')
  const head = lines[0]?.trim().split(/\s+/) ?? []
  const ib = head.indexOf('Ibytes')
  const ob = head.indexOf('Obytes')
  if (ib < 0 || ob < 0) return { rx, tx }
  for (const line of lines.slice(1)) {
    const cols = line.trim().split(/\s+/)
    const name = cols[0]
    if (!name || seen.has(name) || !/^en\d/.test(name) || !cols[2]?.startsWith('<Link')) continue
    seen.add(name)
    // A row without an address column has one column fewer before the counters.
    const shift = cols.length === head.length ? 0 : cols.length - head.length
    rx += Number(cols[ib + shift]) || 0
    tx += Number(cols[ob + shift]) || 0
  }
  return { rx, tx }
}

/** Bytes read and written by the disks since start-up, from ioreg's IOBlockStorageDriver statistics. */
export function parseDiskIo(text: string): { read: number; write: number } {
  let read = 0
  let write = 0
  for (const m of text.matchAll(/"Bytes \(Read\)"=(\d+)/g)) read += Number(m[1])
  for (const m of text.matchAll(/"Bytes \(Write\)"=(\d+)/g)) write += Number(m[1])
  return { read, write }
}

export interface BatteryInfo {
  percent: number
  charging: boolean
  plugged: boolean
  /** Minutes to empty or to full, when macOS has worked it out. */
  minutes: number | null
  cycles: number | null
  /** Its full charge now as a share of when new. */
  health: number | null
  temperature: number | null
}

/** The battery from `ioreg -rn AppleSmartBattery` (null for a Mac without one). */
export function parseBattery(text: string): BatteryInfo | null {
  if (!/BatteryInstalled"\s*=\s*Yes/.test(text)) return null
  const num = (k: string): number | null => { const m = new RegExp(`"${k}"\\s*=\\s*(-?\\d+)`).exec(text); return m ? Number(m[1]) : null }
  const yes = (k: string): boolean => new RegExp(`"${k}"\\s*=\\s*Yes`).test(text)
  const cur = num('CurrentCapacity')
  const max = num('MaxCapacity')
  const rawMax = num('AppleRawMaxCapacity')
  const design = num('DesignCapacity')
  // Plugged in but not charging, macOS reports a time that means nothing.
  const minutes = yes('IsCharging') ? num('AvgTimeToFull') : yes('ExternalConnected') ? null : num('AvgTimeToEmpty')
  const temp = num('Temperature')
  return {
    percent: cur !== null && max ? Math.round((cur / (max > 100 ? max : 100)) * 100) : 0,
    charging: yes('IsCharging'),
    plugged: yes('ExternalConnected'),
    minutes: minutes !== null && minutes > 0 && minutes < 6000 ? minutes : null,
    cycles: num('CycleCount'),
    health: rawMax && design ? Math.round((rawMax / design) * 100) : null,
    // Hundredths of a degree Celsius.
    temperature: temp !== null ? Math.round(temp / 100) : null
  }
}

export interface ProcessRow { pid: number; ppid: number; cpu: number; rss: number; command: string }

/** `ps -axo pid=,ppid=,%cpu=,rss=,comm=`: one row a process (rss in KB). */
export function parsePs(text: string): ProcessRow[] {
  const out: ProcessRow[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line)
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), cpu: Number(m[3]), rss: Number(m[4]) * 1024, command: m[5].trim() })
  }
  return out
}

export interface AppUsage { name: string; path: string; cpu: number; memory: number; pids: number[]; system: boolean }

/**
 * Processes added up by the app they belong to, as Activity Monitor does: everything inside Foo.app (its helpers and
 * renderers too) counts for Foo; anything else is its own name. macOS's own (under /System or /usr) is marked.
 */
export function groupByApp(rows: ProcessRow[]): AppUsage[] {
  const by = new Map<string, AppUsage>()
  for (const r of rows) {
    const app = /^(.*?\/([^/]+)\.app)\//.exec(r.command)
    const key = app ? app[1] : r.command
    const name = app ? app[2] : r.command.split('/').pop() ?? r.command
    const system = /^\/(System|usr|sbin|bin|Library\/Apple)\//.test(r.command) || r.command.startsWith('/System/')
    const u = by.get(key) ?? { name, path: app ? app[1] : r.command, cpu: 0, memory: 0, pids: [], system }
    u.cpu += r.cpu
    u.memory += r.rss
    u.pids.push(r.pid)
    by.set(key, u)
  }
  return [...by.values()]
}

export interface MonitorSample {
  at: number
  /** Processor use, all cores together and each one (0–100). */
  cpu: number
  cores: number[]
  load: [number, number, number]
  memory: MemoryInfo
  /** Bytes a second since the last sample. */
  net: { rx: number; tx: number }
  disk: { read: number; write: number }
  battery: BatteryInfo | null
  uptime: number
  /** The open apps working hardest and holding the most memory. */
  apps: AppUsage[]
  address: string | null
  thermal: 'normal' | 'warm'
}

export interface OpenApp {
  name: string
  id: string
  path: string
  pid: number
  memory: number
  cpu: number
  /** When it was last in front, as far as the app has seen since it started watching (ms), or null. */
  lastFront: number | null
  front: boolean
  /** Doing something now: using the processor. */
  busy: boolean
  /** Keeps you notified or works in the background (Mail, Slack, music). */
  keep: boolean
  /** Not in front for half an hour and doing nothing: ticked to quit. */
  idle: boolean
}

/** Apps that keep you notified or work while you are elsewhere: never ticked for quitting. */
export const KEEP_OPEN = new Set(['com.apple.mail', 'com.apple.MobileSMS', 'com.apple.iCal', 'com.apple.reminders', 'com.tinyspeck.slackmacgap', 'com.microsoft.teams2', 'com.microsoft.teams', 'com.microsoft.Outlook', 'us.zoom.xos', 'com.apple.Music', 'com.spotify.client', 'com.apple.FaceTime', 'com.hnc.Discord', 'net.whatsapp.WhatsApp', 'ru.keepcoder.Telegram', 'com.apple.finder', 'com.1password.1password', 'com.agilebits.onepassword7'])

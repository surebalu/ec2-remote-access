/**
 * The Health tab: the 3DEXPERIENCE platform's health per environment, read from the Prometheus server that monitors it
 * (node, JMX, Apache and Windows exporters plus blackbox probes) and from CloudWatch (the Oracle database on RDS and the
 * load balancers). This module is the pure part: which environment and service a series belongs to, the thresholds,
 * and how findings roll up into one verdict. main/plmHealth.ts gathers the data; tests/plmHealth.test.ts covers this.
 */

export type PlmEnvId = 'prod' | 'qa' | 'dev'
/** ok, warn and crit as usual; off is a server stopped in EC2 (shown, never counted as a failure). */
export type Level = 'ok' | 'warn' | 'crit' | 'off' | 'unknown'

export const ENV_NAMES: Record<PlmEnvId, string> = { prod: 'Production', qa: 'QA', dev: 'Development' }
export const ENV_ORDER: PlmEnvId[] = ['prod', 'qa', 'dev']

/** A metric over time, oldest first, one point per step; null where there was no sample. */
export type Spark = (number | null)[]

export interface Endpoint {
  url: string
  level: Level
  /** HTTP status of the last probe (0 = no answer). */
  status: number | null
  ms: number | null
  /** Response time over the last hour, ms. */
  spark?: Spark
}

export interface ServiceNode extends Endpoint {
  /** "01", "02", "Primary"… or the host's address. */
  label: string
  ip: string | null
  name: string
  stopped: boolean
  instanceKey?: string
}

/** One health-check URL as the monitoring server probes it (blackbox exporter), for the checks table. */
export interface HealthCheck {
  serviceId: string
  service: string
  url: string
  /** Through the load balancer (what users reach) or on one server. */
  via: 'lb' | 'server'
  label: string
  level: Level
  status: number | null
  ms: number | null
  dnsMs: number | null
  certDays: number | null
  stopped: boolean
  /** Less than a health endpoint (checkNote). */
  note: string | null
  /** The probe itself failed: the blackbox exporter is down, or refused the check. */
  broken?: string
}

export interface ServiceHealth {
  id: string
  name: string
  blurb: string
  level: Level
  summary: string
  /** What users reach: the load balancer's checks. */
  fronts: Endpoint[]
  nodes: ServiceNode[]
}

export interface HostHealth {
  ip: string
  name: string
  role: string
  label: string
  level: Level
  problems: string[]
  state: 'running' | 'stopped' | 'unknown'
  reporting: boolean
  os: 'linux' | 'windows'
  cpu: number | null
  mem: number | null
  memBytes: number | null
  /** The fullest of the machine's own disks (fullestDisk). */
  disk: { mount: string; pct: number } | null
  /** Network stores it mounts (NFS, SMB): judged once under Storage, never against the machine. */
  sharedStores?: { mount: string; pct: number; level: Level }[]
  load: number | null
  cores: number | null
  uptimeSec: number | null
  cpuSpark?: Spark
  instanceKey?: string
  instanceType?: string
}

export interface JvmHealth {
  label: string
  ip: string | null
  name: string
  /** Prometheus's instance label, for the GC detail (health:gc). */
  promInstance: string
  level: Level
  problems: string[]
  reporting: boolean
  heapUsed: number | null
  heapMax: number | null
  heapPct: number | null
  /** What the last collections left in the heap: the floor that keeps rising when memory leaks. */
  afterGcBytes: number | null
  afterGcPct: number | null
  /** The after-GC floor over the last day, judged (gcTrend). */
  trend?: GcTrend
  startedAt: number | null
  gcPct: number | null
  threads: number | null
  fdsPct: number | null
  cpu: number | null
  uptimeSec: number | null
  heapSpark?: Spark
  instanceKey?: string
}

/** One 3DSpace server's ENOVIA kernel, read live from its MBeans through Jolokia (health:kernel). */
export interface KernelServer {
  ip: string
  label: string
  name: string
  reachable: boolean
  error?: string
  /** Signed-in people; the kernel's own sessions and service accounts are listed apart. */
  people: string[]
  service: string[]
  system: string[]
  /** What the kernel reports as active users (its own sessions included). */
  reported: number | null
  /** The C++ kernel's own memory (mcs:00=memory,name=kernel): in use, held, and the peak since it started. */
  allocatedBytes: number | null
  reservedBytes: number | null
  highwaterBytes: number | null
  limitBytes: number | null
  contexts: number | null
  dbConnections: number | null
  dbExceeded: number | null
  exceptions: number | null
  uptimeSec: number | null
  version: string
  /** Active users reported every five minutes over the last day (Loki), and the day's peak. */
  usersSpark?: Spark
  usersPeak?: number | null
  level: Level
}

export interface LicenseStatus {
  /** When the check ran (ms). */
  at: number
  status: string
  type: string
  version: string
  offline: string
  nodes: { host: string; ip: string; port: string; rttMs: number | null }[]
  level: Level
}

export interface KernelHealth {
  env: PlmEnvId
  at: number
  start: number
  step: number
  servers: KernelServer[]
  license: LicenseStatus | null
  gaps: string[]
}

/**
 * Everyone signed in across the 3DSpace servers, each person once: the load balancer can give one person sessions on
 * both servers. `onMany` counts the people seen on more than one.
 */
export function signedInPeople(servers: Pick<KernelServer, 'reachable' | 'people'>[]): { people: string[]; onMany: number } {
  const seen = new Map<string, { name: string; n: number }>()
  for (const s of servers) {
    if (!s.reachable) continue
    for (const p of new Set(s.people.map((x) => x.trim()).filter(Boolean))) {
      const k = p.toLowerCase()
      const had = seen.get(k)
      seen.set(k, { name: had?.name ?? p, n: (had?.n ?? 0) + 1 })
    }
  }
  const all = [...seen.values()]
  return { people: all.map((x) => x.name).sort((a, b) => a.localeCompare(b)), onMany: all.filter((x) => x.n > 1).length }
}

/** The kernel's own sessions, never a person. */
export const SYSTEM_USERS = new Set(['User Agent', 'ADMINISTRATION'])
export const isServiceAccount = (u: string): boolean => /^svc[_-]/i.test(u)

/**
 * The license server check (DSCheckLS output, one block every 30 minutes): status, version and the servers it can
 * reach. The license file's name and the customer id in the same block are left out.
 */
export function parseLicense(lines: string[], at: number): LicenseStatus | null {
  const field = (k: string): string => lines.map((l) => new RegExp(`^\\s*\\+\\s*${k}\\s*:\\s*(.*?)\\s*$`, 'i').exec(l)?.[1]).find((x) => x !== undefined) ?? ''
  const status = field('status')
  if (!status) return null
  const nodes: LicenseStatus['nodes'] = []
  lines.forEach((l, i) => {
    const m = /^\s*\+\s*([a-z0-9.-]+\.[a-z]{2,})\s*:\s*$/i.exec(l)
    if (!m) return
    const after = lines.slice(i + 1, i + 8)
    const get = (k: string): string => after.map((x) => new RegExp(`^\\s*\\+\\s*${k}\\s*:\\s*(.*?)\\s*$`, 'i').exec(x)?.[1]).find((x) => x !== undefined) ?? ''
    const rtt = /([\d.]+)\s*ms/.exec(get('round-trip'))
    nodes.push({ host: m[1], ip: get('IP address'), port: get('port'), rttMs: rtt ? Number(rtt[1]) : null })
  })
  return { at, status, type: field('type'), version: field('version'), offline: field('offline licenses'), nodes, level: /^running$/i.test(status) ? 'ok' : 'crit' }
}

/** One machine's memory over a window, for the memory-by-machine grid (health:memory). */
export interface MachineMemory {
  ip: string
  name: string
  role: string
  label: string
  os: 'linux' | 'windows'
  state: HostHealth['state']
  totalBytes: number | null
  /** Memory in use, % of the machine's total, per step. */
  pct: Spark
  now: number | null
  peak: number | null
  avg: number | null
  level: Level
  instanceKey?: string
}

export interface MemoryHistory {
  env: PlmEnvId
  hours: number
  start: number
  step: number
  machines: MachineMemory[]
}

/** How the heap's after-GC floor behaves over a window: the memory-leak signal. */
export interface GcTrend {
  level: Level
  text: string
  floorBytes: number | null
  floorPct: number | null
  /** Growth of the floor per day over the latest stretch of the window. */
  slopePerDay: number | null
  daysToMax: number | null
  /** The fitted line over the latest stretch, to draw: [t0 ms, bytes, t1 ms, bytes]. */
  line: [number, number, number, number] | null
}

export interface GcCollector {
  name: string
  /** A full (global, old-generation) collection rather than a partial or young one. */
  full: boolean
  count: number
  seconds: number
  avgMs: number | null
  perHour: number
}

/** One JVM's heap and garbage collection over a window, for the heap chart (health:gc). */
export interface JvmGcDetail {
  instance: string
  hours: number
  /** First point's time (ms) and the step between points (s). */
  start: number
  step: number
  heapMax: number | null
  /** Per step: the highest and lowest heap in use, the saw-tooth's top and bottom. */
  heapHigh: Spark
  heapLow: Spark
  /** Per step: what the last collection left. */
  afterGc: Spark
  /** Per step: how many full collections ran. */
  fullGcs: Spark
  startedAt: number | null
  lastFullGcAt: number | null
  collectors: GcCollector[]
  /** Share of time the application ran rather than the collector, as GCeasy reports it. */
  throughputPct: number | null
  allocBytesPerSec: number | null
  pools: { name: string; used: number; max: number | null; heap: boolean }[]
  trend: GcTrend
  /** "OpenJ9 balanced", "G1"…, from the pools' names. */
  policy: string
  nonHeapBytes: number | null
  /** The process's resident memory (RSS), heap and everything else. */
  rssBytes: number | null
  openFds: number | null
}

/** The collector a JVM runs, read from its memory pools' names. */
export function gcPolicy(pools: string[]): string {
  const has = (re: RegExp): boolean => pools.some((p) => re.test(p))
  if (has(/^balanced-/i)) return 'OpenJ9 balanced'
  if (has(/^nursery-|^tenured-/i)) return 'OpenJ9 gencon'
  if (has(/^G1 /)) return 'G1'
  if (has(/^ZHeap|^ZGC/)) return 'ZGC'
  if (has(/^Shenandoah/)) return 'Shenandoah'
  if (has(/^PS /)) return 'Parallel'
  if (has(/^CMS /)) return 'CMS'
  return ''
}

/** The heap chart's ranges: hours, and the step that keeps each near 360 points. */
export const GC_RANGES: { hours: number; label: string; step: number }[] = [
  // Every scrape: OpenJ9's teeth are a few minutes long, as on Grafana's JVM heap panel.
  { hours: 1, label: '1h', step: 15 },
  { hours: 6, label: '6h', step: 60 },
  { hours: 24, label: '24h', step: 240 },
  { hours: 72, label: '3d', step: 600 },
  { hours: 168, label: '7d', step: 1800 },
  { hours: 336, label: '14d', step: 3600 }
]

/**
 * Whether a collector (the JMX gc label) is a full collection: OpenJ9's "global garbage collect" (balanced, gencon),
 * HotSpot's old-generation collectors (G1 Old Generation, PS MarkSweep, ConcurrentMarkSweep, MarkSweepCompact).
 */
export const isFullGc = (name: string): boolean => /global|old gen|marksweep|mark ?sweep|\bfull\b|tenured/i.test(name) && !/young|scavenge|partial|minor/i.test(name)

/**
 * Judges the after-GC floor over a window, the way one reads GCeasy's heap-after-GC graph: a healthy saw-tooth drops
 * back to the same level after each collection; a leak shows the floor climbing, or sitting near the maximum while
 * collections keep running. Only time since the JVM started counts, and the slope is taken over the latest stretch,
 * so caches warming up after a restart and then levelling off read as healthy.
 */
export function gcTrend(times: number[], values: Spark, max: number | null, startedAt: number | null = null): GcTrend {
  const pts: [number, number][] = []
  times.forEach((t, i) => { const v = values[i]; if (v !== null && v !== undefined && Number.isFinite(v) && (startedAt === null || t >= startedAt)) pts.push([t, v]) })
  if (pts.length < 6) return { level: 'unknown', text: 'Not enough data yet to judge the heap after collections.', floorBytes: pts.at(-1)?.[1] ?? null, floorPct: null, slopePerDay: null, daysToMax: null, line: null }
  const tail = pts.slice(-3).map((p) => p[1]).sort((a, b) => a - b)
  const floor = tail[1]
  const pct = max && max > 0 ? (floor / max) * 100 : null
  const t0 = pts[0][0]
  const t1 = pts[pts.length - 1][0]
  // Only the latest stretch decides (a quarter of the window, at least six hours): a floor that rose after a restart
  // and has been flat since is not a leak, whichever range is on screen.
  const recentFrom = t1 - Math.max(6 * 3_600_000, (t1 - t0) / 4)
  const recentPts = pts.filter((p) => p[0] >= recentFrom)
  const recent = recentPts.length >= 6 ? recentPts : pts.slice(-6)
  const fit = (ps: [number, number][]): { slope: number; icpt: number; r2: number } => {
    const n = ps.length
    const mx = ps.reduce((a, p) => a + p[0], 0) / n
    const my = ps.reduce((a, p) => a + p[1], 0) / n
    let sxy = 0, sxx = 0, syy = 0
    for (const [x, y] of ps) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2 }
    const slope = sxx ? sxy / sxx : 0
    return { slope, icpt: my - slope * mx, r2: sxx && syy ? (sxy * sxy) / (sxx * syy) : 0 }
  }
  const r = fit(recent)
  const all = fit(pts)
  const perDay = r.slope * 86_400_000
  const scale = max ?? Math.max(...pts.map((p) => p[1]))
  const rising = perDay > scale * 0.03 && r.r2 >= 0.5
  const days = rising && max ? Math.max(0, (max - floor) / perDay) : null
  const line: GcTrend['line'] = rising ? [recent[0][0], r.icpt + r.slope * recent[0][0], t1, r.icpt + r.slope * t1] : null
  const gb = (b: number): string => `${(b / 1024 ** 3).toFixed(b >= 10 * 1024 ** 3 ? 0 : 1)} GB`
  const of = max ? ` (${Math.round(pct!)}% of ${gb(max)})` : ''
  let level: Level = 'ok'
  let text: string
  if (pct !== null && pct >= 90) {
    level = 'crit'
    text = `The heap stays at ${Math.round(pct)}% of its maximum even after collections: the garbage collector cannot free it. Likely a memory leak; a heap dump would show what holds it.`
  } else if (rising && days !== null && days < 14) {
    level = 'warn'
    text = `What survives each collection keeps growing, about ${gb(perDay)} a day; at this rate the heap is full in ${days < 1 ? 'under a day' : `${Math.round(days)} days`}. Possible memory leak.`
  } else if (pct !== null && pct >= 80) {
    level = 'warn'
    text = `After collections the heap still holds ${Math.round(pct)}% of its maximum: little room left for new work.`
  } else {
    // Said only when the restart is on screen: otherwise the climb is just the window's start.
    const restartInView = startedAt !== null && times.length > 0 && startedAt >= times[0]
    const settled = restartInView && all.slope * 86_400_000 > scale * 0.03 && !rising
    text = `Healthy saw-tooth: after collections the heap drops back to about ${gb(floor)}${of}.${settled ? ' It grew after the restart and has levelled off since.' : ''}`
  }
  return { level, text, floorBytes: floor, floorPct: pct, slopePerDay: perDay, daysToMax: days, line }
}

export interface ApacheHealth {
  label: string
  ip: string | null
  name: string
  level: Level
  reporting: boolean
  busy: number | null
  idle: number | null
  reqPerSec: number | null
  spark?: Spark
}

export interface StorageHealth {
  mount: string
  device: string
  shared: boolean
  hosts: string[]
  pct: number
  usedBytes: number
  sizeBytes: number
  level: Level
}

export interface DbHealth {
  id: string
  engine: string
  instanceClass: string
  status: string
  multiAz: boolean
  level: Level
  problems: string[]
  cpu: number | null
  connections: number | null
  freeStorageBytes: number | null
  storageBytes: number | null
  freeMemBytes: number | null
  readLatencyMs: number | null
  writeLatencyMs: number | null
  cpuSpark?: Spark
  connSpark?: Spark
}

export interface AlbHealth {
  name: string
  internal: boolean
  level: Level
  problems: string[]
  requestsPerMin: number | null
  target5xx: number | null
  elb5xx: number | null
  responseMs: number | null
  healthy: number | null
  unhealthy: number | null
  reqSpark?: Spark
  latencySpark?: Spark
}

export interface CertHealth {
  host: string
  days: number
  expires: number
  level: Level
}

export interface AlertItem {
  name: string
  severity: string
  summary: string
  target: string
  since: number | null
  level: Level
  /** The server behind it is stopped in EC2: shown, not counted. */
  muted: boolean
}

export interface Issue {
  level: Level
  text: string
  section: 'services' | 'jvm' | 'kernel' | 'db' | 'alb' | 'servers' | 'storage' | 'certs' | 'web'
}

export interface PlmEnvHealth {
  id: PlmEnvId
  name: string
  level: Level
  headline: string
  issues: Issue[]
  services: ServiceHealth[]
  checks: HealthCheck[]
  hosts: HostHealth[]
  jvms: JvmHealth[]
  apaches: ApacheHealth[]
  storage: StorageHealth[]
  db: DbHealth | null
  albs: AlbHealth[]
  certs: CertHealth[]
  alerts: AlertItem[]
  /** Parts that could not be read (CloudWatch denied, say); the rest still shows. */
  gaps: string[]
}

export interface PlmHealthSnapshot {
  at: number
  /** Where the numbers come from, for the footer: "MSDEV-Monitoring-Server (10.0.2.105:9090) via SSM". */
  source: string
  envs: PlmEnvHealth[]
}

/** The order services are listed in: what users touch first. */
export const SERVICE_ORDER = ['passport', 'dashboard', 'space', 'search', 'fcs', 'index', 'comment', 'swym', 'notification', 'docs', 'tif', 'converter', 'cad', 'apache']

// ---------- thresholds (the monitoring server's own alert rules use 85% for CPU, memory and disk) ----------

export const LIMITS = {
  cpu: [75, 85],
  mem: [80, 90],
  disk: [75, 85],
  diskWindows: [80, 90],
  heap: [85, 95],
  gc: [5, 15],
  fds: [70, 90],
  apacheBusy: [75, 90],
  dbCpu: [75, 90],
  dbLatencyMs: [20, 50],
  albMs: [1000, 3000],
  certDays: [30, 7]
} as const

/** A value against [warn, crit]; null stays unknown. */
export function levelOf(v: number | null | undefined, [warn, crit]: readonly [number, number]): Level {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'unknown'
  return v >= crit ? 'crit' : v >= warn ? 'warn' : 'ok'
}

/** For "less is worse" values (free storage %, certificate days): crit below the second, warn below the first. */
export function levelBelow(v: number | null | undefined, [warn, crit]: readonly [number, number]): Level {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'unknown'
  return v <= crit ? 'crit' : v <= warn ? 'warn' : 'ok'
}

const RANK: Record<Level, number> = { crit: 4, warn: 3, unknown: 1, ok: 2, off: 0 }
/** The worst of several levels; off and unknown never outrank ok. */
export function worst(levels: Level[]): Level {
  let w: Level = 'ok'
  let any = false
  for (const l of levels) {
    if (l === 'off' || l === 'unknown') continue
    any = true
    if (RANK[l] > RANK[w]) w = l
  }
  return any ? w : levels.includes('unknown') ? 'unknown' : levels.length ? 'off' : 'unknown'
}

export interface DiskUse { mount: string; pct: number; shared: boolean }

/**
 * A machine's own fullest disk. A network store (the FCS file store on the NetApp, say) is shared by every machine
 * that mounts it, so it is judged once under Storage rather than turning each of those machines unhealthy; the small
 * boot partitions only count once they fill up.
 */
export function fullestDisk(disks: DiskUse[], windows: boolean): { mount: string; pct: number } | null {
  const limits = windows ? LIMITS.diskWindows : LIMITS.disk
  const own = disks.filter((d) => !d.shared && (!/^\/boot(\/|$)/.test(d.mount) || d.pct >= limits[0])).sort((a, b) => b.pct - a.pct)[0]
  return own ? { mount: own.mount, pct: own.pct } : null
}

// ---------- reading Prometheus labels ----------

/** The private address in an instance label: "10.0.2.175:9100", "ip-10-0-2-175.us-west-1…:9404", or a URL to either. */
export function ipOf(instance: string): string | null {
  const host = /^[a-z]+:\/\//i.test(instance) ? instance.replace(/^[a-z]+:\/\//i, '').split(/[/:?#]/)[0] : instance.split(':')[0]
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host
  const m = /^ip-(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})(\.|$)/.exec(host)
  return m ? `${m[1]}.${m[2]}.${m[3]}.${m[4]}` : null
}

/** The host name of a URL label, '' for a plain address. */
export function urlHost(instance: string): string {
  return /^[a-z]+:\/\//i.test(instance) ? instance.replace(/^[a-z]+:\/\//i, '').split(/[/:?#]/)[0] : ''
}

/**
 * The environment a series belongs to, from its job name ("PROD 3DSpace Server 01", "QA Environment ALB Healthcheck",
 * "Development Server") or a public URL's host (pass-pplm, space-qplm…). Null when the job covers several environments
 * ("QA and Dev CAD Converter URL") or none: the caller then goes by the address.
 */
export function envOf(job: string, instance = ''): PlmEnvId | null {
  const host = urlHost(instance)
  const fromHost = /-pplm\b|\bprod\b/i.test(host) ? 'prod' : /-qplm\b/i.test(host) ? 'qa' : /-dplm\b/i.test(host) ? 'dev' : null
  if (fromHost) return fromHost
  const prod = /\b(prod|production)\b/i.test(job)
  const qa = /\bqa\b/i.test(job)
  const dev = /\b(dev|development)\b/i.test(job)
  if (Number(prod) + Number(qa) + Number(dev) !== 1) return null
  return prod ? 'prod' : qa ? 'qa' : 'dev'
}

interface Role { id: string; name: string; blurb: string; match: RegExp }

/** The platform's parts, most specific first: a probe's path or a job's words say which one a series is about. */
export const ROLES: Role[] = [
  { id: 'monitoring', name: 'Monitoring', blurb: 'Prometheus itself', match: /prometheus/i },
  { id: 'converter', name: 'Derived Output Converter', blurb: 'Viewable and derived formats for 3DSpace', match: /derived ?objects?|derived ?output/i },
  { id: 'cad', name: 'CAD Converter', blurb: 'CAD format conversion service', match: /cad ?con|:5001\b/i },
  { id: 'passport', name: '3DPassport', blurb: 'Sign-in and single sign-on', match: /3dpassport|\/\/pass-/i },
  { id: 'dashboard', name: '3DDashboard', blurb: 'Dashboards and the platform home', match: /3ddashboard|\/\/dash-/i },
  { id: 'index', name: 'Full-text search', blurb: 'EXALEAD CloudView index', match: /3dspaceindex|spaceindex|search-api|\bfts\b|:(19|29)0[01]\d\b/i },
  { id: 'space', name: '3DSpace', blurb: 'ENOVIA collaboration server', match: /3dspace|\/internal\/servlet|\/\/space-/i },
  { id: 'search', name: '3DSearch', blurb: 'Federated search', match: /3dsearch|federated/i },
  { id: 'fcs', name: 'File Collaboration Server', blurb: 'File check-in and check-out', match: /\bfcs\b|\/\/fcs-/i },
  { id: 'comment', name: '3DComment', blurb: 'Comments and markups', match: /3dcomment|\/\/comment-/i },
  { id: 'swym', name: '3DSwym', blurb: 'Communities and social', match: /3dswym/i },
  { id: 'notification', name: '3DNotification', blurb: 'Notifications', match: /3dnotification|\/\/notif-/i },
  { id: 'docs', name: 'Documentation', blurb: 'User assistance', match: /documentation|\/\/help-/i },
  { id: 'tif', name: 'TIF', blurb: 'Integration framework', match: /\btif\b|enovia\/adminui/i },
  { id: 'apache', name: 'Apache web tier', blurb: 'Reverse proxy in front of the apps', match: /apache|:80\/?$/i },
  { id: 'allinone', name: 'All-in-one server', blurb: 'Every service on one machine', match: /development server/i },
  { id: 'migration', name: 'Migration server', blurb: 'Windows migration tooling', match: /migration/i }
]

export function roleOf(job: string, instance = ''): Role | null {
  // A probe's address says more than its job ("QA Environment Service HTTP Healthcheck" covers every service).
  const url = /^[a-z]+:\/\//i.test(instance) ? instance : ''
  if (url) {
    const byUrl = ROLES.find((r) => r.match.test(url))
    if (byUrl) return byUrl
  }
  return ROLES.find((r) => r.match.test(job)) ?? null
}

/** "01", "02", "Primary"… from a job name, or '' when it names one server. */
export function nodeLabel(job: string): string {
  if (/\bprimary\b/i.test(job)) return 'Primary'
  if (/\bsecondary\b/i.test(job)) return 'Secondary'
  const all = [...job.matchAll(/\b0?([1-9])\b/g)]
  return all.length ? `0${all[all.length - 1][1]}` : ''
}

/** Whether a probe is the load balancer's (what users reach) rather than one server's. */
export function isFrontProbe(job: string, instance: string): boolean {
  return /\balb\b/i.test(job) || (/^https:\/\//i.test(instance) && !ipOf(instance))
}

/** A probe's status code counts as up the way the monitoring server's alert does: 200 or a redirect. */
export const probeOk = (status: number | null, success: number | null): boolean => success === 1 || status === 200 || status === 302

// ---------- verdicts ----------

export function serviceLevel(fronts: Endpoint[], nodes: ServiceNode[]): { level: Level; summary: string } {
  // Servers, not checks: 3DSpace has two checks on each machine (its page and its internal one).
  const machines = (list: ServiceNode[]): number => new Set(list.map((n) => n.ip ?? n.url)).size
  // A server whose check is not running says nothing either way: counted apart, never as up.
  const blind = nodes.filter((n) => !n.stopped && n.level === 'unknown')
  const live = nodes.filter((n) => !n.stopped && n.level !== 'unknown')
  const down = live.filter((n) => n.level === 'crit')
  const stopped = machines(nodes.filter((n) => n.stopped))
  const nLive = machines(live)
  const nDown = machines(down)
  const frontDown = fronts.filter((f) => f.level === 'crit')
  const slow = [...fronts, ...live].filter((e) => e.level === 'warn')
  const note = `${blind.length ? ` · ${machines(blind)} not checked` : ''}${stopped ? ` · ${stopped} stopped` : ''}`
  if (frontDown.length) return { level: 'crit', summary: `Unreachable through the load balancer${nDown ? ` · ${nDown} of ${nLive} servers down` : ''}${note}` }
  if (nLive && nDown === nLive) return { level: 'crit', summary: `All ${nLive === 1 ? 'servers are' : `${nLive} servers are`} down${note}` }
  if (nDown) return { level: 'warn', summary: `${nDown} of ${nLive} servers down, still served${note}` }
  if (slow.length) return { level: 'warn', summary: `Slow to answer${note}` }
  // Checks whose probe itself failed (the blackbox exporter down, a module missing): nothing is known.
  if (([...fronts, ...live].length || blind.length) && [...fronts, ...live].every((e) => e.level === 'unknown')) return { level: 'unknown', summary: 'Its health check is not running' }
  if (!fronts.length && !live.length) return { level: stopped ? 'off' : 'unknown', summary: stopped ? 'Stopped' : 'Not checked: only its servers are monitored' }
  return { level: 'ok', summary: `${nLive > 1 ? `${nLive} servers up` : 'Up'}${note}` }
}

/**
 * What a check really proves, when it is less than a health endpoint: a page that only shows the web app answers (a
 * landing or docs page, a login redirect). Null for a real health check (healthcheck, test-alive, isAlive, ping).
 */
export function checkNote(url: string): string | null {
  if (/federated\/manager\?query=monitoring/i.test(url)) return 'Redirects to the 3DPassport login page: proves the web app and sign-in page answer, not that search works'
  if (/swagger-ui/i.test(url)) return 'The API documentation page'
  if (/\/enovia\/adminui/i.test(url)) return 'The admin UI page'
  if (/\/English\/?$/i.test(url)) return 'A content page'
  if (/^https?:\/\/[^/]+:(19|29)0\d\d\/?$/i.test(url)) return 'The search landing page, not its isAlive check'
  if (/^https?:\/\/[^/:]+(:80)?\/?$/i.test(url)) return "The web server's root page"
  return null
}

const SECTION_WEIGHT: Record<Issue['section'], number> = { services: 0, db: 1, alb: 2, jvm: 3, kernel: 4, web: 5, storage: 6, servers: 7, certs: 8 }

/** The environment's verdict and headline from its findings, worst first. */
export function verdict(issues: Issue[], services: ServiceHealth[]): { level: Level; headline: string; issues: Issue[] } {
  const sorted = [...issues].sort((a, b) => RANK[b.level] - RANK[a.level] || SECTION_WEIGHT[a.section] - SECTION_WEIGHT[b.section])
  const level = worst(sorted.map((i) => i.level))
  const outage = services.filter((s) => s.level === 'crit').map((s) => s.name)
  const crit = sorted.filter((i) => i.level === 'crit').length
  const warn = sorted.filter((i) => i.level === 'warn').length
  const headline = outage.length
    ? `${outage.slice(0, 2).join(' and ')}${outage.length > 2 ? ` and ${outage.length - 2} more` : ''} ${outage.length === 1 ? 'is' : 'are'} down`
    : crit
      ? `${crit} ${crit === 1 ? 'problem needs' : 'problems need'} attention`
      : warn
        ? `Running, with ${warn} ${warn === 1 ? 'warning' : 'warnings'}`
        : 'All systems operational'
  return { level: sorted.length ? level : 'ok', headline, issues: sorted }
}

// ---------- machines (the honeycomb) ----------

/** One health check that runs on a machine. */
export interface MachineCheck {
  service: string
  url: string
  level: Level
  status: number | null
  ms: number | null
}

/** One machine in an environment: its own readings (node or Windows exporter) joined with every check that runs on it. */
export interface MachineCell {
  ip: string
  name: string
  /** "3DSpace 01", "All-in-one server". */
  title: string
  roleId: string | null
  label: string
  level: Level
  state: HostHealth['state']
  /** Null when no exporter runs on it, so only its checks are known. */
  reporting: boolean | null
  os: HostHealth['os'] | null
  cpu: number | null
  mem: number | null
  disk: HostHealth['disk']
  sharedStores: NonNullable<HostHealth['sharedStores']>
  checks: MachineCheck[]
  problems: string[]
  instanceKey?: string
  instanceType?: string
  /** Has a row under Servers (an exporter runs on it). */
  listed: boolean
}

const roleRank = (id: string | null): number => {
  const i = id ? SERVICE_ORDER.indexOf(id) : -1
  return i < 0 ? SERVICE_ORDER.length : i
}

/**
 * Every machine in an environment, once, for the honeycomb. A machine is unhealthy when it stops reporting, a health
 * check on it fails, or its CPU, memory or disk is over the limit; stopped in EC2 is set apart, never unhealthy. Sorted
 * by the services' order, then label, so a machine keeps its place when its colour changes.
 */
export function machines(env: Pick<PlmEnvHealth, 'hosts' | 'services'>): MachineCell[] {
  const byIp = new Map<string, MachineCell>()
  for (const h of env.hosts) {
    const had = byIp.get(h.ip)
    if (had) {
      // The same machine under two exporters' jobs: one cell, the worse reading.
      had.level = worst([had.level, h.level])
      had.problems.push(...h.problems)
      continue
    }
    byIp.set(h.ip, {
      ip: h.ip, name: h.name, title: `${h.role}${h.label ? ` ${h.label}` : ''}`, roleId: ROLES.find((r) => r.name === h.role)?.id ?? null, label: h.label,
      level: h.level, state: h.state, reporting: h.reporting, os: h.os, cpu: h.cpu, mem: h.mem, disk: h.disk, sharedStores: h.sharedStores ?? [], checks: [], problems: [...h.problems],
      instanceKey: h.instanceKey, instanceType: h.instanceType, listed: true
    })
  }
  const unlisted = new Map<string, Set<string>>()
  for (const s of env.services) {
    for (const n of s.nodes) {
      if (!n.ip) continue
      let m = byIp.get(n.ip)
      if (!m) {
        // Checked but not monitored itself (no exporter): known only by its checks.
        const label = n.label === 'server' || n.label === n.ip ? '' : n.label
        m = {
          ip: n.ip, name: n.name, title: `${s.name}${label ? ` ${label}` : ''}`, roleId: s.id, label, level: 'unknown', state: n.stopped ? 'stopped' : 'unknown',
          reporting: null, os: null, cpu: null, mem: null, disk: null, sharedStores: [], checks: [], problems: [], instanceKey: n.instanceKey, listed: false
        }
        byIp.set(n.ip, m)
      }
      if (!m.listed) unlisted.set(n.ip, (unlisted.get(n.ip) ?? new Set()).add(s.id))
      if (!m.checks.some((c) => c.url === n.url)) m.checks.push({ service: s.name, url: n.url, level: n.stopped ? 'off' : n.level, status: n.status, ms: n.ms })
    }
  }
  for (const m of byIp.values()) {
    // An unmonitored machine that serves several services is named by its EC2 name, not the first service found.
    if (!m.listed && (unlisted.get(m.ip)?.size ?? 0) > 1) { m.title = m.name; m.roleId = null; m.label = '' }
    if (!m.listed && m.checks.length && m.checks.every((c) => c.level === 'off')) m.state = 'stopped'
    if (m.state === 'stopped') { m.level = 'off'; m.problems = []; continue }
    const live = m.checks.filter((c) => c.level !== 'off')
    for (const c of live) {
      if (c.level === 'crit') m.problems.push(`${c.service} check fails: ${c.status ? `HTTP ${c.status}` : 'no answer'}`)
      else if (c.level === 'warn') m.problems.push(`${c.service} check is slow: ${formatMs(c.ms)}`)
    }
    m.problems = [...new Set(m.problems)]
    m.level = worst([m.level, ...live.map((c) => c.level)])
  }
  return [...byIp.values()].sort((a, b) =>
    roleRank(a.roleId) - roleRank(b.roleId) || a.title.localeCompare(b.title, undefined, { numeric: true }) || a.ip.localeCompare(b.ip, undefined, { numeric: true }))
}

// ---------- formatting ----------

export function formatBytes(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let v = n
  let i = 0
  while (Math.abs(v) >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(digits)} ${units[i]}`
}

export function formatDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '–'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${Math.max(0, m)}m`
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '–'
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s` : `${Math.round(ms)} ms`
}

export function formatPct(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '–' : `${v >= 10 || v === 0 ? Math.round(v) : v.toFixed(1)}%`
}

export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  return s < 5 ? 'just now' : s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 172800 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`
}

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
  disk: { mount: string; pct: number } | null
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
  level: Level
  problems: string[]
  reporting: boolean
  heapUsed: number | null
  heapMax: number | null
  heapPct: number | null
  gcPct: number | null
  threads: number | null
  fdsPct: number | null
  cpu: number | null
  uptimeSec: number | null
  heapSpark?: Spark
  instanceKey?: string
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
  section: 'services' | 'jvm' | 'db' | 'alb' | 'servers' | 'storage' | 'certs' | 'web'
}

export interface PlmEnvHealth {
  id: PlmEnvId
  name: string
  level: Level
  headline: string
  issues: Issue[]
  services: ServiceHealth[]
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
  const live = nodes.filter((n) => !n.stopped)
  const down = live.filter((n) => n.level === 'crit')
  const stopped = nodes.length - live.length
  const frontDown = fronts.filter((f) => f.level === 'crit')
  const slow = [...fronts, ...live].filter((e) => e.level === 'warn')
  const note = stopped ? ` · ${stopped} stopped` : ''
  if (frontDown.length) return { level: 'crit', summary: `Unreachable through the load balancer${down.length ? ` · ${down.length} of ${live.length} servers down` : ''}${note}` }
  if (live.length && down.length === live.length) return { level: 'crit', summary: `All ${live.length === 1 ? 'servers are' : `${live.length} servers are`} down${note}` }
  if (down.length) return { level: 'warn', summary: `${down.length} of ${live.length} servers down, still served${note}` }
  if (slow.length) return { level: 'warn', summary: `Slow to answer${note}` }
  if (!fronts.length && !live.length) return { level: stopped ? 'off' : 'unknown', summary: stopped ? 'Stopped' : 'Not monitored' }
  return { level: 'ok', summary: `${live.length > 1 ? `${live.length} servers up` : 'Up'}${note}` }
}

const SECTION_WEIGHT: Record<Issue['section'], number> = { services: 0, db: 1, alb: 2, jvm: 3, web: 4, storage: 5, servers: 6, certs: 7 }

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

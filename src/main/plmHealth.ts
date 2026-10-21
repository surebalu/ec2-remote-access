/**
 * The Health tab's data (health:snapshot): the 3DEXPERIENCE platform's health per environment.
 *
 * Most of it comes from the Prometheus server that already monitors the platform (node, JMX, Apache and Windows
 * exporters, and blackbox probes of every service, through the load balancer and on each server). It listens on a
 * private address, so it is reached through an SSM port forward via the monitoring host itself, kept open while the
 * tab is used and closed ten minutes after the last look; it is not one of the user's tunnels, so it stays out of the
 * tunnel bar. The Oracle database (RDS) and the load balancers come from CloudWatch, in the account that runs each
 * environment's servers, and EC2's own view of each server tells a stopped machine from a failed one.
 *
 * No Electron here: the gateway serves the same tab to phones and iPads.
 */
import { resolveCname } from 'node:dns/promises'
import { CloudWatchClient, GetMetricDataCommand, ListMetricsCommand, type MetricDataQuery, type MetricDataResult } from '@aws-sdk/client-cloudwatch'
import { DescribeDBInstancesCommand, RDSClient } from '@aws-sdk/client-rds'
import type { Instance } from '@shared/types'
import {
  ENV_NAMES, ENV_ORDER, GC_RANGES, LIMITS, ROLES, SERVICE_ORDER, checkNote, envOf, fullestDisk, gcTrend, ipOf, isFrontProbe, isFullGc, levelBelow, levelOf, nodeLabel, probeOk, roleOf,
  serviceLevel, urlHost, verdict, worst, formatBytes, formatPct, formatMs, gcPolicy, isServiceAccount, parseLicense, SYSTEM_USERS, type GcCollector, type JvmGcDetail, type MachineMemory, type MemoryHistory,
  type AlbHealth, type AlertItem, type ApacheHealth, type CertHealth, type DbHealth, type DiskUse, type Endpoint, type HostHealth, type Issue, type JvmHealth,
  type HealthCheck, type KernelHealth, type KernelMemoryHistory, type KernelMemorySeries, type KernelServer, type Level, type PlmEnvHealth, type PlmEnvId, type PlmHealthSnapshot, type ServiceHealth, type ServiceNode, type Spark, type StorageHealth
} from '@shared/plmHealth'
import { credentialsFor } from './aws/credentials'
import { log } from './log'
import { startPortForward, type SsmHandle } from './ssm/session'
import { getCachedInventory, getSettings } from './store'
import { freePort } from './util'

// ---------- the way in: an SSM port forward to Prometheus ----------

interface Source { inst: Instance; host: string; port: number }

function source(): Source {
  const want = getSettings().healthSource
  const all = getCachedInventory()?.instances ?? []
  const inst = want?.instanceKey
    ? all.find((i) => i.key === want.instanceKey)
    : all.find((i) => i.state === 'running' && i.ssmOnline && /monitor|prometheus/i.test(i.name))
  if (!inst) {
    throw new Error(want?.instanceKey
      ? 'The monitoring server chosen in Settings → Health is not in the host list. Rescan, or choose it again.'
      : 'No monitoring server found: no running host with "monitor" or "prometheus" in its name is online in SSM. Choose one in Settings → Health.')
  }
  if (inst.state !== 'running' || !inst.ssmOnline) throw new Error(`${inst.name} is ${inst.state !== 'running' ? inst.state : 'not online in SSM'}, so its Prometheus cannot be reached.`)
  return { inst, host: want?.host?.trim() || inst.privateIp || '127.0.0.1', port: want?.port || 9090 }
}

/**
 * Tunnels through the monitoring host, one per address it relays to (Prometheus, Loki, each 3DSpace server's Jolokia):
 * an SSM port forward reaches one host and port. Each closes ten minutes after it was last used.
 */
interface Tunnel { port: number; handle: SsmHandle; timer: ReturnType<typeof setTimeout> | null }
const tunnels = new Map<string, Tunnel>()
const opening = new Map<string, Promise<number>>()
const IDLE_MS = 10 * 60_000

function keepOpen(key: string): void {
  const t = tunnels.get(key)
  if (!t) return
  if (t.timer) clearTimeout(t.timer)
  t.timer = setTimeout(() => void closeTunnel(key), IDLE_MS)
}

/** A local port that reaches host:port from the monitoring host. */
async function forward(src: Source, host: string, port: number): Promise<number> {
  const key = `${src.inst.key}|${host}:${port}`
  const have = tunnels.get(key)
  if (have && have.handle.child.exitCode === null && !have.handle.child.killed) { keepOpen(key); return have.port }
  let p = opening.get(key)
  if (!p) {
    p = (async () => {
      await closeTunnel(key)
      const local = await freePort()
      const self = /^(127\.0\.0\.1|localhost)$/.test(host)
      const handle = await startPortForward(src.inst, port, local, undefined, self ? undefined : host)
      tunnels.set(key, { port: local, handle, timer: null })
      handle.child.once('exit', () => { if (tunnels.get(key)?.handle === handle) tunnels.delete(key) })
      log('health', 'tunnel open', { via: src.inst.name, target: `${host}:${port}`, localPort: local })
      return local
    })().finally(() => opening.delete(key))
    opening.set(key, p)
  }
  const local = await p
  keepOpen(key)
  return local
}

async function closeTunnel(key: string): Promise<void> {
  const t = tunnels.get(key)
  tunnels.delete(key)
  if (t?.timer) clearTimeout(t.timer)
  if (t) await t.handle.terminate().catch(() => undefined)
}

const prometheusPort = (src: Source): Promise<number> => forward(src, src.host, src.port)

/** On quit, and ten minutes after the tab was last looked at. */
export async function closePlmHealth(): Promise<void> {
  await Promise.all([...tunnels.keys()].map(closeTunnel))
}

// ---------- Prometheus ----------

type Labels = Record<string, string>
interface Sample { metric: Labels; value: number }
interface Series { metric: Labels; values: Spark }

async function api<T>(port: number, path: string, params: Record<string, string>): Promise<T> {
  const r = await fetch(`http://127.0.0.1:${port}/api/v1/${path}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(20_000) })
  const j = (await r.json()) as { status: string; data?: T; error?: string }
  if (j.status !== 'success') throw new Error(`Prometheus: ${j.error ?? `HTTP ${r.status}`}`)
  return j.data as T
}

const instant = async (port: number, query: string): Promise<Sample[]> =>
  (await api<{ result: { metric: Labels; value: [number, string] }[] }>(port, 'query', { query })).result.map((r) => ({ metric: r.metric, value: Number(r.value[1]) }))

const SPARK_MIN = 60
const SPARK_STEP = 60

async function range(port: number, query: string, end: number, minutes = SPARK_MIN, step = SPARK_STEP): Promise<Series[]> {
  const start = end - minutes * 60
  const d = await api<{ result: { metric: Labels; values: [number, string][] }[] }>(port, 'query_range', { query, start: String(start), end: String(end), step: String(step) })
  const n = Math.round((end - start) / step) + 1
  return d.result.map((r) => {
    const values: Spark = new Array<number | null>(n).fill(null)
    for (const [t, v] of r.values) {
      const i = Math.round((t - start) / step)
      const x = Number(v)
      if (i >= 0 && i < n && Number.isFinite(x)) values[i] = Math.round(x * 100) / 100
    }
    return { metric: r.metric, values }
  })
}

const FS = 'fstype!~"tmpfs|overlay|rootfs|squashfs|devtmpfs"'
const WIN_FS = 'volume!~"HarddiskVolume.*"'
const Q = {
  up: 'up',
  probeOk: 'probe_success',
  probeStatus: 'probe_http_status_code',
  probeSec: 'probe_duration_seconds',
  probeDns: 'probe_dns_lookup_time_seconds',
  cert: 'probe_ssl_earliest_cert_expiry',
  cpu: '100 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100',
  mem: '(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100',
  memTotal: 'node_memory_MemTotal_bytes',
  fsSize: `node_filesystem_size_bytes{${FS}}`,
  fsAvail: `node_filesystem_avail_bytes{${FS}}`,
  load: 'node_load5',
  cores: 'count by (instance) (node_cpu_seconds_total{mode="idle"})',
  uptime: 'time() - node_boot_time_seconds',
  winCpu: '100 - avg by (instance) (rate(windows_cpu_time_total{mode="idle"}[5m])) * 100',
  winMem: '(1 - windows_memory_available_bytes / windows_memory_physical_total_bytes) * 100',
  winMemTotal: 'windows_memory_physical_total_bytes',
  winFsSize: `windows_logical_disk_size_bytes{${WIN_FS}}`,
  winFsFree: `windows_logical_disk_free_bytes{${WIN_FS}}`,
  heapUsed: 'java_lang_memory_heapmemoryusage_used',
  heapMax: 'java_lang_memory_heapmemoryusage_max',
  // Heap climbs between collections; its low point over a quarter of an hour is what the JVM cannot get back.
  heapFloor: 'min_over_time((java_lang_memory_heapmemoryusage_used / java_lang_memory_heapmemoryusage_max * 100)[15m:1m])',
  // What the last collection of each heap pool left (MemoryPool CollectionUsage), summed: the heap after GC.
  afterGc: 'sum by (instance) (jvm_memory_pool_collection_used_bytes)',
  jvmStart: 'java_lang_runtime_starttime',
  gc: 'sum by (instance) (rate(jvm_gc_collection_seconds_sum[5m])) * 100',
  threads: 'java_lang_threading_threadcount',
  fds: 'java_lang_operatingsystem_openfiledescriptorcount / java_lang_operatingsystem_maxfiledescriptorcount * 100',
  jvmCpu: 'java_lang_operatingsystem_processcpuload * 100',
  jvmUptime: 'java_lang_runtime_uptime / 1000',
  workers: 'apache_workers',
  apacheReq: 'rate(apache_accesses_total[5m])',
  apacheUp: 'apache_up'
} as const
const RANGE = {
  cpu: Q.cpu,
  heap: 'java_lang_memory_heapmemoryusage_used / java_lang_memory_heapmemoryusage_max * 100',
  probeMs: 'probe_duration_seconds * 1000',
  apacheReq: Q.apacheReq
} as const

type Instant = Record<keyof typeof Q, Sample[]>
type Ranges = Record<keyof typeof RANGE, Series[]>
interface PromAlert { labels: Labels; annotations?: Labels; state: string; activeAt?: string }
/** The after-GC floor over the last day (15-minute steps), for each JVM's leak verdict. */
interface Day { start: number; step: number; afterGc: Series[] }
const DAY_STEP = 900

async function gather(port: number): Promise<{ q: Instant; r: Ranges; alerts: PromAlert[]; day: Day }> {
  const end = Math.floor(Date.now() / 1000)
  const qs = Object.entries(Q) as [keyof typeof Q, string][]
  const rs = Object.entries(RANGE) as [keyof typeof RANGE, string][]
  const [qv, rv, alerts, afterGc] = await Promise.all([
    Promise.all(qs.map(([, query]) => instant(port, query).catch(() => [] as Sample[]))),
    Promise.all(rs.map(([, query]) => range(port, query, end).catch(() => [] as Series[]))),
    api<{ alerts: PromAlert[] }>(port, 'alerts', {}).then((d) => d.alerts, () => [] as PromAlert[]),
    range(port, `sum by (instance) (min_over_time(jvm_memory_pool_collection_used_bytes[${DAY_STEP}s]))`, end, 24 * 60, DAY_STEP).catch(() => [] as Series[])
  ])
  // Every instant query failing means Prometheus itself did not answer.
  if (qv.every((x) => !x.length)) await instant(port, 'up')
  return {
    q: Object.fromEntries(qs.map(([k], i) => [k, qv[i]])) as Instant,
    r: Object.fromEntries(rs.map(([k], i) => [k, rv[i]])) as Ranges,
    alerts,
    day: { start: (end - 24 * 3600) * 1000, step: DAY_STEP, afterGc }
  }
}

// ---------- who is who: environments, roles, EC2 ----------

const PORTS_HOST = /:(9100|9182)$/
const port = (instance: string): string => /:(\d+)(?:\/|$)/.exec(instance.replace(/^[a-z]+:\/\//i, ''))?.[1] ?? ''
const byInstance = (samples: Sample[]): Map<string, number> => new Map(samples.map((s) => [s.metric.instance, s.value]))

interface World {
  /** ip → environment, role and "01"/"02", from the servers' own exporters. */
  ipEnv: Map<string, PlmEnvId>
  ipRole: Map<string, string>
  ipLabel: Map<string, string>
  ec2: (ip: string | null) => Instance | undefined
}

function world(q: Instant, monitor: Instance): World {
  const ipEnv = new Map<string, PlmEnvId>()
  const ipRole = new Map<string, string>()
  const ipLabel = new Map<string, string>()
  for (const s of q.up) {
    const { job = '', instance = '' } = s.metric
    const ip = ipOf(instance)
    if (!ip || !PORTS_HOST.test(instance)) continue
    const env = envOf(job, instance)
    if (env) ipEnv.set(ip, env)
    const role = roleOf(job, instance)
    if (role) ipRole.set(ip, role.name)
    const label = nodeLabel(job)
    if (label) ipLabel.set(ip, label)
  }
  // The same private address can exist in two accounts' VPCs: prefer the monitoring server's VPC, then its account.
  const all = getCachedInventory()?.instances ?? []
  const byIp = new Map<string, Instance[]>()
  for (const i of all) if (i.privateIp) byIp.set(i.privateIp, [...(byIp.get(i.privateIp) ?? []), i])
  const ec2 = (ip: string | null): Instance | undefined => {
    const c = ip ? byIp.get(ip) : undefined
    if (!c?.length) return undefined
    return c.find((i) => i.vpcId && i.vpcId === monitor.vpcId) ?? c.find((i) => i.profile === monitor.profile) ?? c.find((i) => i.state === 'running') ?? c[0]
  }
  return { ipEnv, ipRole, ipLabel, ec2 }
}

/** The environments a series is about; a job like "QA and Dev CAD Converter" goes by the server's EC2 name, else both. */
function envsFor(w: World, job: string, instance: string): PlmEnvId[] {
  const direct = envOf(job, instance)
  if (direct) return [direct]
  const ip = ipOf(instance)
  const known = ip ? w.ipEnv.get(ip) : undefined
  if (known) return [known]
  const named = w.ec2(ip)?.name ?? ''
  const fromName = envOf(named.replace(/[-_]/g, ' '))
  if (fromName) return [fromName]
  const mentioned = ENV_ORDER.filter((e) => (e === 'prod' ? /\b(prod|production)\b/i : e === 'qa' ? /\bqa\b/i : /\b(dev|development)\b/i).test(job))
  return mentioned
}

const stoppedIn = (inst: Instance | undefined): boolean => !!inst && inst.state !== 'running' && inst.state !== 'pending'

// ---------- one environment ----------

function buildEnv(env: PlmEnvId, d: { q: Instant; r: Ranges; alerts: PromAlert[]; day: Day }, w: World, cloud: CloudPart | undefined, now: number): PlmEnvHealth {
  const { q, r } = d
  const issues: Issue[] = []
  const inEnv = (s: { metric: Labels }): boolean => envsFor(w, s.metric.job ?? '', s.metric.instance ?? '').includes(env)
  const spark = (series: Series[], instance: string): Spark | undefined => series.find((s) => s.metric.instance === instance)?.values
  const nameOf = (ip: string | null, fallback: string): string => w.ec2(ip)?.name ?? fallback
  const upOf = byInstance(q.up)

  // Servers (node and Windows exporters).
  const cpu = byInstance(q.cpu)
  const mem = byInstance(q.mem)
  const memTotal = byInstance(q.memTotal)
  const load = byInstance(q.load)
  const cores = byInstance(q.cores)
  const uptime = byInstance(q.uptime)
  const winCpu = byInstance(q.winCpu)
  const winMem = byInstance(q.winMem)
  const winMemTotal = byInstance(q.winMemTotal)
  const disks = new Map<string, DiskUse[]>()
  const storageMap = new Map<string, StorageHealth>()
  const addDisk = (instance: string, mount: string, device: string, fstype: string, size: number, free: number, windows: boolean): void => {
    if (!(size > 0)) return
    const pct = ((size - free) / size) * 100
    const shared = /^nfs|cifs|smb/i.test(fstype)
    disks.set(instance, [...(disks.get(instance) ?? []), { mount, pct, shared }])
    const ip = ipOf(instance)
    const key = shared ? device : `${instance}|${mount}`
    const level = levelOf(pct, windows ? LIMITS.diskWindows : LIMITS.disk)
    const had = storageMap.get(key)
    const hostName = `${w.ipRole.get(ip ?? '') ?? nameOf(ip, instance)}${w.ipLabel.get(ip ?? '') ? ` ${w.ipLabel.get(ip ?? '')}` : ''}`
    if (had) { if (!had.hosts.includes(hostName)) had.hosts.push(hostName) } else storageMap.set(key, { mount, device, shared, hosts: [hostName], pct, usedBytes: size - free, sizeBytes: size, level })
  }
  const fsAvail = new Map(q.fsAvail.map((s) => [`${s.metric.instance}|${s.metric.mountpoint}`, s.value]))
  for (const s of q.fsSize) if (inEnv(s)) addDisk(s.metric.instance, s.metric.mountpoint, s.metric.device ?? '', s.metric.fstype ?? '', s.value, fsAvail.get(`${s.metric.instance}|${s.metric.mountpoint}`) ?? NaN, false)
  const winFree = new Map(q.winFsFree.map((s) => [`${s.metric.instance}|${s.metric.volume}`, s.value]))
  for (const s of q.winFsSize) if (inEnv(s)) addDisk(s.metric.instance, s.metric.volume, s.metric.volume, 'ntfs', s.value, winFree.get(`${s.metric.instance}|${s.metric.volume}`) ?? NaN, true)

  const hosts: HostHealth[] = []
  const hostDown = new Set<string>()
  for (const s of q.up) {
    const { job = '', instance = '' } = s.metric
    if (!PORTS_HOST.test(instance) || !inEnv(s)) continue
    const role = roleOf(job, instance)
    if (role?.id === 'monitoring') continue
    const ip = ipOf(instance) ?? instance
    const inst = w.ec2(ip)
    const windows = instance.endsWith(':9182')
    const reporting = s.value === 1
    const stopped = stoppedIn(inst)
    const label = nodeLabel(job)
    const roleName = role?.name ?? job
    const worstDisk = fullestDisk(disks.get(instance) ?? [], windows)
    const sharedStores = (disks.get(instance) ?? []).filter((d) => d.shared).map((d) => ({ mount: d.mount, pct: d.pct, level: levelOf(d.pct, LIMITS.disk) }))
    const c = (windows ? winCpu : cpu).get(instance) ?? null
    const m = (windows ? winMem : mem).get(instance) ?? null
    const problems: string[] = []
    let level: Level
    if (!reporting) {
      level = stopped ? 'off' : 'crit'
      if (!stopped) { hostDown.add(ip); problems.push(inst ? 'Not reporting: the server is running but its exporter does not answer' : 'Not reporting') }
    } else {
      const lc = levelOf(c, LIMITS.cpu)
      const lm = levelOf(m, LIMITS.mem)
      const ld = levelOf(worstDisk?.pct, windows ? LIMITS.diskWindows : LIMITS.disk)
      if (lc !== 'ok' && lc !== 'unknown') problems.push(`CPU at ${formatPct(c)}`)
      if (lm !== 'ok' && lm !== 'unknown') problems.push(`Memory at ${formatPct(m)}`)
      if (ld !== 'ok' && ld !== 'unknown' && worstDisk) problems.push(`${worstDisk.mount} is ${formatPct(worstDisk.pct)} full`)
      level = worst([lc, lm, ld])
    }
    const h: HostHealth = {
      ip, name: inst?.name ?? instance, role: roleName, label, level, problems,
      state: inst ? (stopped ? 'stopped' : 'running') : 'unknown',
      reporting, os: windows ? 'windows' : 'linux',
      cpu: reporting ? c : null, mem: reporting ? m : null, memBytes: (windows ? winMemTotal : memTotal).get(instance) ?? null,
      disk: reporting ? worstDisk : null, sharedStores: reporting && sharedStores.length ? sharedStores : undefined, load: load.get(instance) ?? null, cores: cores.get(instance) ?? null, uptimeSec: uptime.get(instance) ?? null,
      cpuSpark: windows ? undefined : spark(r.cpu, instance), instanceKey: inst?.key, instanceType: inst?.instanceType
    }
    hosts.push(h)
    // Disk and memory problems are listed with storage and per server; an unreachable server is listed once here.
    if (level === 'crit' || level === 'warn') {
      if (!reporting) issues.push({ level, text: `${roleName}${label ? ` ${label}` : ''} is not reporting (${inst?.name ?? ip})`, section: 'servers' })
      else for (const p of problems.filter((x) => !/full$/.test(x))) issues.push({ level, text: `${roleName}${label ? ` ${label}` : ''}: ${p}`, section: 'servers' })
    }
  }
  const order = (l: Level): number => ({ crit: 0, warn: 1, unknown: 2, ok: 3, off: 4 })[l]
  hosts.sort((a, b) => order(a.level) - order(b.level) || a.role.localeCompare(b.role) || a.label.localeCompare(b.label))

  // Storage: shared file stores once, with every server that mounts them; tiny boot partitions only when they fill up.
  const storage = [...storageMap.values()]
    .filter((s) => s.sizeBytes >= 4 * 1024 ** 3 || s.level !== 'ok')
    .sort((a, b) => b.pct - a.pct)
  for (const s of storage) {
    if (s.level === 'crit' || s.level === 'warn') issues.push({ level: s.level, text: `${s.shared ? 'Shared store' : s.hosts[0]} ${s.mount} is ${formatPct(s.pct)} full`, section: 'storage' })
  }

  // Services: the load balancer's checks (what users reach) and each server's.
  const status = byInstance(q.probeStatus)
  const okBy = byInstance(q.probeOk)
  const secs = byInstance(q.probeSec)
  const byRole = new Map<string, { fronts: Endpoint[]; nodes: ServiceNode[] }>()
  const dns = byInstance(q.probeDns)
  const certBy = byInstance(q.cert)
  const checks: HealthCheck[] = []
  for (const s of q.probeOk) {
    const { job = '', instance = '' } = s.metric
    if (!inEnv(s)) continue
    const role = roleOf(job, instance)
    if (!role || role.id === 'monitoring' || role.id === 'allinone' || role.id === 'migration') continue
    const code = status.get(instance) ?? null
    const ms = secs.has(instance) ? (secs.get(instance) ?? 0) * 1000 : null
    const ok = probeOk(code, okBy.get(instance) ?? null)
    const ep: Endpoint = { url: instance, level: ok ? (ms !== null && ms >= LIMITS.albMs[0] ? 'warn' : 'ok') : 'crit', status: code, ms, spark: spark(r.probeMs, instance) }
    const slot = byRole.get(role.id) ?? { fronts: [], nodes: [] }
    const certExp = certBy.get(instance)
    const check: HealthCheck = {
      serviceId: role.id, service: role.name, url: instance, via: isFrontProbe(job, instance) ? 'lb' : 'server', label: '', level: ep.level, status: code, ms,
      dnsMs: dns.has(instance) ? (dns.get(instance) ?? 0) * 1000 : null, certDays: certExp ? Math.floor((certExp * 1000 - now) / 86_400_000) : null, stopped: false, note: checkNote(instance)
    }
    checks.push(check)
    if (isFrontProbe(job, instance)) slot.fronts.push(ep)
    else {
      const ip = ipOf(instance)
      const inst = w.ec2(ip)
      const stopped = stoppedIn(inst)
      // "01", or the server's own role when it has no number (search on the 3DSwym machine), and which check it is
      // when one server has two (3DSpace's own page and its internal one).
      const hostRole = ip ? w.ipRole.get(ip) : undefined
      const base = (ip && w.ipLabel.get(ip)) || (hostRole && hostRole !== role.name ? hostRole : 'server')
      const label = /\/internal\//.test(instance) ? `${base} internal` : base
      slot.nodes.push({ ...ep, level: stopped ? 'off' : ep.level, label, ip, name: inst?.name ?? (ip ?? instance), stopped, instanceKey: inst?.key })
      Object.assign(check, { label, stopped, level: stopped ? 'off' : ep.level })
    }
    byRole.set(role.id, slot)
  }
  // A check whose scrape fails (the blackbox exporter down, a module it lacks) has no probe_success at all: show it as
  // not running rather than letting its service vanish.
  const scrapeError = new Map<string, string>()
  for (const s of q.up) {
    const { job = '', instance = '' } = s.metric
    if (s.value === 1 || !/^[a-z]+:\/\//i.test(instance) || okBy.has(instance) || !inEnv(s)) continue
    const role = roleOf(job, instance)
    if (!role || role.id === 'monitoring' || role.id === 'allinone' || role.id === 'migration') continue
    const ep: Endpoint = { url: instance, level: 'unknown', status: null, ms: null }
    const slot = byRole.get(role.id) ?? { fronts: [], nodes: [] }
    const ip = ipOf(instance)
    const inst = w.ec2(ip)
    if (isFrontProbe(job, instance)) slot.fronts.push(ep)
    else slot.nodes.push({ ...ep, label: (ip && w.ipLabel.get(ip)) || 'server', ip, name: inst?.name ?? (ip ?? instance), stopped: stoppedIn(inst), instanceKey: inst?.key })
    byRole.set(role.id, slot)
    scrapeError.set(instance, role.name)
    checks.push({ serviceId: role.id, service: role.name, url: instance, via: isFrontProbe(job, instance) ? 'lb' : 'server', label: (ip && w.ipLabel.get(ip)) || 'server', level: 'unknown', status: null, ms: null, dnsMs: null, certDays: null, stopped: stoppedIn(inst), note: checkNote(instance), broken: 'The probe itself fails, so this check is not running' })
  }
  if (scrapeError.size) {
    const names = [...new Set(scrapeError.values())]
    issues.push({ level: 'warn', text: `${names.join(', ')}: ${scrapeError.size === 1 ? 'its health check is' : 'health checks are'} not running (the probe fails)`, section: 'services' })
  }
  // Apache without an HTTP check (Production's): the Apache exporter reads Apache's own status page, which is a check
  // of the server process itself: up, Apache not answering, or the exporter silent.
  const apacheSlot = byRole.get('apache')
  if (!apacheSlot || (!apacheSlot.fronts.length && !apacheSlot.nodes.length)) {
    const apacheUp = byInstance(q.apacheUp)
    for (const s of q.up) {
      const { job = '', instance = '' } = s.metric
      if (port(instance) !== '9117' || !inEnv(s)) continue
      const ip = ipOf(instance)
      const inst = w.ec2(ip)
      const stopped = stoppedIn(inst)
      const level: Level = stopped ? 'off' : s.value !== 1 ? 'unknown' : apacheUp.get(instance) === 1 ? 'ok' : 'crit'
      const label = nodeLabel(job) || (ip ? w.ipLabel.get(ip) ?? 'server' : 'server')
      const url = `http://${ip ?? instance}:9117 (Apache status)`
      const slot = byRole.get('apache') ?? { fronts: [], nodes: [] }
      slot.nodes.push({ url, level, status: level === 'ok' ? 200 : null, ms: null, label, ip, name: inst?.name ?? (ip ?? instance), stopped, instanceKey: inst?.key })
      byRole.set('apache', slot)
      checks.push({ serviceId: 'apache', service: 'Apache web tier', url, via: 'server', label, level, status: level === 'ok' ? 200 : null, ms: null, dnsMs: null, certDays: null, stopped,
        note: "Apache's own status page, read by the Apache exporter (there is no HTTP health check here)", broken: level === 'unknown' ? 'The Apache exporter does not answer' : undefined })
    }
  }
  // Parts of the platform whose servers are monitored but which nothing checks: a card that says so.
  for (const h of hosts) {
    const role = ROLES.find((r) => r.name === h.role)
    if (!role || !SERVICE_ORDER.includes(role.id) || byRole.has(role.id)) continue
    byRole.set(role.id, { fronts: [], nodes: [] })
  }
  const services: ServiceHealth[] = []
  for (const [id, slot] of byRole) {
    const role = ROLES.find((x) => x.id === id)!
    // The main page first (3DSpace's own check before its internal one).
    slot.fronts.sort((a, b) => Number(/\/internal\//.test(a.url)) - Number(/\/internal\//.test(b.url)))
    slot.nodes.sort((a, b) => a.label.localeCompare(b.label) || a.url.localeCompare(b.url))
    let { level, summary } = serviceLevel(slot.fronts, slot.nodes)
    if (!slot.fronts.length && !slot.nodes.length) {
      // Checked in another environment but not this one: name where, so it reads as a gap here, not a mistake.
      const elsewhere = ENV_ORDER.filter((e2) => e2 !== env && q.probeOk.some((p) => roleOf(p.metric.job ?? '', p.metric.instance ?? '')?.id === id && envsFor(w, p.metric.job ?? '', p.metric.instance ?? '').includes(e2)))
      if (elsewhere.length) summary = `Not checked here: its health check covers ${elsewhere.map((e2) => ENV_NAMES[e2]).join(' and ')} only`
      level = 'unknown'
    }
    services.push({ id, name: role.name, blurb: role.blurb, level, summary, fronts: slot.fronts, nodes: slot.nodes })
    if ((level === 'crit' || level === 'warn') && !summary.startsWith('Its health check')) issues.push({ level, text: `${role.name}: ${summary.split(' · ')[0].toLowerCase()}`, section: 'services' })
  }
  services.sort((a, b) => (SERVICE_ORDER.indexOf(a.id) + 1 || 99) - (SERVICE_ORDER.indexOf(b.id) + 1 || 99))
  const svcRank = (id: string): number => SERVICE_ORDER.indexOf(id) + 1 || 99
  checks.sort((a, b) => svcRank(a.serviceId) - svcRank(b.serviceId) || Number(a.via === 'server') - Number(b.via === 'server') || a.label.localeCompare(b.label) || a.url.localeCompare(b.url))

  // 3DSpace's JVMs (the JMX exporter).
  const heapUsed = byInstance(q.heapUsed)
  const heapMax = byInstance(q.heapMax)
  const heapFloor = byInstance(q.heapFloor)
  const afterGc = byInstance(q.afterGc)
  const jvmStart = byInstance(q.jvmStart)
  const dayTimes = (n: number): number[] => Array.from({ length: n }, (_, i) => d.day.start + i * d.day.step * 1000)
  const gc = byInstance(q.gc)
  const threads = byInstance(q.threads)
  const fds = byInstance(q.fds)
  const jvmCpu = byInstance(q.jvmCpu)
  const jvmUp = byInstance(q.jvmUptime)
  const jvms: JvmHealth[] = []
  for (const s of q.up) {
    const { job = '', instance = '' } = s.metric
    if (port(instance) !== '9404' || !inEnv(s)) continue
    const ip = ipOf(instance)
    const inst = w.ec2(ip)
    const reporting = s.value === 1
    const used = heapUsed.get(instance) ?? null
    const max = heapMax.get(instance) ?? null
    const heapPct = used !== null && max && max > 0 ? (used / max) * 100 : null
    const floor = heapFloor.get(instance) ?? null
    const after = afterGc.get(instance) ?? null
    const afterPct = after !== null && max && max > 0 ? (after / max) * 100 : null
    const startedAt = jvmStart.get(instance) ?? null
    const daySeries = d.day.afterGc.find((x) => x.metric.instance === instance)?.values
    const trend = daySeries ? gcTrend(dayTimes(daySeries.length), daySeries, max, startedAt) : undefined
    // The after-GC floor and its trend say whether memory is being lost; the heap's own level only climbs and falls.
    const lh = trend && trend.level !== 'unknown' ? trend.level : levelOf(floor ?? heapPct, LIMITS.heap)
    const lg = levelOf(gc.get(instance), LIMITS.gc)
    const lf = levelOf(fds.get(instance), LIMITS.fds)
    const problems: string[] = []
    if (lh === 'warn' || lh === 'crit') {
      if (trend && trend.level === lh && trend.daysToMax !== null && (trend.floorPct ?? 0) < 80) problems.push(`heap after GC growing ${formatBytes(trend.slopePerDay)} a day, full in ${Math.max(1, Math.round(trend.daysToMax))} ${Math.round(trend.daysToMax) === 1 ? 'day' : 'days'}: possible memory leak`)
      else problems.push(`heap stays at ${formatPct(afterPct ?? floor ?? heapPct)} after GC${lh === 'crit' ? ': likely a memory leak' : ''}`)
    }
    if (lg === 'warn' || lg === 'crit') problems.push(`${formatPct(gc.get(instance))} of the time in garbage collection`)
    if (lf === 'warn' || lf === 'crit') problems.push(`${formatPct(fds.get(instance))} of file handles in use`)
    const level: Level = !reporting ? (stoppedIn(inst) ? 'off' : 'crit') : worst([lh, lg, lf])
    const label = nodeLabel(job) || (ip ? w.ipLabel.get(ip) ?? '' : '')
    jvms.push({
      label, ip, name: inst?.name ?? instance, promInstance: instance, level, problems, reporting,
      heapUsed: used, heapMax: max, heapPct, afterGcBytes: after, afterGcPct: afterPct, trend, startedAt, gcPct: gc.get(instance) ?? null, threads: threads.get(instance) ?? null, fdsPct: fds.get(instance) ?? null,
      cpu: jvmCpu.get(instance) ?? null, uptimeSec: jvmUp.get(instance) ?? null, heapSpark: spark(r.heap, instance), instanceKey: inst?.key
    })
    const who = label ? `3DSpace ${label}` : '3DSpace'
    if (!reporting && level === 'crit' && !(ip && hostDown.has(ip))) issues.push({ level, text: `${who}: JVM metrics are not answering`, section: 'jvm' })
    else for (const p of problems) issues.push({ level: level === 'crit' ? 'crit' : 'warn', text: `${who}: ${p}`, section: 'jvm' })
  }
  jvms.sort((a, b) => a.label.localeCompare(b.label))

  // Apache.
  const busy = new Map<string, number>()
  const idle = new Map<string, number>()
  for (const s of q.workers) (s.metric.state === 'busy' ? busy : idle).set(s.metric.instance, s.value)
  const req = byInstance(q.apacheReq)
  const apaches: ApacheHealth[] = []
  for (const s of q.up) {
    const { job = '', instance = '' } = s.metric
    if (port(instance) !== '9117' || !inEnv(s)) continue
    const ip = ipOf(instance)
    const inst = w.ec2(ip)
    const reporting = s.value === 1 && upOf.get(instance) !== 0
    const b = busy.get(instance) ?? null
    const i = idle.get(instance) ?? null
    const pct = b !== null && i !== null && b + i > 0 ? (b / (b + i)) * 100 : null
    const level: Level = !reporting ? (stoppedIn(inst) ? 'off' : 'crit') : levelOf(pct, LIMITS.apacheBusy)
    const label = nodeLabel(job) || (ip ? w.ipLabel.get(ip) ?? '' : '')
    apaches.push({ label, ip, name: inst?.name ?? instance, level, reporting, busy: b, idle: i, reqPerSec: req.get(instance) ?? null, spark: spark(r.apacheReq, instance) })
    if (level === 'warn' || level === 'crit') {
      const who = label ? `Apache ${label}` : 'Apache'
      if (!reporting) { if (!(ip && hostDown.has(ip))) issues.push({ level, text: `${who}: metrics are not answering`, section: 'web' }) }
      else issues.push({ level, text: `${who}: ${formatPct(pct)} of workers busy`, section: 'web' })
    }
  }
  apaches.sort((a, b) => a.label.localeCompare(b.label))

  // Certificates of the public addresses.
  const certMap = new Map<string, number>()
  for (const s of q.cert) {
    if (!inEnv(s)) continue
    const host = urlHost(s.metric.instance)
    // Public names only: the servers' own addresses share the same certificate and would only repeat it.
    if (host && !ipOf(s.metric.instance)) certMap.set(host, Math.min(certMap.get(host) ?? Infinity, s.value))
  }
  const certs: CertHealth[] = [...certMap].map(([host, exp]) => {
    const days = Math.floor((exp * 1000 - now) / 86_400_000)
    return { host, days, expires: exp * 1000, level: levelBelow(days, LIMITS.certDays) }
  }).sort((a, b) => a.days - b.days)
  const soon = certs.filter((c) => c.level === 'crit' || c.level === 'warn')
  if (soon.length) issues.push({ level: worst(soon.map((c) => c.level)), text: `${soon.length === 1 ? `The certificate for ${soon[0].host} expires` : `${soon.length} certificates expire`} in ${soon[0].days} days`, section: 'certs' })

  // Prometheus's own alerts, with the ones about stopped servers set aside.
  const alerts: AlertItem[] = d.alerts
    .filter((a) => a.state === 'firing' && envsFor(w, a.labels.job ?? '', a.labels.instance ?? '').includes(env))
    .map((a) => {
      const inst = a.labels.instance ?? ''
      const ip = ipOf(inst)
      const role = roleOf(a.labels.job ?? '', inst)
      const label = ip ? w.ipLabel.get(ip) ?? '' : ''
      const muted = stoppedIn(w.ec2(ip))
      const target = urlHost(inst) || `${role?.name ?? a.labels.job ?? inst}${label ? ` ${label}` : ''}`
      return {
        name: a.labels.alertname ?? 'Alert', severity: a.labels.severity ?? '', summary: (a.annotations?.summary ?? a.annotations?.description ?? '').trim(), target,
        since: a.activeAt ? Date.parse(a.activeAt) : null, level: muted ? 'off' : a.labels.severity === 'warning' ? 'warn' : 'crit', muted
      } satisfies AlertItem
    })
    .sort((a, b) => Number(a.muted) - Number(b.muted) || (b.since ?? 0) - (a.since ?? 0))

  const gaps = [...(cloud?.gaps ?? [])]
  // The kernel is read only for the environment on screen; what it last said counts while it is fresh.
  const kern = kernelCache.get(env)
  if (kern && now - kern.at < 3 * 60_000) {
    for (const s of kern.d.servers) {
      const who = s.label ? `3DSpace ${s.label}` : '3DSpace'
      if (!s.reachable) issues.push({ level: 'warn', text: `${who}: kernel monitoring does not answer`, section: 'kernel' })
      else if (s.dbExceeded) issues.push({ level: 'warn', text: `${who}: database connections went over the limit ${s.dbExceeded} times`, section: 'kernel' })
      else if (s.level === 'warn' || s.level === 'crit') issues.push({ level: s.level, text: `${who}: kernel memory near its limit`, section: 'kernel' })
    }
    if (kern.d.license && kern.d.license.level !== 'ok') issues.push({ level: 'crit', text: `License server is ${kern.d.license.status.toLowerCase()}`, section: 'kernel' })
  }
  if (cloud?.db) for (const p of cloud.db.problems) issues.push({ level: cloud.db.level === 'crit' ? 'crit' : 'warn', text: `Database: ${p}`, section: 'db' })
  for (const a of cloud?.albs ?? []) for (const p of a.problems) issues.push({ level: a.level === 'crit' ? 'crit' : 'warn', text: `${a.internal ? 'Internal load balancer' : 'Load balancer'}: ${p}`, section: 'alb' })

  const v = verdict(issues, services)
  return {
    id: env, name: ENV_NAMES[env], level: v.level, headline: v.headline, issues: v.issues,
    services, checks, hosts, jvms, apaches, storage, db: cloud?.db ?? null, albs: cloud?.albs ?? [], certs, alerts, gaps
  }
}

// ---------- CloudWatch: the database and the load balancers ----------

interface CloudPart { db: DbHealth | null; albs: AlbHealth[]; gaps: string[] }
interface Discovered { profile: string; region: string; albs: { name: string; dim: string; internal: boolean; groups: string[] }[]; dbId: string | null; at: number }

const discovered = new Map<PlmEnvId, Discovered>()
const cloudCache = new Map<PlmEnvId, { at: number; part: CloudPart }>()
const DISCOVER_MS = 30 * 60_000
const CLOUD_MS = 3 * 60_000

/** "3dexperience-prod-alb-479550286.us-west-1.elb.amazonaws.com" → the load balancer's name. */
export function albNameOf(dns: string): string | null {
  const m = /^(internal-)?(.+)-\d+\.[a-z0-9-]+\.elb\.amazonaws\.com\.?$/i.exec(dns)
  return m ? m[2] : null
}

async function discover(env: PlmEnvId, d: { q: Instant }, w: World, cw: (profile: string, region: string) => CloudWatchClient): Promise<Discovered> {
  const have = discovered.get(env)
  if (have && Date.now() - have.at < DISCOVER_MS) return have
  // The account that runs the environment's servers.
  const counts = new Map<string, { n: number; region: string }>()
  for (const s of d.q.up) {
    if (!PORTS_HOST.test(s.metric.instance ?? '') || !envsFor(w, s.metric.job ?? '', s.metric.instance ?? '').includes(env)) continue
    const inst = w.ec2(ipOf(s.metric.instance))
    if (inst) counts.set(inst.profile, { n: (counts.get(inst.profile)?.n ?? 0) + 1, region: inst.region })
  }
  const top = [...counts].sort((a, b) => b[1].n - a[1].n)[0]
  if (!top) throw new Error('none of its servers are in the host list')
  const [profile, { region }] = top
  // Its load balancers: where the public addresses it checks point.
  const hosts = new Set(d.q.probeOk.filter((s) => isFrontProbe(s.metric.job ?? '', s.metric.instance ?? '') && envOf(s.metric.job ?? '', s.metric.instance ?? '') === env).map((s) => urlHost(s.metric.instance)))
  const names = new Map<string, boolean>()
  await Promise.all([...hosts].map(async (h) => {
    try {
      for (const c of await resolveCname(h)) { const n = albNameOf(c); if (n) names.set(n, c.startsWith('internal-')) }
    } catch { /* not a CNAME */ }
  }))
  const client = cw(profile, region)
  const albs: Discovered['albs'] = []
  if (names.size) {
    const lbs = await client.send(new ListMetricsCommand({ Namespace: 'AWS/ApplicationELB', MetricName: 'RequestCount', Dimensions: [{ Name: 'LoadBalancer' }] }))
    for (const m of lbs.Metrics ?? []) {
      const dim = m.Dimensions?.find((x) => x.Name === 'LoadBalancer')?.Value
      const name = dim?.split('/')[1]
      if (!dim || !name || !names.has(name) || (m.Dimensions?.length ?? 0) !== 1 || albs.some((a) => a.dim === dim)) continue
      const tg = await client.send(new ListMetricsCommand({ Namespace: 'AWS/ApplicationELB', MetricName: 'HealthyHostCount', Dimensions: [{ Name: 'LoadBalancer', Value: dim }] }))
      const groups = [...new Set((tg.Metrics ?? []).filter((x) => x.Dimensions?.length === 2).map((x) => x.Dimensions!.find((y) => y.Name === 'TargetGroup')?.Value).filter((x): x is string => !!x))]
      albs.push({ name, dim, internal: names.get(name)!, groups })
    }
  }
  // Its database: the Oracle or SQL Server instance named for the environment.
  const rds = new RDSClient({ region, credentials: credentialsFor(profile) })
  let dbId: string | null = null
  try {
    const out = await rds.send(new DescribeDBInstancesCommand({}))
    const token = env === 'prod' ? /(^|[-_])prod/i : env === 'qa' ? /(^|[-_])qa([-_]|$)/i : /(^|[-_])dev([-_]|$)/i
    dbId = (out.DBInstances ?? []).find((x) => /oracle|sqlserver/i.test(x.Engine ?? '') && token.test(x.DBInstanceIdentifier ?? ''))?.DBInstanceIdentifier ?? null
  } finally { rds.destroy() }
  const result: Discovered = { profile, region, albs, dbId, at: Date.now() }
  discovered.set(env, result)
  return result
}

const last = (r: MetricDataResult | undefined): number | null => {
  const v = r?.Values ?? []
  return v.length ? v[v.length - 1] : null
}
const series = (r: MetricDataResult | undefined, scale = 1): Spark => (r?.Values ?? []).map((v) => Math.round(v * scale * 100) / 100)

async function cloud(env: PlmEnvId, d: { q: Instant }, w: World): Promise<CloudPart> {
  const cached = cloudCache.get(env)
  if (cached && Date.now() - cached.at < CLOUD_MS) return cached.part
  const clients: CloudWatchClient[] = []
  const cw = (profile: string, region: string): CloudWatchClient => {
    const c = new CloudWatchClient({ region, credentials: credentialsFor(profile) })
    clients.push(c)
    return c
  }
  const part: CloudPart = { db: null, albs: [], gaps: [] }
  try {
    const found = await discover(env, d, w, cw).catch((e: Error) => { part.gaps.push(`Database and load balancers: ${e.message}`); return null })
    if (!found) return part
    const client = cw(found.profile, found.region)
    const end = new Date()
    const queries: MetricDataQuery[] = []
    const stat = (id: string, ns: string, metric: string, dims: Record<string, string>, s: string): void => {
      queries.push({ Id: id, MetricStat: { Metric: { Namespace: ns, MetricName: metric, Dimensions: Object.entries(dims).map(([Name, Value]) => ({ Name, Value })) }, Period: 300, Stat: s } })
    }
    let rdsInfo: { engine: string; cls: string; status: string; multiAz: boolean; bytes: number } | null = null
    if (found.dbId) {
      const db = { DBInstanceIdentifier: found.dbId }
      stat('dbcpu', 'AWS/RDS', 'CPUUtilization', db, 'Average')
      stat('dbconn', 'AWS/RDS', 'DatabaseConnections', db, 'Average')
      stat('dbfree', 'AWS/RDS', 'FreeStorageSpace', db, 'Minimum')
      stat('dbmem', 'AWS/RDS', 'FreeableMemory', db, 'Minimum')
      stat('dbread', 'AWS/RDS', 'ReadLatency', db, 'Average')
      stat('dbwrite', 'AWS/RDS', 'WriteLatency', db, 'Average')
      const rds = new RDSClient({ region: found.region, credentials: credentialsFor(found.profile) })
      try {
        const x = (await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: found.dbId }))).DBInstances?.[0]
        if (x) rdsInfo = { engine: `${x.Engine ?? ''} ${(x.EngineVersion ?? '').split('.')[0]}`.trim(), cls: x.DBInstanceClass ?? '', status: x.DBInstanceStatus ?? '', multiAz: !!x.MultiAZ, bytes: (x.AllocatedStorage ?? 0) * 1024 ** 3 }
      } catch (e) { part.gaps.push(`Database details: ${(e as Error).message}`) } finally { rds.destroy() }
    }
    found.albs.forEach((a, i) => {
      const lb = { LoadBalancer: a.dim }
      stat(`req${i}`, 'AWS/ApplicationELB', 'RequestCount', lb, 'Sum')
      stat(`t5x${i}`, 'AWS/ApplicationELB', 'HTTPCode_Target_5XX_Count', lb, 'Sum')
      stat(`e5x${i}`, 'AWS/ApplicationELB', 'HTTPCode_ELB_5XX_Count', lb, 'Sum')
      stat(`lat${i}`, 'AWS/ApplicationELB', 'TargetResponseTime', lb, 'Average')
      a.groups.slice(0, 40).forEach((tg, j) => {
        stat(`h${i}_${j}`, 'AWS/ApplicationELB', 'HealthyHostCount', { TargetGroup: tg, LoadBalancer: a.dim }, 'Minimum')
        stat(`u${i}_${j}`, 'AWS/ApplicationELB', 'UnHealthyHostCount', { TargetGroup: tg, LoadBalancer: a.dim }, 'Maximum')
      })
    })
    if (!queries.length) {
      part.gaps.push('No database or load balancer found for this environment')
      return part
    }
    const res = new Map<string, MetricDataResult>()
    let next: string | undefined
    do {
      const out = await client.send(new GetMetricDataCommand({ StartTime: new Date(end.getTime() - 3 * 3600_000), EndTime: end, ScanBy: 'TimestampAscending', MetricDataQueries: queries, NextToken: next }))
      for (const m of out.MetricDataResults ?? []) if (m.Id) res.set(m.Id, { ...m, Values: [...(res.get(m.Id)?.Values ?? []), ...(m.Values ?? [])] })
      next = out.NextToken
    } while (next)

    if (found.dbId) {
      const cpuV = last(res.get('dbcpu'))
      const free = last(res.get('dbfree'))
      const readMs = last(res.get('dbread')) === null ? null : last(res.get('dbread'))! * 1000
      const writeMs = last(res.get('dbwrite')) === null ? null : last(res.get('dbwrite'))! * 1000
      const freePct = free !== null && rdsInfo?.bytes ? (free / rdsInfo.bytes) * 100 : null
      const problems: string[] = []
      const lStatus: Level = rdsInfo && rdsInfo.status !== 'available' ? 'crit' : 'ok'
      if (lStatus === 'crit') problems.push(`status is ${rdsInfo!.status}`)
      const lc = levelOf(cpuV, LIMITS.dbCpu)
      if (lc === 'warn' || lc === 'crit') problems.push(`CPU at ${formatPct(cpuV)}`)
      const lf = levelBelow(freePct, [20, 10])
      if (lf === 'warn' || lf === 'crit') problems.push(`${formatPct(freePct)} of storage free`)
      const lat = Math.max(readMs ?? 0, writeMs ?? 0)
      const ll = levelOf(readMs === null && writeMs === null ? null : lat, LIMITS.dbLatencyMs)
      if (ll === 'warn' || ll === 'crit') problems.push(`disk latency ${formatMs(lat)}`)
      part.db = {
        id: found.dbId, engine: rdsInfo?.engine ?? '', instanceClass: rdsInfo?.cls ?? '', status: rdsInfo?.status ?? 'unknown', multiAz: rdsInfo?.multiAz ?? false,
        level: worst([lStatus, lc, lf, ll]), problems, cpu: cpuV, connections: last(res.get('dbconn')), freeStorageBytes: free, storageBytes: rdsInfo?.bytes ?? null,
        freeMemBytes: last(res.get('dbmem')), readLatencyMs: readMs, writeLatencyMs: writeMs, cpuSpark: series(res.get('dbcpu')), connSpark: series(res.get('dbconn'))
      }
    }
    part.albs = found.albs.map((a, i) => {
      const reqs = res.get(`req${i}`)
      const recent = (id: string): number | null => {
        const v = res.get(id)?.Values ?? []
        return v.length ? v.slice(-3).reduce((x, y) => x + y, 0) : null
      }
      const healthy = a.groups.slice(0, 40).reduce((n, _, j) => n + (last(res.get(`h${i}_${j}`)) ?? 0), 0)
      const unhealthy = a.groups.slice(0, 40).reduce((n, _, j) => n + (last(res.get(`u${i}_${j}`)) ?? 0), 0)
      const lastReq = last(reqs)
      // CloudWatch has no data points for zero errors: with traffic, none means none.
      const hadTraffic = (reqs?.Values?.length ?? 0) > 0
      const t5 = recent(`t5x${i}`) ?? (hadTraffic ? 0 : null)
      const e5 = recent(`e5x${i}`) ?? (hadTraffic ? 0 : null)
      const latS = last(res.get(`lat${i}`))
      const problems: string[] = []
      const lu: Level = a.groups.length ? (unhealthy > 0 ? (healthy === 0 ? 'crit' : 'warn') : 'ok') : 'unknown'
      if (lu !== 'ok' && lu !== 'unknown') problems.push(`${unhealthy} unhealthy ${unhealthy === 1 ? 'target' : 'targets'}`)
      const total = recent(`req${i}`) ?? 0
      const errRate = total > 0 ? (((t5 ?? 0) + (e5 ?? 0)) / total) * 100 : 0
      // A stray error is not a problem; a share of the traffic, or several from the balancer itself, is.
      const l5: Level = errRate >= 5 ? 'crit' : errRate >= 1 || (e5 ?? 0) >= 5 ? 'warn' : 'ok'
      const n5 = Math.round((t5 ?? 0) + (e5 ?? 0))
      if (l5 !== 'ok') problems.push(`${n5} server ${n5 === 1 ? 'error' : 'errors'} (5xx) in 15 minutes`)
      const ll = levelOf(latS === null ? null : latS * 1000, LIMITS.albMs)
      if (ll === 'warn' || ll === 'crit') problems.push(`responses take ${formatMs(latS! * 1000)}`)
      return {
        name: a.name, internal: a.internal, level: worst([lu, l5, ll]), problems,
        requestsPerMin: lastReq === null ? null : lastReq / 5, target5xx: t5, elb5xx: e5, responseMs: latS === null ? null : latS * 1000,
        healthy: a.groups.length ? healthy : null, unhealthy: a.groups.length ? unhealthy : null,
        reqSpark: series(reqs, 1 / 5), latencySpark: series(res.get(`lat${i}`), 1000)
      }
    })
    cloudCache.set(env, { at: Date.now(), part })
    return part
  } catch (e) {
    part.gaps.push(`Database and load balancers: ${(e as Error).message}`)
    return part
  } finally {
    for (const c of clients) c.destroy()
  }
}

// ---------- one JVM's heap and garbage collection (the heap chart) ----------

const gcCache = new Map<string, { at: number; d: JvmGcDetail }>()

export async function jvmGc(instance: string, hours: number): Promise<JvmGcDetail> {
  // The label goes into PromQL: only an exporter's host:port.
  if (typeof instance !== 'string' || !/^[A-Za-z0-9._-]+:\d{2,5}$/.test(instance)) throw new Error('Unknown JVM.')
  const r = GC_RANGES.find((x) => x.hours === hours) ?? GC_RANGES[1]
  const key = `${instance}|${r.hours}`
  const have = gcCache.get(key)
  if (have && Date.now() - have.at < (r.hours <= 1 ? 12_000 : 50_000)) return have.d
  const port = await prometheusPort(source())
  const sel = `instance="${instance}"`
  const end = Math.floor(Date.now() / 1000)
  const S = `${r.step}s`
  const W = `${r.hours}h`
  const one = async (query: string): Promise<Sample[]> => instant(port, query).catch(() => [] as Sample[])
  const [high, low, after, full, max, counts, secs, alloc, used, poolMax, collected, started, nonHeap, rss, fds] = await Promise.all([
    range(port, `max_over_time(java_lang_memory_heapmemoryusage_used{${sel}}[${S}])`, end, r.hours * 60, r.step),
    range(port, `min_over_time(java_lang_memory_heapmemoryusage_used{${sel}}[${S}])`, end, r.hours * 60, r.step),
    range(port, `sum(min_over_time(jvm_memory_pool_collection_used_bytes{${sel}}[${S}]))`, end, r.hours * 60, r.step),
    // Collections per step as the difference from the previous step: exact at any step, where increase() over a window
    // as short as one scrape would extrapolate.
    range(port, `clamp_min(jvm_gc_collection_seconds_count{${sel}} - jvm_gc_collection_seconds_count{${sel}} offset ${S}, 0)`, end, r.hours * 60, r.step),
    one(`java_lang_memory_heapmemoryusage_max{${sel}}`),
    one(`increase(jvm_gc_collection_seconds_count{${sel}}[${W}])`),
    one(`increase(jvm_gc_collection_seconds_sum{${sel}}[${W}])`),
    one(`sum(rate(jvm_memory_pool_allocated_bytes_total{${sel},pool=~"(?i).*(eden|nursery).*"}[${W}]))`),
    one(`jvm_memory_pool_used_bytes{${sel}}`),
    one(`jvm_memory_pool_max_bytes{${sel}}`),
    one(`jvm_memory_pool_collection_used_bytes{${sel}}`),
    one(`java_lang_runtime_starttime{${sel}}`),
    one(`java_lang_memory_nonheapmemoryusage_used{${sel}}`),
    one(`java_lang_operatingsystem_processphysicalmemorysize{${sel}}`),
    one(`java_lang_operatingsystem_openfiledescriptorcount{${sel}}`)
  ])
  const n = Math.round((r.hours * 3600) / r.step) + 1
  const start = (end - r.hours * 3600) * 1000
  const empty = (): Spark => new Array<number | null>(n).fill(null)
  const fullGcs = empty()
  for (const s of full) {
    if (!isFullGc(s.metric.gc ?? '')) continue
    s.values.forEach((v, i) => { if (v !== null) fullGcs[i] = Math.round(((fullGcs[i] ?? 0) + v) * 100) / 100 })
  }
  let lastFull: number | null = null
  fullGcs.forEach((v, i) => { if ((v ?? 0) >= 0.5) lastFull = start + i * r.step * 1000 })
  const heapMax = max[0]?.value ?? null
  const startedAt = started[0]?.value ?? null
  // Time the JVM was up in the window: a restart inside it shortens what the counts cover.
  const upSec = Math.max(1, Math.min(r.hours * 3600, startedAt ? (Date.now() - startedAt) / 1000 : r.hours * 3600))
  const secBy = new Map(secs.map((s) => [s.metric.gc ?? '', s.value]))
  const collectors: GcCollector[] = counts.map((c) => {
    const name = c.metric.gc ?? ''
    const count = Math.round(c.value)
    const seconds = secBy.get(name) ?? 0
    return { name, full: isFullGc(name), count, seconds, avgMs: count > 0 ? (seconds / count) * 1000 : null, perHour: count / (upSec / 3600) }
  }).sort((a, b) => Number(b.full) - Number(a.full) || a.name.localeCompare(b.name))
  const gcSeconds = collectors.reduce((a, c) => a + c.seconds, 0)
  const heapPools = new Set(collected.map((s) => s.metric.pool))
  const maxBy = new Map(poolMax.map((s) => [s.metric.pool, s.value]))
  const pools = used.map((s) => ({ name: s.metric.pool ?? '', used: s.value, max: (maxBy.get(s.metric.pool) ?? -1) > 0 ? maxBy.get(s.metric.pool)! : null, heap: heapPools.has(s.metric.pool) }))
    .filter((p) => p.name && !(p.heap && p.used === 0 && /reserved/i.test(p.name)))
    .sort((a, b) => Number(b.heap) - Number(a.heap) || b.used - a.used)
  const afterGc = after[0]?.values ?? empty()
  const times = Array.from({ length: n }, (_, i) => start + i * r.step * 1000)
  const d: JvmGcDetail = {
    instance, hours: r.hours, start, step: r.step, heapMax,
    heapHigh: high[0]?.values ?? empty(), heapLow: low[0]?.values ?? empty(), afterGc, fullGcs,
    startedAt, lastFullGcAt: lastFull, collectors,
    throughputPct: counts.length ? Math.max(0, 100 - (gcSeconds / upSec) * 100) : null,
    allocBytesPerSec: alloc[0]?.value ?? null,
    pools,
    trend: gcTrend(times, afterGc, heapMax, startedAt),
    policy: gcPolicy(used.map((s) => s.metric.pool ?? '')),
    nonHeapBytes: nonHeap[0]?.value ?? null,
    rssBytes: rss[0]?.value ?? null,
    openFds: fds[0]?.value ?? null
  }
  gcCache.set(key, { at: Date.now(), d })
  return d
}

// ---------- every machine's memory over a window (the memory grid) ----------

const memCache = new Map<string, { at: number; d: MemoryHistory }>()

export async function memoryHistory(env: PlmEnvId, hours: number): Promise<MemoryHistory> {
  if (!ENV_ORDER.includes(env)) throw new Error('Unknown environment.')
  const r = GC_RANGES.find((x) => x.hours === hours) ?? GC_RANGES[2]
  const key = `${env}|${r.hours}`
  const have = memCache.get(key)
  if (have && Date.now() - have.at < (r.hours <= 1 ? 12_000 : 50_000)) return have.d
  // Which machines belong to the environment, as the last snapshot sorted them.
  const hosts = (await plmHealth()).envs.find((e) => e.id === env)?.hosts ?? []
  const port = await prometheusPort(source())
  const end = Math.floor(Date.now() / 1000)
  const [linux, windows] = await Promise.all([
    range(port, '(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100', end, r.hours * 60, r.step).catch(() => [] as Series[]),
    range(port, '(1 - windows_memory_available_bytes / windows_memory_physical_total_bytes) * 100', end, r.hours * 60, r.step).catch(() => [] as Series[])
  ])
  const byIp = new Map<string, Spark>()
  for (const s of [...linux, ...windows]) { const ip = ipOf(s.metric.instance ?? ''); if (ip) byIp.set(ip, s.values) }
  const n = Math.round((r.hours * 3600) / r.step) + 1
  const machines: MachineMemory[] = hosts.map((h) => {
    const pct = byIp.get(h.ip) ?? new Array<number | null>(n).fill(null)
    const vals = pct.filter((v): v is number => v !== null)
    const now = h.reporting ? ([...pct].reverse().find((v) => v !== null) ?? null) : null
    return {
      ip: h.ip, name: h.name, role: h.role, label: h.label, os: h.os, state: h.state, totalBytes: h.memBytes, pct, now,
      peak: vals.length ? Math.max(...vals) : null, avg: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
      level: h.state === 'stopped' ? 'off' : !h.reporting ? 'unknown' : levelOf(now, LIMITS.mem), instanceKey: h.instanceKey
    }
  })
  const rank = (m: MachineMemory): number => ({ crit: 0, warn: 1, ok: 2, unknown: 3, off: 4 })[m.level]
  machines.sort((a, b) => rank(a) - rank(b) || (b.now ?? -1) - (a.now ?? -1))
  const d: MemoryHistory = { env, hours: r.hours, start: (end - r.hours * 3600) * 1000, step: r.step, machines }
  memCache.set(key, { at: Date.now(), d })
  return d
}

// ---------- the ENOVIA kernel and who is signed in (Jolokia on each 3DSpace server, history from Loki) ----------

/** The Jolokia agent on each 3DSpace server's TomEE (the same one the monitoring scripts read). */
const JOLOKIA_PORT = 8001
const LOKI_PORT = 3100
const kernelCache = new Map<PlmEnvId, { at: number; d: KernelHealth }>()
let licenseCache: { at: number; d: KernelHealth['license'] } | null = null

interface JolokiaReply { status: number; value?: Record<string, unknown>; error?: string }

async function jolokia(local: number, reads: { mbean: string; attribute?: string }[]): Promise<JolokiaReply[]> {
  // One bulk request of reads only.
  const r = await fetch(`http://127.0.0.1:${local}/jolokia/`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(reads.map((x) => ({ type: 'read', ...x }))), signal: AbortSignal.timeout(15_000)
  })
  return (await r.json()) as JolokiaReply[]
}

async function loki<T>(local: number, path: string, params: Record<string, string>): Promise<T> {
  const r = await fetch(`http://127.0.0.1:${local}/loki/api/v1/${path}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(20_000) })
  const j = (await r.json()) as { status: string; data: T }
  if (j.status !== 'success') throw new Error(`Loki: HTTP ${r.status}`)
  return j.data
}

async function readKernel(src: Source, j: { ip: string; label: string; name: string }): Promise<KernelServer> {
  const base: KernelServer = {
    ip: j.ip, label: j.label, name: j.name, reachable: false, people: [], service: [], system: [], reported: null,
    allocatedBytes: null, reservedBytes: null, highwaterBytes: null, limitBytes: null, contexts: null, dbConnections: null, dbExceeded: null,
    exceptions: null, uptimeSec: null, version: '', level: 'unknown'
  }
  try {
    const local = await forward(src, j.ip, JOLOKIA_PORT)
    const [kernel, limit, status, db, count, users, server] = await jolokia(local, [
      { mbean: 'mcs:00=memory,name=kernel' },
      { mbean: 'mcs:00=settings,name=system', attribute: 'MemoryLimit' },
      { mbean: 'mcs:name=status' },
      { mbean: 'mcs:00=Database,name=connection' },
      { mbean: '3DEXPERIENCE:name=EnoviaKernelMonitoring.activeUserCount' },
      { mbean: '3DEXPERIENCE:name=EnoviaKernelMonitoring.activeUsers' },
      { mbean: '3DEXPERIENCE:name=EnoviaKernelMonitoring.monitorServer' }
    ])
    const num = (r: JolokiaReply | undefined, k?: string): number | null => {
      const v = k ? r?.value?.[k] : r?.value
      return r?.status === 200 && typeof v === 'number' ? v : null
    }
    // activeUsers is tenant -> names; the kernel's own sessions and service accounts are not people.
    const names = new Set<string>()
    const byTenant = (users?.value as { Value?: Record<string, string[]> } | undefined)?.Value ?? {}
    for (const list of Object.values(byTenant)) for (const u of list ?? []) if (typeof u === 'string') names.add(u)
    const all = [...names].sort((a, b) => a.localeCompare(b))
    const counts = (count?.value as { Value?: Record<string, number> } | undefined)?.Value ?? {}
    const xml = String((server?.value as { Value?: unknown } | undefined)?.Value ?? '')
    const allocated = num(kernel, 'allocatedBytes')
    const lim = limit?.status === 200 && typeof limit.value === 'number' ? limit.value : null
    const pct = allocated !== null && lim ? (allocated / lim) * 100 : null
    return {
      ...base, reachable: true,
      people: all.filter((u) => !SYSTEM_USERS.has(u) && !isServiceAccount(u)), service: all.filter(isServiceAccount), system: all.filter((u) => SYSTEM_USERS.has(u)),
      reported: Object.values(counts).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0),
      allocatedBytes: allocated, reservedBytes: num(kernel, 'reservedBytes'), highwaterBytes: num(kernel, 'highwater'), limitBytes: lim,
      contexts: Number(/<contextCount>(\d+)<\/contextCount>/.exec(xml)?.[1] ?? NaN) || null,
      dbConnections: num(db, 'nbConnections'), dbExceeded: num(db, 'nbExceedConnections'), exceptions: num(status, 'nbExceptions'), uptimeSec: num(status, 'uptime'),
      version: (/<version>([^<]+)<\/version>/.exec(xml)?.[1] ?? '').replace(/^3DEXPERIENCE\s+/, '').replace(/\s*\([0-9a-f]+\)$/, ''),
      level: (num(db, 'nbExceedConnections') ?? 0) > 0 ? 'warn' : levelOf(pct, [75, 90])
    }
  } catch (e) {
    return { ...base, error: `Its kernel monitoring (Jolokia on port ${JOLOKIA_PORT}) did not answer: ${(e as Error).message}`, level: 'crit' }
  }
}

export async function kernelHealth(env: PlmEnvId): Promise<KernelHealth> {
  if (!ENV_ORDER.includes(env)) throw new Error('Unknown environment.')
  const have = kernelCache.get(env)
  if (have && Date.now() - have.at < 25_000) return have.d
  const src = source()
  const snap = await plmHealth()
  const jvms = snap.envs.find((e) => e.id === env)?.jvms ?? []
  const targets = jvms.filter((j) => j.ip).map((j) => ({ ip: j.ip!, label: j.label, name: j.name }))
  const gaps: string[] = []
  const end = Math.floor(Date.now() / 1000)
  const step = 300
  const start = end - 24 * 3600
  const [servers, history, license] = await Promise.all([
    Promise.all(targets.map((t) => readKernel(src, t))),
    // Who was signed in over the day: the count the servers' monitoring script logs every minute.
    forward(src, src.host, LOKI_PORT).then((lp) => loki<{ result: { metric: Record<string, string>; values: [number, string][] }[] }>(lp, 'query_range', {
      // Backticks: LogQL takes them literally, where a quoted string would read \\d as an escape.
      query: 'max by (host) (max_over_time({job=~".+_ActiveUsers"} |= "Total Active Users" | regexp `Total Active Users: (?P<n>\\d+)` | unwrap n [5m]))',
      start: String(start), end: String(end), step: String(step)
    })).catch((e: Error) => { gaps.push(`Active users over the day (Loki): ${e.message}`); return null }),
    licenseStatus(src).catch((e: Error) => { gaps.push(`License server check (Loki): ${e.message}`); return null })
  ])
  const n = Math.round((end - start) / step) + 1
  for (const s of history?.result ?? []) {
    const ip = ipOf(s.metric.host ?? '')
    const server = servers.find((x) => x.ip === ip)
    if (!server) continue
    const spark: (number | null)[] = new Array(n).fill(null)
    for (const [t, v] of s.values) { const i = Math.round((t - start) / step); if (i >= 0 && i < n) spark[i] = Number(v) }
    server.usersSpark = spark
    const vals = spark.filter((v): v is number => v !== null)
    server.usersPeak = vals.length ? Math.max(...vals) : null
  }
  const d: KernelHealth = { env, at: Date.now(), start: start * 1000, step, servers, license, gaps }
  kernelCache.set(env, { at: Date.now(), d })
  return d
}

const kmemCache = new Map<string, { at: number; d: KernelMemoryHistory }>()

/**
 * Each 3DSpace server's kernel over a window, from the enovia_kernel_* metrics its cron script hands node_exporter's
 * textfile collector. One machine may export another's numbers, so series are matched by their `host` label, never by
 * the instance that served them. A failed read drops the values until the next good one, so gaps stay gaps.
 */
export async function kernelMemoryHistory(env: PlmEnvId, hours: number): Promise<KernelMemoryHistory> {
  if (!ENV_ORDER.includes(env)) throw new Error('Unknown environment.')
  const r = GC_RANGES.find((x) => x.hours === hours) ?? GC_RANGES[2]
  const key = `${env}|${r.hours}`
  const have = kmemCache.get(key)
  if (have && Date.now() - have.at < (r.hours <= 1 ? 12_000 : 50_000)) return have.d
  const jvms = (await plmHealth()).envs.find((e) => e.id === env)?.jvms ?? []
  const targets = jvms.filter((j) => j.ip).map((j) => ({ ip: j.ip!, label: j.label, name: j.name }))
  const port = await prometheusPort(source())
  const end = Math.floor(Date.now() / 1000)
  const minutes = r.hours * 60
  // The cron script writes every few minutes: the highest value in each step keeps short peaks in long views.
  const win = `${Math.max(r.step, 60)}s`
  const q = (metric: string): Promise<Series[]> => range(port, `max by (host) (max_over_time(${metric}[${win}]))`, end, minutes, r.step).catch(() => [] as Series[])
  const [allocated, reserved, highwater, contexts, users, runs] = await Promise.all([
    q('enovia_kernel_memory_allocated_bytes'), q('enovia_kernel_memory_reserved_bytes'), q('enovia_kernel_memory_highwater_bytes'),
    q('enovia_kernel_context_count'), q('enovia_kernel_active_users'),
    range(port, `max by (host, pid, startdatetime) (max_over_time(enovia_kernel_info[${win}]))`, end, minutes, r.step).catch(() => [] as Series[])
  ])
  const start = (end - minutes * 60) * 1000
  const n = Math.round((minutes * 60) / r.step) + 1
  const empty = (): Spark => new Array<number | null>(n).fill(null)
  const of = (list: Series[], ip: string): Spark => list.find((x) => ipOf(x.metric.host ?? '') === ip)?.values ?? empty()
  const servers: KernelMemorySeries[] = []
  for (const t of targets) {
    const a = of(allocated, t.ip)
    if (!a.some((v) => v !== null)) continue
    // Each TomEE run is its own series; every run after the first one in view began with a restart.
    const firsts = runs.filter((x) => ipOf(x.metric.host ?? '') === t.ip).map((x) => x.values.findIndex((v) => v !== null)).filter((i) => i >= 0).sort((x, y) => x - y)
    servers.push({
      ...t, allocated: a, reserved: of(reserved, t.ip), highwater: of(highwater, t.ip), contexts: of(contexts, t.ip), users: of(users, t.ip),
      restarts: firsts.slice(1).map((i) => start + i * r.step * 1000)
    })
  }
  const d: KernelMemoryHistory = { env, hours: r.hours, start, step: r.step, servers }
  kmemCache.set(key, { at: Date.now(), d })
  return d
}

/** The last license server check: DSCheckLS output that one 3DSpace server logs every 30 minutes. */
async function licenseStatus(src: Source): Promise<KernelHealth['license']> {
  if (licenseCache && Date.now() - licenseCache.at < 5 * 60_000) return licenseCache.d
  const lp = await forward(src, src.host, LOKI_PORT)
  const now = Date.now()
  const data = await loki<{ result: { values: [string, string][] }[] }>(lp, 'query_range', {
    query: '{job="DSLS_Status"}', start: String((now - 2 * 3600_000) * 1e6), end: String(now * 1e6), limit: '400', direction: 'backward'
  })
  const lines = data.result.flatMap((r) => r.values).sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : 1))
  // The newest block runs from its "Run time:" line to the row of '='.
  let from = -1
  lines.forEach(([, l], i) => { if (/^Run time:/.test(l)) from = i })
  if (from < 0) { licenseCache = { at: Date.now(), d: null }; return null }
  const block: string[] = []
  for (const [, l] of lines.slice(from + 1)) { if (/^={10,}/.test(l)) break; block.push(l) }
  const d = parseLicense(block, Number(BigInt(lines[from][0]) / 1_000_000n))
  licenseCache = { at: Date.now(), d }
  return d
}

// ---------- the snapshot ----------

let cached: { at: number; snap: PlmHealthSnapshot } | null = null
let building: Promise<PlmHealthSnapshot> | null = null
const SNAP_MS = 20_000

export function plmHealth(force = false): Promise<PlmHealthSnapshot> {
  if (!force && cached && Date.now() - cached.at < SNAP_MS) return Promise.resolve(cached.snap)
  building ??= build().finally(() => { building = null })
  return building
}

async function build(): Promise<PlmHealthSnapshot> {
  const src = source()
  let data: Awaited<ReturnType<typeof gather>>
  try {
    data = await gather(await prometheusPort(src))
  } catch (e) {
    // A tunnel that died quietly (laptop slept, SSM dropped it): one fresh try.
    await closeTunnel(`${src.inst.key}|${src.host}:${src.port}`)
    try {
      data = await gather(await prometheusPort(src))
    } catch (e2) {
      log('health', 'prometheus unreachable', { error: (e2 as Error).message, first: (e as Error).message })
      throw new Error(`Could not read Prometheus on ${src.inst.name}: ${(e2 as Error).message}`)
    }
  }
  const w = world(data.q, src.inst)
  const present = ENV_ORDER.filter((env) => data.q.up.some((s) => envsFor(w, s.metric.job ?? '', s.metric.instance ?? '').includes(env)))
  const clouds = await Promise.all(present.map((env) => cloud(env, data, w)))
  const now = Date.now()
  const snap: PlmHealthSnapshot = {
    at: now,
    source: `${src.inst.name} · Prometheus ${src.host}:${src.port} over SSM`,
    envs: present.map((env, i) => buildEnv(env, data, w, clouds[i], now))
  }
  cached = { at: now, snap }
  return snap
}

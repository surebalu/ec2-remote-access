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
  ENV_NAMES, ENV_ORDER, LIMITS, ROLES, SERVICE_ORDER, envOf, ipOf, isFrontProbe, levelBelow, levelOf, nodeLabel, probeOk, roleOf, serviceLevel,
  urlHost, verdict, worst, formatPct, formatMs,
  type AlbHealth, type AlertItem, type ApacheHealth, type CertHealth, type DbHealth, type Endpoint, type HostHealth, type Issue, type JvmHealth,
  type Level, type PlmEnvHealth, type PlmEnvId, type PlmHealthSnapshot, type ServiceHealth, type ServiceNode, type Spark, type StorageHealth
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

let tunnel: { key: string; port: number; handle: SsmHandle } | null = null
let opening: Promise<number> | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
const IDLE_MS = 10 * 60_000

function keepOpen(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => void closePlmHealth(), IDLE_MS)
}

async function prometheusPort(src: Source): Promise<number> {
  const key = `${src.inst.key}|${src.host}:${src.port}`
  keepOpen()
  if (tunnel?.key === key && tunnel.handle.child.exitCode === null && !tunnel.handle.child.killed) return tunnel.port
  opening ??= (async () => {
    await closeTunnel()
    const port = await freePort()
    const local = /^(127\.0\.0\.1|localhost)$/.test(src.host)
    const handle = await startPortForward(src.inst, src.port, port, undefined, local ? undefined : src.host)
    tunnel = { key, port, handle }
    handle.child.once('exit', () => { if (tunnel?.handle === handle) tunnel = null })
    log('health', 'prometheus tunnel open', { via: src.inst.name, target: `${src.host}:${src.port}`, localPort: port })
    return port
  })().finally(() => { opening = null })
  return opening
}

async function closeTunnel(): Promise<void> {
  const t = tunnel
  tunnel = null
  if (t) await t.handle.terminate().catch(() => undefined)
}

/** On quit, and ten minutes after the tab was last looked at. */
export async function closePlmHealth(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  await closeTunnel()
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

async function range(port: number, query: string, end: number): Promise<Series[]> {
  const start = end - SPARK_MIN * 60
  const d = await api<{ result: { metric: Labels; values: [number, string][] }[] }>(port, 'query_range', { query, start: String(start), end: String(end), step: String(SPARK_STEP) })
  const n = Math.round((end - start) / SPARK_STEP) + 1
  return d.result.map((r) => {
    const values: Spark = new Array<number | null>(n).fill(null)
    for (const [t, v] of r.values) {
      const i = Math.round((t - start) / SPARK_STEP)
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

async function gather(port: number): Promise<{ q: Instant; r: Ranges; alerts: PromAlert[] }> {
  const end = Math.floor(Date.now() / 1000)
  const qs = Object.entries(Q) as [keyof typeof Q, string][]
  const rs = Object.entries(RANGE) as [keyof typeof RANGE, string][]
  const [qv, rv, alerts] = await Promise.all([
    Promise.all(qs.map(([, query]) => instant(port, query).catch(() => [] as Sample[]))),
    Promise.all(rs.map(([, query]) => range(port, query, end).catch(() => [] as Series[]))),
    api<{ alerts: PromAlert[] }>(port, 'alerts', {}).then((d) => d.alerts, () => [] as PromAlert[])
  ])
  // Every instant query failing means Prometheus itself did not answer.
  if (qv.every((x) => !x.length)) await instant(port, 'up')
  return {
    q: Object.fromEntries(qs.map(([k], i) => [k, qv[i]])) as Instant,
    r: Object.fromEntries(rs.map(([k], i) => [k, rv[i]])) as Ranges,
    alerts
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

function buildEnv(env: PlmEnvId, d: { q: Instant; r: Ranges; alerts: PromAlert[] }, w: World, cloud: CloudPart | undefined, now: number): PlmEnvHealth {
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
  const disks = new Map<string, { mount: string; pct: number }[]>()
  const storageMap = new Map<string, StorageHealth>()
  const addDisk = (instance: string, mount: string, device: string, fstype: string, size: number, free: number, windows: boolean): void => {
    if (!(size > 0)) return
    const pct = ((size - free) / size) * 100
    disks.set(instance, [...(disks.get(instance) ?? []), { mount, pct }])
    const shared = /^nfs|cifs|smb/i.test(fstype)
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
    // The small boot partitions only count once they fill up; otherwise the fullest disk is a real one.
    const limits = windows ? LIMITS.diskWindows : LIMITS.disk
    const worstDisk = (disks.get(instance) ?? []).filter((d) => !/^\/boot(\/|$)/.test(d.mount) || d.pct >= limits[0]).sort((a, b) => b.pct - a.pct)[0] ?? null
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
      disk: reporting ? worstDisk : null, load: load.get(instance) ?? null, cores: cores.get(instance) ?? null, uptimeSec: uptime.get(instance) ?? null,
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
    }
    byRole.set(role.id, slot)
  }
  const services: ServiceHealth[] = []
  for (const [id, slot] of byRole) {
    const role = ROLES.find((x) => x.id === id)!
    // The main page first (3DSpace's own check before its internal one).
    slot.fronts.sort((a, b) => Number(/\/internal\//.test(a.url)) - Number(/\/internal\//.test(b.url)))
    slot.nodes.sort((a, b) => a.label.localeCompare(b.label) || a.url.localeCompare(b.url))
    const { level, summary } = serviceLevel(slot.fronts, slot.nodes)
    services.push({ id, name: role.name, blurb: role.blurb, level, summary, fronts: slot.fronts, nodes: slot.nodes })
    if (level === 'crit' || level === 'warn') issues.push({ level, text: `${role.name}: ${summary.split(' · ')[0].toLowerCase()}`, section: 'services' })
  }
  services.sort((a, b) => (SERVICE_ORDER.indexOf(a.id) + 1 || 99) - (SERVICE_ORDER.indexOf(b.id) + 1 || 99))

  // 3DSpace's JVMs (the JMX exporter).
  const heapUsed = byInstance(q.heapUsed)
  const heapMax = byInstance(q.heapMax)
  const heapFloor = byInstance(q.heapFloor)
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
    const lh = levelOf(floor ?? heapPct, LIMITS.heap)
    const lg = levelOf(gc.get(instance), LIMITS.gc)
    const lf = levelOf(fds.get(instance), LIMITS.fds)
    const problems: string[] = []
    if (lh === 'warn' || lh === 'crit') problems.push(`heap stays above ${formatPct(floor ?? heapPct)} even after garbage collection`)
    if (lg === 'warn' || lg === 'crit') problems.push(`${formatPct(gc.get(instance))} of the time in garbage collection`)
    if (lf === 'warn' || lf === 'crit') problems.push(`${formatPct(fds.get(instance))} of file handles in use`)
    const level: Level = !reporting ? (stoppedIn(inst) ? 'off' : 'crit') : worst([lh, lg, lf])
    const label = nodeLabel(job) || (ip ? w.ipLabel.get(ip) ?? '' : '')
    jvms.push({
      label, ip, name: inst?.name ?? instance, level, problems, reporting,
      heapUsed: used, heapMax: max, heapPct, gcPct: gc.get(instance) ?? null, threads: threads.get(instance) ?? null, fdsPct: fds.get(instance) ?? null,
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
  if (cloud?.db) for (const p of cloud.db.problems) issues.push({ level: cloud.db.level === 'crit' ? 'crit' : 'warn', text: `Database: ${p}`, section: 'db' })
  for (const a of cloud?.albs ?? []) for (const p of a.problems) issues.push({ level: a.level === 'crit' ? 'crit' : 'warn', text: `${a.internal ? 'Internal load balancer' : 'Load balancer'}: ${p}`, section: 'alb' })

  const v = verdict(issues, services)
  return {
    id: env, name: ENV_NAMES[env], level: v.level, headline: v.headline, issues: v.issues,
    services, hosts, jvms, apaches, storage, db: cloud?.db ?? null, albs: cloud?.albs ?? [], certs, alerts, gaps
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

// ---------- the snapshot ----------

let cached: { at: number; snap: PlmHealthSnapshot } | null = null
let building: Promise<PlmHealthSnapshot> | null = null
const SNAP_MS = 20_000

export function plmHealth(force = false): Promise<PlmHealthSnapshot> {
  if (!force && cached && Date.now() - cached.at < SNAP_MS) { keepOpen(); return Promise.resolve(cached.snap) }
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
    await closeTunnel()
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

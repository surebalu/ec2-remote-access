/**
 * The host page (main/hostInsight.ts, components/hostpage/): what a Linux server is doing now, read through SSM in one
 * command that samples twice two seconds apart (so CPU, network and disk are rates, not totals since boot), and what one
 * process is doing. This is the pure part: the scripts and reading their output back; tests/hostInsight.test.ts.
 */

export interface DiskInfo {
  mount: string
  fs: string
  device: string
  size: number
  used: number
  avail: number
  readBps: number | null
  writeBps: number | null
  readIops: number | null
  writeIops: number | null
}

export interface NetIf { iface: string; rxBps: number; txBps: number; rxPps: number; txPps: number; rxErrs: number; txErrs: number; rxDrop: number; txDrop: number }

export interface ProcInfo {
  pid: number
  ppid: number
  user: string
  uptimeSec: number
  /** Of the whole host (all cores), over the two-second sample. */
  cpuPct: number | null
  rssBytes: number
  threads: number
  comm: string
  args: string
  unit: string | null
  tech: string
}

export interface Listen { addr: string; port: number; pid: number | null; process: string | null }
export interface Conn { direction: 'in' | 'out'; /** The listening port, coming in. */ localPort: number | null; remote: string; /** Going out. */ remotePort: number | null; pid: number | null; process: string | null; count: number }

export interface HostSnapshot {
  at: number
  uptimeSec: number | null
  cpus: number
  load: [number, number, number] | null
  cpuPct: number | null
  memTotal: number | null
  memAvailable: number | null
  swapTotal: number | null
  swapFree: number | null
  os: string
  kernel: string
  disks: DiskInfo[]
  nets: NetIf[]
  processes: ProcInfo[]
  listening: Listen[]
  connections: Conn[]
}

export const SAMPLE_S = 2

/**
 * One SSM command: everything above, sampled twice. SSM returns at most 24,000 characters, so the server works out the
 * rates itself (two samples in a temporary folder, removed after) and sends only what the page shows: per-process CPU
 * only for processes that used some, the 45 largest and 15 busiest processes with their command lines cut short, and
 * connections counted rather than listed. Linux only; every line tolerates a missing tool.
 */
export function snapshotScript(): string[] {
  return [
    'export LC_ALL=C',
    'T=$(mktemp -d /tmp/ec2ra.XXXXXX)',
    'snap() { head -1 /proc/stat > $T/stat$1; cat /proc/net/dev > $T/net$1; cat /proc/diskstats > $T/disk$1; cat /proc/[0-9]*/stat 2>/dev/null | awk \'{i=index($0,") "); split(substr($0,i+2),f," "); print $1, f[12]+f[13]}\' > $T/pst$1; }',
    `snap 1; sleep ${SAMPLE_S}; snap 2`,
    'echo @@UPTIME; cat /proc/uptime',
    'echo @@CPUS; nproc',
    'echo @@LOAD; cat /proc/loadavg',
    "echo @@MEM; grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo",
    'echo @@OS; (. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME"); uname -r',
    'D="df -PT -B1 -x tmpfs -x devtmpfs -x overlay -x squashfs -x efivarfs"',
    'echo @@DF; $D 2>/dev/null | tail -n +2 | head -40',
    // LVM volumes show as /dev/mapper/<name> in df but dm-<n> in diskstats.
    "echo @@DEVMAP; for d in $($D 2>/dev/null | awk '$1 ~ /^\\/dev\\/mapper\\// {print $1}' | sort -u); do echo \"$d $(readlink -f $d)\"; done",
    'echo @@STAT1; cat $T/stat1; echo @@STAT2; cat $T/stat2',
    // iface, then the deltas of rx bytes, tx bytes, rx packets, tx packets, then the totals of rx/tx errors and drops.
    'echo @@NET; awk \'NR==FNR { if (FNR>2) { split($0,x,":"); n=x[1]; gsub(/ /,"",n); split(x[2],f," "); r[n]=f[1]; rp[n]=f[2]; t[n]=f[9]; tp[n]=f[10] } next } FNR>2 { split($0,x,":"); n=x[1]; gsub(/ /,"",n); split(x[2],f," "); if (n != "lo") print n, f[1]-r[n], f[9]-t[n], f[2]-rp[n], f[10]-tp[n], f[3], f[11], f[4], f[12] }\' $T/net1 $T/net2',
    // device, then the deltas of reads, sectors read, writes, sectors written.
    'echo @@DISK; awk \'NR==FNR { a[$3]=$4" "$6" "$8" "$10; next } ($3 in a) && $3 !~ /^(loop|ram)/ { split(a[$3],o," "); print $3, $4-o[1], $6-o[2], $8-o[3], $10-o[4] }\' $T/disk1 $T/disk2',
    'echo @@PCPU; awk \'NR==FNR { a[$1]=$2; next } ($1 in a) { d=$2-a[$1]; if (d>0) print $1, d }\' $T/pst1 $T/pst2',
    'F="pid=,ppid=,user:20=,etimes=,rss=,nlwp=,comm=,args="',
    // A JVM's command line starts with a screenful of --add-opens; what names it (-Dcatalina.base, the main class) comes after.
    'echo @@PS; (ps -eo "$F" --sort=-rss | head -45; ps -eo "$F" --sort=-pcpu | head -15) 2>/dev/null | sort -n -u | sed -E \'s/ --add-(opens|exports|reads|modules)[= ][^ ]+//g\' | cut -c1-240',
    "echo @@UNITS; for p in $( (ps -eo pid= --sort=-rss | head -45; ps -eo pid= --sort=-pcpu | head -15) | sort -u); do u=$(grep -o '[^/]*\\.service' /proc/$p/cgroup 2>/dev/null | head -1); [ -n \"$u\" ] && echo \"$p $u\"; done",
    'echo @@LISTEN; ss -ltnpH 2>/dev/null | head -60',
    ...connectionsScript(''),
    'rm -rf $T',
    'echo @@END'
  ]
}

/**
 * Established connections counted by direction (in to a listening port, else out), local port, remote address, remote
 * port (only going out: coming in it is a random one) and process id: "12 in 8060 10.1.2.52 - 4242".
 */
function connectionsScript(pidFilter: string): string[] {
  return [
    'L=" $(ss -ltnH 2>/dev/null | awk \'{n=split($4,a,":"); print a[n]}\' | sort -u | tr \'\\n\' \' \')"',
    `echo @@EST; ss -tnpH state established 2>/dev/null${pidFilter} | awk -v L="$L" '{ n=split($3,a,":"); lp=a[n]; rh=$4; m=split(rh,b,":"); rp=b[m]; sub(/:[0-9]+$/,"",rh); gsub(/[][]/,"",rh); sub(/^::ffff:/,"",rh); p="-"; if (match($0,/pid=[0-9]+/)) p=substr($0,RSTART+4,RLENGTH-4); if (index(L," "lp" ")) print "in", lp, rh, "-", p; else print "out", "-", rh, rp, p }' | sort | uniq -c | sort -rn | head -150`
  ]
}

/** One process in detail, sampled over a second for its CPU. */
export function processScript(pid: number): string[] {
  if (!Number.isInteger(pid) || pid < 1 || pid > 99_999_999) throw new Error('Not a process id.')
  const P = String(pid)
  return [
    'export LC_ALL=C',
    `P=${P}`,
    'if [ ! -d /proc/$P ]; then echo @@GONE; exit 0; fi',
    'echo @@CPUS; nproc',
    'echo @@PS; ps -o pid=,ppid=,user:20=,etimes=,rss=,vsz=,nlwp=,comm=,args= -p $P | cut -c1-6000',
    'echo @@STARTED; ps -o lstart= -p $P',
    "echo @@STATUS; grep -E '^(State|Threads|VmRSS|VmHWM|VmSwap):' /proc/$P/status",
    "echo @@UNIT; grep -o '[^/]*\\.service' /proc/$P/cgroup 2>/dev/null | head -1",
    'echo @@FDS; ls /proc/$P/fd 2>/dev/null | wc -l',
    "echo @@LIMIT; grep 'Max open files' /proc/$P/limits",
    'echo @@EXE; readlink /proc/$P/exe; readlink /proc/$P/cwd',
    'echo @@T1; read -r l < /proc/$P/stat; echo "$l"',
    'sleep 1',
    'echo @@T2; read -r l < /proc/$P/stat; echo "$l"',
    'echo @@LISTEN; ss -ltnpH 2>/dev/null | grep "pid=$P,"',
    ...connectionsScript(' | grep "pid=$P,"'),
    'echo @@END'
  ]
}

/** The text between `@@NAME` and the next marker. */
export function sections(out: string): Map<string, string[]> {
  const m = new Map<string, string[]>()
  let cur: string[] | null = null
  for (const line of out.split('\n')) {
    const k = /^@@([A-Z0-9]+)$/.exec(line.trim())
    if (k) { cur = []; m.set(k[1], cur) } else if (cur) cur.push(line)
  }
  return m
}

/** utime + stime (clock ticks) per pid from /proc/<pid>/stat lines; the name in brackets may hold spaces. */
function procTicks(lines: string[]): Map<number, number> {
  const out = new Map<number, number>()
  for (const l of lines) {
    const close = l.lastIndexOf(')')
    if (close < 0) continue
    const pid = Number(l.slice(0, l.indexOf(' ')))
    const f = l.slice(close + 2).split(' ')
    // After the name: state(0) ppid(1) … utime(11) stime(12).
    const ticks = Number(f[11]) + Number(f[12])
    if (Number.isFinite(pid) && Number.isFinite(ticks)) out.set(pid, ticks)
  }
  return out
}

/** Clock ticks a second (USER_HZ), 100 on every Linux the fleet runs. */
const HZ = 100

/** ss's address:port, IPv6 and IPv4-in-IPv6 included. */
function hostPort(s: string): { host: string; port: number } {
  const i = s.lastIndexOf(':')
  let host = s.slice(0, i).replace(/^\[|\]$/g, '').replace(/^::ffff:/, '')
  if (host === '*') host = '0.0.0.0'
  return { host, port: Number(s.slice(i + 1)) }
}
const ssProc = (s: string): { pid: number | null; process: string | null } => {
  const m = /users:\(\("([^"]*)",pid=(\d+)/.exec(s)
  return { pid: m ? Number(m[2]) : null, process: m ? m[1] : null }
}

export function parseListen(lines: string[]): Listen[] {
  const out: Listen[] = []
  for (const l of lines) {
    const f = l.trim().split(/\s+/)
    if (f.length < 4) continue
    // LISTEN recv send local peer [process]
    const local = f[0] === 'LISTEN' ? f[3] : f[2]
    const hp = hostPort(local)
    if (!Number.isFinite(hp.port)) continue
    out.push({ addr: hp.host, port: hp.port, ...ssProc(l) })
  }
  return out
}

/** connectionsScript's counted lines; process names come from `names` (pid → name) when the line has a pid. */
export function parseEstablished(lines: string[], names: Map<number, string> = new Map()): Conn[] {
  const out: Conn[] = []
  for (const l of lines) {
    const m = /^\s*(\d+)\s+(in|out)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/.exec(l)
    if (!m) continue
    const pid = m[6] === '-' ? null : Number(m[6])
    out.push({ count: Number(m[1]), direction: m[2] as 'in' | 'out', localPort: m[3] === '-' ? null : Number(m[3]), remote: m[4], remotePort: m[5] === '-' ? null : Number(m[5]), pid, process: pid !== null ? names.get(pid) ?? null : null })
  }
  return out
}

/** What a process is, for the Technologies table, from its name and command line. */
export function techOf(comm: string, args: string, ppid: number): string {
  const a = `${comm} ${args}`.toLowerCase()
  if (ppid === 2 || /^\[.*\]$/.test(args.trim())) return 'Linux kernel'
  if (/oneagent|dynatrace/.test(a)) return 'Dynatrace OneAgent'
  // Before the exporters: a JVM often carries the JMX exporter as an agent.
  if (/\bjava\b/.test(comm) || /\bjava\s/.test(args)) {
    if (/tomee/.test(a)) return 'Apache TomEE'
    if (/catalina|tomcat/.test(a)) return 'Apache Tomcat'
    if (/elasticsearch|opensearch/.test(a)) return 'Elasticsearch'
    if (/jmx_prometheus_httpserver/.test(a)) return 'Prometheus exporter'
    return 'Java'
  }
  if (/node_exporter/.test(a)) return 'Prometheus node exporter'
  if (/blackbox_exporter|jmx_prometheus|_exporter\b/.test(a)) return 'Prometheus exporter'
  if (/promtail/.test(a)) return 'Grafana Promtail'
  if (/amazon-ssm-agent|ssm-agent-worker|ssm-session-worker|ssm-document-worker/.test(a)) return 'AWS Systems Manager agent'
  if (/amazon-cloudwatch-agent/.test(a)) return 'Amazon CloudWatch agent'
  if (/\bhttpd\b|apache2/.test(a)) return 'Apache HTTP Server'
  if (/\bnginx\b/.test(a)) return 'NGINX'
  if (/cloudview|exalead|cvinit|cvcommand/.test(a)) return 'EXALEAD CloudView'
  if (/\bdsls|dslicsrv|dslicserv/.test(a)) return 'Dassault License Server'
  if (/\bmcs\b|dassaultsystemes/.test(a)) return '3DEXPERIENCE'
  if (/\bnode\b|nodejs/.test(comm)) return 'Node.js'
  if (/python/.test(comm)) return 'Python'
  if (/\boracle\b|tnslsnr/.test(a)) return 'Oracle'
  if (/postgres/.test(a)) return 'PostgreSQL'
  if (/mysqld|mariadb/.test(a)) return 'MySQL'
  if (/\bsshd\b/.test(comm)) return 'OpenSSH'
  if (/chronyd|ntpd/.test(comm)) return 'Time sync'
  if (/systemd|journald|udevd|dbus|rsyslog|crond|auditd|polkit|NetworkManager|tuned|irqbalance|agetty|gssproxy|rpcbind|firewalld|lvmetad|sssd|login/i.test(comm)) return 'Linux system'
  return 'Other'
}

export function parseSnapshot(out: string, now: number): HostSnapshot {
  const s = sections(out)
  const get = (k: string): string[] => s.get(k) ?? []
  const num = (v: string | undefined): number | null => { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) ? n : null }
  const cpus = num(get('CPUS')[0]?.trim()) ?? 1
  const load = get('LOAD')[0]?.trim().split(/\s+/).slice(0, 3).map(Number)
  const mem = new Map(get('MEM').map((l) => { const m = /^(\w+):\s+(\d+)/.exec(l); return m ? [m[1], Number(m[2]) * 1024] as const : null }).filter((x): x is readonly [string, number] => !!x))
  const [os = '', kernel = ''] = get('OS').map((l) => l.trim())

  // The host's CPU over the sample, from the first line of /proc/stat.
  const cpuLine = (l: string | undefined): { total: number; idle: number } | null => {
    const f = l?.trim().split(/\s+/).slice(1).map(Number)
    if (!f || f.length < 5) return null
    return { total: f.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0), idle: f[3] + (f[4] ?? 0) }
  }
  const c1 = cpuLine(get('STAT1')[0])
  const c2 = cpuLine(get('STAT2')[0])
  const cpuPct = c1 && c2 && c2.total > c1.total ? Math.max(0, Math.min(100, (1 - (c2.idle - c1.idle) / (c2.total - c1.total)) * 100)) : null

  const cols = (l: string): string[] => l.trim().split(/\s+/)
  const nets: NetIf[] = get('NET').map(cols).filter((f) => f.length >= 9).map((f) => {
    const [iface, ...v] = f
    const n = v.map(Number)
    const rate = (x: number): number => Math.max(0, x / SAMPLE_S)
    return { iface, rxBps: rate(n[0]), txBps: rate(n[1]), rxPps: rate(n[2]), txPps: rate(n[3]), rxErrs: n[4], txErrs: n[5], rxDrop: n[6], txDrop: n[7] }
  })

  const devmap = new Map(get('DEVMAP').map(cols).filter((f) => f.length === 2).map(([a, b]) => [a, b]))
  const io = new Map(get('DISK').map(cols).filter((f) => f.length >= 5).map(([d, ...v]) => [d, v.map(Number)]))
  const disks: DiskInfo[] = get('DF').map(cols).filter((f) => f.length >= 7).map((f) => {
    const d = io.get((devmap.get(f[0]) ?? f[0]).split('/').pop() ?? '')
    // reads, sectors read, writes, sectors written over the sample; a sector is 512 bytes here.
    const r = (i: number, scale = 1): number | null => (d ? Math.max(0, (d[i] * scale) / SAMPLE_S) : null)
    return { device: f[0], fs: f[1], size: Number(f[2]), used: Number(f[3]), avail: Number(f[4]), mount: f.slice(6).join(' '), readBps: r(1, 512), writeBps: r(3, 512), readIops: r(0), writeIops: r(2) }
  })

  const ticks = new Map(get('PCPU').map(cols).filter((f) => f.length === 2).map(([p, t]) => [Number(p), Number(t)]))
  const units = new Map(get('UNITS').map(cols).filter((f) => f.length === 2).map(([p, u]) => [Number(p), u]))
  const processes: ProcInfo[] = []
  for (const l of get('PS')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(l)
    if (!m) continue
    const pid = Number(m[1])
    processes.push({
      pid, ppid: Number(m[2]), user: m[3], uptimeSec: Number(m[4]), rssBytes: Number(m[5]) * 1024, threads: Number(m[6]), comm: m[7], args: m[8].trim(),
      // Only processes that used the CPU during the sample are listed.
      cpuPct: ((ticks.get(pid) ?? 0) / HZ / SAMPLE_S / cpus) * 100,
      unit: units.get(pid) ?? null, tech: techOf(m[7], m[8], Number(m[2]))
    })
  }

  const listening = parseListen(get('LISTEN'))
  const connections = parseEstablished(get('EST'), new Map(processes.map((p) => [p.pid, p.comm])))
  const up = num(get('UPTIME')[0]?.trim().split(/\s+/)[0])
  return {
    at: now, uptimeSec: up, cpus, load: load && load.length === 3 && load.every(Number.isFinite) ? [load[0], load[1], load[2]] : null, cpuPct,
    memTotal: mem.get('MemTotal') ?? null, memAvailable: mem.get('MemAvailable') ?? null, swapTotal: mem.get('SwapTotal') ?? null, swapFree: mem.get('SwapFree') ?? null,
    os, kernel, disks, nets, processes, listening, connections
  }
}

export interface ProcessDetail {
  at: number
  gone: boolean
  pid: number
  ppid: number | null
  user: string
  uptimeSec: number | null
  started: string
  rssBytes: number | null
  hwmBytes: number | null
  vszBytes: number | null
  swapBytes: number | null
  threads: number | null
  state: string
  comm: string
  args: string
  exe: string
  cwd: string
  unit: string | null
  fds: number | null
  fdLimit: number | null
  cpuPct: number | null
  tech: string
  listening: Listen[]
  connections: Conn[]
}

export function parseProcess(out: string, pid: number, now: number): ProcessDetail {
  const s = sections(out)
  const get = (k: string): string[] => s.get(k) ?? []
  const empty: ProcessDetail = {
    at: now, gone: true, pid, ppid: null, user: '', uptimeSec: null, started: '', rssBytes: null, hwmBytes: null, vszBytes: null, swapBytes: null, threads: null, state: '',
    comm: '', args: '', exe: '', cwd: '', unit: null, fds: null, fdLimit: null, cpuPct: null, tech: 'Other', listening: [], connections: []
  }
  if (s.has('GONE')) return empty
  const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(get('PS').find((l) => l.trim()) ?? '')
  if (!m) return empty
  const cpus = Number(get('CPUS')[0]?.trim()) || 1
  const status = new Map(get('STATUS').map((l) => { const i = l.indexOf(':'); return [l.slice(0, i), l.slice(i + 1).trim()] as [string, string] }))
  const kb = (v: string | undefined): number | null => { const n = Number(/(\d+)\s*kB/.exec(v ?? '')?.[1]); return Number.isFinite(n) && v ? n * 1024 : null }
  const ticks = (l: string | undefined): number | null => (l ? procTicks([l]).get(pid) ?? null : null)
  const a = ticks(get('T1').find((l) => l.trim()))
  const b = ticks(get('T2').find((l) => l.trim()))
  const listening = parseListen(get('LISTEN'))
  const [exe = '', cwd = ''] = get('EXE').map((l) => l.trim())
  const limit = /Max open files\s+(\d+|unlimited)/.exec(get('LIMIT').join(' '))?.[1]
  return {
    at: now, gone: false, pid, ppid: Number(m[2]), user: m[3], uptimeSec: Number(m[4]), started: get('STARTED').join(' ').trim(), rssBytes: Number(m[5]) * 1024, vszBytes: Number(m[6]) * 1024,
    threads: Number(m[7]), comm: m[8], args: m[9].trim(), hwmBytes: kb(status.get('VmHWM')), swapBytes: kb(status.get('VmSwap')), state: status.get('State') ?? '',
    exe, cwd, unit: get('UNIT').map((l) => l.trim()).find(Boolean) ?? null, fds: Number(get('FDS')[0]?.trim()) || null,
    fdLimit: limit && limit !== 'unlimited' ? Number(limit) : null,
    cpuPct: a !== null && b !== null ? Math.max(0, ((b - a) / HZ / 1 / cpus) * 100) : null,
    tech: techOf(m[8], m[9], Number(m[2])), listening, connections: parseEstablished(get('EST'), new Map([[pid, m[8]]]))
  }
}

/** Processes grouped by technology, busiest first. */
export function technologies(ps: ProcInfo[]): { tech: string; processes: number; cpuPct: number; rssBytes: number }[] {
  const by = new Map<string, { tech: string; processes: number; cpuPct: number; rssBytes: number }>()
  for (const p of ps) {
    const t = by.get(p.tech) ?? { tech: p.tech, processes: 0, cpuPct: 0, rssBytes: 0 }
    t.processes++
    t.cpuPct += p.cpuPct ?? 0
    t.rssBytes += p.rssBytes
    by.set(p.tech, t)
  }
  return [...by.values()].sort((a, b) => b.rssBytes - a.rssBytes)
}

/** A host's metrics over a window, one point per step (null where there was no sample). */
export interface HostHistory {
  source: 'prometheus' | 'cloudwatch' | 'none'
  hours: number
  /** ms */
  start: number
  /** s */
  step: number
  cpu: (number | null)[]
  memPct: (number | null)[]
  memUsed: (number | null)[]
  netIn: (number | null)[]
  netOut: (number | null)[]
  diskRead: (number | null)[]
  diskWrite: (number | null)[]
  note?: string
}

/** What usually listens on a port, in this fleet and in general. */
const PORTS: Record<number, string> = {
  22: 'SSH', 25: 'SMTP', 53: 'DNS', 80: 'HTTP', 111: 'RPC bind', 389: 'LDAP', 443: 'HTTPS', 636: 'LDAPS', 1433: 'SQL Server', 1521: 'Oracle', 2049: 'NFS',
  3000: 'Grafana', 3100: 'Loki', 3306: 'MySQL', 3389: 'RDP', 4085: 'DS License Server', 5432: 'PostgreSQL', 8001: 'Jolokia', 8005: 'Tomcat shutdown', 8006: 'Tomcat shutdown',
  9080: 'Promtail', 9090: 'Prometheus', 9093: 'Alertmanager', 9100: 'node exporter', 9115: 'blackbox exporter', 9182: 'windows exporter', 9404: 'JMX exporter', 9117: 'Apache exporter'
}
export const portName = (port: number | null): string | null => (port === null ? null : PORTS[port] ?? null)

/** Bytes a second, as "1.2 MB/s". */
export function formatRate(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return '–'
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  let v = bps
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

export interface Peer {
  /** The other end's address. */
  remote: string
  /** Its name from the inventory, when it is one of ours. */
  name: string | null
  /** Ports involved: ours coming in, theirs going out. */
  ports: number[]
  connections: number
  processes: string[]
}

/**
 * Connections folded into one row per other machine and direction, busiest first: "called by 10.1.2.52 on 8060 (12)",
 * "talks to qa-db on 1521 (21)". `nameOf` maps an address to a server's name.
 */
export function peers(conns: Conn[], direction: 'in' | 'out', nameOf: (ip: string) => string | null): Peer[] {
  const by = new Map<string, Peer>()
  for (const c of conns.filter((x) => x.direction === direction)) {
    const p = by.get(c.remote) ?? { remote: c.remote, name: nameOf(c.remote), ports: [], connections: 0, processes: [] }
    const port = direction === 'in' ? c.localPort : c.remotePort
    if (port !== null && !p.ports.includes(port)) p.ports.push(port)
    if (c.process && !p.processes.includes(c.process)) p.processes.push(c.process)
    p.connections += c.count
    by.set(c.remote, p)
  }
  for (const p of by.values()) p.ports.sort((a, b) => a - b)
  return [...by.values()].sort((a, b) => b.connections - a.connections || a.remote.localeCompare(b.remote, undefined, { numeric: true }))
}

/** The fullest disk that is the server's own (not a share mounted from elsewhere). */
export function fullestOwnDisk(disks: DiskInfo[]): DiskInfo | null {
  const own = disks.filter((d) => !/^(nfs|nfs4|cifs|smb|fuse|efs)/.test(d.fs) && d.size > 0)
  return own.sort((a, b) => b.used / b.size - a.used / a.size)[0] ?? null
}

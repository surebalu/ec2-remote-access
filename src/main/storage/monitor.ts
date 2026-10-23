import { execFile } from 'node:child_process'
import { cpus, loadavg, networkInterfaces, totalmem, uptime } from 'node:os'
import {
  groupByApp, KEEP_OPEN, memoryFrom, parseBattery, parseDiskIo, parseNetstat, parsePs, parseSwap, parseVmStat,
  type BatteryInfo, type MonitorSample, type OpenApp
} from '@shared/macApps'
import { runningApps } from './running'

/**
 * The Monitor and Optimize rooms (Mac app only): one reading of the processor, memory, disk, network and battery each
 * time the Monitor asks (every two seconds while it is shown; rates are since the last reading), and the open apps with
 * what each holds and when it was last in front. Everything is read with macOS's own tools, which ask no permission.
 */

function out(cmd: string, args: string[], timeout = 10_000): Promise<string> {
  return new Promise((resolve) => execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (_err, stdout) => resolve(stdout ?? '')))
}

let prevCpu: { idle: number; total: number; user: number; sys: number }[] | null = null
let prevCounters: { at: number; rx: number; tx: number; read: number; write: number } | null = null
let battery: { at: number; value: BatteryInfo | null } | null = null

function cpuUse(): { all: number; user: number; sys: number; cores: number[] } {
  const now = cpus().map((c) => { const t = c.times; return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq, user: t.user + t.nice, sys: t.sys + t.irq } })
  const before = prevCpu
  prevCpu = now
  if (!before || before.length !== now.length) return { all: 0, user: 0, sys: 0, cores: now.map(() => 0) }
  const cores = now.map((c, i) => { const dt = c.total - before[i].total; return dt > 0 ? Math.round((1 - (c.idle - before[i].idle) / dt) * 1000) / 10 : 0 })
  const dt = now.reduce((s, c, i) => s + c.total - before[i].total, 0) || 1
  const pct = (k: 'user' | 'sys'): number => Math.round((now.reduce((s, c, i) => s + c[k] - before[i][k], 0) / dt) * 1000) / 10
  return { all: Math.round((cores.reduce((s, x) => s + x, 0) / cores.length) * 10) / 10, user: pct('user'), sys: pct('sys'), cores }
}

export async function monitorSample(): Promise<MonitorSample> {
  const [vm, sysctl, netstat, io, ps, therm] = await Promise.all([
    out('vm_stat', []),
    out('sysctl', ['-n', 'hw.pagesize', 'vm.swapusage', 'kern.memorystatus_vm_pressure_level']),
    out('netstat', ['-ibn']),
    out('ioreg', ['-c', 'IOBlockStorageDriver', '-r', '-w0']),
    out('ps', ['-axo', 'pid=,ppid=,%cpu=,rss=,comm=']),
    out('pmset', ['-g', 'therm'])
  ])
  if (!battery || Date.now() - battery.at > 30_000) battery = { at: Date.now(), value: parseBattery(await out('ioreg', ['-rn', 'AppleSmartBattery'])) }
  const [pageLine, swapLine, pressureLine] = sysctl.split('\n')
  const memory = memoryFrom(parseVmStat(vm), Number(pageLine) || 16384, totalmem(), parseSwap(swapLine ?? ''), Number(pressureLine) || 1)
  const net = parseNetstat(netstat)
  const disk = parseDiskIo(io)
  const now = Date.now()
  const prev = prevCounters
  prevCounters = { at: now, rx: net.rx, tx: net.tx, read: disk.read, write: disk.write }
  const secs = prev ? Math.max(0.5, (now - prev.at) / 1000) : 0
  const rate = (a: number, b: number): number => (prev && a >= b ? Math.round((a - b) / secs) : 0)
  const cpu = cpuUse()
  const apps = groupByApp(parsePs(ps)).filter((a) => a.cpu > 0.2 || a.memory > 150e6)
  const address = Object.entries(networkInterfaces()).filter(([n]) => /^en\d/.test(n)).flatMap(([, list]) => list ?? []).find((a) => a.family === 'IPv4' && !a.internal)?.address ?? null
  return {
    at: now, cpu: cpu.all, cpuUser: cpu.user, cpuSys: cpu.sys, cores: cpu.cores, load: loadavg() as [number, number, number], memory,
    net: { rx: rate(net.rx, prev?.rx ?? 0), tx: rate(net.tx, prev?.tx ?? 0) },
    disk: { read: rate(disk.read, prev?.read ?? 0), write: rate(disk.write, prev?.write ?? 0) },
    battery: battery.value, uptime: uptime(),
    apps: apps.sort((a, b) => b.cpu - a.cpu).slice(0, 40),
    address,
    thermal: /CPU_Speed_Limit\s*=\s*(\d+)/.exec(therm) && Number(/CPU_Speed_Limit\s*=\s*(\d+)/.exec(therm)![1]) < 100 ? 'warm' : 'normal'
  }
}

// ----- Which app is in front, watched from the first time Optimize asks -----

const lastFront = new Map<string, number>()
let watching: NodeJS.Timeout | null = null
let frontId = ''

async function noteFront(): Promise<void> {
  const asn = (await out('lsappinfo', ['front'], 5000)).trim()
  if (!asn) return
  const id = /bundleID="([^"]*)"/.exec(await out('lsappinfo', ['info', '-only', 'bundleid', asn], 5000))?.[1] ?? ''
  if (!id) return
  frontId = id
  lastFront.set(id, Date.now())
}

/** Starts noting the front app every 30 seconds (two lsappinfo calls), for Optimize's "not in front for half an hour". */
export function watchFront(): void {
  if (watching) return
  void noteFront()
  watching = setInterval(() => void noteFront(), 30_000)
  watching.unref()
}
const watchedSince = Date.now()

/** The open apps (those with a Dock icon), what each holds, and whether it has been idle long enough to quit. */
export async function openApps(): Promise<{ apps: OpenApp[]; watchedFor: number }> {
  watchFront()
  await noteFront()
  const running = (await runningApps()).filter((a) => a.type === 'Foreground' && a.path && !a.path.startsWith('/System/Library/CoreServices/'))
  const usage = groupByApp(parsePs(await out('ps', ['-axo', 'pid=,ppid=,%cpu=,rss=,comm='])))
  const now = Date.now()
  const apps = running.map((r): OpenApp => {
    const u = usage.find((x) => x.path === r.path)
    const seen = lastFront.get(r.id) ?? null
    const busy = (u?.cpu ?? 0) >= 5
    const keep = KEEP_OPEN.has(r.id) || r.id === 'com.mainspring.ec2-remote-access'
    // Unseen in front since watching began counts from then, so nothing looks idle in its first half hour.
    const away = now - (seen ?? watchedSince)
    return { name: r.name, id: r.id, path: r.path, pid: r.pid, memory: u?.memory ?? 0, cpu: Math.round((u?.cpu ?? 0) * 10) / 10, lastFront: seen, front: r.id === frontId, busy, keep, idle: !busy && !keep && r.id !== frontId && away >= 30 * 60_000 }
  })
  return { apps: apps.sort((a, b) => b.memory - a.memory), watchedFor: now - watchedSince }
}

export function closeMonitor(): void {
  if (watching) clearInterval(watching)
  watching = null
}

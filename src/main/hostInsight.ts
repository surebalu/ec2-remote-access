import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch'
import { GC_RANGES } from '@shared/plmHealth'
import { parseProcess, parseSnapshot, processScript, snapshotScript, type HostHistory, type HostSnapshot, type ProcessDetail } from '@shared/hostInsight'
import { findInstance } from './aws/inventory'
import { credentialsFor } from './aws/credentials'
import { cannotRun, runScript } from './aws/ssmScript'
import { promHistory } from './plmHealth'

/**
 * The host page's data (channels host:*): a live snapshot of a Linux server and of one of its processes, through SSM
 * (src/shared/hostInsight.ts has the scripts), and its metrics over a window from Prometheus when an exporter watches
 * it, otherwise from CloudWatch (CPU and network only: EC2 does not report memory without its agent).
 */

const unreachable = (key: string): string | null => {
  const inst = findInstance(key)
  return cannotRun(inst)
}

export async function hostSnapshot(key: string): Promise<HostSnapshot> {
  const why = unreachable(key)
  if (why) throw new Error(why)
  const inst = findInstance(key)
  const r = (await runScript([inst], snapshotScript(), { timeoutSec: 60, comment: 'EC2 Remote Access: host page snapshot' })).get(key)
  if (!r?.stdout) throw new Error(r?.error ?? (r?.stderr.trim() || 'No answer from the server.'))
  return parseSnapshot(r.stdout, Date.now())
}

export async function hostProcess(key: string, pid: number): Promise<ProcessDetail> {
  const why = unreachable(key)
  if (why) throw new Error(why)
  const inst = findInstance(key)
  const r = (await runScript([inst], processScript(pid), { timeoutSec: 30, comment: 'EC2 Remote Access: process detail' })).get(key)
  if (!r?.stdout) throw new Error(r?.error ?? (r?.stderr.trim() || 'No answer from the server.'))
  return parseProcess(r.stdout, pid, Date.now())
}

const cache = new Map<string, { at: number; d: HostHistory }>()

export async function hostHistory(key: string, hours: number): Promise<HostHistory> {
  const inst = findInstance(key)
  const r = GC_RANGES.find((x) => x.hours === hours) ?? GC_RANGES[2]
  const ck = `${key}|${r.hours}`
  const had = cache.get(ck)
  if (had && Date.now() - had.at < (r.hours <= 1 ? 12_000 : 50_000)) return had.d
  const n = Math.round((r.hours * 3600) / r.step) + 1
  const blank = (): (number | null)[] => new Array<number | null>(n).fill(null)
  let d: HostHistory = { source: 'none', hours: r.hours, start: Date.now() - r.hours * 3_600_000, step: r.step, cpu: blank(), memPct: blank(), memUsed: blank(), netIn: blank(), netOut: blank(), diskRead: blank(), diskWrite: blank() }
  const ip = inst.privateIp
  if (ip && !inst.manual) {
    const w = `[${Math.max(r.step, 60) * 2}s]`
    const win = inst.platform === 'windows'
    const sel = `instance="${ip}:${win ? 9182 : 9100}"`
    const q: Record<string, string> = win
      ? {
          cpu: `100 - avg(rate(windows_cpu_time_total{${sel},mode="idle"}${w})) * 100`,
          memPct: `100 * (1 - windows_memory_available_bytes{${sel}} / windows_memory_physical_total_bytes{${sel}})`,
          memUsed: `windows_memory_physical_total_bytes{${sel}} - windows_memory_available_bytes{${sel}}`,
          netIn: `sum(rate(windows_net_bytes_received_total{${sel}}${w}))`, netOut: `sum(rate(windows_net_bytes_sent_total{${sel}}${w}))`,
          diskRead: `sum(rate(windows_logical_disk_read_bytes_total{${sel}}${w}))`, diskWrite: `sum(rate(windows_logical_disk_write_bytes_total{${sel}}${w}))`
        }
      : {
          cpu: `100 * (1 - avg(rate(node_cpu_seconds_total{${sel},mode="idle"}${w})))`,
          memPct: `100 * (1 - node_memory_MemAvailable_bytes{${sel}} / node_memory_MemTotal_bytes{${sel}})`,
          memUsed: `node_memory_MemTotal_bytes{${sel}} - node_memory_MemAvailable_bytes{${sel}}`,
          netIn: `sum(rate(node_network_receive_bytes_total{${sel},device!~"lo|veth.*|docker.*|br-.*"}${w}))`,
          netOut: `sum(rate(node_network_transmit_bytes_total{${sel},device!~"lo|veth.*|docker.*|br-.*"}${w}))`,
          diskRead: `sum(rate(node_disk_read_bytes_total{${sel},device!~"dm-.*"}${w}))`, diskWrite: `sum(rate(node_disk_written_bytes_total{${sel},device!~"dm-.*"}${w}))`
        }
    const p = await promHistory(q, r.hours).catch(() => null)
    if (p && p.series.cpu?.some((v) => v !== null)) {
      const s = (k: string): (number | null)[] => p.series[k] ?? blank()
      d = { source: 'prometheus', hours: r.hours, start: p.start, step: p.step, cpu: s('cpu'), memPct: s('memPct'), memUsed: s('memUsed'), netIn: s('netIn'), netOut: s('netOut'), diskRead: s('diskRead'), diskWrite: s('diskWrite') }
    }
  }
  if (d.source === 'none' && !inst.manual) {
    // CloudWatch: basic monitoring has a point every five minutes.
    const period = Math.max(300, r.step)
    const end = new Date()
    const start = new Date(end.getTime() - r.hours * 3_600_000)
    const cw = new CloudWatchClient({ region: inst.region, credentials: credentialsFor(inst.profile) })
    try {
      const dims = [{ Name: 'InstanceId', Value: inst.instanceId }]
      const out = await cw.send(new GetMetricDataCommand({
        StartTime: start, EndTime: end, ScanBy: 'TimestampAscending',
        MetricDataQueries: [['cpu', 'CPUUtilization', 'Average'], ['netIn', 'NetworkIn', 'Sum'], ['netOut', 'NetworkOut', 'Sum'], ['diskRead', 'EBSReadBytes', 'Sum'], ['diskWrite', 'EBSWriteBytes', 'Sum']].map(([id, name, stat]) => ({
          Id: id, MetricStat: { Metric: { Namespace: 'AWS/EC2', MetricName: name, Dimensions: dims }, Period: period, Stat: stat }
        }))
      }))
      const m = Math.round((r.hours * 3600) / period) + 1
      const put = (id: string, perSecond: boolean): (number | null)[] => {
        const res = out.MetricDataResults?.find((x) => x.Id === id)
        const arr = new Array<number | null>(m).fill(null)
        res?.Timestamps?.forEach((t, i) => {
          const k = Math.round((t.getTime() - start.getTime()) / 1000 / period)
          const v = res.Values?.[i]
          if (k >= 0 && k < m && v !== undefined) arr[k] = perSecond ? v / period : v
        })
        return arr
      }
      const mm = (): (number | null)[] => new Array<number | null>(m).fill(null)
      d = {
        source: 'cloudwatch', hours: r.hours, start: start.getTime(), step: period, cpu: put('cpu', false), memPct: mm(), memUsed: mm(),
        netIn: put('netIn', true), netOut: put('netOut', true), diskRead: put('diskRead', true), diskWrite: put('diskWrite', true),
        note: 'From CloudWatch: no exporter watches this host, and EC2 does not report memory without its agent.'
      }
    } catch (e) {
      d.note = `No metrics: ${(e as Error).message}`
    } finally {
      cw.destroy()
    }
  }
  cache.set(ck, { at: Date.now(), d })
  return d
}

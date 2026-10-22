import { useEffect, useMemo, useState, type PointerEvent, type ReactElement } from 'react'
import { GC_RANGES, LIMITS, ROLES, SERVICE_ORDER, formatBytes, formatPct, levelOf, type Level, type MachineMemory, type MemoryHistory, type PlmEnvId, type Spark as SparkData } from '@shared/plmHealth'
import { Icon } from '../icons'
import { mayPoll } from './poll'
import { Dot, Empty, MARKS, Pill, SectionHead, Spark, lvl } from './parts'
import Comb, { type CombItem } from './Comb'

/**
 * Every machine's memory and CPU: a honeycomb of each now (same bands for both: green under 80%, yellow to 90%, red
 * above), then one small chart per machine on the same 0–100% scale for the one chosen (small multiples: with
 * twenty-odd machines, one line each in a single chart is unreadable). Pointing at any chart moves one crosshair through
 * all of them, so the machines can be compared at the same moment.
 */

const KEY = 'ui.health.memHours'
const seen = new Map<string, MemoryHistory>()
const readHours = (): number => { try { const n = Number(localStorage.getItem(KEY)); return GC_RANGES.some((r) => r.hours === n) ? n : 24 } catch { return 24 } }
type Filter = 'running' | 'high' | 'stopped'
type Metric = 'mem' | 'cpu'
const METRIC_KEY = 'ui.health.machineMetric'
const readMetric = (): Metric => { try { return localStorage.getItem(METRIC_KEY) === 'cpu' ? 'cpu' : 'mem' } catch { return 'mem' } }
const NOUN: Record<Metric, string> = { mem: 'memory', cpu: 'CPU' }

/** One machine's numbers for the metric shown (readings from before CPU was added have none). */
interface View { values: SparkData; now: number | null; peak: number | null; avg: number | null; level: Level; limits: readonly [number, number] }
const viewOf = (m: MachineMemory, metric: Metric): View => metric === 'cpu'
  ? { values: m.cpu ?? [], now: m.cpuNow ?? null, peak: m.cpuPeak ?? null, avg: m.cpuAvg ?? null, level: m.state === 'stopped' ? 'off' : m.cpuLevel ?? 'unknown', limits: LIMITS.machineCpu }
  : { values: m.pct, now: m.now, peak: m.peak, avg: m.avg, level: m.state === 'stopped' ? 'off' : m.level, limits: LIMITS.mem }

/** The honeycombs' words: green under 80%, yellow 80–90%, red at 90% or more, for memory and CPU alike. */
const wordsFor = (l: readonly [number, number]): Record<Level, string> => ({ ok: `Under ${l[0]}%`, warn: `${l[0]}–${l[1]}%`, crit: `${l[1]}% or more`, off: 'Stopped', unknown: 'No data' })
type MemItem = CombItem & { m: MachineMemory; v: View }
const cellOf = (m: MachineMemory, metric: Metric): MemItem => {
  const v = viewOf(m, metric)
  const level: Level = v.level === 'off' ? 'off' : v.now === null ? 'unknown' : levelOf(v.now, v.limits)
  const id = ROLES.find((r) => r.name === m.role)?.id ?? ''
  const letters = m.role.replace(/^3D/, '').replace(/[^A-Za-z]/g, '')
  return {
    id: m.ip, ip: m.ip, m, v, level, mark: MARKS[id]?.[0] ?? (letters.slice(0, 1).toUpperCase() + letters.slice(1, 2).toLowerCase()),
    label: level === 'off' ? '' : v.now === null ? '–' : `${Math.round(v.now)}%`,
    aria: `${m.role}${m.label ? ` ${m.label}` : ''} (${m.name}): ${level === 'off' ? 'stopped' : `${NOUN[metric]} ${formatPct(v.now)}`}`
  }
}

const when = (t: number, hours: number): string =>
  hours <= 24 ? new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export default function MemoryGrid({ env, active }: { env: PlmEnvId; active: boolean }): ReactElement {
  const [hours, setHours] = useState(readHours)
  const key = `${env}|${hours}`
  const [d, setD] = useState<MemoryHistory | null>(seen.get(key) ?? null)
  const [error, setError] = useState<string | null>(null)
  const [hover, setHoverAt] = useState<{ i: number; ip: string } | null>(null)
  const setHover = (i: number | null, ip = ''): void => setHoverAt(i === null ? null : { i, ip })
  const [filter, setFilter] = useState<Filter>('running')
  const [metric, setMetricState] = useState<Metric>(readMetric)
  const setMetric = (x: Metric): void => { setMetricState(x); try { localStorage.setItem(METRIC_KEY, x) } catch { /* storage off */ } }
  useEffect(() => {
    setD(seen.get(key) ?? null)
    let gone = false
    const load = (): void => {
      window.api.invoke('health:memory', env, hours).then(
        (x) => { seen.set(key, x); if (!gone) { setD(x); setError(null) } },
        (e: Error) => { if (!gone) setError(e.message) }
      )
    }
    if (active) load()
    const t = setInterval(() => { if (active && mayPoll()) load() }, hours <= 1 ? 15_000 : 60_000)
    return () => { gone = true; clearInterval(t) }
  }, [key, active]) // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (h: number): void => { setHours(h); setHover(null); try { localStorage.setItem(KEY, String(h)) } catch { /* storage off */ } }

  // The charts: the worst first for the metric shown.
  const worst = (l: Level): number => ({ crit: 0, warn: 1, ok: 2, unknown: 3, off: 4 })[l]
  const machines = [...(d?.machines ?? [])].sort((a, b) => worst(viewOf(a, metric).level) - worst(viewOf(b, metric).level) || (viewOf(b, metric).now ?? -1) - (viewOf(a, metric).now ?? -1))
  const running = machines.filter((m) => m.state !== 'stopped')
  const stopped = machines.filter((m) => m.state === 'stopped')
  const limits = metric === 'cpu' ? LIMITS.machineCpu : LIMITS.mem
  const high = machines.filter((m) => m.state !== 'stopped' && (viewOf(m, metric).now ?? 0) >= limits[0])
  const shown = filter === 'high' ? high : filter === 'stopped' ? stopped : running
  const at = d && hover ? d.start + hover.i * d.step * 1000 : null
  // The honeycombs in the services' order, never by value, so a machine keeps its place as its colour changes.
  const rank = (m: MachineMemory): number => { const i = SERVICE_ORDER.indexOf(ROLES.find((r) => r.name === m.role)?.id ?? ''); return i < 0 ? SERVICE_ORDER.length : i }
  const ordered = [...machines].sort((a, b) => rank(a) - rank(b) || `${a.role} ${a.label}`.localeCompare(`${b.role} ${b.label}`, undefined, { numeric: true }) || a.ip.localeCompare(b.ip, undefined, { numeric: true }))
  const memItems = ordered.map((m) => cellOf(m, 'mem'))
  const cpuItems = ordered.map((m) => cellOf(m, 'cpu'))
  const hasCpu = machines.some((m) => m.cpu)
  const [lit, setLit] = useState<string | null>(null)
  // A cell picked in a honeycomb: show its chart for that metric (whatever the filter) and light it up.
  const pickMachine = (it: MemItem, x: Metric): void => {
    const want: Filter = it.m.state === 'stopped' ? 'stopped' : 'running'
    setMetric(x)
    const stillShown = filter === 'high' ? it.m.state !== 'stopped' && (viewOf(it.m, x).now ?? 0) >= (x === 'cpu' ? LIMITS.machineCpu : LIMITS.mem)[0] : shown.some((m) => m.ip === it.m.ip)
    if (!stillShown) setFilter(want)
    setLit(it.m.ip)
    setTimeout(() => document.querySelector(`.hl-mem[data-ip="${CSS.escape(it.m.ip)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 30)
    setTimeout(() => setLit((x) => (x === it.m.ip ? null : x)), 1800)
  }
  return (
    <>
      <SectionHead id="hl-memory" icon={<Icon.server />} title="Memory and CPU by machine" sub={at ? `At ${when(at, hours)}: point anywhere to compare all machines at that moment` : `${metric === 'cpu' ? 'CPU busy' : 'Memory in use'} on each machine, on one 0–100% scale`}
        right={
          <div className="hl-sec-controls">
            <div className="hl-seg" role="group" aria-label="Charts of">
              <button type="button" className={metric === 'mem' ? 'on' : ''} aria-pressed={metric === 'mem'} onClick={() => setMetric('mem')}>Memory</button>
              <button type="button" className={metric === 'cpu' ? 'on' : ''} aria-pressed={metric === 'cpu'} onClick={() => setMetric('cpu')} disabled={!!d && !hasCpu} title={d && !hasCpu ? 'This reading has no CPU yet' : undefined}>CPU</button>
            </div>
            <div className="hl-seg" role="group" aria-label="Machines shown">
              <button type="button" className={filter === 'running' ? 'on' : ''} aria-pressed={filter === 'running'} onClick={() => setFilter('running')}>Running<span>{running.length}</span></button>
              <button type="button" className={filter === 'high' ? 'on' : ''} aria-pressed={filter === 'high'} onClick={() => setFilter('high')}>Above {limits[0]}%<span>{high.length}</span></button>
              {stopped.length > 0 && <button type="button" className={filter === 'stopped' ? 'on' : ''} aria-pressed={filter === 'stopped'} onClick={() => setFilter('stopped')}>Stopped<span>{stopped.length}</span></button>}
            </div>
            <div className="hl-seg" role="group" aria-label="Time range">
              {GC_RANGES.map((r) => <button key={r.hours} type="button" className={r.hours === hours ? 'on' : ''} aria-pressed={r.hours === hours} onClick={() => pick(r.hours)}>{r.label}</button>)}
            </div>
          </div>
        } />
      {d && memItems.length > 0 && (
        <div className="hl-mem-combs">
          <Comb kind="mem" title="Memory now" sub={`In use: green under ${LIMITS.mem[0]}%, yellow to ${LIMITS.mem[1]}%, red above`} items={memItems} words={wordsFor(LIMITS.mem)}
            foot={() => 'to see its memory chart'} onPick={(it) => pickMachine(it, 'mem')} tip={(it) => <MachineTip it={it} metric="mem" hours={hours} />} />
          {hasCpu && (
            <Comb kind="cpu" title="CPU now" sub={`Busy, last 5 min: green under ${LIMITS.machineCpu[0]}%, yellow to ${LIMITS.machineCpu[1]}%, red above`} items={cpuItems} words={wordsFor(LIMITS.machineCpu)}
              foot={() => 'to see its CPU chart'} onPick={(it) => pickMachine(it, 'cpu')} tip={(it) => <MachineTip it={it} metric="cpu" hours={hours} />} />
          )}
        </div>
      )}
      {!d && !error && <div className="hl-mem-grid">{Array.from({ length: 6 }, (_, i) => <div key={i} className="hl-card hl-skel" style={{ height: 150 }} />)}</div>}
      {!d && error && <Empty>{error}</Empty>}
      {d && (
        <div className="hl-mem-grid" onPointerLeave={() => setHover(null)}>
          {shown.map((m) => <MemTile key={m.ip} m={m} metric={metric} d={d} hover={hover?.i ?? null} pointing={hover?.ip === m.ip} lit={lit === m.ip} onHover={(i) => setHover(i, m.ip)} />)}
          {!shown.length && <Empty>{filter === 'high' ? `No machine's ${NOUN[metric]} is above ${limits[0]}%.` : 'No machines here.'}</Empty>}
        </div>
      )}
    </>
  )
}

function MachineTip({ it, metric, hours }: { it: MemItem; metric: Metric; hours: number }): ReactElement {
  const { m, v } = it
  return (
    <>
      <div className="hl-hex-tip-head"><Dot level={it.level} /><strong className="min-w-0 flex-1">{m.role}{m.label ? ` ${m.label}` : ''}</strong><Pill level={it.level}>{it.level === 'off' ? 'Stopped' : formatPct(v.now)}</Pill></div>
      <div className="hl-hex-tip-sub">{m.name}<span className="hl-hex-tip-url">{m.ip}</span></div>
      {it.level !== 'off' && (
        <div className="hl-hex-tip-stats">
          <div className="hl-hex-tip-stat"><span>{metric === 'cpu' ? 'Busy' : 'In use'}</span><strong>{metric === 'mem' && m.totalBytes && v.now !== null ? formatBytes((v.now / 100) * m.totalBytes) : formatPct(v.now)}</strong></div>
          <div className="hl-hex-tip-stat"><span>Peak</span><strong>{formatPct(v.peak)}</strong></div>
          <div className="hl-hex-tip-stat"><span>Average</span><strong>{formatPct(v.avg)}</strong></div>
        </div>
      )}
      {it.level !== 'off' && <Spark values={v.values} min={0} max={100} height={34} level={it.level === 'unknown' ? 'ok' : it.level} />}
      {metric === 'mem' && m.totalBytes ? <p className="hl-hex-tip-note">Of {formatBytes(m.totalBytes, 0)}, over the last {hours < 24 ? `${hours} h` : `${hours / 24} d`}.</p> : null}
      {metric === 'cpu' && m.cores ? <p className="hl-hex-tip-note">Of {m.cores} {m.cores === 1 ? 'core' : 'cores'}, over the last {hours < 24 ? `${hours} h` : `${hours / 24} d`}.</p> : null}
    </>
  )
}

function MemTile({ m, metric, d, hover, pointing, lit, onHover }: { m: MachineMemory; metric: Metric; d: MemoryHistory; hover: number | null; pointing: boolean; lit: boolean; onHover: (i: number | null) => void }): ReactElement {
  const v = viewOf(m, metric)
  const n = v.values.length
  const paths = useMemo(() => {
    const line: string[] = []
    const area: string[] = []
    let run: [number, number][] = []
    const flush = (): void => {
      if (run.length > 1) {
        line.push(run.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${(100 - y).toFixed(2)}`).join(''))
        area.push(`M${run[0][0]},100` + run.map(([x, y]) => `L${x},${(100 - y).toFixed(2)}`).join('') + `L${run[run.length - 1][0]},100Z`)
      }
      run = []
    }
    v.values.forEach((x, i) => (x === null ? flush() : run.push([i, Math.max(0, Math.min(100, x))])))
    flush()
    return { line, area }
  }, [v.values])
  const move = (e: PointerEvent<HTMLDivElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    const i = Math.round(((e.clientX - r.left) / r.width) * (n - 1))
    onHover(i >= 0 && i < n ? i : null)
  }
  const hv = hover === null ? null : v.values[hover] ?? null
  const value = hover !== null ? hv : v.now
  const off = m.state === 'stopped'
  const level = v.level
  return (
    <article className={`hl-card hl-mem ${lvl(level)} ${off ? 'off' : ''} ${lit ? 'lit' : ''}`} data-ip={m.ip}>
      <div className="hl-mem-head">
        <div className="min-w-0">
          <div className="hl-row-title"><Dot level={level} /><span className="truncate">{m.role}{m.label ? ` ${m.label}` : ''}</span>{m.os === 'windows' && <Icon.windows />}</div>
          <div className="hl-row-sub truncate" title={`${m.name} · ${m.ip}`}>{m.name}</div>
        </div>
        <div className="hl-mem-now">
          {off ? <Pill level="off">Stopped</Pill> : (
            <>
              <strong className={hover !== null ? 'at' : ''}>{formatPct(value)}</strong>
              <span>{metric === 'cpu' ? (m.cores ? `of ${m.cores} ${m.cores === 1 ? 'core' : 'cores'}` : 'CPU') : m.totalBytes ? `of ${formatBytes(m.totalBytes, 0)}` : ''}</span>
            </>
          )}
        </div>
      </div>
      <div className="hl-mem-chart" onPointerMove={move}>
        <svg viewBox={`0 0 ${Math.max(1, n - 1)} 100`} preserveAspectRatio="none" aria-label={`${m.role} ${m.label} ${NOUN[metric]}: now ${formatPct(v.now)}, peak ${formatPct(v.peak)}`}>
          <line x1="0" x2={n - 1} y1={100 - v.limits[0]} y2={100 - v.limits[0]} className="hl-mem-limit warn" vectorEffect="non-scaling-stroke" />
          <line x1="0" x2={n - 1} y1={100 - v.limits[1]} y2={100 - v.limits[1]} className="hl-mem-limit crit" vectorEffect="non-scaling-stroke" />
          {paths.area.map((p, i) => <path key={`a${i}`} d={p} className="hl-mem-area" />)}
          {paths.line.map((p, i) => <path key={`l${i}`} d={p} className="hl-mem-line" vectorEffect="non-scaling-stroke" />)}
          {hover !== null && <line x1={hover} x2={hover} y1="0" y2="100" className="hl-mem-cross" vectorEffect="non-scaling-stroke" />}
        </svg>
        {pointing && hover !== null && hv !== null && (
          <div className="hl-mem-tip" style={{ left: `${Math.min(70, Math.max(0, (hover / Math.max(1, n - 1)) * 100 - 15))}%` }}>
            <strong>{formatPct(hv)}</strong>
            <span>{metric === 'mem' && m.totalBytes ? `${formatBytes((hv / 100) * m.totalBytes)} used` : metric === 'cpu' ? 'busy' : ''}</span>
            <span className="muted">{when(d.start + hover * d.step * 1000, d.hours)}</span>
          </div>
        )}
      </div>
      <div className="hl-mem-foot">
        <span>Peak <strong>{formatPct(v.peak)}</strong></span>
        <span>Average <strong>{formatPct(v.avg)}</strong></span>
        {m.state === 'stopped' && <span className="muted">Stopped in EC2</span>}
      </div>
    </article>
  )
}

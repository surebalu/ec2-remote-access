import { useEffect, useMemo, useState, type PointerEvent, type ReactElement } from 'react'
import { GC_RANGES, LIMITS, ROLES, SERVICE_ORDER, formatBytes, formatPct, levelOf, type Level, type MachineMemory, type MemoryHistory, type PlmEnvId } from '@shared/plmHealth'
import { Icon } from '../icons'
import { mayPoll } from './poll'
import { Dot, Empty, MARKS, Pill, SectionHead, Spark, lvl } from './parts'
import Comb, { type CombItem } from './Comb'

/**
 * Every machine's memory over a window, one small chart per machine on the same 0–100% scale (small multiples: with
 * twenty-odd machines, one line each in a single chart is unreadable). Pointing at any chart moves one crosshair through
 * all of them, so the machines can be compared at the same moment.
 */

const KEY = 'ui.health.memHours'
const seen = new Map<string, MemoryHistory>()
const readHours = (): number => { try { const n = Number(localStorage.getItem(KEY)); return GC_RANGES.some((r) => r.hours === n) ? n : 24 } catch { return 24 } }
type Filter = 'running' | 'high' | 'stopped'

/** The memory honeycomb's words: green under 80% in use, yellow 80–90%, red at 90% or more (the monitoring rules). */
const MEM_WORDS: Record<Level, string> = { ok: `Under ${LIMITS.mem[0]}%`, warn: `${LIMITS.mem[0]}–${LIMITS.mem[1]}%`, crit: `${LIMITS.mem[1]}% or more`, off: 'Stopped', unknown: 'No data' }
type MemItem = CombItem & { m: MachineMemory }
const memItem = (m: MachineMemory): MemItem => {
  const level: Level = m.state === 'stopped' ? 'off' : levelOf(m.now, LIMITS.mem)
  const id = ROLES.find((r) => r.name === m.role)?.id ?? ''
  const letters = m.role.replace(/^3D/, '').replace(/[^A-Za-z]/g, '')
  return {
    id: m.ip, ip: m.ip, m, level, mark: MARKS[id]?.[0] ?? (letters.slice(0, 1).toUpperCase() + letters.slice(1, 2).toLowerCase()),
    label: level === 'off' ? '' : m.now === null ? '–' : `${Math.round(m.now)}%`,
    aria: `${m.role}${m.label ? ` ${m.label}` : ''} (${m.name}): ${level === 'off' ? 'stopped' : `memory ${formatPct(m.now)}`}`
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

  const machines = d?.machines ?? []
  const running = machines.filter((m) => m.state !== 'stopped')
  const stopped = machines.filter((m) => m.state === 'stopped')
  const high = machines.filter((m) => m.level === 'warn' || m.level === 'crit')
  const shown = filter === 'high' ? high : filter === 'stopped' ? stopped : running
  const at = d && hover ? d.start + hover.i * d.step * 1000 : null
  // In the services' order, never by memory, so a machine keeps its place as its colour changes.
  const rank = (m: MachineMemory): number => { const i = SERVICE_ORDER.indexOf(ROLES.find((r) => r.name === m.role)?.id ?? ''); return i < 0 ? SERVICE_ORDER.length : i }
  const items = [...machines].sort((a, b) => rank(a) - rank(b) || `${a.role} ${a.label}`.localeCompare(`${b.role} ${b.label}`, undefined, { numeric: true }) || a.ip.localeCompare(b.ip, undefined, { numeric: true })).map(memItem)
  const [lit, setLit] = useState<string | null>(null)
  // A cell picked in the honeycomb: show its chart (whatever the filter) and light it up.
  const pickMachine = (it: MemItem): void => {
    const want: Filter = it.m.state === 'stopped' ? 'stopped' : 'running'
    if (!shown.some((m) => m.ip === it.m.ip)) setFilter(want)
    setLit(it.m.ip)
    setTimeout(() => document.querySelector(`.hl-mem[data-ip="${CSS.escape(it.m.ip)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 30)
    setTimeout(() => setLit((x) => (x === it.m.ip ? null : x)), 1800)
  }
  return (
    <>
      <SectionHead id="hl-memory" icon={<Icon.server />} title="Memory by machine" sub={at ? `At ${when(at, hours)}: point anywhere to compare all machines at that moment` : 'Memory in use on each machine, on one 0–100% scale'}
        right={
          <div className="hl-sec-controls">
            <div className="hl-seg" role="group" aria-label="Machines shown">
              <button type="button" className={filter === 'running' ? 'on' : ''} aria-pressed={filter === 'running'} onClick={() => setFilter('running')}>Running<span>{running.length}</span></button>
              <button type="button" className={filter === 'high' ? 'on' : ''} aria-pressed={filter === 'high'} onClick={() => setFilter('high')}>Above {LIMITS.mem[0]}%<span>{high.length}</span></button>
              {stopped.length > 0 && <button type="button" className={filter === 'stopped' ? 'on' : ''} aria-pressed={filter === 'stopped'} onClick={() => setFilter('stopped')}>Stopped<span>{stopped.length}</span></button>}
            </div>
            <div className="hl-seg" role="group" aria-label="Time range">
              {GC_RANGES.map((r) => <button key={r.hours} type="button" className={r.hours === hours ? 'on' : ''} aria-pressed={r.hours === hours} onClick={() => pick(r.hours)}>{r.label}</button>)}
            </div>
          </div>
        } />
      {d && items.length > 0 && (
        <div className="hl-mem-comb">
          <Comb kind="mem" title="Memory now" sub={`Each machine's memory in use: green under ${LIMITS.mem[0]}%, yellow to ${LIMITS.mem[1]}%, red above`} items={items} words={MEM_WORDS}
            foot={() => 'to see its chart'} onPick={pickMachine}
            tip={(it) => (
              <>
                <div className="hl-hex-tip-head"><Dot level={it.level} /><strong className="min-w-0 flex-1">{it.m.role}{it.m.label ? ` ${it.m.label}` : ''}</strong><Pill level={it.level}>{it.level === 'off' ? 'Stopped' : formatPct(it.m.now)}</Pill></div>
                <div className="hl-hex-tip-sub">{it.m.name}<span className="hl-hex-tip-url">{it.m.ip}</span></div>
                {it.level !== 'off' && (
                  <div className="hl-hex-tip-stats">
                    <div className="hl-hex-tip-stat"><span>In use</span><strong>{it.m.totalBytes && it.m.now !== null ? formatBytes((it.m.now / 100) * it.m.totalBytes) : formatPct(it.m.now)}</strong></div>
                    <div className="hl-hex-tip-stat"><span>Peak</span><strong>{formatPct(it.m.peak)}</strong></div>
                    <div className="hl-hex-tip-stat"><span>Average</span><strong>{formatPct(it.m.avg)}</strong></div>
                  </div>
                )}
                {it.level !== 'off' && <Spark values={it.m.pct} min={0} max={100} height={34} level={it.level === 'unknown' ? 'ok' : it.level} />}
                {it.m.totalBytes ? <p className="hl-hex-tip-note">Of {formatBytes(it.m.totalBytes, 0)}, over the last {hours < 24 ? `${hours} h` : `${hours / 24} d`}.</p> : null}
              </>
            )} />
        </div>
      )}
      {!d && !error && <div className="hl-mem-grid">{Array.from({ length: 6 }, (_, i) => <div key={i} className="hl-card hl-skel" style={{ height: 150 }} />)}</div>}
      {!d && error && <Empty>{error}</Empty>}
      {d && (
        <div className="hl-mem-grid" onPointerLeave={() => setHover(null)}>
          {shown.map((m) => <MemTile key={m.ip} m={m} d={d} hover={hover?.i ?? null} pointing={hover?.ip === m.ip} lit={lit === m.ip} onHover={(i) => setHover(i, m.ip)} />)}
          {!shown.length && <Empty>{filter === 'high' ? `No machine is above ${LIMITS.mem[0]}%.` : 'No machines here.'}</Empty>}
        </div>
      )}
    </>
  )
}

function MemTile({ m, d, hover, pointing, lit, onHover }: { m: MachineMemory; d: MemoryHistory; hover: number | null; pointing: boolean; lit: boolean; onHover: (i: number | null) => void }): ReactElement {
  const n = m.pct.length
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
    m.pct.forEach((v, i) => (v === null ? flush() : run.push([i, Math.max(0, Math.min(100, v))])))
    flush()
    return { line, area }
  }, [m.pct])
  const move = (e: PointerEvent<HTMLDivElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    const i = Math.round(((e.clientX - r.left) / r.width) * (n - 1))
    onHover(i >= 0 && i < n ? i : null)
  }
  const hv = hover === null ? null : m.pct[hover] ?? null
  const value = hover !== null ? hv : m.now
  const off = m.state === 'stopped'
  const level = off ? 'off' : m.level
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
              <span>{m.totalBytes ? `of ${formatBytes(m.totalBytes, 0)}` : ''}</span>
            </>
          )}
        </div>
      </div>
      <div className="hl-mem-chart" onPointerMove={move}>
        <svg viewBox={`0 0 ${Math.max(1, n - 1)} 100`} preserveAspectRatio="none" aria-label={`${m.role} ${m.label} memory: now ${formatPct(m.now)}, peak ${formatPct(m.peak)}`}>
          <line x1="0" x2={n - 1} y1={100 - LIMITS.mem[0]} y2={100 - LIMITS.mem[0]} className="hl-mem-limit warn" vectorEffect="non-scaling-stroke" />
          <line x1="0" x2={n - 1} y1={100 - LIMITS.mem[1]} y2={100 - LIMITS.mem[1]} className="hl-mem-limit crit" vectorEffect="non-scaling-stroke" />
          {paths.area.map((p, i) => <path key={`a${i}`} d={p} className="hl-mem-area" />)}
          {paths.line.map((p, i) => <path key={`l${i}`} d={p} className="hl-mem-line" vectorEffect="non-scaling-stroke" />)}
          {hover !== null && <line x1={hover} x2={hover} y1="0" y2="100" className="hl-mem-cross" vectorEffect="non-scaling-stroke" />}
        </svg>
        {pointing && hover !== null && hv !== null && (
          <div className="hl-mem-tip" style={{ left: `${Math.min(70, Math.max(0, (hover / Math.max(1, n - 1)) * 100 - 15))}%` }}>
            <strong>{formatPct(hv)}</strong>
            <span>{m.totalBytes ? `${formatBytes((hv / 100) * m.totalBytes)} used` : ''}</span>
            <span className="muted">{when(d.start + hover * d.step * 1000, d.hours)}</span>
          </div>
        )}
      </div>
      <div className="hl-mem-foot">
        <span>Peak <strong>{formatPct(m.peak)}</strong></span>
        <span>Average <strong>{formatPct(m.avg)}</strong></span>
        {m.state === 'stopped' && <span className="muted">Stopped in EC2</span>}
      </div>
    </article>
  )
}

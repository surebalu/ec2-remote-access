import { useEffect, useMemo, useState, type PointerEvent, type ReactElement } from 'react'
import { GC_RANGES, LIMITS, formatBytes, formatPct, type MachineMemory, type MemoryHistory, type PlmEnvId } from '@shared/plmHealth'
import { Icon } from '../icons'
import { mayPoll } from './poll'
import { Dot, Empty, Pill, SectionHead, lvl } from './parts'

/**
 * Every machine's memory over a window, one small chart per machine on the same 0–100% scale (small multiples: with
 * twenty-odd machines, one line each in a single chart is unreadable). Pointing at any chart moves one crosshair through
 * all of them, so the machines can be compared at the same moment.
 */

const KEY = 'ui.health.memHours'
const seen = new Map<string, MemoryHistory>()
const readHours = (): number => { try { const n = Number(localStorage.getItem(KEY)); return GC_RANGES.some((r) => r.hours === n) ? n : 24 } catch { return 24 } }
type Filter = 'running' | 'high' | 'stopped'

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
      {!d && !error && <div className="hl-mem-grid">{Array.from({ length: 6 }, (_, i) => <div key={i} className="hl-card hl-skel" style={{ height: 150 }} />)}</div>}
      {!d && error && <Empty>{error}</Empty>}
      {d && (
        <div className="hl-mem-grid" onPointerLeave={() => setHover(null)}>
          {shown.map((m) => <MemTile key={m.ip} m={m} d={d} hover={hover?.i ?? null} pointing={hover?.ip === m.ip} onHover={(i) => setHover(i, m.ip)} />)}
          {!shown.length && <Empty>{filter === 'high' ? `No machine is above ${LIMITS.mem[0]}%.` : 'No machines here.'}</Empty>}
        </div>
      )}
    </>
  )
}

function MemTile({ m, d, hover, pointing, onHover }: { m: MachineMemory; d: MemoryHistory; hover: number | null; pointing: boolean; onHover: (i: number | null) => void }): ReactElement {
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
    <article className={`hl-card hl-mem ${lvl(level)} ${off ? 'off' : ''}`}>
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

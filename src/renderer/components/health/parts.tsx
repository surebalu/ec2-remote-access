import { useId, type ReactElement, type ReactNode } from 'react'
import type { Level, Spark as SparkData } from '@shared/plmHealth'
import { Icon } from '../icons'

/** The class that colours a part by its level (--lvl and --lvl-soft in styles.css). */
export const lvl = (l: Level): string => `lvl-${l}`

/** A letter pair and a hue for each part of the platform, so cards and hexagons can be told apart at a glance. */
export const MARKS: Record<string, [string, number]> = {
  passport: ['Pa', 262], dashboard: ['Da', 214], space: ['Sp', 196], search: ['Se', 26], fcs: ['Fc', 150], index: ['Ft', 44], comment: ['Co', 328],
  swym: ['Sw', 182], notification: ['No', 4], docs: ['Do', 222], tif: ['Ti', 18], converter: ['Dc', 240], cad: ['Ca', 286], apache: ['Ap', 352],
  allinone: ['Ai', 170], migration: ['Mi', 300]
}

const WORDS: Record<Level, string> = { ok: 'Healthy', warn: 'Warning', crit: 'Down', off: 'Stopped', unknown: 'No data' }

export function Pill({ level, children }: { level: Level; children?: ReactNode }): ReactElement {
  return <span className={`hl-pill ${lvl(level)}`}><i />{children ?? WORDS[level]}</span>
}

export function Dot({ level, title }: { level: Level; title?: string }): ReactElement {
  return <i className={`hl-dot ${lvl(level)}`} title={title} />
}

/**
 * A line of the last hour with a soft fill under it, scaled to its own range unless `min`/`max` pin it (percentages
 * read better against 0–100). Missing points break the line rather than drop to zero.
 */
export function Spark({ values, level = 'ok', min, max, height = 30, className = '' }: { values?: SparkData; level?: Level; min?: number; max?: number; height?: number; className?: string }): ReactElement {
  const id = useId().replace(/:/g, '')
  const pts = values ?? []
  const nums = pts.filter((v): v is number => v !== null && Number.isFinite(v))
  const W = 120
  const H = height
  if (nums.length < 2) return <svg className={`hl-spark empty ${lvl(level)} ${className}`} style={{ height }} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true"><line x1="0" x2={W} y1={H - 2} y2={H - 2} /></svg>
  const lo = min ?? Math.min(...nums)
  const hi = Math.max(max ?? -Infinity, ...nums, lo + 1e-9)
  const span = hi - lo || 1
  const x = (i: number): number => (i / Math.max(1, pts.length - 1)) * W
  const y = (v: number): number => H - 2 - ((v - lo) / span) * (H - 5)
  const runs: string[] = []
  const areas: string[] = []
  let run: [number, number][] = []
  const flush = (): void => {
    if (run.length > 1) {
      runs.push(run.map(([a, b], i) => `${i ? 'L' : 'M'}${a.toFixed(1)},${b.toFixed(1)}`).join(''))
      areas.push(`M${run[0][0].toFixed(1)},${H}` + run.map(([a, b]) => `L${a.toFixed(1)},${b.toFixed(1)}`).join('') + `L${run[run.length - 1][0].toFixed(1)},${H}Z`)
    }
    run = []
  }
  pts.forEach((v, i) => (v === null || !Number.isFinite(v) ? flush() : run.push([x(i), y(v)])))
  flush()
  const lastI = pts.length - 1 - [...pts].reverse().findIndex((v) => v !== null)
  const lastV = pts[lastI]
  return (
    <svg className={`hl-spark ${lvl(level)} ${className}`} style={{ height }} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity=".28" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      {areas.map((d, i) => <path key={`a${i}`} d={d} fill={`url(#g${id})`} stroke="none" />)}
      {runs.map((d, i) => <path key={i} d={d} className="hl-spark-line" vectorEffect="non-scaling-stroke" />)}
      {lastV !== null && lastV !== undefined && <circle cx={x(lastI)} cy={y(lastV)} r="2.2" className="hl-spark-end" vectorEffect="non-scaling-stroke" />}
    </svg>
  )
}

/** A three-quarter ring that fills to `pct`, with the reading in the middle. */
export function Gauge({ pct, level, size = 104, children }: { pct: number | null; level: Level; size?: number; children?: ReactNode }): ReactElement {
  const r = 40
  const c = 2 * Math.PI * r
  const arc = c * 0.75
  const v = Math.max(0, Math.min(100, pct ?? 0))
  return (
    <div className={`hl-gauge ${lvl(level)}`} style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r={r} className="hl-gauge-track" strokeDasharray={`${arc} ${c}`} />
        <circle cx="50" cy="50" r={r} className="hl-gauge-value" strokeDasharray={`${(arc * v) / 100} ${c}`} />
      </svg>
      <div className="hl-gauge-label">{children}</div>
    </div>
  )
}

/** How full something is, coloured by its level, with the thresholds marked. */
export function Bar({ pct, level, marks }: { pct: number | null; level: Level; marks?: readonly number[] }): ReactElement {
  const v = Math.max(0, Math.min(100, pct ?? 0))
  return (
    <span className={`hl-bar ${lvl(level)}`}>
      <span className="hl-bar-fill" style={{ width: `${v}%` }} />
      {marks?.map((m) => <span key={m} className="hl-bar-mark" style={{ left: `${m}%` }} />)}
    </span>
  )
}

/** The big status mark at the top: a tick, an exclamation or a cross in a ring that breathes while something is down. */
export function StatusRing({ level }: { level: Level }): ReactElement {
  return (
    <div className={`hl-ring ${lvl(level)}`} aria-hidden="true">
      <span className="hl-ring-halo" />
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        {level === 'ok' ? <path d="M6 12.5l4 4 8-9" /> : level === 'crit' ? <path d="M7.5 7.5l9 9M16.5 7.5l-9 9" /> : level === 'warn' ? <path d="M12 6.5v7M12 17.5h.01" /> : <path d="M7 12h10" />}
      </svg>
    </div>
  )
}

export function SectionHead({ id, icon, title, sub, right }: { id: string; icon: ReactNode; title: string; sub?: ReactNode; right?: ReactNode }): ReactElement {
  return (
    <header className="hl-sec-head" id={id}>
      <span className="hl-sec-icon">{icon}</span>
      <h3>{title}</h3>
      {sub && <span className="hl-sec-sub">{sub}</span>}
      <span className="flex-1" />
      {right}
    </header>
  )
}

export function Empty({ children }: { children: ReactNode }): ReactElement {
  return <div className="hl-empty"><Icon.info />{children}</div>
}

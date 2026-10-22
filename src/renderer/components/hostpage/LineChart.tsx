import { useEffect, useRef, useState, type PointerEvent, type ReactElement } from 'react'

/**
 * A time chart for the host page: one or two series on one scale (CPU %, bytes a second in and out), a soft fill under a
 * single series, three recessive grid lines and a crosshair. The crosshair is shared: every chart on the page shows the
 * same moment (`hover` is an index into the series, set by whichever chart the pointer is over).
 */

export interface ChartSeries { label: string; values: (number | null)[]; slot: 1 | 2 }

const H = 132
const PAD = { l: 48, r: 10, t: 8, b: 20 }

/** A round top for the axis: 1, 2 or 5 times a power of ten (or of 1024 for bytes). */
function niceTop(v: number, base: number): number {
  if (!(v > 0)) return 1
  const p = base === 1024 ? 1024 ** Math.floor(Math.log(v) / Math.log(1024)) : 10 ** Math.floor(Math.log10(v))
  for (const m of base === 1024 ? [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024] : [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p
  return 10 * p
}

const when = (t: number, hours: number): string => hours <= 24
  ? new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  : new Date(t).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })

export default function LineChart({ title, series, start, step, hours, max, bytes, format, hover, onHover, note }: {
  title: string
  series: ChartSeries[]
  /** ms of the first point, s between points */
  start: number
  step: number
  hours: number
  /** Pins the top of the scale (100 for a percentage). */
  max?: number
  /** Rounds the scale in powers of 1024. */
  bytes?: boolean
  format: (v: number | null) => string
  hover: number | null
  onHover: (i: number | null) => void
  note?: string
}): ReactElement {
  const box = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const n = Math.max(0, ...series.map((s) => s.values.length))
  const nums = series.flatMap((s) => s.values.filter((v): v is number => v !== null && Number.isFinite(v)))
  const top = max ?? niceTop(Math.max(0, ...nums) * 1.08, bytes ? 1024 : 10)
  const iw = Math.max(1, w - PAD.l - PAD.r)
  const ih = H - PAD.t - PAD.b
  const x = (i: number): number => PAD.l + (n > 1 ? (i / (n - 1)) * iw : 0)
  const y = (v: number): number => PAD.t + ih - (Math.min(v, top) / top) * ih
  const paths = series.map((s) => {
    const runs: string[] = []
    const areas: string[] = []
    const lone: [number, number][] = []
    let run: [number, number][] = []
    const flush = (): void => {
      if (run.length > 1) {
        runs.push(run.map(([a, b], i) => `${i ? 'L' : 'M'}${a.toFixed(1)},${b.toFixed(1)}`).join(''))
        areas.push(`M${run[0][0].toFixed(1)},${PAD.t + ih}${run.map(([a, b]) => `L${a.toFixed(1)},${b.toFixed(1)}`).join('')}L${run[run.length - 1][0].toFixed(1)},${PAD.t + ih}Z`)
      } else if (run.length === 1) lone.push(run[0])
      run = []
    }
    s.values.forEach((v, i) => (v === null || !Number.isFinite(v) ? flush() : run.push([x(i), y(v)])))
    flush()
    return { s, runs, areas, lone }
  })
  const move = (e: PointerEvent<SVGSVGElement>): void => {
    if (n < 2) return
    const r = e.currentTarget.getBoundingClientRect()
    const i = Math.round(((e.clientX - r.left - PAD.l) / iw) * (n - 1))
    onHover(i < 0 || i > n - 1 ? null : i)
  }
  const ticks = [0, top / 2, top]
  const xs = n > 1 ? [0, Math.round((n - 1) / 2), n - 1] : []
  const tAt = (i: number): number => start + i * step * 1000
  const tipLeft = hover !== null ? Math.min(Math.max(x(hover) + 10, PAD.l), Math.max(PAD.l, w - 168)) : 0

  return (
    <section className="hp-chart" aria-label={title}>
      <div className="hp-chart-head">
        <h4>{title}</h4>
        {series.length > 1 && (
          <div className="hp-legend">{series.map((s) => <span key={s.label}><i className={`hp-sw s${s.slot}`} />{s.label}</span>)}</div>
        )}
        <span className="hp-chart-now">{series.length === 1 ? format([...series[0].values].reverse().find((v) => v !== null) ?? null) : ''}</span>
      </div>
      <div className="hp-chart-box" ref={box}>
        {w > 0 && (
          <svg width={w} height={H} onPointerMove={move} onPointerLeave={() => onHover(null)} role="img"
            aria-label={`${title} over the last ${hours <= 24 ? `${hours} hours` : `${Math.round(hours / 24)} days`}`}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.l} x2={w - PAD.r} y1={y(t)} y2={y(t)} className="hp-grid" />
                <text x={PAD.l - 6} y={y(t) + 3.5} className="hp-tick" textAnchor="end">{format(t)}</text>
              </g>
            ))}
            {xs.map((i, k) => <text key={i} x={x(i)} y={H - 5} className="hp-tick" textAnchor={k === 0 ? 'start' : k === xs.length - 1 ? 'end' : 'middle'}>{when(tAt(i), hours)}</text>)}
            {paths.map(({ s, areas }) => series.length === 1 && areas.map((d, i) => <path key={`a${s.label}${i}`} d={d} className={`hp-area s${s.slot}`} />))}
            {paths.map(({ s, runs }) => runs.map((d, i) => <path key={`l${s.label}${i}`} d={d} className={`hp-line s${s.slot}`} />))}
            {/* A reading with no neighbour (the first of a process page) is a dot, not an invisible line. */}
            {paths.map(({ s, lone }) => lone.map(([cx, cy], i) => <circle key={`p${s.label}${i}`} cx={cx} cy={cy} r="3" className={`hp-lone s${s.slot}`} />))}
            {hover !== null && (
              <g>
                <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={PAD.t + ih} className="hp-cross" />
                {series.map((s) => (s.values[hover] !== null && s.values[hover] !== undefined
                  ? <circle key={s.label} cx={x(hover)} cy={y(s.values[hover]!)} r="4" className={`hp-dot s${s.slot}`} />
                  : null))}
              </g>
            )}
          </svg>
        )}
        {hover !== null && w > 0 && (
          <div className="hp-tip" style={{ left: tipLeft }}>
            <div className="hp-tip-when">{new Date(tAt(hover)).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</div>
            {series.map((s) => <div key={s.label}><i className={`hp-sw s${s.slot}`} />{series.length > 1 ? `${s.label} ` : ''}<b>{format(s.values[hover] ?? null)}</b></div>)}
          </div>
        )}
        {!nums.length && <div className="hp-chart-empty">{note ?? 'No data for this window.'}</div>}
      </div>
    </section>
  )
}

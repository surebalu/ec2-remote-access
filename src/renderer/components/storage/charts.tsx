import { useId, type CSSProperties, type ReactElement, type ReactNode } from 'react'

/** Charts the Storage rooms draw: the Overview's rings and donut, and the Monitor's area charts. Colours come in. */

/** A glowing ring with something in its middle (the Overview's "503 GB" and "Optimize"). */
export function Ring({ colors, size = 210, children, onClick, title }: { colors: string[]; size?: number; children: ReactNode; onClick?: () => void; title?: string }): ReactElement {
  const style = { '--ring': `conic-gradient(from 210deg, ${[...colors, colors[0]].join(', ')})`, '--glow': colors[0], width: size, height: size } as CSSProperties
  return (
    <button type="button" className="st-ring" style={style} onClick={onClick} title={title} disabled={!onClick}>
      <span className="st-ring-track" aria-hidden="true" />
      <span className="st-ring-inner">{children}</span>
    </button>
  )
}

/** A donut of parts that add up to a whole, with the total in the middle. */
export function Donut({ parts, size = 130, children }: { parts: { value: number; color: string }[]; size?: number; children?: ReactNode }): ReactElement {
  const r = 40
  const c = 2 * Math.PI * r
  const total = parts.reduce((s, p) => s + p.value, 0) || 1
  let at = 0
  return (
    <div className="st-donut" style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r={r} className="st-donut-track" />
        {parts.map((p, i) => {
          const len = (p.value / total) * c
          const el = <circle key={i} cx="50" cy="50" r={r} stroke={p.color} strokeDasharray={`${Math.max(0, len - 1.2)} ${c}`} strokeDashoffset={-at} className="st-donut-seg" />
          at += len
          return el
        })}
      </svg>
      <div className="st-donut-mid">{children}</div>
    </div>
  )
}

/**
 * Areas over time, stacked or each from zero, with the time along the bottom and values up the side. `values` are in
 * the same order as `times`; `format` writes an axis value.
 */
export function AreaChart({ series, times, stacked, max, format, height = 110, label }: {
  series: { label: string; color: string; values: number[] }[]
  times: number[]
  stacked?: boolean
  max?: number
  format: (v: number) => string
  height?: number
  /** How a time along the bottom reads (the time of day unless given). */
  label?: (t: number) => string
}): ReactElement {
  const id = useId().replace(/:/g, '')
  const W = 600
  const H = 100
  const n = times.length
  const tops: number[][] = []
  for (let s = 0; s < series.length; s++) tops.push(series[s].values.map((v, i) => (stacked && s > 0 ? tops[s - 1][i] : 0) + (Number.isFinite(v) ? v : 0)))
  const peak = max ?? Math.max(1, ...tops.flat()) * 1.1
  const x = (i: number): number => (n < 2 ? W : (i / (n - 1)) * W)
  const y = (v: number): number => H - Math.min(1, v / peak) * H
  const ticks = n > 1 ? [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * (n - 1))) : []
  // "3:06", as Activity Monitor writes it: the hour and minute, without AM or PM.
  const clock = label ?? ((t: number): string => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, ''))
  return (
    <div className="st-area" style={{ height }}>
      <div className="st-area-y" aria-hidden="true"><span>{format(peak)}</span><span>{format(peak / 2)}</span><span>{format(0)}</span></div>
      <div className="st-area-plot">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          <defs>
            {series.map((s, i) => (
              <linearGradient key={i} id={`${id}-${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={s.color} stopOpacity={stacked ? 0.85 : 0.5} />
                <stop offset="1" stopColor={s.color} stopOpacity={stacked ? 0.65 : 0.05} />
              </linearGradient>
            ))}
          </defs>
          {[0.5, 1].map((f) => <line key={f} x1="0" x2={W} y1={H - f * (H / 1.1)} y2={H - f * (H / 1.1)} className="st-area-grid" />)}
          {n > 1 && series.map((s, si) => {
            const top = tops[si].map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`)
            const base = stacked && si > 0 ? tops[si - 1].map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).reverse() : [`${W},${H}`, `0,${H}`]
            return (
              <g key={si}>
                <polygon points={[...top, ...base].join(' ')} fill={`url(#${id}-${si})`} />
                <polyline points={top.join(' ')} fill="none" stroke={s.color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
              </g>
            )
          })}
        </svg>
        <div className="st-area-x" aria-hidden="true">{ticks.map((i) => <span key={i}>{clock(times[i])}</span>)}</div>
      </div>
    </div>
  )
}

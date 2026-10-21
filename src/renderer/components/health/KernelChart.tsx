import { useEffect, useId, useMemo, useRef, useState, type PointerEvent, type ReactElement } from 'react'
import { formatBytes, type Spark } from '@shared/plmHealth'

/**
 * The ENOVIA kernel's memory over a window: what it has in use (the line to watch, with a soft fill), what it holds
 * from the system and its peak since start, on one byte scale from zero. Restarts are marked, and so is the moment
 * recording began when that falls inside the window (the history is only as old as the exporter). Pointing at it shows
 * every value for that moment. Drawn at the box's real width so the text stays crisp.
 */

export interface KernelLine { key: 'allocated' | 'reserved' | 'highwater'; label: string; values: Spark }

const PAD = { l: 52, r: 12, t: 12, b: 24 }
const MB = 1024 ** 2

function ticksFor(max: number): number[] {
  const steps = [16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192].map((m) => m * MB)
  const step = steps.find((s) => max / s <= 5) ?? steps[steps.length - 1]
  const out: number[] = []
  for (let v = 0; v <= max + 1; v += step) out.push(v)
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step)
  return out
}

const fmtTime = (t: number, hours: number): string =>
  hours <= 24
    ? new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : hours <= 72
      ? new Date(t).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
      : new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

export default function KernelChart({ start, step, hours, lines, restarts, extra, height = 190 }: {
  start: number
  step: number
  hours: number
  lines: KernelLine[]
  restarts: number[]
  /** More readings for the tip at a point (contexts, users). */
  extra?: (i: number) => { label: string; value: string }[]
  height?: number
}): ReactElement {
  const box = useRef<HTMLDivElement>(null)
  const gid = `km${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const n = lines[0]?.values.length ?? 0
  const plotW = Math.max(1, width - PAD.l - PAD.r)
  const plotH = Math.max(1, height - PAD.t - PAD.b)
  const tOf = (i: number): number => start + i * step * 1000
  const all = lines.flatMap((l) => l.values.filter((v): v is number => v !== null))
  const ticks = ticksFor(Math.max(64 * MB, ...all) * 1.06)
  const top = ticks[ticks.length - 1] || 1
  const x = (i: number): number => PAD.l + (n > 1 ? (i / (n - 1)) * plotW : 0)
  const xt = (t: number): number => x((t - start) / (step * 1000))
  const y = (v: number): number => PAD.t + plotH - (v / top) * plotH

  const paths = useMemo(() => {
    if (!width) return null
    const out: Record<string, { line: string[]; area: string[] }> = {}
    for (const l of lines) {
      const line: string[] = []
      const area: string[] = []
      let run: number[] = []
      const flush = (): void => {
        if (run.length > 1) {
          line.push(run.map((i, k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(l.values[i]!).toFixed(1)}`).join(''))
          area.push(`M${x(run[0]).toFixed(1)},${y(0)}` + run.map((i) => `L${x(i).toFixed(1)},${y(l.values[i]!).toFixed(1)}`).join('') + `L${x(run[run.length - 1]).toFixed(1)},${y(0)}Z`)
        } else if (run.length === 1) {
          // A lone reading (the first minutes of a long view): a short tick, so it still shows.
          const cx = x(run[0])
          line.push(`M${(cx - 2).toFixed(1)},${y(l.values[run[0]]!).toFixed(1)}L${(cx + 2).toFixed(1)},${y(l.values[run[0]]!).toFixed(1)}`)
        }
        run = []
      }
      l.values.forEach((v, i) => (v === null ? flush() : run.push(i)))
      flush()
      out[l.key] = { line, area }
    }
    return out
  }, [lines, width, height]) // eslint-disable-line react-hooks/exhaustive-deps

  const firstIdx = Math.min(...lines.map((l) => l.values.findIndex((v) => v !== null)).filter((i) => i >= 0))
  const recordingFrom = Number.isFinite(firstIdx) && firstIdx > 2 ? x(firstIdx) : null
  const xTicks = Array.from({ length: 5 }, (_, k) => Math.round((k / 4) * (n - 1)))

  const onMove = (e: PointerEvent<SVGSVGElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    const i = Math.round(((e.clientX - r.left - PAD.l) / plotW) * (n - 1))
    setHover(i >= 0 && i < n ? i : null)
  }
  const h = hover
  const has = h !== null && lines.some((l) => l.values[h] !== null)

  return (
    <div className="hl-heap hl-kchart" ref={box} style={{ height }}>
      {paths && (
        <svg width={width} height={height} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img"
          aria-label={`Kernel memory over the last ${hours} hours`}>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--accent)" stopOpacity=".3" />
              <stop offset="1" stopColor="var(--accent)" stopOpacity=".03" />
            </linearGradient>
          </defs>
          {ticks.map((v) => (
            <g key={v}>
              <line x1={PAD.l} x2={PAD.l + plotW} y1={y(v)} y2={y(v)} className="hl-chart-grid" />
              <text x={PAD.l - 8} y={y(v) + 3.5} className="hl-chart-axis" textAnchor="end">{v === 0 ? '0' : formatBytes(v, 0)}</text>
            </g>
          ))}
          {xTicks.map((i, k) => (
            <text key={i} x={x(i)} y={height - 7} className="hl-chart-axis" textAnchor={k === 0 ? 'start' : k === 4 ? 'end' : 'middle'}>{fmtTime(tOf(i), hours)}</text>
          ))}
          {recordingFrom !== null && (
            <g>
              <rect x={PAD.l} y={PAD.t} width={Math.max(0, recordingFrom - PAD.l)} height={plotH} className="hl-kchart-before" />
              <text x={recordingFrom - 6} y={PAD.t + 12} className="hl-chart-axis" textAnchor="end">recording starts</text>
            </g>
          )}
          {restarts.map((t) => (
            <g key={t}>
              <line x1={xt(t)} x2={xt(t)} y1={PAD.t} y2={PAD.t + plotH} className="hl-chart-restart" />
              <text x={xt(t) + 4} y={PAD.t + 10} className="hl-chart-axis">restart</text>
            </g>
          ))}
          {paths.allocated?.area.map((p, i) => <path key={`a${i}`} d={p} fill={`url(#${gid})`} />)}
          {lines.map((l) => paths[l.key]?.line.map((p, i) => <path key={`${l.key}${i}`} d={p} className={`hl-kline ${l.key}`} />))}
          {has && (
            <g className="hl-chart-hover">
              <line x1={x(h!)} x2={x(h!)} y1={PAD.t} y2={PAD.t + plotH} />
              {lines.map((l) => (l.values[h!] !== null ? <circle key={l.key} cx={x(h!)} cy={y(l.values[h!]!)} r="3.2" className={`hl-kdot ${l.key}`} /> : null))}
            </g>
          )}
        </svg>
      )}
      {has && (
        <div className="hl-chart-tip" style={{ left: Math.min(Math.max(x(h!) + 12, 8), width - 190), top: PAD.t + 4 }}>
          <strong>{new Date(tOf(h!)).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</strong>
          {lines.map((l) => <span key={l.key}><i className={`sw k-${l.key}`} />{l.label} {formatBytes(l.values[h!])}</span>)}
          {extra?.(h!).map((e) => <span key={e.label} className="muted">{e.label} {e.value}</span>)}
        </div>
      )}
    </div>
  )
}

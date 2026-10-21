import { useEffect, useId, useMemo, useRef, useState, type PointerEvent, type ReactElement } from 'react'
import { formatBytes, type JvmGcDetail } from '@shared/plmHealth'
import { lvl } from './parts'

/**
 * A JVM's heap over a window, drawn the way GCeasy's "heap usage" graph reads: the band from the lowest to the highest
 * heap in each step (the saw-tooth), a line for what the collections left (the floor that climbs when memory leaks),
 * the maximum, a red triangle at every full collection and a marker where the JVM restarted. Pointing at it shows the
 * numbers for that moment. Drawn at the box's real width so the text stays crisp.
 */

const PAD = { l: 46, r: 14, t: 16, b: 26 }
const GB = 1024 ** 3

function ticksFor(max: number): number[] {
  const steps = [0.25, 0.5, 1, 2, 4, 8, 16].map((g) => g * GB)
  const step = steps.find((s) => max / s <= 5) ?? steps[steps.length - 1]
  const out: number[] = []
  for (let v = 0; v <= max + 1; v += step) out.push(v)
  return out
}

const fmtTime = (t: number, hours: number): string =>
  hours <= 24
    ? new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : hours <= 72
      ? new Date(t).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
      : new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

export default function HeapChart({ d, height = 260 }: { d: JvmGcDetail; height?: number }): ReactElement {
  const box = useRef<HTMLDivElement>(null)
  const gid = `hb${useId().replace(/[^a-zA-Z0-9]/g, '')}`
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

  const n = d.heapHigh.length
  const plotW = Math.max(1, width - PAD.l - PAD.r)
  const plotH = Math.max(1, height - PAD.t - PAD.b)
  const tOf = (i: number): number => d.start + i * d.step * 1000
  const peak = Math.max(d.heapMax ?? 0, ...d.heapHigh.filter((v): v is number => v !== null))
  const ticks = ticksFor(peak * 1.04)
  const top = ticks[ticks.length - 1] || 1
  const x = (i: number): number => PAD.l + (n > 1 ? (i / (n - 1)) * plotW : 0)
  const xt = (t: number): number => x((t - d.start) / (d.step * 1000))
  const y = (v: number): number => PAD.t + plotH - (v / top) * plotH

  const paths = useMemo(() => {
    if (!width) return null
    const band: string[] = []
    const high: string[] = []
    const after: string[] = []
    let seg: number[] = []
    const flushBand = (): void => {
      if (seg.length > 1) {
        const up = seg.map((i, k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.heapHigh[i]!).toFixed(1)}`).join('')
        const down = [...seg].reverse().map((i) => `L${x(i).toFixed(1)},${y(d.heapLow[i] ?? d.heapHigh[i]!).toFixed(1)}`).join('')
        band.push(`${up}${down}Z`)
        high.push(up)
      }
      seg = []
    }
    d.heapHigh.forEach((v, i) => (v === null ? flushBand() : seg.push(i)))
    flushBand()
    let run: string[] = []
    const flushAfter = (): void => { if (run.length > 1) after.push(run.join('')); run = [] }
    d.afterGc.forEach((v, i) => (v === null ? flushAfter() : run.push(`${run.length ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)))
    flushAfter()
    return { band, high, after }
  }, [d, width, height]) // eslint-disable-line react-hooks/exhaustive-deps

  const marks = d.fullGcs.map((v, i) => ((v ?? 0) >= 0.5 ? i : -1)).filter((i) => i >= 0)
  // Too many to tell apart (a busy collector over a week): ticks along the bottom instead of triangles.
  const dense = marks.length > Math.max(40, plotW / 7)
  const xTicks = Array.from({ length: 5 }, (_, k) => Math.round((k / 4) * (n - 1)))
  const restartX = d.startedAt && d.startedAt > d.start ? xt(d.startedAt) : null

  const onMove = (e: PointerEvent<SVGSVGElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    const i = Math.round(((e.clientX - r.left - PAD.l) / plotW) * (n - 1))
    setHover(i >= 0 && i < n ? i : null)
  }
  const h = hover
  const hv = h === null ? null : { t: tOf(h), high: d.heapHigh[h], low: d.heapLow[h], after: d.afterGc[h], full: d.fullGcs[h] }

  return (
    <div className={`hl-heap ${lvl(d.trend.level === 'unknown' ? 'ok' : d.trend.level)}`} ref={box} style={{ height }}>
      {paths && (
        <svg width={width} height={height} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img"
          aria-label={`Heap over the last ${d.hours} hours: ${d.trend.text}`}>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--accent)" stopOpacity=".42" />
              <stop offset="1" stopColor="var(--accent)" stopOpacity=".1" />
            </linearGradient>
          </defs>
          {ticks.map((v) => (
            <g key={v}>
              <line x1={PAD.l} x2={PAD.l + plotW} y1={y(v)} y2={y(v)} className="hl-chart-grid" />
              <text x={PAD.l - 8} y={y(v) + 3.5} className="hl-chart-axis" textAnchor="end">{v === 0 ? '0' : formatBytes(v, v % GB ? 1 : 0)}</text>
            </g>
          ))}
          {xTicks.map((i, k) => (
            <text key={i} x={x(i)} y={height - 7} className="hl-chart-axis" textAnchor={k === 0 ? 'start' : k === 4 ? 'end' : 'middle'}>{fmtTime(tOf(i), d.hours)}</text>
          ))}
          {paths.band.map((p, i) => <path key={`b${i}`} d={p} fill={`url(#${gid})`} />)}
          {paths.high.map((p, i) => <path key={`h${i}`} d={p} className="hl-chart-high" />)}
          {d.heapMax !== null && (
            <g>
              <line x1={PAD.l} x2={PAD.l + plotW} y1={y(d.heapMax)} y2={y(d.heapMax)} className="hl-chart-max" />
              <text x={PAD.l + plotW - 4} y={y(d.heapMax) - 5} className="hl-chart-max-label" textAnchor="end">max {formatBytes(d.heapMax, 0)}</text>
            </g>
          )}
          {restartX !== null && (
            <g>
              <line x1={restartX} x2={restartX} y1={PAD.t} y2={PAD.t + plotH} className="hl-chart-restart" />
              <text x={restartX + 4} y={PAD.t + 10} className="hl-chart-axis">restart</text>
            </g>
          )}
          {paths.after.map((p, i) => <path key={`a${i}`} d={p} className="hl-chart-after" />)}
          {d.trend.line && <line x1={xt(d.trend.line[0])} y1={y(d.trend.line[1])} x2={xt(d.trend.line[2])} y2={y(d.trend.line[3])} className="hl-chart-trend" />}
          {dense
            ? marks.map((i) => <line key={`m${i}`} x1={x(i)} x2={x(i)} y1={PAD.t + plotH - 6} y2={PAD.t + plotH} className="hl-gc-tick" />)
            : marks.map((i) => {
              const cx = x(i)
              const cy = y(d.heapHigh[i] ?? d.heapLow[i] ?? 0) - 4
              return <path key={`m${i}`} d={`M${cx - 4},${cy - 7}L${cx + 4},${cy - 7}L${cx},${cy}Z`} className="hl-gc-mark" />
            })}
          {hv && (
            <g className="hl-chart-hover">
              <line x1={x(h!)} x2={x(h!)} y1={PAD.t} y2={PAD.t + plotH} />
              {hv.after !== null && <circle cx={x(h!)} cy={y(hv.after)} r="3.5" className="hl-chart-dot-after" />}
              {hv.high !== null && <circle cx={x(h!)} cy={y(hv.high)} r="3" className="hl-chart-dot" />}
            </g>
          )}
        </svg>
      )}
      {hv && (
        <div className="hl-chart-tip" style={{ left: Math.min(Math.max(x(h!) + 12, 8), width - 190), top: PAD.t + 4 }}>
          <strong>{new Date(hv.t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</strong>
          <span><i className="sw high" />Heap {hv.low !== null && hv.high !== null ? `${formatBytes(hv.low)} – ${formatBytes(hv.high)}` : '–'}</span>
          <span><i className="sw after" />After GC {formatBytes(hv.after)}</span>
          {(hv.full ?? 0) >= 0.5 && <span><i className="sw gc" />{Math.round(hv.full!)} full {Math.round(hv.full!) === 1 ? 'collection' : 'collections'}</span>}
        </div>
      )}
    </div>
  )
}

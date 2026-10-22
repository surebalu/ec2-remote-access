import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react'
import type { Level } from '@shared/plmHealth'
import { lvl } from './parts'

/**
 * A honeycomb: one hexagon per item, coloured by its level (green, amber, red, grey hatched when stopped, dashed when
 * nothing is known), in the items' own order so a cell keeps its place when its colour changes. Pointing at one shows
 * `tip`; a click picks it (on a touch screen the first tap shows the tip and a second one picks). A score, a bar of the
 * mix and a legend that lights up one level sit above it. Used by the health checks and memory by machine.
 */

export interface CombItem {
  id: string
  level: Level
  /** Two letters in the middle ("Sp"). */
  mark: string
  /** Under the letters ("01", "83%"); '' for none. */
  label: string
  aria: string
  ip?: string
  url?: string
}

const LEGEND: Level[] = ['ok', 'warn', 'crit', 'off', 'unknown']
const GAP = 6
const TIP_W = 280

/** A pointy-top hexagon of circumradius r centred on 0,0, its corners rounded by `round`. */
function hexPath(r: number, round: number): string {
  const v = Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i - Math.PI / 2
    return [r * Math.cos(a), r * Math.sin(a)]
  })
  const toward = ([x, y]: number[], [tx, ty]: number[]): string => {
    const l = Math.hypot(tx - x, ty - y)
    return `${(x + ((tx - x) / l) * round).toFixed(2)},${(y + ((ty - y) / l) * round).toFixed(2)}`
  }
  return v.map((c, i) => `${i ? 'L' : 'M'}${toward(c, v[(i + 5) % 6])}Q${c[0].toFixed(2)},${c[1].toFixed(2)} ${toward(c, v[(i + 1) % 6])}`).join('') + 'Z'
}

export default function Comb<T extends CombItem>({ kind, title, sub, items, words, tip, foot, onPick }: {
  kind: string
  title: string
  sub: string
  items: T[]
  words: Record<Level, string>
  tip: (item: T) => ReactNode
  /** The tip's last line, after "Click"/"Tap again": "to see it under Servers". */
  foot: (item: T) => string
  onPick: (item: T) => void
}): ReactElement {
  const board = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const pointer = useRef('mouse')
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<string | null>(null)
  const [pinned, setPinned] = useState<string | null>(null)
  const [only, setOnly] = useState<Level | null>(null)
  const [peek, setPeek] = useState<Level | null>(null)
  const [tipH, setTipH] = useState(0)

  useEffect(() => {
    const el = board.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // One cell size for every comb (so by the window, not the comb's own width), smaller on a phone.
  const n = items.length
  const r = window.innerWidth < 640 || width < 260 ? 25 : 32
  const w = Math.sqrt(3) * r
  const pitch = w + GAP
  const rowH = 1.5 * r + GAP * 0.866
  // A compact comb rather than one long strip: about three columns to a row, as many as fit.
  const fit = Math.max(1, Math.floor((width - pitch / 2 - 4) / pitch))
  const cols = Math.min(fit, Math.ceil(n / Math.max(1, Math.round(Math.sqrt(n / 2.5)))))
  const rows = Math.ceil(n / cols)
  const combW = cols * pitch - GAP + (rows > 1 ? pitch / 2 : 0)
  const x0 = Math.max(2, (width - combW) / 2)
  // Odd rows sit half a cell to the right, which is what makes it a honeycomb.
  const at = (i: number): { x: number; y: number; row: number } => {
    const row = Math.floor(i / cols)
    return { x: x0 + (i % cols) * pitch + (row % 2 ? pitch / 2 : 0) + w / 2, y: row * rowH + r + 2, row }
  }
  const height = rows ? (rows - 1) * rowH + 2 * r + 4 : 0
  const face = useMemo(() => hexPath(r, r * 0.17), [r])
  const halo = useMemo(() => hexPath(r + 4, r * 0.2), [r])

  const shown = pinned ?? hover
  const idx = shown ? items.findIndex((c) => c.id === shown) : -1
  const current = idx >= 0 ? items[idx] : null
  useLayoutEffect(() => { if (tipRef.current) setTipH(tipRef.current.offsetHeight) }, [current, width])

  const count = (l: Level): number => items.filter((c) => c.level === l).length
  const running = n - count('off')
  const lit = peek ?? only
  const go = (c: T): void => { setPinned(null); setHover(null); onPick(c) }
  const tap = (c: T): void => {
    // A touch has no hover: the first tap shows what it is, a second one goes to it.
    if (pointer.current !== 'mouse' && pinned !== c.id) { setPinned(c.id); return }
    go(c)
  }
  const key = (e: KeyboardEvent, c: T): void => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(c) }
    if (e.key === 'Escape') { setPinned(null); setHover(null) }
  }

  let tipBox: { left: number; top: number } | null = null
  if (current) {
    const p = at(idx)
    const tw = Math.min(TIP_W, width)
    const left = Math.max(0, Math.min(width - tw, p.x - tw / 2))
    // Below the first row, above the others, so it never covers the cell it describes.
    const above = p.row > 0 && p.y - r - 10 - tipH > -40
    tipBox = { left, top: above ? p.y - r - 10 - tipH : p.y + r + 10 }
  }

  return (
    <section className={`hl-card hl-hive ${kind}`} aria-label={title}>
      <div className="hl-hive-head">
        <div className="min-w-0">
          <h4>{title}</h4>
          <span className="hl-card-sub">{sub}</span>
        </div>
        <div className="hl-hive-score">
          <strong>{count('ok')}</strong>
          <span>of {running} {words.ok.toLowerCase()}</span>
        </div>
      </div>
      <div className="hl-hive-bar" aria-hidden="true">
        {LEGEND.filter((l) => count(l)).map((l) => <i key={l} className={lvl(l)} style={{ flexGrow: count(l) }} />)}
      </div>
      <div className="hl-hive-legend" role="group" aria-label={`${title}: show one status`}>
        {LEGEND.filter((l) => count(l) || l === 'ok' || l === 'crit').map((l) => (
          <button key={l} type="button" className={`${lvl(l)} ${only === l ? 'on' : ''}`} aria-pressed={only === l}
            onPointerEnter={(e) => { if (e.pointerType === 'mouse') setPeek(l) }} onPointerLeave={() => setPeek(null)} onClick={() => setOnly(only === l ? null : l)}>
            <i className={`hl-hive-swatch ${lvl(l)}`} />
            <span>{words[l]}</span>
            <b>{count(l)}</b>
          </button>
        ))}
      </div>
      <div className="hl-hive-board" ref={board} onPointerDown={(e) => { pointer.current = e.pointerType; if (!(e.target as Element).closest('.hl-hex')) setPinned(null) }}>
        {width > 0 && (
          <svg width={width} height={height} role="list" aria-label={`${n} ${title}`}>
            <defs>
              <linearGradient id={`hl-hex-shine-${kind}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#fff" stopOpacity=".26" />
                <stop offset=".55" stopColor="#fff" stopOpacity="0" />
              </linearGradient>
              <pattern id={`hl-hex-hatch-${kind}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="6" className="hl-hex-hatch" />
              </pattern>
            </defs>
            {items.map((c, i) => {
              const p = at(i)
              return (
                <g key={c.id} role="listitem" transform={`translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`}>
                  <g className={`hl-hex ${lvl(c.level)} ${shown === c.id ? 'on' : ''} ${lit && c.level !== lit ? 'dim' : ''}`} tabIndex={0} role="button"
                    data-id={c.id} data-url={c.url} data-ip={c.ip} aria-label={c.aria}
                    onPointerEnter={(e) => { if (e.pointerType === 'mouse') setHover(c.id) }} onPointerLeave={(e) => { if (e.pointerType === 'mouse') setHover((h) => (h === c.id ? null : h)) }}
                    onFocus={() => setHover(c.id)} onBlur={() => setHover((h) => (h === c.id ? null : h))} onClick={() => tap(c)} onKeyDown={(e) => key(e, c)}>
                    {c.level === 'crit' && <path d={halo} className="hl-hex-halo" />}
                    <g className="hl-hex-face">
                      <path d={face} className="hl-hex-body" />
                      {c.level === 'off' && <path d={face} fill={`url(#hl-hex-hatch-${kind})`} />}
                      {c.level !== 'off' && c.level !== 'unknown' && <path d={face} fill={`url(#hl-hex-shine-${kind})`} />}
                      <text className="hl-hex-mark" y={c.label ? -r * 0.13 : 0} style={{ fontSize: r * 0.42 }}>{c.mark}</text>
                      {c.label && <text className="hl-hex-label" y={r * 0.33} style={{ fontSize: r * (c.label.length > 4 ? 0.26 : 0.3) }}>{c.label}</text>}
                    </g>
                  </g>
                </g>
              )
            })}
          </svg>
        )}
        {current && tipBox && (
          <div className={`hl-hex-tip ${lvl(current.level)}`} ref={tipRef} role="tooltip" style={{ left: tipBox.left, top: tipBox.top, width: Math.min(TIP_W, width) }}>
            {tip(current)}
            <div className="hl-hex-tip-foot">{pinned ? 'Tap again' : 'Click'} {foot(current)}</div>
          </div>
        )}
      </div>
    </section>
  )
}

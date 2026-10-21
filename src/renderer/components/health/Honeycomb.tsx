import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { LIMITS, checkCells, formatMs, formatPct, levelOf, type CheckCell, type Level, type PlmEnvHealth } from '@shared/plmHealth'
import { Icon } from '../icons'
import { Bar, Dot, MARKS, Pill, SectionHead, lvl } from './parts'

/**
 * The health checks as Grafana runs them, as two honeycombs: each service's URL through the load balancer (the
 * "<Environment> ALB Healthcheck" job) and on each server (the "Service HTTP Healthcheck" jobs and Apache's), one
 * hexagon per check: green healthy, amber slow, red unhealthy, grey on a server stopped in EC2, dashed when the probe
 * itself is not running. Pointing at one says what it checks and, for a server check, which machine it is and how that
 * machine is doing; a click goes to the machine's row under Servers (or the service). On a touch screen the first tap
 * shows the details and a second one goes. Cells keep the services' order, never status, so a check keeps its place
 * when it changes colour.
 */

const WORDS: Record<Level, string> = { ok: 'Healthy', warn: 'Slow', crit: 'Unhealthy', off: 'Stopped', unknown: 'Not running' }
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

/** What fits under the letters: "01", "Pri", "01 int", "AiO"; nothing for a service's only server. */
function shortLabel(label: string): string {
  const one = (l: string): string => (l === 'Primary' ? 'Pri' : l === 'Secondary' ? 'Sec' : l === 'All-in-one server' ? 'AiO' : l === 'server' ? '' : /^0\d$/.test(l) ? l : l.replace(/^3D/, '').slice(0, 4))
  const internal = /^(.*?)\s*internal$/i.exec(label)
  return internal ? `${one(internal[1])} int`.trim() : one(label)
}
const markOf = (c: CheckCell): string => {
  const known = MARKS[c.serviceId]?.[0]
  if (known) return known
  const letters = c.service.replace(/^3D/, '').replace(/[^A-Za-z]/g, '')
  return letters.slice(0, 1).toUpperCase() + letters.slice(1, 2).toLowerCase()
}
const shortUrl = (url: string): string => url.replace(/^https?:\/\//, '').replace(/\.us-west-\d\.compute\.internal/, '')
const statusWord = (c: CheckCell): string =>
  c.level === 'off' ? 'Server stopped' : c.level === 'unknown' ? (c.broken ?? 'Probe not running') : c.status ? `HTTP ${c.status}` : 'No answer'

export default function Honeycombs({ env, onPick }: { env: PlmEnvHealth; onPick: (c: CheckCell) => void }): ReactElement | null {
  const alb = useMemo(() => checkCells(env, 'lb'), [env])
  const http = useMemo(() => checkCells(env, 'server'), [env])
  if (!alb.length && !http.length) return null
  return (
    <>
      <SectionHead id="hl-checks" icon={<Icon.hexes />} title="Health checks" sub="As Grafana runs them: each URL through the load balancer, and on each server" />
      <div className="hl-combs">
        {alb.length > 0 && <Comb kind="alb" title="ALB checks" sub="Through the load balancer, as users reach them" cells={alb} onPick={onPick} />}
        {http.length > 0 && <Comb kind="http" title="HTTP checks" sub="On each server" cells={http} onPick={onPick} />}
      </div>
    </>
  )
}

function Comb({ kind, title, sub, cells, onPick }: { kind: 'alb' | 'http'; title: string; sub: string; cells: CheckCell[]; onPick: (c: CheckCell) => void }): ReactElement {
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

  // One cell size for both combs (so by the window, not the comb's own width), smaller on a phone.
  const n = cells.length
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
  const idx = shown ? cells.findIndex((c) => c.url === shown) : -1
  const tip = idx >= 0 ? cells[idx] : null
  useLayoutEffect(() => { if (tipRef.current) setTipH(tipRef.current.offsetHeight) }, [tip, width])

  const count = (l: Level): number => cells.filter((c) => c.level === l).length
  const running = n - count('off')
  const lit = peek ?? only
  const go = (c: CheckCell): void => { setPinned(null); setHover(null); onPick(c) }
  const tap = (c: CheckCell): void => {
    // A touch has no hover: the first tap shows what the check is, a second one goes to it.
    if (pointer.current !== 'mouse' && pinned !== c.url) { setPinned(c.url); return }
    go(c)
  }
  const key = (e: KeyboardEvent, c: CheckCell): void => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(c) }
    if (e.key === 'Escape') { setPinned(null); setHover(null) }
  }

  let tipBox: { left: number; top: number } | null = null
  if (tip) {
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
          <span>of {running} healthy</span>
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
            <span>{WORDS[l]}</span>
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
            {cells.map((c, i) => {
              const p = at(i)
              const label = shortLabel(c.label)
              const where = c.via === 'lb' ? 'through the load balancer' : `on ${c.machine?.name ?? shortUrl(c.url).split(/[:/]/)[0]}`
              return (
                <g key={c.url} role="listitem" transform={`translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`}>
                  <g className={`hl-hex ${lvl(c.level)} ${shown === c.url ? 'on' : ''} ${lit && c.level !== lit ? 'dim' : ''}`} tabIndex={0} role="button"
                    data-url={c.url} data-ip={c.machine?.ip ?? undefined}
                    aria-label={`${c.service}${c.label ? ` ${c.label}` : ''} ${where}: ${WORDS[c.level]}, ${statusWord(c)}`}
                    onPointerEnter={(e) => { if (e.pointerType === 'mouse') setHover(c.url) }} onPointerLeave={(e) => { if (e.pointerType === 'mouse') setHover((h) => (h === c.url ? null : h)) }}
                    onFocus={() => setHover(c.url)} onBlur={() => setHover((h) => (h === c.url ? null : h))} onClick={() => tap(c)} onKeyDown={(e) => key(e, c)}>
                    {c.level === 'crit' && <path d={halo} className="hl-hex-halo" />}
                    <g className="hl-hex-face">
                      <path d={face} className="hl-hex-body" />
                      {c.level === 'off' && <path d={face} fill={`url(#hl-hex-hatch-${kind})`} />}
                      {c.level !== 'off' && c.level !== 'unknown' && <path d={face} fill={`url(#hl-hex-shine-${kind})`} />}
                      <text className="hl-hex-mark" y={label ? -r * 0.13 : 0} style={{ fontSize: r * 0.42 }}>{markOf(c)}</text>
                      {label && <text className="hl-hex-label" y={r * 0.33} style={{ fontSize: r * (label.length > 4 ? 0.26 : 0.3) }}>{label}</text>}
                    </g>
                  </g>
                </g>
              )
            })}
          </svg>
        )}
        {tip && tipBox && (
          <div className={`hl-hex-tip ${lvl(tip.level)}`} ref={tipRef} role="tooltip" style={{ left: tipBox.left, top: tipBox.top, width: Math.min(TIP_W, width) }}>
            <CheckTip c={tip} />
            <div className="hl-hex-tip-foot">{pinned ? 'Tap again' : 'Click'} to see {tip.machine?.listed ? 'its server under Servers' : 'its service'}</div>
          </div>
        )}
      </div>
    </section>
  )
}

function CheckTip({ c }: { c: CheckCell }): ReactElement {
  const m = c.machine
  const stat = (name: string, value: ReactNode): ReactElement => <div className="hl-hex-tip-stat"><span>{name}</span><strong>{value}</strong></div>
  // Its checks are this tip's subject, and "not reporting" has its own line.
  const problems = m?.problems.filter((p) => !/check (fails|is slow)|^Not reporting/.test(p)) ?? []
  return (
    <>
      <div className="hl-hex-tip-head">
        <Dot level={c.level} />
        <strong className="min-w-0 flex-1">{c.service}{c.label && c.label !== 'server' ? ` ${c.label}` : ''}</strong>
        <Pill level={c.level}>{WORDS[c.level]}</Pill>
      </div>
      <div className="hl-hex-tip-sub">{c.via === 'lb' ? 'Through the load balancer' : m ? m.name : 'On its server'}<span className="hl-hex-tip-url">{shortUrl(c.url)}</span></div>
      <div className="hl-hex-tip-stats">
        {stat('Status', statusWord(c))}
        {stat('Response', formatMs(c.ms))}
        {c.via === 'lb' ? stat('Certificate', c.certDays === null ? '–' : `${c.certDays} days`) : stat('Address', m?.ip ?? '–')}
      </div>
      {c.note && <p className="hl-hex-tip-note">{c.note}</p>}
      {m && c.via === 'server' && (m.state === 'stopped'
        ? <p className="hl-hex-tip-note">Its server is stopped in EC2: set aside, not counted as a problem.</p>
        : (
          <div className="hl-hex-tip-machine">
            <span className="hl-mini-label">{m.title}{m.instanceType ? ` · ${m.instanceType}` : ''}</span>
            {m.reporting ? (
              <div className="hl-hex-tip-stats">
                {([['CPU', m.cpu, LIMITS.cpu], ['Memory', m.mem, LIMITS.mem], [m.disk ? `Disk ${m.disk.mount}` : 'Disk', m.disk?.pct ?? null, m.os === 'windows' ? LIMITS.diskWindows : LIMITS.disk]] as const).map(([name, v, limits]) => (
                  <div key={name} className="hl-hex-tip-stat">
                    <span className="truncate">{name}</span>
                    <strong>{formatPct(v)}</strong>
                    <Bar pct={v} level={levelOf(v, limits)} />
                  </div>
                ))}
              </div>
            ) : m.reporting === false ? <p className="hl-hex-tip-note">The server is not reporting its CPU, memory and disk.</p> : null}
            {problems.length > 0 && <ul className="hl-hex-tip-problems">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
            {m.sharedStores.filter((d) => d.level === 'warn' || d.level === 'crit').map((d) => (
              <p key={d.mount} className="hl-hex-tip-note">Shared store {d.mount} is {formatPct(d.pct)} full: counted under Storage, not against this machine.</p>
            ))}
          </div>
        ))}
    </>
  )
}

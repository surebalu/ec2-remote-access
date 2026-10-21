import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { LIMITS, formatMs, formatPct, levelOf, machines, type Level, type MachineCell, type MachineCheck, type PlmEnvHealth } from '@shared/plmHealth'
import { Icon } from '../icons'
import { Bar, Dot, MARKS, Pill, SectionHead, lvl } from './parts'

/**
 * Every machine in the environment as one hexagon of a honeycomb: green healthy, amber a warning, red unhealthy (not
 * reporting, a health check on it failing, CPU, memory or disk over the limit), grey stopped in EC2. Pointing at one
 * says which machine it is and why it has its colour; a click goes to its row under Servers (on a touch screen the
 * first tap shows the details and a second one goes). Laid out in the services' order, never by status, so a machine
 * keeps its place when it changes colour.
 */

const WORDS: Record<Level, string> = { ok: 'Healthy', warn: 'Warning', crit: 'Unhealthy', off: 'Stopped', unknown: 'No data' }
const LEGEND: Level[] = ['ok', 'warn', 'crit', 'off', 'unknown']
const GAP = 6
const TIP_W = 272

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

const shortLabel = (label: string): string => (label === 'Primary' ? 'Pri' : label === 'Secondary' ? 'Sec' : label)
const markOf = (m: MachineCell): string => {
  const known = m.roleId ? MARKS[m.roleId]?.[0] : undefined
  if (known) return known
  const letters = m.title.replace(/^3D/, '').replace(/[^A-Za-z]/g, '')
  return letters.slice(0, 1).toUpperCase() + letters.slice(1, 2).toLowerCase()
}
const checkWord = (c: MachineCheck): string =>
  c.level === 'off' ? 'stopped' : c.level === 'unknown' ? 'not running' : `${c.status ? `HTTP ${c.status}` : 'no answer'}${c.ms !== null && c.level !== 'crit' ? ` · ${formatMs(c.ms)}` : ''}`
const RANK: Record<Level, number> = { crit: 0, warn: 1, unknown: 2, ok: 3, off: 4 }

export default function Honeycomb({ env, onPick }: { env: PlmEnvHealth; onPick: (m: MachineCell) => void }): ReactElement | null {
  const cells = useMemo(() => machines(env), [env])
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
  }, [cells.length > 0]) // eslint-disable-line react-hooks/exhaustive-deps

  // Smaller cells on a phone, bigger ones when there are only a few machines.
  const n = cells.length
  const r = width < 400 ? 25 : width < 700 ? 32 : n <= 3 ? 44 : 38
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

  // Machines that share a name and have no number (the migration servers) are told apart by their address.
  const labels = useMemo(() => {
    const named = new Map<string, number>()
    for (const c of cells) named.set(c.title, (named.get(c.title) ?? 0) + 1)
    return new Map(cells.map((c) => [c.ip, c.label ? shortLabel(c.label) : (named.get(c.title) ?? 0) > 1 && /^\d+\.\d+\.\d+\.\d+$/.test(c.ip) ? `.${c.ip.split('.').pop()}` : '']))
  }, [cells])

  const shown = pinned ?? hover
  const idx = shown ? cells.findIndex((c) => c.ip === shown) : -1
  const tip = idx >= 0 ? cells[idx] : null
  useLayoutEffect(() => { if (tipRef.current) setTipH(tipRef.current.offsetHeight) }, [tip, width])

  if (!cells.length) return null
  const count = (l: Level): number => cells.filter((c) => c.level === l).length
  const running = cells.length - count('off')
  const lit = peek ?? only

  const go = (m: MachineCell): void => { setPinned(null); setHover(null); onPick(m) }
  const tap = (m: MachineCell): void => {
    // A touch has no hover: the first tap shows which machine it is, a second one goes to it.
    if (pointer.current !== 'mouse' && pinned !== m.ip) { setPinned(m.ip); return }
    go(m)
  }
  const key = (e: KeyboardEvent, m: MachineCell): void => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(m) }
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
    <>
      <SectionHead id="hl-machines" icon={<Icon.hexes />} title="Machines" sub="One hexagon per machine: point at one to see which it is" />
      <section className="hl-card hl-hive" aria-label="Machines by health">
        <div className="hl-hive-sum">
          <div className="hl-hive-score">
            <strong>{count('ok')}</strong>
            <span>of {running} {running === 1 ? 'machine' : 'machines'} healthy</span>
          </div>
          <div className="hl-hive-bar" aria-hidden="true">
            {LEGEND.filter((l) => count(l)).map((l) => <i key={l} className={lvl(l)} style={{ flexGrow: count(l) }} />)}
          </div>
          <div className="hl-hive-legend" role="group" aria-label="Show one status">
            {LEGEND.filter((l) => count(l) || l === 'ok' || l === 'crit').map((l) => (
              <button key={l} type="button" className={`${lvl(l)} ${only === l ? 'on' : ''}`} aria-pressed={only === l}
                onPointerEnter={(e) => { if (e.pointerType === 'mouse') setPeek(l) }} onPointerLeave={() => setPeek(null)} onClick={() => setOnly(only === l ? null : l)}>
                <i className={`hl-hive-swatch ${lvl(l)}`} />
                <span>{WORDS[l]}</span>
                <b>{count(l)}</b>
              </button>
            ))}
          </div>
        </div>
        <div className="hl-hive-board" ref={board} onPointerDown={(e) => { pointer.current = e.pointerType; if (!(e.target as Element).closest('.hl-hex')) setPinned(null) }}>
          {width > 0 && (
            <svg width={width} height={height} role="list" aria-label={`${cells.length} machines`}>
              <defs>
                <linearGradient id="hl-hex-shine" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#fff" stopOpacity=".26" />
                  <stop offset=".55" stopColor="#fff" stopOpacity="0" />
                </linearGradient>
                <pattern id="hl-hex-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <line x1="0" y1="0" x2="0" y2="6" className="hl-hex-hatch" />
                </pattern>
              </defs>
              {cells.map((m, i) => {
                const p = at(i)
                const label = labels.get(m.ip) ?? ''
                return (
                  <g key={m.ip} role="listitem" transform={`translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`}>
                    <g className={`hl-hex ${lvl(m.level)} ${shown === m.ip ? 'on' : ''} ${lit && m.level !== lit ? 'dim' : ''}`} tabIndex={0} role="button" data-ip={m.ip}
                      aria-label={`${m.title}, ${m.name}, ${m.ip}: ${WORDS[m.level]}${m.problems.length ? `. ${m.problems.join('. ')}` : ''}`}
                      onPointerEnter={(e) => { if (e.pointerType === 'mouse') setHover(m.ip) }} onPointerLeave={(e) => { if (e.pointerType === 'mouse') setHover((h) => (h === m.ip ? null : h)) }}
                      onFocus={() => setHover(m.ip)} onBlur={() => setHover((h) => (h === m.ip ? null : h))} onClick={() => tap(m)} onKeyDown={(e) => key(e, m)}>
                      {m.level === 'crit' && <path d={halo} className="hl-hex-halo" />}
                      <g className="hl-hex-face">
                        <path d={face} className="hl-hex-body" />
                        {m.level === 'off' && <path d={face} fill="url(#hl-hex-hatch)" />}
                        {m.level !== 'off' && m.level !== 'unknown' && <path d={face} fill="url(#hl-hex-shine)" />}
                        <text className="hl-hex-mark" y={label ? -r * 0.13 : 0} style={{ fontSize: r * 0.42 }}>{markOf(m)}</text>
                        {label && <text className="hl-hex-label" y={r * 0.33} style={{ fontSize: r * 0.3 }}>{label}</text>}
                      </g>
                    </g>
                  </g>
                )
              })}
            </svg>
          )}
          {tip && tipBox && (
            <div className={`hl-hex-tip ${lvl(tip.level)}`} ref={tipRef} role="tooltip" style={{ left: tipBox.left, top: tipBox.top, width: Math.min(TIP_W, width) }}>
              <div className="hl-hex-tip-head">
                <Dot level={tip.level} />
                <strong className="min-w-0 flex-1">{tip.title}</strong>
                {tip.os === 'windows' && <Icon.windows />}
                <Pill level={tip.level}>{WORDS[tip.level]}</Pill>
              </div>
              <div className="hl-hex-tip-sub">{tip.name}<span>{tip.ip}{tip.instanceType ? ` · ${tip.instanceType}` : ''}</span></div>
              {tip.level !== 'off' && tip.reporting && (
                <div className="hl-hex-tip-stats">
                  {([['CPU', tip.cpu, LIMITS.cpu], ['Memory', tip.mem, LIMITS.mem], [tip.disk ? `Disk ${tip.disk.mount}` : 'Disk', tip.disk?.pct ?? null, tip.os === 'windows' ? LIMITS.diskWindows : LIMITS.disk]] as const).map(([name, v, limits]) => (
                    <div key={name} className="hl-hex-tip-stat">
                      <span className="truncate">{name}</span>
                      <strong>{formatPct(v)}</strong>
                      <Bar pct={v} level={levelOf(v, limits)} />
                    </div>
                  ))}
                </div>
              )}
              {tip.problems.length > 0 && <ul className="hl-hex-tip-problems">{tip.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
              {tip.sharedStores.filter((d) => d.level === 'warn' || d.level === 'crit').map((d) => (
                <p key={d.mount} className="hl-hex-tip-note">Shared store {d.mount} is {formatPct(d.pct)} full: counted under Storage, not against this machine.</p>
              ))}
              {tip.checks.length > 0 && (
                <div className="hl-hex-tip-checks">
                  <span className="hl-mini-label">{tip.checks.length === 1 ? 'Health check on it' : `${tip.checks.length} health checks on it`}</span>
                  {[...tip.checks].sort((a, b) => RANK[a.level] - RANK[b.level]).slice(0, 6).map((c) => (
                    <div key={c.url} className="hl-hex-tip-check" title={c.url}>
                      <Dot level={c.level} />
                      <span className="min-w-0 flex-1 truncate">{c.service}</span>
                      <span className="muted">{checkWord(c)}</span>
                    </div>
                  ))}
                  {tip.checks.length > 6 && <span className="muted">{tip.checks.length - 6} more</span>}
                </div>
              )}
              {tip.state === 'stopped' && <p className="hl-hex-tip-note">Stopped in EC2: set aside, not counted as a problem.</p>}
              {tip.reporting === null && tip.state !== 'stopped' && <p className="hl-hex-tip-note">No exporter on it: only its health checks are known.</p>}
              <div className="hl-hex-tip-foot">{pinned ? 'Tap again' : 'Click'} to see {tip.listed ? 'it under Servers' : 'its service'}</div>
            </div>
          )}
        </div>
      </section>
    </>
  )
}

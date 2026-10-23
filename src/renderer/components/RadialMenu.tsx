import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent, type ReactElement, type ReactNode } from 'react'
import { comboOf, formatCombo, sectionKeys } from '@shared/keyCombos'
import { isDarkMode, isSession, useStore, type ToolKind } from '../store'
import { hasBrowser } from '../quickConnect'
import { Icon } from './icons'
import { LOOKS } from '../toolLooks'

/**
 * The radial menu: every section of the app rail as a small ring of coloured bubbles around the pointer, opened by
 * its own shortcut (Settings → Keyboard, ⇧⌘Space by default; shortcuts.ts dispatches `ec2ra:radial`). It stays open
 * until something is chosen: a click on a bubble (pointing only highlights), or the keyboard: ⌘Tab-style, hold the
 * modifiers and tap the key again (or an arrow) to step, and let go to open the one stepped to; or the arrow keys and
 * ↩, a number or a first letter. A mouse button that sends the shortcut (Razer Synapse) presses and releases the keys
 * together and may move the pointer: neither ever chooses. Esc, a right-click, a click outside or the shortcut again
 * closes it. The middle names the bubble pointed at; the bubbles carry no labels at this size.
 */

interface Item {
  id: string
  label: string
  hue: number
  sat?: number
  icon: ReactNode
  keys?: string
  /** The section in front now. */
  here: boolean
  /** A tool with a tab open (the rail's dot). */
  open: boolean
  disabled?: boolean
  run: () => void
}

const R = 86
const BALL = 32
const SIZE = 2 * (R + BALL)
const DEAD = 20
/** How far the ring and its caption reach from the centre: keeps them inside the window. */
const REACH_X = R + BALL / 2 + 60
const REACH_Y = R + BALL / 2 + 34

const rad = (deg: number): number => (deg * Math.PI) / 180

/** A ring segment from angle a0 to a1 (degrees clockwise from the top), between radii r0 and r1, centred on 0,0. */
function wedge(a0: number, a1: number, r0: number, r1: number): string {
  const p = (a: number, r: number): string => `${(Math.sin(rad(a)) * r).toFixed(2)},${(-Math.cos(rad(a)) * r).toFixed(2)}`
  const large = a1 - a0 > 180 ? 1 : 0
  return `M${p(a0, r1)}A${r1},${r1} 0 ${large} 1 ${p(a1, r1)}L${p(a1, r0)}A${r0},${r0} 0 ${large} 0 ${p(a0, r0)}Z`
}

export default function RadialMenu(): ReactElement | null {
  const tabs = useStore((s) => s.tabs)
  const activeTab = useStore((s) => s.activeTab)
  const gridView = useStore((s) => s.gridView)
  const gridHost = useStore((s) => s.gridHost)
  const shortcuts = useStore((s) => s.settings?.shortcuts)
  const launcherKey = useStore((s) => s.settings?.launcherKey ?? '')
  const theme = useStore((s) => s.settings?.theme ?? 'system')
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const [hi, setHiState] = useState<number | null>(null)
  const hiRef = useRef<number | null>(null)
  const setHi = (i: number | null): void => { hiRef.current = i; setHiState(i) }
  const [held, setHeldState] = useState(false)
  const heldRef = useRef(false)
  const setHeld = (v: boolean): void => { heldRef.current = v; setHeldState(v) }
  // The highlight was stepped to with the keys held, so letting go of them opens it. Pointing never sets it: Chromium
  // reports a pointer move as soon as the ring appears under the pointer, and a mouse button lets go of its keys at once.
  const stepped = useRef(false)
  // When the ring opened: the press that opened it (a mouse button can send a click too) never chooses.
  const openedAt = useRef(0)
  const pointer = useRef<{ x: number; y: number } | null>(null)
  const opening = useRef(false)
  const before = useRef<HTMLElement | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const st = useStore.getState

  const front = gridView ? undefined : tabs.find((t) => t.id === activeTab)
  const sessions = tabs.filter((t) => isSession(t) && !t.transient).length
  const keys = sectionKeys(shortcuts)
  const items = useMemo<Item[]>(() => {
    const k = (id: keyof typeof keys): string | undefined => formatCombo(keys[id]) || undefined
    const tool = (kind: ToolKind, label: string): Item => ({
      id: kind, label, hue: LOOKS[kind].hue, icon: LOOKS[kind].icon(), keys: k(kind), here: front?.kind === kind, open: tabs.some((t) => t.kind === kind), run: () => st().openTool(kind)
    })
    const dark = isDarkMode()
    const list: (Item | false)[] = [
      { id: 'hosts', label: 'Hosts', hue: LOOKS.hosts.hue, icon: LOOKS.hosts.icon(), keys: k('hosts') ?? '⌘1', here: !gridView && activeTab === 'hosts', open: false, run: () => st().setActive('hosts') },
      { id: 'overview', label: 'Overview', hue: LOOKS.overview.hue, icon: LOOKS.overview.icon(), keys: k('overview'), here: gridView && !gridHost, open: false, disabled: sessions === 0, run: () => st().showGrid(true) },
      tool('health', 'Health'),
      hasBrowser() && tool('local', 'Terminal'),
      hasBrowser() && tool('finder', 'Finder'),
      tool('browser', 'Browser'),
      tool('devtools', 'Dev tools'),
      tool('tasks', 'Tasks'),
      tool('calendar', 'Calendar'),
      tool('links', 'Links'),
      tool('notes', 'Notes'),
      tool('board', 'Whiteboard'),
      tool('claude', 'Claude'),
      tool('chatgpt', 'ChatGPT'),
      hasBrowser() && { id: 'launcher', label: 'Launcher', hue: 278, icon: <Icon.launcher />, keys: formatCombo(launcherKey) || undefined, here: false, open: false, run: () => void window.api.invoke('launcher:show') },
      { id: 'shortcuts', label: 'Shortcuts', hue: 236, icon: <Icon.keyboard />, keys: '⌘/', here: false, open: false, run: () => st().set({ shortcutsOpen: true }) },
      { id: 'theme', label: dark ? 'Light mode' : 'Dark mode', hue: 46, icon: dark ? <Icon.sun /> : <Icon.moon />, here: false, open: false, run: () => void st().setTheme(dark ? 'light' : 'dark') },
      { id: 'settings', label: 'Settings', hue: 215, sat: 22, icon: <Icon.settings />, keys: '⌘,', here: false, open: false, run: () => st().set({ settingsOpen: true }) }
    ]
    return list.filter((x): x is Item => !!x)
  }, [tabs, activeTab, gridView, gridHost, shortcuts, launcherKey, theme, sessions]) // eslint-disable-line react-hooks/exhaustive-deps
  const n = items.length
  const step = 360 / n
  const itemsRef = useRef(items)
  itemsRef.current = items

  const close = (restore = true): void => {
    setAt(null)
    setHi(null)
    setHeld(false)
    stepped.current = false
    if (restore) before.current?.focus?.({ preventScroll: true })
    before.current = null
  }
  const pick = (i: number | null): void => {
    const it = i === null ? null : itemsRef.current[i]
    if (!it || it.disabled) return
    close(false)
    // After the ring is gone, so the section it opens takes the focus.
    setTimeout(it.run, 0)
  }
  const stepBy = (d: number): void => {
    const list = itemsRef.current
    let i = hiRef.current ?? Math.max(0, list.findIndex((x) => x.here))
    for (let k = 0; k < list.length; k++) {
      i = (i + d + list.length) % list.length
      if (!list[i].disabled) break
    }
    setHi(i)
    stepped.current = true
  }

  // Where the pointer last was, so the ring opens under it.
  useEffect(() => {
    const mv = (e: PointerEvent): void => { pointer.current = { x: e.clientX, y: e.clientY } }
    document.addEventListener('pointermove', mv, { passive: true })
    return () => document.removeEventListener('pointermove', mv)
  }, [])

  const atRef = useRef(at)
  atRef.current = at
  useEffect(() => {
    const onOpen = (e: Event): void => {
      const wantsHold = !!(e as CustomEvent<{ held?: boolean }>).detail?.held
      if (atRef.current) {
        // The shortcut again: steps on while its modifiers are held, closes otherwise.
        if (heldRef.current) stepBy(1)
        else close()
        return
      }
      if (opening.current) return
      opening.current = true
      before.current = document.activeElement as HTMLElement | null
      stepped.current = false
      setHeld(wantsHold)
      const here = itemsRef.current.findIndex((x) => x.here)
      setHi(here >= 0 ? here : null)
      // The Mac app asks where the pointer really is: over a web page or a remote desktop the page never saw it move.
      const ask: Promise<{ x: number; y: number } | null> = hasBrowser() ? window.api.invoke('app:pointer').catch(() => null) : Promise.resolve(null)
      void ask.then((real) => {
        opening.current = false
        const w = window.innerWidth
        const h = window.innerHeight
        const p = real ?? pointer.current ?? { x: w / 2, y: h / 2 }
        const clamp = (v: number, lo: number, hi: number): number => (hi < lo ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)))
        openedAt.current = Date.now()
        setAt({ x: clamp(p.x, REACH_X + 8, w - REACH_X - 8), y: clamp(p.y, REACH_Y + 8, h - REACH_Y - 8) })
      })
    }
    window.addEventListener('ec2ra:radial', onOpen)
    return () => window.removeEventListener('ec2ra:radial', onOpen)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Take the keyboard from whatever had it (a terminal, a web page, the remote desktop) while the ring is up.
  useEffect(() => { if (at) root.current?.focus({ preventScroll: true }) }, [!!at]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!at) return
    const radialKey = sectionKeys(useStore.getState().settings?.shortcuts).radial
    const down = (e: KeyboardEvent): void => {
      // Window capture: ahead of the app's shortcuts, dialogs and the remote desktop's own handlers.
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.repeat && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      const combo = comboOf({ code: e.code, key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey })
      if (combo && combo === radialKey) {
        if (heldRef.current) stepBy(1)
        else close()
        return
      }
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey
      if (e.key === 'Escape') return close()
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) return stepBy(1)
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) return stepBy(-1)
      if (e.key === 'Enter' || (e.key === ' ' && plain && !e.shiftKey)) return pick(hiRef.current)
      if (plain && /^[0-9]$/.test(e.key)) return pick(e.key === '0' ? 9 : Number(e.key) - 1)
      if (plain && /^[a-z]$/i.test(e.key)) {
        // A first letter: the one item that starts with it opens; several are stepped through.
        const list = itemsRef.current
        const matches = list.map((x, i) => (x.label.toLowerCase().startsWith(e.key.toLowerCase()) && !x.disabled ? i : -1)).filter((i) => i >= 0)
        if (matches.length === 1) return pick(matches[0])
        if (matches.length > 1) setHi(matches[(matches.indexOf(hiRef.current ?? -1) + 1) % matches.length])
      }
    }
    const up = (e: KeyboardEvent): void => {
      if (!heldRef.current) return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      // The modifiers are up: the section stepped to while they were held opens; otherwise the ring stays for a click.
      setHeld(false)
      if (stepped.current) pick(hiRef.current)
    }
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
    }
  }, [!!at]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!at) return null

  const angleOf = (i: number): number => i * step
  const fromPointer = (e: RPointerEvent): { i: number | null; dist: number } => {
    const dx = e.clientX - at.x
    const dy = e.clientY - at.y
    const dist = Math.hypot(dx, dy)
    if (dist < DEAD) return { i: null, dist }
    const a = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360
    return { i: Math.round(a / step) % n, dist }
  }
  const onMove = (e: RPointerEvent): void => {
    // A pointer moving with no modifier down means they were let go of: from here on a click chooses.
    if (heldRef.current && !(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey)) setHeld(false)
    const { i } = fromPointer(e)
    if (i !== null && i !== hi && !items[i].disabled) { setHi(i); stepped.current = false }
  }
  /** A click that may choose: the left button, not the press that opened the ring. */
  const chooses = (e: RPointerEvent): boolean => e.button === 0 && Date.now() - openedAt.current > 300
  const onDown = (e: RPointerEvent): void => {
    if (e.button === 2) return close()
    if (!chooses(e)) return
    const { i, dist } = fromPointer(e)
    if (dist > R + BALL) return close()
    // The middle (where the pointer was when it opened) chooses nothing.
    if (i !== null) pick(i)
  }

  const cur = hi === null ? null : items[hi]
  const key = formatCombo(keys.radial)
  const keyLetter = key.replace(/^[⌃⌥⇧⌘]+/, '')
  const mods = key.slice(0, key.length - keyLetter.length)
  const colour = (it: Item, l: number, a = 1): string => `hsl(${it.hue} ${it.sat ?? 88}% ${l}% / ${a})`
  const ball = (it: Item): CSSProperties => ({ '--bg': `linear-gradient(140deg, ${colour(it, 66)}, hsl(${it.hue + 18} ${it.sat ?? 84}% 46%))`, '--shadow': `0 6px 14px -5px ${colour(it, 38, 0.65)}`, '--ring': colour(it, 60) } as CSSProperties)
  return (
    <div className="radial" ref={root} tabIndex={-1} role="menu" aria-label="Switch section" onPointerMove={onMove} onPointerDown={onDown} onContextMenu={(e) => { e.preventDefault(); close() }}>
      <div className="radial-ring" style={{ left: at.x, top: at.y, width: SIZE, height: SIZE, '--ball': `${BALL}px` } as CSSProperties}>
        <svg className="radial-wedges" width={SIZE} height={SIZE} viewBox={`${-SIZE / 2} ${-SIZE / 2} ${SIZE} ${SIZE}`} aria-hidden="true">
          <circle r={R + BALL / 2 + 9} className="radial-disc" />
          {items.map((it, i) => (
            <path key={it.id} d={wedge(angleOf(i) - step / 2 + 0.8, angleOf(i) + step / 2 - 0.8, R - BALL / 2 - 8, R + BALL / 2 + 7)}
              style={{ fill: colour(it, 58, i === hi ? 0.36 : 0.12) }} className={`radial-wedge ${i === hi ? 'on' : ''}`} />
          ))}
        </svg>
        <div className="radial-center" aria-live="polite">
          {cur ? (
            <>
              <span className="radial-center-ball" style={ball(cur)}>{cur.icon}</span>
              <strong>{cur.label}</strong>
              {cur.keys && <kbd className="kbd">{cur.keys}</kbd>}
            </>
          ) : (
            <>
              <span className="radial-center-ball plain"><Icon.radial /></span>
              <strong>Switch to…</strong>
            </>
          )}
        </div>
        {items.map((it, i) => {
          const a = rad(angleOf(i))
          const style = { '--dx': `${(Math.sin(a) * R).toFixed(1)}px`, '--dy': `${(-Math.cos(a) * R).toFixed(1)}px`, '--delay': `${i * 10}ms` } as CSSProperties
          return (
            <button key={it.id} type="button" role="menuitem" className={`radial-item ${i === hi ? 'on' : ''} ${it.here ? 'here' : ''} ${it.disabled ? 'off' : ''}`} style={style}
              aria-label={`${it.label}${it.keys ? ` (${it.keys})` : ''}`} title={it.label} aria-disabled={it.disabled || undefined} tabIndex={-1} data-radial={it.id}
              onPointerEnter={() => { if (!it.disabled) { setHi(i); stepped.current = false } }}
              onPointerDown={(e) => { e.stopPropagation(); if (e.button === 2) close(); else if (chooses(e)) pick(i) }}>
              <span className="radial-ball" style={ball(it)}>
                {it.icon}
                {it.open && !it.here && <i className="radial-dot" aria-hidden="true" />}
              </span>
            </button>
          )
        })}
        <span className="radial-hint" style={{ top: `calc(50% + ${R + BALL / 2 + 16}px)` }}>
          {held && key ? <>Tap {keyLetter} to step · let go of {mods || 'the keys'}</> : <>Click one · ← → ↩ · Esc</>}
        </span>
      </div>
    </div>
  )
}

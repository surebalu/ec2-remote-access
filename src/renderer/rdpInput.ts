/**
 * Touch and on-screen-keyboard input for the embedded RDP client.
 *
 * The iron-remote-desktop web component only reads mouse events on its canvas and keyboard events while it holds
 * focus, and a canvas can never raise the iOS keyboard. Its public `UserInteraction` has no way to inject input, so
 * `captureSessions` wraps the backend's `SessionBuilder` to keep a handle on each `Session` it connects and applies
 * device events to it directly, the same `InputTransaction` path the component uses internally.
 */
import { Backend } from '@devolutions/iron-remote-desktop-rdp'

type Session = { applyInputs(t: InstanceType<typeof Backend.InputTransaction>): void; releaseAllInputs(): void }
type DeviceEvent = ReturnType<typeof Backend.DeviceEvent.keyPressed>

/** A copy of the backend whose sessions are reported to `onSession` as they connect (one per reconnect). */
export function captureSessions(onSession: (s: Session) => void): typeof Backend {
  function SessionBuilder(): InstanceType<typeof Backend.SessionBuilder> {
    const b = new Backend.SessionBuilder()
    const connect = b.connect.bind(b)
    b.connect = async () => {
      const s = await connect()
      onSession(s as unknown as Session)
      return s
    }
    return b
  }
  return { ...Backend, SessionBuilder: SessionBuilder as unknown as typeof Backend.SessionBuilder }
}

/** PC/AT set-1 scancodes; the 0xE0 prefix marks extended keys, the encoding the component itself sends. */
export const SC = {
  Escape: 0x01, Backspace: 0x0e, Tab: 0x0f, Enter: 0x1c, Control: 0x1d, Shift: 0x2a, Alt: 0x38, Space: 0x39,
  Home: 0xe047, ArrowUp: 0xe048, PageUp: 0xe049, ArrowLeft: 0xe04b, ArrowRight: 0xe04d, End: 0xe04f,
  ArrowDown: 0xe050, PageDown: 0xe051, Insert: 0xe052, Delete: 0xe053, Meta: 0xe05b,
  F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40, F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44, F11: 0x57, F12: 0x58
} as const
export type NamedKey = keyof typeof SC

const LETTERS = 'qwertyuiop\0\0\0\0asdfghjkl\0\0\0\0\0zxcvbnm'
/** Scancode of a letter or digit, used for shortcuts (Ctrl+C must be a scancode chord, not a Unicode 'c'). */
function charScancode(ch: string): number | undefined {
  const c = ch.toLowerCase()
  if (c >= '1' && c <= '9') return 0x02 + c.charCodeAt(0) - 49
  if (c === '0') return 0x0b
  const i = LETTERS.indexOf(c)
  return c.length === 1 && i >= 0 ? 0x10 + i : undefined
}

export interface Modifiers { ctrl: boolean; alt: boolean; meta: boolean }

export class RdpInput {
  session: Session | null = null

  private apply(events: DeviceEvent[]): void {
    if (!this.session) return
    const t = new Backend.InputTransaction()
    for (const e of events) t.addEvent(e)
    try { this.session.applyInputs(t) } catch { /* session ended between the gesture and now */ }
  }

  move(x: number, y: number): void {
    this.apply([Backend.DeviceEvent.mouseMove(Math.max(0, Math.round(x)), Math.max(0, Math.round(y)))])
  }

  /** 0 = left, 1 = middle, 2 = right (DOM `MouseEvent.button` numbering, as the component passes it). */
  button(b: number, down: boolean): void {
    this.apply([down ? Backend.DeviceEvent.mouseButtonPressed(b) : Backend.DeviceEvent.mouseButtonReleased(b)])
  }

  click(x: number, y: number, b = 0): void {
    this.apply([Backend.DeviceEvent.mouseMove(Math.round(x), Math.round(y)), Backend.DeviceEvent.mouseButtonPressed(b), Backend.DeviceEvent.mouseButtonReleased(b)])
  }

  /** Positive `lines` scrolls up / left, matching the component's `-deltaY` convention. */
  wheel(vertical: boolean, lines: number): void {
    // RotationUnit.Line = 1; the enum is declared but not exported by the backend package.
    this.apply([Backend.DeviceEvent.wheelRotations(vertical, lines, 1 as never)])
  }

  private chord(mods: Modifiers, inner: DeviceEvent[]): DeviceEvent[] {
    const held: number[] = []
    if (mods.ctrl) held.push(SC.Control)
    if (mods.alt) held.push(SC.Alt)
    if (mods.meta) held.push(SC.Meta)
    return [...held.map((c) => Backend.DeviceEvent.keyPressed(c)), ...inner, ...held.reverse().map((c) => Backend.DeviceEvent.keyReleased(c))]
  }

  key(name: NamedKey, mods: Modifiers = { ctrl: false, alt: false, meta: false }): void {
    const sc = SC[name]
    this.apply(this.chord(mods, [Backend.DeviceEvent.keyPressed(sc), Backend.DeviceEvent.keyReleased(sc)]))
  }

  /** Types text. With a modifier held, letters and digits go as scancode chords so shortcuts reach Windows. */
  text(text: string, mods: Modifiers = { ctrl: false, alt: false, meta: false }): void {
    const chorded = mods.ctrl || mods.alt || mods.meta
    const events: DeviceEvent[] = []
    for (const ch of text) {
      if (ch === '\n') { events.push(Backend.DeviceEvent.keyPressed(SC.Enter), Backend.DeviceEvent.keyReleased(SC.Enter)); continue }
      const sc = chorded ? charScancode(ch) : undefined
      events.push(...(sc !== undefined ? [Backend.DeviceEvent.keyPressed(sc), Backend.DeviceEvent.keyReleased(sc)] : [Backend.DeviceEvent.unicodePressed(ch), Backend.DeviceEvent.unicodeReleased(ch)]))
    }
    this.apply(chorded ? this.chord(mods, events) : events)
  }

  releaseAll(): void {
    try { this.session?.releaseAllInputs() } catch { /* ignore */ }
  }
}

/** Keys a hardware or on-screen keyboard reports by name rather than as text. */
export const NAMED_KEYS = new Set<string>(['Escape', 'Backspace', 'Tab', 'Enter', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Delete', 'Insert', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'])

interface GestureOptions {
  /** Canvas-space coordinates of a client point, or null when the desktop is not on screen. */
  toDesktop: (clientX: number, clientY: number) => { x: number; y: number } | null
  input: RdpInput
  /** When true the next single tap is a right click (the toolbar's "right click" toggle). */
  takeRightClick: () => boolean
}

const TAP_SLOP = 10
const LONG_PRESS_MS = 550
const WHEEL_PX_PER_LINE = 18

/**
 * Direct-touch gestures on the desktop: tap = click, long press = right click, drag = left drag, two-finger drag =
 * scroll, two-finger tap = right click. Returns a cleanup function.
 */
export function attachTouchGestures(el: HTMLElement, o: GestureOptions): () => void {
  type P = { id: number; x0: number; y0: number; x: number; y: number }
  const pts = new Map<number, P>()
  let mode: 'idle' | 'pending' | 'drag' | 'scroll' | 'long' = 'idle'
  let maxPointers = 0
  let longTimer: ReturnType<typeof setTimeout> | undefined
  let scrollAcc = { x: 0, y: 0 }
  /** Whether a two-finger gesture moved enough to be a scroll rather than a two-finger tap. */
  let scrolled = false
  let last = { x: 0, y: 0 }

  const mid = (): { x: number; y: number } => {
    const a = [...pts.values()]
    return { x: a.reduce((s, p) => s + p.x, 0) / a.length, y: a.reduce((s, p) => s + p.y, 0) / a.length }
  }
  const at = (x: number, y: number, fn: (p: { x: number; y: number }) => void): void => {
    const d = o.toDesktop(x, y)
    if (d) fn(d)
  }

  const down = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse') return
    e.preventDefault()
    el.setPointerCapture?.(e.pointerId)
    pts.set(e.pointerId, { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY })
    maxPointers = Math.max(maxPointers, pts.size)
    clearTimeout(longTimer)
    if (pts.size === 1) {
      mode = 'pending'
      at(e.clientX, e.clientY, (p) => o.input.move(p.x, p.y))
      longTimer = setTimeout(() => {
        if (mode !== 'pending' || pts.size !== 1) return
        mode = 'long'
        at(e.clientX, e.clientY, (p) => o.input.click(p.x, p.y, 2))
      }, LONG_PRESS_MS)
    } else if (pts.size === 2) {
      // A second finger turns a pending tap into a scroll (or a two-finger tap if nothing moves).
      if (mode === 'drag') o.input.button(0, false)
      mode = 'scroll'
      scrollAcc = { x: 0, y: 0 }
      scrolled = false
      last = mid()
    }
  }

  const move = (e: PointerEvent): void => {
    const p = pts.get(e.pointerId)
    if (!p) return
    e.preventDefault()
    p.x = e.clientX
    p.y = e.clientY
    if (mode === 'pending' && Math.hypot(p.x - p.x0, p.y - p.y0) > TAP_SLOP) {
      clearTimeout(longTimer)
      mode = 'drag'
      at(p.x0, p.y0, (d) => { o.input.move(d.x, d.y); o.input.button(0, true) })
    }
    if (mode === 'drag') at(p.x, p.y, (d) => o.input.move(d.x, d.y))
    else if (mode === 'scroll' && pts.size >= 2) {
      const m = mid()
      scrollAcc.y += m.y - last.y
      scrollAcc.x += m.x - last.x
      last = m
      if (Math.hypot(p.x - p.x0, p.y - p.y0) > TAP_SLOP) scrolled = true
      const ly = Math.trunc(scrollAcc.y / WHEEL_PX_PER_LINE)
      const lx = Math.trunc(scrollAcc.x / WHEEL_PX_PER_LINE)
      if (ly) { o.input.wheel(true, ly); scrollAcc.y -= ly * WHEEL_PX_PER_LINE }
      if (lx) { o.input.wheel(false, lx); scrollAcc.x -= lx * WHEEL_PX_PER_LINE }
    }
  }

  const up = (e: PointerEvent): void => {
    const p = pts.get(e.pointerId)
    if (!p) return
    e.preventDefault()
    pts.delete(e.pointerId)
    clearTimeout(longTimer)
    if (pts.size > 0) return
    if (mode === 'pending') {
      const right = o.takeRightClick()
      at(p.x, p.y, (d) => o.input.click(d.x, d.y, right ? 2 : 0))
    } else if (mode === 'drag') {
      o.input.button(0, false)
    } else if (mode === 'scroll' && maxPointers === 2 && !scrolled) {
      at(p.x, p.y, (d) => o.input.click(d.x, d.y, 2))
    }
    mode = 'idle'
    maxPointers = 0
  }

  const cancel = (e: PointerEvent): void => {
    if (!pts.delete(e.pointerId) || pts.size) return
    clearTimeout(longTimer)
    if (mode === 'drag') o.input.button(0, false)
    mode = 'idle'
    maxPointers = 0
  }

  // iOS Safari still pans/zooms the page from a touch unless the element opts out (see .rdp-touch in styles.css);
  // the context menu and callout are suppressed so a long press stays a right click.
  const noMenu = (e: Event): void => e.preventDefault()
  el.addEventListener('pointerdown', down)
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', cancel)
  el.addEventListener('contextmenu', noMenu)
  return () => {
    clearTimeout(longTimer)
    el.removeEventListener('pointerdown', down)
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
    el.removeEventListener('pointercancel', cancel)
    el.removeEventListener('contextmenu', noMenu)
  }
}

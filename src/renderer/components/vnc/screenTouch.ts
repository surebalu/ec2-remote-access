/**
 * Touch input for the screen tab on a phone or tablet. A layer over noVNC's canvas takes every touch, so this decides
 * what a finger means instead of noVNC's built-in gestures:
 *
 *   Trackpad  one finger moves a pointer drawn on screen (scaled by the tracking speed); tap clicks where it is;
 *             tap then hold and drag drags.
 *   Touch     tap clicks under the finger; hold for half a second right-clicks; drag drags.
 *   Both      two-finger tap right-clicks; two fingers apart/together zoom this view (unless zooming is off) and move
 *             it; two fingers moving together scroll.
 *
 * Zoom and pan are a CSS transform on noVNC's screen element (noVNC itself stays in fit mode), and points are mapped
 * through the canvas' on-screen box, so they stay right at any zoom.
 */

export type PointerMode = 'trackpad' | 'touch'

export interface View { scale: number; x: number; y: number }

export interface TouchDeps {
  /** The element noVNC draws into; it is transformed for zoom. */
  screen: HTMLElement
  canvas: () => HTMLCanvasElement | null
  mode: () => PointerMode
  /** Cursor speed multiplier for trackpad mode (1 = follows the finger). */
  speed: () => number
  zoomable: () => boolean
  /** A pointer event in framebuffer pixels; mask bits: 1 left, 2 middle, 4 right, 8/16 wheel up/down. */
  send: (x: number, y: number, mask: number) => void
  /** The trackpad pointer moved (framebuffer pixels), to draw it. */
  onCursor: (p: { x: number; y: number }) => void
  onView: (v: View) => void
}

const TAP_MS = 250
const HOLD_MS = 500
const SLOP = 10
const SCROLL_STEP = 24
const MAX_SCALE = 8

interface Pt { id: number; x: number; y: number }

export function attachScreenTouch(layer: HTMLElement, d: TouchDeps): { detach: () => void; setView: (v: View) => void; cursor: () => { x: number; y: number }; center: () => void } {
  const pts = new Map<number, Pt>()
  let view: View = { scale: 1, x: 0, y: 0 }
  let cursor = { x: 0, y: 0 }
  let cursorSet = false
  let mask = 0

  // One-finger state.
  let downAt = 0
  let start: Pt | null = null
  let last: Pt | null = null
  let moved = false
  let dragging = false
  let holdTimer: ReturnType<typeof setTimeout> | null = null
  let lastTapAt = 0
  // Two-finger state.
  let two: { at: number; dist0: number; mid0: { x: number; y: number }; view0: View; kind: 'undecided' | 'pinch' | 'scroll'; moved: boolean; scrollAcc: number; lastMid: { x: number; y: number } } | null = null
  let lifted = false

  const box = (): DOMRect | null => d.canvas()?.getBoundingClientRect() ?? null
  const toFb = (cx: number, cy: number): { x: number; y: number } | null => {
    const c = d.canvas()
    const r = box()
    if (!c || !r || !r.width || !r.height) return null
    const x = ((cx - r.left) * c.width) / r.width
    const y = ((cy - r.top) * c.height) / r.height
    return { x: Math.max(0, Math.min(c.width - 1, x)), y: Math.max(0, Math.min(c.height - 1, y)) }
  }
  const fbPerPx = (): number => {
    const c = d.canvas()
    const r = box()
    return c && r && r.width ? c.width / r.width : 1
  }

  const apply = (): void => {
    d.screen.style.transformOrigin = '0 0'
    d.screen.style.transform = view.scale === 1 && !view.x && !view.y ? '' : `translate(${view.x}px, ${view.y}px) scale(${view.scale})`
    d.onView(view)
  }
  /** Keeps the picture on screen: centred when smaller than the layer, edge to edge when larger. */
  const clamp = (): void => {
    apply()
    const r = box()
    const l = layer.getBoundingClientRect()
    if (!r) return
    let dx = 0
    let dy = 0
    if (r.width <= l.width) dx = l.left + (l.width - r.width) / 2 - r.left
    else if (r.left > l.left) dx = l.left - r.left
    else if (r.right < l.right) dx = l.right - r.right
    if (r.height <= l.height) dy = l.top + (l.height - r.height) / 2 - r.top
    else if (r.top > l.top) dy = l.top - r.top
    else if (r.bottom < l.bottom) dy = l.bottom - r.bottom
    if (dx || dy) { view = { ...view, x: view.x + dx, y: view.y + dy }; apply() }
  }
  const setView = (v: View): void => { view = v; clamp() }

  const ensureCursor = (): void => {
    if (cursorSet) return
    const c = d.canvas()
    if (!c) return
    cursor = { x: c.width / 2, y: c.height / 2 }
    cursorSet = true
    d.onCursor(cursor)
  }
  /** While zoomed, the view follows the trackpad pointer when it nears an edge. */
  const follow = (): void => {
    const c = d.canvas()
    const r = box()
    if (!c || !r || view.scale <= 1) return
    const l = layer.getBoundingClientRect()
    const px = r.left + (cursor.x * r.width) / c.width
    const py = r.top + (cursor.y * r.height) / c.height
    const m = 40
    const dx = px < l.left + m ? l.left + m - px : px > l.right - m ? l.right - m - px : 0
    const dy = py < l.top + m ? l.top + m - py : py > l.bottom - m ? l.bottom - m - py : 0
    if (dx || dy) { view = { ...view, x: view.x + dx, y: view.y + dy }; clamp() }
  }
  const at = (): { x: number; y: number } => cursor
  const click = (p: { x: number; y: number }, button: number): void => {
    d.send(p.x, p.y, mask)
    d.send(p.x, p.y, mask | button)
    d.send(p.x, p.y, mask)
  }

  const clearHold = (): void => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null } }

  const down = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse') return
    e.preventDefault()
    try { layer.setPointerCapture(e.pointerId) } catch { /* the pointer is already gone */ }
    pts.set(e.pointerId, { id: e.pointerId, x: e.clientX, y: e.clientY })
    if (pts.size === 1) {
      lifted = false
      downAt = Date.now()
      start = { id: e.pointerId, x: e.clientX, y: e.clientY }
      last = start
      moved = false
      dragging = false
      ensureCursor()
      if (d.mode() === 'trackpad') {
        // Tap, then put the finger down again and move: a drag with the button held.
        if (Date.now() - lastTapAt < 300) dragging = true
      } else {
        const p = toFb(e.clientX, e.clientY)
        holdTimer = setTimeout(() => {
          if (moved || pts.size !== 1 || !p) return
          holdTimer = null
          lifted = true
          click(p, 4)
        }, HOLD_MS)
      }
    } else if (pts.size === 2) {
      clearHold()
      if (dragging && mask & 1) { mask &= ~1; d.send(cursor.x, cursor.y, mask) }
      dragging = false
      const [a, b] = [...pts.values()]
      two = { at: Date.now(), dist0: Math.hypot(a.x - b.x, a.y - b.y), mid0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, view0: view, kind: 'undecided', moved: false, scrollAcc: 0, lastMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }
    }
  }

  const move = (e: PointerEvent): void => {
    const p = pts.get(e.pointerId)
    if (!p) return
    e.preventDefault()
    p.x = e.clientX
    p.y = e.clientY
    if (pts.size === 1 && start && last && !lifted) {
      const dx = e.clientX - last.x
      const dy = e.clientY - last.y
      last = { id: e.pointerId, x: e.clientX, y: e.clientY }
      if (!moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) > SLOP) {
        moved = true
        clearHold()
        if (d.mode() === 'touch') {
          // Touch: a drag presses where the finger started.
          const s0 = toFb(start.x, start.y)
          if (s0) { cursor = s0; d.send(s0.x, s0.y, mask); mask |= 1; d.send(s0.x, s0.y, mask); dragging = true }
        } else if (dragging) {
          mask |= 1
          d.send(cursor.x, cursor.y, mask)
        }
      }
      if (!moved) return
      if (d.mode() === 'trackpad') {
        const c = d.canvas()
        if (!c) return
        const k = fbPerPx() * d.speed()
        cursor = { x: Math.max(0, Math.min(c.width - 1, cursor.x + dx * k)), y: Math.max(0, Math.min(c.height - 1, cursor.y + dy * k)) }
        cursorSet = true
        d.onCursor(cursor)
        d.send(cursor.x, cursor.y, mask)
        follow()
      } else {
        const q = toFb(e.clientX, e.clientY)
        if (q) { cursor = q; d.send(q.x, q.y, mask) }
      }
    } else if (pts.size === 2 && two) {
      const [a, b] = [...pts.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      if (two.kind === 'undecided') {
        const spread = Math.abs(dist - two.dist0)
        const travel = Math.hypot(mid.x - two.mid0.x, mid.y - two.mid0.y)
        if (spread > SLOP || travel > SLOP) {
          two.moved = true
          two.kind = spread > travel && d.zoomable() ? 'pinch' : 'scroll'
          two.lastMid = mid
        }
      }
      if (two.kind === 'pinch') {
        const l = layer.getBoundingClientRect()
        const scale = Math.max(1, Math.min(MAX_SCALE, two.view0.scale * (dist / Math.max(1, two.dist0))))
        // Keep the spot between the fingers under them while zooming and moving.
        const ox = (two.mid0.x - l.left - two.view0.x) / two.view0.scale
        const oy = (two.mid0.y - l.top - two.view0.y) / two.view0.scale
        view = { scale, x: mid.x - l.left - ox * scale, y: mid.y - l.top - oy * scale }
        clamp()
      } else if (two.kind === 'scroll') {
        two.scrollAcc += mid.y - two.lastMid.y
        two.lastMid = mid
        const target = d.mode() === 'trackpad' ? at() : toFb(mid.x, mid.y) ?? at()
        while (Math.abs(two.scrollAcc) >= SCROLL_STEP) {
          // Natural scrolling: fingers moving up move the content up, which is the wheel turning down.
          const up = two.scrollAcc > 0
          click(target, up ? 8 : 16)
          two.scrollAcc += up ? -SCROLL_STEP : SCROLL_STEP
        }
      }
    }
  }

  const up = (e: PointerEvent): void => {
    if (!pts.has(e.pointerId)) return
    e.preventDefault()
    const wasTwo = pts.size === 2 && two
    pts.delete(e.pointerId)
    if (wasTwo) {
      if (!two!.moved && Date.now() - two!.at < TAP_MS + 100) click(d.mode() === 'trackpad' ? at() : toFb(two!.mid0.x, two!.mid0.y) ?? at(), 4)
      two = null
      lifted = true
      return
    }
    if (pts.size > 0) return
    clearHold()
    if (lifted) { lifted = false; return }
    if (mask & 1) { mask &= ~1; d.send(cursor.x, cursor.y, mask); dragging = false; return }
    if (!moved && Date.now() - downAt < TAP_MS) {
      if (d.mode() === 'trackpad') {
        lastTapAt = Date.now()
        click(cursor, 1)
      } else if (start) {
        const p = toFb(start.x, start.y)
        if (p) { cursor = p; click(p, 1) }
      }
    }
    dragging = false
  }

  layer.addEventListener('pointerdown', down)
  layer.addEventListener('pointermove', move)
  layer.addEventListener('pointerup', up)
  layer.addEventListener('pointercancel', up)
  return {
    detach: () => {
      clearHold()
      layer.removeEventListener('pointerdown', down)
      layer.removeEventListener('pointermove', move)
      layer.removeEventListener('pointerup', up)
      layer.removeEventListener('pointercancel', up)
      d.screen.style.transform = ''
    },
    setView,
    cursor: () => cursor,
    center: () => { cursorSet = false; ensureCursor() }
  }
}

/** The view for a scaling choice: fit (the whole screen), fill (covers the layer), actual (one remote pixel per CSS pixel). */
export function presetView(kind: 'fit' | 'fill' | 'actual', fit: { width: number; height: number }, layer: { width: number; height: number }, fb: { width: number; height: number }): View {
  if (!fit.width || !fit.height) return { scale: 1, x: 0, y: 0 }
  const scale = kind === 'fit' ? 1 : kind === 'fill' ? Math.max(layer.width / fit.width, layer.height / fit.height) : fb.width / fit.width
  return { scale: Math.max(1, Math.min(MAX_SCALE, scale)), x: 0, y: 0 }
}

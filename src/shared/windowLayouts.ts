/**
 * Window layouts, as Raycast and Rectangle have them: where the window in front goes (a half, a third, a ninth of the
 * screen…) or how it changes (centre, larger, the next display). The launcher lists them and each can have a key that
 * works in any app (Settings → Windows). Pure, so main (main/desktopKeys.ts) and the renderer share the catalogue and
 * tests/windowLayouts.test.ts covers the arithmetic. Frames are in global points with the origin at the top left of
 * the main display, as Electron's `screen` and macOS's accessibility API both give them.
 */

export interface Rect { x: number; y: number; w: number; h: number }

export type LayoutGroup = 'Halves' | 'Thirds' | 'Fourths' | 'Quarters' | 'Sixths' | 'Eighths' | 'Ninths' | 'Twelfths' | 'Size' | 'Move' | 'Displays'

export const LAYOUT_GROUPS: LayoutGroup[] = ['Halves', 'Thirds', 'Fourths', 'Quarters', 'Sixths', 'Eighths', 'Ninths', 'Twelfths', 'Size', 'Move', 'Displays']

/** What a group is for, under its heading in Settings. */
export const GROUP_ABOUT: Record<LayoutGroup, string> = {
  Halves: 'Two windows side by side or one above the other.',
  Thirds: 'Three columns (or rows), or one window on two of them.',
  Fourths: 'Four columns: on a large screen, four apps side by side at full height.',
  Quarters: 'The four corners.',
  Sixths: 'Three columns of two: six windows at once.',
  Eighths: 'Four columns of two: eight windows on a large display.',
  Ninths: 'Three by three: nine windows on a 55-inch screen.',
  Twelfths: 'Four by three, for dashboards and terminals on a very large screen.',
  Size: 'Fill the screen, centre the window, or make it larger or smaller.',
  Move: 'Slide the window to an edge, keeping its size.',
  Displays: 'Move the window to another display, at the same place on it.'
}

/** What a layout does: an `area` of the screen (fractions of its usable part), or an operation. */
export type LayoutOp =
  | 'center' | 'maximize' | 'almostMaximize' | 'maximizeHeight' | 'maximizeWidth' | 'reasonable' | 'larger' | 'smaller'
  | 'restore' | 'fullscreen' | 'minimize' | 'moveLeft' | 'moveRight' | 'moveUp' | 'moveDown' | 'nextDisplay' | 'previousDisplay'

export interface WindowLayout {
  id: string
  name: string
  group: LayoutGroup
  area?: Rect
  op?: LayoutOp
  /** Other words it is found by in the launcher. */
  words?: string
}

const area = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h })

function grid(group: LayoutGroup, cols: number, rows: number, idPart: string, names: string[][]): WindowLayout[] {
  const out: WindowLayout[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const name = names[r][c]
      out.push({ id: `${name.toLowerCase().replace(/ /g, '-')}-${idPart}`, name: `${name} ${group === 'Quarters' ? 'Quarter' : group.replace(/s$/, '')}`, group, area: area(c / cols, r / rows, 1 / cols, 1 / rows) })
    }
  }
  return out
}

export const WINDOW_LAYOUTS: WindowLayout[] = [
  { id: 'left-half', name: 'Left Half', group: 'Halves', area: area(0, 0, 1 / 2, 1) },
  { id: 'right-half', name: 'Right Half', group: 'Halves', area: area(1 / 2, 0, 1 / 2, 1) },
  { id: 'center-half', name: 'Center Half', group: 'Halves', area: area(1 / 4, 0, 1 / 2, 1), words: 'middle' },
  { id: 'top-half', name: 'Top Half', group: 'Halves', area: area(0, 0, 1, 1 / 2) },
  { id: 'bottom-half', name: 'Bottom Half', group: 'Halves', area: area(0, 1 / 2, 1, 1 / 2) },

  { id: 'first-third', name: 'First Third', group: 'Thirds', area: area(0, 0, 1 / 3, 1), words: 'left' },
  { id: 'center-third', name: 'Center Third', group: 'Thirds', area: area(1 / 3, 0, 1 / 3, 1), words: 'middle' },
  { id: 'last-third', name: 'Last Third', group: 'Thirds', area: area(2 / 3, 0, 1 / 3, 1), words: 'right' },
  { id: 'first-two-thirds', name: 'First Two Thirds', group: 'Thirds', area: area(0, 0, 2 / 3, 1), words: 'left' },
  { id: 'center-two-thirds', name: 'Center Two Thirds', group: 'Thirds', area: area(1 / 6, 0, 2 / 3, 1), words: 'middle' },
  { id: 'last-two-thirds', name: 'Last Two Thirds', group: 'Thirds', area: area(1 / 3, 0, 2 / 3, 1), words: 'right' },
  { id: 'top-third', name: 'Top Third', group: 'Thirds', area: area(0, 0, 1, 1 / 3), words: 'row' },
  { id: 'middle-third', name: 'Middle Third', group: 'Thirds', area: area(0, 1 / 3, 1, 1 / 3), words: 'row center' },
  { id: 'bottom-third', name: 'Bottom Third', group: 'Thirds', area: area(0, 2 / 3, 1, 1 / 3), words: 'row' },
  { id: 'top-two-thirds', name: 'Top Two Thirds', group: 'Thirds', area: area(0, 0, 1, 2 / 3), words: 'rows' },
  { id: 'bottom-two-thirds', name: 'Bottom Two Thirds', group: 'Thirds', area: area(0, 1 / 3, 1, 2 / 3), words: 'rows' },

  { id: 'first-fourth', name: 'First Fourth', group: 'Fourths', area: area(0, 0, 1 / 4, 1), words: 'quarter column left' },
  { id: 'second-fourth', name: 'Second Fourth', group: 'Fourths', area: area(1 / 4, 0, 1 / 4, 1), words: 'quarter column' },
  { id: 'third-fourth', name: 'Third Fourth', group: 'Fourths', area: area(2 / 4, 0, 1 / 4, 1), words: 'quarter column' },
  { id: 'last-fourth', name: 'Last Fourth', group: 'Fourths', area: area(3 / 4, 0, 1 / 4, 1), words: 'quarter column right' },
  { id: 'first-three-fourths', name: 'First Three Fourths', group: 'Fourths', area: area(0, 0, 3 / 4, 1), words: 'quarters left' },
  { id: 'last-three-fourths', name: 'Last Three Fourths', group: 'Fourths', area: area(1 / 4, 0, 3 / 4, 1), words: 'quarters right' },

  ...grid('Quarters', 2, 2, 'quarter', [['Top Left', 'Top Right'], ['Bottom Left', 'Bottom Right']]),
  ...grid('Sixths', 3, 2, 'sixth', [['Top Left', 'Top Center', 'Top Right'], ['Bottom Left', 'Bottom Center', 'Bottom Right']]),
  ...grid('Eighths', 4, 2, 'eighth', [['Top First', 'Top Second', 'Top Third', 'Top Last'], ['Bottom First', 'Bottom Second', 'Bottom Third', 'Bottom Last']]),
  ...grid('Ninths', 3, 3, 'ninth', [['Top Left', 'Top Center', 'Top Right'], ['Middle Left', 'Middle Center', 'Middle Right'], ['Bottom Left', 'Bottom Center', 'Bottom Right']]),
  ...grid('Twelfths', 4, 3, 'twelfth', [['Top First', 'Top Second', 'Top Third', 'Top Last'], ['Middle First', 'Middle Second', 'Middle Third', 'Middle Last'], ['Bottom First', 'Bottom Second', 'Bottom Third', 'Bottom Last']]),

  { id: 'maximize', name: 'Maximize', group: 'Size', op: 'maximize', words: 'fill full zoom' },
  { id: 'almost-maximize', name: 'Almost Maximize', group: 'Size', op: 'almostMaximize', words: 'fill large' },
  { id: 'maximize-height', name: 'Maximize Height', group: 'Size', op: 'maximizeHeight', words: 'tall vertical' },
  { id: 'maximize-width', name: 'Maximize Width', group: 'Size', op: 'maximizeWidth', words: 'wide horizontal' },
  { id: 'center', name: 'Center', group: 'Size', op: 'center', words: 'centre middle' },
  { id: 'reasonable-size', name: 'Reasonable Size', group: 'Size', op: 'reasonable', words: 'default normal medium centre center' },
  { id: 'make-larger', name: 'Make Larger', group: 'Size', op: 'larger', words: 'grow bigger increase' },
  { id: 'make-smaller', name: 'Make Smaller', group: 'Size', op: 'smaller', words: 'shrink decrease' },
  { id: 'restore', name: 'Restore', group: 'Size', op: 'restore', words: 'undo previous back original' },
  { id: 'toggle-fullscreen', name: 'Toggle Full Screen', group: 'Size', op: 'fullscreen', words: 'fullscreen' },
  { id: 'minimize', name: 'Minimize', group: 'Size', op: 'minimize', words: 'dock hide' },

  { id: 'move-left', name: 'Move Left', group: 'Move', op: 'moveLeft', words: 'edge' },
  { id: 'move-right', name: 'Move Right', group: 'Move', op: 'moveRight', words: 'edge' },
  { id: 'move-up', name: 'Move Up', group: 'Move', op: 'moveUp', words: 'edge top' },
  { id: 'move-down', name: 'Move Down', group: 'Move', op: 'moveDown', words: 'edge bottom' },

  { id: 'next-display', name: 'Next Display', group: 'Displays', op: 'nextDisplay', words: 'screen monitor' },
  { id: 'previous-display', name: 'Previous Display', group: 'Displays', op: 'previousDisplay', words: 'screen monitor' }
]

const BY_ID = new Map(WINDOW_LAYOUTS.map((l) => [l.id, l]))
export const layoutById = (id: string): WindowLayout | undefined => BY_ID.get(id)

/**
 * Rectangle's keys, which many people already know, for "Use suggested keys" in Settings: ⌃⌥ with an arrow for the
 * halves, U I J K for the corners, D F G E T for the thirds, ↩ to maximize, ⌃⌥⌘ arrows between displays.
 */
export const SUGGESTED_WINDOW_KEYS: Record<string, string> = {
  'left-half': 'ctrl+alt+left', 'right-half': 'ctrl+alt+right', 'top-half': 'ctrl+alt+up', 'bottom-half': 'ctrl+alt+down',
  'top-left-quarter': 'ctrl+alt+u', 'top-right-quarter': 'ctrl+alt+i', 'bottom-left-quarter': 'ctrl+alt+j', 'bottom-right-quarter': 'ctrl+alt+k',
  'first-third': 'ctrl+alt+d', 'center-third': 'ctrl+alt+f', 'last-third': 'ctrl+alt+g', 'first-two-thirds': 'ctrl+alt+e', 'last-two-thirds': 'ctrl+alt+t',
  maximize: 'ctrl+alt+enter', 'maximize-height': 'ctrl+alt+shift+up', center: 'ctrl+alt+c', 'make-larger': 'ctrl+alt+=', 'make-smaller': 'ctrl+alt+-',
  restore: 'ctrl+alt+backspace', 'next-display': 'ctrl+alt+cmd+right', 'previous-display': 'ctrl+alt+cmd+left'
}

/** The window can never be made smaller than this by Make Smaller. */
const MIN = { w: 320, h: 200 }

/**
 * Where an area of the screen is, leaving `gap` points between windows and around the screen's edge: a full gap at an
 * edge of the screen, half on each side of an edge two windows share, so neighbours sit a full gap apart.
 */
export function areaFrame(a: Rect, screen: Rect, gap = 0): Rect {
  const g = Math.max(0, gap)
  const edge = (f: number): boolean => Math.abs(f) < 1e-6 || Math.abs(f - 1) < 1e-6
  const x0 = screen.x + a.x * screen.w + (edge(a.x) ? g : g / 2)
  const x1 = screen.x + (a.x + a.w) * screen.w - (edge(a.x + a.w) ? g : g / 2)
  const y0 = screen.y + a.y * screen.h + (edge(a.y) ? g : g / 2)
  const y1 = screen.y + (a.y + a.h) * screen.h - (edge(a.y + a.h) ? g : g / 2)
  return { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) }
}

const clampTo = (r: Rect, s: Rect): Rect => {
  const w = Math.min(r.w, s.w)
  const h = Math.min(r.h, s.h)
  return { x: Math.round(Math.min(Math.max(r.x, s.x), s.x + s.w - w)), y: Math.round(Math.min(Math.max(r.y, s.y), s.y + s.h - h)), w: Math.round(w), h: Math.round(h) }
}

const centred = (w: number, h: number, s: Rect): Rect => ({ x: Math.round(s.x + (s.w - w) / 2), y: Math.round(s.y + (s.h - h) / 2), w: Math.round(w), h: Math.round(h) })

/** The display (index into `displays`) the window is mostly on: the largest overlap, else the nearest centre. */
export function displayOf(win: Rect, displays: Rect[]): number {
  let best = -1
  let most = 0
  displays.forEach((d, i) => {
    const w = Math.min(win.x + win.w, d.x + d.w) - Math.max(win.x, d.x)
    const h = Math.min(win.y + win.h, d.y + d.h) - Math.max(win.y, d.y)
    if (w > 0 && h > 0 && w * h > most) { most = w * h; best = i }
  })
  if (best >= 0) return best
  const cx = win.x + win.w / 2
  const cy = win.y + win.h / 2
  let near = Infinity
  displays.forEach((d, i) => {
    const dist = Math.hypot(d.x + d.w / 2 - cx, d.y + d.h / 2 - cy)
    if (dist < near) { near = dist; best = i }
  })
  return Math.max(0, best)
}

/** Displays in reading order (left to right, then top to bottom), as Next Display steps through them. */
export function displayOrder(displays: Rect[]): number[] {
  return displays.map((d, i) => ({ d, i })).sort((a, b) => a.d.x - b.d.x || a.d.y - b.d.y).map((x) => x.i)
}

/**
 * Where `layout` puts a window now at `win`. `displays` are the usable parts of every display (without the menu bar and
 * Dock). Returns null for what is not a frame (Restore, Full Screen, Minimize: main does those), or for one display only
 * when moving between displays.
 */
export function layoutFrame(layout: WindowLayout, win: Rect, displays: Rect[], gap = 0): Rect | null {
  if (!displays.length) return null
  const at = displayOf(win, displays)
  const s = displays[at]
  if (layout.area) return areaFrame(layout.area, s, gap)
  const inner: Rect = { x: s.x + gap, y: s.y + gap, w: s.w - 2 * gap, h: s.h - 2 * gap }
  switch (layout.op) {
    case 'maximize': return areaFrame({ x: 0, y: 0, w: 1, h: 1 }, s, gap)
    case 'almostMaximize': return centred(s.w * 0.9, s.h * 0.9, s)
    case 'maximizeHeight': return clampTo({ x: win.x, y: inner.y, w: win.w, h: inner.h }, inner)
    case 'maximizeWidth': return clampTo({ x: inner.x, y: win.y, w: inner.w, h: win.h }, inner)
    case 'center': return clampTo(centred(win.w, win.h, s), s)
    case 'reasonable': return centred(Math.min(s.w, Math.max(MIN.w, s.w * 0.6)), Math.min(s.h, Math.max(MIN.h, s.h * 0.75)), s)
    case 'larger':
    case 'smaller': {
      // Five per cent of the screen on each side, about the window's centre, kept on the screen.
      const sign = layout.op === 'larger' ? 1 : -1
      const dw = s.w * 0.05 * sign
      const dh = s.h * 0.05 * sign
      const w = Math.min(s.w, Math.max(MIN.w, win.w + 2 * dw))
      const h = Math.min(s.h, Math.max(MIN.h, win.h + 2 * dh))
      return clampTo({ x: win.x + (win.w - w) / 2, y: win.y + (win.h - h) / 2, w, h }, s)
    }
    case 'moveLeft': return clampTo({ ...win, x: inner.x }, s)
    case 'moveRight': return clampTo({ ...win, x: inner.x + inner.w - win.w }, s)
    case 'moveUp': return clampTo({ ...win, y: inner.y }, s)
    case 'moveDown': return clampTo({ ...win, y: inner.y + inner.h - win.h }, s)
    case 'nextDisplay':
    case 'previousDisplay': {
      if (displays.length < 2) return null
      const order = displayOrder(displays)
      const pos = order.indexOf(at)
      const to = displays[order[(pos + (layout.op === 'nextDisplay' ? 1 : -1) + order.length) % order.length]]
      // The same place and the same share of the screen, so a left half stays a left half on a screen of another size.
      const fx = (win.x - s.x) / s.w
      const fy = (win.y - s.y) / s.h
      const w = Math.min(to.w, (win.w / s.w) * to.w)
      const h = Math.min(to.h, (win.h / s.h) * to.h)
      return clampTo({ x: to.x + fx * to.w, y: to.y + fy * to.h, w, h }, to)
    }
    default: return null
  }
}

/** Whether two frames are the same to within a couple of points (apps round sizes to their own steps). */
export function sameFrame(a: Rect, b: Rect, slack = 2): boolean {
  return Math.abs(a.x - b.x) <= slack && Math.abs(a.y - b.y) <= slack && Math.abs(a.w - b.w) <= slack && Math.abs(a.h - b.h) <= slack
}

/**
 * Display selection for the screen tab. A Mac's Screen Sharing sends every display as one wide picture, so showing a
 * single display means cropping that picture to where the display sits. Where each one sits comes from public sources
 * only: this machine's own displays when the app runs on the Mac being shared (Electron's screen list), or sizes the
 * user types once (read from System Settings → Displays), arranged side by side or stacked. Either is checked against
 * the picture's real size before it is used. Pure, tested in tests/displays.test.ts.
 */

/** One display in points, top-left origin, as the Mac arranges them. */
export interface DisplayFrame {
  x: number
  y: number
  width: number
  height: number
  label?: string
  primary?: boolean
}

/** What the user typed to describe the displays: sizes in reading order and how they are arranged. */
export interface DisplayLayout {
  sizes: { width: number; height: number }[]
  direction: 'row' | 'column'
  align: 'start' | 'center' | 'end'
}

/** A display as a rectangle of the screen picture, in its pixels. */
export interface DisplayRegion {
  id: number
  name: string
  x: number
  y: number
  width: number
  height: number
  /** The display's own size in points, as System Settings shows it. */
  points: { width: number; height: number }
}

export interface DisplayInfo {
  /** The displays of the machine the app runs on, when that is the computer being shared. */
  auto: DisplayFrame[] | null
  /** What the user described for this computer. */
  saved: DisplayLayout | null
}

export interface Resolved {
  displays: DisplayRegion[]
  /** Why the known layout is not used (it does not match the picture), for the setup sheet. */
  problem?: string
}

const MAX_DISPLAYS = 8
/** A layout matches the picture when its proportions agree within this share. */
const TOLERANCE = 0.02

/** Left to right, then top to bottom, which is how people count displays on a desk. */
export function readingOrder<T extends { x: number; y: number }>(frames: T[]): T[] {
  return [...frames].sort((a, b) => a.x - b.x || a.y - b.y)
}

/** Arranges displays of the given sizes in a row or a column; `align` places the shorter ones (start = top or left). */
export function layoutFromSizes(layout: DisplayLayout): DisplayFrame[] {
  const row = layout.direction === 'row'
  const span = Math.max(...layout.sizes.map((s) => (row ? s.height : s.width)), 0)
  let at = 0
  return layout.sizes.map((s) => {
    const own = row ? s.height : s.width
    const off = layout.align === 'start' ? 0 : layout.align === 'end' ? span - own : Math.round((span - own) / 2)
    const frame: DisplayFrame = row ? { x: at, y: off, width: s.width, height: s.height } : { x: off, y: at, width: s.width, height: s.height }
    at += row ? s.width : s.height
    return frame
  })
}

/** "1800x1169, 5120 × 1440" → sizes; null when it is not a list of sizes. */
export function parseSizes(text: string): { width: number; height: number }[] | null {
  const found = [...text.matchAll(/(\d{3,5})\s*[x×*]\s*(\d{3,5})/gi)]
  if (!found.length || found.length > MAX_DISPLAYS) return null
  const rest = text.replace(/(\d{3,5})\s*[x×*]\s*(\d{3,5})/gi, '').replace(/[\s,;/&+]|and/gi, '')
  if (rest) return null
  return found.map((m) => ({ width: Number(m[1]), height: Number(m[2]) }))
}

export function sizesText(sizes: { width: number; height: number }[]): string {
  return sizes.map((s) => `${s.width}×${s.height}`).join(', ')
}

const bounds = (frames: DisplayFrame[]): { x: number; y: number; width: number; height: number } => {
  const x = Math.min(...frames.map((f) => f.x))
  const y = Math.min(...frames.map((f) => f.y))
  return { x, y, width: Math.max(...frames.map((f) => f.x + f.width)) - x, height: Math.max(...frames.map((f) => f.y + f.height)) - y }
}

/**
 * Places displays on the screen picture. The picture is the displays' union, in points or at a whole-number multiple
 * of them (a Retina picture); anything whose proportions do not agree with the picture is refused, since cropping to
 * a wrong rectangle is worse than showing everything.
 */
export function resolveDisplays(frames: DisplayFrame[] | null | undefined, picture: { width: number; height: number }): Resolved {
  if (!frames?.length) return { displays: [] }
  if (!picture.width || !picture.height) return { displays: [] }
  const ordered = readingOrder(frames)
  const u = bounds(ordered)
  const sx = picture.width / u.width
  const sy = picture.height / u.height
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || Math.abs(sx - sy) > TOLERANCE * Math.max(sx, sy)) {
    return { displays: [], problem: `These displays add up to ${Math.round(u.width)}×${Math.round(u.height)}, but the screen picture is ${picture.width}×${picture.height}.` }
  }
  const s = (sx + sy) / 2
  const displays = ordered.map((f, i): DisplayRegion => {
    const x = Math.max(0, Math.round((f.x - u.x) * s))
    const y = Math.max(0, Math.round((f.y - u.y) * s))
    return {
      id: i,
      name: f.label?.trim() ? f.label.trim() : `Display ${i + 1}`,
      x,
      y,
      width: Math.min(picture.width - x, Math.round(f.width * s)),
      height: Math.min(picture.height - y, Math.round(f.height * s)),
      points: { width: Math.round(f.width), height: Math.round(f.height) }
    }
  })
  return { displays }
}

/** The layout to use: this machine's displays when they fit the picture, else what the user described. */
export function chooseDisplays(info: DisplayInfo | null, picture: { width: number; height: number }): Resolved {
  if (!info) return { displays: [] }
  const auto = resolveDisplays(info.auto, picture)
  if (auto.displays.length > 1) return auto
  const saved = info.saved ? resolveDisplays(layoutFromSizes(info.saved), picture) : { displays: [] }
  if (saved.displays.length) return saved
  return { displays: [], problem: saved.problem ?? auto.problem }
}

export type ScaleKind = 'fit' | 'fill' | 'actual'

/**
 * The zoom that shows `size` (the picture, or one display of it) as asked, relative to the picture fitted to the
 * layer. `k` is the fitted picture's CSS pixels per picture pixel, so one picture pixel per CSS pixel is 1 / k.
 */
export function viewScale(kind: ScaleKind, k: number, layer: { width: number; height: number }, size: { width: number; height: number }, max = 16): number {
  if (!k || !size.width || !size.height) return 1
  const fit = Math.min(layer.width / (size.width * k), layer.height / (size.height * k))
  const fill = Math.max(layer.width / (size.width * k), layer.height / (size.height * k))
  const scale = kind === 'fit' ? fit : kind === 'fill' ? fill : 1 / k
  return Math.max(1, Math.min(max, scale))
}

/**
 * Display selection for the screen tab. A Mac's Screen Sharing sends every display as one wide picture, so showing a
 * single display means cropping that picture to where the display sits. Where each one sits comes from public sources
 * only: this machine's own displays when the app runs on the Mac being shared (Electron's screen list), or sizes the
 * user types once (read from System Settings → Displays), arranged side by side or stacked. Either is checked against
 * the picture's real size before it is used. Pure, tested in tests/displays.test.ts.
 *
 * Two shapes of picture are recognised. Displays of one pixel density come as the layout in points, or that layout
 * scaled (a Retina picture is the same layout doubled). Displays of mixed density come each at its own native pixels,
 * edge to edge in the order they sit, with the offset across the row in points: measured on a Mac with a 1800×1169
 * Retina display (2×) left of a 5120×1440 one (1×) placed 130 points higher, whose picture was 8720×2468
 * (3600 + 5120 wide; 130 + 2338 high). The offset's scale is not assumed: each candidate is tried and only one that
 * reproduces the picture's exact size is used.
 */

/** One display in points, top-left origin, as the Mac arranges them. */
export interface DisplayFrame {
  x: number
  y: number
  width: number
  height: number
  label?: string
  primary?: boolean
  /** Device pixels per point (2 for Retina); absent when unknown. */
  scale?: number
}

/** What the user typed to describe the displays: sizes in reading order and how they are arranged. */
export interface DisplayLayout {
  sizes: { width: number; height: number; scale?: number }[]
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
  /** Counted as macOS counts them: the main display is 1, the others follow left to right. */
  number: number
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
    const frame: DisplayFrame = row ? { x: at, y: off, width: s.width, height: s.height, scale: s.scale } : { x: off, y: at, width: s.width, height: s.height, scale: s.scale }
    at += row ? s.width : s.height
    return frame
  })
}

const SIZE = /(\d{3,5})\s*[x×*]\s*(\d{3,5})(?:\s*@\s*([1-4](?:\.\d+)?)\s*x)?/gi

/** "1800x1169@2x, 5120 × 1440" → sizes (a Retina display marked @2x); null when it is not a list of sizes. */
export function parseSizes(text: string): { width: number; height: number; scale?: number }[] | null {
  const found = [...text.matchAll(SIZE)]
  if (!found.length || found.length > MAX_DISPLAYS) return null
  const rest = text.replace(SIZE, '').replace(/[\s,;/&+]|and/gi, '')
  if (rest) return null
  return found.map((m) => (m[3] && Number(m[3]) !== 1 ? { width: Number(m[1]), height: Number(m[2]), scale: Number(m[3]) } : { width: Number(m[1]), height: Number(m[2]) }))
}

export function sizesText(sizes: { width: number; height: number; scale?: number }[]): string {
  return sizes.map((s) => `${s.width}×${s.height}${s.scale && s.scale !== 1 ? `@${s.scale}x` : ''}`).join(', ')
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
  const r = placeDisplays(frames, picture)
  // Main display first, then left to right (reading order is the regions' own order).
  const order = [...r.displays].sort((a, b) => Number(!!b.primary) - Number(!!a.primary) || a.id - b.id)
  return { ...r, displays: r.displays.map(({ primary: _p, ...d }) => ({ ...d, number: order.findIndex((o) => o.id === d.id) + 1 })) }
}

function placeDisplays(frames: DisplayFrame[] | null | undefined, picture: { width: number; height: number }): { displays: (DisplayRegion & { primary?: boolean })[]; problem?: string } {
  if (!frames?.length) return { displays: [] }
  if (!picture.width || !picture.height) return { displays: [] }
  // Known, differing scales: the native shape first, since a whole-picture scale can match it by coincidence.
  const mixed = frames.every((f) => f.scale) && new Set(frames.map((f) => f.scale)).size > 1
  const native = mixed ? nativeDisplays(frames, picture) : null
  if (native) return { displays: native }
  const uniform = uniformDisplays(frames, picture)
  if (uniform.displays.length || mixed) return uniform
  const fallback = nativeDisplays(frames, picture)
  return fallback ? { displays: fallback } : uniform
}

/** Displays of mixed density, each at its own pixels, edge to edge in a row or a column (see the note at the top). */
function nativeDisplays(frames: DisplayFrame[], picture: { width: number; height: number }): (DisplayRegion & { primary?: boolean })[] | null {
  if (frames.length < 2 || frames.some((f) => !f.scale || f.scale <= 0)) return null
  const byX = [...frames].sort((a, b) => a.x - b.x || a.y - b.y)
  const byY = [...frames].sort((a, b) => a.y - b.y || a.x - b.x)
  const row = byX.every((f, i) => i === 0 || f.x >= byX[i - 1].x + byX[i - 1].width - 1)
  const column = !row && byY.every((f, i) => i === 0 || f.y >= byY[i - 1].y + byY[i - 1].height - 1)
  if (!row && !column) return null
  const list = row ? byX : byY
  const px = list.map((f) => ({ w: Math.round(f.width * f.scale!), h: Math.round(f.height * f.scale!) }))
  const along = (p: { w: number; h: number }): number => (row ? p.w : p.h)
  const across = (p: { w: number; h: number }): number => (row ? p.h : p.w)
  const pictureAlong = row ? picture.width : picture.height
  const pictureAcross = row ? picture.height : picture.width
  // The displays' own pixels end to end must be the picture exactly: this is what tells mixed density apart.
  if (Math.abs(px.reduce((n, p) => n + along(p), 0) - pictureAlong) > 2) return null
  const start = Math.min(...list.map((f) => (row ? f.y : f.x)))
  const factors = [...new Set([1, ...list.map((f) => f.scale!)])]
  // The offset across: the factor that reproduces the picture exactly, else (a typed layout, whose alignment is only
  // approximate) the closest within 1.5%, with each display then kept inside the picture.
  let best: { offsets: number[]; error: number } | null = null
  for (const k of factors) {
    const offsets = list.map((f) => Math.round(((row ? f.y : f.x) - start) * k))
    const extent = Math.max(...offsets.map((o, i) => o + across(px[i])))
    const error = Math.abs(extent - pictureAcross)
    if (!best || error < best.error) best = { offsets, error }
  }
  if (!best || best.error > Math.max(2, pictureAcross * 0.015)) return null
  let at = 0
  return list.map((f, i) => {
    const off = Math.max(0, Math.min(best!.offsets[i], pictureAcross - across(px[i])))
    const region: DisplayRegion & { primary?: boolean } = {
      id: i,
      name: f.label?.trim() ? f.label.trim() : `Display ${i + 1}`,
      number: 0,
      primary: f.primary,
      ...(row ? { x: at, y: off, width: px[i].w, height: Math.min(px[i].h, picture.height) } : { x: off, y: at, width: Math.min(px[i].w, picture.width), height: px[i].h }),
      points: { width: Math.round(f.width), height: Math.round(f.height) }
    }
    at += along(px[i])
    return region
  })
}

/** Displays of one density: the layout in points, or the same layout scaled as a whole. */
function uniformDisplays(frames: DisplayFrame[], picture: { width: number; height: number }): { displays: (DisplayRegion & { primary?: boolean })[]; problem?: string } {
  const ordered = readingOrder(frames)
  const u = bounds(ordered)
  const sx = picture.width / u.width
  const sy = picture.height / u.height
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || Math.abs(sx - sy) > TOLERANCE * Math.max(sx, sy)) {
    return { displays: [], problem: `These displays add up to ${Math.round(u.width)}×${Math.round(u.height)}, but the screen picture is ${picture.width}×${picture.height}.` }
  }
  const s = (sx + sy) / 2
  const displays = ordered.map((f, i): DisplayRegion & { primary?: boolean } => {
    const x = Math.max(0, Math.round((f.x - u.x) * s))
    const y = Math.max(0, Math.round((f.y - u.y) * s))
    return {
      id: i,
      name: f.label?.trim() ? f.label.trim() : `Display ${i + 1}`,
      number: 0,
      primary: f.primary,
      x,
      y,
      width: Math.min(picture.width - x, Math.round(f.width * s)),
      height: Math.min(picture.height - y, Math.round(f.height * s)),
      points: { width: Math.round(f.width), height: Math.round(f.height) }
    }
  })
  return { displays }
}

/** The display (of several) that alone makes up the picture, at a whole or Retina scale: the Mac shares only it. */
export function soleDisplay(frames: DisplayFrame[] | null | undefined, picture: { width: number; height: number }): DisplayFrame | null {
  if (!frames || frames.length < 2 || !picture.width || !picture.height) return null
  return frames.find((f) => {
    const sx = picture.width / f.width
    const sy = picture.height / f.height
    return Math.abs(sx - sy) <= TOLERANCE * Math.max(sx, sy) && Math.abs(sx - Math.round(sx)) < 0.02 && Math.round(sx) >= 1
  }) ?? null
}

/** The layout to use: this machine's displays when they fit the picture, else what the user described. */
export function chooseDisplays(info: DisplayInfo | null, picture: { width: number; height: number }): Resolved {
  if (!info) return { displays: [] }
  const auto = resolveDisplays(info.auto, picture)
  if (auto.displays.length > 1) return auto
  const saved = info.saved ? resolveDisplays(layoutFromSizes(info.saved), picture) : { displays: [] }
  if (saved.displays.length) return saved
  const only = soleDisplay(info.auto, picture)
  if (only) return { displays: [], problem: `This Mac is sending only ${only.label ?? 'one display'} (${picture.width}×${picture.height}), not all of its displays.` }
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

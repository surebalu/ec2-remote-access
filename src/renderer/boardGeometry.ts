/**
 * Geometry of the whiteboard (components/board), free of the DOM so tests can load it: bounds, hit testing, moving
 * and resizing, snapping, arrowheads, the view's pan and zoom, and wrapping a sticky note's text.
 */
import type { BoardItem } from '@shared/types'

export interface Pt { x: number; y: number }
export interface Box { x: number; y: number; w: number; h: number }
export interface View { x: number; y: number; zoom: number }

export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 8

export function boxOf(a: Pt, b: Pt): Box {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }
}

export function boundsOfPoints(points: number[][]): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of points) {
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (x > x1) x1 = x
    if (y > y1) y1 = y
  }
  return points.length ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 0, h: 0 }
}

/** The item's box, grown by half its stroke so selection outlines sit outside the ink. */
export function itemBounds(it: BoardItem): Box {
  const pad = it.type === 'pen' || it.type === 'highlighter' || it.type === 'line' || it.type === 'arrow' ? it.width / 2 + (it.type === 'arrow' ? it.width * 2 : 0) : 0
  return { x: it.x - pad, y: it.y - pad, w: it.w + 2 * pad, h: it.h + 2 * pad }
}

export function unionBounds(items: BoardItem[]): Box | null {
  if (!items.length) return null
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const it of items) {
    const b = itemBounds(it)
    x0 = Math.min(x0, b.x)
    y0 = Math.min(y0, b.y)
    x1 = Math.max(x1, b.x + b.w)
    y1 = Math.max(y1, b.y + b.h)
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = dx * dx + dy * dy
  const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

const inBox = (p: Pt, b: Box, pad = 0): boolean => p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad

/** Whether a point (board units) touches an item: its ink, its outline, or its inside when it is filled or a box. */
export function hitItem(it: BoardItem, p: Pt, tolerance: number): boolean {
  const reach = tolerance + it.width / 2
  if (!inBox(p, it, reach + (it.type === 'highlighter' ? it.width * 2 : 0))) return false
  switch (it.type) {
    case 'pen':
    case 'highlighter':
    case 'line':
    case 'arrow': {
      const pts = it.points ?? []
      const r = it.type === 'highlighter' ? reach + it.width * 2 : reach
      if (pts.length === 1) return Math.hypot(p.x - pts[0][0], p.y - pts[0][1]) <= r
      for (let i = 1; i < pts.length; i++) {
        if (distToSegment(p, { x: pts[i - 1][0], y: pts[i - 1][1] }, { x: pts[i][0], y: pts[i][1] }) <= r) return true
      }
      return false
    }
    case 'rect': {
      if (it.fill && it.fill !== 'none') return true
      const nearX = Math.min(Math.abs(p.x - it.x), Math.abs(p.x - (it.x + it.w))) <= reach
      const nearY = Math.min(Math.abs(p.y - it.y), Math.abs(p.y - (it.y + it.h))) <= reach
      return nearX || nearY
    }
    case 'ellipse': {
      const rx = it.w / 2
      const ry = it.h / 2
      if (!rx || !ry) return false
      const nx = (p.x - (it.x + rx)) / rx
      const ny = (p.y - (it.y + ry)) / ry
      const d = Math.sqrt(nx * nx + ny * ny)
      if (it.fill && it.fill !== 'none') return d <= 1 + reach / Math.min(rx, ry)
      return Math.abs(d - 1) * Math.min(rx, ry) <= reach
    }
    case 'diamond': {
      const cx = it.x + it.w / 2
      const cy = it.y + it.h / 2
      const d = Math.abs(p.x - cx) / (it.w / 2 || 1) + Math.abs(p.y - cy) / (it.h / 2 || 1)
      if (it.fill && it.fill !== 'none') return d <= 1 + reach / Math.min(it.w, it.h)
      return Math.abs(d - 1) * Math.min(it.w, it.h) / 2 <= reach
    }
    default:
      return inBox(p, it, tolerance)
  }
}

/** The topmost item at a point. */
export function topItemAt(items: BoardItem[], p: Pt, tolerance: number): BoardItem | null {
  for (let i = items.length - 1; i >= 0; i--) if (hitItem(items[i], p, tolerance)) return items[i]
  return null
}

/** Items a selection rectangle touches. */
export function itemsInBox(items: BoardItem[], box: Box): string[] {
  return items.filter((it) => {
    const b = itemBounds(it)
    return b.x <= box.x + box.w && b.x + b.w >= box.x && b.y <= box.y + box.h && b.y + b.h >= box.y
  }).map((it) => it.id)
}

export function moveItem(it: BoardItem, dx: number, dy: number): BoardItem {
  return { ...it, x: it.x + dx, y: it.y + dy, points: it.points?.map(([x, y, p]) => (p === undefined ? [x + dx, y + dy] : [x + dx, y + dy, p])) }
}

/** Maps an item from one box to another (resizing a selection): positions, sizes and points scale together. */
export function scaleItem(it: BoardItem, from: Box, to: Box): BoardItem {
  const sx = from.w ? to.w / from.w : 1
  const sy = from.h ? to.h / from.h : 1
  const mx = (x: number): number => to.x + (x - from.x) * sx
  const my = (y: number): number => to.y + (y - from.y) * sy
  const out: BoardItem = { ...it, x: mx(it.x), y: my(it.y), w: it.w * sx, h: it.h * sy }
  if (it.points) out.points = it.points.map(([x, y, p]) => (p === undefined ? [mx(x), my(y)] : [mx(x), my(y), p]))
  if (it.type === 'text' && it.fontSize) out.fontSize = Math.max(6, it.fontSize * Math.min(sx, sy))
  return out
}

/** Shift while drawing a line: the nearest 45° direction. */
export function snapAngle(a: Pt, b: Pt): Pt {
  const len = Math.hypot(b.x - a.x, b.y - a.y)
  const angle = Math.round(Math.atan2(b.y - a.y, b.x - a.x) / (Math.PI / 4)) * (Math.PI / 4)
  return { x: a.x + Math.cos(angle) * len, y: a.y + Math.sin(angle) * len }
}

/** Shift while drawing a shape: a square (or circle) from the start corner. */
export function squareFrom(a: Pt, b: Pt): Pt {
  const s = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))
  return { x: a.x + Math.sign(b.x - a.x || 1) * s, y: a.y + Math.sign(b.y - a.y || 1) * s }
}

/** The triangle at an arrow's end, sized to its stroke. */
export function arrowHead(from: Pt, to: Pt, width: number): Pt[] {
  const size = Math.max(10, width * 3.5)
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  const spread = Math.PI / 7
  return [
    to,
    { x: to.x - size * Math.cos(angle - spread), y: to.y - size * Math.sin(angle - spread) },
    { x: to.x - size * Math.cos(angle + spread), y: to.y - size * Math.sin(angle + spread) }
  ]
}

export const toBoard = (p: Pt, v: View): Pt => ({ x: (p.x - v.x) / v.zoom, y: (p.y - v.y) / v.zoom })
export const toScreen = (p: Pt, v: View): Pt => ({ x: p.x * v.zoom + v.x, y: p.y * v.zoom + v.y })

/** Zooms by `factor` keeping the board point under the screen point `at` where it is. */
export function zoomAt(v: View, at: Pt, factor: number): View {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor))
  const b = toBoard(at, v)
  return { zoom, x: at.x - b.x * zoom, y: at.y - b.y * zoom }
}

/** The view that shows `box` in a viewport of `size`, with a margin, never zoomed in past 100%. */
export function fitView(box: Box | null, size: { w: number; h: number }, margin = 60): View {
  if (!box || !box.w || !box.h) return { x: size.w / 2 - (box?.x ?? 0), y: size.h / 2 - (box?.y ?? 0), zoom: 1 }
  const zoom = Math.max(MIN_ZOOM, Math.min(1, (size.w - 2 * margin) / box.w, (size.h - 2 * margin) / box.h))
  return { zoom, x: (size.w - box.w * zoom) / 2 - box.x * zoom, y: (size.h - box.h * zoom) / 2 - box.y * zoom }
}

/** Word-wraps text into lines no wider than `width` (as `measure` reports), keeping the user's own line breaks. */
export function wrapText(text: string, width: number, measure: (s: string) => number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    const words = para.split(/(\s+)/)
    let line = ''
    for (const w of words) {
      if (!w) continue
      const next = line + w
      if (line && !/^\s+$/.test(w) && measure(next) > width) {
        out.push(line.trimEnd())
        line = w
      } else line = next
    }
    out.push(line.trimEnd())
  }
  return out
}

/** SVG path data for a closed outline (perfect-freehand's stroke polygon), smoothed with quadratic curves. */
export function outlinePath(outline: number[][]): string {
  if (!outline.length) return ''
  const d = [`M ${outline[0][0].toFixed(2)} ${outline[0][1].toFixed(2)} Q`]
  for (let i = 0; i < outline.length; i++) {
    const [x0, y0] = outline[i]
    const [x1, y1] = outline[(i + 1) % outline.length]
    d.push(`${x0.toFixed(2)} ${y0.toFixed(2)} ${((x0 + x1) / 2).toFixed(2)} ${((y0 + y1) / 2).toFixed(2)}`)
  }
  d.push('Z')
  return d.join(' ')
}

/**
 * Split panes as a tree (PaneNode), for a Terminal tab's panes and for the app's side-by-side view of tabs: splitting,
 * docking, closing, resizing, and finding the pane in a direction. Pure, so tests load it directly. The renderer draws
 * every pane absolutely from `layoutRects`, so a pane never moves in the DOM when the tree changes (a remount would
 * throw a terminal's scrollback away and reload a web page).
 */
import type { PaneNode } from '@shared/types'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** A draggable border between child `index` and `index + 1` of the split at `path` (child indexes from the root). */
export interface Divider {
  path: number[]
  index: number
  dir: 'row' | 'column'
  /** Where the border is, and the extent of the split it resizes (for turning pixels into shares). */
  at: number
  span: Rect
}

export type Direction = 'left' | 'right' | 'up' | 'down'

const MIN_SHARE = 0.08

export function paneIds(node: PaneNode): string[] {
  return node.type === 'pane' ? [node.id] : node.children.flatMap(paneIds)
}

/** Splits pane `target`, putting `id` after it; a split in the same direction gets another child instead of nesting. */
export function splitPane(root: PaneNode, target: string, id: string, dir: 'row' | 'column'): PaneNode {
  return insertPane(root, target, id, dir === 'row' ? 'right' : 'down')
}

/** Puts pane `id` on one side of pane `target`: into the split around it when that runs the same way, else nested. */
export function insertPane(root: PaneNode, target: string, id: string, side: Direction): PaneNode {
  const dir = side === 'left' || side === 'right' ? 'row' : 'column'
  const before = side === 'left' || side === 'up'
  const fresh: PaneNode = { type: 'pane', id }
  const visit = (node: PaneNode): PaneNode => {
    if (node.type === 'pane') {
      return node.id === target ? { type: 'split', dir, children: before ? [fresh, node] : [node, fresh], sizes: [0.5, 0.5] } : node
    }
    const at = node.children.findIndex((c) => c.type === 'pane' && c.id === target)
    if (at >= 0 && node.dir === dir) {
      const half = node.sizes[at] / 2
      const i = before ? at : at + 1
      const children = [...node.children.slice(0, i), fresh, ...node.children.slice(i)]
      const sizes = [...node.sizes.slice(0, at), half, half, ...node.sizes.slice(at + 1)]
      return { ...node, children, sizes }
    }
    return { ...node, children: node.children.map(visit) }
  }
  return visit(root)
}

/** Panes `a` and `b` trade places; when only one of them is in the tree, the other takes its place. */
export function swapPanes(root: PaneNode, a: string, b: string): PaneNode {
  if (root.type === 'pane') return root.id === a ? { type: 'pane', id: b } : root.id === b ? { type: 'pane', id: a } : root
  return { ...root, children: root.children.map((c) => swapPanes(c, a, b)) }
}

/** The tree without pane `id` (its share goes to its neighbour); null when it was the only pane. */
export function removePane(root: PaneNode, id: string): PaneNode | null {
  if (root.type === 'pane') return root.id === id ? null : root
  const at = root.children.findIndex((c) => c.type === 'pane' && c.id === id)
  if (at >= 0) {
    const children = root.children.filter((_, i) => i !== at)
    const sizes = root.sizes.filter((_, i) => i !== at)
    sizes[Math.max(0, at - 1)] += root.sizes[at]
    return children.length === 1 ? children[0] : { ...root, children, sizes }
  }
  const children = root.children.map((c) => removePane(c, id)).filter((c): c is PaneNode => c !== null)
  return children.length === 1 ? children[0] : { ...root, children }
}

/** Every pane's rectangle and every divider, in fractions of `rect` (the whole tab by default). */
export function layoutRects(root: PaneNode, rect: Rect = { x: 0, y: 0, w: 1, h: 1 }): { panes: Record<string, Rect>; dividers: Divider[] } {
  const panes: Record<string, Rect> = {}
  const dividers: Divider[] = []
  const visit = (node: PaneNode, r: Rect, path: number[]): void => {
    if (node.type === 'pane') {
      panes[node.id] = r
      return
    }
    let offset = 0
    node.children.forEach((child, i) => {
      const share = node.sizes[i]
      const cr = node.dir === 'row' ? { x: r.x + offset * r.w, y: r.y, w: share * r.w, h: r.h } : { x: r.x, y: r.y + offset * r.h, w: r.w, h: share * r.h }
      offset += share
      visit(child, cr, [...path, i])
      if (i < node.children.length - 1) dividers.push({ path, index: i, dir: node.dir, at: node.dir === 'row' ? r.x + offset * r.w : r.y + offset * r.h, span: r })
    })
  }
  visit(root, rect, [])
  return { panes, dividers }
}

/** Moves the border `index` of the split at `path` by `delta` (a fraction of that split), keeping both sides usable. */
export function resizeSplit(root: PaneNode, path: number[], index: number, delta: number): PaneNode {
  if (path.length) {
    if (root.type !== 'split') return root
    const [head, ...rest] = path
    return { ...root, children: root.children.map((c, i) => (i === head ? resizeSplit(c, rest, index, delta) : c)) }
  }
  if (root.type !== 'split') return root
  const sizes = root.sizes.slice()
  const pair = sizes[index] + sizes[index + 1]
  const a = Math.min(pair - MIN_SHARE, Math.max(MIN_SHARE, sizes[index] + delta))
  sizes[index] = a
  sizes[index + 1] = pair - a
  return { ...root, sizes }
}

/** The split at `path` with every child the same size again (double-clicking its border). */
export function equalize(root: PaneNode, path: number[] = []): PaneNode {
  if (root.type !== 'split') return root
  if (path.length) {
    const [head, ...rest] = path
    return { ...root, children: root.children.map((c, i) => (i === head ? equalize(c, rest) : c)) }
  }
  return { ...root, sizes: root.children.map(() => 1 / root.children.length) }
}

/** The pane next to `from` in a direction: touching its edge, with the most overlap. */
export function neighbor(root: PaneNode, from: string, dir: Direction): string | null {
  const { panes } = layoutRects(root)
  const a = panes[from]
  if (!a) return null
  const eps = 1e-6
  let best: string | null = null
  let bestOverlap = 0
  for (const [id, b] of Object.entries(panes)) {
    if (id === from) continue
    const touches =
      dir === 'right' ? Math.abs(b.x - (a.x + a.w)) < eps
        : dir === 'left' ? Math.abs(b.x + b.w - a.x) < eps
          : dir === 'down' ? Math.abs(b.y - (a.y + a.h)) < eps
            : Math.abs(b.y + b.h - a.y) < eps
    if (!touches) continue
    const overlap = dir === 'left' || dir === 'right'
      ? Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
      : Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
    if (overlap > bestOverlap + eps) {
      best = id
      bestOverlap = overlap
    }
  }
  return best
}

/** Ready-made layouts for a Terminal tab, by how many panes they show. */
export type Preset = 'single' | 'columns' | 'rows' | 'main' | 'grid'
export const PRESET_PANES: Record<Preset, number> = { single: 1, columns: 2, rows: 2, main: 3, grid: 4 }

/** A preset's tree over `ids` (in reading order: left to right, top to bottom); needs PRESET_PANES[kind] ids. */
export function presetLayout(kind: Preset, ids: string[]): PaneNode {
  const p = (i: number): PaneNode => ({ type: 'pane', id: ids[i] })
  const split = (dir: 'row' | 'column', children: PaneNode[]): PaneNode => ({ type: 'split', dir, children, sizes: children.map(() => 1 / children.length) })
  switch (kind) {
    case 'single': return p(0)
    case 'columns': return split('row', [p(0), p(1)])
    case 'rows': return split('column', [p(0), p(1)])
    case 'main': return split('row', [p(0), split('column', [p(1), p(2)])])
    case 'grid': return split('column', [split('row', [p(0), p(1)]), split('row', [p(2), p(3)])])
  }
}

/** Arrangements for any number of panes (the app's side-by-side view, unlike the fixed presets above). */
export type Arrangement = 'columns' | 'rows' | 'main' | 'grid'

/**
 * `ids` (in reading order) laid out side by side, stacked, the first one large with the rest stacked beside it, or in
 * rows of two (three from five panes up). Shares start equal, except the large pane's.
 */
export function arrange(kind: Arrangement, ids: string[]): PaneNode {
  const p = (id: string): PaneNode => ({ type: 'pane', id })
  const split = (dir: 'row' | 'column', children: PaneNode[], sizes?: number[]): PaneNode =>
    children.length === 1 ? children[0] : { type: 'split', dir, children, sizes: sizes ?? children.map(() => 1 / children.length) }
  if (ids.length < 2) return p(ids[0])
  switch (kind) {
    case 'columns': return split('row', ids.map(p))
    case 'rows': return split('column', ids.map(p))
    case 'main': return split('row', [p(ids[0]), split('column', ids.slice(1).map(p))], [0.6, 0.4])
    case 'grid': {
      const per = ids.length > 4 ? 3 : 2
      const rows: PaneNode[] = []
      for (let i = 0; i < ids.length; i += per) rows.push(split('row', ids.slice(i, i + per).map(p)))
      return split('column', rows)
    }
  }
}

/** Where something dropped at (x, y) over pane rectangle `r` goes: beside it on the nearest edge, or in its place in the middle. */
export function dockZone(r: Rect, x: number, y: number): Direction | 'center' {
  const fx = (x - r.x) / r.w
  const fy = (y - r.y) / r.h
  if (fx > 0.3 && fx < 0.7 && fy > 0.3 && fy < 0.7) return 'center'
  const gaps: Record<Direction, number> = { left: fx, right: 1 - fx, up: fy, down: 1 - fy }
  return (Object.keys(gaps) as Direction[]).reduce((a, b) => (gaps[b] < gaps[a] ? b : a))
}

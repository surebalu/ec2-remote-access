/**
 * Split panes of a Terminal tab as a tree (PaneNode): splitting, closing, resizing, and finding the pane in a
 * direction. Pure, so tests load it directly. The renderer draws every pane absolutely from `layoutRects`, so a
 * pane's terminal never moves in the DOM when the tree changes (a remount would throw its scrollback away).
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
  const visit = (node: PaneNode): PaneNode => {
    if (node.type === 'pane') {
      return node.id === target ? { type: 'split', dir, children: [node, { type: 'pane', id }], sizes: [0.5, 0.5] } : node
    }
    const at = node.children.findIndex((c) => c.type === 'pane' && c.id === target)
    if (at >= 0 && node.dir === dir) {
      const half = node.sizes[at] / 2
      const children = [...node.children.slice(0, at + 1), { type: 'pane', id } as PaneNode, ...node.children.slice(at + 1)]
      const sizes = [...node.sizes.slice(0, at), half, half, ...node.sizes.slice(at + 1)]
      return { ...node, children, sizes }
    }
    return { ...node, children: node.children.map(visit) }
  }
  return visit(root)
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

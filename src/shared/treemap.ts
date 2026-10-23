/**
 * The Space Map's layout: squarified treemaps (Bruls, Huizing and van Wijk), so each card is as close to square as
 * the sizes allow and big things read as big. Pure: tests/storage.test.ts.
 */

export interface Rect { x: number; y: number; w: number; h: number }

/**
 * Lays `items` out inside `box`, each with an area in proportion to its value, largest first. Items worth nothing are
 * left out. The rectangles fill the box exactly (up to rounding).
 */
export function squarify<T extends { value: number }>(items: readonly T[], box: Rect): { item: T; rect: Rect }[] {
  const total = items.reduce((s, i) => s + (i.value > 0 ? i.value : 0), 0)
  if (!total || box.w <= 0 || box.h <= 0) return []
  const scale = (box.w * box.h) / total
  const queue = items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value).map((item) => ({ item, area: item.value * scale }))
  const out: { item: T; rect: Rect }[] = []
  let { x, y, w, h } = box

  /** The worst aspect ratio in a row of areas summing to `sum`, laid along a side of `side`. */
  const worst = (sum: number, max: number, min: number, side: number): number => {
    const s2 = sum * sum
    const side2 = side * side
    return Math.max((side2 * max) / s2, s2 / (side2 * min))
  }
  const place = (row: { item: T; area: number }[]): void => {
    const sum = row.reduce((s, r) => s + r.area, 0)
    if (w >= h) {
      // A column down the left of what is left.
      const cw = h > 0 ? sum / h : 0
      let cy = y
      for (const r of row) { const rh = cw > 0 ? r.area / cw : 0; out.push({ item: r.item, rect: { x, y: cy, w: cw, h: rh } }); cy += rh }
      x += cw
      w -= cw
    } else {
      // A row across the top.
      const rh = w > 0 ? sum / w : 0
      let cx = x
      for (const r of row) { const rw = rh > 0 ? r.area / rh : 0; out.push({ item: r.item, rect: { x: cx, y, w: rw, h: rh } }); cx += rw }
      y += rh
      h -= rh
    }
  }

  let row: { item: T; area: number }[] = []
  let sum = 0
  let max = 0
  let min = Infinity
  for (let i = 0; i < queue.length;) {
    const next = queue[i]
    const side = Math.min(w, h)
    if (!row.length) { row = [next]; sum = next.area; max = next.area; min = next.area; i++; continue }
    const nextWorst = worst(sum + next.area, Math.max(max, next.area), Math.min(min, next.area), side)
    if (nextWorst <= worst(sum, max, min, side)) {
      row.push(next)
      sum += next.area
      max = Math.max(max, next.area)
      min = Math.min(min, next.area)
      i++
    } else {
      place(row)
      row = []
    }
  }
  if (row.length) place(row)
  return out
}

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { BoardItem } from '../src/shared/types.ts'
import { arrowHead, boxOf, fitView, hitItem, itemsInBox, moveItem, outlinePath, scaleItem, snapAngle, squareFrom, toBoard, toScreen, topItemAt, unionBounds, wrapText, zoomAt } from '../src/renderer/boardGeometry.ts'

const item = (o: Partial<BoardItem>): BoardItem => ({ id: 'i', type: 'rect', x: 0, y: 0, w: 100, h: 50, color: 'ink', width: 4, ...o })

test('hitting shapes: outlines unless filled, ink along a stroke, boxes inside', () => {
  const rect = item({})
  assert.equal(hitItem(rect, { x: 50, y: 1 }, 4), true, 'on the top edge')
  assert.equal(hitItem(rect, { x: 50, y: 25 }, 4), false, 'inside an outline')
  assert.equal(hitItem({ ...rect, fill: 'tint' }, { x: 50, y: 25 }, 4), true, 'inside a filled one')
  const ellipse = item({ type: 'ellipse', w: 100, h: 100 })
  assert.equal(hitItem(ellipse, { x: 50, y: 1 }, 4), true)
  assert.equal(hitItem(ellipse, { x: 50, y: 50 }, 4), false)
  const pen = item({ type: 'pen', x: 0, y: 0, w: 100, h: 0, points: [[0, 0, 0.5], [100, 0, 0.5]] })
  assert.equal(hitItem(pen, { x: 50, y: 3 }, 2), true)
  assert.equal(hitItem(pen, { x: 50, y: 20 }, 2), false)
  const note = item({ id: 'n', type: 'note', x: 200, y: 0, w: 100, h: 100 })
  assert.equal(topItemAt([rect, note], { x: 250, y: 50 }, 2)?.id, 'n')
  assert.equal(topItemAt([rect, note], { x: 500, y: 500 }, 2), null)
})

test('a selection box takes what it touches; moving and resizing move ink with the box', () => {
  const a = item({ id: 'a' })
  const b = item({ id: 'b', x: 300, y: 300 })
  assert.deepEqual(itemsInBox([a, b], { x: 90, y: 40, w: 20, h: 20 }), ['a'])
  const pen = item({ type: 'pen', x: 10, y: 10, w: 10, h: 10, points: [[10, 10, 0.5], [20, 20, 0.5]] })
  assert.deepEqual(moveItem(pen, 5, -5).points, [[15, 5, 0.5], [25, 15, 0.5]])
  const scaled = scaleItem(pen, { x: 10, y: 10, w: 10, h: 10 }, { x: 0, y: 0, w: 20, h: 20 })
  assert.deepEqual(scaled.points, [[0, 0, 0.5], [20, 20, 0.5]])
  assert.deepEqual([scaled.x, scaled.y, scaled.w, scaled.h], [0, 0, 20, 20])
  const u = unionBounds([a, b])!
  assert.deepEqual([u.x, u.y, u.x + u.w, u.y + u.h], [0, 0, 400, 350])
})

test('shift snaps lines to 45° and shapes to squares; arrowheads point along the line', () => {
  const s = snapAngle({ x: 0, y: 0 }, { x: 100, y: 8 })
  assert.equal(Math.round(s.y), 0)
  assert.equal(Math.round(s.x), 100)
  assert.deepEqual(squareFrom({ x: 0, y: 0 }, { x: 40, y: -10 }), { x: 40, y: -40 })
  const head = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 4)
  assert.deepEqual(head[0], { x: 100, y: 0 })
  assert.ok(head[1].x < 100 && head[2].x < 100 && Math.sign(head[1].y) === -Math.sign(head[2].y), 'the wings sit behind the tip, one on each side')
  assert.deepEqual(boxOf({ x: 10, y: 50 }, { x: 0, y: 0 }), { x: 0, y: 0, w: 10, h: 50 })
})

test('zooming keeps the point under the cursor; fitting shows everything', () => {
  const v = { x: 0, y: 0, zoom: 1 }
  const z = zoomAt(v, { x: 200, y: 100 }, 2)
  assert.deepEqual(toBoard({ x: 200, y: 100 }, z), toBoard({ x: 200, y: 100 }, v))
  assert.deepEqual(toScreen(toBoard({ x: 33, y: 44 }, z), z), { x: 33, y: 44 })
  assert.equal(zoomAt(v, { x: 0, y: 0 }, 1000).zoom, 8)
  const f = fitView({ x: 0, y: 0, w: 2000, h: 1000 }, { w: 1000, h: 600 })
  assert.ok(f.zoom < 1)
  const tl = toScreen({ x: 0, y: 0 }, f)
  const br = toScreen({ x: 2000, y: 1000 }, f)
  assert.ok(tl.x >= 59 && br.x <= 941 && tl.y >= 0 && br.y <= 600)
})

test('sticky note text wraps at words and keeps line breaks', () => {
  const measure = (s: string): number => s.length * 10
  assert.deepEqual(wrapText('one two three four', 90, measure), ['one two', 'three', 'four'])
  assert.deepEqual(wrapText('a\nb c', 1000, measure), ['a', 'b c'])
  assert.deepEqual(wrapText('', 100, measure), [''])
  assert.match(outlinePath([[0, 0], [10, 0], [10, 10]]), /^M 0\.00 0\.00 Q .* Z$/)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { areaFrame, displayOf, displayOrder, layoutById, layoutFrame, sameFrame, SUGGESTED_WINDOW_KEYS, WINDOW_LAYOUTS, type Rect } from '../src/shared/windowLayouts.ts'

// A 55-inch 4K display at "looks like 3840 × 2160", with a 25-point menu bar; a laptop to its left, lower down.
const BIG: Rect = { x: 0, y: 25, w: 3840, h: 2135 }
const LAPTOP: Rect = { x: -1728, y: 400, w: 1728, h: 1080 }
const at = (id: string, win: Rect, displays = [BIG], gap = 0): Rect | null => layoutFrame(layoutById(id)!, win, displays, gap)
const WIN: Rect = { x: 300, y: 200, w: 1200, h: 800 }

test('every layout has a unique id and a name, and areas stay inside the screen', () => {
  const ids = WINDOW_LAYOUTS.map((l) => l.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const l of WINDOW_LAYOUTS) {
    assert.ok(l.name && (l.area || l.op), l.id)
    if (l.area) assert.ok(l.area.x >= 0 && l.area.y >= 0 && l.area.x + l.area.w <= 1 + 1e-9 && l.area.y + l.area.h <= 1 + 1e-9, l.id)
  }
  for (const id of Object.keys(SUGGESTED_WINDOW_KEYS)) assert.ok(layoutById(id), id)
  assert.equal(WINDOW_LAYOUTS.filter((l) => l.group === 'Ninths').length, 9)
  assert.equal(WINDOW_LAYOUTS.filter((l) => l.group === 'Twelfths').length, 12)
  assert.equal(layoutById('middle-center-ninth')?.name, 'Middle Center Ninth')
  assert.equal(layoutById('top-left-quarter')?.name, 'Top Left Quarter')
})

test('halves, thirds and ninths of a large screen', () => {
  assert.deepEqual(at('left-half', WIN), { x: 0, y: 25, w: 1920, h: 2135 })
  assert.deepEqual(at('right-half', WIN), { x: 1920, y: 25, w: 1920, h: 2135 })
  assert.deepEqual(at('center-third', WIN), { x: 1280, y: 25, w: 1280, h: 2135 })
  assert.deepEqual(at('last-two-thirds', WIN), { x: 1280, y: 25, w: 2560, h: 2135 })
  assert.deepEqual(at('bottom-right-ninth', WIN), { x: 2560, y: 25 + Math.round(2135 * 2 / 3), w: 1280, h: 2135 - Math.round(2135 * 2 / 3) })
  assert.deepEqual(at('second-fourth', WIN), { x: 960, y: 25, w: 960, h: 2135 })
})

test('a gap is whole at the screen edge and split between neighbours', () => {
  const left = areaFrame({ x: 0, y: 0, w: 0.5, h: 1 }, BIG, 10)
  const right = areaFrame({ x: 0.5, y: 0, w: 0.5, h: 1 }, BIG, 10)
  assert.deepEqual(left, { x: 10, y: 35, w: 1905, h: 2115 })
  assert.equal(right.x - (left.x + left.w), 10)
  assert.equal(right.x + right.w, 3830)
})

test('size operations', () => {
  assert.deepEqual(at('maximize', WIN), BIG)
  assert.deepEqual(at('center', WIN), { x: 1320, y: 25 + 668, w: 1200, h: 800 })
  const almost = at('almost-maximize', WIN)!
  assert.equal(almost.w, Math.round(3840 * 0.9))
  assert.deepEqual(at('maximize-height', WIN), { x: 300, y: 25, w: 1200, h: 2135 })
  const larger = at('make-larger', WIN)!
  assert.ok(larger.w > WIN.w && larger.h > WIN.h)
  assert.ok(Math.abs(larger.x + larger.w / 2 - (WIN.x + WIN.w / 2)) <= 1, 'grows about its centre')
  const tiny = at('make-smaller', { x: 0, y: 25, w: 330, h: 210 })!
  assert.ok(tiny.w >= 320 && tiny.h >= 200, 'never smaller than the minimum')
  assert.deepEqual(at('move-right', WIN), { x: 3840 - 1200, y: 200, w: 1200, h: 800 })
  assert.deepEqual(at('move-up', WIN), { x: 300, y: 25, w: 1200, h: 800 })
  assert.equal(at('restore', WIN), null, 'main does Restore')
})

test('next display keeps the place and the share of the screen', () => {
  const displays = [BIG, LAPTOP]
  assert.equal(displayOf(WIN, displays), 0)
  assert.deepEqual(displayOrder(displays), [1, 0])
  const half = at('left-half', WIN)!
  const moved = layoutFrame(layoutById('next-display')!, half, displays)!
  // Next after the big screen (rightmost) wraps round to the laptop: still its left half.
  assert.deepEqual(moved, { x: -1728, y: 400, w: 864, h: 1080 })
  assert.equal(at('next-display', WIN, [BIG]), null, 'one display: nothing to do')
})

test('a window off every display belongs to the nearest', () => {
  assert.equal(displayOf({ x: -5000, y: 600, w: 100, h: 100 }, [BIG, LAPTOP]), 1)
  assert.ok(sameFrame({ x: 0, y: 0, w: 100, h: 100 }, { x: 1, y: 2, w: 99, h: 101 }))
  assert.ok(!sameFrame({ x: 0, y: 0, w: 100, h: 100 }, { x: 5, y: 0, w: 100, h: 100 }))
})

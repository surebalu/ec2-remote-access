import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chooseDisplays, layoutFromSizes, parseSizes, readingOrder, resolveDisplays, sizesText, viewScale, type DisplayFrame } from '../src/shared/displays.ts'

// The user's desk: a 1800×1169 laptop screen left of a 5120×1440 monitor, centred vertically (as the picture showed).
const desk: DisplayFrame[] = [
  { x: 1800, y: 0, width: 5120, height: 1440, label: 'Ultrawide' },
  { x: 0, y: 136, width: 1800, height: 1169, label: 'Built-in Display', primary: true }
]

test('displays are counted left to right and placed on the picture', () => {
  assert.deepEqual(readingOrder(desk).map((f) => f.label), ['Built-in Display', 'Ultrawide'])
  const r = resolveDisplays(desk, { width: 6920, height: 1440 })
  assert.equal(r.problem, undefined)
  assert.deepEqual(r.displays.map((d) => [d.name, d.x, d.y, d.width, d.height]), [
    ['Built-in Display', 0, 136, 1800, 1169],
    ['Ultrawide', 1800, 0, 5120, 1440]
  ])
  assert.deepEqual(r.displays[1].points, { width: 5120, height: 1440 })
})

test('a Retina picture is the same layout at twice the size', () => {
  const r = resolveDisplays(desk, { width: 13840, height: 2880 })
  assert.deepEqual([r.displays[0].x, r.displays[0].y, r.displays[0].width, r.displays[1].x, r.displays[1].width], [0, 272, 3600, 3600, 10240])
})

test('a layout that does not fit the picture is refused, with the sums in the message', () => {
  const r = resolveDisplays(desk, { width: 6920, height: 1169 })
  assert.deepEqual(r.displays, [])
  assert.match(r.problem!, /add up to 6920×1440, but the screen picture is 6920×1169/)
  assert.deepEqual(resolveDisplays(null, { width: 10, height: 10 }), { displays: [] })
  assert.deepEqual(resolveDisplays(desk, { width: 0, height: 0 }), { displays: [] })
})

test('sizes typed from System Settings: lists, separators and × all read', () => {
  assert.deepEqual(parseSizes('1800x1169, 5120x1440'), [{ width: 1800, height: 1169 }, { width: 5120, height: 1440 }])
  assert.deepEqual(parseSizes('1800 × 1169 and 5120 × 1440'), [{ width: 1800, height: 1169 }, { width: 5120, height: 1440 }])
  assert.equal(parseSizes('two big ones'), null)
  assert.equal(parseSizes('1800x1169 oops'), null)
  assert.equal(parseSizes(''), null)
  assert.equal(sizesText([{ width: 1800, height: 1169 }, { width: 5120, height: 1440 }]), '1800×1169, 5120×1440')
})

test('side by side or stacked, shorter displays at the start, centre or end', () => {
  const sizes = [{ width: 1800, height: 1169 }, { width: 5120, height: 1440 }]
  assert.deepEqual(layoutFromSizes({ sizes, direction: 'row', align: 'center' }).map((f) => [f.x, f.y]), [[0, 136], [1800, 0]])
  assert.deepEqual(layoutFromSizes({ sizes, direction: 'row', align: 'start' }).map((f) => [f.x, f.y]), [[0, 0], [1800, 0]])
  assert.deepEqual(layoutFromSizes({ sizes, direction: 'row', align: 'end' }).map((f) => [f.x, f.y]), [[0, 271], [1800, 0]])
  assert.deepEqual(layoutFromSizes({ sizes, direction: 'column', align: 'center' }).map((f) => [f.x, f.y]), [[1660, 0], [0, 1169]])
})

test('this machine’s own displays win when they fit; otherwise what the user described', () => {
  const picture = { width: 6920, height: 1440 }
  const saved = { sizes: [{ width: 1800, height: 1169 }, { width: 5120, height: 1440 }], direction: 'row' as const, align: 'center' as const }
  assert.equal(chooseDisplays({ auto: desk, saved: null }, picture).displays.length, 2)
  const viaSaved = chooseDisplays({ auto: null, saved }, picture)
  assert.deepEqual(viaSaved.displays.map((d) => d.name), ['Display 1', 'Display 2'])
  assert.equal(chooseDisplays({ auto: [{ x: 0, y: 0, width: 1000, height: 1000 }], saved }, picture).displays.length, 2, 'a stale auto list does not hide a good saved one')
  const none = chooseDisplays({ auto: null, saved: null }, picture)
  assert.deepEqual(none, { displays: [], problem: undefined })
  assert.match(chooseDisplays({ auto: null, saved }, { width: 100, height: 100 }).problem!, /add up to/)
  assert.deepEqual(chooseDisplays(null, picture), { displays: [] })
})

test('zoom to fit a display, fill the pane with it, or show it pixel for pixel', () => {
  // A 430×800 pane showing a 6920×1440 picture: 430 / 6920 CSS pixels per picture pixel.
  const k = 430 / 6920
  const layer = { width: 430, height: 800 }
  const display = { width: 1800, height: 1169 }
  const fit = viewScale('fit', k, layer, display)
  assert.ok(Math.abs(fit - 430 / (1800 * k)) < 1e-9, 'limited by the width')
  assert.ok(viewScale('fill', k, layer, display) > fit, 'filling covers the pane: limited by the height')
  assert.equal(viewScale('actual', k, layer, display), 1 / k > 16 ? 16 : 1 / k)
  assert.equal(viewScale('fit', k, layer, { width: 6920, height: 1440 }), 1, 'the whole picture is the unzoomed view')
  assert.equal(viewScale('fit', 0, layer, display), 1)
})

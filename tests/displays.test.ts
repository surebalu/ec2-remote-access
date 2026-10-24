import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chooseDisplays, soleDisplay, layoutFromSizes, parseSizes, readingOrder, resolveDisplays, sizesText, viewScale, type DisplayFrame } from '../src/shared/displays.ts'

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

test('a picture of one display alone says so, instead of asking for a layout', () => {
  assert.equal(soleDisplay(desk, { width: 3600, height: 2338 })?.label, 'Built-in Display', 'the Retina built-in display at 2×')
  assert.equal(soleDisplay(desk, { width: 5120, height: 1440 })?.label, 'Ultrawide')
  assert.equal(soleDisplay(desk, { width: 6920, height: 1440 }), null)
  assert.equal(soleDisplay([desk[0]], { width: 5120, height: 1440 }), null, 'one display is not a choice')
  assert.match(chooseDisplays({ auto: desk, saved: null }, { width: 3600, height: 2338 }).problem!, /sending only Built-in Display \(3600×2338\)/)
})

// Measured on the user's Mac (main.log, 2026-10-24): the picture for these two displays was 8720×2468.
const mixed: DisplayFrame[] = [
  { x: 0, y: 0, width: 1800, height: 1169, label: 'Built-in Retina Display', primary: true, scale: 2 },
  { x: 1800, y: -130, width: 5120, height: 1440, label: 'Dell U4924DW', scale: 1 }
]

test('mixed density: each display at its own pixels, edge to edge, offset in points', () => {
  const r = resolveDisplays(mixed, { width: 8720, height: 2468 })
  assert.equal(r.problem, undefined)
  assert.deepEqual(r.displays.map((d) => [d.name, d.x, d.y, d.width, d.height]), [
    ['Built-in Retina Display', 0, 130, 3600, 2338],
    ['Dell U4924DW', 3600, 0, 5120, 1440]
  ])
  assert.deepEqual(r.displays[0].points, { width: 1800, height: 1169 }, 'named by the size System Settings shows')
  assert.deepEqual(chooseDisplays({ auto: mixed, saved: null }, { width: 8720, height: 2468 }).displays.length, 2)
})

test('mixed density is only used when it reproduces the picture', () => {
  assert.deepEqual(resolveDisplays(mixed, { width: 8740, height: 2468 }).displays, [], 'widths must add up (within rounding)')
  assert.deepEqual(resolveDisplays(mixed, { width: 8720, height: 3000 }).displays, [], 'and the height must agree')
  assert.deepEqual(resolveDisplays(mixed.map((f) => ({ ...f, scale: undefined })), { width: 8720, height: 2468 }).displays, [], 'unknown scales: no guessing')
  // The same displays at one density still take the uniform path.
  assert.equal(resolveDisplays(mixed.map((f) => ({ ...f, scale: 1 })), { width: 6920, height: 1440 }).displays[1].x, 1800)
})

test('stacked displays of mixed density', () => {
  const stacked: DisplayFrame[] = [
    { x: 0, y: 0, width: 1800, height: 1169, scale: 2 },
    { x: -100, y: 1169, width: 2560, height: 1440, scale: 1 }
  ]
  const r = resolveDisplays(stacked, { width: 3700, height: 3778 })
  assert.equal(r.problem, undefined, 'not mistaken for one density scaled ×1.45')
  assert.deepEqual(r.displays.map((d) => [d.x, d.y, d.width, d.height]), [[100, 0, 3600, 2338], [0, 2338, 2560, 1440]])
})

test('a typed layout with @2x finds the same crop, its approximate alignment kept inside the picture', () => {
  assert.deepEqual(parseSizes('1800x1169@2x, 5120x1440'), [{ width: 1800, height: 1169, scale: 2 }, { width: 5120, height: 1440 }])
  assert.deepEqual(parseSizes('1800 × 1169 @ 2x and 5120×1440 @1x'), [{ width: 1800, height: 1169, scale: 2 }, { width: 5120, height: 1440 }])
  assert.equal(sizesText([{ width: 1800, height: 1169, scale: 2 }, { width: 5120, height: 1440 }]), '1800×1169@2x, 5120×1440')
  const typed = layoutFromSizes({ sizes: [{ width: 1800, height: 1169, scale: 2 }, { width: 5120, height: 1440, scale: 1 }], direction: 'row', align: 'center' })
  const r = resolveDisplays(typed, { width: 8720, height: 2468 })
  assert.deepEqual(r.displays.map((d) => [d.x, d.y, d.width, d.height]), [[0, 130, 3600, 2338], [3600, 0, 5120, 1440]])
})

test('displays are numbered as macOS numbers them: the main display is 1, then left to right', () => {
  assert.deepEqual(resolveDisplays(mixed, { width: 8720, height: 2468 }).displays.map((d) => [d.number, d.points.width]), [[1, 1800], [2, 5120]])
  const mainOnRight = mixed.map((f) => ({ ...f, primary: f.width === 5120 }))
  assert.deepEqual(resolveDisplays(mainOnRight, { width: 8720, height: 2468 }).displays.map((d) => [d.number, d.points.width]), [[2, 1800], [1, 5120]])
  const typed = layoutFromSizes({ sizes: [{ width: 200, height: 400 }, { width: 440, height: 300 }], direction: 'row', align: 'center' })
  assert.deepEqual(resolveDisplays(typed, { width: 64, height: 40 }).displays.map((d) => d.number), [1, 2], 'without a main display: left to right')
  assert.equal('primary' in resolveDisplays(mixed, { width: 8720, height: 2468 }).displays[0], false, 'only the number leaves the module')
})

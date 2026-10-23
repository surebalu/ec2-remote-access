import { test } from 'node:test'
import assert from 'node:assert/strict'
import { droppedOutside, isToolKind, toolWindowBounds } from '../src/shared/toolWindows.ts'

test('tools that can have a window of their own', () => {
  for (const k of ['finder', 'browser', 'local', 'tasks', 'claude']) assert.equal(isToolKind(k), true, k)
  for (const k of ['hosts', 'overview', 'ssh', '', 'constructor', 7]) assert.equal(isToolKind(k), false, String(k))
})

test('a detached window opens under the pointer, on that screen, sized from the main window', () => {
  const area = { x: 0, y: 25, width: 1728, height: 1092 }
  assert.deepEqual(toolWindowBounds({ x: 600, y: 400 }, area, { x: 0, y: 25, width: 1400, height: 900 }), { x: 520, y: 380, width: 1050, height: 720 })
  // Dropped near the bottom-right corner: pulled back onto the screen.
  assert.deepEqual(toolWindowBounds({ x: 1700, y: 1100 }, area, { x: 0, y: 25, width: 1400, height: 900 }), { x: 678, y: 397, width: 1050, height: 720 })
  // A second screen to the left (negative x), no main window to size from.
  assert.deepEqual(toolWindowBounds({ x: -1500, y: 300 }, { x: -1920, y: 0, width: 1920, height: 1080 }, null), { x: -1580, y: 280, width: 900, height: 656 })
  // A small screen: never larger than it.
  const small = toolWindowBounds({ x: 10, y: 10 }, { x: 0, y: 0, width: 600, height: 400 }, { x: 0, y: 0, width: 1800, height: 1200 })
  assert.deepEqual([small.width, small.height, small.x, small.y], [600, 400, 0, 0])
})

test('a drag counts as let go outside the window only off its rectangle', () => {
  const win = { x: 100, y: 50, width: 1400, height: 900 }
  assert.equal(droppedOutside({ x: 1600, y: 300 }, win), true, 'right of it')
  assert.equal(droppedOutside({ x: 120, y: 30 }, win), true, 'above it')
  assert.equal(droppedOutside({ x: 700, y: 500 }, win), false, 'on the page')
  assert.equal(droppedOutside({ x: 1500, y: 950 }, win), true, 'the far corner is outside')
  assert.equal(droppedOutside({ x: 0, y: 0 }, win), false, 'a cancelled drag reports 0,0')
  assert.equal(droppedOutside({ x: Number.NaN, y: 5 }, win), false)
})

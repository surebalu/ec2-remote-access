import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PaneNode } from '../src/shared/types.ts'
import { layoutRects, neighbor, paneIds, removePane, resizeSplit, splitPane } from '../src/renderer/termLayout.ts'

const one: PaneNode = { type: 'pane', id: 'a' }

test('splitting nests a new direction and extends the same one', () => {
  const r = splitPane(one, 'a', 'b', 'row')
  assert.deepEqual(r, { type: 'split', dir: 'row', children: [{ type: 'pane', id: 'a' }, { type: 'pane', id: 'b' }], sizes: [0.5, 0.5] })
  const r2 = splitPane(r, 'a', 'c', 'row')
  assert.deepEqual(paneIds(r2), ['a', 'c', 'b'])
  assert.deepEqual(r2.type === 'split' && r2.sizes, [0.25, 0.25, 0.5])
  const r3 = splitPane(r, 'b', 'd', 'column')
  assert.deepEqual(paneIds(r3), ['a', 'b', 'd'])
  const { panes } = layoutRects(r3)
  assert.deepEqual(panes.d, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 })
})

test('closing a pane gives its share to a neighbour and collapses single-child splits', () => {
  const tree = splitPane(splitPane(one, 'a', 'b', 'row'), 'b', 'c', 'column')
  const noC = removePane(tree, 'c')
  assert.deepEqual(noC, { type: 'split', dir: 'row', children: [{ type: 'pane', id: 'a' }, { type: 'pane', id: 'b' }], sizes: [0.5, 0.5] })
  assert.deepEqual(removePane(noC!, 'a'), { type: 'pane', id: 'b' })
  assert.equal(removePane(one, 'a'), null)
  const three = splitPane(splitPane(one, 'a', 'b', 'row'), 'b', 'c', 'row')
  const r = removePane(three, 'b')
  assert.deepEqual(r?.type === 'split' && r.sizes, [0.75, 0.25])
})

test('dividers resize within limits, and focus moves to the touching pane', () => {
  const tree = splitPane(splitPane(one, 'a', 'b', 'row'), 'b', 'c', 'column')
  const { dividers } = layoutRects(tree)
  assert.equal(dividers.length, 2)
  assert.deepEqual(dividers[0], { path: [], index: 0, dir: 'row', at: 0.5, span: { x: 0, y: 0, w: 1, h: 1 } })
  const wider = resizeSplit(tree, [], 0, 0.2)
  assert.deepEqual(wider.type === 'split' && wider.sizes.map((x) => Math.round(x * 100)), [70, 30])
  const tooFar = resizeSplit(tree, [], 0, 5)
  assert.deepEqual(tooFar.type === 'split' && tooFar.sizes.map((x) => Math.round(x * 100)), [92, 8])
  assert.equal(neighbor(tree, 'a', 'right'), 'b')
  assert.equal(neighbor(tree, 'b', 'down'), 'c')
  assert.equal(neighbor(tree, 'c', 'left'), 'a')
  assert.equal(neighbor(tree, 'c', 'up'), 'b')
  assert.equal(neighbor(tree, 'a', 'left'), null)
})

test('presets lay panes out in reading order: two side by side, one big and two, and a 2×2 grid', async () => {
  const { presetLayout, PRESET_PANES } = await import('../src/renderer/termLayout.ts')
  const grid = presetLayout('grid', ['a', 'b', 'c', 'd'])
  assert.deepEqual(paneIds(grid), ['a', 'b', 'c', 'd'])
  const { panes } = layoutRects(grid)
  assert.deepEqual(panes.a, { x: 0, y: 0, w: 0.5, h: 0.5 })
  assert.deepEqual(panes.d, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 })
  assert.equal(neighbor(grid, 'a', 'down'), 'c')
  assert.equal(neighbor(grid, 'c', 'right'), 'd')
  assert.deepEqual(layoutRects(presetLayout('main', ['a', 'b', 'c'])).panes.c, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 })
  assert.equal(PRESET_PANES.grid, 4)
})

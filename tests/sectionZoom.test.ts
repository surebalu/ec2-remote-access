import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stepZoom, ZOOM_STEPS, zoomLabel } from '../src/renderer/sectionZoom.ts'

test('zoom steps up and down within the range, from any starting value', () => {
  assert.equal(stepZoom(1, 1), 1.1)
  assert.equal(stepZoom(1, -1), 0.95)
  assert.equal(stepZoom(0.93, 1), 0.95, 'an off-step value moves to the next step')
  assert.equal(stepZoom(0.93, -1), 0.9)
  assert.equal(stepZoom(ZOOM_STEPS[0], -1), ZOOM_STEPS[0], 'stays at the smallest')
  assert.equal(stepZoom(1.4, 1), 1.4, 'stays at the largest')
  assert.equal(zoomLabel(0.85), '85%')
})

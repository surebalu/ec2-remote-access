import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bump, HALF_LIFE_MS, rank, score } from '../src/shared/usage.ts'

test('a use counts one today and half a week later', () => {
  const u = bump(undefined, 0)
  assert.equal(score(u, 0), 1)
  assert.ok(Math.abs(score(u, HALF_LIFE_MS) - 0.5) < 1e-9)
  assert.ok(Math.abs(score(bump(u, HALF_LIFE_MS), HALF_LIFE_MS) - 1.5) < 1e-9, 'older uses keep their decayed weight')
})

test('tools rank by recent use; unused ones keep their order', () => {
  const now = 30 * 86_400_000
  const usage = {
    browser: { n: 10, at: now - 28 * 86_400_000 }, // a lot, a month ago
    health: { n: 3, at: now - 3_600_000 }, // a few times today
    notes: { n: 1, at: now - 86_400_000 }
  }
  assert.deepEqual(rank(['local', 'browser', 'notes', 'health', 'claude'] as const, usage, now), ['health', 'notes', 'browser', 'local', 'claude'])
  assert.deepEqual(rank(['a', 'b'] as const, {}, now), ['a', 'b'])
})

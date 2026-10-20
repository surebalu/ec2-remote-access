import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calculate, formatNumber, matchScore, rank, recentIds, recordUse, usageBoost } from '../src/shared/launcher.ts'

test('names match best whole, then by their start, a word, initials, anywhere, letters in order', () => {
  const s = (q: string, t: string): number => matchScore(q, t)
  assert.equal(s('safari', 'Safari'), 100)
  assert.ok(s('saf', 'Safari') > s('code', 'Visual Studio Code'), 'start of the name beats start of a word')
  assert.ok(s('saf', 'Safari') > s('saf', 'Safari Technology Preview'), 'shorter names first')
  assert.ok(s('code', 'Visual Studio Code') > s('vsc', 'Visual Studio Code'))
  assert.ok(s('vsc', 'Visual Studio Code') > s('stud', 'Visual Studio Code') - 30)
  assert.ok(s('vsc', 'Visual Studio Code') > s('isual', 'Visual Studio Code'), 'initials beat a substring')
  assert.ok(s('drive', 'OneDrive') >= 70, 'camelCase humps are words')
  assert.ok(s('isual', 'Visual Studio Code') > s('vlsd', 'Visual Studio Code'))
  assert.ok(s('vlsd', 'Visual Studio Code') > 0, 'letters in order')
  assert.equal(s('xyz', 'Safari'), 0)
  assert.equal(s('v', 'Safari'), 0, 'a single letter needs more than letters in order')
  assert.ok(s('visual code', 'Visual Studio Code') >= 70, 'several words each match a word')
  assert.equal(s('visual xcode', 'Visual Studio Code'), 0)
  assert.equal(s('', 'Anything'), 1)
})

test('what was opened often and lately rises', () => {
  const now = Date.UTC(2026, 9, 19)
  assert.equal(usageBoost(undefined, now), 0)
  assert.ok(usageBoost({ count: 10, last: now - 1000 }, now) > usageBoost({ count: 10, last: now - 40 * 86_400_000 }, now))
  assert.ok(usageBoost({ count: 50, last: now }, now) <= 30)
  const apps = [{ name: 'Slack' }, { name: 'Safari' }, { name: 'Sublime Text' }]
  const ranked = (usage = {}): string[] => rank(apps, 's', { text: (a) => a.name, id: (a) => a.name, usage, now }).map((a) => a.name)
  assert.deepEqual(ranked(), ['Slack', 'Safari', 'Sublime Text'])
  assert.equal(ranked({ 'Sublime Text': { count: 20, last: now } })[0], 'Sublime Text')
  assert.deepEqual(rank(apps, 'zz', { text: (a) => a.name, id: (a) => a.name }), [])
})

test('uses are counted, the latest first, and capped', () => {
  const now = 1_000_000
  let u = recordUse({}, 'app:a', now)
  u = recordUse(u, 'app:a', now + 1)
  u = recordUse(u, 'host:b', now + 2)
  assert.deepEqual(u['app:a'], { count: 2, last: now + 1 })
  assert.deepEqual(recentIds(u, now + 3, 5), ['app:a', 'host:b'])
  let big = {}
  for (let n = 0; n < 405; n++) big = recordUse(big, `f:${n}`, now + n)
  assert.equal(Object.keys(big).length, 400)
  assert.equal(big['f:0' as keyof typeof big], undefined, 'the oldest go')
})

test('arithmetic is calculated without evaluating code', () => {
  assert.equal(calculate('2*(3+4)'), 14)
  assert.equal(calculate('1.5^2'), 2.25)
  assert.equal(calculate('2^3^2'), 512)
  assert.equal(calculate('-2^2'), -4)
  assert.equal(calculate('0.1 + 0.2'), 0.3)
  assert.equal(calculate('200 * 15%'), 30)
  assert.equal(calculate('1,250 / 4'), 312.5)
  assert.equal(calculate('10 × 3 ÷ 4'), 7.5)
  assert.equal(calculate('sqrt(16) + abs(-2)'), 6)
  assert.equal(calculate('round(pi * 100)'), 314)
  assert.equal(calculate('2 ** 10'), 1024)
  for (const no of ['42', 'safari', 'web-prod-01', '10.0.1.15', '2 +', '(1 + 2', '1/0', 'alert(1)', 'process.exit()', '2 + x', '']) {
    assert.equal(calculate(no), null, no)
  }
})

test('results read with grouped thousands', () => {
  assert.equal(formatNumber(1234.5), '1,234.5')
  assert.equal(formatNumber(14), '14')
  assert.equal(formatNumber(1 / 3), '0.3333333333')
  assert.equal(formatNumber(1e22), '1.000000e+22')
})

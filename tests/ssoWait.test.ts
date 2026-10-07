import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ssoWaitOutcome } from '../src/shared/ssoWait.ts'
import type { SsoSessionInfo } from '../src/shared/types.ts'

const session = (over: Partial<SsoSessionInfo> = {}): SsoSessionInfo =>
  ({ name: 'corp', tokenValid: false, hasRefreshToken: false, profiles: ['prod'], ...over })
const base = { expiresAtBefore: undefined, startedAt: 1_000_000, flowExpiresInSec: 600, now: 1_030_000 }

test('waiting while no token has been written', () => {
  assert.equal(ssoWaitOutcome({ ...base, session: session() }), 'pending')
  assert.equal(ssoWaitOutcome({ ...base, session: undefined }), 'pending')
})

test('a valid token that was not there before means the sign-in finished', () => {
  assert.equal(ssoWaitOutcome({ ...base, session: session({ tokenValid: true, expiresAt: '2026-10-07T01:00:00Z' }) }), 'signed-in')
})

test('the token the sign-in started with does not count as finished', () => {
  const old = '2026-10-06T23:00:00Z'
  assert.equal(ssoWaitOutcome({ ...base, expiresAtBefore: old, session: session({ tokenValid: true, expiresAt: old }) }), 'pending')
  assert.equal(ssoWaitOutcome({ ...base, expiresAtBefore: old, session: session({ tokenValid: true, expiresAt: '2026-10-07T01:00:00Z' }) }), 'signed-in')
})

test('an expired token that merely changed is not a sign-in', () => {
  assert.equal(ssoWaitOutcome({ ...base, expiresAtBefore: '2026-10-06T20:00:00Z', session: session({ tokenValid: false, expiresAt: '2026-10-06T21:00:00Z' }) }), 'pending')
})

test('a finished sign-in wins over the clock', () => {
  const late = { ...base, now: base.startedAt + 3_600_000 }
  assert.equal(ssoWaitOutcome({ ...late, session: session({ tokenValid: true, expiresAt: '2026-10-07T01:00:00Z' }) }), 'signed-in')
})

test('gives up once the device code and its grace period have run out', () => {
  const edge = base.startedAt + 600_000
  assert.equal(ssoWaitOutcome({ ...base, now: edge + 19_000, session: session() }), 'pending')
  assert.equal(ssoWaitOutcome({ ...base, now: edge + 21_000, session: session() }), 'expired')
})

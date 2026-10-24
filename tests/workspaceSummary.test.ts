import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boxIssue, healthIsStale, workspaceSummary } from '../src/shared/workspaceSummary.ts'
import type { AwsProfile, Instance } from '../src/shared/types.ts'

const host = (key: string, extra: Partial<Instance> = {}): Instance => ({ key, name: key, profile: 'prod', region: 'us-east-1', instanceId: 'i-same', platform: 'linux', platformDetails: 'Linux', osHint: 'Linux', state: 'running', instanceType: 't3.small', ssmOnline: true, tags: {}, ...extra })
const profile = (name: string, enabled = true): AwsProfile => ({ name, enabled, region: 'us-east-1', kind: 'sso' })
const base = { hosts: [host('prod/us-east-1/i-same')], profiles: [profile('prod')], statuses: {}, errors: [], sessions: [], route: () => 'ssm' as const }

test('a configured route does not invent a live session or verified AWS access', () => {
  const result = workspaceSummary(base)
  assert.equal(result.routes, 1)
  assert.equal(result.live, 0)
  assert.equal(result.accountState, 'unverified')
  assert.equal(workspaceSummary({ ...base, profiles: [] }).accountState, 'none')
  assert.equal(workspaceSummary({ ...base, statuses: { prod: { profile: 'prod', state: 'ok' } } }).accountState, 'verified')
})

test('disabled profiles are excluded while manual hosts and existing sessions remain visible', () => {
  const result = workspaceSummary({ ...base, profiles: [profile('prod', false)],
    hosts: [...base.hosts, host('manual/test', { manual: true, profile: 'servers' })],
    statuses: { prod: { profile: 'prod', state: 'login-required' } },
    errors: [{ profile: 'prod', region: 'us-east-1', message: 'expired' }],
    sessions: [{ id: 'ssh', title: 'Still open', kind: 'ssh', status: 'connected' }]
  })
  assert.equal(result.total, 1)
  assert.equal(result.live, 1)
  assert.equal(result.issues.length, 0)
})

test('cached and stopped hosts are not classified as currently unreachable', () => {
  const result = workspaceSummary({ ...base, hosts: [host('cached', { staleReason: 'timeout' }), host('stopped', { state: 'stopped' }), host('fresh')], route: () => 'unreachable' })
  assert.equal(result.stale, 1)
  assert.deepEqual(result.issues.map((i) => i.kind), ['cached', 'route'])
  assert.equal(result.issues[1].title, '1 running host has no automatic route')
})

test('scan failures are deduplicated by full profile and region, with account issues first', () => {
  const result = workspaceSummary({ ...base, profiles: [profile('prod'), profile('readonly')], statuses: { prod: { profile: 'prod', state: 'error', message: 'denied' } },
    errors: [{ profile: 'prod', region: 'us-east-1', message: 'timeout' }, { profile: 'prod', region: 'us-east-1', message: 'timeout' }, { profile: 'readonly', region: 'us-east-1', message: 'timeout' }]
  })
  assert.equal(result.accountState, 'attention')
  assert.deepEqual(result.issues.map((i) => i.kind), ['account', 'scan'])
  assert.equal(result.issues[1].title, '2 inventory scans need a retry')
})

test('tool tabs and transient grid tiles do not inflate session counts or attention', () => {
  const result = workspaceSummary({ ...base, sessions: [
    { id: 'notes', title: 'Notes', kind: 'notes', status: 'connected' },
    { id: 'tile', title: 'Tile', kind: 'ssh', status: 'error', transient: true },
    { id: 'ssh', title: 'Host', kind: 'ssh', status: 'connected' },
    { id: 'rdp', title: 'Desktop', kind: 'rdp', status: 'closed' }
  ] })
  assert.equal(result.sessions, 2)
  assert.equal(result.live, 1)
  assert.deepEqual(result.issues.map((i) => i.target), ['rdp'])
})

test('failed health refresh and aging data cannot retain a current healthy verdict', () => {
  const now = 1_000_000
  assert.equal(healthIsStale(now - 120_000, null, now), false)
  assert.equal(healthIsStale(now - 180_001, null, now), true)
  assert.equal(healthIsStale(now, 'Refresh failed', now), true)
  assert.equal(healthIsStale(undefined, null, now), true)
})

test('Box sync problems are named, with their fix; a healthy or signed-out-by-choice Box is not a problem', () => {
  const now = 10_000_000
  const ok = { available: true, signedIn: true, syncing: false, user: { name: 'P', login: 'p@x' }, lastSync: now - 60_000 }
  assert.equal(boxIssue(ok, now), null)
  assert.equal(boxIssue({ ...ok, available: false }, now), null, 'a build without Box')
  assert.equal(boxIssue({ available: true, signedIn: false, syncing: false }, now), null, 'never signed in, or signed out on purpose')
  assert.deepEqual(boxIssue({ ...ok, signedIn: false }, now), { id: 'box', kind: 'box', target: 'signin', title: 'Box signed this computer out', detail: 'Tasks, Calendar, Links and whiteboards are not syncing. Sign in to Box again.' })
  assert.equal(boxIssue({ ...ok, lastError: 'Box is having trouble; the next sync tries again.' }, now)?.title, 'Box sync is failing')
  assert.equal(boxIssue({ ...ok, lastSync: now - 20 * 60_000 }, now)?.detail, 'Last synced 20 minutes ago.')
  assert.equal(boxIssue({ ...ok, lastSync: now - 20 * 60_000, syncing: true }, now), null, 'a long sync in progress is not late')
  const s = workspaceSummary({ hosts: [], profiles: [], statuses: {}, errors: [], sessions: [], route: () => 'ssm', box: { ...ok, lastError: 'x' }, now })
  assert.deepEqual(s.issues.map((i) => i.kind), ['box'])
})

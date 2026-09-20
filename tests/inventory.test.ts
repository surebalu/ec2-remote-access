import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeInventoryScan } from '../src/shared/inventoryMerge.ts'
import type { Instance, ScanResult } from '../src/shared/types.ts'

const host = (profile: string, region: string, instanceId = 'i-1'): Instance => ({
  key: `${profile}/${region}/${instanceId}`, profile, region, instanceId, name: instanceId,
  platform: 'linux', platformDetails: 'Linux', osHint: 'Linux', state: 'running', instanceType: 't3.small', ssmOnline: true, tags: {}
})
const a = host('prod', 'us-east-1')
const b = host('prod', 'us-west-2')
const c = host('dev', 'us-east-1')
const cached: ScanResult = { instances: [a, b, c], errors: [], scannedAt: 100 }

test('failed regions retain hosts and their last verified time; successful regions refresh', () => {
  const r = mergeInventoryScan([{ ...a, state: 'stopped' }, c], cached, [{ profile: 'prod' }, { profile: 'dev' }], [{ profile: 'prod', region: 'us-west-2', message: 'Access denied' }], false, 200)
  assert.equal(r.instances.length, 3)
  assert.equal(r.instances.find((i) => i.key === a.key)?.state, 'stopped')
  assert.equal(r.instances.find((i) => i.key === a.key)?.lastSeenAt, 200)
  assert.equal(r.instances.find((i) => i.key === b.key)?.lastSeenAt, 100)
  assert.equal(r.instances.find((i) => i.key === b.key)?.staleReason, 'Access denied')
})

test('a successful empty scan removes only hosts in the refreshed scope', () => {
  const r = mergeInventoryScan([], cached, [{ profile: 'prod', regions: ['us-east-1'] }], [], true, 200)
  assert.deepEqual(new Set(r.instances.map((i) => i.key)), new Set([b.key, c.key]))
})

test('failed enabled-region discovery retains every region in that account', () => {
  const r = mergeInventoryScan([], cached, [{ profile: 'prod' }], [{ profile: 'prod', region: 'us-east-1', message: 'Expired credentials', allRegions: true }], true, 200)
  assert.equal(r.instances.length, 3)
  assert.equal(r.instances.filter((i) => i.staleReason).length, 2)
  assert.equal(r.instances.find((i) => i.key === c.key)?.staleReason, undefined)
})

test('retry success replaces stale records, clears only resolved errors, and preserves other accounts', () => {
  const previous: ScanResult = { ...cached, instances: [a, { ...b, staleReason: 'timeout', lastSeenAt: 50 }, c], errors: [
    { profile: 'prod', region: b.region, message: 'timeout' }, { profile: 'dev', region: c.region, message: 'offline' }
  ] }
  const r = mergeInventoryScan([b], previous, [{ profile: 'prod', regions: [b.region] }], [], true, 200)
  assert.equal(r.instances.length, 3)
  assert.equal(r.instances.find((i) => i.key === b.key)?.staleReason, undefined)
  assert.equal(r.instances.find((i) => i.key === b.key)?.lastSeenAt, 200)
  assert.deepEqual(r.errors, [previous.errors[1]])
})

test('repeated failures never advance the last successful timestamp', () => {
  const previous = { ...cached, instances: [{ ...a, lastSeenAt: 25, staleReason: 'old failure' }] }
  const r = mergeInventoryScan([], previous, [{ profile: 'prod' }], [{ profile: 'prod', region: a.region, message: 'new failure' }], false, 300)
  assert.equal(r.instances[0].lastSeenAt, 25)
  assert.equal(r.instances[0].staleReason, 'new failure')
})

test('a complete successful scan clears old errors and drops excluded or deleted hosts', () => {
  const r = mergeInventoryScan([a], { ...cached, errors: [{ profile: 'dev', region: c.region, message: 'old' }] }, [{ profile: 'prod' }], [], false, 200)
  assert.deepEqual(r.instances.map((i) => i.key), [a.key])
  assert.deepEqual(r.errors, [])
})

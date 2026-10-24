import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cardTone, computerLabel, libraryGroups } from '../src/shared/computers.ts'
import type { Instance } from '../src/shared/types.ts'

const host = (key: string, name: string, extra: Partial<Instance> = {}): Instance => ({
  key, name, profile: 'p', region: 'r', instanceId: key, platform: 'linux', platformDetails: '', osHint: 'Linux', state: 'running',
  instanceType: '', ssmOnline: false, tags: {}, ...extra
})

test('machine names read like names; names typed with capitals stay as they are', () => {
  assert.equal(computerLabel('ec2amaz-ehoft35'), 'Ec2amaz Ehoft35')
  assert.equal(computerLabel('MSE-SBALU'), 'Mse Sbalu')
  assert.equal(computerLabel('raspberrypi'), 'Raspberrypi')
  assert.equal(computerLabel('Surendra’s MacBook Pro'), 'Surendra’s MacBook Pro')
  assert.equal(computerLabel('sbalu_graphics'), 'Sbalu Graphics')
  assert.equal(computerLabel(''), '')
})

test('cards without a picture are coloured by what the machine is', () => {
  assert.equal(cardTone({ platform: 'windows', osHint: 'Windows' }), 'violet')
  assert.equal(cardTone({ platform: 'linux', osHint: 'Linux' }), 'orange')
  assert.equal(cardTone({ platform: 'linux', osHint: 'macOS', tailnet: { os: 'macOS', online: true } }), 'teal')
  assert.equal(cardTone({ platform: 'unknown', osHint: '' }), 'slate')
})

test('the library: tailnet machines, then hand-added servers, then starred AWS hosts, each sorted by name', () => {
  const groups = libraryGroups([
    host('tailnet/b', 'windows', { manual: true, tailnet: { os: 'Windows', online: false } }),
    host('tailnet/a', 'ec2amaz-ehoft35', { manual: true, tailnet: { os: 'Windows', online: true } }),
    host('manual/1', 'Lab box', { manual: true }),
    host('aws/1', 'web-prod-01'),
    host('aws/2', 'not-starred')
  ], ['aws/1'])
  assert.deepEqual(groups.map((g) => [g.title, g.hosts.map((h) => h.key)]), [
    ['Tailscale', ['tailnet/a', 'tailnet/b']],
    ['Servers', ['manual/1']],
    ['Favorites', ['aws/1']]
  ])
  assert.deepEqual(libraryGroups([], []), [], 'empty groups are left out')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Instance } from '../src/shared/types.ts'
import { hostsInText } from '../src/shared/pageHosts.ts'

const host = (id: string, name: string, extra: Partial<Instance> = {}): Instance => ({
  key: `prod/us-east-1/${id}`, profile: 'prod', region: 'us-east-1', instanceId: id, name, platform: 'linux', platformDetails: 'Linux/UNIX',
  osHint: 'rhel', state: 'running', instanceType: 't3.large', ssmOnline: true, tags: {}, ...extra
})

const web = host('i-0123456789abcdef0', 'web-01', { privateIp: '10.20.1.15' })
const db = host('i-0fedcba9876543210', 'orders-db', { privateIp: '10.20.2.40', publicIp: '54.12.3.4' })
const jenkins = host('i-00000000000000aaa', 'jenkins', { privateIp: '10.20.3.3' })
const prod = host('i-00000000000000bbb', 'prod')
const spaced = host('i-00000000000000ccc', 'Billing API 2')
const all = [web, db, jenkins, prod, spaced]

test('finds hosts by instance ID, address, EC2 host name and name, in page order', () => {
  const text = `Customer reports 502s from orders-db since 09:10.
Checked i-0123456789ABCDEF0 and the box at 54.12.3.4; ip-10-20-3-3.ec2.internal is the build server.`
  const found = hostsInText(text, all)
  assert.deepEqual(found.map((h) => h.key), [db.key, web.key, jenkins.key])
  assert.equal(found[0].via, 'IP address') // named by its stronger match, placed by its first mention
  assert.equal(found[1].via, 'instance ID')
  assert.equal(found[2].via, 'host name')
})

test('an instance ID names the match even when the host is also mentioned by name earlier', () => {
  const found = hostsInText('web-01 is slow (i-0123456789abcdef0)', all)
  assert.equal(found.length, 1)
  assert.equal(found[0].via, 'instance ID')
  assert.equal(found[0].at, 0)
})

test('whole words and whole addresses only', () => {
  assert.deepEqual(hostsInText('web-010 and 10.20.1.150 and 110.20.1.15 and version 1.10.20.1.15', all), [])
  assert.deepEqual(hostsInText('see web-01.', all).map((h) => h.match), ['web-01'])
  assert.deepEqual(hostsInText('at 10.20.1.15.', all).map((h) => h.key), [web.key])
})

test('ordinary words are not host names; names with spaces match as phrases', () => {
  assert.deepEqual(hostsInText('this is a prod incident', all), [])
  assert.deepEqual(hostsInText('The billing  api 2 service', all).map((h) => h.key), [spaced.key])
  assert.deepEqual(hostsInText('billing api 22', all), [])
})

test('the same instance under two accounts shows up twice', () => {
  const twin = { ...web, key: `staging/us-east-1/${web.instanceId}`, profile: 'staging' }
  assert.deepEqual(hostsInText(web.instanceId, [web, twin]).map((h) => h.key), [web.key, twin.key])
})

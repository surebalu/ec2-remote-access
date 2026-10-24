import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  awsSetupFrom, companyPicks, exportSettings, mergeSettings, parseCompanySetup, parseSetupFile, planSections, rehome, sectionsFor, settingsSummary,
  type ConfigSections, type SetupFile
} from '../src/shared/setup.ts'
import type { Settings } from '../src/shared/types.ts'

const config: ConfigSections = {
  'sso-session corp': { sso_start_url: 'https://corp.awsapps.com/start', sso_region: 'us-west-2', sso_registration_scopes: 'sso:account:access' },
  'profile prod': { sso_session: 'corp', sso_account_id: '111111111111', sso_role_name: 'Admin', region: 'us-west-2', output: 'json' },
  'profile qa': { sso_session: 'corp', sso_account_id: '222222222222', sso_role_name: 'Admin', region: 'us-west-1', output: 'json' },
  'profile old': { region: 'us-east-1' },
  'profile legacy': { sso_start_url: 'https://corp.awsapps.com/start', sso_account_id: '333333333333', sso_role_name: 'Read', region: 'us-east-1' }
}

test('the Identity Center part of a config, and what is left out', () => {
  const { aws, left } = awsSetupFrom(config, ['old', 'keys-only', 'prod'])
  assert.deepEqual(aws.sessions, [{ name: 'corp', startUrl: 'https://corp.awsapps.com/start', region: 'us-west-2', scopes: 'sso:account:access' }])
  assert.deepEqual(aws.profiles.map((p) => p.name), ['prod', 'qa'])
  assert.deepEqual(left.map((l) => l.name), ['old', 'legacy', 'keys-only'])
  assert.match(left.find((l) => l.name === 'old')!.why, /access keys/)
  assert.match(left.find((l) => l.name === 'legacy')!.why, /older single sign-on/)
})

test('the sections written are the ones the app writes itself, and nothing there is overwritten', () => {
  const { aws } = awsSetupFrom(config)
  assert.deepEqual(sectionsFor(aws)[1], ['profile prod', { sso_session: 'corp', sso_account_id: '111111111111', sso_role_name: 'Admin', region: 'us-west-2', output: 'json' }])
  const fresh = planSections(aws, {})
  assert.equal(fresh.write.length, 3)
  const there = planSections(aws, { ...config, 'profile qa': { sso_session: 'corp', sso_account_id: '999999999999', sso_role_name: 'Admin' } })
  assert.deepEqual(there.status, { 'sso-session corp': 'same', 'profile prod': 'same', 'profile qa': 'kept' })
  assert.deepEqual(there.write, [])
})

test('settings: what stays on each Mac, home folders, and a merge that loses nothing', () => {
  const mine = { favorites: ['a'], overrides: { a: { sshUser: 'ec2-user' } }, manualHosts: [{ id: 'm1', name: 'one' }], phoneAccessEnabled: true, phoneAccessPort: 9000, dataDir: '/Volumes/nas', theme: 'dark', notesDir: '/Users/old/Notes', extraRegions: ['eu-west-1'] } as unknown as Settings
  const out = exportSettings(mine)
  assert.equal('phoneAccessEnabled' in out, false)
  assert.equal('dataDir' in out, false)
  assert.equal(out.theme, 'dark')
  assert.deepEqual(rehome({ notesDir: '/Users/old/Notes', key: '/Users/old/.ssh/id', other: '/Users/olden/x', home: '/Users/old' }, '/Users/old', '/Users/new'),
    { notesDir: '/Users/new/Notes', key: '/Users/new/.ssh/id', other: '/Users/olden/x', home: '/Users/new' })
  const here = { favorites: ['b'], overrides: { b: { rdpUser: 'admin' } }, manualHosts: [{ id: 'm1', name: 'renamed' }, { id: 'm2', name: 'two' }], phoneAccessEnabled: false, theme: 'light', extraRegions: [] } as unknown as Settings
  const merged = mergeSettings(here, { ...out, phoneAccessEnabled: true } as Partial<Settings>)
  assert.deepEqual(merged.favorites, ['b', 'a'])
  assert.deepEqual(Object.keys(merged.overrides), ['b', 'a'])
  assert.deepEqual(merged.manualHosts.map((m) => `${m.id}:${m.name}`), ['m2:two', 'm1:one'])
  assert.equal(merged.phoneAccessEnabled, false, 'a file never turns on phone access')
  assert.equal(merged.theme, 'dark')
  assert.deepEqual(merged.extraRegions, ['eu-west-1'])
  assert.deepEqual(settingsSummary(out).slice(0, 3), ['1 favorite', '1 host setting', '1 server'])
})

const file = (over: Partial<SetupFile> = {}): string => JSON.stringify({ kind: 'ec2ra-setup', version: 1, exportedAt: 1, from: { computer: 'Old Mac', home: '/Users/old' }, aws: awsSetupFrom(config).aws, settings: { theme: 'dark' }, left: { profiles: [] }, ...over })

test('a setup file is checked before anything is written', () => {
  assert.equal(parseSetupFile(file()).aws.profiles.length, 2)
  assert.throws(() => parseSetupFile('{'), /not a setup file/)
  assert.throws(() => parseSetupFile(JSON.stringify({ kind: 'other' })), /not a setup file/)
  assert.throws(() => parseSetupFile(file({ version: 2 } as unknown as Partial<SetupFile>)), /newer version/)
  const evil = (p: Record<string, unknown>): string => file({ aws: { sessions: awsSetupFrom(config).aws.sessions, profiles: [{ name: 'x', session: 'corp', accountId: '111111111111', roleName: 'Admin', ...p }] } } as unknown as Partial<SetupFile>)
  assert.throws(() => parseSetupFile(evil({ name: 'x]\n[profile y' })), /not valid/, 'a name cannot add a section')
  assert.throws(() => parseSetupFile(evil({ roleName: 'Admin\nregion = x' })), /not valid/)
  assert.throws(() => parseSetupFile(evil({ region: 'us-west-2\ncredential_process = /bin/sh' })), /region/)
  assert.throws(() => parseSetupFile(evil({ session: 'nowhere' })), /does not have/)
  assert.throws(() => parseSetupFile(file({ aws: { sessions: [{ name: 'corp', startUrl: 'http://corp.example', region: 'us-west-2' }], profiles: [] } } as unknown as Partial<SetupFile>)), /not valid/)
})

test('the company sign-in names the accounts as the file does', () => {
  const company = parseCompanySetup(JSON.stringify({ name: 'Corp', aws: awsSetupFrom(config).aws, accountMeta: { prod: { label: 'Production', color: 'rose' } } }))
  assert.throws(() => parseCompanySetup(JSON.stringify({ name: 'Corp', aws: { sessions: [], profiles: [] } })), /exactly one/)
  const picks = companyPicks(company, [
    { accountId: '111111111111', accountName: 'Corp Prod', roles: ['Read', 'Admin'] },
    { accountId: '222222222222', accountName: 'Corp QA', roles: ['Read'] },
    { accountId: '444444444444', accountName: 'Sandbox', roles: ['Admin'] }
  ], [{ name: 'qa' }])
  assert.deepEqual(picks['111111111111'], { on: true, role: 'Admin', profile: 'prod', label: 'Production', color: 'rose', region: 'us-west-2' })
  assert.deepEqual(picks['222222222222'], { on: false, role: 'Read', profile: 'qa', label: 'Corp QA', region: 'us-west-1' }, 'already set up; a role the person lacks falls back to theirs')
  assert.equal(picks['444444444444'], undefined, 'an account the file does not name is left to the dialog')
})

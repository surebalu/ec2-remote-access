import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanSentence, findHosts, readIntent, squash, type IntentContext } from '../src/shared/intent.ts'
import { DEFAULT_SERVICES } from '../src/shared/services.ts'

const ctx: IntentContext = {
  hosts: [
    { key: 'prod/us-west-1/i-1', name: 'MSPROD-3DSpace-01', account: 'Prod', profile: 'mainspring-prod', region: 'us-west-1', privateIp: '10.0.1.11', state: 'running', platform: 'linux' },
    { key: 'qa/us-west-1/i-2', name: 'MSQA-3DSpace-01', account: 'QA', profile: 'mainspring-qa', region: 'us-west-1', privateIp: '10.0.2.11', state: 'running', platform: 'linux' },
    { key: 'qa/us-west-1/i-3', name: 'MSQA-3DSpace-02', account: 'QA', profile: 'mainspring-qa', region: 'us-west-1', privateIp: '10.0.2.12', state: 'running', platform: 'linux' },
    { key: 'manual/sbalu', name: 'MSE-SBALU', account: 'Server', profile: 'servers', state: 'running', platform: 'windows', privateIp: '10.10.0.5' },
    { key: 'prod/us-east-1/i-4', name: 'web-prod-01', account: 'Production', profile: 'production', region: 'us-east-1', state: 'running', platform: 'linux', instanceId: 'i-0abc123' },
    { key: 'prod/us-east-1/i-5', name: 'worker-stopped', account: 'Production', profile: 'production', region: 'us-east-1', state: 'stopped', platform: 'linux' }
  ],
  apps: [{ name: 'Slack', path: '/Applications/Slack.app' }, { name: 'Visual Studio Code', path: '/Applications/Visual Studio Code.app' }, { name: 'Notes', path: '/System/Applications/Notes.app' }],
  sites: [{ id: 't1', title: 'Inbox - Gmail', url: 'https://mail.google.com/mail/u/0/', space: 'personal' }, { id: 't2', title: 'OTS Sprint Board - Jira', url: 'https://mainspringenergy.atlassian.net/jira/software', space: 'work' }],
  spaces: [{ id: 'work', name: 'Work' }, { id: 'personal', name: 'Personal' }, { id: 'aws-prod', name: 'Prod' }],
  services: DEFAULT_SERVICES,
  accounts: [{ profile: 'mainspring-prod', label: 'Prod' }, { profile: 'mainspring-qa', label: 'QA' }],
  sections: [{ id: 'notes', name: 'Notes' }, { id: 'calendar', name: 'Calendar' }, { id: 'health', name: 'Health' }]
}
const top = (text: string) => readIntent(text, ctx)[0]
const titles = (text: string) => readIntent(text, ctx).map((m) => m.title)

test('what people and dictation put around a command is dropped', () => {
  assert.equal(cleanSentence('Hey, could you please SSH to web 1?'), 'SSH to web 1')
  assert.equal(cleanSentence('Open mainspring energy dot com.'), 'Open mainspring energy.com')
  assert.equal(squash('MSQA-3DSpace-01'), 'msqa3dspace1')
  assert.equal(squash('three d space one'), '3dspace1')
})

test('the three examples', () => {
  assert.deepEqual(top('open mainspringenergy.com')?.intent, { kind: 'url', url: 'https://mainspringenergy.com', space: undefined, external: undefined })
  // 3dspace1 is in two accounts: a row each, never a guess.
  assert.deepEqual(titles('ssh to 3dspace1'), ['SSH to MSPROD-3DSpace-01', 'SSH to MSQA-3DSpace-01'])
  assert.equal(top('rdp into mse-sbalu')?.title, 'Remote Desktop to MSE-SBALU')
  assert.deepEqual(top('rdp into mse-sbalu')?.intent, { kind: 'connect', via: 'rdp', host: ctx.hosts[3] })
})

test('an account narrows the hosts, said before or after', () => {
  assert.deepEqual(titles('ssh to 3dspace 1 in qa'), ['SSH to MSQA-3DSpace-01'])
  assert.deepEqual(titles('ssh qa 3dspace 2'), ['SSH to MSQA-3DSpace-02'])
  assert.deepEqual(titles('SSH to 3D space one on prod.'), ['SSH to MSPROD-3DSpace-01'])
  assert.equal(findHosts('10.0.2.12', ctx)[0].host.name, 'MSQA-3DSpace-02')
  assert.equal(findHosts('i-0abc123', ctx)[0].host.name, 'web-prod-01')
})

test('dictated addresses and where to open them', () => {
  assert.equal(top('open mainspring energy dot com')?.title, 'Open mainspringenergy.com')
  assert.deepEqual(top('go to github.com/surebalu in personal')?.intent, { kind: 'url', url: 'https://github.com/surebalu', space: { id: 'personal', name: 'Personal' }, external: undefined })
  assert.equal((top('open google.com in safari')?.intent as { external?: boolean }).external, true)
  assert.equal(top('mainspringenergy.com')?.title, 'Open mainspringenergy.com', 'a bare address')
  assert.equal(readIntent('bracket.step', ctx).length, 0, 'a file name is not an address')
  assert.equal(readIntent('open notes.md', ctx).some((m) => m.intent.kind === 'url'), false)
  assert.equal(top('open gmail in personal')?.title, 'Switch to Inbox - Gmail')
  assert.equal(top('open jira')?.title, 'Switch to OTS Sprint Board - Jira')
})

test('files, power, forwards, services and commands on hosts', () => {
  assert.equal(top('files on web prod 1')?.title, 'Browse Files on web-prod-01')
  assert.equal(top('start worker-stopped')?.title, 'Start worker-stopped…')
  assert.deepEqual(top('forward 1521 on web-prod-01')?.intent, { kind: 'forward', host: ctx.hosts[4], port: 1521 })
  assert.equal(top('tunnel to web-prod-01')?.title, 'Forward a Port on web-prod-01…')
  assert.equal(top('restart 3dspace on msqa 3dspace 2')?.title, 'Restart 3DSpace on MSQA-3DSpace-02')
  assert.equal(top('run "df -h" on web-prod-01')?.title, 'Run “df -h” on web-prod-01…')
  assert.equal(top('show web-prod-01')?.title, 'Show web-prod-01')
  assert.equal(top('connect to mse sbalu')?.title, 'Connect to MSE-SBALU')
})

test('windows, apps and the Mac', () => {
  assert.equal(top('left half')?.title, 'Left Half')
  assert.equal(top('snap left')?.title, 'Left Half')
  assert.equal(readIntent('top', ctx).length, 0, 'one common word alone moves nothing')
  assert.equal(top('move this to the next screen')?.title, 'Next Display')
  assert.equal(top('put slack on the right third')?.title, 'Slack: Last Third')
  assert.equal(top('open vs code')?.title, 'Open Visual Studio Code')
  assert.equal(top('quit slack')?.title, 'Quit Slack')
  assert.equal(top('quit all apps')?.title, 'Quit All Apps…')
  assert.equal(top('kill chrome')?.title, 'Kill “chrome”…')
  assert.equal(top('lock the screen')?.title, 'Lock Screen')
  assert.equal(top('speed test')?.title, 'Speed Test')
  assert.equal(top("what's my ip")?.title, 'My IP Address')
  assert.equal(top('emoji rocket')?.title, 'Emoji: rocket')
  assert.deepEqual(readIntent('open notes', ctx).map((m) => m.intent.kind), ['section', 'app'], 'the app’s Notes first, then Apple’s')
})

test('asking, searching and writing down', () => {
  assert.deepEqual(top('ask claude why is nginx 502')?.intent, { kind: 'ask', to: 'claude', text: 'why is nginx 502' })
  assert.deepEqual(top('ChatGPT: summarise this')?.intent, { kind: 'ask', to: 'chatgpt', text: 'summarise this' })
  assert.equal(top('search for oracle rds kill session')?.title, 'Search Google for “oracle rds kill session”')
  assert.deepEqual(top('note the cert expires Nov 3')?.intent, { kind: 'capture', text: 'the cert expires Nov 3', task: false })
  assert.deepEqual(top('remind me to renew the cert friday')?.intent, { kind: 'task', text: 'renew the cert friday' })
  assert.equal(top("open today's note")?.title, 'Open Today’s Note')
  assert.equal(readIntent('log in to web-prod-01', ctx).some((m) => m.intent.kind === 'capture'), false)
})

test('plain words are left to the search', () => {
  assert.deepEqual(readIntent('nginx', ctx), [])
  assert.deepEqual(readIntent('web-prod', ctx), [])
  assert.deepEqual(readIntent('ssh to nothing-like-this', ctx), [])
})

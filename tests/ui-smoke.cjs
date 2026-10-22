// Runs the built renderer with synthetic data and no production main process or AWS access.
const { app, BrowserWindow, ipcMain, session, webContents } = require('electron')
const http = require('node:http')
const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const assert = require('node:assert/strict')
const output = mkdtempSync(join(tmpdir(), 'ec2ra-ui-'))
app.setPath('userData', output)
app.setPath('sessionData', output)
const now = Date.now()
// Recents' dates stay "Today" even when the suite runs just after midnight.
const today = new Date(now).setHours(0, 0, 0, 0)
const calls = []
const errors = []
const profiles = ['production', 'development'].map((name) => ({ name, region: 'us-east-1', kind: 'static', enabled: true, accountId: '123456789012' }))
const instance = (profile, name, state = 'running') => ({
  key: `${profile}/us-east-1/${name}`, profile, accountId: '123456789012', region: 'us-east-1', instanceId: name,
  name, state, platform: 'linux', platformDetails: 'Linux/UNIX', osHint: 'Ubuntu', instanceType: 't3.small',
  privateIp: '10.0.1.15', ssmOnline: true, ssmAgentVersion: '3.3.0', vpcId: 'vpc-example', subnetId: 'subnet-example',
  imageId: 'ami-example', az: 'us-east-1a', tags: { Name: name, Environment: profile, Service: 'web' }, lastSeenAt: now - 60000
})
const running = instance('production', 'web-prod-01')
const stopped = instance('production', 'worker-stopped', 'stopped')
const stale = { ...instance('development', 'web-dev-01'), staleReason: 'Example: request timed out', lastSeenAt: now - 3600000 }
let settings = {
  theme: 'dark', profileDefaults: { production: { sshUser: 'ubuntu' } }, favorites: [running.key], manualHosts: [], manualFolders: [],
  accountMeta: { production: { label: 'Production', color: 'rose' }, development: { label: 'Development', color: 'emerald' } },
  groupBy: 'account', collapsedGroups: [], extraRegions: [], scanAllRegions: false, disabledProfiles: [], hiddenProfiles: [],
  defaultLinuxUser: '', defaultWindowsUser: 'Administrator', sshAgentSock: '', defaultIdentityFile: '', pemFile: '',
  externalTerminal: 'Terminal', sessionManagerPluginPath: '', awsCliPath: '', connectTimeoutSec: 20, preferDirect: false, overrides: {},
  snippets: [{ id: 'sn-1', name: 'Disk usage', command: 'df -h', run: true }], portForwards: [], workspaces: [], sessionLogging: false, sessionLogDir: ''
}
let cached = { instances: [running, stopped, stale], errors: [{ profile: 'development', region: 'us-east-1', message: stale.staleReason }], scannedAt: now }
let failSsh = false
// First run: no AWS profiles, no servers, nothing scanned.
let emptyScenario = false
// Notes vault for the Notes tab.
const noteFolders = new Set(['Projects'])
const notes = {
  'Runbook.md': { text: '# Runbook\n\nRestart 3dspace, then see [[PLM upgrade]].\n', mtime: 1000 },
  'Projects/PLM upgrade.md': { text: '# PLM upgrade\n\n- [ ] index rebuild\n', mtime: 1000 }
}
// Persistent-shell scenario: the host reports a shell left running by an earlier session.
let shellScenario = false
// Sign-in scenario: one SSO profile whose token the "Mac" writes on demand, without ever pushing profiles:status.
let ssoScenario = false
let ssoTokenWritten = false
const ssoProfile = { name: 'corp-prod', region: 'us-east-1', kind: 'sso', enabled: true, accountId: '123456789012', ssoSession: 'corp' }
// Browser scenario: an AWS SSO account (its console is served by the local web server below) and saved browser state.
let browserScenario = false
let browserSaved = null
let webPort = 0
const awsProfile = { name: 'sandbox', region: 'us-west-2', kind: 'sso', enabled: true, accountId: '210987654321', ssoSession: 'corp' }
// Pages for the browser's <webview>s; console.aws.amazon.com requests from its spaces are redirected here.
const webServer = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1')
  if (u.pathname === '/fed') { res.writeHead(302, { Location: u.searchParams.get('d') }); res.end(); return }
  const title = u.pathname.startsWith('/console') ? 'AWS Console fixture' : u.pathname.startsWith('/chat/') ? 'Debug nginx 502s - Claude' : { '/one': 'Fixture page one', '/two': 'Fixture page two' }[u.pathname] ?? 'Fixture'
  if (u.pathname === '/ticket') {
    // A Jira-like ticket naming two hosts (one running, one stopped) and a config value to compare.
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<!doctype html><title>INC-4211 Checkout 502s</title><body style="font:15px -apple-system,system-ui;padding:36px;line-height:1.6"><h1>INC-4211: Checkout returns 502</h1><p>Since 09:10 the load balancer marks web-prod-01 unhealthy. Expected max_connections=512 in nginx.conf.</p><p>worker-stopped was stopped for patching.</p></body>`)
    return
  }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(`<!doctype html><title>${title}</title><body style="font:15px -apple-system,system-ui;padding:36px;line-height:1.6"><h1>${title}</h1><p>${u.pathname}${u.search}</p><p>find me, find me</p><a href="/two" target="_blank">two</a></body>`)
})
app.on('session-created', (ses) => {
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    if (ses === session.defaultSession) return callback({ cancel: /^(https?|wss?):/.test(details.url) })
    const u = new URL(details.url)
    if (u.hostname === '127.0.0.1') return callback({})
    if (/(^|\.)console\.aws\.amazon\.com$/.test(u.hostname)) return callback({ redirectURL: `http://127.0.0.1:${webPort}/console${u.pathname}${u.search}` })
    // Claude and ChatGPT tabs get a fixture page instead of the real sites.
    if (/^(claude\.ai|chatgpt\.com)$/.test(u.hostname)) return callback({ redirectURL: `http://127.0.0.1:${webPort}/chat/${u.hostname}${u.pathname}${u.search}` })
    callback({ cancel: /^(https?|wss?):/.test(details.url) })
  })
})
// The launcher: a few installed apps, what it counted and what it was asked to do.
const launcherApps = ['Safari', 'Slack', 'Visual Studio Code', 'System Settings'].map((name) => ({ name, path: `/Applications/${name}.app` }))
let launcherUsage = {}
const launcherDone = []
// While the launcher's window is up, notes:search finds notes by name.
let launcherNotes = false
// A fake zsh for the Terminal tab: shell-integration markers, echo, a few commands, ⌃C.
let termSaved = null
// The Finder tab's pretend disk under /Users/fixture, its Finder favorites and locations, and what it was asked to do.
const fsEntry = (dir, name, type = 'file', size = 0, ageDays = 1) => ({ name, path: `${dir === '/' ? '' : dir}/${name}`, type, size, mtime: now - ageDays * 86400000, mode: 0 })
const finderFs = {
  '/Users/fixture': [fsEntry('/Users/fixture', 'Documents', 'dir'), fsEntry('/Users/fixture', 'Downloads', 'dir'), fsEntry('/Users/fixture', 'Projects', 'dir'), fsEntry('/Users/fixture', '.zshrc', 'file', 120)],
  '/Users/fixture/Documents': [fsEntry('/Users/fixture/Documents', 'Surendra-Personal', 'dir'), fsEntry('/Users/fixture/Documents', 'Runbook.pdf', 'file', 1234567, 3), fsEntry('/Users/fixture/Documents', 'notes.md', 'file', 4200), fsEntry('/Users/fixture/Documents', 'photo.png', 'file', 250000, 40)],
  '/Users/fixture/Documents/Surendra-Personal': [fsEntry('/Users/fixture/Documents/Surendra-Personal', 'codebase', 'dir'), fsEntry('/Users/fixture/Documents/Surendra-Personal', 'Passport.pdf', 'file', 900000)],
  '/Users/fixture/Downloads': [], '/Users/fixture/Projects': [fsEntry('/Users/fixture/Projects', 'main.go', 'file', 1200)]
}
const finderDone = []
// A JVM's heap over a window: an hour-long saw-tooth from 1.5 to 6 GB, a full collection at each drop, a steady floor.
const gcFixture = (instance, hours) => {
  const step = { 1: 15, 6: 60, 24: 240, 72: 600, 168: 1800, 336: 3600 }[hours] ?? 240
  const n = Math.round((hours * 3600) / step) + 1
  const GB = 1024 ** 3
  const start = now - hours * 3600000
  const phase = (i) => ((i * step) % 3600) / 3600
  const heapHigh = Array.from({ length: n }, (_, i) => Math.round((1.5 + 4.5 * phase(i)) * GB))
  const heapLow = heapHigh.map((v) => v - 0.2 * GB)
  const fullGcs = Array.from({ length: n }, (_, i) => (i > 0 && phase(i) < phase(i - 1) ? 1 : 0))
  return {
    instance, hours, start, step, heapMax: 8 * GB, heapHigh, heapLow, afterGc: heapHigh.map(() => 1.5 * GB), fullGcs, startedAt: now - 1.6 * 86400000, lastFullGcAt: now - 1200000,
    collectors: [{ name: 'global garbage collect', full: true, count: 24, seconds: 0.07, avgMs: 2.9, perHour: 1 }, { name: 'partial gc', full: false, count: 900, seconds: 32, avgMs: 35.6, perHour: 37.5 }],
    throughputPct: 99.96, allocBytesPerSec: 11 * 1024 ** 2,
    pools: [{ name: 'balanced-old', used: 4.4 * GB, max: 8 * GB, heap: true }, { name: 'balanced-eden', used: 0.3 * GB, max: 1 * GB, heap: true }, { name: 'class storage', used: 0.2 * GB, max: null, heap: false }],
    trend: { level: 'ok', text: 'Healthy saw-tooth: after collections the heap drops back to about 1.5 GB (19% of 8.0 GB).', floorBytes: 1.5 * GB, floorPct: 19, slopePerDay: 0, daysToMax: null, line: null },
    policy: 'OpenJ9 balanced', nonHeapBytes: 0.46 * GB, rssBytes: 11.5 * GB, openFds: 1926
  }
}
// The Health tab's snapshot: three environments of an example platform (HEALTH_SNAPSHOT_JSON renders a captured one).
const healthFixture = () => {
  const spark = (base, wobble, n = 61) => Array.from({ length: n }, (_, i) => Math.round((base + Math.sin(i / 5) * wobble + (i % 7) * wobble * 0.1) * 100) / 100)
  const ep = (url, level = 'ok', ms = 40) => ({ url, level, status: level === 'crit' ? 0 : 200, ms: level === 'crit' ? null : ms, spark: spark(ms, ms / 4) })
  const node = (label, ip, level = 'ok', stopped = false) => ({ ...ep(`http://${ip}:8080/check`, level), label, ip, name: `plm-${label}`, stopped, level: stopped ? 'off' : level })
  const svc = (id, name, level, summary, fronts, nodes) => ({ id, name, blurb: `${name} service`, level, summary, fronts, nodes })
  const host = (role, label, ip, extra = {}) => ({ ip, name: `${role.toLowerCase().replace(/\W+/g, '-')}-${label}`, role, label, level: 'ok', problems: [], state: 'running', reporting: true, os: 'linux', cpu: 18 + Number(label) * 7, mem: 52, memBytes: 16 * 1024 ** 3, disk: { mount: '/', pct: 41 }, load: 0.4, cores: 4, uptimeSec: 3 * 86400, cpuSpark: spark(20, 6), ...extra })
  const env = (id, name, level, headline, issues, services, hosts, extra = {}) => ({
    id, name, level, headline, issues, services, hosts,
    jvms: [{ label: '01', ip: '10.9.0.11', name: 'space-01', promInstance: `${id}-space-01:9404`, level: 'ok', problems: [], reporting: true, heapUsed: 5.4 * 1024 ** 3, heapMax: 8 * 1024 ** 3, heapPct: 67,
      afterGcBytes: 1.6 * 1024 ** 3, afterGcPct: 20, startedAt: now - 1.6 * 86400000, trend: { level: 'ok', text: 'Healthy saw-tooth: after collections the heap drops back to about 1.6 GB (20% of 8.0 GB).', floorBytes: 1.6 * 1024 ** 3, floorPct: 20, slopePerDay: 0, daysToMax: null, line: null },
      gcPct: 0.4, threads: 134, fdsPct: 1.2, cpu: 9, uptimeSec: 1.6 * 86400, heapSpark: spark(62, 8) }],
    apaches: [{ label: '01', ip: '10.9.0.21', name: 'web-01', level: 'ok', reporting: true, busy: 11, idle: 139, reqPerSec: 1.6, spark: spark(1.5, 0.5) }],
    storage: [{ mount: '/filestore', device: 'nas:/filestore', shared: true, hosts: ['FCS 01', 'FCS 02'], pct: 86.3, usedBytes: 440e9, sizeBytes: 510e9, level: 'crit' }, { mount: '/', device: '/dev/nvme0n1p4', shared: false, hosts: ['3DSpace 01'], pct: 41, usedBytes: 21e9, sizeBytes: 52e9, level: 'ok' }],
    db: { id: `${id}-db`, engine: 'oracle-se2 19', instanceClass: 'db.m5.2xlarge', status: 'available', multiAz: id === 'prod', level: 'ok', problems: [], cpu: 2.1, connections: 719, freeStorageBytes: 300e9, storageBytes: 700 * 1024 ** 3, freeMemBytes: 9e9, readLatencyMs: 0.6, writeLatencyMs: 2.3, cpuSpark: spark(3, 1, 36), connSpark: spark(700, 20, 36) },
    albs: [{ name: `${id}-alb`, internal: false, level: 'ok', problems: [], requestsPerMin: 54, target5xx: 0, elb5xx: 0, responseMs: 13, healthy: 2, unhealthy: 0, reqSpark: spark(50, 10, 36), latencySpark: spark(14, 4, 36) }],
    certs: ['pass', 'space', 'dash'].map((h) => ({ host: `${h}-${id}.example.com`, days: 106, expires: now + 106 * 86400000, level: 'ok' })),
    checks: services.flatMap((sv) => [...sv.fronts.map((f) => ({ serviceId: sv.id, service: sv.name, url: f.url, via: 'lb', label: '', level: f.level, status: f.status, ms: f.ms, dnsMs: 0.5, certDays: 106, stopped: false, note: null })),
      ...sv.nodes.map((nd) => ({ serviceId: sv.id, service: sv.name, url: nd.url, via: 'server', label: nd.label, level: nd.level, status: nd.status, ms: nd.ms, dnsMs: 0.3, certDays: null, stopped: nd.stopped, note: null }))]),
    alerts: [], gaps: [], ...extra
  })
  return {
    at: Date.now(), source: 'monitoring-01 · Prometheus 10.9.0.5:9090 over SSM',
    envs: [
      env('prod', 'Production', 'crit', '3DPassport is down',
        [{ level: 'crit', text: '3DPassport: unreachable through the load balancer', section: 'services' }, { level: 'crit', text: 'Shared store /filestore is 86% full', section: 'storage' }],
        [svc('passport', '3DPassport', 'crit', 'Unreachable through the load balancer', [ep('https://pass-prod.example.com/3dpassport/healthcheck', 'crit')], [node('01', '10.9.0.31', 'crit'), node('02', '10.9.0.32', 'crit', true)]),
          svc('dashboard', '3DDashboard', 'ok', '2 servers up', [ep('https://dash-prod.example.com/3ddashboard/test-alive')], [node('01', '10.9.0.41'), node('02', '10.9.0.42')]),
          svc('space', '3DSpace', 'warn', '1 of 2 servers down, still served', [ep('https://space-prod.example.com/3dspace/servlet/fcs/ping', 'ok', 22)], [node('01', '10.9.0.11'), node('02', '10.9.0.12', 'crit')]),
          svc('fcs', 'File Collaboration Server', 'ok', '2 servers up', [ep('https://fcs-prod.example.com/fcs/servlet/fcs/ping')], [node('01', '10.9.0.51'), node('02', '10.9.0.52')])],
        [host('3DPassport', '01', '10.9.0.31', { level: 'crit', reporting: false, cpu: null, mem: null, disk: null, problems: ['Not reporting'] }), host('3DPassport', '02', '10.9.0.32', { level: 'off', state: 'stopped', reporting: false }), host('3DSpace', '01', '10.9.0.11'), host('3DSpace', '02', '10.9.0.12', { level: 'warn', mem: 83, problems: ['Memory at 83%'] }), host('File Collaboration Server', '01', '10.9.0.51', { sharedStores: [{ mount: '/filestore', pct: 86.3, level: 'crit' }] })],
        { alerts: [{ name: 'PlatformServiceDown', severity: 'critical', summary: 'HTTP status 0', target: 'pass-prod.example.com', since: now - 600000, level: 'crit', muted: false }, { name: 'PlatformServiceDown', severity: 'critical', summary: 'HTTP status 0', target: '3DPassport 02', since: now - 7200000, level: 'off', muted: true }] }),
      env('qa', 'QA', 'ok', 'All systems operational', [],
        [svc('passport', '3DPassport', 'ok', 'Up · 1 stopped', [ep('https://pass-qa.example.com/3dpassport/healthcheck')], [node('01', '10.8.0.31'), node('02', '10.8.0.32', 'crit', true)])],
        [host('3DPassport', '01', '10.8.0.31'), host('3DPassport', '02', '10.8.0.32', { level: 'off', state: 'stopped', reporting: false })]),
      env('dev', 'Development', 'warn', 'Running, with 1 warning', [{ level: 'warn', text: 'All-in-one server / is 82% full', section: 'storage' }],
        [svc('space', '3DSpace', 'ok', 'Up', [ep('https://space-dev.example.com/3dspace/servlet/fcs/ping')], [node('', '10.7.0.9')])],
        [host('All-in-one server', '', '10.7.0.9', { level: 'warn', disk: { mount: '/', pct: 82 }, problems: ['/ is 82% full'] })])
    ]
  }
}
// Service control jobs the fixture "runs": running, then active, then the health check, then done.
const serviceJobs = []
const jobNow = (j) => {
  const t = Date.now() - j.startedAt
  const phase = t < 900 ? 'running' : t < 1800 ? 'verifying' : t < 2700 ? 'checking' : 'done'
  return { ...j, finishedAt: phase === 'done' ? j.startedAt + 2700 : undefined, steps: j.steps.map((s) => ({ ...s, phase, message: phase === 'done' ? 'Restarted; active and its health check passes.' : undefined, endedAt: phase === 'done' ? j.startedAt + 2700 : undefined })) }
}
// Run Command: runs the fixture "sent", and how they come back (the production host succeeds, the others fail).
const runsSent = []
const runState = (r) => {
  const done = Date.now() - r.startedAt > 900
  const targets = r.targets.map((t) => (!done ? { ...t, status: 'running' } : t.name === 'web-prod-01'
    ? { ...t, status: 'success', exitCode: 0, stdout: ' 10:42:01 up 3 days,  2:11,  0 users,  load average: 0.08, 0.03, 0.01\n', startedAt: r.startedAt, endedAt: r.startedAt + 900 }
    : { ...t, status: 'failed', exitCode: 1, stderr: 'df: /data: No such file or directory\n', startedAt: r.startedAt, endedAt: r.startedAt + 900 }))
  return { ...r, targets, finishedAt: done ? r.startedAt + 900 : undefined }
}
// Dictations the fixture "helper" is running; events go to the window that started them, as main sends them.
const voiceRuns = []
let voiceRefusal = null
const voiceSend = (run, ev) => { if ((!run.cancelled || ev.kind === 'end') && !run.sender.isDestroyed()) run.sender.send('voice:event', { id: run.id, ...ev }) }
// Whiteboards main has saved (boards:*), and the images added to notes.
const boardsSaved = {}
const noteImages = []
const shells = new Map()
const termOut = (sh, data) => { if (!sh.sender.isDestroyed()) sh.sender.send('term:event', { id: sh.id, type: 'data', data }) }
const termPrompt = (sh) => termOut(sh, `\x1b]7;file://fixture${sh.cwd}\x07\x1b]633;P;Git=main\x07\x1b]633;P;Aws=${sh.env?.AWS_PROFILE ?? ''}\x07\x1b]133;A\x07fixture ${sh.cwd.replace('/Users/fixture', '~')} % `)
const termRun = (sh, cmd) => {
  termOut(sh, `${cmd}\r\n\x1b]633;E;${Buffer.from(cmd).toString('base64')}\x07\x1b]133;C\x07`)
  const done = (exit) => { termOut(sh, `\x1b]133;D;${exit}\x07`); termPrompt(sh) }
  if (cmd.startsWith('echo ')) { termOut(sh, `${cmd.slice(5)}\r\n`); done(0) }
  else if (cmd === 'false') done(1)
  else if (cmd.startsWith('sleep')) sh.waiting = () => { termOut(sh, '^C\r\n'); done(130) }
  else if (cmd === 'lines') { for (let i = 1; i <= 80; i++) termOut(sh, `line ${i}\r\n`); done(0) }
  else if (cmd === '') termPrompt(sh)
  else { termOut(sh, `zsh: command not found: ${cmd.split(' ')[0]}\r\n`); done(127) }
}
ipcMain.handle('fixture:invoke', async (_e, channel, ...args) => {
  calls.push({ channel, args })
  switch (channel) {
    case 'settings:get': return settings
    case 'settings:set': settings = { ...settings, ...args[0] }; return settings
    case 'inventory:cached': return emptyScenario ? null : cached
    case 'inventory:scan': if (emptyScenario) return { instances: [], errors: [], scannedAt: Date.now() }
      cached = { ...cached, instances: cached.instances.map((i) => ({ ...i, staleReason: undefined, lastSeenAt: Date.now() })), errors: [], scannedAt: Date.now() }; return cached
    case 'profiles:list': return emptyScenario ? [] : ssoScenario ? [ssoProfile] : browserScenario ? [...profiles, awsProfile] : profiles
    case 'profiles:check':
      if (ssoScenario) return [{ profile: ssoProfile.name, state: ssoTokenWritten ? 'ok' : 'login-required', accountId: ssoProfile.accountId, checkedAt: Date.now() }]
      return [...profiles, ...(browserScenario ? [awsProfile] : [])].map((p) => ({ profile: p.name, state: 'ok', accountId: p.accountId, checkedAt: Date.now() }))
    case 'tunnels:list': return []
    case 'sso:sessions':
      if (!ssoScenario) return []
      return [{ name: 'corp', tokenValid: ssoTokenWritten, expiresAt: new Date(Date.now() + (ssoTokenWritten ? 1 : -1) * 3600000).toISOString(), hasRefreshToken: false, profiles: [ssoProfile.name] }]
    case 'sso:loginSession': return { flowId: 'flow-1', userCode: 'ABCD-EFGH', verificationUri: 'https://device.sso.example/', verificationUriComplete: 'https://device.sso.example/?user_code=ABCD-EFGH', expiresIn: 600 }
    case 'sso:cancel': return
    case 'app:paths': return { sessionManagerPlugin: '/fixture/plugin', awsCli: null, windowsApp: false }
    case 'app:about': return { version: '1.0.0', electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, platform: 'darwin', arch: 'arm64', dataDir: '/fixture/data', logsDir: '/fixture/data/logs' }
    case 'app:reveal': return
    case 'diag:log': return { path: '/fixture/main.log', text: '' }
    case 'phone:status': return { enabled: true, running: true, port: 8321, bind: 'https', tailscaleAvailable: true, tailscaleHostname: 'fixture-mac.tail1234.ts.net', tailscaleHttps: true, urls: ['https://fixture-mac.tail1234.ts.net/#token=fixture-token'], token: 'fixture-token', clients: [{ address: '100.101.102.5', since: Date.now() - 120000 }] }
    case 'ssh:open':
      if (failSsh) throw new Error('Fixture: authentication failed')
      if (shellScenario) {
        const adopted = !!args[0].shellName
        return { sessionId: args[0].sessionId, instanceKey: running.key, title: running.name, route: 'ssm', host: running.instanceId, user: 'ubuntu', persistent: true, resumed: adopted, shellName: adopted ? args[0].shellName : 'ec2ra-fresh', shellLabel: adopted ? 'debug' : '', detached: adopted ? [] : [{ name: 'ec2ra-old1', label: 'debug', user: '3dxadmin', args: 'bash', preview: '3dxadmin@ip-10-1-2-144:/etc/systemd/system$', command: 'bash', path: '/etc/systemd/system', idleSec: 7200 }] }
      }
      return { sessionId: args[0].sessionId, instanceKey: running.key, title: running.name, route: 'ssm', host: running.instanceId, user: 'ubuntu' }
    case 'ec2:health': return { instanceStatus: 'ok', systemStatus: 'ok', events: [], cpu: Array.from({ length: 36 }, (_, n) => ({ t: now - (36 - n) * 300000, v: 20 + 15 * Math.sin(n / 4) })), ssmLastPing: new Date(now - 90000).toISOString(), fetchedAt: now, errors: [] }
    case 'notes:info': return { dir: '/fixture/vault', source: 'obsidian', hostFolder: 'EC2 Remote/Hosts', exists: true }
    case 'notes:list': return [...[...noteFolders].map((path) => ({ path, mtime: 0, size: 0, folder: true })), ...Object.entries(notes).map(([path, n]) => ({ path, mtime: n.mtime, size: n.text.length }))]
    case 'notes:mkdir': noteFolders.add(args[0]); return args[0]
    case 'notes:rename': { const [from, to] = args; if (notes[from]) { notes[to] = notes[from]; delete notes[from] } return to }
    case 'notes:delete': delete notes[args[0]]; noteFolders.delete(args[0]); return
    case 'notes:read': { const n = notes[args[0]]; if (!n) throw new Error(`No note ${args[0]}`); return { path: args[0], text: n.text, mtime: n.mtime } }
    case 'notes:write': notes[args[0]] = { text: args[1], mtime: Date.now() }; return { mtime: notes[args[0]].mtime }
    case 'notes:stat': return notes[args[0]]?.mtime ?? null
    case 'notes:create': notes[args[0]] ??= { text: `# ${args[0].replace(/\.md$/, '')}\n\n`, mtime: Date.now() }; return args[0]
    case 'notes:hostNote': { const p = 'EC2 Remote/Hosts/web-prod-01 (production).md'; notes[p] ??= { text: '---\nec2_key: production/us-east-1/web-prod-01\n---\n# web-prod-01\n\n', mtime: Date.now() }; return p }
    case 'notes:daily': { const p = 'Journal/2026-10-18.md'; notes[p] ??= { text: '# 2026-10-18\n\n', mtime: Date.now() }; return p }
    case 'notes:append': notes[args[0]].text += `\n${args[1]}\n`; notes[args[0]].mtime = Date.now(); return
    case 'notes:search': return launcherNotes ? Object.keys(notes).filter((p) => p.toLowerCase().includes(String(args[0]).toLowerCase())).map((path) => ({ path, line: 0, text: '' })) : []
    case 'notes:openInObsidian': return
    case 'browser:load': return browserSaved
    case 'browser:save': browserSaved = args[0]; return
    case 'browser:consoleUrl': return `http://127.0.0.1:${webPort}/fed?d=${encodeURIComponent(args[1])}`
    case 'shell:open': return
    case 'browser:openDownload': case 'browser:cancelDownload': return
    case 'browser:logins': return [
      { id: 'i1', account: 'u1', accountName: 'my.1password.com', title: 'Fixture login', username: 'me@example.com', vault: 'Private', urls: [`http://127.0.0.1:${webPort}/`], matches: true },
      { id: 'i2', account: 'u1', accountName: 'my.1password.com', title: 'Other site', username: 'other', vault: 'Work', urls: ['https://other.example'], matches: false }
    ]
    case 'browser:fill': return ['username', 'password']
    // Service control: a running 3DSpace unit and a failed TIF unit; a job steps through its phases over a few seconds.
    case 'services:status': return args[0].map((key) => {
      const i = [running, stopped, stale].find((x) => x.key === key)
      return { key, name: i?.name ?? key, ip: '10.0.1.15', units: [
        { unit: '3dspace.service', description: '3DSpace TomEE', load: 'loaded', active: 'active', sub: 'running', enabled: 'enabled', pid: 4242, memBytes: 6.1 * 1024 ** 3, since: Date.now() - 2 * 86400000 },
        { unit: 'tif.service', description: 'TIF', load: 'loaded', active: 'failed', sub: 'failed', enabled: 'enabled', pid: null, memBytes: null, since: Date.now() - 3600000 }
      ] }
    })
    case 'services:run': {
      const j = { id: `svc-${serviceJobs.length + 1}`, action: args[0].action, rolling: args[0].rolling, verify: args[0].verify, startedAt: Date.now(),
        steps: args[0].targets.map((t) => ({ key: t.key, name: 'web-prod-01', label: t.label ?? t.key, serviceId: t.serviceId, unit: t.unit, phase: 'running', startedAt: Date.now() })) }
      serviceJobs.push(j)
      return j
    }
    case 'services:jobs': return serviceJobs.map(jobNow).reverse()
    case 'services:job': return serviceJobs.map(jobNow).find((j) => j.id === args[0]) ?? null
    case 'services:cancel': return undefined
    case 'services:logs': return `2026-10-21T20:01:02+0000 ip-10-0-1-15 systemd[1]: Started ${args[1]}.\n2026-10-21T20:01:05+0000 ip-10-0-1-15 java[4242]: Server startup in 61234 ms`
    case 'services:history': return serviceJobs.filter((j) => jobNow(j).finishedAt).map((j) => ({ at: Date.now(), by: 'fixture.user', action: j.action, key: j.steps[0].key, name: 'web-prod-01', unit: j.steps[0].unit, result: 'done', message: 'Restarted; active and its health check passes.', seconds: 3 }))
    case 'run:start': {
      const r = { id: `run-${runsSent.length + 1}`, command: args[0].command, timeoutSec: args[0].timeoutSec ?? 600, startedAt: Date.now(), targets: args[0].keys.map((k) => { const i = [running, stopped, stale].find((x) => x.key === k); return { key: k, name: i.name, profile: i.profile, region: i.region, instanceId: i.instanceId, platform: 'linux', status: 'pending' } }) }
      runsSent.push(r)
      return r
    }
    case 'run:status': { const r = runsSent.find((x) => x.id === args[0]); return r ? runState(r) : null }
    case 'run:list': return runsSent.map(runState).reverse()
    case 'run:cancel': return
    case 'creds:get': return null
    case 'creds:set': return
    // A remote desktop that stays "connecting": the viewer is on the page, which is all the keyboard check needs.
    case 'rdp:prepare': return new Promise(() => undefined)
    case 'rdp:release': return
    case 'boards:list': return Object.values(boardsSaved).map((b) => ({ id: b.id, name: b.name, updatedAt: b.updatedAt, items: b.items.length })).sort((a, b) => b.updatedAt - a.updatedAt)
    case 'boards:load': return boardsSaved[args[0]] ? structuredClone(boardsSaved[args[0]]) : null
    case 'boards:save': boardsSaved[args[0].id] = structuredClone(args[0]); return
    case 'boards:delete': delete boardsSaved[args[0]]; return
    case 'notes:saveImage': noteImages.push(args[1]); return `EC2 Remote/Boards/${args[0]}.png`
    case 'local:home': return '/Users/fixture'
    case 'local:list': { const l = finderFs[args[0]]; if (!l) throw new Error(`ENOENT: no such directory, scandir '${args[0]}'`); return l }
    case 'local:mkdir': { const dir = args[0].replace(/\/[^/]+$/, ''); finderFs[dir].push(fsEntry(dir, args[0].split('/').pop(), 'dir', 0, 0)); finderFs[args[0]] = []; finderDone.push(['mkdir', args[0]]); return }
    case 'local:rename': { const dir = args[0].replace(/\/[^/]+$/, ''); const e = finderFs[dir].find((x) => x.path === args[0]); e.name = args[1].split('/').pop(); e.path = args[1]; if (finderFs[args[0]]) { finderFs[args[1]] = finderFs[args[0]]; delete finderFs[args[0]] } finderDone.push(['rename', args[0], args[1]]); return }
    case 'local:trash': for (const p of args[0]) { const dir = p.replace(/\/[^/]+$/, ''); finderFs[dir] = finderFs[dir].filter((x) => x.path !== p) } finderDone.push(['trash', ...args[0]]); return
    case 'local:open': finderDone.push(['open', args[0]]); return
    case 'local:quickLook': finderDone.push(['quickLook', args[0]]); return
    case 'finder:places': return {
      home: '/Users/fixture',
      favorites: [
        { name: 'Documents', path: '/Users/fixture/Documents', kind: 'documents', fromFinder: true },
        { name: 'Downloads', path: '/Users/fixture/Downloads', kind: 'downloads', fromFinder: true },
        ...(settings.finderExtra ?? []).map((p) => ({ name: p.split('/').pop(), path: p, kind: 'folder' }))
      ].filter((f) => !(settings.finderHidden ?? []).includes(f.path)),
      locations: [{ name: 'iCloud Drive', path: '/Users/fixture/Library/Mobile Documents/com~apple~CloudDocs', kind: 'icloud' }, { name: 'Google Drive - me@example.com', path: '/Users/fixture/Library/CloudStorage/GoogleDrive-me@example.com', kind: 'cloud' }, { name: 'Macintosh HD', path: '/', kind: 'computer' }]
    }
    case 'finder:recents': return [{ ...fsEntry('/Users/fixture/Documents', 'notes.md', 'file', 4200), lastUsed: Math.max(now - 3600000, today + 2000) }, { ...fsEntry('/Users/fixture/Projects', 'main.go', 'file', 1200), lastUsed: Math.max(now - 7200000, today + 1000) }]
    case 'finder:search': return Object.entries(finderFs).filter(([d]) => d.startsWith(args[1])).flatMap(([, l]) => l).filter((e) => e.name.toLowerCase().includes(args[0].toLowerCase())).map((e) => ({ ...e, lastUsed: e.mtime }))
    case 'local:reveal': return
    case 'app:pointer': return { x: 640, y: 420 }
    case 'health:snapshot': return process.env.HEALTH_SNAPSHOT_JSON ? JSON.parse(readFileSync(process.env.HEALTH_SNAPSHOT_JSON, 'utf8')) : healthFixture()
    case 'health:memory': {
      if (process.env.HEALTH_MEM_JSON) return JSON.parse(readFileSync(process.env.HEALTH_MEM_JSON, 'utf8'))[`${args[0]}|${args[1]}`]
      const env = healthFixture().envs.find((e) => e.id === args[0])
      const n = { 1: 241, 6: 361, 24: 361, 72: 433, 168: 337, 336: 337 }[args[1]] ?? 361
      const step = { 1: 15, 6: 60, 24: 240, 72: 600, 168: 1800, 336: 3600 }[args[1]] ?? 240
      return { env: args[0], hours: args[1], start: now - args[1] * 3600000, step, machines: (env?.hosts ?? []).map((h, k) => ({
        ip: h.ip, name: h.name, role: h.role, label: h.label, os: h.os, state: h.state, totalBytes: h.memBytes,
        pct: Array.from({ length: n }, (_, i) => (h.state === 'stopped' && i > n / 2 ? null : Math.round((40 + k * 9 + Math.sin(i / 9) * 8) * 10) / 10)),
        now: h.state === 'stopped' ? null : 40 + k * 9, peak: 48 + k * 9, avg: 40 + k * 9, level: h.state === 'stopped' ? 'off' : 40 + k * 9 >= 80 ? 'warn' : 'ok'
      })) }
    }
    case 'health:kernel': {
      if (process.env.HEALTH_KERNEL_JSON) return JSON.parse(readFileSync(process.env.HEALTH_KERNEL_JSON, 'utf8'))[args[0]]
      const MB = 1024 ** 2
      return { env: args[0], at: Date.now(), start: now - 86400000, step: 300, gaps: [],
        servers: [{ ip: '10.9.0.11', label: '01', name: 'space-01', reachable: true, people: ['alex.example', 'sam.example'], service: ['svc_sync'], system: ['ADMINISTRATION', 'User Agent'], reported: 5,
          allocatedBytes: 205 * MB, reservedBytes: 135 * MB, highwaterBytes: 663 * MB, limitBytes: 8192 * MB, contexts: 544, dbConnections: 87, dbExceeded: 0, exceptions: 527, uptimeSec: 175000, version: 'R2025x HotFix 10',
          usersSpark: Array.from({ length: 289 }, (_, i) => 4 + Math.round(10 * Math.max(0, Math.sin((i - 100) / 46)))), usersPeak: 14, level: 'ok' },
        // The same person can be signed in to both servers; the banner counts people once.
        { ip: '10.9.0.12', label: '02', name: 'space-02', reachable: true, people: ['sam.example', 'riley.example'], service: [], system: [], reported: 2,
          allocatedBytes: 180 * MB, reservedBytes: 120 * MB, highwaterBytes: 600 * MB, limitBytes: 8192 * MB, contexts: 300, dbConnections: 60, dbExceeded: 0, exceptions: 12, uptimeSec: 90000, version: 'R2025x HotFix 10',
          usersSpark: Array.from({ length: 289 }, () => 2), usersPeak: 2, level: 'ok' }],
        license: { at: now - 720000, status: 'RUNNING', type: 'MANAGED', version: '6.428.3', offline: 'Enabled', level: 'ok', nodes: [{ host: 'lic-1.example.com', ip: '192.0.2.1', port: '443', rttMs: 3 }, { host: 'lic-2.example.com', ip: '192.0.2.2', port: '443', rttMs: 4 }] } }
    }
    case 'health:kernelMemory': {
      if (process.env.HEALTH_KMEM_JSON) return JSON.parse(readFileSync(process.env.HEALTH_KMEM_JSON, 'utf8'))[`${args[0]}|${args[1]}`] ?? { env: args[0], hours: args[1], start: now - args[1] * 3600000, step: 60, servers: [] }
      // Server 01 records its kernel (recording began part-way through, then one restart); 02 has no history.
      const MB = 1024 ** 2
      const n = 145
      const step = Math.round((args[1] * 3600) / (n - 1))
      const restartAt = 100
      const series = (f) => Array.from({ length: n }, (_, i) => (i < 30 ? null : f(i)))
      return { env: args[0], hours: args[1], start: now - args[1] * 3600000, step, servers: [{ ip: '10.9.0.11', label: '01', name: 'space-01',
        allocated: series((i) => (i < restartAt ? 150 + i * 0.6 : 120 + (i - restartAt) * 0.4) * MB), reserved: series((i) => (i < restartAt ? 120 : 100) * MB),
        highwater: series((i) => (i < restartAt ? 600 : 300 + (i - restartAt)) * MB), contexts: series((i) => 400 + i), users: series((i) => 5 + (i % 4)),
        restarts: [now - args[1] * 3600000 + restartAt * step * 1000] }] }
    }
    case 'health:gc': return process.env.HEALTH_GC_JSON ? JSON.parse(readFileSync(process.env.HEALTH_GC_JSON, 'utf8'))[`${args[0]}|${args[1]}`] : gcFixture(args[0], args[1])
    case 'finder:openWithApps': return [{ name: 'TextEdit', path: '/System/Applications/TextEdit.app', isDefault: true }, { name: 'Visual Studio Code', path: '/Applications/Visual Studio Code.app', isDefault: false }]
    case 'finder:openWith': finderDone.push(['openWith', args[0], args[1]]); return
    case 'finder:openWithOther': finderDone.push(['openWithOther', args[0]]); return
    case 'finder:copy': finderDone.push(['copy', ...args[0]]); return
    case 'finder:pasteCommand': finderDone.push(['pasteCommand']); return
    case 'finder:paste': case 'finder:duplicate': {
      // Finder's names: "x copy.ext" beside the original, the same name elsewhere.
      const dirOf = (p) => p.replace(/\/[^/]+$/, '') || '/'
      const made = []
      for (const src of args[0]) {
        const dir = channel === 'finder:paste' ? args[1] : dirOf(src)
        const name = src.split('/').pop()
        const dot = name.lastIndexOf('.')
        const as = dirOf(src) === dir ? (dot > 0 ? `${name.slice(0, dot)} copy${name.slice(dot)}` : `${name} copy`) : name
        const orig = Object.values(finderFs).flat().find((e) => e.path === src)
        finderFs[dir].push(fsEntry(dir, as, orig?.type ?? 'file', orig?.size ?? 0, 0))
        made.push(`${dir}/${as}`)
      }
      finderDone.push([channel.slice(7), ...made])
      return made
    }
    case 'term:history': return ['ls -la', 'git status', 'git checkout main', 'npm test']
    case 'term:loadState': return termSaved
    case 'term:saveState': termSaved = args[0]; return
    case 'term:resize': return
    case 'term:close': shells.delete(args[0]); return
    case 'term:git': return {
      branch: 'main', detached: false, upstream: 'origin/main', ahead: 1, behind: 0, changed: 6, insertions: 31, deletions: 8,
      files: [{ path: 'src/app.ts', status: 'M', staged: false }, { path: 'notes/todo.md', status: '?', staged: false }]
    }
    case 'term:open': {
      const sh = { id: args[0].id, cwd: args[0].cwd || '/Users/fixture/proj', env: args[0].env, sender: _e.sender, line: '' }
      shells.set(sh.id, sh)
      setTimeout(() => termPrompt(sh), 30)
      return { shell: '/bin/zsh', integration: true, cwd: sh.cwd }
    }
    case 'term:write': {
      const sh = shells.get(args[0])
      if (!sh) return
      let data = String(args[1])
      if (data === '\x03' && sh.waiting) { const w = sh.waiting; sh.waiting = null; w(); return }
      if (data.startsWith('\x1b[200~')) data = data.replace('\x1b[200~', '').replace('\x1b[201~', '')
      sh.line += data
      if (sh.line.endsWith('\r')) { const cmd = sh.line.slice(0, -1); sh.line = ''; termRun(sh, cmd) }
      return
    }
    case 'ssh:listShells': return [
      { name: 'ec2ra-old1', label: 'debug', user: '3dxadmin', args: 'bash', preview: '3dxadmin@ip-10-1-2-144:/etc/systemd/system$', command: 'bash', path: '/etc/systemd/system', idleSec: 5, ageSec: 7200, current: true, attached: true },
      { name: 'ec2ra-other', label: '', user: 'root', args: 'tail -f /var/log/messages', preview: 'Oct 17 21:40:01 ip-10-1-2-144 systemd[1]: Started Session 42.', command: 'tail', path: '/root', idleSec: 60, ageSec: 300, current: false, attached: false }
    ]
    case 'ssh:switchShell': return { name: args[1] ?? 'ec2ra-new', label: args[2]?.label ?? (args[1] === 'ec2ra-old1' ? 'debug' : '') }
    case 'ssh:renameShell': return String(args[2]).trim()
    case 'ssh:close': case 'ssh:write': case 'ssh:resize': case 'clipboard:write': case 'theme:set': case 'browser:paneTargets': return
    // Dictation: a scripted "helper" that hears "connect to web prod one" (no microphone, no permission prompts).
    case 'voice:status': return { available: true, helper: true, mic: 'authorized', speech: 'notDetermined', onDevice: true, locale: 'en-US', supported: true, locales: ['en-GB', 'en-US', 'fr-FR'] }
    case 'voice:start': {
      if (voiceRefusal) throw new Error(voiceRefusal)
      const run ={ id: args[0]?.id ?? `v${voiceRuns.length + 1}`, sender: _e.sender, stopped: false, cancelled: false, timers: [] }
      voiceRuns.push(run)
      const at = (ms, ev) => run.timers.push(setTimeout(() => voiceSend(run, ev), ms))
      at(20, { kind: 'ready', onDevice: true })
      ;[0.18, 0.42, 0.75, 0.58, 0.9, 0.66, 0.35, 0.8, 0.52, 0.28, 0.7, 0.95, 0.6, 0.4, 0.22, 0.55, 0.85, 0.47, 0.3, 0.68, 0.5, 0.78, 0.36, 0.6].forEach((level, i) => at(30 + i * 12, { kind: 'level', level }))
      at(120, { kind: 'partial', text: 'connect to web' })
      at(260, { kind: 'partial', text: 'connect to web prod' })
      return { id: run.id }
    }
    case 'voice:stop': {
      const run = voiceRuns.find((r) => r.id === args[0])
      if (run && !run.stopped) { run.stopped = true; setTimeout(() => { voiceSend(run, { kind: 'final', text: 'connect to web prod one' }); voiceSend(run, { kind: 'end' }) }, 40) }
      return
    }
    case 'voice:cancel': {
      const run = voiceRuns.find((r) => r.id === args[0])
      if (run) { run.timers.forEach(clearTimeout); setTimeout(() => voiceSend(run, { kind: 'end' }), 10); run.cancelled = true }
      return
    }
    case 'voice:openPrivacy': return
    case 'launcher:apps': return launcherApps
    case 'launcher:usage': return launcherUsage
    case 'launcher:icons': return {}
    // Files by every typed word in the name, anywhere on the pretend disk, never opened.
    case 'launcher:files': {
      const words = String(args[0]).toLowerCase().split(/\s+/).filter(Boolean)
      return Object.values(finderFs).flat().filter((e) => words.every((w) => e.name.toLowerCase().includes(w))).map((e) => ({ ...e, lastUsed: 0 }))
    }
    case 'launcher:preview': {
      const e = Object.values(finderFs).flat().find((x) => x.path === args[0])
      return { path: args[0], isDir: e?.type === 'dir', kind: e?.name.endsWith('.pdf') ? 'PDF document' : 'Document', size: e?.size ?? 0, created: now - 86400000 * 30, modified: e?.mtime ?? now, lastOpened: null, thumbnail: '' }
    }
    case 'launcher:quickLook': case 'launcher:system': launcherDone.push([channel, ...args]); return
    case 'launcher:status': return { key: settings.launcherKey ?? '', registered: true }
    case 'launcher:open': case 'launcher:used': case 'launcher:command': case 'launcher:show': case 'launcher:hide': case 'launcher:pause': {
      launcherDone.push([channel, ...args])
      const id = channel === 'launcher:open' ? args[1] : channel === 'launcher:used' ? args[0] : null
      if (id) launcherUsage = { ...launcherUsage, [id]: { count: (launcherUsage[id]?.count ?? 0) + 1, last: Date.now() } }
      return
    }
    default: throw new Error(`Unexpected fixture IPC: ${channel}`)
  }
})

app.whenReady().then(async () => {
  app.dock?.hide()
  // Nothing from a test run may reach the desktop: no notifications from the hidden windows.
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission !== 'notifications')
  session.defaultSession.setPermissionRequestHandler((_wc, permission, done) => done(permission !== 'notifications'))
  await new Promise((r) => webServer.listen(0, '127.0.0.1', r))
  webPort = webServer.address().port
  const win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { preload: join(__dirname, 'ui-preload.cjs'), contextIsolation: true, backgroundThrottling: false } })
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }))
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message) })
  // Names the script when it throws; Electron's own error says only that "a script" failed.
  const js = (code) => win.webContents.executeJavaScript(code).catch((e) => { throw new Error(`${e.message}\n  in: ${code.slice(0, 300)}`) })
  const until = async (code) => {
    for (let n = 0; n < 100; n++) { if (await js(code)) return; await new Promise((r) => setTimeout(r, 30)) }
    throw new Error(`Timed out: ${code}`)
  }
  const click = async (label) => {
    await js(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(label)} && x.getClientRects().length); if (!b) throw new Error('Missing button: ' + ${JSON.stringify(label)}); b.click() })()`)
  }
  const key = (key, modifiers = {}) => js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true, ...${JSON.stringify(modifiers)} }))`)
  const screenshot = async (name) => { await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await new Promise((r) => setTimeout(r, 100)); writeFileSync(join(output, name), (await win.webContents.capturePage()).toPNG()) }
  try {
    await win.loadFile(resolve('out/renderer/index.html'))
    await until(`document.querySelectorAll('[data-host-key]').length === 3`)
    await screenshot('hosts-dark.png')
    // Save a filtered view, switch away, and restore it after a reload through the command palette.
    const setInput = (selector, value) => js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    assert.equal(await js(`!!document.querySelector('.quick-host-card[aria-label="Connect SSH: web-prod-01"]')`), true, 'favorites are available before there are recents')
    await setInput('[aria-label="Search hosts"]', 'web-prod')
    await until(`document.querySelectorAll('[data-host-key]').length === 2`)
    await click('Save view')
    await until(`!!document.querySelector('#host-view-name')`)
    await setInput('#host-view-name', 'Production web')
    await screenshot('host-view-editor.png')
    await js(`document.querySelector('[role="dialog"] form').requestSubmit()`)
    await until(`!document.querySelector('[role="dialog"]') && !!document.querySelector('[aria-label="View: Production web"]')`)
    assert.equal(settings.hostViews.length, 1)
    assert.equal(settings.hostViews[0].filters.search, 'web-prod')
    assert.equal(settings.hostViews[0].filters.stateFilter, 'running')
    await js(`document.querySelector('[aria-label="View: All hosts"]').click()`)
    await until(`!!document.querySelector('[data-host-key="${stopped.key}"]')`)
    await js(`localStorage.setItem('ui.recentHosts', ${JSON.stringify(JSON.stringify([running.key, stale.key, 'missing/host']))})`)
    await win.loadFile(resolve('out/renderer/index.html'))
    await until(`!!document.querySelector('[aria-label="View: Production web"]')`)
    assert.equal(await js(`document.querySelectorAll('.quick-host-card').length`), 2, 'recents exclude missing hosts and deduplicate favorites')
    await key('k', { metaKey: true })
    await until(`!!document.querySelector('[role="combobox"]')`)
    await setInput('[role="combobox"]', '> Host view: Production web')
    await until(`document.querySelectorAll('[role="option"]').length === 1`)
    await key('Enter')
    await until(`!document.querySelector('[role="dialog"]') && document.querySelector('[aria-label="Search hosts"]').value === 'web-prod'`)
    assert.equal(await js(`document.querySelector('[aria-label="View: Production web"]').getAttribute('aria-pressed')`), 'true')
    await js(`document.querySelector('[aria-label="Manage saved views"]').click()`)
    await until(`!!document.querySelector('[aria-label="Rename Production web"]')`)
    await js(`document.querySelector('[aria-label="Rename Production web"]').click()`)
    await until(`!!document.querySelector('#host-view-name')`)
    await setInput('#host-view-name', 'Production focus')
    await js(`document.querySelector('[role="dialog"] form').requestSubmit()`)
    await until(`!document.querySelector('[role="dialog"]') && !!document.querySelector('[aria-label="View: Production focus"]')`)
    assert.equal(settings.hostViews[0].filters.search, 'web-prod', 'renaming preserves filters')
    await screenshot('hosts-saved-view.png')
    await js(`document.querySelector('[aria-label="View: Running"]').click()`)
    const rowHeight = await js(`document.querySelector('tr.row').getBoundingClientRect().height`)
    await js(`document.querySelector('[aria-label="Compact host rows"]').click()`)
    await until(`document.querySelector('.hosts-page').classList.contains('density-compact')`)
    assert.ok(await js(`document.querySelector('tr.row').getBoundingClientRect().height`) < rowHeight, 'compact density gives more rows room')
    assert.equal(settings.hostDensity, 'compact')
    await win.loadFile(resolve('out/renderer/index.html'))
    await until(`document.querySelector('.hosts-page')?.classList.contains('density-compact')`)
    await js(`document.querySelector('[aria-label="Compact host rows"]').click()`)
    await until(`!document.querySelector('.hosts-page').classList.contains('density-compact')`)
    await screenshot('hosts-workspace-dark.png')
    await js(`document.documentElement.dataset.theme = 'light'`)
    await screenshot('hosts-workspace-light.png')
    await js(`document.documentElement.dataset.theme = 'dark'`)
    await js(`document.querySelector('[aria-label="Manage saved views"]').click()`)
    await until(`!!document.querySelector('[aria-label="Delete Production focus"]')`)
    await js(`document.querySelector('[aria-label="Delete Production focus"]').click()`)
    await until(`!document.querySelector('[aria-label="Delete Production focus"]')`)
    assert.deepEqual(settings.hostViews, [])
    await key('Escape')
    await until(`!document.querySelector('[role="dialog"]') && document.querySelectorAll('[data-host-key]').length === 3`)
    // Every row has the same action slots, so the SSH / RDP buttons line up down the column (a stopped host's Start sits
    // to their left), and the labels fit their slots.
    const primaries = await js(`[...document.querySelectorAll('.row-acts')].map((r) => { const b = r.querySelector('.act-main').getBoundingClientRect(); return [Math.round(b.left), Math.round(b.right)] })`)
    assert.ok(primaries.length >= 2 && primaries.every((p) => p[0] === primaries[0][0] && p[1] === primaries[0][1]), `primary actions line up: ${JSON.stringify(primaries)}`)
    assert.equal(await js(`[...document.querySelectorAll('.act-main, button.act-files')].every((b) => b.scrollWidth <= b.clientWidth)`), true, 'action labels fit their slots')
    assert.equal(await js(`document.querySelector('.titlebar .brand-name').textContent`), 'Remote Access Tool')
    assert.equal(await js(`getComputedStyle(document.querySelector('thead th button')).textTransform`), 'uppercase', 'sortable headers match the others')

    // Health: the platform per environment. An outage leads the headline, environments switch, an issue jumps to its
    // section, stopped servers are only noted, and the page never scrolls sideways.
    await js(`document.querySelector('button[aria-label="Health"]').click()`)
    await until(`!!document.querySelector('.hl-hero') && document.querySelectorAll('.hl-env').length === 3`)
    assert.equal(await js(`document.querySelector('.hl-headline').textContent`), '3DPassport is down')
    assert.equal(await js(`document.querySelectorAll('.hl-svc').length`), 4)
    assert.equal(await js(`document.querySelector('.hl-svc.lvl-warn .hl-pill').textContent`), 'Degraded', 'one server down is degraded, not down')
    assert.equal(await js(`document.querySelector('.sidebar')?.getClientRects().length ?? 0`), 0, 'the hosts sidebar steps aside')
    assert.equal(await js(`(() => { const h = document.querySelector('.hl'); return h.scrollWidth <= h.clientWidth + 1 })()`), true, 'no sideways scrolling')
    assert.ok((await js(`document.querySelector('.hl-alert.lvl-off')`)) === null, 'alerts about stopped servers start hidden')
    // The checks as Grafana runs them, as two honeycombs: through the load balancer (ALB) and on each server (HTTP).
    // Red where a check fails, grey on a stopped server; pointing says what it checks and which machine, a click goes.
    await until(`document.querySelectorAll('.hl-hive.alb .hl-hex').length === 4 && document.querySelectorAll('.hl-hive.http .hl-hex').length === 8`)
    assert.equal(await js(`document.querySelectorAll('.hl-hive.alb .hl-hex.lvl-crit').length`), 1, 'the failing load balancer check')
    assert.equal(await js(`document.querySelectorAll('.hl-hive.http .hl-hex.lvl-crit').length`), 2, 'two failing server checks')
    assert.equal(await js(`document.querySelectorAll('.hl-hive.http .hl-hex.lvl-off').length`), 1, 'a stopped server\'s check is set apart')
    assert.match(await js(`document.querySelector('.hl-hive.alb .hl-hive-score').textContent`), /^3of 4 healthy$/)
    assert.match(await js(`document.querySelector('.hl-hive.http .hl-hive-score').textContent`), /^5of 7 healthy$/)
    await js(`document.querySelector('.hl-hive.alb .hl-hex.lvl-crit').dispatchEvent(new PointerEvent('pointerover', { pointerType: 'mouse', bubbles: true }))`)
    await until(`!!document.querySelector('.hl-hive.alb .hl-hex-tip')`)
    const albTip = await js(`document.querySelector('.hl-hex-tip').textContent`)
    for (const want of ['3DPassport', 'Through the load balancer', 'pass-prod.example.com/3dpassport/healthcheck', 'No answer', '106 days', 'Click to see its service']) assert.ok(albTip.includes(want), `the ALB tip says ${want}: ${albTip}`)
    await js(`document.querySelector('.hl-hive.alb .hl-hex.lvl-crit').dispatchEvent(new PointerEvent('pointerout', { pointerType: 'mouse', bubbles: true }))`)
    await js(`document.querySelector('.hl-hive.http .hl-hex[data-ip="10.9.0.12"]').dispatchEvent(new PointerEvent('pointerover', { pointerType: 'mouse', bubbles: true }))`)
    await until(`!!document.querySelector('.hl-hive.http .hl-hex-tip')`)
    const httpTip = await js(`document.querySelector('.hl-hex-tip').textContent`)
    for (const want of ['3DSpace 02', '3dspace-02', '10.9.0.12', 'Unhealthy', 'No answer', 'Memory at 83%', 'Click to see its server under Servers']) assert.ok(httpTip.includes(want), `the HTTP tip says ${want}: ${httpTip}`)
    await js(`document.querySelector('#hl-checks').scrollIntoView()`)
    await new Promise((r) => setTimeout(r, 500))
    await screenshot('health-hive.png')
    await js(`document.querySelector('.hl-hive.http .hl-hex[data-ip="10.9.0.12"]').dispatchEvent(new PointerEvent('pointerout', { pointerType: 'mouse', bubbles: true }))`)
    // A full shared store is the store's problem (under Storage), not the machines that mount it.
    await js(`document.querySelector('.hl-hive.http .hl-hex[data-ip="10.9.0.51"]').dispatchEvent(new PointerEvent('pointerover', { pointerType: 'mouse', bubbles: true }))`)
    await until(`!!document.querySelector('.hl-hex-tip') && document.querySelector('.hl-hex-tip').textContent.includes('File Collaboration Server 01')`)
    assert.ok(await js(`document.querySelector('.hl-hive.http .hl-hex[data-ip="10.9.0.51"]').classList.contains('lvl-ok')`), 'the FCS check stays healthy')
    assert.match(await js(`document.querySelector('.hl-hex-tip').textContent`), /Shared store \/filestore is 86% full: counted under Storage/)
    await js(`document.querySelector('.hl-hive.http .hl-hex[data-ip="10.9.0.51"]').dispatchEvent(new PointerEvent('pointerout', { pointerType: 'mouse', bubbles: true }))`)
    await js(`document.documentElement.setAttribute('data-theme', 'light')`)
    await screenshot('health-hive-light.png')
    await js(`document.documentElement.setAttribute('data-theme', 'dark')`)
    const clickHex = (sel) => js(`(() => { const g = document.querySelector('${sel}'); g.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'mouse', bubbles: true })); g.dispatchEvent(new MouseEvent('click', { bubbles: true })) })()`)
    await clickHex('.hl-hive.http .hl-hex[data-ip="10.9.0.12"]')
    await until(`!!document.querySelector('.hl-srv.lit[data-ip="10.9.0.12"]') && !document.querySelector('.hl-hex-tip')`)
    await clickHex('.hl-hive.alb .hl-hex.lvl-crit')
    await until(`document.querySelector('.hl').dataset.flash === 'services'`)
    // Lighting up one status from the legend dims the rest of that comb.
    await js(`[...document.querySelectorAll('.hl-hive.http .hl-hive-legend button')].find((b) => b.textContent.startsWith('Unhealthy')).click()`)
    assert.equal(await js(`document.querySelectorAll('.hl-hive.http .hl-hex.dim').length`), 6)
    assert.equal(await js(`document.querySelectorAll('.hl-hive.alb .hl-hex.dim').length`), 0)
    await js(`[...document.querySelectorAll('.hl-hive.http .hl-hive-legend button')].find((b) => b.textContent.startsWith('Unhealthy')).click()`)
    assert.equal(await js(`document.querySelectorAll('.hl-hex.dim').length`), 0)
    await js(`document.querySelector('.hl').scrollTop = 0`)
    // Who is signed in and the kernel's own memory, live from each 3DSpace server; the license server beside them.
    await until(`!!document.querySelector('.hl-kernel') && document.querySelectorAll('.hl-user').length === 7 && !!document.querySelector('.hl-license')`)
    // The banner counts each person once across the servers; the machines tile matches the honeycomb.
    const kpi = (label) => js(`(() => { const k = [...document.querySelectorAll('.hl-kpi')].find((b) => b.querySelector('.hl-kpi-label').textContent === '${label}'); return k.querySelector('.hl-kpi-value').textContent + '|' + (k.querySelector('.hl-kpi-note')?.textContent ?? '') })()`)
    assert.equal(await kpi('Signed in'), '3|1 on both servers')
    assert.equal(await js(`document.querySelector('.hl-kpi-note') && [...document.querySelectorAll('.hl-kpi-note')].every((n) => n.scrollWidth <= n.clientWidth)`), true, 'tile notes fit')
    assert.equal(await kpi('Machines'), '5/7|healthy')
    assert.match(await js(`document.querySelector('#hl-kernel').textContent`), /3 people signed in now \(1 on more than one server, counted once\)/)
    assert.equal(await js(`document.querySelectorAll('.hl-kpi').length`), 8)
    // The kernel's memory over time where Prometheus records it: three lines, the restart, a readout; none for 02.
    await until(`document.querySelectorAll('.hl-kchart svg').length === 1 && document.querySelectorAll('.hl-kline.allocated').length > 0`)
    assert.ok(await js(`!!document.querySelector('.hl-kchart .hl-chart-restart') && !!document.querySelector('.hl-kchart .hl-kchart-before')`), 'the restart and the start of recording are marked')
    assert.match(await js(`document.querySelectorAll('.hl-kernel')[0].querySelector('.hl-kernel-mem .hl-metric-note').textContent`), /since the restart at/)
    assert.match(await js(`document.querySelectorAll('.hl-kernel')[1].querySelector('.hl-kernel-mem').textContent`), /No history for this server/)
    await js(`(() => { const s = document.querySelector('.hl-kchart svg'); const r = s.getBoundingClientRect(); s.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + r.width * 0.8, clientY: r.top + 50, bubbles: true })) })()`)
    await until(`!!document.querySelector('.hl-kchart .hl-chart-tip') && document.querySelector('.hl-kchart .hl-chart-tip').textContent.includes('In use') && document.querySelector('.hl-kchart .hl-chart-tip').textContent.includes('Contexts')`)
    await js(`document.querySelector('#hl-kernel').scrollIntoView()`)
    await new Promise((r) => setTimeout(r, 300))
    await screenshot('health-kernel-memory.png')
    await js(`document.querySelector('.hl-kchart svg').dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }))`)
    await js(`[...document.querySelectorAll('.hl-kernel-mem .hl-seg button')].find((b) => b.textContent === '7d').click()`)
    for (let k = 0; k < 100 && !calls.some((c) => c.channel === 'health:kernelMemory' && c.args[1] === 168); k++) await new Promise((r) => setTimeout(r, 30))
    assert.ok(calls.some((c) => c.channel === 'health:kernelMemory' && c.args[1] === 168), 'the week asked for')
    await js(`document.querySelector('.hl').scrollTop = 0`)
    assert.match(await js(`document.querySelector('.hl-signed-now').textContent`), /2people signed in/)
    assert.ok(await js(`[...document.querySelectorAll('.hl-user.system')].length === 2 && [...document.querySelectorAll('.hl-user.service')].length === 1`), 'system and service accounts set apart')
    // Every machine's memory on one scale, one crosshair through them all.
    await until(`document.querySelectorAll('.hl-mem').length === 4`)
    assert.ok(await js(`[...document.querySelectorAll('.hl-sec-controls .hl-seg button')].some((b) => b.textContent.startsWith('Stopped1'))`), 'stopped machines wait behind a filter')
    await js(`(() => { const c = document.querySelectorAll('.hl-mem-chart')[1]; const r = c.getBoundingClientRect(); c.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + r.width / 2, clientY: r.top + 20, bubbles: true })) })()`)
    await until(`document.querySelectorAll('.hl-mem-cross').length === 4 && !!document.querySelector('.hl-mem-tip')`)
    assert.ok(calls.some((c) => c.channel === 'health:memory' && c.args[0] === 'prod'), 'the environment shown is asked for')
    // Every health-check URL behind the cards, as Grafana's HTTP monitoring table lists them.
    await js(`[...document.querySelectorAll('.hl-link')].find((b) => b.textContent.startsWith('All health checks')).click()`)
    await until(`document.querySelectorAll('.hl-chk').length === 12`)
    assert.ok(await js(`[...document.querySelectorAll('.hl-chk')].some((r) => r.textContent.includes('pass-prod.example.com/3dpassport/healthcheck') && r.textContent.includes('no answer'))`), 'a failing check reads no answer')
    assert.ok(await js(`[...document.querySelectorAll('.hl-chk.off')].some((r) => r.textContent.includes('stopped'))`), 'a stopped server\'s check is set aside')
    await js(`[...document.querySelectorAll('.hl-link')].find((b) => b.textContent.startsWith('Hide health checks')).click()`)
    // The heap chart: GCeasy's saw-tooth with a triangle at every full collection, a range switch and a readout.
    await until(`!!document.querySelector('.hl-jvm-panel .hl-heap svg') && document.querySelectorAll('.hl-gc-mark').length >= 20`)
    assert.match(await js(`document.querySelector('.hl-jvm-panel .hl-verdict').textContent`), /Healthy saw-tooth/)
    const gcAsks = () => calls.filter((c) => c.channel === 'health:gc').map((c) => c.args[1])
    assert.ok(gcAsks().includes(24), 'a day by default')
    await js(`[...document.querySelectorAll('.hl-jvm-panel .hl-seg button')].find((b) => b.textContent === '7d').click()`)
    await until(`document.querySelector('.hl-jvm-panel .hl-seg button.on').textContent === '7d' && document.querySelectorAll('.hl-gc-tick, .hl-gc-mark').length > 0`)
    assert.ok(gcAsks().includes(168), 'the week asked for')
    await js(`document.querySelector('.hl-jvm-panel .hl-seg button').click()`)
    await until(`document.querySelector('.hl-jvm-panel .hl-seg button.on').textContent === '1h' && document.querySelectorAll('.hl-gc-mark').length >= 1`)
    assert.ok(gcAsks().includes(1), 'the last hour at full resolution')
    await js(`(() => { const s = document.querySelector('.hl-jvm-panel .hl-heap svg'); const r = s.getBoundingClientRect(); s.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + r.width * 0.6, clientY: r.top + 60, bubbles: true })) })()`)
    await until(`!!document.querySelector('.hl-chart-tip') && document.querySelector('.hl-chart-tip').textContent.includes('After GC')`)
    await js(`document.querySelector('#hl-jvm').scrollIntoView()`)
    await screenshot('health-gc.png')
    await js(`[...document.querySelectorAll('.hl-jvm-panel .hl-seg button')].find((b) => b.textContent === '24h').click()`)
    await js(`document.querySelector('.hl').scrollTop = 0`)
    await screenshot('health-dark.png')
    await js(`document.documentElement.setAttribute('data-theme', 'light')`)
    await screenshot('health-light.png')
    await js(`document.documentElement.setAttribute('data-theme', 'dark')`)
    await js(`[...document.querySelectorAll('.hl-issues button')].find((b) => b.textContent.includes('/filestore')).click()`)
    await until(`document.querySelector('.hl').dataset.flash === 'storage'`)
    await js(`[...document.querySelectorAll('#hl-servers .hl-seg button')].find((b) => b.textContent.startsWith('Stopped')).click()`)
    await until(`document.querySelectorAll('.hl-srv').length === 1 && document.querySelector('.hl-srv').classList.contains('off')`)
    await js(`[...document.querySelectorAll('.hl-env')].find((b) => b.textContent.startsWith('QA')).click()`)
    await until(`document.querySelector('.hl-headline').textContent === 'All systems operational'`)
    assert.equal(await js(`document.querySelector('.hl-svc .hl-svc-summary').textContent`), 'Up · 1 stopped', 'a stopped server is noted, not counted')
    await js(`[...document.querySelectorAll('.hl-env')].find((b) => b.textContent.startsWith('Production')).click()`)
    await until(`document.querySelector('.hl-headline').textContent === '3DPassport is down'`)
    // ⌘W closes it like any tool tab, back to the hosts.
    await key('w', { metaKey: true })
    await until(`!document.querySelector('.hl') && document.querySelectorAll('[data-host-key]').length === 3`)
    assert.equal(await js(`!!document.querySelector('[data-host-key="${stopped.key}"]')`), false, 'running filter initially hides stopped host')

    // The radial menu: every section in a ring around the pointer, on ⇧⌘Space. Held: tap again to step, let go to open.
    const radialKey = (mods = { metaKey: true, shiftKey: true }) => key(' ', mods)
    const keyUp = () => js(`(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta', bubbles: true, cancelable: true }))`)
    await js(`document.dispatchEvent(new PointerEvent('pointermove', { clientX: 760, clientY: 470, bubbles: true }))`)
    await radialKey()
    await until(`!!document.querySelector('.radial') && document.querySelectorAll('.radial-item').length === 14`)
    assert.ok(await js(`document.querySelector('.radial-item.here').dataset.radial === 'hosts' && document.querySelector('.radial-center strong').textContent === 'Hosts'`), 'it starts on the section in front')
    assert.equal(await js(`document.activeElement === document.querySelector('.radial')`), true, 'the ring takes the keyboard')
    await new Promise((r) => setTimeout(r, 400))
    await screenshot('radial-dark.png')
    await js(`document.documentElement.setAttribute('data-theme', 'light')`)
    await screenshot('radial-light.png')
    await js(`document.documentElement.setAttribute('data-theme', 'dark')`)
    await radialKey()
    await radialKey()
    // Overview is skipped while no session is open; two steps from Hosts land on Health.
    assert.equal(await js(`document.querySelector('.radial-item.on').dataset.radial`), 'local')
    await radialKey()
    await js(`(() => { const e = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true, metaKey: true, shiftKey: true }); document.activeElement.dispatchEvent(e) })()`)
    assert.equal(await js(`document.querySelector('.radial-item.on').dataset.radial`), 'local')
    await js(`(() => { const e = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true, metaKey: true, shiftKey: true }); document.activeElement.dispatchEvent(e) })()`)
    assert.equal(await js(`document.querySelector('.radial-item.on').dataset.radial`), 'health')
    await keyUp()
    await until(`!document.querySelector('.radial') && !!document.querySelector('.hl')`)
    await key('w', { metaKey: true })
    await until(`!document.querySelector('.hl')`)
    // Tapped and let go: it stays for a click or the keys; Esc closes it and nothing changes.
    await radialKey()
    await until(`!!document.querySelector('.radial')`)
    await keyUp()
    assert.equal(await js(`!!document.querySelector('.radial')`), true, 'a tap keeps it open')
    assert.match(await js(`document.querySelector('.radial-hint').textContent`), /Click/)
    await key('Escape')
    await until(`!document.querySelector('.radial')`)
    // A first letter that only one section has opens it; a click on a bubble opens that one.
    await radialKey()
    await until(`!!document.querySelector('.radial')`)
    await keyUp()
    await key('w')
    await until(`!document.querySelector('.radial') && !!document.querySelector('.board')`)
    await key('w', { metaKey: true })
    await until(`!document.querySelector('.board')`)
    await radialKey()
    await until(`!!document.querySelector('.radial')`)
    await keyUp()
    await new Promise((r) => setTimeout(r, 350)) // a press right as it opens never chooses
    await js(`document.querySelector('[data-radial="hosts"]').dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }))`)
    await until(`!document.querySelector('.radial') && document.querySelector('.rail-item[aria-label="Hosts"]').getAttribute('aria-current') === 'page'`)
    // Pointing only highlights: a bubble pointed at while the keys are still down does not open when they are let go
    // (a mouse button lets go at once, and Chromium reports a pointer move as the ring appears). Only a click chooses.
    await radialKey()
    await until(`!!document.querySelector('.radial')`)
    await new Promise((r) => setTimeout(r, 400))
    await js(`(() => { const b = document.querySelector('[data-radial="health"]').getBoundingClientRect(); document.querySelector('.radial').dispatchEvent(new PointerEvent('pointermove', { clientX: b.left + b.width / 2, clientY: b.top + b.height / 2, bubbles: true, metaKey: true, shiftKey: true })) })()`)
    await until(`document.querySelector('.radial-item.on')?.dataset.radial === 'health'`)
    await keyUp()
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(await js(`!!document.querySelector('.radial') && !document.querySelector('.hl')`), true, 'letting go after pointing chooses nothing')
    // A click in the middle, or with another mouse button, chooses nothing either.
    await js(`(() => { const r = document.querySelector('.radial-ring').getBoundingClientRect(); const root = document.querySelector('.radial'); root.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, button: 0 })); root.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + 10, clientY: r.top + r.height / 2, bubbles: true, button: 3 })) })()`)
    assert.equal(await js(`!!document.querySelector('.radial') && !document.querySelector('.hl')`), true, 'the middle and side buttons choose nothing')
    await key('Escape')
    await until(`!document.querySelector('.radial')`)
    // A mouse button that sends the shortcut (Razer Synapse) presses and lets go at once, before the ring is drawn: it
    // opens where the pointer really is (app:pointer), stays open, and the mouse points and clicks.
    await radialKey(); await keyUp()
    await until(`!!document.querySelector('.radial')`)
    assert.equal(await js(`(() => { const r = document.querySelector('.radial-ring').getBoundingClientRect(); return Math.round(r.left + r.width / 2) + ',' + Math.round(r.top + r.height / 2) })()`), '640,420', 'it opens at the pointer')
    await new Promise((r) => setTimeout(r, 400)) // the bubbles finish flying out
    await js(`(() => { const b = document.querySelector('[data-radial="health"]').getBoundingClientRect(); const root = document.querySelector('.radial'); const o = { clientX: b.left + b.width / 2, clientY: b.top + b.height / 2, bubbles: true, button: 0 }; root.dispatchEvent(new PointerEvent('pointermove', o)); root.dispatchEvent(new PointerEvent('pointerdown', o)) })()`)
    await until(`!document.querySelector('.radial') && !!document.querySelector('.hl')`)
    await key('w', { metaKey: true })
    await until(`!document.querySelector('.hl')`)
    // Tapped open, the shortcut again closes it.
    await radialKey()
    await until(`!!document.querySelector('.radial')`)
    await keyUp()
    await radialKey({ metaKey: true, shiftKey: true })
    await until(`!document.querySelector('.radial')`)

    // Service control from a host's menu: the units the server has, production asks for PROD, a restart is verified.
    await js(`(() => { const row = document.querySelector('[data-host-key="${running.key}"]'); row.scrollIntoView({ block: 'center' }); const r = row.getBoundingClientRect(); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 200, clientY: r.top + 10 })) })()`)
    await until(`!!document.querySelector('body > .panel.modal.fixed')`)
    await js(`[...document.querySelectorAll('body > .panel.modal.fixed button')].find((b) => b.textContent === 'Services…').click()`)
    await until(`!!document.querySelector('.svc-row[data-unit="3dspace.service"]') && !!document.querySelector('.svc-row[data-unit="tif.service"]')`)
    assert.ok(calls.some((c) => c.channel === 'services:status' && c.args[0].includes(running.key)), 'the server is asked for its units')
    assert.equal(await js(`!!document.querySelector('.svc-prod')`), true, 'a production account is marked')
    assert.match(await js(`document.querySelector('.svc-row[data-unit="tif.service"]').textContent`), /Failed.*Start/)
    assert.match(await js(`document.querySelector('.svc-row[data-unit="3dspace.service"]').textContent`), /Running.*up 2d 0h.*6\.1 GB.*Restart/)
    await js(`[...document.querySelector('.svc-row[data-unit="3dspace.service"]').querySelectorAll('button')].find((b) => b.textContent.includes('Restart')).click()`)
    await until(`!!document.querySelector('.svc-confirm')`)
    const goBtn = `[...document.querySelectorAll('.svc-confirm button')].find((b) => b.textContent.startsWith('Restart'))`
    assert.equal(await js(`${goBtn}.disabled`), true, 'production waits for PROD to be typed')
    await js(`(() => { const i = document.querySelector('.svc-type'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'PROD'); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await until(`${goBtn}.disabled === false`)
    await js(`${goBtn}.click()`)
    await until(`!!document.querySelector('.svc-job') && document.querySelector('.svc-step')?.classList.contains('done')`)
    const runCall = calls.find((c) => c.channel === 'services:run')
    assert.deepEqual([runCall.args[0].action, runCall.args[0].verify, runCall.args[0].targets[0].unit, runCall.args[0].targets[0].serviceId], ['restart', true, '3dspace.service', 'space'])
    assert.match(await js(`document.querySelector('.svc-step').textContent`), /health check passes/)
    await screenshot('services.png')
    // The log, and who did what.
    await js(`document.querySelector('.svc-row[data-unit="3dspace.service"] [aria-label^="More for"]').click()`)
    await until(`!!document.querySelector('.popover')`)
    await js(`[...document.querySelectorAll('.popover button')].find((b) => b.textContent === 'Show the log').click()`)
    await until(`document.querySelector('.svc-log')?.textContent.includes('Server startup in')`)
    await js(`[...document.querySelectorAll('.svc-head button')].find((b) => b.textContent.includes('Services')).click()`)
    await js(`[...document.querySelectorAll('.svc-head button')].find((b) => b.textContent.includes('History')).click()`)
    await until(`document.querySelectorAll('.svc-hist').length >= 1 && document.querySelector('.svc-hist').textContent.includes('3dspace.service')`)
    await js(`document.querySelector('.svc-head [aria-label="Close dialog"]').click()`)
    await until(`!document.querySelector('.svc')`)
    // Settings → Services lists the install sheet's services and their units.
    await key(',', { metaKey: true })
    await until(`!!document.querySelector('.settings-nav-item[data-section="services"]')`)
    await js(`document.querySelector('.settings-nav-item[data-section="services"]').click()`)
    await until(`document.querySelectorAll('.svc-def').length === 10`)
    assert.ok(await js(`[...document.querySelectorAll('.svc-def input')].some((i) => i.value === 'thbtasklist.service 3dspaceDerivedconverter.service')`), 'a service with two units')
    await js(`document.querySelector('.settings [aria-label="Close dialog"]').click()`)
    await until(`!document.querySelector('.settings')`)

    // Text size per section: the sidebar matches the table's 12px; pointing at it and pressing ⌘− shrinks only it,
    // keeping its width on screen; the footer's Aa sizes either section; menus still open at the pointer when zoomed.
    assert.equal(await js(`getComputedStyle(document.querySelector('.sidebar .nav-row')).fontSize`), '12px')
    const sideBox = await js(`(() => { const r = document.querySelector('.sidebar').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 300, w: Math.round(r.width) } })()`)
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(sideBox.x), y: Math.round(sideBox.y) })
    await until(`!!document.querySelector('[data-zoom-section="sidebar"]:hover')`)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: '-', modifiers: ['meta'] })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: '-', modifiers: ['meta'] })
    await until(`document.documentElement.style.getPropertyValue('--zoom-sidebar') === '0.95' && !!document.querySelector('.zoom-badge')`)
    assert.equal(settings.sectionZoom.sidebar, 0.95)
    assert.equal(settings.sectionZoom.hosts, undefined, 'the hosts list keeps its size')
    // The width animates (150 ms), so wait for it to come back to where it was.
    await until(`Math.abs(Math.round(document.querySelector('.sidebar').getBoundingClientRect().width) - ${sideBox.w}) <= 1`)
    await js(`document.querySelector('button[aria-label="Text size"]').click()`)
    await until(`document.querySelectorAll('.popover .zoom-stepper').length === 2`)
    await js(`document.querySelector('.popover [aria-label="Larger hosts list text"]').click()`)
    await js(`document.querySelector('.popover [aria-label="Larger hosts list text"]').click()`)
    await until(`document.documentElement.style.getPropertyValue('--zoom-hosts') === '1.2'`)
    await screenshot('section-zoom.png')
    await key('Escape')
    // The right-click menu lands at the pointer even inside the zoomed hosts list (on a row in view, as a person would).
    await js(`document.querySelector('[data-host-key="${running.key}"]').scrollIntoView({ block: 'center' })`)
    await js(`(() => { const row = document.querySelector('[data-host-key="${running.key}"]'); const r = row.getBoundingClientRect(); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 200, clientY: r.top + 10 })) })()`)
    await until(`!!document.querySelector('body > .panel.modal.fixed')`)
    assert.equal(await js(`(() => { const row = document.querySelector('[data-host-key="${running.key}"]').getBoundingClientRect(); const m = document.querySelector('body > .panel.modal.fixed').getBoundingClientRect(); const y = row.top + 10; const expectedTop = y + m.height > innerHeight - 8 ? Math.max(8, y - m.height) : y; return Math.abs(m.left - (row.left + 200)) < 3 && Math.abs(m.top - expectedTop) < 3 && m.bottom <= innerHeight })()`), true, 'context menu opens at the pointer or flips up to fit the window')
    await key('Escape')
    await js(`document.querySelector('button[aria-label="Text size"]').click()`)
    await until(`document.querySelectorAll('.popover .zoom-stepper').length === 2`)
    await js(`document.querySelectorAll('.popover .zoom-stepper-value').forEach((b) => b.click())`)
    await until(`document.documentElement.style.getPropertyValue('--zoom-hosts') === '1' && document.documentElement.style.getPropertyValue('--zoom-sidebar') === '1'`)
    await key('Escape')

    // Remote desktop keyboard: the viewer sends a key only while its own wrapper is the first element of its shadow
    // root. The app's styles once went in as a <style> element ahead of it, and no key reached Windows (the mouse did).
    await js(`(() => { const row = document.querySelector('[data-host-key="${running.key}"]'); const r = row.getBoundingClientRect(); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 200, clientY: r.top + 10 })) })()`)
    await until(`!!document.querySelector('body > .panel.modal.fixed')`)
    await js(`[...document.querySelectorAll('body > .panel.modal.fixed button')].find((b) => b.textContent === 'RDP with options…').click()`)
    await until(`!!document.querySelector('[role="dialog"] input[type="password"]')`)
    await js(`(() => { const pw = document.querySelector('[role="dialog"] input[type="password"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(pw, 'fixture-pw'); pw.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await js(`document.querySelector('[role="dialog"] .btn-primary').click()`)
    await until(`!!document.querySelector('iron-remote-desktop')?.shadowRoot?.querySelector('canvas')`)
    assert.equal(await js(`(() => {
      const n = document.querySelector('iron-remote-desktop')
      n.shadowRoot.querySelectorAll('.hidden').forEach((x) => x.classList.remove('hidden')) // as once connected
      n.shadowRoot.querySelector('canvas').focus()
      return document.activeElement === n && n.shadowRoot.firstElementChild === n.shadowRoot.querySelector('div') && n.shadowRoot.adoptedStyleSheets.length > 0
    })()`), true, 'a clicked remote desktop takes the keyboard, with the app styles applied')
    await key('w', { metaKey: true })
    await until(`!document.querySelector('iron-remote-desktop')`)

    // Open account tree and select a stopped host: filters and collapsed groups must not hide it.
    await js(`document.querySelector('button[title="Show instances"]').click()`)
    await click('worker-stopped')
    await until(`!!document.querySelector('[data-host-key="${stopped.key}"]') && !!document.querySelector('.host-details')`)
    assert.equal(await js(`document.querySelector('.host-details').textContent.includes('worker-stopped')`), true)
    await js(`document.querySelector('[aria-label="Close host details"]').click()`)

    // Favorites must not stick when switching account scope.
    await click('Favorites')
    await js(`document.querySelector('button[data-accent="emerald"]').click()`)
    await until(`document.querySelectorAll('[data-host-key]').length === 1`)
    assert.equal(await js(`document.querySelector('[data-host-key]').dataset.hostKey`), stale.key)
    await click('Clear filters')

    // Keyboard switcher, details shortcut, and Escape/focus restoration.
    await js(`document.querySelector('[aria-label="Open quick switcher"]').focus()`)
    await key('k', { metaKey: true })
    await until(`!!document.querySelector('[role="combobox"]')`)
    await js(`(() => { const input = document.querySelector('[role="combobox"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'worker-stopped'); input.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await until(`document.querySelectorAll('[role="option"]').length === 1`)
    await screenshot('quick-switcher.png')
    await key('Enter', { shiftKey: true })
    await until(`!document.querySelector('[role="dialog"]') && document.querySelector('.host-details')?.textContent.includes('worker-stopped')`)
    await js(`document.querySelector('[aria-label="Close host details"]').click()`)
    await key('k', { metaKey: true })
    await until(`!!document.querySelector('[role="dialog"]')`)
    await key('Escape')
    await until(`!document.querySelector('[role="dialog"]')`)
    assert.equal(await js(`document.activeElement.getAttribute('aria-label')`), 'Open quick switcher')

    // Details fit at the minimum window size in both themes.
    await click('web-dev-01')
    win.setSize(960, 600)
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(await js(`(() => { const r = document.querySelector('.host-details').getBoundingClientRect(); return r.right <= innerWidth && r.bottom <= innerHeight })()`), true)
    await screenshot('details-small-dark.png')
    await js(`document.documentElement.setAttribute('data-theme', 'light')`)
    await screenshot('details-small-light.png')
    await js(`document.querySelector('[aria-label="Close host details"]').click()`)
    win.setSize(1400, 900)

    // Retry targets failed regions, rather than causing a full rescan.
    await click('Retry failed scans')
    await until(`!document.querySelector('.scan-notice')`)
    assert.deepEqual(calls.find((c) => c.channel === 'inventory:scan').args, [undefined, [{ profile: 'development', regions: ['us-east-1'] }]])

    // Failed SSH keeps its tab and buffer; reconnect opens the same session ID.
    failSsh = true
    await js(`document.querySelector('[data-host-key="${running.key}"] .btn-ssh').click()`)
    await until(`document.body.textContent.includes('Reconnect')`)
    const firstOpen = calls.find((c) => c.channel === 'ssh:open').args[0]
    const tabsBefore = await js(`document.querySelectorAll('.tab').length`)
    await js(`document.querySelector('.xterm-helper-textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }))`)
    assert.equal(await js(`document.querySelectorAll('.tab').length`), tabsBefore)
    failSsh = false
    await click('Reconnect')
    await until(`document.body.textContent.includes('ubuntu@web-prod-01 via ssm')`)
    assert.equal(calls.filter((c) => c.channel === 'ssh:open').at(-1).args[0].sessionId, firstOpen.sessionId)
    assert.equal(await js(`localStorage.getItem('ui.recentHosts').includes('${running.key}')`), true)
    const writesBefore = calls.filter((c) => c.channel === 'ssh:write').length
    await js(`document.querySelector('.xterm-helper-textarea').focus()`)
    await key('k', { ctrlKey: true })
    await until(`!!document.querySelector('[role="combobox"]')`)
    assert.equal(calls.filter((c) => c.channel === 'ssh:write').length, writesBefore, 'switcher shortcut must not send Ctrl+K to the server')
    await key('Escape')
    await until(`!document.querySelector('[role="dialog"]')`)
    await screenshot('ssh-reconnected.png')
    const opensBeforeQuickAccess = calls.filter((c) => c.channel === 'ssh:open').length
    await js(`document.querySelector('button[aria-label="Hosts"]').click()`)
    await until(`!!document.querySelector('.quick-host-card[aria-label="Return to SSH: web-prod-01"]')`)
    await js(`document.querySelector('.quick-host-card[aria-label="Return to SSH: web-prod-01"]').click()`)
    await until(`document.querySelector('.tab.on')?.textContent.includes('web-prod-01')`)
    assert.equal(calls.filter((c) => c.channel === 'ssh:open').length, opensBeforeQuickAccess, 'quick access reuses the live session')

    // Persistent shells: a new tab offers the shell an earlier session left running; Resume ends the new shell and
    // attaches the old one with its earlier output; closing the tab ends its shell.
    shellScenario = true
    const tabsBeforeShell = await js(`document.querySelectorAll('.tab').length`)
    await js(`document.querySelector('[data-host-key="${running.key}"] .btn-ssh').click()`)
    await until(`document.querySelectorAll('.tab').length === ${tabsBeforeShell + 1} && !!document.querySelector('.shells-bar')`)
    const shellTab = calls.filter((c) => c.channel === 'ssh:open').at(-1).args[0].sessionId
    assert.match(await js(`document.querySelector('.shells-bar').textContent`), /debug.*3dxadmin · bash.*idle 2 h.*3dxadmin@ip-10-1-2-144:\/etc\/systemd\/system\$/)
    await until(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Detach' && b.getClientRects().length)`)
    await screenshot('ssh-detached-shells.png')
    // A brand-new unnamed shell offers a name field, which never takes the terminal's focus.
    await until(`!!document.querySelector('.name-bar')`)
    assert.notEqual(await js(`document.activeElement?.getAttribute('aria-label')`), 'Name this session', 'the name field does not steal focus from the terminal')
    await js(`(() => { const t = document.querySelector('.name-bar input'); t.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(t, 'build'); t.dispatchEvent(new Event('input', { bubbles: true })); t.form.requestSubmit() })()`)
    await until(`!document.querySelector('.name-bar') && document.querySelector('.tab.on .shell-chip')?.textContent === 'build'`)
    assert.deepEqual(calls.filter((c) => c.channel === 'ssh:renameShell').at(-1).args, [shellTab, 'ec2ra-fresh', 'build'])
    const switches = () => calls.filter((c) => c.channel === 'ssh:switchShell')
    const opensBeforeResume = calls.filter((c) => c.channel === 'ssh:open').length
    await click('Resume')
    await until(`!document.querySelector('.shells-bar')`)
    for (let n = 0; n < 50 && !switches().length; n++) await new Promise((r) => setTimeout(r, 30))
    assert.deepEqual(switches().at(-1).args, [shellTab, 'ec2ra-old1', { endPrevious: true }], 'Resume switches in place and ends the shell the tab had just started')
    assert.equal(calls.filter((c) => c.channel === 'ssh:open').length, opensBeforeResume, 'Resume does not reconnect')
    // The resumed shell's name shows on its tab.
    await until(`document.querySelector('.tab.on .shell-chip')?.textContent === 'debug'`)
    // Sessions list: each shell by name, or by who and what runs in it and its last screen line.
    await click('Sessions')
    await until(`document.querySelectorAll('.popover .shell-item').length === 2`)
    const rowText = (i) => js(`document.querySelectorAll('.popover .shell-item')[${i}].textContent`)
    assert.match(await rowText(0), /debug.*this tab.*3dxadmin · bash.*3dxadmin@ip-10-1-2-144:\/etc\/systemd\/system\$/)
    assert.match(await rowText(1), /Unnamed session.*root · tail -f \/var\/log\/messages.*idle just now.*systemd\[1\]: Started Session 42\./)
    await screenshot('ssh-sessions-list.png')
    // Name the unnamed one from the list.
    await js(`document.querySelector('.popover button[aria-label="Rename session 2"]').click()`)
    await until(`document.activeElement?.getAttribute('aria-label') === 'Session name'`)
    await js(`(() => { const t = document.activeElement; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(t, 'indexing'); t.dispatchEvent(new Event('input', { bubbles: true })); t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })()`)
    await until(`[...document.querySelectorAll('.popover .shell-name')].some((n) => n.textContent === 'indexing')`)
    assert.deepEqual(calls.filter((c) => c.channel === 'ssh:renameShell').at(-1).args, [shellTab, 'ec2ra-other', 'indexing'])
    // A row switches this tab to that shell.
    await js(`document.querySelectorAll('.popover .shell-item')[1].click()`)
    await until(`!document.querySelector('.popover')`)
    for (let n = 0; n < 50 && switches().length < 2; n++) await new Promise((r) => setTimeout(r, 30))
    assert.deepEqual(switches().at(-1).args.slice(0, 2), [shellTab, 'ec2ra-other'])
    // A new session can be named as it starts.
    await click('Sessions')
    await until(`!!document.querySelector('.popover .shell-new-btn')`)
    await js(`document.querySelector('.popover .shell-new-btn').click()`)
    await until(`document.activeElement?.getAttribute('aria-label') === 'New session name'`)
    await js(`(() => { const t = document.activeElement; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(t, 'third'); t.dispatchEvent(new Event('input', { bubbles: true })); t.form.requestSubmit() })()`)
    for (let n = 0; n < 50 && switches().length < 3; n++) await new Promise((r) => setTimeout(r, 30))
    assert.deepEqual(switches().at(-1).args, [shellTab, null, { label: 'third' }])
    await until(`document.querySelector('.tab.on .shell-chip')?.textContent === 'third'`)
    // Open in a new tab: a tab of its own attached to that shell, on this tab's connection, replaying its history.
    const tabsBeforeOpen = await js(`document.querySelectorAll('.tab').length`)
    await click('Sessions')
    await until(`document.querySelectorAll('.popover .shell-item').length === 2`)
    await js(`document.querySelector('.popover button[aria-label^="Open"][aria-label$="in a new tab"]').click()`)
    await until(`document.querySelectorAll('.tab').length === ${tabsBeforeOpen + 1}`)
    const openedReq = calls.filter((c) => c.channel === 'ssh:open').at(-1).args[0]
    assert.deepEqual([openedReq.shellName, openedReq.shellHistory, openedReq.reuseSessionId], ['ec2ra-other', true, shellTab])
    await key('w', { metaKey: true })
    await until(`document.querySelectorAll('.tab').length === ${tabsBeforeOpen}`)
    // All sessions of this host on one screen: the other shell gets a transient tab (kept out of the tab bar) on this
    // tab's connection; Done closes it, Open keeps one as a normal tab.
    const tabsBeforeHostGrid = await js(`document.querySelectorAll('.tab').length`)
    // Every terminal already open to this machine is a tile too, plus one transient tab for the background shell.
    const hostTiles = (await js(`document.querySelectorAll('.session-panes > .session-pane').length`)) + 1
    await click('Sessions')
    await until(`!!document.querySelector('.popover .shell-all-btn')`)
    await js(`document.querySelector('.popover .shell-all-btn').click()`)
    await until(`!!document.querySelector('.host-grid-bar') && document.querySelectorAll('.session-grid > .session-pane:not(.hidden)').length === ${hostTiles}`)
    assert.equal(await js(`document.querySelectorAll('.tab').length`), tabsBeforeHostGrid, 'transient tiles stay out of the tab bar')
    const tileReq = calls.filter((c) => c.channel === 'ssh:open').at(-1).args[0]
    assert.deepEqual([tileReq.shellName, tileReq.shellHistory, tileReq.reuseSessionId], ['ec2ra-other', true, shellTab])
    assert.match(await js(`document.querySelector('.host-grid-bar').textContent`), new RegExp(`${hostTiles} sessions on this machine`))
    await screenshot('host-grid.png')
    const tileId = tileReq.sessionId
    await click('Done')
    await until(`!document.querySelector('.host-grid-bar') && !document.querySelector('[data-tab-id="${tileId}"]')`)
    assert.ok(calls.some((c) => c.channel === 'ssh:close' && c.args[0] === tileId && !c.args[1]?.endShell), 'leaving the grid detaches the tile, the session keeps running')
    await click('Sessions')
    await until(`!!document.querySelector('.popover .shell-all-btn')`)
    await js(`document.querySelector('.popover .shell-all-btn').click()`)
    await until(`document.querySelectorAll('.session-grid > .session-pane:not(.hidden)').length === ${hostTiles}`)
    const keepId = calls.filter((c) => c.channel === 'ssh:open').at(-1).args[0].sessionId
    await js(`document.querySelector('[data-tab-id="${keepId}"] .tile-head button[aria-label^="Open"]').click()`)
    await until(`!document.querySelector('.session-grid') && document.querySelectorAll('.tab').length === ${tabsBeforeHostGrid + 1}`)
    await key('w', { metaKey: true })
    await until(`document.querySelectorAll('.tab').length === ${tabsBeforeHostGrid}`)
    // A dropped tab cannot reach its host's shells, so Sessions waits until the connection is back.
    const sessionsShown = `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Sessions' && b.getClientRects().length)`
    win.webContents.send('ssh:event', { sessionId: shellTab, type: 'closed', message: 'Disconnected' })
    await until(`!${sessionsShown}`)
    await click('Reconnect')
    await until(sessionsShown)
    const callsBeforeClose = calls.length
    await click('Disconnect')
    await until(`document.querySelectorAll('.tab').length === ${tabsBeforeShell}`)
    assert.ok(calls.slice(callsBeforeClose).some((c) => c.channel === 'ssh:close' && c.args[0] === shellTab && c.args[1]?.endShell === true), 'closing the tab ends its shell')
    shellScenario = false

    // Terminal colour scheme applies live to the open SSH tab and persists through settings:set.
    await js(`document.querySelector('button[aria-label="Settings"]').click()`)
    await until(`!!document.querySelector('.settings-nav [data-section="terminal"]')`)
    await js(`document.querySelector('.settings-nav [data-section="terminal"]').click()`)
    await until(`!!document.querySelector('[role="dialog"] select option[value="dracula"]')`)
    await js(`(() => { const sel = document.querySelector('[role="dialog"] select option[value="dracula"]').closest('select'); sel.value = 'dracula'; sel.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    await until(`getComputedStyle(document.querySelector('.xterm').parentElement).backgroundColor === 'rgb(40, 42, 54)'`)
    assert.equal(calls.filter((c) => c.channel === 'settings:set').at(-1).args[0].terminalTheme, 'dracula')
    await screenshot('settings-terminal.png')
    await key('Escape')
    await until(`!document.querySelector('[role="dialog"]')`)
    await screenshot('terminal-dracula.png')

    // In-tab appearance pane: clicking a theme card applies it live and remembers the pane state.
    await js(`document.querySelector('button[title="Themes and font"]').click()`)
    await until(`!!document.querySelector('.appearance-pane')`)
    assert.equal(await js(`document.querySelector('.theme-row.on').title`), 'Dracula')
    await js(`document.querySelector('.xterm-helper-textarea').focus()`)
    await js(`(() => { const b = document.querySelector('.theme-row[title="Tokyo Night"]'); b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); b.click() })()`)
    await until(`getComputedStyle(document.querySelector('.xterm').parentElement).backgroundColor === 'rgb(26, 27, 38)'`)
    await until(`document.activeElement?.classList.contains('xterm-helper-textarea')`)
    assert.equal(calls.filter((c) => c.channel === 'settings:set').at(-1).args[0].terminalTheme, 'tokyo-night')
    await js(`document.querySelector('.pane-section:not(.as-label)').click()`)
    await until(`!!document.querySelector('#pane-terminal-fonts')`)
    await screenshot('terminal-pane.png')
    assert.equal(await js(`localStorage.getItem('ui.terminalPaneOpen')`), '1')
    await js(`document.querySelector('button[title="Hide appearance pane"]').click()`)
    await until(`!document.querySelector('.appearance-pane')`)

    // Find bar (⌘F), snippet menu, split (⌘D) with broadcast, and ⌘W closing the split pane.
    await js(`document.querySelector('.xterm-helper-textarea').focus()`)
    await key('f', { metaKey: true })
    // The find bar takes the focus, though a reconnect still in back-off from the failure above may take it back.
    await until(`!!document.querySelector('[aria-label="Find in terminal"]')`)
    await js(`document.querySelector('[aria-label="Find in terminal"]').focus()`)
    await key('Escape')
    await until(`!document.querySelector('[aria-label="Find in terminal"]')`)
    await js(`document.querySelector('button[title="Snippets"]').click()`)
    await until(`!!document.querySelector('.popover') && document.querySelector('.popover').textContent.includes('Disk usage')`)
    const writes = calls.filter((c) => c.channel === 'ssh:write').length
    await js(`document.querySelector('.popover .menu-item').click()`)
    for (let n = 0; n < 100 && calls.filter((c) => c.channel === 'ssh:write').length === writes; n++) await new Promise((r) => setTimeout(r, 30))
    assert.equal(calls.filter((c) => c.channel === 'ssh:write').at(-1).args[1], 'df -h\r', 'snippet runs with Enter')
    await js(`document.querySelector('.xterm-helper-textarea').focus()`)
    await key('d', { metaKey: true })
    await until(`document.querySelectorAll('.split-pane:not(.hidden)').length === 2`)
    await until(`document.querySelectorAll('.term-toolbar button[title^="Broadcast:"]').length >= 1`)
    await screenshot('split.png')
    await key('w', { metaKey: true })
    await until(`document.querySelectorAll('.split-pane').length === 0 && document.querySelectorAll('.tab').length === ${tabsBefore}`)

    // Many tabs: the strip overflows into "»" and the title bar must settle, not flip between layouts.
    for (let n = 0; n < 4; n++) {
      await js(`document.querySelector('.xterm-helper-textarea').focus()`)
      await key('d', { metaKey: true, shiftKey: true })
      await until(`document.querySelectorAll('.session-panes > div').length === ${n + 2}`)
    }
    // The strip flipped between layouts only when the tabs' width fell inside the band the brand frees up, so sweep
    // the window width across that band and require the title bar to settle at every width.
    const churnAt = () => js(`new Promise((resolve) => {
      let n = 0
      const mo = new MutationObserver((list) => { n += list.length })
      mo.observe(document.querySelector('.titlebar'), { subtree: true, childList: true, attributes: true })
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-tabs-crowded'] })
      setTimeout(() => { mo.disconnect(); resolve(n) }, 400)
    })`)
    for (let w = 1000; w <= 2400; w += 50) {
      win.setSize(w, 900)
      await new Promise((r) => setTimeout(r, 250))
      const churn = await churnAt()
      assert.ok(churn < 4, `title bar keeps re-laying out at width ${w} (${churn} mutations in 400 ms)`)
    }
    win.setSize(1400, 900)
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(await js(`document.documentElement.hasAttribute('data-tabs-crowded')`), true)
    await screenshot('many-tabs.png')

    // All sessions on one page: every tab becomes a live tile, the clicked tile takes the typing, ⌘0 toggles it, and
    // nothing reconnects on the way in or out.
    const opensBeforeGrid = calls.filter((c) => c.channel === 'ssh:open').length
    await js(`document.querySelector('button[title^="All sessions"]').click()`)
    await until(`document.querySelectorAll('.session-grid > .session-pane').length === 5`)
    assert.equal(await js(`[...document.querySelectorAll('.session-grid .tile-head')].every((h) => h.getBoundingClientRect().height > 20)`), true, 'every tile has a header')
    await until(`[...document.querySelectorAll('.session-grid .xterm')].every((x) => x.getBoundingClientRect().width > 200 && x.getBoundingClientRect().height > 150)`)
    assert.equal(await js(`getComputedStyle(document.querySelector('.hosts-workspace')).display`), 'none', 'the host list gives way to the grid')
    assert.equal(await js(`[...document.querySelectorAll('.session-grid .term-toolbar')].every((t) => !t.getClientRects().length)`), true, 'tiles show a header, not each terminal toolbar')
    const secondTile = await js(`document.querySelectorAll('.session-grid > .session-pane')[1].dataset.tabId`)
    await js(`document.querySelector('[data-tab-id="${secondTile}"] .xterm').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
    await until(`document.querySelector('[data-tab-id="${secondTile}"]').classList.contains('focused') && document.activeElement === document.querySelector('[data-tab-id="${secondTile}"] .xterm-helper-textarea')`)
    await js(`(() => { const t = document.activeElement; t.value = 'z'; t.dispatchEvent(new InputEvent('input', { data: 'z', inputType: 'insertText', bubbles: true })) })()`)
    for (let n = 0; n < 50 && calls.filter((c) => c.channel === 'ssh:write').at(-1)?.args[0] !== secondTile; n++) await new Promise((r) => setTimeout(r, 30))
    assert.deepEqual(calls.filter((c) => c.channel === 'ssh:write').at(-1).args, [secondTile, 'z'], 'typing goes to the focused tile')
    await screenshot('all-sessions.png')
    await key('0', { metaKey: true })
    await until(`!document.querySelector('.session-grid') && document.querySelector('[data-tab-id="${secondTile}"]').getClientRects().length > 0`)
    await key('0', { metaKey: true })
    await until(`!!document.querySelector('.session-grid')`)
    await js(`document.querySelectorAll('.session-grid .tile-head button[aria-label^="Open"]')[2].click()`)
    await until(`!document.querySelector('.session-grid') && document.querySelectorAll('.session-panes > .session-pane:not(.hidden)').length === 1`)
    assert.equal(calls.filter((c) => c.channel === 'ssh:open').length, opensBeforeGrid, 'showing and leaving the grid must not reconnect anything')
    for (let n = 0; n < 4; n++) {
      await key('w', { metaKey: true })
      await until(`document.querySelectorAll('.session-panes > div').length === ${5 - n - 1}`)
    }

    // Command mode in the switcher and the shortcuts sheet.
    await key('p', { metaKey: true, shiftKey: true })
    await until(`!!document.querySelector('[role="combobox"]') && document.querySelector('[role="combobox"]').value === '>'`)
    assert.equal(await js(`[...document.querySelectorAll('[role="option"]')].some((o) => o.textContent.includes('Rescan inventory'))`), true)
    await screenshot('commands.png')
    await key('Escape')
    await until(`!document.querySelector('[role="dialog"]')`)
    await click('Hosts')
    await js(`document.querySelector('button[aria-label="Settings"]').click()`)
    await until(`!!document.querySelector('.settings-nav [data-section="phone"]')`)
    // Every section opens from the sidebar.
    for (const id of ['general', 'accounts', 'ssh', 'notes', 'requirements', 'about']) {
      await js(`document.querySelector('.settings-nav [data-section="${id}"]').click()`)
      await until(`document.querySelector('.settings-nav-item.on')?.dataset.section === '${id}' && document.querySelectorAll('.settings-body .set-card').length > 0`)
    }
    await until(`document.querySelector('.settings-body').textContent.includes('No analytics')`)
    await screenshot('settings-about.png')
    await js(`document.querySelector('.settings-nav [data-section="general"]').click()`)
    await until(`!!document.querySelector('.settings-body [role="switch"]')`)
    await screenshot('settings-general.png')
    // A colour theme from its card repaints the app at once; Default takes the stylesheet's colours back.
    await js(`document.querySelector('[data-color-theme-option="tokyo-night"]').click()`)
    await until(`document.documentElement.dataset.colorTheme === 'tokyo-night' && document.documentElement.style.getPropertyValue('--bg') !== '' && document.querySelector('[data-color-theme-option="tokyo-night"]').getAttribute('aria-checked') === 'true'`)
    assert.equal(settings.colorTheme, 'tokyo-night')
    await new Promise((r) => setTimeout(r, 600)) // let the colour transitions finish
    await screenshot('settings-theme-tokyo-night.png')
    assert.equal(await js(`getComputedStyle([...document.querySelectorAll('.settings-foot .btn')].find((b) => b.textContent === 'Cancel')).backgroundColor`), await js(`getComputedStyle(document.querySelector('.set-card')).backgroundColor`), 'buttons take the theme panel colour')
    await js(`document.querySelector('[data-color-theme-option="default"]').click()`)
    await until(`!document.documentElement.dataset.colorTheme && document.documentElement.style.getPropertyValue('--bg') === ''`)
    // New installs use the system UI font; an explicit Monaco selection still applies to every label.
    assert.match(await js(`getComputedStyle(document.body).fontFamily`), /^-apple-system/, 'system UI font by default')
    assert.match(await js(`getComputedStyle(document.querySelector('.settings-nav-item')).fontFamily`), /^-apple-system/)
    await js(`[...document.querySelectorAll('.font-choice')].find((b) => b.textContent.includes('San Francisco')).click()`)
    await until(`getComputedStyle(document.body).fontFamily.startsWith('-apple-system')`)
    assert.equal(settings.uiFont, 'System')
    await js(`[...document.querySelectorAll('.font-choice')].find((b) => b.textContent.includes('Monaco')).click()`)
    await until(`getComputedStyle(document.body).fontFamily.startsWith('Monaco')`)
    await js(`document.querySelector('.settings-nav [data-section="phone"]').click()`)
    await until(`document.body.textContent.includes('Let my phone use this app')`)
    await until(`!!document.querySelector('img[alt="QR code for the phone link"]')`)
    assert.equal(await js(`document.body.textContent.includes('fixture-token')`), false, 'token must be masked in the settings dialog')
    assert.equal(calls.some((c) => c.channel === 'phone:status'), true, 'settings dialog asks for phone access status')
    await screenshot('settings-phone.png')
    win.setSize(960, 600)
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(await js(`(() => { const r = document.querySelector('[role="dialog"]').getBoundingClientRect(); return r.height <= innerHeight && r.top >= 0 })()`), true)
    await key('Escape')
    await until(`!document.querySelector('[role="dialog"]')`)

    // Notes: the vault in a tab, edited with autosave, previewed with [[links]]; a host's note beside its terminal and
    // terminal output added to it.
    win.setSize(1400, 900)
    await js(`document.querySelector('button[aria-label="Notes"]').click()`)
    await until(`!!document.querySelector('.notes-tab') && document.querySelectorAll('.notes-file').length >= 2`)
    assert.equal(await js(`document.querySelector('.sidebar')?.getClientRects().length ?? 0`), 0, 'Notes has its own list, so the hosts sidebar steps aside')
    await js(`[...document.querySelectorAll('.notes-file')].find((b) => b.textContent.includes('Runbook')).click()`)
    // Live mode: the [[ ]] of a link show only on the line being edited.
    await until(`document.querySelector('.notes-tab .cm-content')?.textContent.includes('see PLM upgrade') && !!document.querySelector('.notes-tab .cm-live-wikilink')`)
    // Real clicks and keys, as a person edits: the window-wide user-select: none once kept clicks from placing a caret.
    const lastLine = await js(`(() => { const r = [...document.querySelectorAll('.notes-tab .cm-line')].at(-1).getBoundingClientRect(); return { x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2) } })()`)
    win.webContents.focus()
    win.webContents.sendInputEvent({ type: 'mouseDown', x: lastLine.x, y: lastLine.y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: lastLine.x, y: lastLine.y, button: 'left', clickCount: 1 })
    await until(`document.activeElement?.classList.contains('cm-content') && getSelection().rangeCount > 0`)
    for (const ch of 'Checked the logs. ') win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
    await until(`document.querySelector('.notes-tab .cm-content').textContent.includes('Checked the logs.')`)
    assert.match(await js(`document.querySelector('.notes-tab .cm-content').textContent`), /see (\[\[)?PLM upgrade(\]\])?\.Checked the logs\./, 'typing goes where the click put the caret')
    for (let n = 0; n < 100 && !calls.some((c) => c.channel === 'notes:write' && c.args[0] === 'Runbook.md' && c.args[1].includes('Checked the logs.')); n++) await new Promise((r) => setTimeout(r, 30))
    assert.ok(calls.some((c) => c.channel === 'notes:write' && c.args[0] === 'Runbook.md' && c.args[1].includes('Checked the logs.') && typeof c.args[2] === 'number'), 'typing autosaves, with the loaded version for conflict checks')
    await until(`document.querySelector('.notes-status')?.textContent === 'Saved'`)
    // Open in Obsidian goes through its own channel (shell:open only passes web addresses).
    await js(`[...document.querySelectorAll('.notes-head button')].find((b) => b.textContent === 'Obsidian').click()`)
    for (let n = 0; n < 50 && !calls.some((c) => c.channel === 'notes:openInObsidian'); n++) await new Promise((r) => setTimeout(r, 30))
    assert.deepEqual(calls.filter((c) => c.channel === 'notes:openInObsidian').at(-1)?.args, ['Runbook.md'])
    // Formatting: select a word, the toolbar and the shortcuts change the Markdown; ⌘B is bold here, not the sidebar.
    for (const ch of 'key words') win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Left', modifiers: ['shift', 'alt'] })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Left', modifiers: ['shift', 'alt'] })
    await until(`getSelection().toString() === 'words'`)
    await js(`document.querySelector('.nt-btn[aria-label="Bold (⌘B)"]').click()`)
    await until(`document.querySelector('.notes-tab .cm-content').textContent.includes('key **words**') && document.querySelector('.nt-btn[aria-label="Bold (⌘B)"]').classList.contains('on')`)
    const sidebarOpen = () => js(`document.documentElement.dataset.sidebar !== 'collapsed'`)
    const sidebarBefore = await sidebarOpen()
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'I', modifiers: ['meta'] })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'I', modifiers: ['meta'] })
    await until(`document.querySelector('.notes-tab .cm-content').textContent.includes('key ***words***')`)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'B', modifiers: ['meta'] })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'B', modifiers: ['meta'] })
    await until(`document.querySelector('.notes-tab .cm-content').textContent.includes('key *words*') && !document.querySelector('.notes-tab .cm-content').textContent.includes('**words')`)
    assert.equal(await sidebarOpen(), sidebarBefore, '⌘B in the editor does not toggle the sidebar')
    await js(`document.querySelector('.nt-btn[aria-label="Bulleted list (⌘⇧8)"]').click()`)
    await until(`[...document.querySelectorAll('.notes-tab .cm-line')].some((l) => l.textContent.startsWith('- Checked the logs.'))`)
    // Away from the line, its Markdown is hidden: a bullet dot and italic text instead of "- " and "*".
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Up', modifiers: ['meta'] })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Up', modifiers: ['meta'] })
    await until(`!!document.querySelector('.notes-tab .cm-live-bullet') && [...document.querySelectorAll('.notes-tab .cm-line')].some((l) => l.textContent.includes('key words') && !l.textContent.includes('*'))`)
    await js(`(() => { const s = document.querySelector('.nt-select.font'); s.value = 'Georgia'; s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    await until(`document.querySelector('.notes-tab').style.getPropertyValue('--notes-font').includes('Georgia')`)
    await screenshot('notes-formatting.png')
    for (let n = 0; n < 100 && !calls.some((c) => c.channel === 'notes:write' && c.args[1].includes('see [[PLM upgrade]].\n- Checked the logs. key *words*')); n++) await new Promise((r) => setTimeout(r, 30))
    assert.ok(calls.some((c) => c.channel === 'notes:write' && c.args[1].includes('see [[PLM upgrade]].\n- Checked the logs. key *words*')), 'formatting is saved as Markdown')
    await js(`(() => { const s = document.querySelector('.nt-select.font'); s.value = 'Monaco'; s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    await js(`[...document.querySelectorAll('.notes-modes button')].find((b) => b.textContent === 'Split').click()`)
    await until(`!!document.querySelector('.notes-preview a.wikilink')`)
    await screenshot('notes.png')
    await js(`document.querySelector('.notes-preview a.wikilink').click()`)
    await until(`document.querySelector('.notes-title')?.textContent === 'PLM upgrade' && !!document.querySelector('.notes-preview input[type="checkbox"]')`)
    // Folders: clicking one makes it where new notes and folders go; rename and delete from a row's menu.
    await js(`[...document.querySelectorAll('.notes-folder')].find((r) => r.textContent.includes('Projects')).click()`)
    await until(`document.querySelector('.notes-target-chip')?.textContent === 'Projects'`)
    await js(`document.querySelector('button[aria-label="New folder"]').click()`)
    await until(`document.activeElement?.getAttribute('aria-label') === 'New folder name'`)
    await js(`(() => { const t = document.activeElement; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(t, 'Ops'); t.dispatchEvent(new Event('input', { bubbles: true })); t.form.requestSubmit() })()`)
    await until(`[...document.querySelectorAll('.notes-folder')].some((r) => r.textContent.includes('Ops')) && document.querySelector('.notes-target-chip')?.textContent === 'Projects/Ops'`)
    assert.deepEqual(calls.filter((c) => c.channel === 'notes:mkdir').at(-1).args, ['Projects/Ops'], 'the folder is created inside the selected folder, not at the top')
    await js(`document.querySelector('button[aria-label="New note"]').click()`)
    await until(`document.activeElement?.getAttribute('aria-label') === 'New note name'`)
    await js(`(() => { const t = document.activeElement; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(t, 'Checklist'); t.dispatchEvent(new Event('input', { bubbles: true })); t.form.requestSubmit() })()`)
    await until(`document.querySelector('.notes-title')?.textContent === 'Checklist' && document.querySelector('.notes-path')?.textContent === 'Projects/Ops'`)
    await js(`document.querySelector('.notes-file.on .notes-row-more').click()`)
    await until(`!!document.querySelector('.popover')`)
    await click('Rename')
    await until(`document.activeElement?.getAttribute('aria-label') === 'New name'`)
    await js(`(() => { const t = document.activeElement; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(t, 'Runlist'); t.dispatchEvent(new Event('input', { bubbles: true })); t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })()`)
    await until(`document.querySelector('.notes-title')?.textContent === 'Runlist'`)
    assert.deepEqual(calls.filter((c) => c.channel === 'notes:rename').at(-1).args, ['Projects/Ops/Checklist.md', 'Projects/Ops/Runlist.md'])
    await screenshot('notes-folders.png')
    // Drag and drop: the note onto the Projects folder moves it there; a folder never into itself.
    const rowOf = (text, kind) => `[...document.querySelectorAll('.notes-${kind}')].find((r) => r.textContent.replace('⋯', '').trim().startsWith(${JSON.stringify(text)}))`
    const dragEvent = (row, type) => js(`(() => { const ev = new DragEvent('${type}', { dataTransfer: window.__dt, bubbles: true, cancelable: true }); ${row}.dispatchEvent(ev); return ev.defaultPrevented })()`)
    await js(`void (window.__dt = new DataTransfer())`)
    await dragEvent(rowOf('Runlist', 'file'), 'dragstart')
    await until(`!!document.querySelector('.notes-file.dragging')`)
    assert.equal(await dragEvent(rowOf('Projects', 'folder'), 'dragover'), true, 'a folder accepts a note from elsewhere')
    await until(`!!document.querySelector('.notes-folder.drop-target')`)
    await screenshot('notes-drag.png')
    await dragEvent(rowOf('Projects', 'folder'), 'drop')
    for (let n = 0; n < 50 && calls.filter((c) => c.channel === 'notes:rename').at(-1)?.args[1] !== 'Projects/Runlist.md'; n++) await new Promise((r) => setTimeout(r, 30))
    assert.deepEqual(calls.filter((c) => c.channel === 'notes:rename').at(-1).args, ['Projects/Ops/Runlist.md', 'Projects/Runlist.md'], 'dropping a note on a folder moves it into that folder')
    await until(`document.querySelector('.notes-path')?.textContent === 'Projects' && !document.querySelector('.notes-row.dragging')`)
    const renamesBefore = calls.filter((c) => c.channel === 'notes:rename').length
    await js(`void (window.__dt = new DataTransfer())`)
    await dragEvent(rowOf('Projects', 'folder'), 'dragstart')
    await until(`!!document.querySelector('.notes-folder.dragging')`)
    assert.equal(await dragEvent(rowOf('Ops', 'folder'), 'dragover'), false, 'a folder cannot be dropped into its own subfolder')
    await dragEvent(rowOf('Projects', 'folder'), 'dragend')
    await until(`!document.querySelector('.notes-row.dragging')`)
    assert.equal(calls.filter((c) => c.channel === 'notes:rename').length, renamesBefore)
    // Move to… from the menu (the touch-friendly way): back to the top level.
    await js(`document.querySelector('.notes-file.on .notes-row-more').click()`)
    await until(`!!document.querySelector('.popover')`)
    await click('Move to…')
    await until(`!!document.querySelector('.notes-move-list')`)
    await click('Top level')
    for (let n = 0; n < 50 && calls.filter((c) => c.channel === 'notes:rename').at(-1)?.args[1] !== 'Runlist.md'; n++) await new Promise((r) => setTimeout(r, 30))
    assert.deepEqual(calls.filter((c) => c.channel === 'notes:rename').at(-1).args, ['Projects/Runlist.md', 'Runlist.md'])
    await until(`document.querySelector('.notes-title')?.textContent === 'Runlist' && !document.querySelector('.notes-path')`)
    await js(`void (window.confirm = () => true)`)
    await js(`document.querySelector('.notes-file.on .notes-row-more').click()`)
    await until(`!!document.querySelector('.popover')`)
    await click('Move to Trash')
    await until(`document.querySelector('.notes-title')?.textContent === 'No note open' && ![...document.querySelectorAll('.notes-file')].some((r) => r.textContent.includes('Runlist'))`)
    assert.deepEqual(calls.filter((c) => c.channel === 'notes:delete').at(-1).args, ['Runlist.md'])
    await js(`[...document.querySelectorAll('.notes-file')].find((b) => b.textContent.includes('PLM upgrade')).click()`)
    await until(`document.querySelector('.notes-title')?.textContent === 'PLM upgrade'`)
    // The All grid tiles sessions only: the open Notes tab is not a tile and not counted.
    const sessionCount = await js(`document.querySelectorAll('.session-panes > .session-pane').length - 1`)
    await key('0', { metaKey: true })
    await until(`!!document.querySelector('.session-grid')`)
    assert.equal(await js(`document.querySelectorAll('.session-grid > .session-pane:not(.hidden)').length`), sessionCount)
    assert.equal(await js(`!!document.querySelector('.session-grid .notes-tab:not(.hidden)') && !document.querySelector('.session-grid .notes-tab').closest('.session-pane').classList.contains('hidden')`), false, 'no Notes tile')
    assert.equal(await js(`document.querySelector('button[title^="All sessions"] .rail-badge').textContent`), String(sessionCount), 'the Overview badge counts sessions only')
    await key('0', { metaKey: true })
    await until(`!document.querySelector('.session-grid')`)
    // The host's note beside its terminal, and output added to it.
    await js(`[...document.querySelectorAll('.tab')].find((t) => t.textContent.includes('web-prod-01') && !t.textContent.includes('Notes')).click()`)
    await until(`!!document.querySelector('.term-toolbar')`)
    const termTab = await js(`document.querySelector('.session-panes > .session-pane:not(.hidden)').dataset.tabId`)
    await click('Note')
    await until(`document.querySelectorAll('.session-panes > .split-pane').length === 2 && document.querySelector('.notes-title')?.textContent === 'web-prod-01 (production)'`)
    await screenshot('notes-beside-terminal.png')
    win.webContents.send('ssh:event', { sessionId: termTab, type: 'data', data: 'uptime: 10 days\r\n' })
    await new Promise((r) => setTimeout(r, 200))
    await js(`document.querySelector('[data-tab-id="${termTab}"] button[aria-label="Add to note"]').click()`)
    for (let n = 0; n < 50 && !calls.some((c) => c.channel === 'notes:append'); n++) await new Promise((r) => setTimeout(r, 30))
    const appended = calls.filter((c) => c.channel === 'notes:append').at(-1).args
    assert.equal(appended[0], 'EC2 Remote/Hosts/web-prod-01 (production).md')
    assert.match(appended[1], /^### \d{4}-\d{2}-\d{2} \d{2}:\d{2} · .*\n\n```text\n[\s\S]*uptime: 10 days\n```\n$/)
    await until(`document.querySelector('.notes-tab .cm-content')?.textContent.includes('uptime: 10 days')`)
    // Broadcasting needs two terminals; beside a note it is not offered.
    assert.equal(await js(`!!document.querySelector('[data-tab-id="${termTab}"] button[aria-pressed][title*="Broadcast"]')`), false, 'no broadcast button with a single terminal in the split')
    // Note again closes the note beside the session; the terminal stays.
    await js(`[...document.querySelectorAll('.notes-modes button')].find((b) => b.textContent === 'Edit').click()`)
    await js(`document.querySelector('[data-tab-id="${termTab}"] button[aria-pressed="true"][title^="Close the note"]').click()`)
    await until(`!document.querySelector('.notes-tab') && !!document.querySelector('[data-tab-id="${termTab}"]:not(.hidden)')`)

    // Phone layout (what the gateway serves to an iPhone): host list, action sheet, terminal key bar, back to lists.
    const phone = new BrowserWindow({ show: false, width: 430, height: 932, webPreferences: { preload: join(__dirname, 'ui-preload.cjs'), contextIsolation: true, backgroundThrottling: false } })
    phone.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }))
    phone.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message) })
    const pjs = (code) => phone.webContents.executeJavaScript(code)
    const puntil = async (code) => {
      for (let n = 0; n < 100; n++) { if (await pjs(code)) return; await new Promise((r) => setTimeout(r, 30)) }
      throw new Error(`Timed out (phone): ${code}`)
    }
    const ptap = (label) => pjs(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim().startsWith(${JSON.stringify(label)}) && x.getClientRects().length); if (!b) throw new Error('Missing button: ' + ${JSON.stringify(label)}); b.click() })()`)
    const pshot = async (name) => { await pjs('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await new Promise((r) => setTimeout(r, 150)); writeFileSync(join(output, name), (await phone.webContents.capturePage()).toPNG()) }
    const noSideScroll = () => pjs(`document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth`)
    await phone.loadFile(resolve('out/renderer/index.html'), { query: { layout: 'mobile' } })
    await puntil(`!!document.querySelector('.m-app') && document.querySelectorAll('[data-host-key]').length === 2`)
    assert.equal(await pjs(`!!document.querySelector('.titlebar')`), false, 'phone layout replaces the desktop chrome')
    assert.equal(await noSideScroll(), true, 'host list fits the phone width')
    await pshot('phone-hosts.png')
    await pjs(`document.querySelector('[data-host-key="${running.key}"]').click()`)
    await puntil(`!!document.querySelector('.m-sheet')`)
    await pshot('phone-host-actions.png')
    const phoneOpens = calls.filter((c) => c.channel === 'ssh:open').length
    await ptap('SSH terminal')
    await puntil(`!!document.querySelector('.m-keybar') && !!document.querySelector('.m-session-header')`)
    for (let n = 0; n < 100 && calls.filter((c) => c.channel === 'ssh:open').length === phoneOpens; n++) await new Promise((r) => setTimeout(r, 30))
    const phoneSession = calls.filter((c) => c.channel === 'ssh:open').at(-1).args[0].sessionId
    await new Promise((r) => setTimeout(r, 200))
    const lastWrite = () => calls.filter((c) => c.channel === 'ssh:write' && c.args[0] === phoneSession).at(-1)?.args[1]
    await pjs(`document.querySelector('.m-key[aria-label="Esc"]').click()`)
    await puntil(`true`)
    for (let n = 0; n < 50 && lastWrite() !== '\x1b'; n++) await new Promise((r) => setTimeout(r, 30))
    assert.equal(lastWrite(), '\x1b', 'Esc key sends ESC')
    await pjs(`document.querySelector('.m-key[aria-label^="Control"]').click()`)
    await pjs(`(() => { const t = document.querySelector('.xterm-helper-textarea'); t.focus(); t.value = 'c'; t.dispatchEvent(new InputEvent('input', { data: 'c', inputType: 'insertText', bubbles: true })) })()`)
    for (let n = 0; n < 50 && lastWrite() !== '\x03'; n++) await new Promise((r) => setTimeout(r, 30))
    assert.equal(lastWrite(), '\x03', 'sticky Ctrl turns the next letter into a control code')
    assert.equal(await pjs(`document.querySelector('.m-key[aria-label^="Control"]').getAttribute('aria-pressed')`), 'false', 'Ctrl releases after one key')
    // Paste key. A refused clipboard read (WebKit's Paste bubble dismissed) opens the paste box; one line from the
    // clipboard goes straight in; several lines are shown in the box first.
    const waitWrite = async (want) => { for (let n = 0; n < 50 && lastWrite() !== want; n++) await new Promise((r) => setTimeout(r, 30)) }
    await pjs(`void (navigator.clipboard.readText = () => Promise.reject(new DOMException('dismissed', 'NotAllowedError')))`)
    await pjs(`document.querySelector('.m-key[aria-label="Paste"]').click()`)
    await puntil(`!!document.querySelector('.m-paste-input')`)
    await pshot('phone-paste-box.png')
    await pjs(`(() => { const t = document.querySelector('.m-paste-input'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, 'uptime'); t.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await ptap('Paste')
    await waitWrite('uptime')
    assert.equal(lastWrite(), 'uptime', 'the paste box sends its text')
    await puntil(`!document.querySelector('.m-paste-input')`)
    await pjs(`void (navigator.clipboard.readText = () => Promise.resolve('whoami'))`)
    await pjs(`document.querySelector('.m-key[aria-label="Paste"]').click()`)
    await waitWrite('whoami')
    assert.equal(lastWrite(), 'whoami', 'a single clipboard line pastes straight into the terminal')
    await pjs(`void (navigator.clipboard.readText = () => Promise.resolve('echo one\\necho two'))`)
    await pjs(`document.querySelector('.m-key[aria-label="Paste"]').click()`)
    await puntil(`document.querySelector('.m-paste-input')?.value === 'echo one\\necho two'`)
    assert.equal(lastWrite(), 'whoami', 'multi-line clipboard text is not sent before review')
    assert.equal(await pjs(`[...document.querySelectorAll('.m-sheet button')].some((b) => b.textContent === 'Paste 2 lines')`), true, 'the paste box counts lines')
    await ptap('Cancel')
    await puntil(`!document.querySelector('.m-paste-input')`)
    // Select text: the scrollback in a selectable field, soft-wrapped rows joined back into one line.
    const longLine = 'x'.repeat(60) + 'END'
    phone.webContents.send('ssh:event', { sessionId: phoneSession, type: 'data', data: `hello from the fixture\r\n${longLine}\r\n` })
    await pjs(`document.querySelector('.m-key[aria-label="More actions"]').click()`)
    await ptap('Select text to copy')
    await puntil(`!!document.querySelector('.m-copy-text')`)
    const copied = await pjs(`document.querySelector('.m-copy-text').value`)
    assert.ok(copied.includes('hello from the fixture'), 'Select text shows the terminal output')
    assert.ok(copied.split('\n').includes(longLine), 'wrapped rows are joined back into the printed line')
    await pshot('phone-select-text.png')
    await ptap('Copy all')
    await puntil(`!document.querySelector('.m-copy-text')`)
    assert.equal(calls.filter((c) => c.channel === 'clipboard:write').at(-1)?.args[0], copied, 'Copy all copies the whole text')
    // Toasts share the .modal class, so later "no dialog open" checks wait for the "Copied" toast to go.
    for (let n = 0; n < 100 && (await pjs(`!!document.querySelector('.toasts .modal')`)); n++) await new Promise((r) => setTimeout(r, 60))
    assert.equal(await noSideScroll(), true, 'terminal view fits the phone width')
    await pshot('phone-terminal.png')
    await pjs(`document.querySelector('.m-key[aria-label="More actions"]').click()`)
    await puntil(`!!document.querySelector('.m-sheet') && document.querySelector('.m-sheet').textContent.includes('Disk usage')`)
    await pshot('phone-terminal-menu.png')
    await ptap('Cancel')
    await pjs(`document.querySelector('.m-back').click()`)
    await puntil(`!!document.querySelector('.m-tabbar') && document.querySelector('.m-header h1')?.textContent === 'Sessions'`)
    assert.equal(await pjs(`document.querySelectorAll('.m-row-close').length`), 1, 'the terminal stays open in the sessions list')
    await pshot('phone-sessions.png')
    await ptap('More')
    await ptap('Settings')
    await puntil(`!!document.querySelector('.modal')`)
    assert.equal(await pjs(`(() => { const r = document.querySelector('.modal').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 })()`), true, 'dialogs fit the phone screen')
    await pshot('phone-settings.png')
    await pjs(`document.querySelector('[aria-label="Close dialog"]').click()`)
    await puntil(`!document.querySelector('.modal')`)
    // Run Command from the phone's More list fits the screen.
    await ptap('Run a command')
    await puntil(`!!document.querySelector('.rc .rc-count')`)
    assert.equal(await pjs(`(() => { const r = document.querySelector('.modal').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 })()`), true, 'run command fits the phone')
    assert.equal(await noSideScroll(), true, 'run command: no sideways scrolling')
    await pshot('phone-run-command.png')
    await pjs(`document.querySelector('[aria-label="Close dialog"]').click()`)
    await puntil(`!document.querySelector('.modal')`)

    // Unfolding (a foldable opening to tablet width) keeps the session mounted and shows list and session side by side.
    await pjs(`document.querySelectorAll('.m-tabbar button')[1].click()`)
    await puntil(`!!document.querySelector('.m-host[role="button"]')`)
    await pjs(`document.querySelector('.m-host[role="button"]').click()`)
    await puntil(`document.querySelector('.m-app').classList.contains('has-session')`)
    const opensBeforeFold = calls.filter((c) => c.channel === 'ssh:open').length
    phone.setSize(744, 1133)
    await puntil(`document.querySelector('.m-app').classList.contains('wide')`)
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(await pjs(`getComputedStyle(document.querySelector('.m-side')).display !== 'none' && getComputedStyle(document.querySelector('.m-stage')).display !== 'none'`), true, 'unfolded: list and session both visible')
    assert.equal(await pjs(`!!document.querySelector('.m-back')`), false, 'no back button when the list is on screen')
    assert.equal(calls.filter((c) => c.channel === 'ssh:open').length, opensBeforeFold, 'unfolding must not reconnect the session')
    assert.equal(await noSideScroll(), true, 'unfolded layout fits')
    await pshot('unfolded-session.png')
    // Book pose on a foldable: the iPhone app reports the fold and the split lines up with it.
    await pjs(`window.dispatchEvent(new CustomEvent('ec2ra:fold', { detail: { x: 372, y: 0, width: 24, height: 1133 } }))`)
    await new Promise((r) => setTimeout(r, 150))
    assert.deepEqual(await pjs(`(() => { const a = document.querySelector('.m-side').getBoundingClientRect(), b = document.querySelector('.m-stage').getBoundingClientRect(); return [Math.round(a.right), Math.round(b.left)] })()`), [372, 396], 'list ends at the fold, session starts past it')
    await pshot('unfolded-book-pose.png')
    await pjs(`window.dispatchEvent(new CustomEvent('ec2ra:fold', { detail: null }))`)
    // Full-screen session on a wide screen: the divider handle hides the list and brings it back.
    await pjs(`document.querySelector('.m-divider-toggle').click()`)
    await puntil(`getComputedStyle(document.querySelector('.m-side')).display === 'none'`)
    assert.equal(await pjs(`Math.round(document.querySelector('.m-stage').getBoundingClientRect().width) === innerWidth`), true, 'session takes the full width')
    await pshot('unfolded-full-session.png')
    await pjs(`document.querySelector('.m-divider-toggle').click()`)
    await puntil(`getComputedStyle(document.querySelector('.m-side')).display !== 'none'`)
    assert.equal(calls.filter((c) => c.channel === 'ssh:open').length, opensBeforeFold, 'hiding the list must not reconnect the session')
    await pjs(`window.dispatchEvent(new CustomEvent('ec2ra:fold', { detail: null }))`)
    await ptap('Hosts')
    await pshot('unfolded-hosts.png')
    phone.setSize(430, 932)
    await puntil(`!document.querySelector('.m-app').classList.contains('wide')`)
    assert.equal(calls.filter((c) => c.channel === 'ssh:open').length, opensBeforeFold, 'folding must not reconnect the session')
    assert.equal(await pjs(`getComputedStyle(document.querySelector('.m-side')).display`), 'none', 'folded with a session open: session is full screen')

    // iPad: every orientation and the Split View widths, with the terminal open. Sizes are the iPads' CSS pixels.
    // The shell must pick list-beside-session from 700 wide and 500 high, keep the key bar on screen, and never reconnect.
    const ipads = [
      ['ipad-mini-portrait', 744, 1133, true], ['ipad-mini-landscape', 1133, 744, true],
      ['ipad-11-portrait', 834, 1194, true], ['ipad-11-landscape', 1194, 834, true],
      ['ipad-13-portrait', 1032, 1376, true], ['ipad-13-landscape', 1376, 1032, true],
      ['ipad-split-half', 507, 1024, false], ['ipad-split-two-thirds', 678, 1024, false], ['ipad-split-wide', 802, 834, true]
    ]
    for (const [name, width, height, wide] of ipads) {
      phone.setContentSize(width, height)
      await puntil(`innerWidth === ${width} && innerHeight === ${height} && document.querySelector('.m-app').classList.contains('wide') === ${wide}`)
      await new Promise((r) => setTimeout(r, 250))
      assert.equal(await noSideScroll(), true, `${name}: no sideways scrolling`)
      assert.equal(await pjs(`(() => { const k = document.querySelector('.m-keybar')?.getBoundingClientRect(); return !!k && k.bottom <= innerHeight + 1 && k.right <= innerWidth + 1 })()`), true, `${name}: terminal key bar stays on screen`)
      assert.equal(await pjs(`(() => { const r = document.querySelector('.m-stage').getBoundingClientRect(); return r.width >= 300 && r.height >= 300 })()`), true, `${name}: the session has room`)
      assert.equal(await pjs(`getComputedStyle(document.querySelector('.m-side')).display !== 'none'`), wide, `${name}: host list ${wide ? 'beside' : 'hidden behind'} the session`)
      assert.equal(calls.filter((c) => c.channel === 'ssh:open').length, opensBeforeFold, `${name}: resizing must not reconnect the session`)
      if (name === 'ipad-11-landscape' || name === 'ipad-13-portrait') await pshot(`${name}.png`)
    }
    // A dialog on a tablet floats centred instead of sliding up from the bottom.
    phone.setContentSize(1194, 834)
    await puntil(`innerWidth === 1194`)
    await pjs(`document.querySelector('.m-header-btn[aria-label="Switch session"]').click()`)
    await puntil(`!!document.querySelector('.m-sheet')`)
    assert.equal(await pjs(`(() => { const r = document.querySelector('.m-sheet').getBoundingClientRect(); return r.width <= 520 && r.left > 100 && r.right < innerWidth - 100 })()`), true, 'tablet sheets are centred, not full width')
    await pshot('ipad-sheet.png')
    await ptap('Cancel')
    // Tablet: all sessions tiled on one screen; a tap on a tile opens that session.
    const ipadOpens = calls.filter((c) => c.channel === 'ssh:open').length
    await pjs(`document.querySelectorAll('.m-tabbar button')[0].click()`)
    await puntil(`!!document.querySelector('[data-host-key="${running.key}"]')`)
    await pjs(`document.querySelector('[data-host-key="${running.key}"]').click()`)
    await puntil(`!!document.querySelector('.m-sheet')`)
    await ptap('SSH terminal')
    await puntil(`!!document.querySelector('.m-header-btn[aria-label="All sessions on one screen"]')`)
    await pjs(`document.querySelector('.m-header-btn[aria-label="All sessions on one screen"]').click()`)
    await puntil(`document.querySelectorAll('.session-grid > .session-pane').length === 2 && [...document.querySelectorAll('.session-grid .xterm')].every((x) => x.getBoundingClientRect().height > 150)`)
    assert.equal(await pjs(`[...document.querySelectorAll('.session-grid .m-keybar')].every((k) => !k.getClientRects().length)`), true, 'tiles hide the key bar')
    assert.equal(await noSideScroll(), true, 'the tablet grid fits the width')
    await pshot('ipad-all-sessions.png')
    const ipadFirst = await pjs(`document.querySelectorAll('.session-grid > .session-pane')[0].dataset.tabId`)
    await pjs(`document.querySelector('[data-tab-id="${ipadFirst}"] .tile-shield').click()`)
    await puntil(`!document.querySelector('.session-grid') && document.querySelector('[data-tab-id="${ipadFirst}"]').getClientRects().length > 0`)
    assert.equal(calls.filter((c) => c.channel === 'ssh:open').length, ipadOpens + 1, 'only the new terminal connected')
    await pjs(`document.querySelector('.m-header-btn[aria-label="All sessions on one screen"]').click()`)
    await puntil(`!!document.querySelector('.session-grid')`)
    await pjs(`document.querySelectorAll('.session-grid .tile-head button[aria-label^="Close"]')[1].click()`)
    await puntil(`document.querySelectorAll('.session-grid > .session-pane').length === 1`)
    await ptap('Done')
    await puntil(`!document.querySelector('.session-grid')`)
    // The Terminal on an iPad has room for its tabs down the side; a phone-sized window puts them across the top.
    await ptap('More')
    await ptap('Terminal')
    await puntil(`!!document.querySelector('.term-side .term-tab')`)
    await pshot('ipad-terminal.png')
    phone.setContentSize(430, 932)
    await puntil(`innerWidth === 430 && !!document.querySelector('.term-tabs .term-tab') && !document.querySelector('.term-side')`)
    phone.setContentSize(1194, 834)
    await puntil(`innerWidth === 1194 && !!document.querySelector('.term-side .term-tab')`)
    // The whiteboard on an iPad: the toolbar fits and the page does not scroll sideways.
    await ptap('More')
    await ptap('Whiteboard')
    await puntil(`!!document.querySelector('.board-toolbar') && document.querySelector('.board-svg').getClientRects().length > 0`)
    assert.equal(await pjs(`(() => { const r = document.querySelector('.board-toolbar').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight })()`), true, 'iPad: whiteboard toolbar on screen')
    assert.equal(await noSideScroll(), true, 'iPad whiteboard: no sideways scrolling')
    await pshot('ipad-whiteboard.png')

    // Signing in from a phone: the approval happens in Safari, iOS suspends the page and drops its socket, and the
    // "signed in" push is sent to nobody. The dialog must still finish by asking the computer what token it holds.
    ssoScenario = true
    phone.setContentSize(430, 932)
    await phone.loadFile(resolve('out/renderer/index.html'), { query: { layout: 'mobile' } })
    await puntil(`!!document.querySelector('.m-app') && document.querySelectorAll('.m-tabbar button').length === 4`)
    await puntil(`document.body.textContent.includes('corp-prod')`) // profiles loaded and checked: the sign-in banner names the account
    await ptap('More')
    await ptap('Sign in to AWS')
    try {
      await puntil(`!!document.querySelector('.modal') && document.querySelector('.modal').textContent.includes('ABCD-EFGH') && document.querySelector('.modal').textContent.includes('Waiting for approval')`)
    } catch (e) {
      await pshot('phone-sso-failure.png')
      console.error('page text:', (await pjs(`document.body.innerText`)).slice(0, 600), '\ncalls:', calls.slice(-8).map((c) => c.channel).join(', '))
      throw e
    }
    await pshot('phone-sso-waiting.png')
    ssoTokenWritten = true // the Mac got the approval and wrote the token; no event reaches the page
    for (let n = 0; n < 400 && await pjs(`!!document.querySelector('.modal')`); n++) await new Promise((r) => setTimeout(r, 30))
    assert.equal(await pjs(`!!document.querySelector('.modal')`), false, 'sign-in dialog closes once the computer holds a new token, even with no push')
    assert.equal(await pjs(`document.body.textContent.includes('Waiting for sign-in')`), false, 'sign-in no longer reported as waiting')
    await pshot('phone-sso-done.png')
    ssoScenario = false
    // Health on a phone and a tablet: from the tab bar, one column that fits the width.
    await ptap('Health')
    await puntil(`!!document.querySelector('.hl-hero') && document.querySelectorAll('.hl-env').length === 3`)
    assert.equal(await noSideScroll(), true, 'health fits the phone width')
    assert.equal(await pjs(`(() => { const h = document.querySelector('.hl'); return h.scrollWidth <= h.clientWidth + 1 })()`), true, 'no sideways scrolling inside health on a phone')
    await pshot('phone-health.png')
    // A touch has no hover: the first tap on a hexagon says which machine it is, the second goes to its row.
    await puntil(`document.querySelectorAll('.hl-hex').length === 12`)
    await pjs(`document.querySelector('#hl-checks').scrollIntoView()`)
    await new Promise((r) => setTimeout(r, 500))
    const tapHex = (ip) => pjs(`(() => { const g = document.querySelector('.hl-hex[data-ip="${ip}"]'); g.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true })); g.dispatchEvent(new MouseEvent('click', { bubbles: true })) })()`)
    await tapHex('10.9.0.31')
    await puntil(`!!document.querySelector('.hl-hex-tip') && document.querySelector('.hl-hex-tip').textContent.includes('Tap again')`)
    assert.ok(await pjs(`document.querySelector('.hl-hex-tip').textContent.includes('3DPassport 01')`))
    assert.equal(await pjs(`(() => { const t = document.querySelector('.hl-hex-tip').getBoundingClientRect(); return t.left >= 0 && t.right <= innerWidth })()`), true, 'the tip stays on screen')
    await pshot('phone-health-hive.png')
    await tapHex('10.9.0.31')
    await puntil(`!!document.querySelector('.hl-srv.lit[data-ip="10.9.0.31"]')`)
    await pjs(`document.querySelector('.hl').scrollTop = 0`)
    phone.setContentSize(1194, 834)
    await puntil(`innerWidth === 1194 && document.querySelector('.m-app').classList.contains('wide')`)
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(await pjs(`(() => { const h = document.querySelector('.hl'); return h.scrollWidth <= h.clientWidth + 1 })()`), true, 'no sideways scrolling inside health on a tablet')
    await pshot('ipad-health.png')
    phone.destroy()

    // The browser: start page, tabs, command bar, an AWS account space signing in to its console, spaces, persistence.
    browserScenario = true
    const bwin = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { preload: join(__dirname, 'ui-preload.cjs'), contextIsolation: true, backgroundThrottling: false, webviewTag: true } })
    // Electron 44 itself logs "Invalid guestInstanceId" whenever a loaded <webview> leaves the DOM (closing a tab does
    // that); it is reproducible with a bare page and harmless, so it is the one error not counted here.
    bwin.webContents.on('console-message', (event) => {
      if (event.level !== 'error' || (/^Uncaught Error: Invalid guestInstanceId: \d+$/.test(event.message) && event.sourceId.includes('isolated_bundle'))) return
      errors.push(event.message)
      if (process.env.UI_TRACE) console.log('[browser error]', event.message, event.sourceId, event.lineNumber)
    })
    const bjs = (code) => bwin.webContents.executeJavaScript(code)
    const buntil = async (code, what = code) => {
      for (let n = 0; n < 200; n++) { if (await bjs(code)) { if (process.env.UI_TRACE) console.log('[browser ok]', what.slice(0, 70)); return } await new Promise((r) => setTimeout(r, 30)) }
      if (process.env.UI_TRACE) console.log('[browser state]', await bjs(`JSON.stringify({ key: !!document.querySelector('.web-url-key'), op: !!document.querySelector('.op'), pop: !!document.querySelector('.popover'), toasts: document.querySelector('.toasts')?.textContent, url: document.querySelector('.web-url-host')?.textContent })`))
      throw new Error(`Timed out (browser): ${what}`)
    }
    const bshot = async (name) => { await bjs('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await new Promise((r) => setTimeout(r, 250)); writeFileSync(join(output, name), (await bwin.webContents.capturePage()).toPNG()) }
    const typeIn = (sel, value) => bjs(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; i.focus(); set.call(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    const enterIn = (sel, mods = {}) => bjs(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...${JSON.stringify(mods)} }))`)
    const bkey = (k, mods = {}) => bjs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, metaKey: true, bubbles: true, cancelable: true, ...${JSON.stringify(mods)} }))`)
    const guests = () => webContents.getAllWebContents().filter((w) => w.getType() === 'webview' && w.hostWebContents === bwin.webContents)
    const guestAt = (path) => guests().find((g) => g.getURL().includes(path))
    const tabTitles = () => bjs(`[...document.querySelectorAll('.web-tab .web-tab-title')].map((t) => t.textContent)`)
    const page = (path) => `http://127.0.0.1:${webPort}${path}`
    await bwin.loadFile(resolve('out/renderer/index.html'))
    await buntil(`document.querySelectorAll('[data-host-key]').length > 0`)
    await bjs(`document.querySelector('button[aria-label="Browser"]').click()`)
    await buntil(`!!document.querySelector('.browser .start-page .start-clock')`, 'start page')
    assert.equal(await bjs(`document.querySelector('.web-space-name').textContent`), 'General')
    await bjs(`document.documentElement.dataset.theme = 'light'`)
    await bshot('browser-start-light.png')
    await bjs(`document.documentElement.dataset.theme = 'dark'`)
    // Typing an address in the start page opens it in a tab.
    await typeIn('.cmdbar.inline input', page('/one'))
    await buntil(`document.querySelector('.cmdbar.inline .cmdbar-item.on')?.textContent.includes('/one')`, 'go suggestion')
    await enterIn('.cmdbar.inline input')
    await buntil(`document.querySelector('.web-tab.on .web-tab-title')?.textContent === 'Fixture page one'`, 'page one loads in a tab')
    assert.equal(await bjs(`document.querySelector('.web-url-host').textContent`), '127.0.0.1:' + webPort)
    // A page opening a new window gets a tab beside it; ⌘W from inside the page closes it, ⌘⇧T brings it back.
    let g1 = guestAt('/one')
    bwin.webContents.send('web:window', { webContentsId: g1.id, url: page('/two'), background: false })
    await buntil(`document.querySelector('.web-tab.on .web-tab-title')?.textContent === 'Fixture page two'`, 'popup becomes a tab')
    assert.deepEqual(await tabTitles(), ['Fixture page one', 'Fixture page two'])
    bwin.webContents.send('web:shortcut', { webContentsId: guestAt('/two').id, key: 'w', code: 'KeyW', meta: true, ctrl: false, shift: false, alt: false })
    await buntil(`document.querySelectorAll('.web-tab').length === 1`, 'shortcut from the page closes the tab')
    await bkey('t', { shiftKey: true })
    await buntil(`document.querySelectorAll('.web-tab').length === 2 && document.querySelector('.web-tab.on .web-tab-title')?.textContent === 'Fixture page two'`, 'reopen closed tab')
    // Pin with ⌘D; find in page.
    await bkey('d')
    await buntil(`document.querySelectorAll('.web-pinned .web-tab').length === 1 && document.querySelectorAll('.web-tabs .web-tab').length === 1`, 'pinned')
    await bkey('f')
    await buntil(`document.activeElement?.getAttribute('aria-label') === 'Find in page'`, 'find bar')
    await typeIn('.web-find input', 'find me')
    await buntil(`/^\\d+\\/2$/.test(document.querySelector('.web-find-count').textContent)`, 'find counts matches')
    await bjs(`document.querySelector('.web-find input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await buntil(`!document.querySelector('.web-find')`)
    // ⌘L: the command bar with the address; "sandbox ec2" offers that account's EC2 console, which signs the space in.
    await bkey('l')
    await buntil(`document.querySelector('.cmdbar.floating input')?.value.endsWith('/two')`, 'command bar shows the address')
    await typeIn('.cmdbar.floating input', 'sandbox ec2')
    await buntil(`[...document.querySelectorAll('.cmdbar-item')].some((b) => b.textContent.includes('EC2') && b.textContent.includes('sandbox'))`, 'AWS suggestion')
    await bshot('browser-command-bar.png')
    const ec2 = await bjs(`[...document.querySelectorAll('.cmdbar-item')].findIndex((b) => b.textContent.includes('EC2') && b.textContent.includes('sandbox'))`)
    await bjs(`document.querySelectorAll('.cmdbar-item')[${ec2}].click()`)
    await buntil(`document.querySelector('.web-space-name')?.textContent === 'sandbox' && document.querySelector('.web-tab.on .web-tab-title')?.textContent === 'AWS Console fixture'`, 'AWS space signs in and shows the console')
    const signin = calls.filter((c) => c.channel === 'browser:consoleUrl').at(-1).args
    assert.deepEqual(signin, ['sandbox', 'https://us-west-2.console.aws.amazon.com/ec2/home?region=us-west-2#Instances:'])
    assert.equal(await bjs(`document.querySelectorAll('.web-services .web-service').length`), 7, 'account space offers its console services')
    await bshot('browser-aws-space.png')
    // A second console page in the same space reuses the console session (no second sign-in).
    const signins = calls.filter((c) => c.channel === 'browser:consoleUrl').length
    await bjs(`document.querySelector('.web-service[title^="CloudWatch"]').click()`)
    await buntil(`document.querySelectorAll('.web-tab').length === 2 && document.querySelector('.web-tab.on .web-tab-title')?.textContent === 'AWS Console fixture'`, 'second console tab')
    assert.equal(calls.filter((c) => c.channel === 'browser:consoleUrl').length, signins, 'signed-in space opens console pages directly')
    // Spaces: ⌥⌘↑ goes back to General; its pinned tab is still loaded. A new space starts empty.
    await bkey('ArrowUp', { altKey: true })
    await buntil(`document.querySelector('.web-space-name')?.textContent === 'General'`, 'previous space')
    await bjs(`document.querySelector('.space-add').click()`)
    await typeIn('.space-form input', 'Jira')
    // A colour of its own as a gradient, and an emoji in place of the initials.
    await bjs(`document.querySelector('.space-swatch.custom').click()`)
    await buntil(`!!document.querySelector('.space-custom input[type="color"]')`, 'custom colour')
    await bjs(`(() => { const i = document.querySelector('.space-custom input[type="color"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '#ff5500'); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await bjs(`document.querySelector('.space-gradient input').click()`)
    await buntil(`document.querySelectorAll('.space-custom input[type="color"]').length === 2`, 'gradient adds a second colour')
    await bjs(`document.querySelector('.space-emoji[aria-label="Icon 🧪"]').click()`)
    await buntil(`document.querySelector('.space-preview .space-avatar')?.textContent === '🧪'`, 'preview shows the emoji')
    await bshot('browser-space-editor.png')
    await bjs(`document.querySelector('.space-form').requestSubmit()`)
    await buntil(`document.querySelector('.web-space-name')?.textContent === 'Jira' && !!document.querySelector('.start-page')`, 'new space')
    await buntil(`getComputedStyle(document.querySelector('.browser')).getPropertyValue('--c').trim() === '#ff5500' && !!getComputedStyle(document.querySelector('.browser')).getPropertyValue('--c2').trim() && document.querySelector('.web-space-dot[aria-label="Space Jira"] .space-avatar')?.textContent === '🧪'`, 'the space wears its colours and emoji')
    for (let n = 0; n < 60 && !browserSaved?.spaces.some((x) => x.name === 'Jira' && x.icon === '🧪'); n++) await new Promise((r) => setTimeout(r, 50))
    const jira = browserSaved.spaces.find((x) => x.name === 'Jira')
    assert.equal(jira.custom.from, '#ff5500')
    assert.match(jira.custom.to, /^#[0-9a-f]{6}$/)
    await bshot('browser-space-custom.png')
    // An AWS account space keeps the account's name, but takes a colour and an icon of its own too.
    await bjs(`document.querySelector('.web-space-dot[aria-label="Space sandbox"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`)
    await buntil(`[...document.querySelectorAll('.popover .menu-item')].some((b) => b.textContent === 'Colour and icon…')`, 'account space menu')
    await bjs(`[...document.querySelectorAll('.popover .menu-item')].find((b) => b.textContent === 'Colour and icon…').click()`)
    await buntil(`!!document.querySelector('.space-form') && !document.querySelector('.space-form input.input[placeholder^="Name"]')`, 'colour and icon form, no name field')
    await bjs(`document.querySelector('.space-swatch.custom').click()`)
    await buntil(`!!document.querySelector('.space-presets button[aria-label="Ocean"]')`, 'gradients offered')
    await bjs(`document.querySelector('.space-presets button[aria-label="Ocean"]').click()`)
    await bjs(`document.querySelector('.space-emoji[aria-label="Icon 🚀"]').click()`)
    await bjs(`document.querySelector('.space-form').requestSubmit()`)
    await buntil(`document.querySelector('.web-space-dot[aria-label="Space sandbox"] .space-avatar')?.textContent === '🚀'`, 'account space icon')
    for (let n = 0; n < 60 && browserSaved?.spaceLooks?.['aws-sandbox']?.icon !== '🚀'; n++) await new Promise((r) => setTimeout(r, 50))
    assert.deepEqual(browserSaved.spaceLooks['aws-sandbox'], { custom: { from: '#0ea5e9', to: '#1e3a8a' }, icon: '🚀' })
    assert.equal(browserSaved.spaces.some((x) => x.id === 'aws-sandbox'), false, 'the account space is not stored as a space of its own')
    // Leaving the browser for another tab and coming back keeps its pages (no reload, same page process).
    await bjs(`document.querySelector('.web-space-dot[aria-label="Space General"]').click()`)
    await buntil(`document.querySelector('.web-pinned .web-tab.on') !== null`, 'pinned tab active in General')
    g1 = guestAt('/two')
    const before = g1.id
    // ⌘1 belongs to the browser's tabs here; ⌘⇧[ goes to the previous app tab (Hosts).
    await bkey('{', { shiftKey: true })
    await buntil(`!document.querySelector('.browser') || document.querySelector('.browser').getClientRects().length === 0`, 'hosts shown')
    await bjs(`document.querySelector('button[aria-label="Browser"]').click()`)
    await buntil(`document.querySelector('.browser').getClientRects().length > 0`)
    assert.ok(guestAt('/two') && guestAt('/two').id === before, 'page survives switching app tabs')
    // Favorites belong to their space (its logins): page one becomes a favorite of General and is not shown in sandbox;
    // ⌘W only unloads it; Move to space takes it to another space, still a favorite.
    await bjs(`[...document.querySelectorAll('.web-tabs .web-tab')].find((t) => t.textContent.includes('Fixture page one')).click()`)
    await buntil(`document.querySelector('.web-tab.on .web-tab-title')?.textContent === 'Fixture page one'`, 'page one selected')
    await bkey('d', { shiftKey: true })
    await buntil(`document.querySelectorAll('.web-fav').length === 1 && !document.querySelector('.web-tabs .web-tab') && !!document.querySelector('.web-fav.on')`, 'favorited')
    await bshot('browser-favorites.png')
    await bjs(`document.querySelector('.web-space-dot[aria-label="Space sandbox"]').click()`)
    await buntil(`document.querySelector('.web-space-name')?.textContent === 'sandbox' && !document.querySelector('.web-fav') && !!document.querySelector('.web-favs.empty')`, "another space shows only its own favorites")
    await bjs(`document.querySelector('.web-space-dot[aria-label="Space General"]').click()`)
    await buntil(`document.querySelector('.web-space-name')?.textContent === 'General' && !!document.querySelector('.web-fav.on')`, 'the favorite is still selected in its space')
    await bkey('w')
    await buntil(`!!document.querySelector('.web-fav.asleep') && !document.querySelector('.web-fav.on')`, '⌘W unloads the favorite')
    for (let n = 0; n < 50 && guestAt('/one'); n++) await new Promise((r) => setTimeout(r, 30))
    assert.equal(guestAt('/one'), undefined, 'unloaded favorite releases its page')
    await bjs(`document.querySelector('.web-fav').click()`)
    await buntil(`!!document.querySelector('.web-fav.on:not(.asleep)') && document.querySelector('.web-url-host')?.textContent.startsWith('127.0.0.1')`, 'the favorite loads again')
    for (let n = 0; n < 60 && !guestAt('/one'); n++) await new Promise((r) => setTimeout(r, 30))
    assert.ok(guestAt('/one'), 'the favorite loads again when opened')
    const moveFavTo = async (name) => {
      await bjs(`document.querySelector('.web-fav').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`)
      // A space's item is its avatar then its name.
      await buntil(`[...document.querySelectorAll('.popover .menu-item')].some((b) => b.textContent.endsWith(${JSON.stringify(name)}))`, `move to ${name}`)
      await bjs(`[...document.querySelectorAll('.popover .menu-item')].find((b) => b.textContent.endsWith(${JSON.stringify(name)})).click()`)
      await buntil(`!document.querySelector('.web-fav')`, `the favorite leaves for ${name}`)
      await bjs(`document.querySelector('.web-space-dot[aria-label="Space ${name}"]').click()`)
      await buntil(`document.querySelector('.web-space-name')?.textContent === ${JSON.stringify(name)} && document.querySelectorAll('.web-fav').length === 1`, `a favorite of ${name}`)
    }
    await moveFavTo('sandbox')
    await moveFavTo('General')
    await bjs(`document.querySelector('.web-fav').click()`)
    await buntil(`!!document.querySelector('.web-fav.on')`, 'favorite selected again')
    // Moving between spaces changes its logins, so the page loads again in General's partition.
    for (let n = 0; n < 100 && !guestAt('/one'); n++) await new Promise((r) => setTimeout(r, 30))
    assert.ok(guestAt('/one'), `the moved favorite loads in its space (pages: ${guests().map((g) => g.getURL()).join(', ')})`)
    // ⌘1…⌘9 switch spaces in the order of the avatars (General, Jira, sandbox); ⌘9 is the last one.
    await bkey('2')
    await buntil(`document.querySelector('.web-space-name')?.textContent === 'Jira'`, '⌘2 shows the second space')
    await bkey('9')
    await buntil(`document.querySelector('.web-space-name')?.textContent === 'sandbox'`, '⌘9 shows the last space')
    assert.match(await bjs(`document.querySelector('.web-space-dot[aria-label="Space sandbox"]').title`), /⌘3$/)
    await bkey('1')
    await buntil(`document.querySelector('.web-space-name')?.textContent === 'General' && !!document.querySelector('.web-fav.on')`, '⌘1 shows the first space')
    // One zoom for every page: ⌘+ on one page zooms the other open pages too, and ⌘0 resets them all.
    await bkey('=')
    await buntil(`document.querySelector('.web-zoom')?.textContent === '110%'`, 'zoom badge')
    for (let n = 0; n < 50 && guestAt('/two')?.getZoomFactor() !== 1.1; n++) await new Promise((r) => setTimeout(r, 30))
    assert.equal(guestAt('/one').getZoomFactor(), 1.1)
    assert.equal(guestAt('/two').getZoomFactor(), 1.1, 'the page in the background zooms too')
    // The sidebar follows the zoom so it stays in proportion with the pages.
    await buntil(`Math.abs(document.querySelector('.web-side').getBoundingClientRect().width - 208 * 1.1) < 1`, 'sidebar zooms with the pages')
    await bkey('0')
    await buntil(`!document.querySelector('.web-zoom') && document.querySelector('.web-side').getBoundingClientRect().width === 208`, 'zoom reset')
    for (let n = 0; n < 3; n++) await bkey('-')
    await buntil(`document.querySelector('.web-zoom')?.textContent === '75%' && document.querySelector('.web-side').getBoundingClientRect().width === 156`, 'sidebar at 75%')
    await bshot('browser-zoom-75.png')
    await bkey('0')
    await buntil(`!document.querySelector('.web-zoom')`)
    assert.equal(guestAt('/two').getZoomFactor(), 1)
    // Edit a favorite's name.
    await bjs(`document.querySelector('.web-fav').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`)
    await bjs(`[...document.querySelectorAll('.popover .menu-item')].find((b) => b.textContent.startsWith('Edit name')).click()`)
    await buntil(`!!document.querySelector('.popover form.space-form')`, 'edit form')
    await typeIn('.popover form.space-form input', 'My fixture')
    await bjs(`document.querySelector('.popover form.space-form').requestSubmit()`)
    await buntil(`!!document.querySelector('.web-fav[aria-label="Favorite My fixture"]') && !document.querySelector('.popover')`, 'favorite renamed')
    // The sidebar fits three favorites a row; dragging its edge wider fits four, double-click restores it.
    const favCols = () => bjs(`getComputedStyle(document.querySelector('.web-favs')).gridTemplateColumns.split(' ').length`)
    assert.equal(await favCols(), 3)
    await bjs(`(() => { const h = document.querySelector('.web-side-resize'); const r = h.getBoundingClientRect(); h.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: r.left + 4, clientY: 300 })) })()`)
    await buntil(`!!document.querySelector('.web-resize-shield')`)
    await bjs(`(() => { const h = document.querySelector('.web-side-resize').getBoundingClientRect(); const s = document.querySelector('.web-resize-shield'); s.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: h.left + 64, clientY: 300 })); s.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: h.left + 64, clientY: 300 })) })()`)
    await buntil(`!document.querySelector('.web-resize-shield') && document.querySelector('.web-side').getBoundingClientRect().width === 268`, 'sidebar resized')
    assert.equal(await favCols(), 4)
    await bjs(`document.querySelector('.web-side-resize').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
    await buntil(`document.querySelector('.web-side').getBoundingClientRect().width === 208`, 'default width again')
    // A sideways two-finger swipe on the sidebar switches space, once per gesture.
    const swipeSide = (dx) => bjs(`(() => { const a = document.querySelector('.web-side'); for (let i = 0; i < 6; i++) a.dispatchEvent(new WheelEvent('wheel', { deltaX: ${dx}, deltaY: 0, bubbles: true, cancelable: true })) })()`)
    await swipeSide(40)
    await buntil(`document.querySelector('.web-space-name')?.textContent === 'Jira'`, 'swipe to the next space')
    await new Promise((r) => setTimeout(r, 300))
    await swipeSide(-40)
    await buntil(`document.querySelector('.web-space-name')?.textContent === 'General'`, 'swipe back')
    // Fill from 1Password (⌘⇧L): this site's logins first, the others by search; Enter fills the selected one.
    await bkey('l', { shiftKey: true })
    await buntil(`document.querySelector('.op .op-title')?.textContent === 'Fixture login' && document.querySelectorAll('.op-row').length === 1`, '1Password picker')
    await bshot('browser-1password.png')
    await bjs(`document.querySelector('.op-search input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`)
    await buntil(`!document.querySelector('.op') && document.querySelector('.toasts')?.textContent.includes('Filled the username and password')`, 'filled')
    const fillCall = calls.filter((c) => c.channel === 'browser:fill').at(-1).args
    assert.deepEqual(fillCall.slice(1), ['u1', 'i1', false])
    assert.equal(fillCall[0], guestAt('/one').id, 'fills the page on screen')
    // A click inside the page (which this document never sees) closes an open menu.
    await bjs(`document.querySelector('.web-url-more[aria-label="Page actions"]').click()`)
    await buntil(`!!document.querySelector('.popover')`, 'page menu open')
    bwin.webContents.send('web:pointer', { webContentsId: guestAt('/one').id }) // what main/webviews.ts reports
    await buntil(`!document.querySelector('.popover')`, 'clicking into the page closes the menu')
    // Downloads: a ring while a file downloads, a dot when it finishes, and the list with View all downloads.
    const dl = { id: 'd1', name: 'report.pdf', path: '/fixture/Downloads/report.pdf', at: Date.now(), total: 2048 }
    bwin.webContents.send('web:download', { ...dl, state: 'progressing', received: 512 })
    await buntil(`document.querySelector('.web-dl.busy')?.style.getPropertyValue('--p') === '25%'`, 'download progress ring')
    bwin.webContents.send('web:download', { ...dl, state: 'completed', received: 2048 })
    await buntil(`!!document.querySelector('.web-dl.unseen:not(.busy)')`, 'download finished dot')
    await bjs(`document.querySelector('.web-dl').click()`)
    await buntil(`document.querySelector('.dl-row.done .dl-name')?.textContent === 'report.pdf' && document.querySelector('.dl-sub').textContent === 'pdf · 2 KB'`, 'downloads list')
    await bshot('browser-downloads.png')
    await bjs(`document.querySelector('.dl-act[aria-label^="Show"]').click()`)
    assert.deepEqual(calls.filter((c) => c.channel === 'browser:openDownload').at(-1).args, [dl.path, 'reveal'])
    await bjs(`document.querySelector('.web-dl').click()`)
    await buntil(`!!document.querySelector('.dl-all')`)
    await bjs(`document.querySelector('.dl-all').click()`)
    assert.deepEqual(calls.filter((c) => c.channel === 'browser:openDownload').at(-1).args, [null, 'open'])
    // State is saved (never with a sign-in link) and comes back after a reload.
    for (let n = 0; n < 60 && !(browserSaved?.spaces.some((x) => x.name === 'Jira') && browserSaved.tabs.length === 4 && browserSaved.activeSpace === 'general' && browserSaved.tabs.some((t) => t.favorite)); n++) await new Promise((r) => setTimeout(r, 50))
    assert.equal(browserSaved.tabs.length, 4)
    assert.deepEqual(browserSaved.tabs.filter((t) => t.favorite).map((t) => [t.spaceId, t.homeUrl]), [['general', page('/one')]])
    assert.ok(browserSaved.tabs.every((t) => !t.url.includes('/fed')), 'no sign-in links saved')
    assert.ok(browserSaved.history.length >= 3)
    await bwin.reload()
    await buntil(`document.querySelectorAll('[data-host-key]').length > 0`)
    await bjs(`document.querySelector('button[aria-label="Browser"]').click()`)
    await buntil(`document.querySelectorAll('.web-pinned .web-tab').length === 1 && document.querySelectorAll('.web-fav.on').length === 1 && document.querySelector('.web-space-name')?.textContent === 'General'`, 'restored')
    await bjs(`document.querySelector('.web-space-dot[aria-label="Space sandbox"]').click()`)
    await buntil(`document.querySelectorAll('.web-tab').length === 2`, 'restored AWS tabs')
    // ⌘S hides the sidebar; the page fills the window.
    await bkey('s')
    await buntil(`!!document.querySelector('.browser.side-hidden')`)
    await bshot('browser-sidebar-hidden.png')
    await bkey('s')

    // Side by side: a ticket names hosts; one opens beside it, the split resizes, rearranges, finds a value in every
    // pane, and takes text from the page.
    bwin.webContents.send('web:window', { webContentsId: guests()[0].id, url: page('/ticket'), background: false })
    await buntil(`document.querySelector('.web-tab.on .web-tab-title')?.textContent === 'INC-4211 Checkout 502s'`, 'ticket opens')
    await buntil(`document.querySelector('.web-hosts-pill')?.textContent.includes('2 hosts on this page')`, 'hosts on the page')
    await bjs(`document.querySelector('.web-hosts-pill button').click()`)
    await buntil(`document.querySelectorAll('.popover .menu-item').length === 2`, 'hosts menu')
    assert.deepEqual(await bjs(`[...document.querySelectorAll('.popover .menu-item')].map((b) => [b.querySelector('.font-medium').textContent, b.disabled])`), [['web-prod-01', false], ['worker-stopped', true]])
    const browserTabId = await bjs(`document.querySelector('.browser').closest('.session-pane').dataset.tabId`)
    await bjs(`document.querySelector('.popover .menu-item').click()`)
    await buntil(`document.querySelectorAll('.session-panes.split > .split-pane:not(.hidden)').length === 2 && !!document.querySelector('.split-bar')`, 'host beside the ticket')
    const sshA = await bjs(`[...document.querySelectorAll('.split-pane:not(.hidden)')].find((p) => p.dataset.tabId !== ${JSON.stringify(browserTabId)}).dataset.tabId`)
    const paneBox = (id) => bjs(`(() => { const s = document.querySelector('[data-tab-id="${id}"]').style; return [s.left, s.top, s.width, s.height] })()`)
    assert.deepEqual(await paneBox(browserTabId), ['0%', '0%', '50%', '100%'])
    assert.deepEqual(await paneBox(sshA), ['50%', '0%', '50%', '100%'])
    await buntil(`document.querySelector('[data-tab-id="${sshA}"] .tile-title')?.textContent === 'web-prod-01 @ production'`, 'pane header')
    for (let n = 0; n < 60 && !calls.some((c) => c.channel === 'browser:paneTargets' && c.args[0].length === 1); n++) await new Promise((r) => setTimeout(r, 30))
    assert.deepEqual(calls.filter((c) => c.channel === 'browser:paneTargets').at(-1).args[0], [{ id: sshA, title: 'web-prod-01 @ production' }], 'the page menu offers the terminal')
    // Find in all panes: the value once on the ticket, twice in the terminal.
    await buntil(`document.querySelector('[data-tab-id="${sshA}"]')?.querySelector('.term-toolbar')?.textContent.includes('via ssm')`, 'terminal connected')
    bwin.webContents.send('ssh:event', { sessionId: sshA, type: 'data', data: 'max_connections = 256\r\nmax_connections_per_ip = 10\r\n' })
    await new Promise((r) => setTimeout(r, 200))
    await typeIn('.split-find input', 'max_connections')
    await buntil(`(() => { const c = [...document.querySelectorAll('.split-count')].map((b) => b.querySelector('b').textContent); return c.join(',') === '1,2' })()`, 'counts per pane')
    await bshot('side-by-side-find.png')
    await bjs(`document.querySelector('.split-find input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
    await buntil(`document.querySelector('.split-find input').value === '' && !document.querySelector('.split-count')`, 'find cleared')
    // Dragging the border resizes; a double-click evens it out again.
    const border = async () => bjs(`(() => { const r = document.querySelector('.split-divider.row').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)
    const pointer = (sel, type, x, y) => bjs(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new PointerEvent(${JSON.stringify(type)}, { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y}, button: 0, pointerId: 1 }))`)
    const [bx, by] = await border()
    await pointer('.split-divider.row', 'pointerdown', bx, by)
    await buntil(`!!document.querySelector('.split-shield')`, 'drag shield')
    await pointer('.split-shield', 'pointermove', bx + 200, by)
    await pointer('.split-shield', 'pointerup', bx + 200, by)
    await buntil(`!document.querySelector('.split-shield')`)
    const widened = parseFloat((await paneBox(browserTabId))[2])
    assert.ok(widened > 60 && widened < 70, `the ticket pane grew to ${widened}%`)
    await new Promise((r) => setTimeout(r, 400))
    const [bx2, by2] = await border()
    await pointer('.split-divider.row', 'pointerdown', bx2, by2)
    await pointer('.split-shield', 'pointerup', bx2, by2)
    await pointer('.split-divider.row', 'pointerdown', bx2, by2)
    await buntil(`document.querySelector('[data-tab-id="${browserTabId}"]').style.width === '50%'`, 'double-click evens the sizes')
    // ⌘\ picks a second host beside the focused pane; then one large and the rest stacked.
    await bjs(`document.querySelector('[data-tab-id="${sshA}"] .tile-head').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
    await bkey('\\')
    await buntil(`document.querySelector('[role="dialog"] h2')?.textContent === 'Open beside web-prod-01 @ production'`, 'beside picker')
    await typeIn('input[aria-label="Find a host or open session"]', 'web-prod')
    await buntil(`document.querySelector('.switcher-result.on')?.textContent.includes('SSH beside')`, 'host offered beside')
    await enterIn('input[aria-label="Find a host or open session"]')
    await buntil(`document.querySelectorAll('.session-panes.split > .split-pane:not(.hidden)').length === 3`, 'three panes')
    await bjs(`document.querySelector('.split-bar button[aria-label="One large, the rest stacked beside it"]').click()`)
    const sshB = await bjs(`[...document.querySelectorAll('.split-pane:not(.hidden)')].map((p) => p.dataset.tabId).find((id) => id !== ${JSON.stringify(browserTabId)} && id !== ${JSON.stringify(sshA)})`)
    await buntil(`document.querySelector('[data-tab-id="${browserTabId}"]').style.width === '60%'`, 'main layout')
    assert.deepEqual(await paneBox(sshB), ['60%', '50%', '40%', '50%'])
    await bshot('side-by-side.png')
    // ⌘⇧↩ shows the focused pane alone and back; ⌥⌘← moves to the ticket.
    await bkey('Enter', { shiftKey: true })
    await buntil(`document.querySelectorAll('.session-panes.split > .split-pane:not(.hidden)').length === 1`, 'zoomed')
    await bkey('Enter', { shiftKey: true })
    await buntil(`document.querySelectorAll('.session-panes.split > .split-pane:not(.hidden)').length === 3`, 'unzoomed')
    await bkey('ArrowLeft', { altKey: true })
    await buntil(`document.querySelector('.split-pane.focused')?.dataset.tabId === ${JSON.stringify(browserTabId)}`, 'focus moved to the ticket')
    // Dragging a pane's header onto the ticket's left edge docks it there.
    const drag = (sel, type, x, y) => bjs(`(() => { window.__dt ??= new DataTransfer(); document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new DragEvent(${JSON.stringify(type)}, { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y}, dataTransfer: window.__dt })) })()`)
    const ticketBox = await bjs(`(() => { const r = document.querySelector('[data-tab-id="${browserTabId}"]').getBoundingClientRect(); return [r.left, r.top, r.width, r.height] })()`)
    await drag(`[data-tab-id="${sshB}"] .tile-head`, 'dragstart', 0, 0)
    await buntil(`!!document.querySelector('.dock-shield')`, 'dock shield')
    await drag('.dock-shield', 'dragover', ticketBox[0] + 20, ticketBox[1] + ticketBox[3] / 2)
    await buntil(`document.querySelector('.dock-hint span')?.textContent === 'Beside, on the left'`, 'dock hint')
    await bshot('side-by-side-dock.png')
    await drag('.dock-shield', 'drop', ticketBox[0] + 20, ticketBox[1] + ticketBox[3] / 2)
    await buntil(`!document.querySelector('.dock-shield') && document.querySelector('[data-tab-id="${sshB}"]').style.left === '0%'`, 'docked on the left')
    // The page's menu: paste the selection into a terminal beside (no Enter), or find it in every pane.
    const writesNow = calls.filter((c) => c.channel === 'ssh:write').length
    bwin.webContents.send('web:menu', { webContentsId: guestAt('/ticket').id, action: 'paste', url: page('/ticket'), title: 'INC-4211', text: 'grep max_connections /etc/nginx/nginx.conf', target: sshA })
    for (let n = 0; n < 60 && calls.filter((c) => c.channel === 'ssh:write').length === writesNow; n++) await new Promise((r) => setTimeout(r, 30))
    const pasted = calls.filter((c) => c.channel === 'ssh:write').at(-1).args
    assert.equal(pasted[0], sshA)
    assert.ok(pasted[1].includes('grep max_connections /etc/nginx/nginx.conf') && !pasted[1].endsWith('\r'), 'pasted, not run')
    await buntil(`document.querySelector('.split-pane.focused')?.dataset.tabId === ${JSON.stringify(sshA)}`, 'the terminal takes the keyboard')
    bwin.webContents.send('web:menu', { webContentsId: guestAt('/ticket').id, action: 'find', url: page('/ticket'), title: 'INC-4211', text: 'web-prod-01' })
    await buntil(`document.querySelector('.split-find input').value === 'web-prod-01' && document.querySelectorAll('.split-count').length === 3`, 'find from the page')
    // From the hosts list, a host opens beside the tab that was in front (here the ticket).
    await bjs(`document.querySelector('[data-tab-id="${browserTabId}"] .tile-head').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
    await buntil(`document.querySelector('.split-pane.focused')?.dataset.tabId === ${JSON.stringify(browserTabId)}`, 'ticket focused')
    await bjs(`document.querySelector('button[aria-label="Hosts"]').click()`)
    await buntil(`!!document.querySelector('[data-host-key="${running.key}"]')`)
    await bjs(`document.querySelector('[data-host-key="${running.key}"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }))`)
    await buntil(`[...document.querySelectorAll('.panel.modal button')].some((b) => b.textContent === 'SSH beside the Browser')`, 'host menu offers beside')
    await bjs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    // Done leaves the split; every pane stays open as a tab.
    await bjs(`document.querySelector('.tab.in-split, .tab')?.click()`)
    await buntil(`!!document.querySelector('.split-bar')`, 'back to the split')
    await bjs(`[...document.querySelectorAll('.split-bar button')].find((b) => b.textContent.trim() === 'Done').click()`)
    await buntil(`!document.querySelector('.split-bar') && document.querySelectorAll('.session-panes > .session-pane:not(.hidden)').length === 1`, 'split done')

    // Claude on the rail: its own page (a fixture here) in its own partition with the app's own user agent (Google's
    // sign-in rejects one claiming to be Chrome), links to other sites going to the Browser.
    await bjs(`document.querySelector('button[aria-label="Claude"]').click()`)
    await buntil(`document.querySelector('.webapp[data-webapp="claude"] .webapp-title')?.textContent.includes('Debug nginx 502s')`, 'claude page loads')
    const claudeGuest = () => guests().find((g) => g.getURL().includes('/chat/claude.ai/'))
    assert.ok(claudeGuest(), 'claude page in a webview')
    assert.ok(/Electron\//.test(claudeGuest().getUserAgent()), 'chat pages keep the app user agent')
    assert.equal(await bjs(`document.querySelector('.sidebar')?.getClientRects().length ?? 0`), 0, 'the hosts sidebar steps aside')
    assert.equal(await bjs(`document.querySelector('button[aria-label="Claude"]').classList.contains('on')`), true)
    await bshot('claude.png')
    bwin.webContents.send('web:window', { webContentsId: claudeGuest().id, url: page('/one'), background: false })
    await buntil(`document.querySelector('button[aria-label="Browser"]').classList.contains('on')`, 'a link to another site opens in the Browser')

    // Settings → Keyboard: record ⌃⌘C for Claude (⌘C is refused), take ⇧⌘N from Notes for ChatGPT, restore defaults.
    await bkey(',')
    await buntil(`!!document.querySelector('.settings-nav-item[data-section="keyboard"]')`, 'settings')
    await bjs(`document.querySelector('.settings-nav-item[data-section="keyboard"]').click()`)
    await buntil(`!!document.querySelector('[aria-label="Shortcut for Claude"]')`, 'keyboard section')
    assert.equal(await bjs(`document.querySelector('[aria-label="Shortcut for Notes"]').textContent`), '⇧⌘N')
    assert.equal(await bjs(`document.querySelector('[aria-label="Shortcut for the radial menu"]').textContent`), '⇧⌘Space')
    // Real keys go to the focused element, so the recorder's window capture runs before the window's own listeners.
    const press = (k, code, mods) => bjs(`(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, code: ${JSON.stringify(code)}, bubbles: true, cancelable: true, ...${JSON.stringify(mods)} }))`)
    await bjs(`document.querySelector('[aria-label="Shortcut for Claude"]').click()`)
    await buntil(`document.querySelector('[aria-label="Shortcut for Claude"]').classList.contains('recording')`, 'recording')
    await press('c', 'KeyC', { metaKey: true })
    await buntil(`document.querySelector('[data-shortcut-row="claude"]').closest('.set-row').querySelector('.set-key-error')?.textContent.includes('Copy')`, '⌘C is refused')
    await press('c', 'KeyC', { metaKey: true, ctrlKey: true })
    await buntil(`document.querySelector('[aria-label="Shortcut for Claude"]').textContent === '⌃⌘C'`, 'recorded')
    assert.deepEqual(settings.shortcuts, { claude: 'ctrl+cmd+c' }, 'saved at once')
    await bjs(`document.querySelector('[aria-label="Shortcut for ChatGPT"]').click()`)
    await press('N', 'KeyN', { metaKey: true, shiftKey: true })
    await buntil(`document.querySelector('[aria-label="Shortcut for ChatGPT"]').textContent === '⇧⌘N' && document.querySelector('[aria-label="Shortcut for Notes"]').textContent === 'None'`, 'moved from notes')
    assert.match(await bjs(`document.querySelector('.set-key-note').textContent`), /Moved from Notes.*In Finder, ⇧⌘N stays New folder/)
    assert.deepEqual(settings.shortcuts, { claude: 'ctrl+cmd+c', chatgpt: 'shift+cmd+n', notes: '' })
    await bshot('settings-keyboard.png')
    await bjs(`[...document.querySelectorAll('.settings button')].find((b) => b.textContent === 'Restore defaults').click()`)
    await buntil(`document.querySelector('[aria-label="Shortcut for Notes"]').textContent === '⇧⌘N' && document.querySelector('[aria-label="Shortcut for Claude"]').textContent === 'None'`, 'defaults')
    assert.deepEqual(settings.shortcuts, {})
    // Each rail icon carries its shortcut underneath, straight from these settings: none for Claude now.
    await buntil(`!document.querySelector('button[aria-label="Claude"] .rail-key')`, 'no key, no hint under Claude')
    assert.equal(await bjs(`document.querySelector('button[aria-label="Notes"] .rail-key').dataset.keys`), '⇧⌘N')
    assert.equal(await bjs(`document.querySelector('button[aria-label="Hosts"] .rail-key').dataset.keys`), '⌘1')
    await bjs(`document.querySelector('[aria-label="Shortcut for Claude"]').click()`)
    await press('c', 'KeyC', { metaKey: true, ctrlKey: true })
    await buntil(`document.querySelector('[aria-label="Shortcut for Claude"]').textContent === '⌃⌘C'`, 'recorded again')
    await buntil(`document.querySelector('button[aria-label="Claude"] .rail-key')?.dataset.keys === '⌃⌘C'`, 'the hint under the rail icon follows the new key at once')
    // The launcher's key works in every app: ⌥E would type a character everywhere, ⌥Space is fine (with a note about
    // Raycast), and the old key is let go while recording.
    const pausesBefore = launcherDone.filter((d) => d[0] === 'launcher:pause').length
    await bjs(`document.querySelector('[aria-label="Shortcut for the launcher"]').click()`)
    await press('e', 'KeyE', { altKey: true })
    await buntil(`document.querySelector('[data-shortcut-row="launcher"]').closest('.set-row').querySelector('.set-key-error')?.textContent.includes('types a character')`, '⌥E is refused')
    await press(' ', 'Space', { altKey: true })
    await buntil(`document.querySelector('[aria-label="Shortcut for the launcher"]').textContent === '⌥Space'`, 'launcher key recorded')
    assert.equal(settings.launcherKey, 'alt+space')
    await buntil(`document.querySelector('button[aria-label="Launcher"] .rail-key')?.dataset.keys === '⌥Space'`, 'the launcher hint follows its key')
    // Even with a shortcut under every item, the rail keeps Settings on screen in a 900-point-tall window.
    assert.ok(await bjs(`(() => {
      const rail = document.querySelector('.app-rail')
      const extra = [...rail.querySelectorAll('.rail-item:not(:has(.rail-key)):not([aria-label="Theme"])')].map((b) => b.appendChild(Object.assign(document.createElement('kbd'), { className: 'rail-key' })))
      extra.forEach((k) => (k.dataset.keys = '⌃⌥⇧⌘K'))
      const fits = rail.scrollHeight <= rail.clientHeight
      extra.forEach((k) => k.remove())
      return fits
    })()`), 'the rail fits with a hint under every item')
    assert.match(await bjs(`document.querySelector('[data-shortcut-row="launcher"]').closest('.set-row').querySelector('.set-key-note').textContent`), /Raycast/)
    for (let n = 0; n < 60 && launcherDone.filter((d) => d[0] === 'launcher:pause').length < pausesBefore + 2; n++) await new Promise((r) => setTimeout(r, 30))
    assert.deepEqual(launcherDone.filter((d) => d[0] === 'launcher:pause').slice(pausesBefore).map((d) => d[1]), [true, false], 'the key is let go while recording')
    await bjs(`document.querySelector('.settings button[aria-label="Close dialog"]').click()`)
    await buntil(`!document.querySelector('.modal-backdrop')`, 'settings closed')
    assert.match(await bjs(`document.querySelector('button[aria-label="Claude"]').title`), /\(⌃⌘C\)$/, 'the rail shows the key')

    // The key brings Claude up from anywhere and, pressed again (here from inside its page), goes back.
    await bjs(`document.querySelector('button[aria-label="Hosts"]').click()`)
    await buntil(`!!document.querySelector('[data-host-key]')`, 'hosts')
    await bkey('c', { ctrlKey: true, code: 'KeyC' })
    await buntil(`document.querySelector('button[aria-label="Claude"]').classList.contains('on')`, 'shortcut shows claude')
    bwin.webContents.send('web:shortcut', { webContentsId: claudeGuest().id, key: 'c', code: 'KeyC', meta: true, ctrl: true, shift: false, alt: false })
    await buntil(`document.querySelector('button[aria-label="Hosts"]').classList.contains('on')`, 'pressed again from the page: back to hosts')
    // What the launcher asks of the window: a question for ChatGPT (a new chat with ?q=), a section.
    bwin.webContents.send('app:command', { kind: 'ask', app: 'chatgpt', text: 'why 502' })
    await buntil(`document.querySelector('button[aria-label="ChatGPT"]').classList.contains('on')`, 'ask opens chatgpt')
    for (let n = 0; n < 100 && !guests().some((g) => g.getURL().includes('/chat/chatgpt.com/?q=why%20502')); n++) await new Promise((r) => setTimeout(r, 30))
    assert.ok(guests().some((g) => g.getURL().includes('/chat/chatgpt.com/?q=why%20502')), 'the question is in the address')
    bwin.webContents.send('app:command', { kind: 'section', section: 'hosts' })
    await buntil(`document.querySelector('button[aria-label="Hosts"]').classList.contains('on')`, 'section command')
    // The rail's Launcher button opens it without the keyboard.
    const shows = launcherDone.filter((d) => d[0] === 'launcher:show').length
    await bjs(`document.querySelector('button[aria-label="Launcher"]').click()`)
    for (let n = 0; n < 60 && launcherDone.filter((d) => d[0] === 'launcher:show').length === shows; n++) await new Promise((r) => setTimeout(r, 30))
    assert.ok(launcherDone.filter((d) => d[0] === 'launcher:show').length > shows, 'the rail button opens the launcher')
    assert.match(await bjs(`document.querySelector('button[aria-label="Launcher"]').title`), /⌥Space/, 'its tooltip names the key')
    // ⌘/ lists it under App sections.
    await bkey('/')
    await buntil(`[...document.querySelectorAll('.modal dl')][0]?.textContent.includes('⌃⌘CClaude')`, 'shortcuts dialog lists it')
    await bjs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await buntil(`!document.querySelector('.modal-backdrop')`, 'shortcuts closed')
    browserScenario = false
    bwin.destroy()
    webServer.close()

    // The launcher's own window: apps by initials, a sum, hosts by name or IP, the app's sections, Spotlight files,
    // the actions menu, Ask Claude, and Esc.
    const lwin = new BrowserWindow({ show: false, width: 700, height: 446, frame: false, transparent: true, webPreferences: { preload: join(__dirname, 'ui-preload.cjs'), contextIsolation: true, backgroundThrottling: false } })
    lwin.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message) })
    const ljs = (code) => lwin.webContents.executeJavaScript(code)
    const luntil = async (code, what = code) => {
      for (let n = 0; n < 200; n++) { if (await ljs(code)) return; await new Promise((r) => setTimeout(r, 30)) }
      throw new Error(`Timed out (launcher): ${what}`)
    }
    const lshot = async (name) => { await ljs('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await new Promise((r) => setTimeout(r, 150)); writeFileSync(join(output, name), (await lwin.webContents.capturePage()).toPNG()) }
    const ltype = (v) => ljs(`(() => { const i = document.querySelector('.launcher-search input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(v)}); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    const lkey = (k, mods = {}) => ljs(`document.querySelector('.launcher-search input').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true, ...${JSON.stringify(mods)} }))`)
    const picked = `document.querySelector('.launcher-item.on .launcher-title')?.textContent`
    const done = async (what, test) => {
      for (let n = 0; n < 100 && !launcherDone.some(test); n++) await new Promise((r) => setTimeout(r, 30))
      assert.ok(launcherDone.some(test), what)
    }
    launcherNotes = true
    await lwin.loadFile(resolve('out/renderer/index.html'), { query: { launcher: '1' } })
    await luntil(`[...document.querySelectorAll('.launcher-group')].some((g) => g.textContent === 'Favorite Hosts') && document.body.textContent.includes('web-prod-01')`, 'suggestions: favorite hosts')
    assert.equal(await ljs(`document.documentElement.classList.contains('launcher-page')`), true)
    await lshot('launcher.png')
    await ltype('vsc')
    await luntil(`${picked} === 'Visual Studio Code'`, 'initials find the app')
    await lkey('Enter')
    await done('Enter opens the app', (d) => d[0] === 'launcher:open' && d[1] === '/Applications/Visual Studio Code.app' && d[2] === 'app:/Applications/Visual Studio Code.app')
    await ltype('2*(3+4)')
    await luntil(`${picked} === '14'`, 'a sum')
    const copies = calls.filter((c) => c.channel === 'clipboard:write').length
    await lkey('Enter')
    for (let n = 0; n < 60 && calls.filter((c) => c.channel === 'clipboard:write').length === copies; n++) await new Promise((r) => setTimeout(r, 30))
    assert.equal(calls.filter((c) => c.channel === 'clipboard:write').at(-1).args[0], '14', 'Enter copies the answer')
    // Units convert; a Mac command is found by name (recorded here, never run).
    await ltype('5 gb to mib')
    await luntil(`${picked} === '4,768.37158203 MiB'`, 'a conversion')
    await ltype('sleep')
    await luntil(`[...document.querySelectorAll('[role="group"][aria-label="Mac"] .launcher-title')].some((t) => t.textContent === 'Sleep')`, 'mac commands')
    for (let n = 0; n < 12 && (await ljs(picked)) !== 'Sleep'; n++) await lkey('ArrowDown')
    await lkey('Enter')
    await done('Sleep asks main for the command', (d) => d[0] === 'launcher:system' && d[1] === 'sleep')
    // A saved snippet is copied, to paste anywhere.
    await ltype('disk usage')
    await luntil(`${picked} === 'Snippet: Disk usage'`, 'a snippet')
    const snippetCopies = calls.filter((c) => c.channel === 'clipboard:write').length
    await lkey('Enter')
    for (let n = 0; n < 60 && calls.filter((c) => c.channel === 'clipboard:write').length === snippetCopies; n++) await new Promise((r) => setTimeout(r, 30))
    assert.equal(calls.filter((c) => c.channel === 'clipboard:write').at(-1).args[0], 'df -h', 'the snippet is copied')
    await ltype('10.0.1.15')
    await luntil(`[...document.querySelectorAll('[role="group"][aria-label="Hosts"] .launcher-title')].some((t) => t.textContent === 'web-prod-01')`, 'a host by its IP')
    await ltype('web-prod-01')
    await luntil(`${picked} === 'web-prod-01'`, 'a host by name')
    await lkey('k', { metaKey: true })
    await luntil(`[...document.querySelectorAll('.launcher-action')].map((a) => a.textContent).join('|').includes('Copy Instance ID')`, 'actions menu')
    await lkey('Escape')
    await luntil(`!document.querySelector('.launcher-actions')`, 'actions menu closes')
    await lkey('Enter')
    await done('Enter connects', (d) => d[0] === 'launcher:command' && d[1].kind === 'connect' && d[1].key === running.key)
    await ltype('notes')
    await luntil(`${picked} === 'Notes'`, 'a section of the app')
    await lkey('Enter')
    await done('Enter shows the section', (d) => d[0] === 'launcher:command' && d[1].kind === 'section' && d[1].section === 'notes')
    await ltype('Runbook')
    await luntil(`[...document.querySelectorAll('[role="group"][aria-label="Files"] .launcher-title')].some((t) => t.textContent === 'Runbook.pdf')`, 'Spotlight files')
    assert.ok(await ljs(`[...document.querySelectorAll('[role="group"][aria-label="Notes"] .launcher-title')].some((t) => t.textContent === 'Runbook')`), 'a note by name')
    for (let n = 0; n < 12 && (await ljs(picked)) !== 'Runbook.pdf'; n++) await lkey('ArrowDown')
    // The side pane: the file's kind, folder, size and dates, as in FileMinutes; ⌘Y is Quick Look.
    await luntil(`document.querySelector('.launcher-detail')?.textContent.includes('PDF document') && document.querySelector('.launcher-detail').textContent.includes('~/Documents') && document.querySelector('.launcher-detail').textContent.includes('1.2 MB')`, 'file details')
    assert.equal(await ljs(`document.querySelector('.launcher-item.on .launcher-sub')?.textContent`), '~/Documents', 'the folder under the name')
    await lshot('launcher-files.png')
    await lkey('y', { metaKey: true, code: 'KeyY' })
    await done('⌘Y is Quick Look', (d) => d[0] === 'launcher:quickLook' && d[1] === '/Users/fixture/Documents/Runbook.pdf')
    await lkey('Enter', { metaKey: true })
    for (let n = 0; n < 60 && calls.at(-1)?.channel !== 'local:reveal'; n++) await new Promise((r) => setTimeout(r, 30))
    assert.deepEqual(calls.filter((c) => c.channel === 'local:reveal').at(-1).args, ['/Users/fixture/Documents/Runbook.pdf'], '⌘↵ shows it in Finder')
    await ltype('why is nginx 502')
    await luntil(`[...document.querySelectorAll('.launcher-title')].some((t) => t.textContent.startsWith('Ask Claude'))`, 'ask claude')
    await ljs(`[...document.querySelectorAll('.launcher-item')].find((r) => r.textContent.startsWith('Ask Claude')).click()`)
    await done('ask claude', (d) => d[0] === 'launcher:command' && d[1].kind === 'ask' && d[1].app === 'claude' && d[1].text === 'why is nginx 502')
    await lkey('Escape')
    await luntil(`document.querySelector('.launcher-search input').value === ''`, 'Esc clears the field')
    const hides = launcherDone.filter((d) => d[0] === 'launcher:hide').length
    await lkey('Escape')
    await done('Esc on an empty field puts it away', () => launcherDone.filter((d) => d[0] === 'launcher:hide').length > hides)
    // Opened since: Visual Studio Code is a recent item now.
    lwin.webContents.send('launcher:shown', { at: Date.now() })
    await luntil(`[...document.querySelectorAll('[role="group"][aria-label="Recent"] .launcher-title')].some((t) => t.textContent === 'Visual Studio Code')`, 'recent items')
    lwin.destroy()
    launcherNotes = false

    // The Terminal tab: Warp-style tabs, split panes, command blocks and the input box, against a fake zsh.
    const twin = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { preload: join(__dirname, 'ui-preload.cjs'), contextIsolation: true, backgroundThrottling: false } })
    twin.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message) })
    const tjs = (code) => twin.webContents.executeJavaScript(code)
    const tuntil = async (code, what = code) => {
      for (let n = 0; n < 200; n++) { if (await tjs(code)) { if (process.env.UI_TRACE) console.log('[term ok]', what.slice(0, 70)); return } await new Promise((r) => setTimeout(r, 30)) }
      if (process.env.UI_TRACE) console.log('[term state]', JSON.stringify(calls.filter((c) => c.channel.startsWith('term:')).slice(-6).map((c) => [c.channel, String(c.args[1] ?? '').slice(0, 30)])), await tjs(`JSON.stringify({ rows: document.querySelector('.xterm-rows')?.textContent.slice(0, 200), gut: document.querySelectorAll('.tblock-gutter').length, screen: !!document.querySelector('.xterm-screen'), h: document.querySelector('.xterm-screen')?.offsetHeight })`))
      throw new Error(`Timed out (terminal): ${what}`)
    }
    const tshot = async (name) => { await tjs('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await new Promise((r) => setTimeout(r, 200)); writeFileSync(join(output, name), (await twin.webContents.capturePage()).toPNG()) }
    const tkey = (k, mods = {}) => tjs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true, ...${JSON.stringify(mods)} }))`)
    const focusedArea = `(document.querySelector('.term-slot:not([style*="none"]) .tpane.focused .tdock textarea') ?? document.querySelector('.term-slot:not([style*="none"]) .tdock textarea'))`
    const typeCmd = async (text, keyMods = {}) => {
      await tjs(`(() => { const a = ${focusedArea}; const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; a.focus(); set.call(a, ${JSON.stringify(text)}); a.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    }
    const pressIn = (k, mods = {}) => tjs(`${focusedArea}.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true, ...${JSON.stringify(mods)} }))`)
    const screenText = () => tjs(`[...document.querySelectorAll('.term-slot:not([style*="none"]) .xterm-rows')].map((r) => r.textContent).join('\\n')`)
    const termWrites = () => calls.filter((c) => c.channel === 'term:write').map((c) => c.args[1])
    await twin.loadFile(resolve('out/renderer/index.html'))
    await tuntil(`document.querySelectorAll('[data-host-key]').length > 0`)
    await tkey('`', { ctrlKey: true, code: 'Backquote' })
    await tuntil(`document.querySelectorAll('.term-tab').length === 1 && !!document.querySelector('.tdock textarea')`, '⌃` opens the Terminal with the input box')
    assert.equal(await tjs(`!!document.querySelector('.term-side .term-tab')`), true, 'tabs are down the side by default')
    // Output sits against the bottom, by the input box, as in Warp: a fresh shell's prompt is on the last rows of the
    // pane, with the empty rows above it, not at the top.
    await tuntil(`(() => { const x = document.querySelector('.term-slot:not([style*="none"]) .tpane-xterm'); return !!x && /translateY\\(\\d+px\\)/.test(x.style.transform) })()`, 'a short output is moved to the bottom')
    assert.equal(await tjs(`(() => {
      const pane = document.querySelector('.term-slot:not([style*="none"]) .tpane-term')
      const rows = [...pane.querySelectorAll('.xterm-rows > div')].filter((r) => r.textContent.trim())
      const last = rows[rows.length - 1].getBoundingClientRect()
      const area = pane.getBoundingClientRect()
      return area.bottom - last.bottom < 40 && rows[0].getBoundingClientRect().top - area.top > 100
    })()`), true, 'the prompt is at the bottom with empty space above')
    await tuntil(`document.querySelector('.term-side .term-tab.on .term-tab-branch')?.textContent === 'main'`, 'the side list shows the tab\'s Git branch, as in Warp')
    // The ribbon along the bottom of the pane, as in Warp: Git changes, workflows, Finder, the input-box switch, the
    // folder and the branch. With the whole width it has its labels and does not overflow.
    const ribbon = `document.querySelector('.term-slot:not([style*="none"]) .tribbon')`
    await tuntil(`${ribbon}?.querySelector('.trib-chip.folder')?.textContent.includes('~/proj') && ${ribbon}.querySelector('.trib-chip.branch .trib-text')?.textContent === 'main'`, 'ribbon: folder and branch chips')
    await tuntil(`${ribbon}.querySelector('.trib-count')?.textContent === '6'`, 'ribbon: the Git changes')
    assert.equal(await tjs(`${ribbon}.querySelector('.trib-pm').textContent + ' ' + ${ribbon}.querySelector('.trib-count').textContent + ' ' + ${ribbon}.querySelector('.trib-add').textContent + ' ' + ${ribbon}.querySelector('.trib-del').textContent`), '± 6 +31 −8')
    assert.ok(calls.some((c) => c.channel === 'term:git' && c.args[0] === '/Users/fixture/proj'), 'Git status of the pane\'s folder')
    assert.equal(await tjs(`(() => { const r = ${ribbon}; return r.scrollWidth <= r.clientWidth && getComputedStyle(r.querySelector('.trib-label')).display !== 'none' && r.getBoundingClientRect().bottom === r.closest('.tpane').getBoundingClientRect().bottom })()`), true, 'a wide ribbon: labels, no overflow, at the very bottom')
    assert.equal(await tjs(`${ribbon}.querySelector('.trib-chip.rich').getAttribute('aria-pressed')`), 'true', 'Rich input shows on')
    await tshot('terminal-ribbon.png')
    // The Git chip lists the changed files with their status letters.
    await tjs(`${ribbon}.querySelector('.trib-chip.git').click()`)
    await tuntil(`document.querySelectorAll('.popover .trib-file').length === 2`, 'ribbon: changed files listed')
    assert.deepEqual(await tjs(`[...document.querySelectorAll('.popover .trib-file')].map((f) => f.querySelector('.trib-st').textContent + ' ' + f.querySelector('.trib-file-path').textContent)`), ['M src/app.ts', '? notes/todo.md'])
    assert.match(await tjs(`document.querySelector('.popover .trib-pop-head').textContent`), /6 changed files.*\+31.*−8/)
    await tshot('terminal-ribbon-git.png')
    await tkey('Escape')
    await tuntil(`!document.querySelector('.popover')`)
    // ⌃G at the prompt: from the input box to typing straight into the shell, and back from the shell (never sent to it).
    const writesBeforeG = termWrites().length
    await pressIn('g', { ctrlKey: true })
    await tuntil(`!document.querySelector('.term-slot:not([style*="none"]) .tdock') && ${ribbon}.querySelector('.trib-chip.rich').getAttribute('aria-pressed') === 'false'`, '⌃G: straight into the shell')
    await tshot('terminal-ribbon-shell.png')
    await tjs(`document.querySelector('.term-slot:not([style*="none"]) .xterm-helper-textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'g', code: 'KeyG', ctrlKey: true, bubbles: true, cancelable: true }))`)
    await tuntil(`!!document.querySelector('.term-slot:not([style*="none"]) .tdock textarea') && ${ribbon}.querySelector('.trib-chip.rich').getAttribute('aria-pressed') === 'true'`, '⌃G in the shell brings the input box back')
    assert.ok(!termWrites().slice(writesBeforeG).some((d) => d.includes('\x07')), '⌃G at the prompt is not sent to the shell')
    // The Rich input chip does the same.
    await tjs(`${ribbon}.querySelector('.trib-chip.rich').click()`)
    await tuntil(`!document.querySelector('.term-slot:not([style*="none"]) .tdock')`, 'Rich input off')
    await tjs(`${ribbon}.querySelector('.trib-chip.rich').click()`)
    await tuntil(`!!document.querySelector('.term-slot:not([style*="none"]) .tdock textarea')`, 'Rich input on')
    // History: the ribbon opens the input box's history search.
    await tjs(`[...${ribbon}.querySelectorAll('.trib-chip')].find((b) => b.getAttribute('aria-label') === 'History').click()`)
    await tuntil(`!!document.querySelector('.term-slot:not([style*="none"]) .tdock-pop input[aria-label="Search command history"]')`, 'ribbon: history search')
    await tjs(`document.querySelector('.term-slot:not([style*="none"]) .tdock-pop input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
    await tuntil(`!document.querySelector('.term-slot:not([style*="none"]) .tdock-pop')`)
    // The mic hands this pane to dictation (voice.ts): pressed while it listens, the words appear live in the input
    // box, and a second click finishes. (The fixture's "helper" hears "connect to web prod one".)
    const dock = `document.querySelector('.term-slot:not([style*="none"]) .tdock textarea')`
    await tjs(`window.__dictate = []; window.addEventListener('ec2ra:dictate', (e) => window.__dictate.push(e.detail)); 0`)
    await tjs(`${ribbon}.querySelector('.trib-chip.mic').click()`)
    assert.deepEqual(await tjs(`window.__dictate.map((d) => [d.action, !!d.target?.classList.contains('tpane')])`), [['toggle', true]])
    await tuntil(`${ribbon}.querySelector('.trib-chip.mic').getAttribute('aria-pressed') === 'true' && !!document.querySelector('.voice-hud')`, 'mic pressed while dictating')
    await tuntil(`${dock}?.value.includes('onnect to web prod')`, 'live words in the input box')
    assert.equal(await tjs(`document.querySelector('.voice-hud').getBoundingClientRect().bottom <= ${dock}.getBoundingClientRect().top`), true, 'the dictation pill sits above the input box, not over it')
    await tshot('terminal-ribbon-mic.png')
    await tjs(`${ribbon}.querySelector('.trib-chip.mic').click()`)
    await tuntil(`${ribbon}.querySelector('.trib-chip.mic').getAttribute('aria-pressed') === 'false' && !document.querySelector('.voice-hud')`, 'mic released when dictation ends')
    assert.match(await tjs(`${dock}.value`), /onnect to web prod one$/, 'the final words replace the live ones')
    assert.equal(termWrites().filter((d) => d.includes('web prod')).length, 0, 'nothing reached the shell: the words wait in the input box')
    await tjs(`(() => { const a = ${dock}; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(a, ''); a.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    // On a light scheme the ribbon follows the terminal's colours.
    const termTheme = async (id) => {
      await tjs(`document.querySelector('button[aria-label="Settings"]').click()`)
      await tuntil(`!!document.querySelector('.settings-nav [data-section="terminal"]')`, 'settings')
      await tjs(`document.querySelector('.settings-nav [data-section="terminal"]').click()`)
      await tuntil(`!!document.querySelector('[role="dialog"] select option[value="${id}"]')`, `${id} offered`)
      await tjs(`(() => { const sel = document.querySelector('[role="dialog"] select option[value="${id}"]').closest('select'); sel.value = '${id}'; sel.dispatchEvent(new Event('change', { bubbles: true })) })()`)
      await tjs(`document.querySelector('[role="dialog"] [aria-label="Close dialog"]').click()`)
      await tuntil(`!document.querySelector('[role="dialog"]')`)
    }
    const themeBeforeRibbon = settings.terminalTheme ?? 'auto'
    await termTheme('github-light')
    await tuntil(`getComputedStyle(${ribbon}).backgroundColor !== '' && getComputedStyle(document.querySelector('.term-slot:not([style*="none"]) .tpane')).getPropertyValue('--term-bg').trim() === '#ffffff'`, 'light scheme')
    await tshot('terminal-ribbon-light.png')
    await termTheme(themeBeforeRibbon)
    // The folder chip's menu copies the path; the branch chip copies the branch name.
    await tjs(`${ribbon}.querySelector('.trib-chip.folder').click()`)
    await tuntil(`!!document.querySelector('.popover .menu-item')`)
    await tjs(`[...document.querySelectorAll('.popover .menu-item')].find((b) => b.textContent === 'Copy path').click()`)
    await tuntil(`!document.querySelector('.popover')`)
    for (let n = 0; n < 50 && calls.filter((c) => c.channel === 'clipboard:write').at(-1)?.args[0] !== '/Users/fixture/proj'; n++) await new Promise((r) => setTimeout(r, 30))
    assert.equal(calls.filter((c) => c.channel === 'clipboard:write').at(-1).args[0], '/Users/fixture/proj')
    await tjs(`${ribbon}.querySelector('.trib-chip.branch').click()`)
    for (let n = 0; n < 50 && calls.filter((c) => c.channel === 'clipboard:write').at(-1)?.args[0] !== 'main'; n++) await new Promise((r) => setTimeout(r, 30))
    assert.equal(calls.filter((c) => c.channel === 'clipboard:write').at(-1).args[0], 'main')
    // A command typed in the input box runs in the shell and becomes a block.
    await typeCmd('echo hi')
    await pressIn('Enter')
    await tuntil(`!!document.querySelector('.tblock-gutter.ok')`, 'successful block')
    // xterm paints rows on the next frame, so wait for the text rather than reading it once.
    await tuntil(`[...document.querySelectorAll('.term-slot:not([style*="none"]) .xterm-rows')].some((r) => r.textContent.includes('hi'))`, 'the output is on screen')
    await typeCmd('false')
    await pressIn('Enter')
    await tuntil(`!!document.querySelector('.tblock-gutter.err')`, 'failed block')
    // Hovering a block shows its actions; Copy output copies just the output.
    await tjs(`(() => { const g = document.querySelector('.tblock-gutter.ok').getBoundingClientRect(); document.querySelector('.term-slot:not([style*="none"]) .tpane-term').dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: g.left + 200, clientY: g.top + 2 })) })()`)
    await tuntil(`!!document.querySelector('.tblock-bar')`, 'block toolbar')
    await tshot('terminal-blocks.png')
    await tjs(`document.querySelector('.tblock-bar button[title="Copy the output"]').click()`)
    for (let n = 0; n < 50 && calls.filter((c) => c.channel === 'clipboard:write').at(-1)?.args[0] !== 'hi'; n++) await new Promise((r) => setTimeout(r, 30))
    // Cyber Wave (Warp's theme): a teal-to-black gradient behind the text, with xterm's own background out of the way.
    const themeBefore = settings.terminalTheme
    await tjs(`document.querySelector('button[aria-label="Settings"]').click()`)
    await tuntil(`!!document.querySelector('.settings-nav [data-section="terminal"]')`, 'settings')
    await tjs(`document.querySelector('.settings-nav [data-section="terminal"]').click()`)
    await tuntil(`!!document.querySelector('[role="dialog"] select option[value="cyber-wave"]')`, 'cyber wave offered')
    await tjs(`(() => { const sel = document.querySelector('[role="dialog"] select option[value="cyber-wave"]').closest('select'); sel.value = 'cyber-wave'; sel.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    await tuntil(`getComputedStyle(document.querySelector('.set-preview')).backgroundImage.includes('gradient')`, 'settings preview shows the gradient')
    await tjs(`document.querySelector('[role="dialog"] [aria-label="Close dialog"]').click()`)
    await tuntil(`!document.querySelector('[role="dialog"]') && getComputedStyle(document.querySelector('.term-slot:not([style*="none"]) .tpane')).backgroundImage.includes('linear-gradient')`, 'terminal pane has the gradient')
    assert.equal(await tjs(`getComputedStyle(document.querySelector('.term-slot:not([style*="none"]) .xterm-scrollable-element')).backgroundColor`), 'rgba(0, 0, 0, 0)', 'xterm paints no background of its own')
    await tshot('terminal-cyber-wave.png')
    await tjs(`window.api.invoke('settings:set', { terminalTheme: ${JSON.stringify(themeBefore ?? 'auto')} })`)
    assert.equal(calls.filter((c) => c.channel === 'clipboard:write').at(-1).args[0], 'hi')
    // Colour themes from the rail: the terminal follows the main theme even after a scheme of its own was picked
    // (Cyber Wave, just above), and Cyber Wave fades the chrome too.
    const pickTheme = async (label) => {
      await tjs(`document.querySelector('.app-rail button[aria-label="Theme"]').click()`)
      await tuntil(`!!document.querySelector('.popover .theme-menu-list')`, 'theme menu')
      await tjs(`[...document.querySelectorAll('.popover .menu-item')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)})).click()`)
    }
    await pickTheme('Dracula')
    await tuntil(`document.documentElement.dataset.colorTheme === 'dracula' && getComputedStyle(document.querySelector('.term-slot:not([style*="none"]) .tpane')).backgroundColor === 'rgb(40, 42, 54)'`, 'the terminal follows to Dracula')
    assert.equal(settings.colorTheme, 'dracula')
    assert.equal(settings.terminalTheme, 'auto', 'the terminal is back on Match app')
    await pickTheme('Cyber Wave')
    await tuntil(`document.documentElement.dataset.colorTheme === 'cyber-wave' && getComputedStyle(document.querySelector('.term-slot:not([style*="none"]) .tpane')).backgroundImage.includes('linear-gradient') && getComputedStyle(document.querySelector('.app-rail')).backgroundImage.includes('linear-gradient')`, 'Cyber Wave across the app')
    assert.equal(await tjs(`document.querySelector('.app-rail button[aria-label="Theme"] .rail-label').textContent`), 'Theme')
    await tshot('app-theme-cyber-wave.png')
    await pickTheme('Dark')
    await tuntil(`!document.documentElement.dataset.colorTheme && document.documentElement.style.getPropertyValue('--bg') === ''`, 'back to the default colours')
    assert.equal(settings.colorTheme, '')
    // History on ↑, and a suggestion from history.
    await typeCmd('')
    await pressIn('ArrowUp')
    await tuntil(`${focusedArea}.value === 'false'`, 'history recall')
    await typeCmd('git c')
    await tuntil(`document.querySelector('.tdock-ghost-rest')?.textContent === 'heckout main'`, 'history suggestion')
    await pressIn('ArrowRight')
    await tuntil(`${focusedArea}.value === 'git checkout main'`, 'suggestion accepted')
    await typeCmd('')
    // A long command: the running bar, and ⌃C stops it.
    await typeCmd('sleep 10')
    await pressIn('Enter')
    await tuntil(`!!document.querySelector('.tdock.running')`, 'running bar')
    await tjs(`document.querySelector('.tdock-btn').click()`)
    await tuntil(`!!document.querySelector('.tdock textarea') && document.querySelectorAll('.tblock-gutter.err').length === 2`, '⌃C stops it')
    // Tab hands the line to the shell (its own completion), and the box comes back at the next prompt.
    await typeCmd('ls')
    await pressIn('Tab')
    assert.equal(termWrites().at(-1), 'ls\t')
    await tuntil(`!document.querySelector('.term-slot:not([style*="none"]) .tdock')`, 'the shell has the line')
    twin.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    twin.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
    twin.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    await tuntil(`!!document.querySelector('.term-slot:not([style*="none"]) .tdock textarea')`, 'input box back at the next prompt')
    // Workflows (saved commands) from the ribbon: one marked to run is run.
    await tjs(`[...document.querySelector('.term-slot:not([style*="none"]) .tribbon').querySelectorAll('.trib-chip')].find((b) => b.getAttribute('aria-label') === 'Workflows').click()`)
    await tuntil(`[...document.querySelectorAll('.popover .menu-item')].some((b) => b.textContent.includes('Disk usage'))`, 'ribbon: workflows listed')
    await tjs(`[...document.querySelectorAll('.popover .menu-item')].find((b) => b.textContent.includes('Disk usage')).click()`)
    for (let n = 0; n < 50 && !termWrites().some((d) => d.includes('df -h')); n++) await new Promise((r) => setTimeout(r, 30))
    assert.ok(termWrites().some((d) => d.includes('df -h') && d.endsWith('\r')), 'the workflow runs')
    await tuntil(`!!document.querySelector('.term-slot:not([style*="none"]) .tdock textarea')`, 'back at the prompt after the workflow')
    // Splits: ⌘D opens a pane in the same folder, ⌥⌘← moves focus, ⌘W closes the focused pane.
    const opens = () => calls.filter((c) => c.channel === 'term:open').map((c) => c.args[0])
    const opensAtSplit = opens().length
    await tkey('d', { metaKey: true })
    await tuntil(`document.querySelectorAll('.term-slot:not([style*="none"])').length === 2`, 'split right')
    assert.equal(opens().length, opensAtSplit + 1)
    assert.equal(opens().at(-1).cwd, '/Users/fixture/proj', 'the new pane starts in the same folder')
    await tuntil(`document.querySelectorAll('.term-slot:not([style*="none"]) .tdock textarea').length === 2`)
    // Half the width: the ribbon folds its labels away to icons and still fits.
    await tuntil(`[...document.querySelectorAll('.term-slot:not([style*="none"]) .tribbon')].every((r) => r.clientWidth > 0 && r.clientWidth < 700 && r.scrollWidth <= r.clientWidth && [...r.querySelectorAll('.trib-label')].every((l) => getComputedStyle(l).display === 'none') && !!r.querySelector('.trib-chip.branch') && r.querySelector('.trib-count')?.textContent === '6')`, 'narrow panes: icon-only ribbon without overflow')
    await tshot('terminal-split.png')
    await tkey('ArrowLeft', { metaKey: true, altKey: true })
    await tuntil(`document.querySelector('.term-slot:not([style*="none"]) .tpane.focused') === document.querySelectorAll('.term-slot:not([style*="none"]) .tpane')[0]`, 'focus moves left')
    await tkey('w', { metaKey: true })
    await tuntil(`document.querySelectorAll('.term-slot:not([style*="none"])').length === 1`, '⌘W closes the pane')
    // Layouts: four panes in a grid in one go, and back to one (after confirming the others close).
    const pickLayout = async (label) => {
      await tjs(`document.querySelector('.term-tool[aria-label="Pane layout"]').click()`)
      await tuntil(`!!document.querySelector('.popover .tl-icon.grid')`)
      await tjs(`[...document.querySelectorAll('.popover .menu-item')].find((b) => b.textContent.includes(${JSON.stringify(label)})).click()`)
    }
    const termOpensBeforeGrid = opens().length
    await pickLayout('Four in a grid')
    await tuntil(`document.querySelectorAll('.term-slot:not([style*="none"])').length === 4 && document.querySelectorAll('.term-slot:not([style*="none"]) .tdock textarea').length === 4`, '2×2 grid')
    assert.equal(opens().length, termOpensBeforeGrid + 3, 'three new shells')
    const rects = await tjs(`[...document.querySelectorAll('.term-slot:not([style*="none"])')].map((s) => s.style.left + ',' + s.style.top + ',' + s.style.width + ',' + s.style.height)`)
    assert.deepEqual(rects.sort(), ['0%,0%,50%,50%', '0%,50%,50%,50%', '50%,0%,50%,50%', '50%,50%,50%,50%'])
    await tshot('terminal-grid.png')
    await tkey('ArrowDown', { metaKey: true, altKey: true })
    await tuntil(`document.querySelectorAll('.term-slot:not([style*="none"])')[2]?.querySelector('.tpane.focused') !== null`, 'focus moves down in the grid')
    await tjs('void (window.confirm = () => true)')
    await pickLayout('One pane')
    await tuntil(`document.querySelectorAll('.term-slot:not([style*="none"])').length === 1`, 'back to one pane')
    // Tabs: ⌘T, ⌘1, rename by double-click, and a tab for an AWS profile.
    await tkey('t', { metaKey: true })
    await tuntil(`document.querySelectorAll('.term-tab').length === 2 && document.querySelectorAll('.term-tab')[1].classList.contains('on')`, 'new tab')
    await tkey('1', { metaKey: true })
    await tuntil(`document.querySelectorAll('.term-tab')[0].classList.contains('on')`, '⌘1')
    await tjs(`document.querySelectorAll('.term-tab')[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
    await tuntil(`!!document.querySelector('.term-tab-rename')`)
    await tjs(`(() => { const i = document.querySelector('.term-tab-rename'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'build'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })()`)
    await tuntil(`document.querySelectorAll('.term-tab .term-tab-title')[0]?.textContent === 'build'`, 'renamed')
    await tjs(`document.querySelector('.term-tab-more').click()`)
    await tuntil(`!!document.querySelector('.popover')`)
    await tjs(`[...document.querySelectorAll('.popover .menu-item')].find((b) => b.textContent.includes('Production')).click()`)
    await tuntil(`document.querySelectorAll('.term-tab').length === 3 && document.querySelector('.term-tab.on .term-tab-aws')?.textContent === 'production'`, 'AWS profile tab')
    assert.deepEqual(opens().at(-1).env, { AWS_PROFILE: 'production' })
    await tuntil(`document.querySelector('.term-slot:not([style*="none"]) .tribbon .trib-chip.aws')?.textContent === 'production'`, 'AWS chip')
    // Each tab: the folder as its name, and underneath, as in Warp, the Git branch (the fixture's shell reports "main").
    await tuntil(`document.querySelectorAll('.term-side .term-tab-sub')[0]?.textContent.startsWith('main') && !!document.querySelectorAll('.term-side .term-tab-sub')[0].querySelector('.term-tab-branch-icon')`, 'side list shows the branch')
    await tshot('terminal-vertical-tabs.png')
    // Tabs across the top instead, and back down the side.
    const termSetting = async (label) => {
      await tjs(`document.querySelector('.term-tool[aria-label="Terminal settings"]').click()`)
      await tuntil(`!!document.querySelector('.popover')`)
      await tjs(`[...document.querySelectorAll('.popover .menu-item')].find((b) => b.textContent.startsWith(${JSON.stringify(label)})).click()`)
      await tkey('Escape')
      await tuntil(`!document.querySelector('.popover')`)
    }
    await termSetting('Across the top')
    await tuntil(`!!document.querySelector('.term-tabs .term-tab') && !document.querySelector('.term-side')`, 'tabs across the top')
    await termSetting('Down the side')
    await tuntil(`!!document.querySelector('.term-side .term-tab')`, 'tabs down the side again')
    // Typing straight into the shell instead: no input box.
    await tjs(`document.querySelector('.term-tool[aria-label="Terminal settings"]').click()`)
    await tjs(`[...document.querySelectorAll('.popover .menu-item')].find((b) => b.textContent.startsWith('Straight into')).click()`)
    await tuntil(`!document.querySelector('.term-slot:not([style*="none"]) .tdock')`, 'shell input mode')
    await tkey('Escape')
    // The layout is saved and the shells start again in their folders after a restart.
    for (let n = 0; n < 60 && !(termSaved?.tabs.length === 3 && termSaved.input === 'shell'); n++) await new Promise((r) => setTimeout(r, 50))
    assert.equal(termSaved.tabs.length, 3)
    assert.equal(termSaved.tabs[0].title, 'build')
    const opensBefore = opens().length
    await twin.reload()
    await tuntil(`document.querySelectorAll('[data-host-key]').length > 0`)
    await tkey('`', { ctrlKey: true, code: 'Backquote' })
    await tuntil(`document.querySelectorAll('.term-tab').length === 3 && document.querySelectorAll('.term-tab .term-tab-title')[0]?.textContent === 'build'`, 'restored tabs')
    for (let n = 0; n < 60 && opens().length < opensBefore + 1; n++) await new Promise((r) => setTimeout(r, 50))
    assert.equal(opens().at(-1).cwd, '/Users/fixture/proj', 'restored shell starts in its folder')

    // The Finder tab: the Finder favorites and locations, folders and files with Finder's columns, going in and back, a
    // new folder named in place, Quick Look, opening a file, Add to Favorites, Spotlight search, Recents and the Trash.
    await tjs(`document.querySelector('button[aria-label="Finder"]').click()`)
    await tuntil(`document.querySelectorAll('.fi-group .fi-place').length >= 5 && [...document.querySelectorAll('.fi-row')].some((r) => r.textContent.includes('Documents'))`, 'finder opens at home')
    assert.equal(await tjs(`[...document.querySelectorAll('.fi-row')].some((r) => r.textContent.includes('.zshrc'))`), false, 'hidden files stay hidden')
    assert.equal(await tjs(`document.querySelector('.sidebar')?.getClientRects().length ?? 0`), 0, 'the hosts sidebar steps aside')
    await tjs(`[...document.querySelectorAll('.fi-place')].find((b) => b.textContent === 'Documents').click()`)
    await tuntil(`[...document.querySelectorAll('.fi-row')].some((r) => r.textContent.includes('Runbook.pdf'))`, 'documents favorite')
    assert.equal(await tjs(`(() => { const r = [...document.querySelectorAll('.fi-row')].find((x) => x.textContent.includes('Runbook.pdf')); return r.querySelector('.kind').textContent + ' / ' + r.querySelector('.size').textContent })()`), 'PDF document / 1.2 MB')
    const row = (name) => `[...document.querySelectorAll('.fi-row')].find((r) => r.querySelector('.name').textContent.startsWith(${JSON.stringify(name)}))`
    await tjs(`${row('Surendra-Personal')}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
    await tuntil(`document.querySelector('.fi-title').textContent === 'Surendra-Personal' && [...document.querySelectorAll('.fi-step')].map((s) => s.textContent.replace('›', '')).join('/').includes('Documents/Surendra-Personal')`, 'into a folder, path bar follows')
    await tjs(`document.querySelector('.fi-btn[aria-label="Back"]').click()`)
    await tuntil(`document.querySelector('.fi-title').textContent === 'Documents'`, 'back')
    await tjs(`document.querySelector('.fi-btn[aria-label="New folder"]').click()`)
    await tuntil(`document.querySelector('.fi-rename')?.value === 'untitled folder' && document.activeElement === document.querySelector('.fi-rename')`, 'new folder, named in place')
    await tjs(`(() => { const i = document.querySelector('.fi-rename'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'Reports'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })()`)
    await tuntil(`!document.querySelector('.fi-rename') && [...document.querySelectorAll('.fi-row')].some((r) => r.textContent.includes('Reports'))`, 'renamed')
    assert.deepEqual(finderDone.at(-1), ['rename', '/Users/fixture/Documents/untitled folder', '/Users/fixture/Documents/Reports'])
    await tjs(`${row('notes.md')}.click()`)
    await tkey(' ')
    await tuntil(`true`)
    for (let n = 0; n < 40 && finderDone.at(-1)?.[0] !== 'quickLook'; n++) await new Promise((r) => setTimeout(r, 30))
    assert.deepEqual(finderDone.at(-1), ['quickLook', '/Users/fixture/Documents/notes.md'], 'Space is Quick Look')
    await tjs(`${row('Runbook.pdf')}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
    for (let n = 0; n < 40 && finderDone.at(-1)?.[0] !== 'open'; n++) await new Promise((r) => setTimeout(r, 30))
    assert.deepEqual(finderDone.at(-1), ['open', '/Users/fixture/Documents/Runbook.pdf'], 'a file opens in its app')
    await tjs(`${row('Surendra-Personal')}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 600, clientY: 300 }))`)
    await tuntil(`[...document.querySelectorAll('.popover .menu-item')].some((b) => b.textContent === 'Add to Favorites')`, 'folder menu')
    await tjs(`[...document.querySelectorAll('.popover .menu-item')].find((b) => b.textContent === 'Add to Favorites').click()`)
    await tuntil(`[...document.querySelectorAll('.fi-place')].some((b) => b.textContent === 'Surendra-Personal')`, 'added to favorites')
    assert.deepEqual(settings.finderExtra, ['/Users/fixture/Documents/Surendra-Personal'])
    await tjs(`(() => { const i = document.querySelector('.fi-search input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'pass'); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await tuntil(`document.querySelector('.fi-banner')?.textContent.startsWith('1 found') && ${row('Passport.pdf')}?.querySelector('.fi-where')?.textContent === '~/Documents/Surendra-Personal'`, 'search finds it below the folder')
    await tshot('finder.png')
    await tjs(`document.querySelector('.fi-search button[aria-label="Clear search"]').click()`)
    await tuntil(`!!${row('notes.md')}`, 'search cleared')
    // Open With: the item's apps (the default first) in a submenu beside the row.
    const menuItem = (label) => `[...document.querySelectorAll('.popover .menu-item')].find((b) => b.textContent.startsWith(${JSON.stringify(label)}))`
    await tjs(`${row('notes.md')}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 600, clientY: 300 }))`)
    await tuntil(`!!${menuItem('Open With')}`, 'file menu with Open With')
    await tjs(`${menuItem('Open With')}.click()`)
    await tuntil(`document.querySelectorAll('.popover').length === 2 && [...document.querySelectorAll('.popover .fi-app')].map((a) => a.textContent).join('|') === 'TextEdit (default)|Visual Studio Code'`, 'open with lists the apps')
    assert.ok(await tjs(`(() => { const [m, s] = document.querySelectorAll('.popover'); return s.getBoundingClientRect().left >= m.getBoundingClientRect().right - 4 })()`), 'the submenu opens beside the menu')
    await tshot('finder-open-with.png')
    await tjs(`[...document.querySelectorAll('.popover .menu-item')].find((b) => b.textContent === 'Visual Studio Code').click()`)
    await tuntil(`!document.querySelector('.popover')`, 'menus close')
    assert.deepEqual(finderDone.at(-1), ['openWith', ['/Users/fixture/Documents/notes.md'], '/Applications/Visual Studio Code.app'])
    // Copy puts the files on the clipboard, ⌥⌘C the path; Duplicate copies beside; a paste of files (from Finder, say)
    // copies them here; the Paste menu item asks for Edit → Paste.
    await tjs(`${row('Runbook.pdf')}.click()`)
    await tkey('c', { metaKey: true })
    for (let n = 0; n < 40 && finderDone.at(-1)?.[0] !== 'copy'; n++) await new Promise((r) => setTimeout(r, 30))
    assert.deepEqual(finderDone.at(-1), ['copy', '/Users/fixture/Documents/Runbook.pdf'], '⌘C copies the file')
    await tkey('d', { metaKey: true })
    await tuntil(`${row('Runbook copy.pdf')}?.classList.contains('on')`, '⌘D duplicates beside it and selects the copy')
    await tjs(`(() => { const dt = new DataTransfer(); dt.items.add(new File(['x'], 'fixture-path|Users|fixture|Projects|main.go')); document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })) })()`)
    await tuntil(`${row('main.go')}?.classList.contains('on')`, 'pasted files are copied into this folder')
    assert.deepEqual(finderDone.at(-1), ['paste', '/Users/fixture/Documents/main.go'])
    await tjs(`document.querySelector('.fi-list').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 700, clientY: 520 }))`)
    await tuntil(`!!${menuItem('Paste')}`, 'background menu has Paste')
    await tjs(`${menuItem('Paste')}.click()`)
    for (let n = 0; n < 40 && finderDone.at(-1)?.[0] !== 'pasteCommand'; n++) await new Promise((r) => setTimeout(r, 30))
    assert.deepEqual(finderDone.at(-1), ['pasteCommand'], 'the menu item pastes through Edit → Paste')
    await tjs(`${row('Runbook.pdf')}.click()`)
    await tkey('Backspace', { metaKey: true })
    await tuntil(`![...document.querySelectorAll('.fi-row')].some((r) => r.textContent.includes('Runbook.pdf'))`, '⌘⌫ moves to the Trash')
    assert.deepEqual(finderDone.at(-1), ['trash', '/Users/fixture/Documents/Runbook.pdf'])
    await tjs(`[...document.querySelectorAll('.fi-place')].find((b) => b.textContent === 'Recents').click()`)
    await tuntil(`document.querySelector('.fi-title').textContent === 'Recents' && document.querySelectorAll('.fi-row').length === 2 && document.querySelector('.fi-th.on')?.textContent.startsWith('Name') !== undefined`, 'recents')
    assert.match(await tjs(`document.querySelectorAll('.fi-row')[0].querySelector('.date').textContent`), /^Today at /)

    // Run Command on the hosts listed: a confirmation for production, then each host's result and output; retry the failed.
    await tjs(`document.querySelector('button[aria-label="Hosts"]').click()`)
    await tuntil(`!!document.querySelector('[data-host-key]')`, 'hosts view')
    await tjs(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Run command' && !b.closest('tr')).click()`)
    await tuntil(`!!document.querySelector('.rc .rc-count')`, 'run command dialog')
    const runnable = Number(await tjs(`document.querySelector('.rc .rc-count').textContent`))
    assert.ok(runnable >= 1, 'the listed running hosts with SSM are targets')
    await tjs(`(() => { const a = document.querySelector('.rc-command'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(a, 'uptime && df -h /data'); a.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await tjs(`window.__confirmed = []; window.confirm = (m) => { window.__confirmed.push(m); return true }; 0`)
    await tjs(`document.querySelector('.rc-foot .btn-primary').click()`)
    await tuntil(`document.querySelectorAll('.rc-result').length === ${runnable} && !!document.querySelector('.rc-chip.ok')`, 'results list')
    assert.match(await tjs(`window.__confirmed[0] ?? ''`), /including production/, 'production asks first')
    assert.deepEqual(runsSent.at(-1).command, 'uptime && df -h /data')
    await tuntil(`document.querySelector('.rc-chip.ok')?.textContent.includes('1 succeeded') && !document.querySelector('.rc-chip.run')`, 'run finishes')
    await tjs(`[...document.querySelectorAll('.rc-result-head')].find((b) => b.textContent.includes('web-prod-01')).click()`)
    await tuntil(`document.querySelector('.rc-pre')?.textContent.includes('load average')`, 'output shown')
    await tshot('run-command.png')
    if (runnable > 1) {
      await tjs(`[...document.querySelectorAll('.rc-foot button')].find((b) => b.textContent.startsWith('Retry failed')).click()`)
      await tuntil(`document.querySelectorAll('.rc-result').length === ${runnable - 1}`, 'retry runs only the failed hosts')
      assert.equal(runsSent.at(-1).targets.length, runnable - 1)
    }
    await tjs(`[...document.querySelectorAll('.rc-foot button')].find((b) => b.textContent === 'Done').click()`)
    await tuntil(`!document.querySelector('.rc')`, 'dialog closes')

    // The Whiteboard: pen, shapes, a sticky note, selecting, deleting, undo, saving, a second board, and a PNG into today's note.
    await tjs(`document.querySelector('button[aria-label="Whiteboard"]').click()`)
    await tuntil(`!!document.querySelector('.board-svg') && !!document.querySelector('.board-hint')`, 'whiteboard opens on an empty board')
    for (let n = 0; n < 60 && !Object.values(boardsSaved).some((b) => b.name === 'Brainstorm'); n++) await new Promise((r) => setTimeout(r, 50))
    assert.ok(Object.values(boardsSaved).some((b) => b.name === 'Brainstorm'), 'a first board is created and saved')
    assert.equal(await tjs(`document.querySelector('.bt-btn.on').getAttribute('aria-label')`), 'Pen', 'the pen is ready')
    const ptr = (type, x, y, extra = {}) => tjs(`(() => { const r = document.querySelector('.board-svg').getBoundingClientRect(); document.querySelector('.board-svg').dispatchEvent(new PointerEvent(${JSON.stringify(type)}, { clientX: r.left + ${x}, clientY: r.top + ${y}, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: ${type === 'pointerup' ? 0 : 1}, bubbles: true, cancelable: true, ...${JSON.stringify(extra)} })) })()`)
    const stroke = async (points, extra) => {
      await ptr('pointerdown', ...points[0], extra)
      for (const p of points.slice(1)) await ptr('pointermove', ...p, extra)
      await ptr('pointerup', ...points.at(-1), extra)
    }
    const boardItems = () => tjs(`document.querySelectorAll('.board-items > *').length`)
    await stroke([[120, 200], [160, 180], [200, 210], [240, 190], [280, 220], [320, 200]])
    await tuntil(`document.querySelectorAll('.board-items > path').length === 1 && !document.querySelector('.board-hint')`, 'a pen stroke')
    await tkey('r')
    await stroke([[380, 150], [450, 200], [560, 260]])
    await tkey('a')
    await stroke([[580, 200], [650, 205], [700, 210]])
    await tkey('o')
    await tkey('3')
    await stroke([[150, 300], [250, 380], [330, 420]])
    await tuntil(`document.querySelectorAll('.board-items > rect').length === 1 && document.querySelectorAll('.board-items > ellipse').length === 1 && document.querySelectorAll('.board-items > g polygon').length === 1`, 'rectangle, arrow and ellipse')
    assert.equal(await tjs(`document.querySelector('.board-items > ellipse').getAttribute('stroke')`), '#0090ff', 'key 3 picks the third colour')
    // A sticky note: placed on release, typed into, kept when the editor closes.
    await tkey('n')
    await ptr('pointerdown', 840, 220)
    await ptr('pointerup', 840, 220)
    await tuntil(`document.activeElement?.classList.contains('board-editor')`, 'the note editor has focus')
    await tjs(`(() => { const a = document.activeElement; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(a, 'Ship the whiteboard on Friday'); a.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await tjs(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
    await tuntil(`!document.querySelector('.board-editor') && document.querySelector('.board-note')?.textContent.includes('Ship the')`, 'the note keeps its text')
    // Text: a box sized to what was typed; an empty one disappears.
    await tkey('t')
    await ptr('pointerdown', 420, 330)
    await ptr('pointerup', 420, 330)
    await tuntil(`document.activeElement?.classList.contains('board-editor')`, 'the text editor has focus')
    await tjs(`(() => { const a = document.activeElement; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(a, 'Ideas'); a.dispatchEvent(new Event('input', { bubbles: true })); a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })()`)
    await tkey('t')
    await ptr('pointerdown', 700, 420)
    await ptr('pointerup', 700, 420)
    await tuntil(`document.activeElement?.classList.contains('board-editor')`)
    await tjs(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
    await tuntil(`!document.querySelector('.board-editor')`)
    assert.equal(await boardItems(), 6, 'pen, rectangle, arrow, ellipse, note and one text box')
    await tshot('whiteboard.png')
    // Marquee-select the stroke and the rectangle, delete them, then undo.
    await tkey('v')
    await stroke([[100, 120], [300, 180], [500, 240]])
    await tuntil(`document.querySelector('.board-count')?.textContent === '2 selected'`, 'two selected')
    assert.equal(await tjs(`document.querySelectorAll('.board-handle').length`), 8, 'resize handles around the selection')
    await tkey('Backspace')
    await tuntil(`document.querySelectorAll('.board-items > *').length === 4`, 'deleted')
    await tkey('z', { metaKey: true })
    await tuntil(`document.querySelectorAll('.board-items > *').length === 6`, '⌘Z brings them back')
    // Moving the rectangle by dragging it.
    await tkey('Escape')
    const rectX = await tjs(`Number(document.querySelector('.board-items > rect').getAttribute('x'))`)
    await stroke([[380, 200], [430, 230], [480, 260]])
    await tuntil(`Number(document.querySelector('.board-items > rect').getAttribute('x')) === ${rectX + 100}`, 'dragging moves the rectangle')
    for (let n = 0; n < 60 && !Object.values(boardsSaved).some((b) => b.name === 'Brainstorm' && b.items.length === 6 && b.items.some((it) => it.type === 'note' && it.text.startsWith('Ship'))); n++) await new Promise((r) => setTimeout(r, 50))
    const saved = Object.values(boardsSaved).find((b) => b.name === 'Brainstorm')
    assert.deepEqual(saved.items.map((it) => it.type).sort(), ['arrow', 'ellipse', 'note', 'pen', 'rect', 'text'], 'the board is saved with its items')
    // A PNG of the board into today's note.
    await tjs(`document.querySelector('.bt-btn[aria-label="More"]').click()`)
    await tjs(`[...document.querySelectorAll('.popover .menu-item')].find((b) => b.textContent.startsWith('Add to today')).click()`)
    for (let n = 0; n < 100 && !notes['Journal/2026-10-18.md']?.text.includes('![[Brainstorm.png]]'); n++) await new Promise((r) => setTimeout(r, 50))
    assert.match(noteImages.at(-1) ?? '', /^data:image\/png;base64,.{2000,}/, 'the export is a real PNG')
    assert.ok(notes['Journal/2026-10-18.md'].text.includes('![[Brainstorm.png]]'), 'the image is embedded in the daily note')
    // A second board starts empty and both are listed.
    await tjs(`document.querySelector('button[aria-label="New board"]').click()`)
    await tuntil(`document.querySelectorAll('.board-row').length === 2 && !!document.querySelector('.board-hint') && document.querySelector('.board-row.on .board-row-name').textContent === 'Board'`, 'a new empty board')
    await tjs(`[...document.querySelectorAll('.board-row')].find((r) => r.textContent.startsWith('Brainstorm')).click()`)
    await tuntil(`document.querySelectorAll('.board-items > *').length === 6`, 'switching back loads the first board')
    // The shortcuts list has a whiteboard section.
    await tkey('/', { metaKey: true })
    await tuntil(`!!document.querySelector('.modal') && document.querySelector('.modal').textContent.includes('On the whiteboard')`, 'shortcuts dialog lists the whiteboard keys')
    await tkey('Escape')
    twin.destroy()

    // Voice dictation against the scripted helper: live words in a text field, the HUD, Done, the hold key, Escape,
    // a held key that was an ⌥ combination, the Notes editor (live, one undo step) and a terminal (one paste at the end).
    const vwin = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { preload: join(__dirname, 'ui-preload.cjs'), contextIsolation: true, backgroundThrottling: false } })
    vwin.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message) })
    const vjs = (code) => vwin.webContents.executeJavaScript(code).catch((e) => { throw new Error(`${e.message}\n  in: ${code.slice(0, 300)}`) })
    const vuntil = async (code, what = code) => { for (let n = 0; n < 150; n++) { if (await vjs(code)) return; await new Promise((r) => setTimeout(r, 30)) } throw new Error(`Timed out (dictation): ${what}`) }
    const vshot = async (name) => { await vjs('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await new Promise((r) => setTimeout(r, 250)); writeFileSync(join(output, name), (await vwin.webContents.capturePage()).toPNG()) }
    const dictate = (action, target) => vjs(`window.dispatchEvent(new CustomEvent('ec2ra:dictate', { detail: { action: ${JSON.stringify(action)}${target ? `, target: document.querySelector(${JSON.stringify(target)})` : ''} } }))`)
    const hud = `document.querySelector('.voice-hud')`
    const voiceCalls = (ch) => calls.filter((c) => c.channel === ch)
    const altRight = (type) => vjs(`document.activeElement.dispatchEvent(new KeyboardEvent('${type}', { key: 'Alt', code: 'AltRight', altKey: ${type === 'keydown'}, bubbles: true, cancelable: true }))`)
    await vwin.loadFile(resolve('out/renderer/index.html'))
    await vuntil(`document.querySelectorAll('[data-host-key]').length > 0`)
    await vjs(`window.__dictation = []; window.addEventListener('ec2ra:dictation', (e) => window.__dictation.push(e.detail.active)); 0`)
    // A mic-button style start into the focused search field: the words appear in the field as they are heard.
    await vjs(`document.querySelector('[aria-label="Search hosts"]').focus()`)
    await dictate('start')
    await vuntil(`${hud}?.textContent.includes('connect to web prod') && document.querySelector('[aria-label="Search hosts"]').value === 'Connect to web prod'`, 'live words in the search field')
    await vuntil(`${hud}.querySelectorAll('.voice-wave > span').length === 20 && ${hud}.textContent.includes('On this Mac') && ${hud}.textContent.includes('into Search hosts')`, 'waveform, on-device note and target')
    await vshot('voice-hud-dark.png')
    await vjs(`document.documentElement.setAttribute('data-theme', 'light')`)
    await vshot('voice-hud-light.png')
    await vjs(`document.documentElement.setAttribute('data-theme', 'dark')`)
    await vjs(`document.querySelector('.voice-btn.done').click()`)
    await vuntil(`!${hud} && document.querySelector('[aria-label="Search hosts"]').value === 'Connect to web prod one'`, 'Done inserts the final words and closes the HUD')
    assert.deepEqual(await vjs(`window.__dictation`), [true, false], 'ec2ra:dictation reports start and end')
    await vuntil(`document.querySelectorAll('[data-host-key]').length === 0`, 'the field’s own handlers saw the words (the host list filtered)')
    assert.match(voiceCalls('voice:start').at(-1).args[0].id, /^v[a-z0-9]+$/, 'the renderer names the dictation')
    await vjs(`(() => { const i = document.querySelector('[aria-label="Search hosts"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await vuntil(`document.querySelectorAll('[data-host-key]').length > 0`)
    // Holding Right Option: talk while held, let go to insert (here into the quick switcher).
    await vjs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true }))`)
    await vuntil(`document.activeElement?.getAttribute('role') === 'combobox'`, 'quick switcher')
    const startsBeforeHold = voiceCalls('voice:start').length
    await altRight('keydown')
    await vuntil(`${hud}?.textContent.includes('Release Right ⌥ to insert') && document.activeElement.value === 'Connect to web prod'`, 'holding the key dictates')
    assert.equal(await vjs(`!!${hud}.querySelector('.voice-btn.done')`), false, 'no Done button while holding the key')
    assert.equal(await vjs(`(() => { const m = ${hud}.querySelector('.voice-meta'); return m.scrollWidth <= m.clientWidth + 1 })()`), true, 'the HUD’s hints fit on one line')
    await vshot('voice-hud-hold.png')
    await altRight('keyup')
    await vuntil(`!${hud} && document.activeElement.value === 'Connect to web prod one'`, 'releasing the key inserts')
    assert.equal(voiceCalls('voice:start').length, startsBeforeHold + 1)
    assert.equal(voiceCalls('voice:stop').at(-1).args[0], voiceCalls('voice:start').at(-1).args[0].id)
    // Escape cancels: the field is left as it was and the dialog under the HUD stays open.
    await vjs(`(() => { const i = document.activeElement; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'web'); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await dictate('toggle')
    await vuntil(`document.activeElement.value === 'web connect to web prod'`, 'mid-sentence words are spaced and lower-cased')
    await vjs(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
    await vuntil(`!${hud} && document.activeElement.value === 'web' && !!document.querySelector('[role="combobox"]')`, 'Escape restores the field and keeps the dialog')
    assert.equal(voiceCalls('voice:cancel').at(-1).args[0], voiceCalls('voice:start').at(-1).args[0].id)
    // An ⌥ combination is not a hold: no dictation starts.
    const startsBeforeCombo = voiceCalls('voice:start').length
    await altRight('keydown')
    await vjs(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ƒ', code: 'KeyF', altKey: true, bubbles: true, cancelable: true }))`)
    await new Promise((r) => setTimeout(r, 350))
    await altRight('keyup')
    assert.equal(voiceCalls('voice:start').length, startsBeforeCombo, '⌥F never starts dictation')
    assert.equal(await vjs(`!!${hud}`), false)
    await vjs(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
    await vuntil(`!document.querySelector('[role="dialog"]')`)
    // A refusal (microphone access off) shows in the HUD with what to do; Escape dismisses it.
    voiceRefusal = 'Microphone access is off for EC2 Remote Access. Turn it on in System Settings → Privacy & Security → Microphone.'
    await vjs(`document.querySelector('[aria-label="Search hosts"]').focus()`)
    await dictate('toggle')
    await vuntil(`${hud}?.classList.contains('error') && ${hud}.textContent.includes('Privacy & Security') && ${hud}.textContent.includes('Open Privacy Settings')`, 'the HUD explains a refusal and offers the setting')
    assert.equal(await vjs(`${hud}.textContent.includes('Error invoking remote method')`), false, 'only the message itself')
    await vshot('voice-hud-error.png')
    voiceRefusal = null
    await vjs(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
    await vuntil(`!${hud} && document.querySelector('[aria-label="Search hosts"]').value === ''`)
    // The Notes editor: its mic button, words written live, the final text kept and saved.
    notes['Dictation.md'] = { text: '# Dictation\n\n', mtime: Date.now() }
    await vjs(`document.querySelector('button[aria-label="Notes"]').click()`)
    await vuntil(`[...document.querySelectorAll('.notes-file')].some((b) => b.textContent.includes('Dictation'))`)
    await vjs(`[...document.querySelectorAll('.notes-file')].find((b) => b.textContent.includes('Dictation')).click()`)
    await vuntil(`document.querySelector('.notes-title')?.textContent === 'Dictation' && !!document.querySelector('.notes-tools .mic-btn')`)
    const lastNoteLine = await vjs(`(() => { const r = [...document.querySelectorAll('.notes-tab .cm-line')].at(-1).getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2) } })()`)
    vwin.webContents.focus()
    vwin.webContents.sendInputEvent({ type: 'mouseDown', x: lastNoteLine.x, y: lastNoteLine.y, button: 'left', clickCount: 1 })
    vwin.webContents.sendInputEvent({ type: 'mouseUp', x: lastNoteLine.x, y: lastNoteLine.y, button: 'left', clickCount: 1 })
    await vuntil(`document.activeElement?.classList.contains('cm-content')`)
    await vjs(`document.querySelector('.notes-tools .mic-btn').click()`)
    await vuntil(`document.querySelector('.notes-tools .mic-btn').getAttribute('aria-pressed') === 'true' && document.querySelector('.notes-tab .cm-content').textContent.includes('Connect to web prod') && ${hud}?.textContent.includes('into Note')`, 'words appear in the note as they are heard')
    await vshot('voice-notes.png')
    await vjs(`document.querySelector('.notes-tools .mic-btn').click()`)
    await vuntil(`!${hud} && document.querySelector('.notes-tools .mic-btn').getAttribute('aria-pressed') === 'false' && document.querySelector('.notes-tab .cm-content').textContent.includes('Connect to web prod one')`, 'the mic button again inserts')
    for (let n = 0; n < 100 && !notes['Dictation.md'].text.includes('Connect to web prod one'); n++) await new Promise((r) => setTimeout(r, 30))
    assert.equal(notes['Dictation.md'].text, '# Dictation\n\nConnect to web prod one', 'the note is saved with the words, once')
    // A terminal takes the finished words as one paste, with no Enter.
    await vjs(`document.querySelector('button[aria-label="Hosts"]').click()`)
    await vuntil(`!!document.querySelector('[data-host-key="${running.key}"] .btn-ssh')`)
    await vjs(`document.querySelector('[data-host-key="${running.key}"] .btn-ssh').click()`)
    await vuntil(`!!document.querySelector('.term-toolbar .mic-btn') && document.body.textContent.includes('ubuntu@web-prod-01 via ssm')`)
    const sshSession = calls.filter((c) => c.channel === 'ssh:open').at(-1).args[0].sessionId
    await vjs(`document.querySelector('.term-toolbar .mic-btn').click()`)
    await vuntil(`${hud}?.textContent.includes('into Terminal') && ${hud}.textContent.includes('connect to web prod')`, 'the HUD shows the words for a terminal')
    assert.equal(calls.some((c) => c.channel === 'ssh:write' && c.args[0] === sshSession && /connect/i.test(c.args[1])), false, 'nothing reaches the shell before the end')
    await vjs(`document.querySelector('.voice-btn.done').click()`)
    await vuntil(`!${hud}`)
    for (let n = 0; n < 50 && !calls.some((c) => c.channel === 'ssh:write' && c.args[0] === sshSession && /connect/i.test(c.args[1])); n++) await new Promise((r) => setTimeout(r, 30))
    assert.deepEqual(calls.filter((c) => c.channel === 'ssh:write' && c.args[0] === sshSession && /connect/i.test(c.args[1])).map((c) => c.args[1]), ['Connect to web prod one'], 'one paste, no Enter')
    // Settings → Voice: the hold key, the language and what macOS allows.
    await vjs(`document.querySelector('button[aria-label="Settings"]').click()`)
    await vuntil(`!!document.querySelector('.settings-nav [data-section="voice"]')`)
    await vjs(`document.querySelector('.settings-nav [data-section="voice"]').click()`)
    await vuntil(`document.querySelector('.settings-body')?.textContent.includes('Allowed') && !!document.querySelector('select[aria-label="Dictation language"] option[value="fr-FR"]')`, 'voice settings show the permissions and languages')
    await vshot('settings-voice.png')
    await vjs(`document.querySelector('.settings-nav [data-section="about"]').click()`)
    await vuntil(`document.querySelector('.settings-body').textContent.includes('Dictation listens only while')`)
    vwin.destroy()

    // First run: the welcome screen, in both appearances, and its main action opens Add account.
    emptyScenario = true
    const savedTheme = settings.theme
    const ewin = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { preload: join(__dirname, 'ui-preload.cjs'), contextIsolation: true, backgroundThrottling: false } })
    ewin.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message) })
    const ejs = (code) => ewin.webContents.executeJavaScript(code).catch((e) => { throw new Error(`${e.message}\n  in: ${code.slice(0, 300)}`) })
    const euntil = async (code) => { for (let n = 0; n < 150; n++) { if (await ejs(code)) return; await new Promise((r) => setTimeout(r, 30)) } throw new Error(`Timed out (welcome): ${code}`) }
    const eshot = async (name) => { await ejs('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await new Promise((r) => setTimeout(r, 150)); writeFileSync(join(output, name), (await ewin.webContents.capturePage()).toPNG()) }
    for (const theme of ['dark', 'light']) {
      settings.theme = theme
      await ewin.loadFile(resolve('out/renderer/index.html'))
      await euntil(`!!document.querySelector('.welcome .welcome-action.primary') && document.querySelectorAll('.welcome-req').length === 3`)
      await eshot(`welcome-${theme}.png`)
    }
    await ejs(`document.querySelector('.welcome-action.primary').click()`)
    await euntil(`!!document.querySelector('[role="dialog"]')`)
    ewin.destroy()
    settings.theme = savedTheme
    emptyScenario = false
    assert.deepEqual(errors, [])
    console.log(`UI smoke checks passed. Screenshots: ${output}`)
    app.exit(0)
  } catch (error) {
    await screenshot('failure.png')
    console.error(error)
    console.error(`Screenshots: ${output}`)
    console.error(errors)
    app.exit(1)
  }
})

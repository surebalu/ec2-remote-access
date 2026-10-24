// Runs the built renderer with synthetic data and no production main process or AWS access.
const { app, BrowserWindow, ipcMain, session, webContents } = require('electron')
const http = require('node:http')
const { createHash } = require('node:crypto')
const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
// An error that escapes is printed and fails the run; Electron's own handler would leave a dialog on the desktop.
process.on('uncaughtException', (e) => { console.error(e); app.exit(1) })
const assert = require('node:assert/strict')
const workspacePreview = process.argv.includes('--workspace-preview')
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
// Screen sharing (ui-screens.cjs): the tailnet the fixture reports, the fake VNC server's socket, the one ws:// origin
// the page may open (everything else stays blocked), and screen-sharing sign-ins kept apart from RDP's.
let tailnetFixture = null
let vncUrl = null
let wsAllowed = null
// Every window shares the default session, whose one request filter blocks the network, bar that one origin.
const blockNetwork = (details, callback) => callback({ cancel: !(wsAllowed && details.url.startsWith(wsAllowed)) })
const vncCreds = {}
const computerThumbs = {}
const displayLayouts = {}
let failWorkspaceHealth = false
let workspaceHealthAge = 0
// First run: no AWS profiles, no servers, nothing scanned.
let emptyScenario = false
// The organization's sign-in a build may carry (app:company), and what the first-run and setup actions asked main for.
let companyFixture = null
const companyDefaults = {
  name: 'Corp',
  aws: {
    sessions: [{ name: 'corp', startUrl: 'https://corp.awsapps.com/start', region: 'us-west-2' }],
    profiles: [{ name: 'prod-plm', session: 'corp', accountId: '111111111111', roleName: 'Admin', region: 'us-west-2' }, { name: 'qa-plm', session: 'corp', accountId: '222222222222', roleName: 'Admin', region: 'us-west-1' }]
  },
  accountMeta: { 'prod-plm': { label: 'Prod', color: 'rose' } }
}
const setupDone = []
const importPreview = () => ({
  id: 'imp-1', fileName: 'EC2 Remote Access setup 2026-10-24.json', from: { computer: 'Old Mac', home: '/Users/old' }, exportedAt: now - 3600000,
  sessions: [{ name: 'corp', status: 'add' }], profiles: [{ name: 'prod-plm', accountId: '111111111111', status: 'add' }, { name: 'qa-plm', accountId: '222222222222', status: 'kept' }],
  settings: ['3 favorites', '2 host settings', 'appearance, terminal, Notes and other preferences'],
  left: { profiles: [{ name: 'old-keys', why: 'uses access keys, which are never exported' }], dataDir: '/Volumes/home/EC2 Remote Access' }
})
// Box sync (main/boxSync.ts) as the page sees it: signed out until box:signIn, then signed in and synced.
const boxSignedOut = { available: true, signedIn: false, syncing: false }
let boxFixture = boxSignedOut
let failNoteWrites = false
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
// What macOS allows the app in the fixture: Accessibility for window layouts, and the Calendars permission.
let wmAccess = false
let macCalStatus = 'notDetermined'
const macEventReads = []
const launcherDone = []
// While the launcher's window is up, notes:search finds notes by name.
let launcherNotes = false
// The Links panels: the page the save key found in front, and what the panels asked of main.
let panelPage = { url: '', title: '' }
const panelDone = []
// A fake zsh for the Terminal tab: shell-integration markers, echo, a few commands, ⌃C.
let termSaved = null
// The Finder tab's pretend disk under /Users/fixture, its Finder favorites and locations, and what it was asked to do.
const fsEntry = (dir, name, type = 'file', size = 0, ageDays = 1) => ({ name, path: `${dir === '/' ? '' : dir}/${name}`, type, size, mtime: now - ageDays * 86400000, mode: 0 })
const finderFs = {
  '/Users/fixture': [fsEntry('/Users/fixture', 'Documents', 'dir'), fsEntry('/Users/fixture', 'Downloads', 'dir'), fsEntry('/Users/fixture', 'Projects', 'dir'), fsEntry('/Users/fixture', '.zshrc', 'file', 120), fsEntry('/Users/fixture', '.aws', 'dir'), fsEntry('/Users/fixture', '.ssh', 'dir')],
  '/Users/fixture/.aws': [fsEntry('/Users/fixture/.aws', 'config', 'file', 300), fsEntry('/Users/fixture/.aws', 'sso', 'dir')], '/Users/fixture/.aws/sso': [], '/Users/fixture/.ssh': [],
  '/Users/fixture/Documents': [fsEntry('/Users/fixture/Documents', 'Surendra-Personal', 'dir'), fsEntry('/Users/fixture/Documents', 'Runbook.pdf', 'file', 1234567, 3), fsEntry('/Users/fixture/Documents', 'notes.md', 'file', 4200), fsEntry('/Users/fixture/Documents', 'photo.png', 'file', 250000, 40)],
  '/Users/fixture/Documents/Surendra-Personal': [fsEntry('/Users/fixture/Documents/Surendra-Personal', 'codebase', 'dir'), fsEntry('/Users/fixture/Documents/Surendra-Personal', 'Passport.pdf', 'file', 900000)],
  '/Users/fixture/Downloads': [], '/Users/fixture/Projects': [fsEntry('/Users/fixture/Projects', 'main.go', 'file', 1200)]
}
const finderDone = []
// The CAD viewer reads two real STEP files from occt-import-js's own tests (an assembly and a cube), as main would.
const cadFiles = {
  as1: resolve('node_modules/occt-import-js/test/testfiles/cax-if/as1_pe_203.stp'),
  cube: resolve('node_modules/occt-import-js/test/testfiles/simple-basic-cube/cube.stp')
}
const cadPicks = []
const cadCache = {}
const cadSaved = []
// The Storage tool's pretend scan of a Mac: folders and big files by path, the disk, and what went to the Trash.
const stIds = new Map()
const stId = (path) => { if (!stIds.has(path)) stIds.set(path, stIds.size); return stIds.get(path) }
const stEntry = (path, size, extra = {}) => ({ id: stId(path), name: path === '/' ? '/' : path.split('/').pop(), path, size, files: Math.max(1, Math.round(size / 2e6)), dir: true, ...extra })
const stFile = (path, size, kind, ageDays = 30) => stEntry(path, size, { dir: false, files: 1, kind, mtime: now - ageDays * 86400000 })
const stKids = {
  '/': [stEntry('/Users', 210e9, { more: true }), stEntry('/Applications', 38e9, { more: true }), stEntry('/System', 15e9, { more: true }), stEntry('/Library', 9e9, { more: true }), stEntry('/private', 6e9, { more: true }), stEntry('/opt', 2e9, { more: true })],
  '/Users': [stEntry('/Users/fixture', 205e9, { more: true }), stEntry('/Users/Shared', 5e9, { more: true })],
  '/Users/fixture': [stEntry('/Users/fixture/Library', 90e9, { more: true }), stEntry('/Users/fixture/Documents', 60e9, { more: true }), stEntry('/Users/fixture/Movies', 30e9, { more: true }), stEntry('/Users/fixture/Downloads', 12e9, { more: true }), stEntry('/Users/fixture/Pictures', 8e9, { more: true }), stEntry('/Users/fixture/.npm', 2.5e9, { more: true }), stEntry('/Users/fixture/.cache', 1.4e9, { more: true }), stEntry('/Users/fixture/.Trash', 0.8e9, { more: true })],
  '/Users/fixture/Movies': [stFile('/Users/fixture/Movies/Trip 2024.mov', 9e9, 'video', 200), stEntry('/Users/fixture/Movies/Edits', 21e9, { more: true })],
  '/Users/fixture/Downloads': [stFile('/Users/fixture/Downloads/ubuntu-24.04.iso', 5e9, 'diskimage', 120), stFile('/Users/fixture/Downloads/Xcode_16.xip', 4e9, 'archive', 90), stFile('/Users/fixture/Downloads/Installer.dmg', 0.6e9, 'diskimage', 10)]
}
const stAll = () => Object.values(stKids).flat()
const stNest = (path, per) => {
  const n = [stEntry('/', 280e9, { more: true }), ...stAll()].find((x) => x.path === path)
  const kids = (stKids[path] ?? []).slice().sort((a, b) => b.size - a.size)
  const node = { id: n.id, name: n.name, path: n.path, size: n.size, items: kids.length + 3, dir: n.dir, ...(n.kind ? { kind: n.kind } : {}), ...(n.more ? { more: true } : {}) }
  if (per.length && n.dir) {
    node.children = kids.slice(0, per[0]).map((k) => stNest(k.path, per.slice(1)))
    const rest = kids.slice(per[0])
    const small = Math.max(0, n.size - kids.reduce((t, c) => t + c.size, 0))
    if (rest.length || small) node.rest = { count: rest.length + 3, size: rest.reduce((t, c) => t + c.size, 0) + small }
  }
  return node
}
const stView = (path) => {
  const all = [{ ...stEntry('/', 280e9, { more: true }) }, ...stAll()]
  const node = all.find((n) => n.path === path)
  if (!node) throw new Error('That folder is not in the last scan. Scan again.')
  const chain = []
  for (let p = path; p !== '/';) { p = p.replace(/\/[^/]+$/, '') || '/'; chain.unshift({ id: stId(p), name: p === '/' ? '/' : p.split('/').pop() }) }
  const children = (stKids[path] ?? []).slice().sort((a, b) => b.size - a.size)
  return { node, chain, children, small: { bytes: Math.max(0, node.size - children.reduce((t, c) => t + c.size, 0)), files: 3000 }, inner: Object.fromEntries(children.filter((c) => stKids[c.path]).map((c) => [c.id, stKids[c.path].map((g) => ({ size: g.size, dir: g.dir, kind: g.kind }))])) }
}
const stApps = [
  { path: '/Applications/Old Editor.app', name: 'Old Editor', id: 'com.old.editor', version: '2.1', size: 1.4e9, lastUsed: now - 200 * 86400000, added: now - 900 * 86400000, intelOnly: true, running: false, systemExtension: false, admin: false, apple: false },
  { path: '/Applications/Daily.app', name: 'Daily', id: 'com.daily.app', version: '5.0', size: 3e8, lastUsed: now - 86400000, intelOnly: false, running: true, systemExtension: false, admin: false, apple: false },
  { path: '/Applications/Guard VPN.app', name: 'Guard VPN', id: 'com.guard.vpn', version: '1.0', size: 2e8, lastUsed: now - 400 * 86400000, intelOnly: false, running: false, systemExtension: true, admin: false, apple: false }
]
const stQuits = []
let stState = { status: 'idle' }
let stRemoved = []
const stPutBacks = []
const stSummary = () => ({ root: '/', kind: 'mac', at: Date.now(), took: 41000, bytes: 280e9, files: 2100000, dirs: 400000, unreadable: 3, fullDiskAccess: false, byKind: { video: 30e9, diskimage: 5.6e9, archive: 4e9, document: 2e9, image: 6e9, developer: 9e9, other: 3e9, app: 38e9 }, smallBytes: 60e9, smallFiles: 2000000,
  parts: [{ id: 'apps', bytes: 38e9 }, { id: 'documents', bytes: 90e9 }, { id: 'downloads', bytes: 12e9 }, { id: 'pictures', bytes: 8e9 }, { id: 'library', bytes: 99e9 }, { id: 'other', bytes: 9e9 }, { id: 'trash', bytes: 0.8e9 }, { id: 'system', bytes: 285e9 }] })
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
        [host('3DPassport', '01', '10.9.0.31', { level: 'crit', reporting: false, cpu: null, mem: null, disk: null, problems: ['Not reporting'] }), host('3DPassport', '02', '10.9.0.32', { level: 'off', state: 'stopped', reporting: false }), host('3DSpace', '01', '10.9.0.11', { instanceKey: running.key }), host('3DSpace', '02', '10.9.0.12', { level: 'warn', mem: 83, problems: ['Memory at 83%'] }), host('File Collaboration Server', '01', '10.9.0.51', { sharedStores: [{ mount: '/filestore', pct: 86.3, level: 'crit' }] })],
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
// Browser extensions: one installed; what the panel asked main to do.
let extList = [{ id: 'eimadpbcbfnmbkopoojfekhnkhdbieeh', runtimeId: 'eimadpbcbfnmbkopoojfekhnkhdbieeh', name: 'Dark Reader', version: '4.9.133', description: 'Dark mode for every website', icon: '', popup: null, options: null, worker: true, enabled: true, source: 'store', path: '/fixture/extensions/dark', manifestVersion: 3, access: { all: true, hosts: [] }, missing: ['right-click menu items'], installedAt: 0 }]
// Sessions ended in the Database locks dialog.
const dbKilled = []
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
// Tasks, Calendar and Links documents (main/records.ts), Anybox's library on "this Mac", a page preview and an iCal link.
const recordDocs = {}
// The Services dialog's rows at any width: every button inside its card, the buttons' right edges, the units and
// the states each in one line down the list, and a group's Restart all ending where the rows' buttons end.
const SVC_ALIGNED = `(() => {
  const rows = [...document.querySelectorAll('.svc-row[data-unit]')]
  const at = (r, s) => r.querySelector(s).getBoundingClientRect()
  const same = (xs) => Math.max(...xs) - Math.min(...xs) <= 1
  const rights = rows.map((r) => at(r, '.svc-acts').right)
  const head = document.querySelector('.svc-group-head .btn')
  return {
    inside: rows.every((r, i) => rights[i] <= r.getBoundingClientRect().right - 8 && at(r, '[aria-label^="More for"]').right <= r.getBoundingClientRect().right - 8),
    buttons: same(rights), units: same(rows.map((r) => at(r, '.svc-unit').left)), states: same(rows.map((r) => at(r, '.svc-pill').left)) || same(rows.map((r) => at(r, '.svc-pill').right)),
    groupButton: !head || Math.abs(head.getBoundingClientRect().right - rights[0]) <= 1.5,
    sideways: (() => { const b = document.querySelector('.svc-body'); return b.scrollWidth <= b.clientWidth + 1 })()
  }
})()`
const ALL_ALIGNED = { inside: true, buttons: true, units: true, states: true, groupButton: true, sideways: true }
// Health's server rows: the buttons (Services, SSH, info) stay right of Up for and inside the row.
const SRV_CLEAR = `[...document.querySelectorAll('.hl-srv:not(.off)')].every((r) => {
  const up = r.querySelector('[data-label="Up for"] .hl-srv-num'), acts = [...r.querySelector('.hl-srv-actions').children].map((c) => c.getBoundingClientRect())
  return !up || !acts.length || (Math.min(...acts.map((a) => a.left)) >= up.getBoundingClientRect().right + 4 && Math.max(...acts.map((a) => a.right)) <= r.getBoundingClientRect().right)
})`
// Tools in windows of their own (main/toolWindows.ts): which are out.
let toolsOut = []
// Settings → Data: the data folder's state as main/dataFolder.ts reports it.
let dataState = { dir: '', reachable: false, syncing: false, places: [{ id: 'app', label: 'This Mac’s copy', path: '/fixture/userData' }, { id: 'records', label: 'Tasks, Calendar and Links', path: '/fixture/userData/records' }] }
// The first Anybox import meets macOS's privacy wall, as on a Mac that has not let this app in.
let anyboxBlocked = true
const anyboxFixture = [
  { kind: 'link', url: 'https://grafana.example.com/d/prod', title: 'Grafana — production', description: 'Dashboards', folder: ['Work', 'Monitoring'], tags: ['ops', 'prod'], starred: true, addedAt: 1760000000000, note: 'the main board' },
  { kind: 'link', url: 'https://docs.aws.amazon.com/', title: 'AWS documentation', folder: ['Work'], tags: ['aws/docs'], addedAt: 1760000100000, keyword: 'awsdocs' },
  { kind: 'link', url: 'https://news.ycombinator.com/', title: 'Hacker News', tags: ['reading'], addedAt: 1760000200000 },
  { kind: 'note', title: 'Wifi at the office', text: 'guest / network', folder: ['Work'], addedAt: 1760000300000 },
  { kind: 'file', title: 'Architecture review.pdf', path: '/fixture/Links Files/Work/Architecture review.pdf', size: 1258291, folder: ['Work'], addedAt: 1760000400000 }
]
const pad2 = (n) => String(n).padStart(2, '0')
const icsDay = (d) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`
const FIXTURE_ICS = ['BEGIN:VCALENDAR', 'X-WR-CALNAME:Team', 'BEGIN:VEVENT', 'UID:team-1', `DTSTART;VALUE=DATE:${icsDay(new Date())}`, `DTEND;VALUE=DATE:${icsDay(new Date(Date.now() + 86400000))}`, 'SUMMARY:Team offsite', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
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
    case 'app:paths': return { sessionManagerPlugin: '/fixture/plugin', sessionManagerPluginBundled: emptyScenario, awsCli: null, windowsApp: false }
    case 'app:company': return companyFixture
    case 'box:status': return boxFixture
    case 'box:signIn':
      setupDone.push(['box:signIn', args[0] ?? null])
      boxFixture = { available: true, signedIn: true, syncing: false, user: { name: 'Fixture Person', login: 'person@example.com' }, folder: { id: '123', name: 'Remote Access Tool' }, lastSync: Date.now(), files: { done: 3, total: 3, tooLarge: 1 } }
      setTimeout(() => { if (!_e.sender.isDestroyed()) _e.sender.send('box:status', boxFixture) }, 150)
      return { url: 'https://account.box.com/api/oauth2/authorize?fixture', opened: true }
    case 'box:sync': setupDone.push(['box:sync']); boxFixture = { ...boxFixture, lastSync: Date.now() }; return boxFixture
    case 'box:signOut': setupDone.push(['box:signOut']); boxFixture = boxSignedOut; return boxFixture
    case 'links:openFile': return
    case 'sso:start': setupDone.push(['sso:start', args[0]]); return { flowId: 'flow-2', userCode: 'WXYZ-1234', verificationUri: 'https://device.sso.example/', verificationUriComplete: 'https://device.sso.example/?user_code=WXYZ-1234', expiresIn: 600 }
    case 'sso:wait': return [{ accountId: '111111111111', accountName: 'Corp Production', roles: ['ReadOnly', 'Admin'] }, { accountId: '222222222222', accountName: 'Corp QA', roles: ['Admin'] }, { accountId: '333333333333', accountName: 'Sandbox', roles: ['Admin'] }]
    case 'sso:save': setupDone.push(['sso:save', args[0]]); return args[0].selections.map((x) => x.profileName)
    case 'setup:export': setupDone.push(['export']); return '/Users/fixture/Desktop/EC2 Remote Access setup.json'
    case 'setup:boxList': return [{ id: '901', computer: 'Old Mac', exportedAt: now - 7200000, mine: false }, { id: '902', computer: 'This Mac', exportedAt: now, mine: true }]
    case 'setup:fromBox': setupDone.push(['fromBox', args[0]]); return { ...importPreview(), fileName: 'Box: Old Mac.json' }
    case 'setup:pickImport': return importPreview()
    case 'setup:apply': setupDone.push(['apply', args[0]]); return { settings: { ...settings, favorites: [...settings.favorites, 'imported/us-east-1/i-imported'] }, profiles: ['prod-plm'], dataDir: '/Volumes/home/EC2 Remote Access' }
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
    case 'notes:write': if (failNoteWrites) throw new Error('Fixture: disk is read only'); notes[args[0]] = { text: args[1], mtime: Date.now() }; return { mtime: notes[args[0]].mtime }
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
    case 'ext:list': return extList
    case 'ext:install': {
      const x = { ...extList[0], id: 'bcjindcccaagfpapjjmafapmmgkkhgoa', name: 'JSON Formatter', version: '0.7.1', access: { all: false, hosts: ['*'] }, missing: [] }
      extList = [...extList, x]
      return x
    }
    case 'ext:setEnabled': extList = extList.map((x) => (x.id === args[0] ? { ...x, enabled: args[1] } : x)); return extList
    case 'ext:remove': extList = extList.filter((x) => x.id !== args[0]); return extList
    case 'ext:action': return null // no popup set: the extension took the click itself
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
    // The host page: one server read live (a TomEE, a child mql, an exporter; a peer that is in the inventory) and charts.
    case 'host:snapshot': return {
      at: Date.now(), uptimeSec: 3801174, cpus: 8, load: [0.42, 0.38, 0.3], cpuPct: 23.5, memTotal: 64 * 1024 ** 3, memAvailable: 30 * 1024 ** 3, swapTotal: 0, swapFree: 0,
      os: 'Red Hat Enterprise Linux 9.7 (Plow)', kernel: '5.14.0',
      disks: [
        { mount: '/', fs: 'xfs', device: '/dev/nvme0n1p4', size: 50e9, used: 20e9, avail: 30e9, readBps: 0, writeBps: 2048, readIops: 0, writeIops: 1 },
        { mount: '/apps/DassaultSystemes', fs: 'xfs', device: '/dev/nvme1n1', size: 200e9, used: 172e9, avail: 28e9, readBps: 10240, writeBps: 40960, readIops: 2, writeIops: 5 }
      ],
      nets: [{ iface: 'eth0', rxBps: 52000, txBps: 132000, rxPps: 40, txPps: 60, rxErrs: 0, txErrs: 0, rxDrop: 0, txDrop: 0 }],
      processes: [
        { pid: 4242, ppid: 1, user: 'tomcat', uptimeSec: 172800, cpuPct: 12.5, rssBytes: 6.1 * 1024 ** 3, threads: 312, comm: 'java', args: '/usr/lib/jvm/bin/java -Dcatalina.base=/usr/DassaultSystemes/tomee org.apache.catalina.startup.Bootstrap start', unit: '3dspace.service', tech: 'Apache TomEE' },
        { pid: 5150, ppid: 4242, user: 'tomcat', uptimeSec: 3600, cpuPct: 0.4, rssBytes: 900 * 1024 ** 2, threads: 4, comm: 'mql', args: '/usr/DassaultSystemes/R2025x/3DSpace/linux_a64/code/bin/mql', unit: null, tech: '3DEXPERIENCE' },
        { pid: 880, ppid: 1, user: 'root', uptimeSec: 3800000, cpuPct: 0.1, rssBytes: 16 * 1024 ** 2, threads: 7, comm: 'node_exporter', args: '/opt/node_exporter/node_exporter', unit: 'node_exporter.service', tech: 'Prometheus node exporter' }
      ],
      listening: [{ addr: '0.0.0.0', port: 8090, pid: 4242, process: 'java' }, { addr: '0.0.0.0', port: 22, pid: 900, process: 'sshd' }, { addr: '::', port: 9100, pid: 880, process: 'node_exporter' }],
      connections: [
        { direction: 'in', localPort: 8090, remote: '10.0.1.15', remotePort: null, pid: 4242, process: 'java', count: 12 },
        { direction: 'out', localPort: null, remote: '10.0.2.20', remotePort: 1521, pid: 4242, process: 'java', count: 21 }
      ]
    }
    case 'host:process': return {
      at: Date.now(), gone: false, pid: args[1], ppid: 1, user: 'tomcat', uptimeSec: 172800, started: 'Mon Oct 19 20:01:02 2026', rssBytes: 6.1 * 1024 ** 3, hwmBytes: 6.5 * 1024 ** 3,
      vszBytes: 20 * 1024 ** 3, swapBytes: 0, threads: 312, state: 'S (sleeping)', comm: 'java', args: '/usr/lib/jvm/bin/java -Dcatalina.base=/usr/DassaultSystemes/tomee org.apache.catalina.startup.Bootstrap start',
      exe: '/usr/lib/jvm/bin/java', cwd: '/', unit: '3dspace.service', fds: 812, fdLimit: 65536, cpuPct: 12.5, tech: 'Apache TomEE',
      listening: [{ addr: '0.0.0.0', port: 8090, pid: args[1], process: 'java' }], connections: [{ direction: 'out', localPort: null, remote: '10.0.2.20', remotePort: 1521, pid: args[1], process: 'java', count: 21 }]
    }
    case 'host:history': {
      const n = 61
      const wave = (base, amp, k) => Array.from({ length: n }, (_, i) => base + amp * Math.sin(i / k))
      return { source: 'prometheus', hours: args[1], start: Date.now() - args[1] * 3600000, step: (args[1] * 3600) / (n - 1), cpu: wave(22, 9, 6), memPct: wave(54, 3, 9), memUsed: wave(34e9, 2e9, 9),
        netIn: wave(200000, 60000, 4), netOut: wave(500000, 120000, 5), diskRead: wave(30000, 20000, 3), diskWrite: wave(90000, 40000, 7) }
    }
    // Database locks: one blocker idle with a transaction open, two waiting behind it (one through the other).
    case 'db:list': return [
      { id: 'prod-ms-db', env: 'prod', engine: 'oracle-se2 19', profile: 'production', region: 'us-east-1', endpoint: 'prod-ms-db.example', port: 1521, dbName: 'ORCL', via: { key: running.key, name: running.name }, secret: { name: 'env-refresh/prod-master-pwd', profile: 'production' } },
      { id: 'qa-ms-db', env: 'qa', engine: 'oracle-se2 19', profile: 'development', region: 'us-east-1', endpoint: 'qa-ms-db.example', port: 1521, dbName: 'ORCL', via: null, secret: null, problem: 'No running server with an online SSM agent in qa-ms-db\'s network.' }
    ]
    case 'db:locks': {
      const sess = (sid, extra) => ({ inst: 1, sid, serial: sid * 7, user: 'X3DSPACE', osUser: 'tomcat', machine: 'ip-10-0-1-15', program: 'JDBC Thin Client', module: null, status: 'ACTIVE', type: 'USER', event: null, waitClass: null, waitSec: null, lastCallSec: 40, logonAt: null, sqlId: null, prevSqlId: null, sqlText: null, prevSqlText: null, blockingInst: null, blockingSid: null, waitObject: null, locked: [], txSince: null, ...extra })
      const killed = dbKilled.includes(101)
      const root = sess(101, { status: 'INACTIVE', lastCallSec: 754, prevSqlText: 'UPDATE lxbo_x SET lxstate = :1 WHERE lxoid = :2', locked: [{ object: 'X3DSPACE.LXBO_X', type: 'TABLE', mode: 'Row exclusive' }], txSince: Date.now() - 760000 })
      const w1 = sess(202, { blockingInst: 1, blockingSid: 101, waitSec: 312, event: 'enq: TX - row lock contention', waitObject: 'X3DSPACE.LXBO_X', sqlText: 'UPDATE lxbo_x SET lxstate = :1 WHERE lxoid = :2' })
      const w2 = sess(303, { blockingInst: 1, blockingSid: 202, waitSec: 45, event: 'enq: TX - row lock contention', waitObject: 'X3DSPACE.LXBO_X' })
      return { at: Date.now(), db: args[0], env: 'prod', via: running.name, sessions: { active: 12, inactive: 300, total: 312 }, chains: killed ? [] : [{ root, waiters: [{ s: w1, depth: 1 }, { s: w2, depth: 2 }], longestWaitSec: 312 }] }
    }
    case 'db:kill':
      if (args[0].confirm !== 'PROD') throw new Error('Type PROD to end a session on the production database.')
      dbKilled.push(args[0].sid)
      return { message: `Ended session ${args[0].sid},${args[0].serial} (X3DSPACE on ip-10-0-1-15). Its open transaction is rolled back.` }
    case 'db:history': return dbKilled.map((sid) => ({ at: Date.now(), by: 'fixture.user', db: 'prod-ms-db', sid, serial: sid * 7, user: 'X3DSPACE', machine: 'ip-10-0-1-15', program: 'JDBC Thin Client', result: 'done', message: `Ended session ${sid},${sid * 7}` }))
    case 'run:start': {
      const r = { id: `run-${runsSent.length + 1}`, command: args[0].command, timeoutSec: args[0].timeoutSec ?? 600, startedAt: Date.now(), targets: args[0].keys.map((k) => { const i = [running, stopped, stale].find((x) => x.key === k); return { key: k, name: i.name, profile: i.profile, region: i.region, instanceId: i.instanceId, platform: 'linux', status: 'pending' } }) }
      runsSent.push(r)
      return r
    }
    case 'run:status': { const r = runsSent.find((x) => x.id === args[0]); return r ? runState(r) : null }
    case 'run:list': return runsSent.map(runState).reverse()
    case 'run:cancel': return
    case 'creds:get': return String(args[0]).startsWith('vnc:') ? (vncCreds[args[0]] ?? null) : null
    case 'creds:set': if (String(args[0]).startsWith('vnc:')) vncCreds[args[0]] = args[1]; return
    case 'creds:delete': delete vncCreds[args[0]]; return
    case 'tailnet:list': return tailnetFixture
    case 'vnc:prepare': return { sessionId: args[0].sessionId, url: vncUrl, destination: '100.64.0.10:5900', route: 'direct', title: 'Fixture Mac' }
    case 'vnc:release': return
    case 'vnc:lastError': return undefined
    case 'computers:displays': return { auto: null, saved: displayLayouts[args[0]] ?? null }
    case 'computers:saveDisplays': if (args[1]) displayLayouts[args[0]] = args[1]; else delete displayLayouts[args[0]]; return
    case 'computers:thumbs': return computerThumbs
    case 'computers:saveThumb': computerThumbs[args[0]] = { image: args[1], at: Date.now() }; return
    case 'computers:probe': return Object.fromEntries(args[0].map((k) => [k, k === 'tailnet/nMAC' ? 'open' : k.startsWith('tailnet/') ? 'offline' : 'tunnel']))
    // A remote desktop that stays "connecting": the viewer is on the page, which is all the keyboard check needs.
    case 'rdp:prepare': return new Promise(() => undefined)
    case 'rdp:release': return
    case 'records:load': return structuredClone(recordDocs[args[0]] ?? { rev: 0, items: {} })
    case 'data:status': case 'data:sync': return dataState
    case 'tools:list': return toolsOut
    case 'tools:detach': toolsOut = [...new Set([...toolsOut, args[0]])]; _e.sender.send('tools:detached', toolsOut); return
    case 'tools:attach': toolsOut = toolsOut.filter((k) => k !== args[0]); _e.sender.send('tools:detached', toolsOut); _e.sender.send('app:command', { kind: 'section', section: args[0] }); return
    case 'tools:relay': return toolsOut.includes(args[0])
    case 'data:pickFolder': return '/Volumes/home/EC2 Remote Access'
    case 'data:setFolder': dataState = { ...dataState, dir: args[0], reachable: !!args[0], lastSync: args[0] ? Date.now() : undefined }; return dataState
    case 'data:copyLinkFiles': dataState = { ...dataState, linkFiles: { to: `${dataState.dir}/Links Files`, done: 3, total: 3, finished: true } }; return dataState
    case 'data:reveal': return
    case 'records:apply': {
      const d = (recordDocs[args[0]] ??= { rev: 0, items: {} })
      for (const o of args[1]) { if (o.op === 'delete') delete d.items[o.id]; else d.items[o.item.id] = structuredClone(o.item) }
      return ++d.rev
    }
    case 'links:anybox': if (anyboxBlocked) throw new Error('macOS keeps Anybox\'s library private to Anybox, so this app cannot read it directly.'); return { links: structuredClone(anyboxFixture), skippedFiles: 2, source: '/fixture/Anybox.sqlite' }
    case 'links:preview': return { title: 'Fixture page title', description: 'A page about fixtures.' }
    case 'calendar:feed': return FIXTURE_ICS
    case 'boards:list': return Object.values(boardsSaved).map((b) => ({ id: b.id, name: b.name, updatedAt: b.updatedAt, items: b.items.length })).sort((a, b) => b.updatedAt - a.updatedAt)
    case 'boards:load': return boardsSaved[args[0]] ? structuredClone(boardsSaved[args[0]]) : null
    case 'boards:save': boardsSaved[args[0].id] = structuredClone(args[0]); return
    case 'boards:delete': delete boardsSaved[args[0]]; return
    case 'notes:saveImage': noteImages.push(args[1]); return `EC2 Remote/Boards/${args[0]}.png`
    case 'local:home': return '/Users/fixture'
    case 'cad:read': { const bytes = readFileSync(args[0]); return { name: args[0].split('/').pop(), path: args[0], size: bytes.length, mtime: 1000, sha256: createHash('sha256').update(bytes).digest('hex'), format: 'step', bytes } }
    case 'cad:pick': return cadPicks.shift() ?? null
    case 'cad:cacheGet': return cadCache[args[0]] ?? null
    case 'cad:cachePut': cadCache[args[0]] = args[1]; return
    case 'notes:saveReview': {
      const path = `EC2 Remote/Reviews/${args[0]}.md`
      cadSaved.push({ name: args[0], markdown: args[1], png: args[2] })
      notes[path] = { text: args[1].replace('{image}', `${args[0]}.png`), mtime: Date.now() }
      return path
    }
    case 'storage:state': return stState
    case 'storage:fullDiskAccess': return false
    case 'storage:disk': return { name: 'Macintosh HD', total: 994e9, free: 452e9, freeNow: 416e9, history: Array.from({ length: 12 }, (_, i) => ({ day: new Date(now - (11 - i) * 86400000).toISOString().slice(0, 10), used: 530e9 + i * 1.2e9, total: 994e9 })) }
    case 'storage:scan':
      stState = { status: 'scanning', root: '/', progress: { dirs: 1200, files: 40000, bytes: 12e9, path: '/Users/fixture/Library/Caches' } }
      setTimeout(() => { stState = { status: 'done', summary: stSummary(), live: true }; if (!_e.sender.isDestroyed()) _e.sender.send('storage:scanState', stState) }, 300)
      return stState
    case 'storage:cancel': case 'storage:cancelDuplicates': case 'storage:openTrash': return
    case 'storage:pickFolder': return '/Users/fixture/Projects'
    case 'storage:nest': { const path = args[0].path ?? [{ path: '/' }, ...stAll()].find((n) => stId(n.path) === args[0].id)?.path ?? '/'; return { node: stNest(path, [14, 10, 6]), chain: stView(path).chain } }
    case 'storage:appsMap': return { apps: [], rest: { count: 0, size: 0 }, total: 0, count: 0 }
    case 'storage:kinds': return [{ kind: 'video', size: 30e9, count: 3, top: [] }, { kind: 'small', size: 2e9, count: 4000, top: [] }]
    case 'storage:topFolders': return stAll().filter((n) => n.dir).sort((a, b) => b.size - a.size).slice(0, 5)
    case 'storage:report': return { folders: stAll().filter((n) => n.dir).sort((a, b) => b.size - a.size).slice(0, 8), files: stAll().filter((n) => !n.dir), recent: stAll().filter((n) => !n.dir) }
    case 'storage:changes': return { scans: [{ at: now - 86400000, bytes: 270e9 }, { at: now, bytes: 280e9 }], base: now - 86400000, changes: [{ path: '/Users/fixture/Movies', before: 20e9, after: 30e9, delta: 10e9, kind: 'grew' }] }
    case 'storage:macInfo': return { os: 'macOS 27.2 (26B5101f)', model: 'MacBook Pro (14-inch, Nov 2023)', chip: 'Apple M3 Max (16 cores)', memory: 128 * 1024 ** 3, disk: 'Macintosh HD (APFS)' }
    case 'storage:targets': return [{ kind: 'mac', label: 'Macintosh HD', total: 994e9, free: 452e9 }, { kind: 'home', label: 'Your home folder', path: '/Users/fixture' }]
    case 'storage:dates': return { created: now - 300 * 86400000, modified: now - 86400000, opened: 0 }
    case 'storage:view': return stView(args[0].path ?? [{ path: '/' }, ...stAll()].find((n) => stId(n.path) === args[0].id)?.path ?? '/')
    case 'storage:large': return stAll().filter((n) => !n.dir && n.size >= args[0]).sort((a, b) => b.size - a.size)
    case 'storage:search': { const q = args[0].toLowerCase(); return stAll().filter((n) => n.name.toLowerCase().includes(q.replace(/^"|"$/g, ''))) }
    case 'storage:hidden': return stAll().filter((n) => n.name.startsWith('.'))
    case 'storage:duplicates': return [{ length: 3e9, files: [stFile('/Users/fixture/Movies/Edits/cut.mov', 3e9, 'video', 300), stFile('/Users/fixture/Downloads/cut copy.mov', 3e9, 'video', 2)] }]
    case 'storage:junk': return { at: Date.now(), notes: [], groups: [
      { id: 'caches', title: 'App caches', text: 'Copies apps and browsers keep to open faster.', items: [
        { path: '/Users/fixture/Library/Caches/com.spotify.client', name: 'com.spotify.client', size: 1.2e9, dir: true, safe: true, note: 'The app rebuilds its cache when it next needs it.' },
        { path: '/Users/fixture/Library/Caches/Google', name: 'Google', size: 2e9, dir: true, safe: false, note: 'Google Chrome is open, and may be writing into it: quit it first.' }] },
      { id: 'logs', title: 'Logs and crash reports', text: 'Records apps wrote about what they did.', items: [{ path: '/Users/fixture/Library/Logs/DiagnosticReports', name: 'DiagnosticReports', size: 0.3e9, dir: true, safe: true }] }] }
    case 'storage:ai': return { at: Date.now(), notes: [], groups: [{ id: 'ollama', title: 'Ollama', text: 'Only Ollama removes a model safely.', items: [
      { path: '/Users/fixture/.ollama/models/manifests/registry.ollama.ai/library/llama3.2/latest', name: 'llama3.2:latest', size: 2e9, dir: false, safe: false, blocked: 'Removed with ollama rm in Terminal: only Ollama removes its models safely.', action: { label: 'Copy the command', copy: 'ollama rm llama3.2:latest' } }] }] }
    case 'storage:installers': return { at: Date.now(), notes: [], groups: [] }
    case 'storage:systemData': return { notes: [], cards: [
      { id: 'system', title: 'In System Data', tag: 'System Data', look: 'system', text: 'Caches, logs and app support files.', rows: [{ label: 'Caches, logs and build data', size: 18e9, room: 'junk' }, { label: 'Leftovers of removed apps', room: 'leftovers' }] },
      { id: 'mail', title: 'Mail\'s Copies of Attachments', tag: 'Mail', look: 'mail', text: 'These can go.', size: 3e8, items: [{ path: '/Users/fixture/Library/Containers/com.apple.mail/Data/Library/Mail Downloads', name: 'Mail Downloads', label: 'Mail Downloads', size: 3e8, dir: true, safe: true }] },
      { id: 'trash', title: 'The Trash', tag: 'Trash', look: 'trash', size: 8e8, text: 'Empty it in Finder.', actions: [{ label: 'Open Trash', room: 'trash' }] }] }
    case 'storage:receipts': return []
    case 'storage:apps': return stApps
    case 'storage:appFiles': { const a = stApps.find((x) => x.path === args[0]); return [
      { path: `/Users/fixture/Library/Caches/${a.id}`, name: a.id, size: 5e7, dir: true, safe: true, note: 'Named for the app\'s bundle identifier. Caches are rebuilt whenever an app needs them.' },
      { path: `/Users/fixture/Library/Application Support/${a.name}`, name: a.name, size: 2e8, dir: true, safe: false, note: 'Named like the app. Application Support can hold documents, so it is never ticked for you.' }] }
    case 'storage:leftovers': return { at: Date.now(), notes: [], groups: [{ id: 'com.gone.app', title: 'gone', text: 'com.gone.app: no app with this identifier is installed.', items: [{ path: '/Users/fixture/Library/Caches/com.gone.app', name: 'com.gone.app', size: 3e7, dir: true, safe: true, note: 'Caches are rebuilt whenever an app needs them.' }] }] }
    case 'storage:startup': return [
      { path: '/Users/fixture/Library/LaunchAgents/com.gone.agent.plist', label: 'com.gone.agent', scope: 'user-agent', program: '/Applications/Gone.app/Contents/MacOS/agent', missing: true, apple: false, owner: '', ownerKind: 'none', loaded: false, runAtLoad: true, admin: false, size: 4096, mtime: now - 86400000, note: 'Its program is no longer there, so launchd has nothing to start.' },
      { path: '/Users/fixture/Library/LaunchAgents/com.daily.helper.plist', label: 'com.daily.helper', scope: 'user-agent', program: '/Applications/Daily.app/Contents/MacOS/helper', missing: false, apple: false, owner: 'Daily', ownerApp: '/Applications/Daily.app', ownerKind: 'app', loaded: true, runAtLoad: true, admin: false, size: 4096, mtime: now - 86400000, note: 'Runs the Daily helper.' }]
    case 'storage:quitApps': stQuits.push(...args[0]); return args[0].length
    case 'storage:monitor': return { at: Date.now(), cpu: 23.5, cpuUser: 15 + Math.random() * 5, cpuSys: 8, cores: [10, 40, 20, 30, 5, 60, 15, 8], load: [2.1, 1.8, 1.5], memory: { total: 32e9, used: 21e9, app: 14e9, wired: 4e9, compressed: 3e9, cached: 6e9, free: 11e9, swap: 0, pressure: 'normal' },
      net: { rx: 120000 + Math.random() * 1e5, tx: 40000 }, disk: { read: 3e6 * Math.random(), write: 1e6 }, battery: { percent: 77, charging: false, plugged: true, minutes: null, cycles: 116, health: 83, temperature: 30 }, uptime: 360000,
      apps: [{ name: 'Daily', path: '/Applications/Daily.app', cpu: 12.5, memory: 1.2e9, pids: [501, 502], system: false }, { name: 'WindowServer', path: '/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer', cpu: 8, memory: 3e8, pids: [300], system: true }], address: '192.168.0.20', thermal: 'normal' }
    case 'storage:openApps': return { watchedFor: 3600000, apps: [
      { name: 'Daily', id: 'com.daily.app', path: '/Applications/Daily.app', pid: 501, memory: 1.2e9, cpu: 0.1, lastFront: now - 2 * 3600000, front: false, busy: false, keep: false, idle: true },
      { name: 'Mail', id: 'com.apple.mail', path: '/System/Applications/Mail.app', pid: 601, memory: 4e8, cpu: 0.2, lastFront: now - 5 * 3600000, front: false, busy: false, keep: true, idle: false }] }
    case 'storage:trashSize': return 0.8e9
    case 'storage:trash': {
      const moved = args[0].map((it, i) => ({ id: `st-${Date.now()}-${i}`, path: it.path, trashPath: `/Users/fixture/.Trash/${it.path.split('/').pop()}`, size: it.size ?? 0 }))
      stRemoved = [...moved.map((m) => ({ ...m, at: Date.now(), from: args[1], dir: false, state: 'in-trash' })), ...stRemoved]
      for (const m of moved) for (const k of Object.keys(stKids)) stKids[k] = stKids[k].filter((n) => n.path !== m.path)
      _e.sender.send('storage:trashed', { count: moved.length, bytes: moved.reduce((t, m) => t + m.size, 0) })
      return { moved, failed: [], bytes: moved.reduce((t, m) => t + m.size, 0) }
    }
    case 'storage:removed': return stRemoved
    case 'storage:putBack': stPutBacks.push(...args[0]); stRemoved = stRemoved.filter((r) => !args[0].includes(r.id)); return { restored: args[0], failed: [] }
    case 'storage:forget': stRemoved = stRemoved.filter((r) => !args[0].includes(r.id)); return
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
    case 'health:snapshot':
      if (failWorkspaceHealth) throw new Error('Fixture health is unavailable')
      if (workspaceHealthAge) return { ...healthFixture(), at: Date.now() - workspaceHealthAge }
      return process.env.HEALTH_SNAPSHOT_JSON ? JSON.parse(readFileSync(process.env.HEALTH_SNAPSHOT_JSON, 'utf8')) : healthFixture()
    case 'health:memory': {
      if (process.env.HEALTH_MEM_JSON) return JSON.parse(readFileSync(process.env.HEALTH_MEM_JSON, 'utf8'))[`${args[0]}|${args[1]}`]
      const env = healthFixture().envs.find((e) => e.id === args[0])
      const n = { 1: 241, 6: 361, 24: 361, 72: 433, 168: 337, 336: 337 }[args[1]] ?? 361
      const step = { 1: 15, 6: 60, 24: 240, 72: 600, 168: 1800, 336: 3600 }[args[1]] ?? 240
      return { env: args[0], hours: args[1], start: now - args[1] * 3600000, step, machines: (env?.hosts ?? []).map((h, k) => ({
        ip: h.ip, name: h.name, role: h.role, label: h.label, os: h.os, state: h.state, totalBytes: h.memBytes,
        pct: Array.from({ length: n }, (_, i) => (h.state === 'stopped' && i > n / 2 ? null : Math.round((40 + k * 9 + Math.sin(i / 9) * 8) * 10) / 10)),
        now: h.state === 'stopped' ? null : 40 + k * 9, peak: 48 + k * 9, avg: 40 + k * 9, level: h.state === 'stopped' ? 'off' : 40 + k * 9 >= 80 ? 'warn' : 'ok',
        // CPU runs the other way round, so the busiest CPU is not the fullest memory.
        cpu: Array.from({ length: n }, (_, i) => (h.state === 'stopped' && i > n / 2 ? null : Math.round((92 - k * 20 + Math.sin(i / 7) * 5) * 10) / 10)),
        cpuNow: h.state === 'stopped' ? null : Math.max(3, 92 - k * 20), cpuPeak: Math.max(8, 97 - k * 20), cpuAvg: Math.max(3, 92 - k * 20), cores: 8,
        cpuLevel: h.state === 'stopped' ? 'off' : 92 - k * 20 >= 90 ? 'crit' : 92 - k * 20 >= 80 ? 'warn' : 'ok'
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
    case 'linksPanel:page': return structuredClone(panelPage)
    case 'linksPanel:status': return { save: { key: settings.linkSaveKey ?? 'ctrl+s', registered: true }, find: { key: settings.linkFindKey ?? 'ctrl+f', registered: true } }
    case 'linksPanel:show': case 'linksPanel:hide': case 'linksPanel:command': case 'linksPanel:resize': case 'linksPanel:automation': panelDone.push([channel, ...args]); return
    case 'browser:frontPage': return
    case 'launcher:open': case 'launcher:used': case 'launcher:command': case 'launcher:show': case 'launcher:hide': case 'launcher:pause': {
      launcherDone.push([channel, ...args])
      const id = channel === 'launcher:open' ? args[1] : channel === 'launcher:used' ? args[0] : null
      if (id) launcherUsage = { ...launcherUsage, [id]: { count: (launcherUsage[id]?.count ?? 0) + 1, last: Date.now() } }
      return
    }
    // The window helper and the launcher's Mac tools (main/desktopKeys.ts, main/macTools.ts), recorded, never real.
    case 'wm:status': return { helper: true, accessibility: wmAccess, calendar: macCalStatus, keys: Object.entries(settings.windowKeys ?? {}).map(([id, combo]) => ({ id: `window:${id}`, combo, registered: id !== 'maximize' })) }
    case 'wm:askAccess': wmAccess = true; launcherDone.push([channel]); return true
    case 'wm:layout': case 'wm:openPrivacy': launcherDone.push([channel, ...args]); return
    case 'launcher:processes': return [
      { pid: 4242, ppid: 1, user: 'fixture', cpu: 87.5, memory: 1.2e9, name: 'Runaway', command: '/Applications/Runaway.app/Contents/MacOS/Runaway', app: '/Applications/Runaway.app' },
      { pid: 501, ppid: 1, user: 'fixture', cpu: 3.1, memory: 4e8, name: 'Slack', command: '/Applications/Slack.app/Contents/MacOS/Slack', app: '/Applications/Slack.app' },
      { pid: 88, ppid: 1, user: 'root', cpu: 0, memory: 2e6, name: 'syslogd', command: '/usr/sbin/syslogd' }
    ]
    case 'launcher:kill': case 'launcher:quitAll': case 'launcher:paste': case 'notes:capture': {
      launcherDone.push([channel, ...args])
      return channel === 'launcher:paste' ? 'pasted' : channel === 'notes:capture' ? 'Daily/2026-10-23.md' : channel === 'launcher:quitAll' ? 2 : undefined
    }
    case 'launcher:network': return { addresses: [{ label: 'Public IPv4', address: '203.0.113.7', note: 'How websites and AWS security groups see this Mac' }, { label: 'Wi-Fi (en0)', address: '192.168.0.20', note: '192.168.0.20/24' }, { label: 'Tailscale', address: '100.101.7.3' }, { label: 'Router', address: '192.168.0.1' }] }
    case 'launcher:speedTest': return { id: 'fixture-speed' }
    case 'launcher:speedStatus': return { id: 'fixture-speed', started: now, ended: now + 20_000, live: true, samples: Array.from({ length: 30 }, (_, i) => ({ t: i * 250, down: 412.3 * Math.min(1, (i + 3) / 12), up: 23.4 * Math.min(1, (i + 2) / 14), rpm: i > 8 ? 1234 : 0 })),
      result: { download: 412_345_678, upload: 23_456_789, rpm: 1234, idleMs: 18, rating: 'High', workingMs: 48.6, interface: 'en0', server: 'fixture', isp: 'Frontier Communications', location: 'Austin, Texas, US', externalIp: '203.0.113.7', internalIp: '192.168.0.20' } }
    case 'launcher:downloads': return [
      { name: 'invoice-october.pdf', path: '/Users/fixture/Downloads/invoice-october.pdf', size: 245_000, dir: false, added: now - 3600_000 },
      { name: 'ubuntu-24.04.iso', path: '/Users/fixture/Downloads/ubuntu-24.04.iso', size: 6.1e9, dir: false, added: now - 3 * 86400_000 }
    ]
    case 'maccal:status': return { available: true, status: macCalStatus }
    case 'maccal:ask': macCalStatus = 'authorized'; return macCalStatus
    case 'maccal:calendars': return [
      { id: 'g-work', title: 'surendra@mainspring.example', account: 'surendra@mainspring.example', kind: 'caldav', color: '#1a73e8', writable: true },
      { id: 'g-holidays', title: 'Holidays in United States', account: 'surendra@mainspring.example', kind: 'caldav', color: '#0b8043', writable: false },
      { id: 'i-home', title: 'Home', account: 'iCloud', kind: 'icloud', color: '#ff9500', writable: true }
    ]
    case 'maccal:events': {
      const [from, to, ids] = args
      const at = (d, h, m = 0) => { const x = new Date(from); x.setDate(x.getDate() + 7 + d); x.setHours(h, m, 0, 0); return x.getTime() }
      macEventReads.push(ids)
      return ids.includes('g-work') ? [
        { id: 'standup@1', calendarId: 'g-work', title: 'Platform standup', start: at(1, 9, 30), end: at(1, 9, 45), allDay: false, location: 'Google Meet' },
        { id: 'review@1', calendarId: 'g-work', title: 'Release review', start: at(2, 14), end: at(2, 15), allDay: false }
      ].filter((e) => e.start >= from && e.start < to) : []
    }
    case 'maccal:settings': launcherDone.push([channel, ...args]); return
    default: throw new Error(`Unexpected fixture IPC: ${channel}`)
  }
})

app.whenReady().then(async () => {
  if (!workspacePreview) app.dock?.hide()
  // Nothing from a test run may reach the desktop: no notifications from the hidden windows.
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission !== 'notifications')
  session.defaultSession.setPermissionRequestHandler((_wc, permission, done) => done(permission !== 'notifications'))
  await new Promise((r) => webServer.listen(0, '127.0.0.1', r))
  webPort = webServer.address().port
  const win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { preload: join(__dirname, 'ui-preload.cjs'), contextIsolation: true, backgroundThrottling: false } })
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, blockNetwork)
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
    const screens = () => require('./ui-screens.cjs')({
      output, errors,
      fixture: { calls: () => calls, thumbs: () => computerThumbs, setTailnet: (t) => { tailnetFixture = t }, setVnc: (u) => { vncUrl = u }, allowWs: (prefix) => { wsAllowed = prefix } }
    })
    // Just the screen sharing checks (electron tests/ui-smoke.cjs --screens).
    if (process.argv.includes('--screens')) {
      await screens()
      assert.deepEqual(errors, [])
      console.log(`Screen sharing checks passed. Screenshots: ${output}`)
      app.exit(0)
      return
    }
    // This uses only the fixture IPC above. No production main, real credentials, shell or file writes are loaded.
    if (workspacePreview) {
      settings = { ...settings,
        workspaces: [{ id: 'preview-workspace', name: 'Production support', tabs: [{ kind: 'ssh', instanceKey: running.key }], savedAt: now }],
        hostViews: [{ id: 'preview-view', name: 'Production Linux', filters: { search: '', profileFilter: 'production', favoritesOnly: false, osFilter: 'linux', stateFilter: 'running', reachFilter: 'all' } }],
        portForwards: [{ id: 'preview-forward', name: 'Application logs', instanceKey: running.key, remotePort: 8080 }],
        quicklinks: [{ id: 'preview-link', name: 'Issue tracker', keyword: 'issue', url: 'https://example.com/issues/{query}', space: 'external' }]
      }
      await win.loadFile(resolve('out/renderer/index.html'))
      await until(`document.querySelector('.ws-account')?.textContent === '2 accounts verified'`)
      await js(`(() => {
        document.querySelector('.brand-name').textContent = 'Workspace Preview';
        const badge = document.createElement('div'); badge.textContent = 'DEMO · Synthetic data · Connections simulated';
        badge.style.cssText = 'position:fixed;bottom:8px;left:50%;transform:translateX(-50%);z-index:50;padding:5px 12px;background:#322c16;color:#ffe29a;border:1px solid #665429;border-radius:6px;font:11px system-ui;pointer-events:none';
        document.body.append(badge)
      })()`)
      win.setTitle('Workspace Preview — Synthetic data')
      win.on('closed', () => app.exit(0))
      win.show()
      console.log(`Isolated workspace preview. Temporary data: ${output}`)
      return
    }
    const projectCallsStart = calls.length
    const beforeProjects = { settings, terminal: termSaved, browser: browserSaved, notes: structuredClone(notes) }
    await require('./ui-workspaces.cjs')({
      calls, output, hostKey: running.key, webPort, getSettings: () => settings, failNotes: (value) => { failNoteWrites = value },
      seed: (value) => { termSaved = value.terminal; browserSaved = value.browser },
      restore: () => { settings = beforeProjects.settings; termSaved = beforeProjects.terminal; browserSaved = beforeProjects.browser; Object.assign(notes, beforeProjects.notes); failNoteWrites = false }
    })
    // The older suite checks its first SSH call; keep the new scenario's IPC history isolated.
    calls.splice(projectCallsStart)
    if (process.argv.includes('--project-workspaces')) {
      console.log(`Workspace checks passed. Screenshots: ${output}`)
      app.exit(0)
      return
    }
    // Save a filtered view, switch away, and restore it after a reload through the command palette.
    const setInput = (selector, value) => js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    // Developer workbench: real navigation, keyboard transformation, clipboard and draft lifecycle.
    const setToolInput = (value) => js(`(() => { const el = document.querySelector('#dev-input'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    assert.equal(await js(`!!document.querySelector('.app-rail [aria-label="Search"]')`), false, '⌘K has one entry point: the title bar')
    await js(`document.querySelector('.search-pill[aria-label="Open quick switcher"]').click()`)
    await until(`!!document.querySelector('[role="combobox"]')`)
    await click('Commands >')
    await until(`document.querySelector('[role="combobox"]').value === '>' && document.querySelector('.switcher .launcher-command')?.textContent === 'Commands & Tools'`)
    await setInput('[role="combobox"]', '>JSON')
    await until(`[...document.querySelectorAll('[role="option"]')].some((el) => el.textContent.includes('Open developer tools'))`)
    await key('Enter')
    await until(`!!document.querySelector('.dev-workbench')`)
    assert.equal(await js(`document.querySelector('.app-rail [aria-label="Dev tools"]').getAttribute('aria-current')`), 'page')
    await setToolInput('{"hello":"engineer","healthy":true}')
    await js(`document.querySelector('#dev-input').focus()`)
    await key('Enter', { metaKey: true })
    await until(`document.querySelector('#dev-output').value.includes('\\n  "hello"')`)
    await click('Copy result')
    await until(`document.body.textContent.includes('Result copied')`)
    assert.ok(calls.some((c) => c.channel === 'clipboard:write' && c.args[0].includes('"hello"')), 'copies exactly the transformed text')
    await screenshot('devtools-dark.png')
    await click('Hosts')
    await js(`document.querySelector('.app-rail [aria-label="Dev tools"]').click()`)
    await until(`document.querySelector('#dev-input').value.includes('engineer')`)
    await key('\\', { metaKey: true })
    await until(`!!document.querySelector('[role="combobox"]')`)
    await setInput('[role="combobox"]', 'Notes')
    await key('Enter')
    await until(`document.querySelectorAll('.split-pane:not(.hidden)').length === 2 && !!document.querySelector('.notes-tab')`)
    assert.equal(await js(`document.querySelector('#dev-input').value.includes('engineer')`), true, 'docking another tool preserves the draft')
    await screenshot('devtools-beside-notes.png')
    await key('w', { metaKey: true })
    await until(`!document.querySelector('.notes-tab')`)
    await js(`document.querySelector('.app-rail [aria-label="Dev tools"]').click()`)
    await click('Base64')
    await setToolInput('工程师 👋')
    await click('Encode')
    await until(`document.querySelector('#dev-output').value.length > 0`)
    await click('Use as input')
    await click('Decode')
    await until(`document.querySelector('#dev-output').value === '工程师 👋'`)
    await click('JSON')
    await until(`document.querySelector('#dev-input').value.includes('engineer')`)
    await setToolInput('{bad json')
    await click('Format JSON')
    await until(`!!document.querySelector('.dev-error[role="alert"]')`)
    assert.equal(await js(`document.querySelector('#dev-output').value`), '', 'failed transforms clear old output')
    await click('Load example')
    await click('Format JSON')
    await until(`document.querySelector('#dev-output').value.includes('"service"')`)
    win.setSize(680, 700)
    await new Promise((r) => setTimeout(r, 100))
    await screenshot('devtools-narrow.png')
    assert.ok(await js(`(() => { const e = document.querySelector('.dev-workbench'); return e.scrollWidth <= e.clientWidth + 1 })()`), 'workbench has no horizontal overflow in a narrow window')
    win.setSize(1400, 900)
    await key('w', { metaKey: true })
    await until(`!document.querySelector('.dev-workbench')`)
    await js(`document.querySelector('.app-rail [aria-label="Dev tools"]').click()`)
    await until(`!!document.querySelector('#dev-input')`)
    assert.equal(await js(`document.querySelector('#dev-input').value`), '', 'closing a tool tab discards its transient input')
    await key('w', { metaKey: true })
    await click('Hosts')
    // Tasks: the quick-add box reads dates, a new project, tags and priority; completing keeps the row until the
    // view changes; the editor; Upcoming and the Logbook.
    const nav = (label) => js(`(() => { const b = [...document.querySelectorAll('.plan-nav')].find((x) => x.getClientRects().length && x.querySelector('.plan-nav-label')?.textContent === ${JSON.stringify(label)}); if (!b) throw new Error('Missing list: ' + ${JSON.stringify(label)}); b.click() })()`)
    const submit = (form, input, value) => js(`(() => { const el = document.querySelector(${JSON.stringify(input)}); el.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`).then(() => js(`document.querySelector(${JSON.stringify(form)}).requestSubmit()`))
    await js(`document.querySelector('.app-rail [aria-label="Tasks"]').click()`)
    await until(`!!document.querySelector('.plan.tasks')`)
    await nav('Today')
    await setInput('.tasks-add-input', 'Review PR tomorrow 3pm #Platform @code p1')
    await until(`[...document.querySelectorAll('.tasks-add-found .plan-chip')].map((c) => c.textContent).join(' ') === 'tomorrow 3pm #Platform @code P1'`)
    await js(`document.querySelector('.tasks-add').requestSubmit()`)
    await until(`[...document.querySelectorAll('.plan-nav-label')].some((l) => l.textContent === 'Platform')`)
    await submit('.tasks-add', '.tasks-add-input', 'Water the plants')
    await submit('.tasks-add', '.tasks-add-input', 'Renew the certificate today !1 @ops')
    await until(`document.querySelectorAll('.task-row').length === 2`)
    assert.deepEqual(await js(`[...document.querySelectorAll('.task-row .task-title')].map((t) => t.textContent)`), ['Renew the certificate', 'Water the plants'], 'priority first')
    await js(`[...document.querySelectorAll('.task-row')].find((r) => r.textContent.includes('Water')).querySelector('.task-check').click()`)
    await until(`document.querySelector('.task-row.done')?.textContent.includes('Water')`)
    await screenshot('tasks-today.png')
    await nav('Upcoming')
    await until(`[...document.querySelectorAll('.task-row')].some((r) => r.textContent.includes('Review PR') && r.textContent.includes('Tomorrow 3 PM') && r.textContent.includes('#code') && r.textContent.includes('Platform'))`)
    await js(`[...document.querySelectorAll('.task-row')].find((r) => r.textContent.includes('Review PR')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
    await until(`!!document.querySelector('.task-edit')`)
    await js(`(() => { const t = document.querySelector('.task-edit-notes'); t.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, 'Check the migration'); t.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await screenshot('tasks-editor.png')
    await click('Done')
    await until(`!document.querySelector('.task-edit')`)
    const taskSaved = () => Object.values(recordDocs.tasks.items).some((t) => t.title === 'Review PR' && t.notes === 'Check the migration' && t.priority === 1 && t.tags?.includes('code'))
    for (let i = 0; i < 50 && !taskSaved(); i++) await new Promise((r) => setTimeout(r, 30))
    assert.ok(taskSaved(), 'the editor saved the notes')
    await nav('Logbook')
    await until(`[...document.querySelectorAll('.task-row')].some((r) => r.textContent.includes('Water the plants'))`)
    await nav('Today')
    await until(`document.querySelectorAll('.task-row').length === 1`)
    // Calendar: tasks on their days, an event from the quick-add box, the week view, and an iCal subscription.
    await js(`document.querySelector('.app-rail [aria-label="Calendar"]').click()`)
    await until(`!!document.querySelector('.plan.calendar .cal-month')`)
    await until(`[...document.querySelectorAll('.cal-chip.task')].some((c) => c.textContent.includes('Renew the certificate'))`)
    await submit('.cal-add', '.cal-add .tasks-add-input', 'Lunch with Sam today 12:30')
    await until(`[...document.querySelectorAll('.cal-chip')].some((c) => c.textContent.includes('Lunch with Sam'))`)
    assert.ok(Object.values(recordDocs.calendar.items).some((c) => c.type === 'calendar' && c.name === 'Personal'), 'the first event makes a Personal calendar')
    await screenshot('calendar-month.png')
    await click('Week')
    await until(`[...document.querySelectorAll('.cal-block')].some((b) => b.textContent.includes('Lunch with Sam') && b.textContent.includes('12:30 PM – 1:30 PM'))`)
    await screenshot('calendar-week.png')
    // A phone or a narrow pane spans three days for "week": seven columns would be too thin to read. The heading
    // follows the days actually shown, so it has to name the first and the last of them.
    win.setSize(560, 900)
    await until(`document.querySelector('.plan.calendar .plan-main').clientWidth < 600 && document.querySelectorAll('.plan.calendar .cal-time-day').length === 3`)
    await until(`(() => { const d = [...document.querySelectorAll('.plan.calendar .cal-time-day b')].map((b) => b.textContent); const h = document.querySelector('.plan.calendar .plan-head h1').textContent; return h.includes(d[0]) && h.includes(d[2]) })()`)
    await screenshot('calendar-week-narrow.png')
    win.setSize(1400, 900)
    await until(`document.querySelectorAll('.plan.calendar .cal-time-day').length === 7`)
    await js(`[...document.querySelectorAll('.cal-block')].find((b) => b.textContent.includes('Lunch')).click()`)
    await until(`document.querySelector('.cal-edit-title')?.value === 'Lunch with Sam'`)
    await js(`(() => { const el = document.querySelector('.cal-edit input[aria-label="Location"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'Cafe'); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await click('Save')
    await until(`[...document.querySelectorAll('.cal-block')].some((b) => b.textContent.includes('Cafe'))`)
    await js(`[...document.querySelectorAll('.plan-nav')].find((b) => b.textContent.includes('Subscribe to a calendar')).click()`)
    await setInput('.cal-edit input[aria-label="iCal link"]', 'webcal://calendar.example.com/team.ics')
    await click('Check link')
    await until(`document.querySelector('.cal-sub-ok')?.textContent.includes('Found 1 event')`)
    await click('Subscribe')
    await until(`[...document.querySelectorAll('.cal-allday-col .cal-chip')].some((c) => c.textContent.includes('Team offsite'))`)
    // Calendars on this Mac (a Google Workspace account in Internet Accounts): macOS is asked once, a calendar is
    // picked, and its events are in the week, read-only.
    await js(`[...document.querySelectorAll('.plan-nav')].find((b) => b.textContent.includes('Calendars on this Mac')).click()`)
    await until(`[...document.querySelectorAll('.cal-mac button')].some((b) => b.textContent.startsWith('Allow access'))`)
    await click('Allow access to Calendars…')
    await until(`document.querySelectorAll('.cal-mac-row').length === 3`)
    await js(`[...document.querySelectorAll('.cal-mac-row')].find((r) => r.textContent.includes('surendra@mainspring.example')).querySelector('input').click()`)
    await screenshot('calendar-mac.png')
    await click('Add 1 calendar')
    await until(`[...document.querySelectorAll('.cal-block')].some((b) => b.textContent.includes('Platform standup'))`)
    assert.ok(Object.values(recordDocs.calendar.items).some((c) => c.type === 'calendar' && c.mac === 'g-work' && c.color === '#1a73e8'), 'added with its colour')
    assert.ok(macEventReads.at(-1).includes('g-work'))
    await js(`[...document.querySelectorAll('.cal-block')].find((b) => b.textContent.includes('Platform standup')).click()`)
    await until(`document.querySelector('.cal-readonly')?.textContent.includes('a calendar on this Mac') && document.querySelector('.cal-readonly').textContent.includes('Google Meet')`)
    await click('Close')
    await until(`!document.querySelector('.cal-readonly')`)
    await click('Month')
    // Links: importing from Anybox (folders, tags, a note), search with a keyword, adding a link by its address.
    await js(`document.querySelector('.app-rail [aria-label="Links"]').click()`)
    await until(`!!document.querySelector('.links-welcome')`)
    await click('Import from Anybox')
    await until(`document.querySelector('.links-import')?.textContent.includes('private to Anybox') && [...document.querySelectorAll('.links-import button')].some((b) => b.textContent === 'Import a file…')`)
    await click('Close')
    anyboxBlocked = false
    await click('Import from Anybox')
    await until(`document.querySelector('.links-import')?.textContent.includes('5 new (3 links, 1 note, 1 file read)') && document.querySelector('.links-import').textContent.includes('2 new folders')`)
    await js(`document.querySelector('.links-import .btn-primary').click()`)
    await until(`document.querySelectorAll('.link-row').length === 5`)
    // Folders and nested tags fold: Work's Monitoring shows once Work is opened; Expand all and Collapse all.
    const sideHas = (label) => `[...document.querySelectorAll('.plan.links .plan-nav .plan-nav-label')].some((l) => l.textContent === ${JSON.stringify(label)})`
    assert.equal(await js(sideHas('Work')), true)
    assert.equal(await js(sideHas('Monitoring')), false, 'folded at first')
    await js(`[...document.querySelectorAll('.plan.links .plan-nav')].find((b) => b.querySelector('.plan-nav-label')?.textContent === 'Work').querySelector('.plan-chev').click()`)
    await until(sideHas('Monitoring'))
    await js(`document.querySelector('.plan.links [aria-label="Collapse all folders"]').click()`)
    await until(`!${sideHas('Monitoring')}`)
    await js(`document.querySelector('.plan.links [aria-label="Expand all folders"]').click()`)
    await until(sideHas('Monitoring'))
    assert.equal(await js(sideHas('docs')), false, 'the nested tag is folded under aws')
    await nav('aws')
    await until(`document.querySelectorAll('.link-row').length === 1 && document.querySelector('.link-row').textContent.includes('AWS documentation')`)
    await js(`document.querySelector('.plan.links [aria-label="Expand all tags"]').click()`)
    await until(sideHas('docs'))
    await screenshot('links-tree.png')
    await nav('All Links')
    await screenshot('links.png')
    await setInput('.links-search input', 'awsdocs')
    await until(`document.querySelectorAll('.link-row').length === 1 && document.querySelector('.link-row').textContent.includes('AWS documentation')`)
    await setInput('.links-search input', '')
    // A file from Anybox: its type's badge, size, and Open (on the Mac, through local:open).
    await nav('Files')
    await until(`document.querySelectorAll('.link-row').length === 1 && document.querySelector('.link-row').textContent.includes('PDF · 1.2 MB') && document.querySelector('.link-row .link-icon.badge')?.textContent === 'PDF'`)
    await js(`document.querySelector('.link-row .link-go').click()`)
    for (let i = 0; i < 50 && !calls.some((c) => c.channel === 'links:openFile'); i++) await new Promise((r) => setTimeout(r, 30))
    // By the link's id: main opens it from this Mac, or downloads its copy in Box where the Mac does not have it.
    assert.equal(recordDocs.links.items[calls.filter((c) => c.channel === 'links:openFile').at(-1)?.args[0]]?.path, '/fixture/Links Files/Work/Architecture review.pdf')
    // A folder lists as Finder does: its subfolder first, then only what is directly in it; a double-click opens the
    // subfolder, and the path bar and ⌘↑ go back up.
    await nav('Work')
    await until(`document.querySelector('.links-head h1')?.textContent === 'Work' && !!document.querySelector('.link-row')?.classList.contains('link-folder')`)
    assert.equal(await js(`document.querySelector('.link-folder .link-title').textContent`), 'Monitoring')
    assert.equal(await js(`[...document.querySelectorAll('.link-row:not(.link-folder)')].some((r) => r.textContent.includes('Grafana'))`), false, 'what is in Monitoring stays in Monitoring')
    assert.match(await js(`document.querySelector('.links-head .plan-sub').textContent`), /^1 folder · \d+ items?$/)
    assert.equal(await js(`(() => { const r = [...document.querySelectorAll('.link-row:not(.link-folder)')].map((x) => x.querySelector('.link-star').getBoundingClientRect().left); return Math.max(...r) - Math.min(...r) <= 1 })()`), true, 'stars line up, notes included')
    await screenshot('links-folder.png')
    await js(`document.querySelector('.link-folder').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
    await until(`document.querySelector('.links-head h1').textContent === 'Monitoring' && document.querySelectorAll('.link-row').length === 1 && document.querySelector('.links-crumbs')?.textContent === 'Work'`)
    await key('ArrowUp', { metaKey: true })
    await until(`document.querySelector('.links-head h1').textContent === 'Work' && !!document.querySelector('.link-folder.selected')`, '⌘↑ goes up to Work, Monitoring selected')
    await key('Enter')
    await until(`document.querySelector('.links-head h1').textContent === 'Monitoring'`, '↵ opens the selected folder')
    await js(`document.querySelector('.links-crumbs button').click()`)
    await until(`document.querySelector('.links-head h1').textContent === 'Work'`, 'the path bar goes back')
    await nav('Monitoring')
    await until(`document.querySelectorAll('.link-row').length === 1`)
    await js(`document.querySelector('.link-row').click()`)
    await until(`!!document.querySelector('.link-detail') && document.querySelector('.link-detail').textContent.includes('Dashboards')`)
    await screenshot('links-detail.png')
    await nav('All Links')
    await key('n', { metaKey: true })
    await until(`document.activeElement?.getAttribute('aria-label') === 'New link or note'`)
    await js(`(() => { const el = document.activeElement; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'example.org/fixture'); el.closest('form').requestSubmit() })()`)
    await until(`[...document.querySelectorAll('.link-row')].some((r) => r.textContent.includes('Fixture page title') && r.textContent.includes('example.org'))`)
    win.setSize(680, 760)
    await new Promise((r) => setTimeout(r, 150))
    await screenshot('links-narrow.png')
    win.setSize(1400, 900)
    // Close the three again (their data stays in the stub); the saved-work checks below expect no open tabs.
    for (const tool of ['Links', 'Calendar', 'Tasks']) {
      await js(`document.querySelector('.app-rail [aria-label="${tool}"]').click()`)
      await key('w', { metaKey: true })
      await until(`!document.querySelector('.plan.${tool.toLowerCase()}')`)
    }
    await click('Hosts')
    // Workspace modules: keyboard access, actionable failures, saved work, freshness and constrained layouts.
    const workspaceTab = (name) => js(`document.getElementById('workspace-tab-' + ${JSON.stringify(name)}).click()`)
    assert.equal(calls.filter((c) => c.channel === 'health:snapshot').length, 0, 'overview does not start platform polling')
    assert.equal(await js(`document.querySelector('.ws-account').textContent`), '2 accounts verified')
    assert.equal(await js(`document.querySelectorAll('.app-rail .rail-group, .app-rail .rail-group-label').length`), 0, 'one list, no group labels')
    assert.equal(await js(`document.querySelectorAll('.app-rail .rail-key').length`), 0, 'no shortcut hints under the rail items')
    assert.ok(await js(`(() => { const rail = document.querySelector('.app-rail'); return rail.scrollHeight <= rail.clientHeight })()`), 'grouped navigation fits')
    assert.equal(await js(`document.querySelector('.ws-attention').textContent.includes('1 inventory scan needs a retry')`), true)
    await js(`document.getElementById('workspace-tab-overview').focus()`)
    await key('ArrowRight')
    await until(`document.getElementById('workspace-tab-tools').getAttribute('aria-selected') === 'true'`)
    assert.equal(await js(`document.activeElement.id`), 'workspace-tab-tools')
    assert.equal(await js(`document.querySelectorAll('.ws-tool').length`), 15)
    await screenshot('workspace-tools.png')
    await workspaceTab('saved-work')
    await until(`!!document.querySelector('[aria-label="Search saved work"]')`)
    assert.equal(await js(`document.querySelector('.ws-saved-top button').disabled`), true, 'no remote sessions to save')
    const workspaceSettings = structuredClone(settings)
    settings = { ...settings,
      workspaces: [{ id: 'ws-test', name: 'Production support', tabs: [{ kind: 'ssh', instanceKey: running.key }], savedAt: now }, { id: 'missing', name: 'Missing host', tabs: [{ kind: 'ssh', instanceKey: 'gone/host' }], savedAt: now }],
      portForwards: [{ id: 'pf-test', name: 'Application logs', instanceKey: running.key, remotePort: 8080 }],
      quicklinks: [{ id: 'ql-test', name: 'Issue tracker', keyword: 'issue', url: 'https://example.com/issues/{query}', space: 'external' }]
    }
    await win.loadFile(resolve('out/renderer/index.html'))
    await until(`document.querySelector('.ws-account')?.textContent === '2 accounts verified'`)
    await workspaceTab('saved-work')
    await until(`document.querySelectorAll('.ws-saved-item').length === 4`)
    assert.equal(await js(`[...document.querySelectorAll('.ws-saved-item')].find((x) => x.textContent.includes('Missing host')).disabled`), true)
    await screenshot('workspace-saved-work.png')
    await setInput('[aria-label="Search saved work"]', 'not-found')
    await until(`!!document.querySelector('.ws-no-results')`)
    await setInput('[aria-label="Search saved work"]', 'issue')
    await until(`document.querySelectorAll('.ws-saved-item').length === 1`)
    await js(`document.querySelector('.ws-saved-item').click()`)
    await until(`!!document.querySelector('#workspace-link-query')`)
    await setInput('#workspace-link-query', 'PLM 42/7')
    await js(`document.querySelector('.ws-link-query').requestSubmit()`)
    await until(`!document.querySelector('.ws-link-query')`)
    assert.equal(calls.filter((c) => c.channel === 'shell:open').at(-1).args[0], 'https://example.com/issues/PLM%2042%2F7')
    await setInput('[aria-label="Search saved work"]', 'Application logs')
    await js(`document.querySelector('.ws-saved-item').click()`)
    await until(`!!document.querySelector('[role="dialog"]')`)
    assert.equal(await js(`document.querySelector('[role="dialog"]').textContent.includes('Port forward: Application logs')`), true)
    await key('Escape')
    await workspaceTab('platform')
    await until(`document.querySelectorAll('.ws-environment').length === 3`)
    await screenshot('workspace-platform.png')
    failWorkspaceHealth = true
    await click('Refresh health')
    await until(`document.querySelector('.ws-stale')?.textContent.includes('Refresh failed')`)
    assert.equal(await js(`document.querySelectorAll('.ws-environment.lvl-unknown').length`), 3, 'retained health is marked stale after failure')
    await screenshot('workspace-health-stale.png')
    failWorkspaceHealth = false
    workspaceHealthAge = 240_000
    await click('Refresh health')
    await until(`document.querySelector('.ws-stale')?.textContent.includes('more than 3 minutes')`)
    workspaceHealthAge = 0
    await click('Refresh health')
    await until(`!document.querySelector('.ws-stale') && !!document.querySelector('.ws-environment.lvl-ok')`)
    await workspaceTab('overview')
    await screenshot('workspace-overview-dark.png')
    await js(`document.documentElement.dataset.theme = 'light'`)
    await screenshot('workspace-overview-light.png')
    await js(`document.documentElement.dataset.theme = 'dark'`)
    win.setSize(1000, 700)
    await screenshot('workspace-small.png')
    assert.equal(await js(`document.querySelector('.workspace-deck').scrollWidth <= document.querySelector('.workspace-deck').clientWidth + 1`), true, 'workspace fits a small window')
    assert.ok(await js(`(() => { const r = document.querySelector('.host-table').getBoundingClientRect(); return Math.min(innerHeight - 30, r.bottom) - Math.max(0, r.top) })()`) > 80, 'inventory retains visible space in the viewport')
    await js(`document.querySelector('[aria-label="Fold the home panel"]').click()`)
    await win.loadFile(resolve('out/renderer/index.html'))
    await until(`!!document.querySelector('.workspace-deck.folded [aria-label="Show the home panel"]') && document.querySelectorAll('[data-host-key]').length === 3`)
    await js(`document.querySelector('[aria-label="Show the home panel"]').click()`)
    win.setSize(1400, 900)
    settings = workspaceSettings
    await win.loadFile(resolve('out/renderer/index.html'))
    await until(`document.querySelectorAll('[data-host-key]').length === 3`)
    if (process.argv.includes('--workspace-only')) {
      assert.deepEqual(errors, [])
      console.log(`Workspace UI checks passed. Screenshots: ${output}`)
      app.exit(0)
      return
    }
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
    assert.ok(await js(`document.querySelectorAll('.hl-srv-actions .hl-btn').length > 0`), 'server rows have Services and SSH buttons')
    assert.equal(await js(SRV_CLEAR), true, 'server row buttons clear of Up for (wide)')
    win.setSize(1080, 900)
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(await js(SRV_CLEAR), true, 'server row buttons clear of Up for (narrower: icons only)')
    assert.equal(await js(`getComputedStyle(document.querySelector('.hl-srv-actions .hl-btn-label')).display`), 'none', 'labels fold away when narrower')
    win.setSize(1400, 900)
    await new Promise((r) => setTimeout(r, 300))
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
    // Memory now as a honeycomb above the charts: green under 80%, yellow to 90%, red above; a click finds the chart.
    await until(`document.querySelectorAll('.hl-hive.mem .hl-hex').length >= 4`)
    assert.ok(await js(`[...document.querySelectorAll('.hl-hive.mem .hl-hex')].every((h) => /lvl-(ok|warn|crit|off|unknown)/.test(h.getAttribute('class')))`))
    const memHex = `[...document.querySelectorAll('.hl-hive.mem .hl-hex')].find((h) => !h.classList.contains('lvl-off'))`
    await js(`${memHex}.dispatchEvent(new PointerEvent('pointerover', { pointerType: 'mouse', bubbles: true }))`)
    await until(`!!document.querySelector('.hl-hive.mem .hl-hex-tip') && document.querySelector('.hl-hive.mem .hl-hex-tip').textContent.includes('to see its memory chart')`)
    const memIp = await js(`${memHex}.dataset.ip`)
    await js(`${memHex}.dispatchEvent(new PointerEvent('pointerout', { pointerType: 'mouse', bubbles: true }))`)
    await js(`(() => { const g = ${memHex}; g.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'mouse', bubbles: true })); g.dispatchEvent(new MouseEvent('click', { bubbles: true })) })()`)
    await until(`!!document.querySelector('.hl-mem.lit[data-ip="${memIp}"]')`)
    // CPU now beside it with the same bands; a click turns the charts to CPU and finds the machine's.
    await until(`document.querySelectorAll('.hl-hive.cpu .hl-hex').length >= 4`)
    assert.match(await js(`document.querySelector('.hl-hive.cpu').textContent`), /green under 80%, yellow to 90%, red above/)
    const cpuHex = `document.querySelector('.hl-hive.cpu .hl-hex.lvl-crit')`
    assert.ok(await js(`!!${cpuHex}`), 'a machine at 92% CPU is red')
    const cpuIp = await js(`${cpuHex}.dataset.ip`)
    await js(`(() => { const g = ${cpuHex}; g.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'mouse', bubbles: true })); g.dispatchEvent(new MouseEvent('click', { bubbles: true })) })()`)
    await until(`!!document.querySelector('.hl-mem.lit[data-ip="${cpuIp}"]') && [...document.querySelectorAll('.hl-sec-controls .hl-seg button.on')].some((b) => b.textContent === 'CPU')`)
    assert.match(await js(`document.querySelector('.hl-mem[data-ip="${cpuIp}"] .hl-mem-now').textContent`), /\d+%of 8 cores/, 'CPU of its cores, not memory of its gigabytes')
    assert.equal(await js(`document.querySelector('.hl-mem').dataset.ip`), cpuIp, 'the busiest CPU comes first')
    await js(`document.getElementById('hl-memory').scrollIntoView()`)
    await screenshot('health-cpu-comb.png')
    await js(`[...document.querySelectorAll('.hl-sec-controls .hl-seg button')].find((b) => b.textContent === 'Memory').click()`)
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
    await until(`!!document.querySelector('.radial') && document.querySelectorAll('.radial-item').length === 21`)
    assert.ok(await js(`document.querySelector('.radial-item.here').dataset.radial === 'hosts' && document.querySelector('.radial-center strong').textContent === 'Hosts'`), 'it starts on the section in front')
    assert.equal(await js(`document.activeElement === document.querySelector('.radial')`), true, 'the ring takes the keyboard')
    await new Promise((r) => setTimeout(r, 400))
    await screenshot('radial-dark.png')
    await js(`document.documentElement.setAttribute('data-theme', 'light')`)
    await screenshot('radial-light.png')
    await js(`document.documentElement.setAttribute('data-theme', 'dark')`)
    await radialKey()
    await radialKey()
    // Overview is skipped while no session is open; two steps from Hosts pass Computers and land on Health.
    assert.equal(await js(`document.querySelector('.radial-item.on').dataset.radial`), 'health')
    await radialKey()
    const arrow = (k) => js(`(() => { const e = new KeyboardEvent('keydown', { key: '${k}', bubbles: true, cancelable: true, metaKey: true, shiftKey: true }); document.activeElement.dispatchEvent(e) })()`)
    assert.equal(await js(`document.querySelector('.radial-item.on').dataset.radial`), 'local')
    await arrow('ArrowLeft')
    await arrow('ArrowLeft')
    assert.equal(await js(`document.querySelector('.radial-item.on').dataset.radial`), 'computers')
    await arrow('ArrowRight')
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
    assert.deepEqual(await js(SVC_ALIGNED), ALL_ALIGNED, 'services rows line up on the desktop')
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

    // The host page: a server's name in Services opens it, and Back returns to the dialog as it was.
    await js(`(() => { const row = document.querySelector('[data-host-key="${running.key}"]'); row.scrollIntoView({ block: 'center' }); const r = row.getBoundingClientRect(); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 200, clientY: r.top + 10 })) })()`)
    await until(`!!document.querySelector('body > .panel.modal.fixed')`)
    await js(`[...document.querySelectorAll('body > .panel.modal.fixed button')].find((b) => b.textContent === 'Services…').click()`)
    await until(`!!document.querySelector('.svc-row[data-unit="3dspace.service"] .svc-host-link')`)
    await js(`document.querySelector('.svc-row[data-unit="3dspace.service"] .svc-host-link').click()`)
    await until(`!!document.querySelector('.host-page') && !document.querySelector('.svc') && document.querySelectorAll('.hp-tile').length === 6 && document.querySelector('.hp-tile-value')?.textContent === '24%'`)
    assert.match(await js(`document.querySelector('.hp-crumbs').textContent`), /Services · web-prod-01.*Hosts.*web-prod-01/)
    assert.equal(await js(`!!document.querySelector('.hosts-workspace .host-details')`), false, 'the page takes the details panel\'s place')
    await until(`document.querySelectorAll('.hp-chart path.hp-line').length >= 6`)
    assert.ok(calls.some((c) => c.channel === 'host:history' && c.args[0] === running.key), 'the charts are read')
    assert.match(await js(`document.querySelector('.hp-tech').textContent`), /Apache TomEE/)
    assert.match(await js(`document.querySelector('.hp-peers').textContent`), /web-dev-01/, 'a caller that is in the inventory is named')
    assert.match(await js(`[...document.querySelectorAll('.hp-peers')][1].textContent`), /10\.0\.2\.20.*1521 Oracle/)
    // The shared crosshair: pointing at one chart shows the same moment in all four.
    await js(`(() => { const svg = document.querySelector('.hp-chart svg'); const r = svg.getBoundingClientRect(); svg.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + 40 })) })()`)
    await until(`document.querySelectorAll('.hp-cross').length === 4 && document.querySelectorAll('.hp-tip').length === 4`)
    await screenshot('host-page.png')
    await js(`document.querySelector('.hp-chart svg').dispatchEvent(new PointerEvent('pointerleave'))`)
    // Processes, then one process; ⌘[ goes back a step.
    await js(`[...document.querySelectorAll('.hp-tabs button')].find((b) => b.textContent.startsWith('Processes')).click()`)
    await until(`document.querySelectorAll('.hp-ptable button.hp-tr').length === 3`)
    await js(`[...document.querySelectorAll('.hp-ptable button.hp-tr')].find((b) => b.textContent.includes('java')).click()`)
    await until(`document.querySelector('.hp-title')?.textContent === 'java' && document.querySelector('.hp-cmd')?.textContent.includes('catalina')`)
    assert.ok(calls.some((c) => c.channel === 'host:process' && c.args[1] === 4242), 'the process is read')
    assert.match(await js(`document.querySelector('.hp-body').textContent`), /Also in 3dspace\.service|Started by it/)
    await screenshot('host-process.png')
    await key('[', { metaKey: true })
    await until(`!!document.querySelector('.hp-ptable') && !document.querySelector('.hp-cmd')`)
    await js(`document.querySelector('.hp-back').click()`)
    await until(`!document.querySelector('.host-page') && !!document.querySelector('.svc-row[data-unit="3dspace.service"]')`)
    await js(`document.querySelector('.svc-head [aria-label="Close dialog"]').click()`)
    await until(`!document.querySelector('.svc')`)
    // From the list the name opens the page with no trail; a peer that is one of ours opens its own page, and Back
    // comes back to the first; the Hosts crumb returns to the list.
    await js(`document.querySelector('[data-host-key="${running.key}"] button[title^="Open web-prod-01"]').click()`)
    await until(`!!document.querySelector('.host-page') && !document.querySelector('.hp-crumbs').textContent.includes('Services') && !!document.querySelector('.hp-peers .hp-link')`)
    await js(`document.querySelector('.hp-peers .hp-link').click()`)
    await until(`document.querySelector('.hp-crumb.current')?.textContent === 'web-dev-01'`)
    assert.match(await js(`document.querySelector('.hp-crumbs').textContent`), /web-prod-01.*Hosts.*web-dev-01/)
    await js(`document.querySelector('.hp-back').click()`)
    await until(`document.querySelector('.hp-crumb.current')?.textContent === 'web-prod-01'`)
    await js(`[...document.querySelectorAll('.hp-crumb button')].find((b) => b.textContent === 'Hosts').click()`)
    await until(`!document.querySelector('.host-page') && !!document.querySelector('[data-host-key="${running.key}"]')`)

    // Database locks from ⌘K: a blocker idle in a transaction with two sessions behind it; ending it on production needs
    // PROD typed, and History shows who did it.
    await key('k', { metaKey: true })
    await until(`!!document.querySelector('[role="combobox"]')`)
    await js(`(() => { const input = document.querySelector('[role="combobox"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '>Database locks'); input.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await until(`[...document.querySelectorAll('[role="option"]')].some((o) => o.textContent.includes('Database locks'))`)
    await js(`[...document.querySelectorAll('[role="option"]')].find((o) => o.textContent.includes('Database locks')).click()`)
    await until(`!!document.querySelector('.dbl-chain') && document.querySelectorAll('.dbl-waiter').length === 2`)
    assert.match(await js(`document.querySelector('.svc-head').textContent`), /1 session is blocking 2 others.*312 sessions/)
    assert.match(await js(`document.querySelector('.dbl-root').textContent`), /Blocking 2.*X3DSPACE.*Idle for 12m with a transaction open/)
    assert.match(await js(`document.querySelector('.dbl-chain').textContent`), /X3DSPACE\.LXBO_X · Row exclusive[\s\S]*Last statement[\s\S]*UPDATE lxbo_x/)
    assert.equal(await js(`document.querySelectorAll('.dbl-waiter')[1].style.paddingLeft`), '28px', 'a session waiting behind a waiter sits one step further in')
    assert.equal(await js(`!!document.querySelector('.dbl-dbs button[aria-selected="false"] svg')`), true, 'a database that cannot be read is marked')
    await screenshot('db-locks.png')
    await js(`document.querySelector('.dbl-root .btn-danger').click()`)
    await until(`!!document.querySelector('.svc-confirm.danger')`)
    const endBtn = `[...document.querySelectorAll('.svc-confirm button')].find((b) => b.textContent === 'End session')`
    assert.equal(await js(`${endBtn}.disabled`), true, 'production waits for PROD')
    await js(`(() => { const i = document.querySelector('.svc-confirm .svc-type'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'PROD'); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await until(`${endBtn}.disabled === false`)
    await js(`${endBtn}.click()`)
    await until(`!!document.querySelector('.dbl-clear') && !document.querySelector('.svc-confirm')`)
    assert.deepEqual(calls.filter((c) => c.channel === 'db:kill').map((c) => [c.args[0].id, c.args[0].sid, c.args[0].serial, c.args[0].confirm]), [['prod-ms-db', 101, 707, 'PROD']])
    await js(`[...document.querySelectorAll('.svc-head button')].find((b) => b.textContent.includes('History')).click()`)
    await until(`document.querySelector('.dbl-hist')?.textContent.includes('fixture.user')`)
    await js(`document.querySelector('.svc-head [aria-label="Close dialog"]').click()`)
    await until(`!document.querySelector('.dbl')`)

    // Settings → Services lists the install sheet's services and their units.
    await key(',', { metaKey: true })
    await until(`!!document.querySelector('.settings-nav-item[data-section="services"]')`)
    await js(`document.querySelector('.settings-nav-item[data-section="services"]').click()`)
    await until(`document.querySelectorAll('.svc-def').length === 10`)
    assert.ok(await js(`[...document.querySelectorAll('.svc-def input')].some((i) => i.value === 'thbtasklist.service 3dspaceDerivedconverter.service')`), 'a service with two units')
    // Settings → Launcher: quicklinks are added, checked and saved at once.
    await js(`document.querySelector('.settings-nav-item[data-section="launcher"]').click()`)
    await until(`[...document.querySelectorAll('.settings button')].some((b) => b.textContent.includes('Add a quicklink'))`)
    await js(`[...document.querySelectorAll('.settings button')].find((b) => b.textContent.includes('Add a quicklink')).click()`)
    await until(`!!document.querySelector('.ql-edit')`)
    const qlSet = (label, v) => js(`(() => { const i = [...document.querySelectorAll('.ql-grid label')].find((l) => l.querySelector('span').textContent === ${JSON.stringify(label)}).querySelector('input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(v)}); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await qlSet('Name', 'Jira issue')
    await qlSet('Keyword', 'two words')
    await qlSet('Address', 'https://example.atlassian.net/browse/{query}')
    await js(`[...document.querySelectorAll('.ql-edit button')].find((b) => b.textContent === 'Add quicklink').click()`)
    await until(`document.querySelector('.ql-edit .set-key-error')?.textContent.includes('one word')`, 'a keyword is one word')
    await qlSet('Keyword', 'jira')
    await js(`[...document.querySelectorAll('.ql-edit button')].find((b) => b.textContent === 'Add quicklink').click()`)
    await until(`!document.querySelector('.ql-edit') && document.querySelectorAll('.ql-row').length === 1`)
    assert.deepEqual(settings.quicklinks.map((l) => [l.keyword, l.url, l.space]), [['jira', 'https://example.atlassian.net/browse/{query}', 'general']])
    // Settings → Data: where things are, then a data folder chosen and in step, and the Links files copied there.
    await js(`document.querySelector('.settings-nav-item[data-section="data"]').click()`)
    await until(`[...document.querySelectorAll('.settings .set-row')].some((r) => r.textContent.includes('Tasks, Calendar and Links') && r.textContent.includes('/fixture/userData/records'))`, 'data places')
    await js(`[...document.querySelectorAll('.settings button')].find((b) => b.textContent === 'Choose…').click()`)
    await until(`[...document.querySelectorAll('.settings .set-row')].some((r) => r.textContent.includes('/Volumes/home/EC2 Remote Access')) && document.querySelector('.settings').textContent.includes('In step: synced just now')`, 'data folder chosen')
    await js(`[...document.querySelectorAll('.settings button')].find((b) => b.textContent === 'Copy to the data folder').click()`)
    await until(`document.querySelector('.settings').textContent.includes('Copied 3 files to /Volumes/home/EC2 Remote Access/Links Files')`, 'links files copied')
    await screenshot('settings-data.png')
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
    // As the launcher: one column with what each row is, the main action and Actions ⌘K in the floating bar.
    await until(`document.querySelector('.switcher .launcher-item.on .launcher-type')?.textContent === 'Stopped' && document.querySelector('.switcher .launcher-bar').textContent.includes('Show Details')`)
    await screenshot('quick-switcher.png')
    await key('k', { metaKey: true })
    await until(`[...document.querySelectorAll('.switcher .launcher-action')].some((a) => a.textContent.includes('Show Host Details'))`)
    await key('Escape')
    await until(`!document.querySelector('.switcher .launcher-actions') && !!document.querySelector('[role="combobox"]')`)
    await key('Enter', { shiftKey: true })
    await until(`!document.querySelector('[role="dialog"]') && document.querySelector('.host-details')?.textContent.includes('worker-stopped')`)
    await js(`document.querySelector('[aria-label="Close host details"]').click()`)
    await key('k', { metaKey: true })
    await until(`!!document.querySelector('[role="dialog"]')`)
    await key('Escape')
    await until(`!document.querySelector('[role="dialog"]')`)
    assert.equal(await js(`document.activeElement.getAttribute('aria-label')`), 'Open quick switcher')
    // Plain language in the switcher too: the sentence is its own row, first.
    await key('k', { metaKey: true })
    await until(`!!document.querySelector('[role="combobox"]')`)
    await js(`(() => { const input = document.querySelector('[role="combobox"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'ssh to web prod 1'); input.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await until(`document.querySelector('.switcher .launcher-group')?.textContent === 'Do This' && document.querySelector('.switcher .launcher-item.on .launcher-title')?.textContent === 'SSH to web-prod-01' && document.querySelector('.switcher .launcher-bar').textContent.includes('SSH to web-prod-01')`)
    await screenshot('quick-switcher-intent.png')
    await key('Escape')
    await until(`!document.querySelector('[role="dialog"]')`)

    // Details fit at the minimum window size in both themes (a row opens them; its name opens the host page).
    await js(`document.querySelector('[data-host-key="${stale.key}"]').click()`)
    await until(`document.querySelector('.host-details')?.textContent.includes('web-dev-01')`)
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
    // Bundled fonts really load, even with all network traffic blocked by this fixture.
    for (const family of ['Geist', 'Manrope', 'Geist Mono']) {
      await js(`[...document.querySelectorAll('.font-choice')].find((b) => b.querySelector('.font-choice-name').textContent === ${JSON.stringify(family)}).click()`)
      const loaded = await js(`document.fonts.load('14px "${family}"').then((faces) => faces.length > 0 && faces.every((face) => face.status === 'loaded'))`)
      assert.equal(loaded, true, `${family} is available offline`)
      await until(`document.documentElement.style.getPropertyValue('--ui-font').includes(${JSON.stringify(family)})`)
    }
    await js(`[...document.querySelectorAll('.font-choice')].find((b) => b.querySelector('.font-choice-name').textContent === 'Geist').click()`)
    for (const id of ['midnight', 'aurora', 'ember', 'porcelain']) {
      await js(`document.querySelector('[data-color-theme-option="${id}"]').click()`)
      await until(`document.documentElement.dataset.colorTheme === '${id}'`)
      assert.equal(settings.colorTheme, id)
    }
    await js(`[...document.querySelectorAll('[aria-label="Filter themes"] button')].find((b) => b.textContent === 'Light').click()`)
    await until(`!!document.querySelector('[data-color-theme-option="porcelain"]') && !document.querySelector('[data-color-theme-option="midnight"]')`)
    await screenshot('appearance-porcelain-geist.png')
    await js(`[...document.querySelectorAll('[aria-label="Filter themes"] button')].find((b) => b.textContent === 'All').click()`)
    await js(`document.querySelector('[data-color-theme-option="midnight"]').click()`)
    await screenshot('appearance-midnight-geist.png')
    await js(`document.querySelector('.ctheme-grid').scrollIntoView({ block: 'center' })`)
    await screenshot('theme-gallery.png')
    await js(`document.querySelector('[data-color-theme-option="default"]').click()`)
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
    phone.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, blockNetwork)
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
    // CAD on an iPad and a phone: the file is chosen on the device and read in the page (never cad:*, which the
    // gateway refuses), hashed there, cached in IndexedDB; on a phone the parts and the review are sheets.
    // The input's click is stubbed: a real one would put a file chooser on the desktop.
    const cadCallsBefore = calls.filter((c) => c.channel.startsWith('cad:')).length
    const cubeBytes = readFileSync(cadFiles.cube)
    const plong = async (code, what) => { for (let n = 0; n < 600; n++) { if (await pjs(code)) return; await new Promise((r) => setTimeout(r, 50)) } throw new Error(`Timed out (phone CAD): ${what}`) }
    const feedCube = () => pjs(`(() => { const b = Uint8Array.from(atob(${JSON.stringify(cubeBytes.toString('base64'))}), (c) => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([b], 'cube.stp')); const i = document.querySelector('.cad-file-input'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    await ptap('More')
    await ptap('CAD')
    await puntil(`!!document.querySelector('.cad .cad-start') && !!document.querySelector('.cad-file-input')`)
    assert.match(await pjs(`document.querySelector('.cad-drop p').textContent`), /Choose one/, 'off the Mac the file is chosen on the device')
    await pjs(`window.__picks = 0; document.querySelector('.cad-file-input').click = () => { window.__picks++ }; 0`)
    await pjs(`document.querySelector('.cad-drop .btn-primary').click()`)
    assert.equal(await pjs(`window.__picks`), 1, 'Open… opens the device\'s file chooser')
    await feedCube()
    await plong(`document.querySelector('.cad-head-file b')?.textContent === 'cube.stp' && !document.querySelector('.cad-loading') && !!document.querySelector('.cad-review')`, 'the cube read on the device')
    const deviceReview = Object.values(recordDocs.reviews.items).find((i) => i.type === 'cadfile')
    assert.equal(deviceReview.id, createHash('sha256').update(cubeBytes).digest('hex'), 'the device finds the same review the Mac would: by SHA-256')
    assert.equal(deviceReview.path, '', 'a file chosen on a device has no path')
    await pshot('ipad-cad.png')
    // The iPad keeps its list beside the tab, so the review sits beside the model (not a sheet), one panel at a time.
    assert.equal(await pjs(`!!document.querySelector('.cad-review') && !document.querySelector('.cad-sheet') && document.querySelector('.cad-stage').getBoundingClientRect().width > 400`), true, 'iPad landscape: the review beside the model')
    // Opened again, the model comes from the device's own cache.
    await puntil(`indexedDB.databases().then((ds) => ds.some((d) => d.name === 'cad-cache'))`)
    await puntil(`new Promise((r) => { const q = indexedDB.open('cad-cache'); q.onsuccess = () => { const d = q.result; if (!d.objectStoreNames.contains('glb')) { d.close(); r(false); return } const c = d.transaction('glb').objectStore('glb').count(); c.onsuccess = () => { d.close(); r(c.result === 1) } }; q.onerror = () => r(false) })`)
    await feedCube()
    await puntil(`!document.querySelector('.cad-loading') && !!document.querySelector('.cad-review')`)
    await pjs(`[...document.querySelectorAll('.cad-tabs button')].find((b) => b.textContent.startsWith('Info')).click()`)
    await puntil(`document.querySelector('.cad-info')?.textContent.includes('from the cache') && !document.querySelector('.cad-info-actions')`)
    // A phone: the model takes the tab; Review slides up as a sheet and Done puts it away.
    phone.setContentSize(430, 932)
    await puntil(`innerWidth === 430 && document.querySelector('.cad').classList.contains('compact') && !document.querySelector('.cad-tree') && !document.querySelector('.cad-review')`)
    assert.equal(await noSideScroll(), true, 'phone CAD: no sideways scrolling')
    assert.equal(await pjs(`(() => { const r = document.querySelector('.cad-toolbar').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight })()`), true, 'phone: the CAD toolbar is on screen')
    await pshot('phone-cad.png')
    await pjs(`document.querySelector('.cad-head .cad-icon-btn[title="Review"]').click()`)
    await puntil(`!!document.querySelector('.cad-sheet .cad-review')`)
    await pshot('phone-cad-review.png')
    await pjs(`[...document.querySelectorAll('.cad-sheet-bar button')].find((b) => b.textContent === 'Done').click()`)
    await puntil(`!document.querySelector('.cad-sheet')`)
    // A comment pinned with a tap; the sheet stays down so the pin is in view.
    await pjs(`document.querySelector('.cad-toolbar button[title^="Pin a comment"]').click()`)
    await puntil(`document.querySelector('.cad-stage').classList.contains('tool-pin') && document.querySelector('.cad-tool-hint button')?.textContent === 'Done'`)
    const phoneMid = await pjs(`(() => { const r = document.querySelector('.cad-canvas').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
    phone.webContents.focus()
    phone.webContents.sendInputEvent({ type: 'mouseMove', x: phoneMid.x, y: phoneMid.y - 30 })
    phone.webContents.sendInputEvent({ type: 'mouseDown', x: phoneMid.x, y: phoneMid.y - 30, button: 'left', clickCount: 1 })
    phone.webContents.sendInputEvent({ type: 'mouseUp', x: phoneMid.x, y: phoneMid.y - 30, button: 'left', clickCount: 1 })
    await puntil(`!!document.querySelector('.cad-composer textarea')`)
    assert.equal(await pjs(`(() => { const r = document.querySelector('.cad-composer').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth })()`), true, 'phone: the comment box fits the screen')
    await pjs(`(() => { const el = document.querySelector('.cad-composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, 'Check this face on site'); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await pjs(`[...document.querySelectorAll('.cad-composer button')].find((b) => b.textContent === 'Pin').click()`)
    await puntil(`!!document.querySelector('.cad-pin[data-pin="1"]') && !document.querySelector('.cad-sheet')`)
    await pshot('phone-cad-pin.png')
    assert.equal(calls.filter((c) => c.channel.startsWith('cad:')).length, cadCallsBefore, 'nothing from a device asks for cad:*')
    // The Mac's own pass below starts from no reviews.
    delete recordDocs.reviews
    phone.setContentSize(1194, 834)

    // Signing in from a phone: the approval happens in Safari, iOS suspends the page and drops its socket, and the
    // "signed in" push is sent to nobody. The dialog must still finish by asking the computer what token it holds.
    ssoScenario = true
    phone.setContentSize(430, 932)
    await phone.loadFile(resolve('out/renderer/index.html'), { query: { layout: 'mobile' } })
    await puntil(`!!document.querySelector('.m-app') && document.querySelectorAll('.m-tabbar button').length === 5`)
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
    await puntil(`document.querySelectorAll('.hl-hive.alb .hl-hex, .hl-hive.http .hl-hex').length === 12`)
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
    // A machine's name opens its page (CPU, memory, disks, processes) on the phone's stage; Back returns to Health.
    await pjs(`document.querySelector('.hl-srv[data-ip="10.9.0.11"] .hl-srv-link').click()`)
    await puntil(`!!document.querySelector('.m-hostpage .host-page') && document.querySelectorAll('.m-hostpage .hp-tile').length === 6 && getComputedStyle(document.querySelector('.m-side')).display === 'none'`)
    assert.match(await pjs(`document.querySelector('.m-hostpage .hp-crumbs').textContent`), /Health · Production/)
    assert.equal(await noSideScroll(), true, 'the machine page fits the phone width')
    await pshot('phone-host-page.png')
    await pjs(`document.querySelector('.m-hostpage .hp-back').click()`)
    await puntil(`!document.querySelector('.m-hostpage') && !!document.querySelector('.hl-hero')`)
    // Services on a phone: each row's dot, name and state on one line, then the unit, then uptime with the buttons;
    // the title, Close, History and Read again fit; nothing scrolls sideways.
    await pjs(`[...document.querySelectorAll('.hl button')].find((b) => b.textContent.trim() === 'Control services').click()`)
    await puntil(`document.querySelectorAll('.svc-row[data-unit]').length > 1`)
    const svcRow = await pjs(`(() => {
      const row = document.querySelector('.svc-row[data-unit]').getBoundingClientRect()
      const r = (s) => document.querySelector('.svc-row[data-unit] ' + s).getBoundingClientRect()
      const mid = (b) => (b.top + b.bottom) / 2
      const dot = r('.svc-dot'), who = r('.svc-who'), name = r('.svc-host-link'), pill = r('.svc-pill'), unit = r('.svc-unit'), acts = r('.svc-acts')
      return { nameIn: Math.round(who.left - row.left), pillLine: Math.abs(mid(pill) - mid(name)) < 8, dotLine: Math.abs(mid(dot) - mid(name)) < 8, unitBelow: unit.top >= who.bottom - 1, actsBelow: acts.top >= unit.bottom - 1, actsRight: row.right - acts.right < 20 }
    })()`)
    assert.ok(svcRow.nameIn < 44, `the name sits next to its dot, not pushed right (${svcRow.nameIn}px in)`)
    assert.deepEqual([svcRow.dotLine, svcRow.pillLine, svcRow.unitBelow, svcRow.actsBelow, svcRow.actsRight], [true, true, true, true, true], 'dot, name and state on one line; unit; uptime and buttons')
    assert.equal(await pjs(`(() => { const head = document.querySelector('.svc-head').getBoundingClientRect(); const close = document.querySelector('.svc-head [aria-label="Close dialog"]').getBoundingClientRect(); const title = document.querySelector('.svc-head h2').getBoundingClientRect(); return close.right <= head.right && Math.abs(close.top - title.top) < 12 })()`), true, 'Close sits on the title line')
    assert.equal(await pjs(`(() => { const b = document.querySelector('.svc-body'); return b.scrollWidth <= b.clientWidth + 1 })()`), true, 'services fit the phone width')
    assert.deepEqual(await pjs(SVC_ALIGNED), ALL_ALIGNED, 'services rows line up on a phone')
    assert.equal(await noSideScroll(), true)
    await pshot('phone-services.png')
    await pjs(`document.querySelector('.svc-head [aria-label="Close dialog"]').click()`)
    await puntil(`!document.querySelector('.svc')`)
    await pjs(`document.querySelector('.hl').scrollTop = 0`)
    phone.setContentSize(1194, 834)
    await puntil(`innerWidth === 1194 && document.querySelector('.m-app').classList.contains('wide')`)
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(await pjs(`(() => { const h = document.querySelector('.hl'); return h.scrollWidth <= h.clientWidth + 1 })()`), true, 'no sideways scrolling inside health on a tablet')
    await pshot('ipad-health.png')
    await pjs(`[...document.querySelectorAll('.hl button')].find((b) => b.textContent.trim() === 'Control services').click()`)
    await puntil(`document.querySelectorAll('.svc-row[data-unit]').length > 1`)
    assert.ok(await pjs(`document.querySelector('.svc').getBoundingClientRect().width < 760`), 'a sheet narrower than the screen')
    assert.deepEqual(await pjs(SVC_ALIGNED), ALL_ALIGNED, 'services rows line up in a sheet on a wide screen (unfolded Duo, iPad)')
    await pshot('ipad-services.png')
    await pjs(`document.querySelector('.svc-head [aria-label="Close dialog"]').click()`)
    await puntil(`!document.querySelector('.svc')`)
    await pjs(`document.querySelector('.hl-srv[data-ip="10.9.0.11"] .hl-srv-link').click()`)
    await puntil(`!!document.querySelector('.m-hostpage .host-page') && document.querySelectorAll('.m-hostpage .hp-chart').length === 4`)
    await pshot('ipad-host-page.png')
    await pjs(`document.querySelector('.m-hostpage .hp-back').click()`)
    await puntil(`!document.querySelector('.m-hostpage') && !!document.querySelector('.hl-hero')`)
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
    // Stay approved: on unless turned off, saved at once (the dialog's Save leaves it alone).
    assert.equal(await bjs(`document.querySelector('.op-foot input').checked`), true, 'stay approved by default')
    await bjs(`document.querySelector('.op-foot input').click()`)
    for (let n = 0; n < 60 && settings.onePasswordStayApproved !== false; n++) await new Promise((r) => setTimeout(r, 30))
    assert.equal(settings.onePasswordStayApproved, false, 'the switch saves')
    await bjs(`document.querySelector('.op-foot input').click()`)
    for (let n = 0; n < 60 && settings.onePasswordStayApproved !== true; n++) await new Promise((r) => setTimeout(r, 30))
    await bjs(`document.querySelector('.op-search input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`)
    await buntil(`!document.querySelector('.op') && document.querySelector('.toasts')?.textContent.includes('Filled the username and password')`, 'filled')
    const fillCall = calls.filter((c) => c.channel === 'browser:fill').at(-1).args
    assert.deepEqual(fillCall.slice(1), ['u1', 'i1', false])
    assert.equal(fillCall[0], guestAt('/one').id, 'fills the page on screen')
    // Extensions (the puzzle button): what is installed and what it can reach, turning one off, adding by link.
    await bjs(`document.querySelector('.web-side-top [aria-label="Extensions"]').click()`)
    await buntil(`document.querySelectorAll('.ext-row').length === 1 && document.querySelector('.ext-row').textContent.includes('Dark Reader') && document.querySelector('.ext-row').textContent.includes('Reads and changes every site')`, 'extensions list')
    // Choosing one is Chrome's toolbar click: with no popup set the extension takes it (on the page on screen) and the
    // panel closes; a page it asks for opens as a tab in the space it runs in, and nowhere for an unknown session.
    await bjs(`document.querySelector('.ext-row .ext-main').click()`)
    await buntil(`!document.querySelector('.ext')`, 'the extension took the click')
    const extPress = calls.filter((c) => c.channel === 'ext:action').at(-1).args
    assert.deepEqual(extPress.slice(0, 2), ['eimadpbcbfnmbkopoojfekhnkhdbieeh', 'persist:web-general'])
    assert.equal(extPress[2], guestAt('/one').id, 'the page on screen')
    const extTabs = await bjs(`document.querySelectorAll('.web-tab').length`)
    bwin.webContents.send('ext:openTab', { partition: 'persist:web-nowhere', url: page('/ext-elsewhere'), background: false })
    bwin.webContents.send('ext:openTab', { partition: 'persist:web-general', url: page('/ext-signin'), background: false })
    await buntil(`document.querySelectorAll('.web-tab').length === ${extTabs + 1}`, 'the extension\'s page opens in a tab')
    for (let i = 0; i < 50 && !guestAt('/ext-signin'); i++) await new Promise((r) => setTimeout(r, 100))
    assert.ok(guestAt('/ext-signin'), 'in a tab of the General space')
    assert.ok(!guestAt('/ext-elsewhere'), 'not in another space')
    await bkey('w')
    await buntil(`document.querySelectorAll('.web-tab').length === ${extTabs}`, 'closed again')
    await bjs(`document.querySelector('.web-fav').click()`)
    await buntil(`!!document.querySelector('.web-fav.on')`, 'page one (a favorite) in front again')
    // An extension asking for its popup (action.openPopup: 1Password's Unlock in a page) gets the panel open on it.
    bwin.webContents.send('ext:openPopup', { partition: 'persist:web-general', id: 'eimadpbcbfnmbkopoojfekhnkhdbieeh', url: 'chrome-extension://eimadpbcbfnmbkopoojfekhnkhdbieeh/popup.html' })
    await buntil(`document.querySelector('.ext .ext-head')?.textContent.includes('Dark Reader') && document.querySelector('.ext .ext-view')?.getAttribute('src') === 'chrome-extension://eimadpbcbfnmbkopoojfekhnkhdbieeh/popup.html'`, 'the popup it asked for')
    assert.equal(await bjs(`document.querySelector('.ext .ext-view').hasAttribute('allowpopups')`), true, 'its links reach main')
    // The panel takes the size the page asks for (1Password's popup is 600 × 450), so it needs no scroll bars.
    await buntil(`(() => { try { return document.querySelector('.ext .ext-view').getWebContentsId() > 0 } catch { return false } })()`, 'popup page attached')
    const popupWc = await bjs(`document.querySelector('.ext .ext-view').getWebContentsId()`)
    bwin.webContents.send('web:preferredSize', { webContentsId: popupWc, width: 600, height: 450 })
    await buntil(`document.querySelector('.ext-view-box').style.width === '600px' && document.querySelector('.ext-view-box').style.height === '450px'`, 'sized to its page')
    await bjs(`document.querySelector('.ext .ext-head [aria-label="Back to extensions"]').click()`)
    await buntil(`document.querySelectorAll('.ext-row').length === 1`, 'extensions list again')
    await bjs(`document.querySelector('.ext-row input[type="checkbox"]').click()`)
    await buntil(`document.querySelector('.ext-row').classList.contains('off')`, 'turned off')
    assert.ok(calls.some((c) => c.channel === 'ext:setEnabled' && c.args[0] === 'eimadpbcbfnmbkopoojfekhnkhdbieeh' && c.args[1] === false))
    await bjs(`(() => { const i = document.querySelector('.ext-add input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'https://chromewebstore.google.com/detail/json-formatter/bcjindcccaagfpapjjmafapmmgkkhgoa'); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await bjs(`document.querySelector('.ext-add button[type="submit"]').click()`)
    await buntil(`document.querySelectorAll('.ext-row').length === 2`, 'added by link')
    assert.equal(calls.filter((c) => c.channel === 'ext:install').at(-1).args[0], 'https://chromewebstore.google.com/detail/json-formatter/bcjindcccaagfpapjjmafapmmgkkhgoa')
    await bshot('browser-extensions.png')
    await bkey('Escape')
    await bjs(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
    await buntil(`!document.querySelector('.ext')`, 'the panel closes')
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
    await buntil(`document.querySelector('.switcher-result.on')?.textContent.includes('web-prod') && document.querySelector('.switcher .launcher-bar').textContent.includes('SSH beside')`, 'host offered beside')
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
    // ⌘K lists the Browser's sites under its tab, to switch straight to one.
    await new Promise((r) => setTimeout(r, 450))
    bwin.webContents.send('app:command', { kind: 'switcher' })
    await buntil(`document.querySelectorAll('.switcher-result.space').length >= 2 && document.querySelectorAll('.switcher-result.nested-2').length >= 2`, 'the quick switcher lists the open sites, by space')
    // Each space's sites follow its own row, never mixed with another space's.
    assert.ok(await bjs(`(() => { const rows = [...document.querySelectorAll('.switcher-result')]; const seen = []; let cur = null; for (const r of rows) { if (r.classList.contains('space')) { cur = r.querySelector('.launcher-title').textContent; if (seen.includes(cur)) return false; seen.push(cur) } } return seen.length >= 2 })()`), 'one row per space')
    await bshot('switcher-sites.png')
    await bjs(`(() => { const i = document.querySelector('[aria-label="Find a host or open session"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'one'); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await buntil(`[...document.querySelectorAll('.switcher-result')].some((r) => r.id && !r.classList.contains('space') && r.textContent.includes('127.0.0.1'))`, 'a site by its address')
    await bjs(`[...document.querySelectorAll('.switcher-result')].find((r) => !r.classList.contains('space') && r.textContent.includes('127.0.0.1')).click()`)
    await buntil(`!document.querySelector('.switcher-result') && document.querySelector('button[aria-label="Browser"]').classList.contains('on')`, 'picking a site switches to it')

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
    // Each rail item names its shortcut in its tooltip, straight from these settings: none for Claude now.
    await buntil(`!/\\(.+\\)$/.test(document.querySelector('button[aria-label="Claude"]').title)`, 'no key, none in Claude\'s tooltip')
    assert.match(await bjs(`document.querySelector('button[aria-label="Notes"]').title`), /\(⇧⌘N\)$/)
    assert.match(await bjs(`document.querySelector('button[aria-label="Hosts"]').title`), /\(⌘1\)$/)
    await bjs(`document.querySelector('[aria-label="Shortcut for Claude"]').click()`)
    await press('c', 'KeyC', { metaKey: true, ctrlKey: true })
    await buntil(`document.querySelector('[aria-label="Shortcut for Claude"]').textContent === '⌃⌘C'`, 'recorded again')
    await buntil(`document.querySelector('button[aria-label="Claude"]').title.endsWith('(⌃⌘C)')`, 'the rail tooltip follows the new key at once')
    // The launcher's key works in every app: ⌥E would type a character everywhere, ⌥Space is fine (with a note about
    // Raycast), and the old key is let go while recording.
    const pausesBefore = launcherDone.filter((d) => d[0] === 'launcher:pause').length
    await bjs(`document.querySelector('[aria-label="Shortcut for the launcher"]').click()`)
    await press('e', 'KeyE', { altKey: true })
    await buntil(`document.querySelector('[data-shortcut-row="launcher"]').closest('.set-row').querySelector('.set-key-error')?.textContent.includes('types a character')`, '⌥E is refused')
    await press(' ', 'Space', { altKey: true })
    await buntil(`document.querySelector('[aria-label="Shortcut for the launcher"]').textContent === '⌥Space'`, 'launcher key recorded')
    assert.equal(settings.launcherKey, 'alt+space')
    await buntil(`document.querySelector('button[aria-label="Launcher"]').title.includes('(⌥Space, from any app)')`, 'the launcher tooltip follows its key')
    // The rail keeps Settings on screen in a 900-point-tall window.
    assert.ok(await bjs(`(() => { const rail = document.querySelector('.app-rail'); return rail.scrollHeight <= rail.clientHeight })()`), 'the rail fits')
    assert.match(await bjs(`document.querySelector('[data-shortcut-row="launcher"]').closest('.set-row').querySelector('.set-key-note').textContent`), /Raycast/)
    for (let n = 0; n < 60 && launcherDone.filter((d) => d[0] === 'launcher:pause').length < pausesBefore + 2; n++) await new Promise((r) => setTimeout(r, 30))
    assert.deepEqual(launcherDone.filter((d) => d[0] === 'launcher:pause').slice(pausesBefore).map((d) => d[1]), [true, false], 'the key is let go while recording')
    // Settings → Windows: Accessibility asked for, Rectangle's keys in one click (one held by another app is named), a
    // ninth's key recorded (a clash refused first), and a hotkey for Slack.
    wmAccess = false
    await bjs(`document.querySelector('.settings-nav-item[data-section="windows"]').click()`)
    await buntil(`document.querySelector('.settings-body')?.textContent.includes('Not allowed yet')`, 'windows section, Accessibility not on')
    await bjs(`[...document.querySelectorAll('.settings-body button')].find((b) => b.textContent === 'Allow…').click()`)
    await buntil(`document.querySelector('.settings-body').textContent.includes('Allowed: the keys')`, 'allowed')
    await bjs(`[...document.querySelectorAll('.settings-body button')].find((b) => b.textContent === 'Use suggested keys').click()`)
    await buntil(`document.querySelector('[aria-label="Key for Left Half"]')?.textContent === '⌃⌥←'`, 'suggested keys')
    assert.equal(settings.windowKeys['next-display'], 'ctrl+alt+cmd+right')
    await bjs(`document.querySelector('[data-layout-group="Size"] .set-group-toggle').click()`)
    await buntil(`document.querySelector('[data-shortcut-row="window:maximize"]')?.closest('.set-row').querySelector('.set-key-error')?.textContent.includes('another app')`, 'a key macOS kept for another app is named')
    await bjs(`document.querySelector('[data-layout-group="Ninths"] .set-group-toggle').click()`)
    await bjs(`document.querySelector('[aria-label="Key for Middle Center Ninth"]').click()`)
    await buntil(`document.querySelector('[aria-label="Key for Middle Center Ninth"]').classList.contains('recording')`, 'recording a ninth')
    await press('ArrowLeft', 'ArrowLeft', { ctrlKey: true, altKey: true })
    await buntil(`document.querySelector('[data-shortcut-row="window:middle-center-ninth"]').closest('.set-row').querySelector('.set-key-error')?.textContent.includes('Left Half')`, 'a key in use is refused')
    await press('5', 'Digit5', { ctrlKey: true, altKey: true })
    await buntil(`document.querySelector('[aria-label="Key for Middle Center Ninth"]').textContent === '⌃⌥5'`, 'the ninth has its key')
    assert.equal(settings.windowKeys['middle-center-ninth'], 'ctrl+alt+5')
    await bjs(`[...document.querySelectorAll('.settings-body button')].find((b) => b.textContent.includes('Add an app')).click()`)
    await buntil(`!!document.querySelector('[aria-label="Find an app"]')`, 'the app picker')
    await bjs(`(() => { const i = document.querySelector('[aria-label="Find an app"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'sla'); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await buntil(`[...document.querySelectorAll('.set-app-list button')].some((b) => b.textContent.startsWith('Slack'))`, 'Slack found')
    await bjs(`document.querySelector('[aria-label="Find an app"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`)
    await buntil(`document.querySelector('[aria-label="Key for Slack"]')?.classList.contains('recording')`, 'its key is recorded at once')
    await press('S', 'KeyS', { ctrlKey: true, altKey: true, shiftKey: true })
    await buntil(`document.querySelector('[aria-label="Key for Slack"]').textContent === '⌃⌥⇧S'`, 'the app hotkey')
    assert.deepEqual(settings.appHotkeys.map((h) => [h.name, h.path, h.combo]), [['Slack', '/Applications/Slack.app', 'ctrl+alt+shift+s']])
    await bshot('settings-windows.png')
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
    // The Links search panel's ⌘↵: Links, with the item selected in its folder.
    const shownLink = Object.values(recordDocs.links.items).find((l) => l.type === 'link' && l.folderId)
    bwin.webContents.send('app:command', { kind: 'links', id: shownLink.id })
    await buntil(`document.querySelector('button[aria-label="Links"]').classList.contains('on') && !!document.querySelector('.link-row.selected[data-link="${shownLink.id}"]')`, 'links shows the item')
    bwin.webContents.send('app:command', { kind: 'section', section: 'hosts' })
    await buntil(`document.querySelector('button[aria-label="Hosts"]').classList.contains('on')`, 'back to hosts')
    // A tool in a window of its own: Open in New Window closes its tab here, its rail button then hands the call to
    // that window, and Put Back shows it here again.
    const railMenu = async (label, item) => {
      await bjs(`document.querySelector('button[aria-label="${label}"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`)
      await buntil(`[...document.querySelectorAll('.popover .menu-item')].some((b) => b.textContent === ${JSON.stringify(item)})`, `${label}: ${item}`)
      await bjs(`[...document.querySelectorAll('.popover .menu-item')].find((b) => b.textContent === ${JSON.stringify(item)}).click()`)
    }
    await bjs(`document.querySelector('button[aria-label="Links"]').click()`)
    await buntil(`!!document.querySelector('section.plan.links')`, 'links open before detaching')
    await railMenu('Links', 'Open in New Window')
    await buntil(`document.querySelector('button[aria-label="Links"]').classList.contains('rail-out') && !document.querySelector('section.plan.links')`, 'links is out and its tab closed')
    assert.ok(calls.some((c) => c.channel === 'tools:detach' && c.args[0] === 'links'))
    const relays = calls.filter((c) => c.channel === 'tools:relay').length
    await bjs(`document.querySelector('button[aria-label="Links"]').click()`)
    for (let n = 0; n < 60 && calls.filter((c) => c.channel === 'tools:relay').length === relays; n++) await new Promise((r) => setTimeout(r, 30))
    assert.deepEqual(calls.filter((c) => c.channel === 'tools:relay').at(-1)?.args.slice(0, 2), ['links', 'openTool'], 'the rail button goes to the window')
    assert.equal(await bjs(`!!document.querySelector('section.plan.links')`), false, 'no second Links here')
    await railMenu('Links', 'Put Back in This Window')
    await buntil(`!document.querySelector('button[aria-label="Links"]').classList.contains('rail-out') && !!document.querySelector('section.plan.links')`, 'links back in the main window')
    // The tool's own window: the tool under a slim bar, carrying out what the main window hands it.
    const owin = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { preload: join(__dirname, 'ui-preload.cjs'), contextIsolation: true, backgroundThrottling: false } })
    owin.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message) })
    const ojs = (code) => owin.webContents.executeJavaScript(code)
    const ountil = async (code, what = code) => {
      for (let n = 0; n < 200; n++) { if (await ojs(code)) return; await new Promise((r) => setTimeout(r, 30)) }
      throw new Error(`Timed out (tool window): ${what}`)
    }
    await owin.loadFile(resolve('out/renderer/index.html'), { query: { tool: 'links' } })
    await ountil(`document.querySelector('.tool-window-grip')?.textContent === 'Links' && !!document.querySelector('.tool-window-body section.plan.links')`, 'links in its own window')
    assert.equal(await ojs(`document.title`), 'Links')
    owin.webContents.send('tools:relay', { method: 'showInLinks', args: [{ id: shownLink.id }] })
    await ountil(`!!document.querySelector('.link-row.selected[data-link="${shownLink.id}"]')`, 'the hand-off selects the link')
    writeFileSync(join(output, 'tool-window-links.png'), (await owin.webContents.capturePage()).toPNG())
    const attaches = calls.filter((c) => c.channel === 'tools:attach').length
    await ojs(`document.querySelector('.tool-window-attach').click()`)
    for (let n = 0; n < 60 && calls.filter((c) => c.channel === 'tools:attach').length === attaches; n++) await new Promise((r) => setTimeout(r, 30))
    assert.deepEqual(calls.filter((c) => c.channel === 'tools:attach').at(-1)?.args, ['links'], 'Put back')
    owin.destroy()
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
    const lwin = new BrowserWindow({ show: false, width: 780, height: 505, frame: false, transparent: true, webPreferences: { preload: join(__dirname, 'ui-preload.cjs'), contextIsolation: true, backgroundThrottling: false } })
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
    // Accessibility is off in the launcher's run until its Allow (Settings turned it on above).
    wmAccess = false
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
    await luntil(`[...document.querySelectorAll('[role="group"] .launcher-title')].some((t) => t.textContent === 'Sleep')`, 'mac commands')
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
    await luntil(`document.querySelector('.launcher-item.on .launcher-type')?.textContent === 'File' && !document.querySelector('.launcher-detail')`, 'a file, labelled as one, in one column as in Raycast')
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
    // Quicklinks: Create Quicklink… opens a form; then "aws" ↩ opens the page in the Browser's first space, and
    // "jira PLM-42" fills the address's {query}.
    await ltype('create quicklink')
    await luntil(`${picked} === 'Create Quicklink…'`, 'the create command')
    await lkey('Enter')
    await luntil(`!!document.querySelector('.launcher-form')`, 'the quicklink form')
    const lset = (label, v) => ljs(`(() => { const i = [...document.querySelectorAll('.launcher-form-row')].find((r) => r.querySelector('span').textContent === ${JSON.stringify(label)}).querySelector('input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(v)}); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await lset('Name', 'AWS sign-in')
    await lset('Keyword', 'jira')
    await lset('Address', 'mainspring.awsapps.com/start')
    await ljs(`[...document.querySelectorAll('.launcher-form-buttons button')].find((b) => b.textContent.startsWith('Save')).click()`)
    await luntil(`document.querySelector('.launcher-form-error')?.textContent.includes('already')`, 'a keyword in use is refused')
    await lset('Keyword', 'aws')
    await ljs(`[...document.querySelectorAll('.launcher-form-buttons button')].find((b) => b.textContent.startsWith('Save')).click()`)
    await luntil(`!document.querySelector('.launcher-form')`, 'saved')
    assert.deepEqual(settings.quicklinks.find((l) => l.keyword === 'aws') && [settings.quicklinks.find((l) => l.keyword === 'aws').url, settings.quicklinks.find((l) => l.keyword === 'aws').space], ['https://mainspring.awsapps.com/start', 'general'])
    await ltype('aws')
    await luntil(`document.querySelector('.launcher-group')?.textContent === 'Quicklink' && ${picked} === 'AWS sign-in'`, 'the keyword comes first')
    await lshot('launcher-quicklink.png')
    await lkey('Enter')
    await done('aws ↩ opens it in the Browser', (d) => d[0] === 'launcher:command' && d[1].kind === 'browse' && d[1].url === 'https://mainspring.awsapps.com/start' && d[1].space === 'general')
    await ltype('jira PLM-42')
    await luntil(`${picked} === 'Jira issue: PLM-42'`, 'a keyword with words after it')
    await lkey('Enter')
    await done('the words fill {query}', (d) => d[0] === 'launcher:command' && d[1].kind === 'browse' && d[1].url === 'https://example.atlassian.net/browse/PLM-42')
    await lkey('Escape')
    await luntil(`document.querySelector('.launcher-search input').value === ''`, 'Esc clears the field')
    const hides = launcherDone.filter((d) => d[0] === 'launcher:hide').length
    await lkey('Escape')
    await done('Esc on an empty field puts it away', () => launcherDone.filter((d) => d[0] === 'launcher:hide').length > hides)
    // Opened since: Visual Studio Code is a recent item now.
    lwin.webContents.send('launcher:shown', { at: Date.now() })
    await luntil(`[...document.querySelectorAll('[role="group"][aria-label="Suggestions"] .launcher-title')].some((t) => t.textContent === 'Visual Studio Code')`, 'recent items')
    // Raycast's commands: a window layout (Accessibility asked for first), the emoji grid typed into the app in front,
    // Kill Process, My IP, Speed Test, Downloads, Capture to today's note and Quit All Apps.
    const commandRow = (title) => `[...document.querySelectorAll('[role="group"][aria-label="Commands"] .launcher-item')].find((r) => r.querySelector('.launcher-title').textContent === ${JSON.stringify(title)})`
    await ltype('left half')
    await luntil(`${picked} === 'Left Half' && document.querySelector('.launcher-bar').textContent.includes('Allow Window Control')`, 'a window layout, asking for Accessibility first')
    await lkey('Enter')
    await done('Allow asks macOS', (d) => d[0] === 'wm:askAccess')
    await luntil(`document.querySelector('.launcher-bar').textContent.includes('Move the Window')`, 'then it moves windows')
    await lshot('launcher-window.png')
    await lkey('Enter')
    await done('↩ moves the window in front', (d) => d[0] === 'wm:layout' && d[1] === 'left-half')
    await ltype('ninth')
    await luntil(`[...document.querySelectorAll('[role="group"][aria-label="Window Management"] .launcher-title')].some((t) => t.textContent === 'Middle Center Ninth')`, 'ninths for a large screen')
    await ltype('emoji')
    await luntil(`${picked} === 'Search Emoji'`, 'the emoji command')
    await lkey('Enter')
    await luntil(`document.querySelector('.launcher-command > span:last-child')?.textContent === 'Search Emoji' && !!document.querySelector('.launcher-back') && document.querySelectorAll('.launcher-cell').length > 100`, 'the emoji grid')
    await ltype('rocket')
    await luntil(`document.querySelector('.launcher-cell.on')?.getAttribute('aria-label') === 'Rocket' && document.querySelector('.launcher-cell.on').textContent === '🚀'`, 'an emoji by name')
    await lshot('launcher-emoji.png')
    await lkey('Enter')
    await done('↩ types it into the app in front', (d) => d[0] === 'launcher:paste' && d[1] === '🚀')
    await ltype('')
    await lkey('Backspace')
    await luntil(`!document.querySelector('.launcher-back')`, '⌫ on an empty field goes back to search')
    await ltype('kill process')
    await luntil(`${picked} === 'Kill Process'`, 'kill process')
    await lkey('Enter')
    await luntil(`${picked} === 'Runaway' && document.querySelector('.launcher-command > span:last-child')?.textContent === 'Kill Process'`, 'the busiest process first')
    await lshot('launcher-kill.png')
    await lkey('Enter')
    await done('↩ asks it to quit', (d) => d[0] === 'launcher:kill' && d[1] === 4242 && d[2] === false)
    await luntil(`document.querySelector('.launcher-notice')?.textContent.includes('Runaway')`, 'and says so')
    await ltype('slack')
    await luntil(`${picked} === 'Slack'`, 'filtered by name')
    await lkey('Enter', { metaKey: true })
    await done('⌘↩ force quits', (d) => d[0] === 'launcher:kill' && d[1] === 501 && d[2] === true)
    await lkey('Escape')
    await lkey('Escape')
    await luntil(`!document.querySelector('.launcher-back') && document.querySelector('.launcher-search input').value === ''`, 'Esc clears, then goes back')
    await ltype('my ip')
    await luntil(`${picked} === 'My IP Address'`, 'my ip')
    await lkey('Enter')
    await luntil(`${picked} === '203.0.113.7'`, 'the public address first')
    await lkey('Enter')
    for (let n = 0; n < 60 && !calls.some((c) => c.channel === 'clipboard:write' && c.args[0] === '203.0.113.7'); n++) await new Promise((r) => setTimeout(r, 30))
    assert.ok(calls.some((c) => c.channel === 'clipboard:write' && c.args[0] === '203.0.113.7'), '↩ copies the address')
    await lkey('Escape')
    await ltype('speed test')
    await luntil(`${picked} === 'Speed Test'`, 'speed test')
    await lkey('Enter')
    await luntil(`document.querySelector('.sp-status')?.textContent === 'Finished' && document.querySelector('.sp-gauge.down svg').getAttribute('aria-label') === 'Download: 412.35 Mbps' && document.querySelector('.sp-side').textContent.includes('Frontier Communications')`, 'the gauges, as in Raycast')
    assert.equal(await ljs(`document.querySelectorAll('.sp-chip.ok').length`), 10, 'fast enough for every call and stream')
    await lshot('launcher-speed.png')
    await lkey('Enter')
    await luntil(`${picked} === '412 Mbps' && [...document.querySelectorAll('.launcher-title')].some((t) => t.textContent === '1234 RPM · High')`, '↩ shows the detailed list')
    await lkey('Escape')
    await ltype('downloads')
    await luntil(`${picked} === 'Downloads'`, 'the downloads command, first')
    await lkey('Enter')
    await luntil(`${picked} === 'invoice-october.pdf' && [...document.querySelectorAll('.launcher-group')].map((g) => g.textContent).join() === 'Today,This Week'`, 'downloads, newest first, by when they came')
    await lkey('C', { metaKey: true, shiftKey: true, code: 'KeyC' })
    for (let n = 0; n < 60 && !calls.some((c) => c.channel === 'finder:copy' && c.args[0][0] === '/Users/fixture/Downloads/invoice-october.pdf'); n++) await new Promise((r) => setTimeout(r, 30))
    assert.ok(calls.some((c) => c.channel === 'finder:copy' && c.args[0][0] === '/Users/fixture/Downloads/invoice-october.pdf'), '⇧⌘C copies the file')
    await lkey('Escape')
    await ltype('capture')
    await luntil(`!!${commandRow('Capture to Today’s Note')}`, 'the capture command')
    await ljs(`${commandRow('Capture to Today’s Note')}.click()`)
    await luntil(`document.querySelector('.launcher-command > span:last-child')?.textContent === 'Capture to Today’s Note'`, 'capture mode')
    await ltype('call Sam about the release')
    await luntil(`${picked} === 'Add “call Sam about the release”'`, 'what will be added')
    await lkey('Enter')
    await done('↩ adds it to today’s note', (d) => d[0] === 'notes:capture' && d[1] === 'call Sam about the release' && d[2] === false)
    await luntil(`document.querySelector('.launcher-notice')?.textContent.includes('Added to 2026-10-23.md') && document.querySelector('.launcher-search input').value === ''`, 'added, ready for the next one')
    await lkey('Escape')
    await ltype('quit all')
    await luntil(`${picked} === 'Quit All Apps…'`, 'quit all apps')
    await lkey('Enter')
    await done('main asks first, then quits them', (d) => d[0] === 'launcher:quitAll')
    // Plain language: "ssh to web prod 1", a dictated address, a reminder, and the same said with the dictation key.
    await ltype('ssh to web prod 1')
    await luntil(`document.querySelector('.launcher-group')?.textContent === 'Do This' && ${picked} === 'SSH to web-prod-01'`, 'a sentence read as a command')
    await lshot('launcher-intent.png')
    await lkey('Enter')
    await done('↩ connects over SSH', (d) => d[0] === 'launcher:command' && d[1].kind === 'connect' && d[1].key === running.key && d[1].via === 'ssh')
    await ltype('open mainspring energy dot com')
    await luntil(`${picked} === 'Open mainspringenergy.com'`, 'a dictated address')
    await lkey('Enter')
    await done('↩ opens it in the Browser', (d) => d[0] === 'launcher:command' && d[1].kind === 'browse' && d[1].url === 'https://mainspringenergy.com')
    await ltype('remind me to renew the cert monday 3pm')
    await luntil(`${picked} === 'Add Task: “renew the cert monday 3pm”'`, 'a reminder')
    await lkey('Enter')
    await luntil(`document.querySelector('.launcher-notice')?.textContent.includes('Task added: renew the cert')`, 'added to Tasks')
    assert.ok(Object.values(recordDocs.tasks.items).some((t) => t.type === 'task' && t.title === 'renew the cert' && t.time === '15:00'), 'a task with its day and time')
    const lalt = (type) => ljs(`document.activeElement.dispatchEvent(new KeyboardEvent('${type}', { key: 'Alt', code: 'AltRight', altKey: ${type === 'keydown'}, bubbles: true, cancelable: true }))`)
    await ltype('')
    await ljs(`document.querySelector('.launcher-search input').focus()`)
    await lalt('keydown')
    await luntil(`document.querySelector('.launcher-search input').placeholder.startsWith('Listening') || document.querySelector('.launcher-search input').value.length > 0`, 'holding the key, the launcher listens')
    await new Promise((r) => setTimeout(r, 320))
    await lalt('keyup')
    await luntil(`${picked} === 'Connect to web-prod-01' && document.querySelector('.launcher-search input').value.toLowerCase() === 'connect to web prod one'`, 'what was said becomes the command')
    await lshot('launcher-dictated.png')
    lwin.destroy()
    launcherNotes = false

    // The Links panels (the save and search keys, from any app): the page in front saved with a comment, a new tag
    // and a star; saved again it is updated, not added twice; a browser that cannot be asked says so; the search
    // narrows to a tag with ⌘1 and opens a link in the app's Browser.
    const pwin = new BrowserWindow({ show: false, width: 640, height: 520, frame: false, transparent: true, webPreferences: { preload: join(__dirname, 'ui-preload.cjs'), contextIsolation: true, backgroundThrottling: false } })
    pwin.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message) })
    const kjs = (code) => pwin.webContents.executeJavaScript(code)
    const kuntil = async (code, what = code) => {
      for (let n = 0; n < 200; n++) { if (await kjs(code)) return; await new Promise((r) => setTimeout(r, 30)) }
      throw new Error(`Timed out (links panel): ${what}`)
    }
    const kshot = async (name) => { await kjs('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await new Promise((r) => setTimeout(r, 150)); writeFileSync(join(output, name), (await pwin.webContents.capturePage()).toPNG()) }
    const ktype = (sel, v) => kjs(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); i.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(v)}); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    const kkey = (sel, k, mods = {}) => kjs(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, code: ${JSON.stringify(/^[1-9]$/.test(k) ? `Digit${k}` : '')}, bubbles: true, cancelable: true, ...${JSON.stringify(mods)} }))`)
    const kdone = async (what, test) => {
      for (let n = 0; n < 100 && !panelDone.some(test); n++) await new Promise((r) => setTimeout(r, 30))
      assert.ok(panelDone.some(test), what)
    }
    await pwin.loadFile(resolve('out/renderer/index.html'), { query: { links: '1' } })
    panelPage = { url: 'https://www.speedtest.net/result/19821881827', title: 'Speedtest by Ookla - The Global Broadband Speed Test', app: 'Safari' }
    pwin.webContents.send('linksPanel:shown', { mode: 'save', at: Date.now() })
    await kuntil(`document.querySelector('[aria-label="Title"]')?.value === 'Speedtest by Ookla - The Global Broadband Speed Test'`, 'the page in front fills the form')
    await kuntil(`document.querySelector('.lp-status').textContent === 'From Safari'`, 'where it came from')
    await kdone('the window fits the card', (d) => d[0] === 'linksPanel:resize' && d[1] > 150 && d[1] < 400)
    await ktype('[aria-label="Comment"]', 'Home internet speed')
    await kjs(`[...document.querySelectorAll('.lp-btn')].find((b) => b.textContent.startsWith('Tags')).click()`)
    await kuntil(`document.activeElement?.getAttribute('aria-label') === 'Add a tag'`, 'the tag field takes the keyboard')
    await ktype('[aria-label="Add a tag"]', 'Home/Network')
    await kuntil(`document.querySelector('.lp-option.on')?.textContent.includes('Home/Network')`, 'a new tag is offered')
    await kkey('[aria-label="Add a tag"]', 'Enter')
    await kuntil(`[...document.querySelectorAll('.lp-tag-field .lp-chip')].map((c) => c.textContent).join() === '#Home/Network'`, 'the tag is added')
    await kjs(`document.querySelector('.lp-star').click()`)
    await kshot('links-panel-save.png')
    await kkey('[aria-label="Add a tag"]', 'Escape')
    await kuntil(`!document.querySelector('.lp-tag-field') && document.querySelector('.lp-chips')?.textContent === '#Home/Network'`, 'Esc closes the tag field, not the panel')
    const hidesBefore = panelDone.filter((d) => d[0] === 'linksPanel:hide').length
    await kkey('[aria-label="Title"]', 'Enter')
    await kuntil(`document.querySelector('.lp-status').textContent === 'Saved to Links'`, 'saved')
    const savedLink = () => Object.values(recordDocs.links?.items ?? {}).filter((l) => l.url === 'https://www.speedtest.net/result/19821881827')
    assert.equal(savedLink().length, 1)
    assert.deepEqual([savedLink()[0].note, savedLink()[0].tags, savedLink()[0].starred], ['Home internet speed', ['Home/Network'], true])
    // Saved before the site answered: its description follows.
    for (let n = 0; n < 100 && !savedLink()[0].description; n++) await new Promise((r) => setTimeout(r, 30))
    assert.equal(savedLink()[0].description, 'A page about fixtures.')
    await kdone('then it goes away', () => panelDone.filter((d) => d[0] === 'linksPanel:hide').length > hidesBefore)
    // The same page again: what it was saved with, and Update.
    panelPage = { url: 'https://speedtest.net/result/19821881827/', title: 'Speedtest', app: 'Chrome' }
    pwin.webContents.send('linksPanel:shown', { mode: 'save', at: Date.now() })
    await kuntil(`document.querySelector('.lp-status').textContent.startsWith('In Links since') && document.querySelector('.lp-btn.primary').textContent === 'Update'`, 'a saved page is recognised')
    assert.equal(await kjs(`document.querySelector('[aria-label="Comment"]').value`), 'Home internet speed')
    await kkey('[aria-label="Title"]', 'Enter', { metaKey: true })
    await kuntil(`document.querySelector('.lp-status').textContent === 'Updated in Links'`, 'updated')
    assert.equal(savedLink().length + Object.values(recordDocs.links.items).filter((l) => l.url === 'https://speedtest.net/result/19821881827/').length, 1, 'not added twice')
    // A browser that cannot say what it shows.
    panelPage = { url: '', title: '', app: 'Zen', problem: 'no-script' }
    pwin.webContents.send('linksPanel:shown', { mode: 'save', at: Date.now() })
    await kuntil(`document.querySelector('.lp-status').textContent.startsWith('Zen cannot tell other apps its page') && document.activeElement?.getAttribute('aria-label') === 'Address'`, 'Zen: paste the address')
    // Search: a tag first, ⌘1 narrows to it, ↵ opens the link in the app's Browser.
    pwin.webContents.send('linksPanel:shown', { mode: 'find', at: Date.now() })
    await kuntil(`document.activeElement?.getAttribute('aria-label') === 'Search Links'`, 'the search field takes the keyboard')
    await ktype('[aria-label="Search Links"]', 'network')
    await kuntil(`document.querySelector('.lp-row .lp-row-title')?.textContent === 'Network' && document.querySelector('.lp-row .lp-row-sub').textContent.startsWith('Tag · 1 item')`, 'the tag comes first')
    await kshot('links-panel-find.png')
    await kkey('[aria-label="Search Links"]', '1', { metaKey: true })
    await kuntil(`document.querySelector('.lp-scope')?.textContent === '#Home/Network' && document.querySelector('[aria-label="Search Links"]').value === ''`, '⌘1 narrows the search to the tag')
    await kuntil(`document.querySelector('.lp-row.on .lp-row-title')?.textContent.startsWith('Speedtest')`, 'its link')
    await kkey('[aria-label="Search Links"]', 'Enter')
    await kdone('↵ opens it in the Browser', (d) => d[0] === 'linksPanel:command' && d[1].kind === 'browse' && d[1].url === 'https://www.speedtest.net/result/19821881827')
    assert.ok(savedLink()[0].openedAt, 'opening counts as a use')
    await kkey('[aria-label="Search Links"]', 'Enter', { metaKey: true })
    await kdone('⌘↵ shows it in Links', (d) => d[0] === 'linksPanel:command' && d[1].kind === 'links' && d[1].id === savedLink()[0].id)
    await kkey('[aria-label="Search Links"]', 'Backspace')
    await kuntil(`!document.querySelector('.lp-scope')`, '⌫ on an empty field searches everything again')
    pwin.destroy()

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
    // Go to Folder (a click on the title, or ⇧⌘G): any path, hidden folders included, with the folders under what is typed.
    const gotoSet = (v) => tjs(`(() => { const i = document.querySelector('.fi-goto input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(v)}); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    const gotoKey = (k) => tjs(`document.querySelector('.fi-goto input').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }))`)
    await tjs(`document.querySelector('.fi-title button').click()`)
    await tuntil(`document.querySelector('.fi-goto input')?.value === '~/'`, 'go to folder opens on the home folder from Recents')
    await gotoSet('~/.a')
    await tuntil(`[...document.querySelectorAll('.fi-goto-hints li')].map((l) => l.textContent).join('|') === '.aws'`, 'a dot offers the hidden folders')
    await tshot('finder-goto.png')
    await gotoKey('Tab')
    await tuntil(`document.querySelector('.fi-goto input')?.value === '~/.aws/'`, 'Tab completes')
    await gotoKey('Enter')
    await tuntil(`document.querySelector('.fi-title')?.textContent === '.aws' && [...document.querySelectorAll('.fi-row')].map((r) => r.querySelector('.name, .fi-name')?.textContent ?? r.textContent).join('|').includes('config')`, 'Enter goes into the hidden folder')
    await tkey('g', { metaKey: true, shiftKey: true })
    await tuntil(`document.querySelector('.fi-goto input')?.value === '~/.aws/'`, '⇧⌘G opens it on this folder')
    await gotoSet('/nowhere')
    await gotoKey('Enter')
    await tuntil(`document.querySelector('.fi-goto-error')?.textContent === 'There is no folder at /nowhere.'`, 'a path that is not there says so')
    await gotoSet('~/.zshrc')
    await gotoKey('Enter')
    await tuntil(`document.querySelector('.fi-title')?.textContent === 'fixture' && document.querySelector('.fi-row.on')?.textContent.includes('.zshrc')`, 'a file opens its folder with the file selected, hidden or not')
    await tjs(`document.querySelector('.fi-title button').click()`)
    await gotoSet('Documents/Surendra-Personal')
    await gotoKey('Enter')
    await tuntil(`document.querySelector('.fi-title')?.textContent === 'Surendra-Personal'`, 'a path without / is inside the current folder')
    await tjs(`document.querySelector('.fi-title button').click()`)
    await tuntil(`!!document.querySelector('.fi-goto input')`)
    await gotoKey('Escape')
    await tuntil(`!document.querySelector('.fi-goto') && !!document.querySelector('.fi-title button')`, 'Esc puts the title back')
    await tkey('.', { metaKey: true, shiftKey: true })

    // Storage: a scan of the Mac and the Overview, the Space Map's cards and inspector, going in and out of folders, Large
    // Files to the Trash and Put Back, Hidden Files ticking only caches, Search, the Clean up rooms, the Apps rooms, the
    // Monitor, Optimize from the Overview's ring, the Report and Recently Removed.
    const stNav = (label) => tjs(`[...document.querySelectorAll('.storage .st-nav-item')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click()`)
    const stCard = (name) => `[...document.querySelectorAll('.st-card')].find((c) => c.querySelector('.st-card-text b')?.textContent === ${JSON.stringify(name)})`
    const stButton = (text) => `[...document.querySelectorAll('.st-room button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)}))`
    await tjs(`document.querySelector('button[aria-label="Storage"]').click()`)
    await tuntil(`document.querySelector('.st-disk-free')?.textContent.includes('452 GB')`, 'storage opens with the disk')
    assert.equal(await tjs(`document.querySelector('.sidebar')?.getClientRects().length ?? 0`), 0, 'the hosts sidebar steps aside for Storage')
    assert.equal(await tjs(`[...document.querySelectorAll('.st-nav-group h4')].map((h) => h.textContent).join()`), 'Clean up,Tools,Insights', 'the rooms are grouped as in Strata')
    await stNav('Overview')
    await tjs(`document.querySelector('.st-ring').click()`)
    await tuntil(`document.querySelectorAll('.st-legend-item').length >= 8 && document.querySelector('.st-ring-col h2')?.textContent.includes('is mapped')`, 'a scan maps the Mac')
    assert.ok(await tjs(`document.querySelector('.st-banner.info')?.textContent.includes('Full Disk Access') ?? false`), 'asks for Full Disk Access')
    await tuntil(`document.querySelectorAll('.st-stat').length === 4 && document.querySelectorAll('.st-rec').length === 6 && document.querySelectorAll('.st-kinds-legend > div').length >= 5`, 'figures, recommendations and kinds')
    await tuntil(`document.querySelector('.st-macinfo')?.textContent.includes('Apple M3 Max')`, 'this Mac in words')
    await tshot('storage-overview.png')
    await stNav('Space Map')
    await tuntil(`document.querySelectorAll('.st-card').length >= 5 && !!${stCard('Users')} && !!document.querySelector('.st-inspector')`, 'the space map draws the Mac with its inspector')
    await tjs(`${stCard('Users')}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
    await tuntil(`document.querySelector('.st-crumbs b')?.textContent === 'Users'`, 'double-click goes into a folder')
    await tjs(`${stCard('fixture')}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
    await tuntil(`document.querySelector('.st-crumbs b')?.textContent === 'fixture' && !!${stCard('Library')} && document.querySelectorAll('.st-tile').length > 0`, 'into the home folder, with what is inside each card')
    await tjs(`${stCard('Movies')}.click()`)
    await tuntil(`document.querySelector('.st-insp-head b')?.textContent === 'Movies'`, 'a click shows it in the inspector')
    await tshot('storage-map.png')
    await tkey('Backspace')
    await tuntil(`document.querySelector('.st-crumbs b')?.textContent === 'Users'`, '⌫ goes up')
    await tjs(`document.querySelector('.st-top button[aria-label="List"]').click()`)
    await tuntil(`document.querySelectorAll('.st-list .st-row').length >= 2`, 'the list view')
    await tjs(`document.querySelector('.st-top button[aria-label="Cards"]').click()`)
    await stNav('Large Files')
    await tuntil(`document.querySelectorAll('.st-list .st-row').length === 4`, 'large files listed, biggest first')
    assert.equal(await tjs(`document.querySelectorAll('.st-list .st-row .st-check:checked').length`), 0, 'none of your files starts ticked')
    await tjs(`document.querySelector('.st-list .st-row .st-check').click()`)
    await tuntil(`document.querySelector('.st-footer-text')?.textContent.includes('1 selected · 9 GB')`, 'the footer sums what is ticked')
    await tshot('storage-large.png')
    await tjs(`document.querySelector('.st-footer .st-primary').click()`)
    await tuntil(`document.querySelector('.plan-undo')?.textContent.includes('Put Back') && document.querySelectorAll('.st-list .st-row').length === 3`, 'moved to the Trash, with Put Back offered')
    assert.equal(calls.filter((c) => c.channel === 'storage:trash').at(-1).args[1], 'Large Files')
    await tjs(`[...document.querySelectorAll('.plan-undo button')].find((b) => b.textContent === 'Put Back').click()`)
    for (let n = 0; n < 40 && !stPutBacks.length; n++) await new Promise((r) => setTimeout(r, 30))
    assert.equal(stPutBacks.length, 1, 'Put Back asks main')
    await stNav('Hidden Files')
    await tuntil(`document.querySelectorAll('.st-list .st-row').length === 3`, 'hidden items listed')
    assert.equal(await tjs(`document.querySelectorAll('.st-list .st-row .st-check:checked').length`), 2, 'only the caches start ticked')
    await stNav('Search')
    await tuntil(`document.querySelectorAll('.st-quick-tile').length === 6`, 'search offers kinds of file')
    await tshot('storage-search-empty.png')
    await tjs(`(() => { const i = document.querySelector('.st-searchbox.big input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'ubuntu'); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await tuntil(`[...document.querySelectorAll('.st-list .st-row')].some((r) => r.textContent.includes('ubuntu-24.04.iso'))`, 'search finds by name')
    await stNav('Junk Files')
    await tuntil(`document.querySelectorAll('.st-group').length === 2`, 'junk files measured into groups')
    assert.equal(await tjs(`document.querySelectorAll('.st-list .st-row .st-check:checked').length`), 2, 'only what is safe starts ticked')
    await tshot('storage-junk.png')
    await stNav('AI Data Sweeper')
    await tuntil(`!!document.querySelector('.st-ai-sum') && !!${stButton('View Details')}`, 'the AI summary and its cards')
    await tjs(`${stButton('View Details')}.click()`)
    await tuntil(`!!${stButton('Copy the command')}`, 'an Ollama model offers its command')
    assert.equal(await tjs(`document.querySelectorAll('.st-ai-items .st-check').length`), 0, 'only Ollama removes its models')
    await tjs(`${stButton('Copy the command')}.click()`)
    for (let n = 0; n < 40 && !calls.some((c) => c.channel === 'clipboard:write' && c.args[0] === 'ollama rm llama3.2:latest'); n++) await new Promise((r) => setTimeout(r, 30))
    assert.ok(calls.some((c) => c.channel === 'clipboard:write' && c.args[0] === 'ollama rm llama3.2:latest'), 'the command is copied')
    await tshot('storage-ai.png')
    await stNav('System Data')
    await tuntil(`document.querySelectorAll('.st-syscard').length >= 3`, 'system data as cards')
    await tshot('storage-system.png')
    await stNav('Duplicates')
    await tjs(`${stButton('Find Duplicates')}.click()`)
    await tuntil(`document.querySelectorAll('.st-group .st-row').length === 2`, 'duplicates found')
    assert.equal(await tjs(`[...document.querySelectorAll('.st-group .st-row')].map((r) => r.querySelector('.st-check').checked).join()`), 'false,true', 'the oldest copy stays')
    await stNav('Unused Apps')
    await tuntil(`[...document.querySelectorAll('.st-list .st-row')].some((r) => r.textContent.includes('Old Editor'))`, 'unused apps listed')
    assert.ok(await tjs(`[...document.querySelectorAll('.st-list .st-row')].find((r) => r.textContent.includes('Old Editor')).textContent.includes('Intel')`), 'Intel-only apps are marked')
    assert.ok(await tjs(`[...document.querySelectorAll('.st-list .st-row')].find((r) => r.textContent.includes('Guard VPN'))?.querySelector('.st-check') === null`), 'an app with a system extension goes through Finder')
    await tshot('storage-unused.png')
    await tjs(`[...[...document.querySelectorAll('.st-list .st-row')].find((r) => r.textContent.includes('Old Editor')).querySelectorAll('button')].find((b) => b.textContent.startsWith('Uninstall')).click()`)
    await tuntil(`document.querySelector('.st-uninstaller') && [...document.querySelectorAll('.st-un-detail .st-row')].some((r) => r.textContent.includes('com.old.editor'))`, 'Uninstall… opens the app in the Uninstaller with its files')
    assert.equal(await tjs(`document.querySelectorAll('.st-un-detail .st-check:checked').length`), 2, 'the app and what is sure start ticked')
    await tshot('storage-uninstaller.png')
    await stNav('Startup Items')
    await tuntil(`document.querySelectorAll('.st-group.flat').length === 2`, 'startup items grouped by app')
    await tjs(`[...document.querySelectorAll('.st-listbar .st-link')].find((b) => b.textContent.startsWith('Select Missing Programs')).click()`)
    await tuntil(`document.querySelector('.st-footer-text')?.textContent.includes('1 selected')`, 'the agent whose program is gone can be picked at once')
    await tshot('storage-startup.png')
    await stNav('Monitor')
    await tuntil(`document.querySelectorAll('.st-mon-card').length === 9 && document.querySelectorAll('.st-proc-row').length >= 1`, 'monitor cards')
    await new Promise((r) => setTimeout(r, 4500))
    await tshot('storage-monitor.png')
    await stNav('Overview')
    await tjs(`document.querySelectorAll('.st-ring')[1].click()`)
    await tuntil(`document.querySelectorAll('.st-opt-card .st-row').length >= 3 && document.querySelector('.st-opt-hero h2')?.textContent.includes('lighter')`, 'Optimize opens from the ring with apps and junk')
    assert.equal(await tjs(`[...document.querySelectorAll('.st-opt-card .st-row')].filter((r) => r.querySelector('.st-check')?.checked).map((r) => r.querySelector('.st-row-name').textContent).join()`), 'Daily', 'only the idle app is ticked; Mail keeps you notified')
    await tshot('storage-optimize.png')
    await tjs(`document.querySelector('.st-footer .st-primary').click()`)
    for (let n = 0; n < 60 && !stQuits.includes(501); n++) await new Promise((r) => setTimeout(r, 30))
    assert.ok(stQuits.includes(501), 'Optimize asks the idle app to quit')
    for (let n = 0; n < 60 && calls.filter((c) => c.channel === 'storage:trash').at(-1)?.args[1] !== 'Optimize'; n++) await new Promise((r) => setTimeout(r, 30))
    assert.equal(calls.filter((c) => c.channel === 'storage:trash').at(-1).args[1], 'Optimize', 'and moves the safe junk')
    await stNav('Report')
    await tuntil(`document.querySelectorAll('.st-export').length === 3 && document.querySelectorAll('.st-listcard .st-lrow').length >= 4`, 'the report: figures, exports and the largest')
    await tshot('storage-report.png')
    await tjs(`[...document.querySelectorAll('.st-tabsbar button')].find((b) => b.textContent === 'Changes Over Time').click()`)
    await tuntil(`[...document.querySelectorAll('.st-lrow')].some((r) => r.textContent.includes('Grew'))`, 'what grew since the last scan')
    await stNav('Recently Removed')
    await tuntil(`document.querySelector('.st-intro')?.textContent.includes('800 MB')`, 'recently removed shows the Trash')
    await tshot('storage-removed.png')

    // CAD: the start screen, an assembly read with OpenCascade (its parts tree: select, hide, show all), then a cube:
    // a pinned comment and a measurement clicked on the model, an issue, the checklist, Request changes asked in place,
    // Approve, the report saved to Notes with its picture, and the assembly again from the cache.
    const cadStage = async () => tjs(`(() => { const r = document.querySelector('.cad-canvas').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
    const cadClick = async (x, y) => {
      twin.webContents.focus()
      twin.webContents.sendInputEvent({ type: 'mouseMove', x, y })
      twin.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      twin.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    }
    // Reading STEP compiles OpenCascade's WebAssembly first: a longer wait, and what the tab shows if it never opens.
    const cadUntil = async (code, what) => {
      for (let n = 0; n < 600; n++) { if (await tjs(code)) return; await new Promise((r) => setTimeout(r, 50)) }
      console.error('[cad state]', await tjs(`JSON.stringify({ loading: document.querySelector('.cad-loading')?.textContent, error: document.querySelector('.cad-error')?.textContent, head: document.querySelector('.cad-head')?.textContent, nodes: document.querySelectorAll('.cad-node').length, toast: document.querySelector('.toast')?.textContent })`), calls.filter((c) => c.channel.startsWith('cad:')).map((c) => c.channel))
      throw new Error(`Timed out (CAD): ${what}`)
    }
    const cadRecords = (type) => Object.values(recordDocs.reviews?.items ?? {}).filter((i) => i.type === type)
    const cadSet = (selector, value) => tjs(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await tjs(`document.querySelector('button[aria-label="CAD"]').click()`)
    await tuntil(`!!document.querySelector('.cad .cad-start .cad-drop')`, 'the CAD start screen')
    assert.equal(await tjs(`document.querySelector('.sidebar')?.getClientRects().length ?? 0`), 0, 'the hosts sidebar steps aside for CAD')
    await tshot('cad-start.png')
    cadPicks.push(cadFiles.as1)
    await tjs(`document.querySelector('.cad-head button[title^="Open a CAD file"]').click()`)
    await cadUntil(`document.querySelector('.cad-head-file b')?.textContent === 'as1_pe_203.stp' && document.querySelectorAll('.cad-node').length > 3`, 'the assembly opens with its parts')
    // OpenCascade gives this file as the plate, two bracket assemblies and the rod, each with its solids.
    assert.equal(await tjs(`document.querySelector('.cad-panel-head b').textContent`), '4', 'the assembly has its parts')
    assert.deepEqual(await tjs(`[...document.querySelectorAll('.cad-node-name')].map((n) => n.textContent)`), ['AS1_PE_ASM', 'PLATE', 'L_BRACKET_ASSEMBLY_ASM', 'L_BRACKET_ASSEMBLY_ASM', 'ROD_ASM'])
    assert.match(await tjs(`document.querySelector('.cad-head-sub').textContent`), / mm · 4 parts$/)
    await tuntil(`document.querySelector('.cad-verdict')?.dataset.verdict === 'open'`, 'a new review starts open')
    assert.equal(cadRecords('cadfile').length, 1, 'opening the file starts its review')
    assert.equal(cadRecords('cadfile')[0].checklist.length > 5, true, 'with the checklist')
    for (let n = 0; n < 150 && !Object.keys(cadCache).length; n++) await new Promise((r) => setTimeout(r, 30))
    assert.equal(Object.keys(cadCache).length, 1, 'what was read is cached as GLB')
    const cadNode = (n) => `document.querySelectorAll('.cad-node')[${n}]`
    await tjs(`${cadNode(1)}.querySelector('.cad-node-name').click()`)
    await tuntil(`${cadNode(1)}.classList.contains('on')`, 'a part is selected from the tree')
    await tjs(`${cadNode(1)}.querySelector('.cad-node-eye').click()`)
    await tuntil(`${cadNode(1)}.classList.contains('hidden')`, 'and hidden')
    await tshot('cad-assembly.png')
    await tjs(`[...document.querySelectorAll('.cad-mini')].find((b) => b.textContent === 'Show all').click()`)
    await tuntil(`!document.querySelector('.cad-node.hidden')`, 'show all')
    cadPicks.push(cadFiles.cube)
    await tjs(`document.querySelector('.cad-head button[title^="Open a CAD file"]').click()`)
    await cadUntil(`document.querySelector('.cad-head-file b')?.textContent === 'cube.stp' && !document.querySelector('.cad-loading')`, 'the cube opens')
    await tuntil(`document.querySelector('.cad-list-head')?.textContent === 'No comments yet'`, 'its own review')
    // A comment pinned on the top face.
    await tkey('c')
    await tuntil(`document.querySelector('.cad-stage').classList.contains('tool-pin') && !!document.querySelector('.cad-tool-hint')`, 'the comment tool')
    const mid = await cadStage()
    await cadClick(mid.x, mid.y - 40)
    await tuntil(`!!document.querySelector('.cad-composer textarea')`, 'the comment box opens where the model was clicked')
    await cadSet('.cad-composer textarea', 'Chamfer this edge, 0.5 mm')
    await tjs(`[...document.querySelectorAll('.cad-composer button')].find((b) => b.textContent === 'Pin').click()`)
    await tuntil(`!!document.querySelector('.cad-pin[data-pin="1"]') && document.querySelector('.cad-note[data-note="1"]')?.textContent.includes('Chamfer this edge')`, 'pin 1 on the model and in the list')
    assert.equal(cadRecords('cadnote').length, 1)
    assert.equal(cadRecords('cadnote')[0].anchor.kind, 'point', 'the comment is anchored to a point')
    assert.ok(cadRecords('cadnote')[0].view?.pos?.length === 3, 'with the view it was made in')
    await tuntil(`/translate\\(\\d/.test(document.querySelector('.cad-pin').style.transform)`, 'the pin follows the model on screen')
    // A measurement between two points on the cube.
    await tkey('m')
    await tuntil(`document.querySelector('.cad-stage').classList.contains('tool-measure')`, 'the ruler')
    await cadClick(mid.x - 40, mid.y + 30)
    await new Promise((r) => setTimeout(r, 80))
    await cadClick(mid.x + 40, mid.y + 30)
    await tuntil(`!!document.querySelector('.cad-len') && document.querySelector('.cad-tabs .on')?.textContent.startsWith('Measure')`, 'a length label and the Measure tab')
    assert.ok(cadRecords('cadmeasure')[0].length > 0, 'the measurement has a length')
    await tjs(`[...document.querySelectorAll('.cad-measure button')].find((b) => b.textContent === 'Name…').click()`)
    await tuntil(`!!document.querySelector('input[aria-label="Measurement name"]')`, 'naming a measurement in place')
    await cadSet('input[aria-label="Measurement name"]', 'Face span')
    await tjs(`document.querySelector('input[aria-label="Measurement name"]').blur()`)
    await tuntil(`document.querySelector('.cad-measure p')?.textContent.includes('Face span')`, 'the name is kept')
    await tkey('Escape')
    await tuntil(`document.querySelector('.cad-stage').classList.contains('tool-orbit')`, 'Esc goes back to turning')
    await tshot('cad-review.png')
    // An issue, two checks (one failing, with what fails), Request changes asked in place, then Approve.
    await tjs(`[...document.querySelectorAll('.cad-tabs button')].find((b) => b.textContent.startsWith('Issues')).click()`)
    await tuntil(`!!document.querySelector('input[aria-label="New issue"]')`, 'issues tab')
    await cadSet('input[aria-label="New issue"]', 'Wall below 1.5 mm at the flange')
    await tjs(`(() => { const s = document.querySelector('select[aria-label^="New issue"][aria-label$="severity"]'); s.value = 'high'; s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    await tjs(`[...document.querySelectorAll('.cad-compose button')].find((b) => b.textContent === 'Add issue').click()`)
    await tuntil(`document.querySelector('.cad-issue')?.dataset.severity === 'high'`, 'the issue is listed')
    await tjs(`[...document.querySelectorAll('.cad-tabs button')].find((b) => b.textContent.startsWith('Checklist')).click()`)
    await tuntil(`document.querySelectorAll('.cad-checkrow').length > 5`, 'the checklist')
    await tjs(`document.querySelectorAll('.cad-checkrow')[0].querySelector('[data-s="pass"]').click()`)
    await tjs(`document.querySelectorAll('.cad-checkrow')[1].querySelector('[data-s="fail"]').click()`)
    await tuntil(`document.querySelectorAll('.cad-checkrow')[0].classList.contains('pass') && !!document.querySelectorAll('.cad-checkrow')[1].querySelector('.cad-check-note')`, 'a check passes; a failing one asks what fails')
    await tjs(`document.querySelector('.cad-check-note').focus()`)
    await cadSet('.cad-check-note', 'Draft is 0.5°')
    await tjs(`document.querySelector('.cad-check-note').blur()`)
    for (let n = 0; n < 60 && !cadRecords('cadfile').some((f) => f.checklist.some((c) => c.note === 'Draft is 0.5°')); n++) await new Promise((r) => setTimeout(r, 30))
    assert.ok(cadRecords('cadfile').some((f) => f.checklist.some((c) => c.status === 'fail' && c.note === 'Draft is 0.5°')), 'the failing check keeps its note')
    await tjs(`[...document.querySelectorAll('.cad-verdict button')].find((b) => b.textContent === 'Request changes').click()`)
    await tuntil(`!!document.querySelector('.cad-ask textarea')`, 'what needs to change is asked in place')
    await cadSet('.cad-ask textarea', 'Thicken the flange')
    await tjs(`document.querySelector('.cad-ask button[type="submit"]').click()`)
    await tuntil(`document.querySelector('.cad-verdict')?.dataset.verdict === 'changes' && document.querySelector('.cad-verdict-sub').textContent.includes('Thicken the flange')`, 'changes requested, with the note')
    await tjs(`[...document.querySelectorAll('.cad-verdict button')].find((b) => b.textContent === 'Reopen').click()`)
    await tuntil(`document.querySelector('.cad-verdict')?.dataset.verdict === 'open'`, 'reopened')
    await tjs(`window.__cadConfirm = []; window.confirm = (m) => { window.__cadConfirm.push(m); return true }; 0`)
    await tjs(`[...document.querySelectorAll('.cad-verdict button')].find((b) => b.textContent === 'Approve').click()`)
    await tuntil(`document.querySelector('.cad-verdict')?.dataset.verdict === 'approved' && document.querySelector('.cad-chip.verdict')?.dataset.verdict === 'approved'`, 'approved')
    assert.match(await tjs(`window.__cadConfirm[0] ?? ''`), /Approve anyway\?/, 'approving with an open issue asks first')
    // The report goes to Notes with a picture of the pinned model, and the note opens beside the model.
    await tjs(`[...document.querySelectorAll('.cad-head .btn')].find((b) => b.textContent.includes('Report')).click()`)
    await tuntil(`!!document.querySelector('.cad-menu [role="menuitem"]')`, 'the report menu')
    await tjs(`[...document.querySelectorAll('.cad-menu [role="menuitem"]')].find((b) => b.textContent.startsWith('Save to Notes')).click()`)
    for (let n = 0; n < 100 && !cadSaved.length; n++) await new Promise((r) => setTimeout(r, 30))
    assert.equal(cadSaved.length, 1, 'the review is saved to Notes')
    assert.match(cadSaved[0].name, /^cube review \d{4}-\d{2}-\d{2}$/)
    assert.match(cadSaved[0].markdown, /Chamfer this edge, 0\.5 mm/)
    assert.match(cadSaved[0].markdown, /Wall below 1\.5 mm at the flange/)
    assert.match(cadSaved[0].markdown, /Face span/)
    assert.match(cadSaved[0].markdown, /\{image\}/, 'the picture goes where the report says')
    assert.ok(cadSaved[0].png?.startsWith('data:image/png;base64,') && cadSaved[0].png.length > 5000, 'with a picture')
    await tuntil(`document.querySelector('.notes-title')?.textContent.startsWith('cube review')`, 'the note opens beside the model')
    // Beside the note there is room for one side panel, the one opened last; the model keeps its room.
    await tuntil(`document.querySelector('.cad').classList.contains('narrow') && !document.querySelector('.cad-tree') && !!document.querySelector('.cad-review')`, 'one side panel beside a note')
    assert.ok(await tjs(`document.querySelector('.cad-stage').getBoundingClientRect().width`) > 300, 'the model keeps its room')
    await tshot('cad-report.png')
    await tjs(`document.querySelector('.cad-head .cad-icon-btn[title="Parts"]').click()`)
    await tuntil(`!!document.querySelector('.cad-tree') && !document.querySelector('.cad-review')`, 'Parts takes the side')
    await tjs(`document.querySelector('.cad-head .cad-icon-btn[title="Review"]').click()`)
    await tuntil(`!document.querySelector('.cad-tree') && !!document.querySelector('.cad-review')`, 'and Review takes it back')
    // Back to the assembly from the Reviews list: it comes from the cache, its review still open, the cube approved.
    assert.ok(await tjs(`!!document.querySelector('.cad-canvas')?.getClientRects().length`), 'the model stays beside the note')
    const cadCalls = calls.filter((c) => c.channel === 'cad:cacheGet').length
    cadPicks.push(cadFiles.as1)
    await tjs(`document.querySelector('.cad-head button[title^="Open a CAD file"]').click()`)
    await cadUntil(`document.querySelector('.cad-head-file b')?.textContent === 'as1_pe_203.stp' && !document.querySelector('.cad-loading') && / mm · 4 parts$/.test(document.querySelector('.cad-head-sub')?.textContent)`, 'the assembly again, its parts kept by the cache')
    assert.equal(calls.filter((c) => c.channel === 'cad:cacheGet').length, cadCalls + 1)
    await tjs(`[...document.querySelectorAll('.cad-tabs button')].find((b) => b.textContent.startsWith('Info')).click()`)
    await tuntil(`document.querySelector('.cad-info')?.textContent.includes('from the cache')`, 'read from the cache the second time')
    assert.deepEqual(cadRecords('cadfile').map((f) => [f.name, f.verdict]).sort(), [['as1_pe_203.stp', 'open'], ['cube.stp', 'approved']])

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

    // Box problems in the workspace's Needs attention, with their fix, and ⌘K's Sync with Box now.
    const boxwin = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { preload: join(__dirname, 'ui-preload.cjs'), contextIsolation: true, backgroundThrottling: false } })
    boxwin.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message) })
    const bxjs = (code) => boxwin.webContents.executeJavaScript(code).catch((e) => { throw new Error(`${e.message}\n  in: ${code.slice(0, 300)}`) })
    const bxuntil = async (code) => { for (let n = 0; n < 150; n++) { if (await bxjs(code)) return; await new Promise((r) => setTimeout(r, 30)) } throw new Error(`Timed out (Box attention): ${code}`) }
    const signedInBox = { available: true, signedIn: true, syncing: false, user: { name: 'Fixture Person', login: 'person@example.com' }, folder: { id: '123', name: 'Remote Access Tool' }, lastSync: Date.now() }
    const attentionRow = (title) => `[...document.querySelectorAll('.ws-attention-row')].find((r) => r.textContent.includes(${JSON.stringify(title)}))`
    boxFixture = { ...signedInBox, lastError: 'Box is having trouble; the next sync tries again.' }
    await boxwin.loadFile(resolve('out/renderer/index.html'))
    await bxuntil(`!!document.querySelector('.ws-attention-list')`)
    await bxjs(`document.querySelector('.ws-attention .ws-text-action')?.click()`)
    await bxuntil(`!!${attentionRow('Box sync is failing')}`)
    assert.equal(await bxjs(`${attentionRow('Box sync is failing')}.querySelector('button').textContent`), 'Sync now')
    const syncsBefore = setupDone.filter((d) => d[0] === 'box:sync').length
    await bxjs(`${attentionRow('Box sync is failing')}.querySelector('button').click()`)
    for (let n = 0; n < 50 && setupDone.filter((d) => d[0] === 'box:sync').length === syncsBefore; n++) await new Promise((r) => setTimeout(r, 30))
    assert.equal(setupDone.filter((d) => d[0] === 'box:sync').length, syncsBefore + 1, 'Sync now from Needs attention')
    boxFixture = { ...signedInBox, signedIn: false }
    await boxwin.loadFile(resolve('out/renderer/index.html'))
    await bxuntil(`!!document.querySelector('.ws-attention-list')`)
    await bxjs(`document.querySelector('.ws-attention .ws-text-action')?.click()`)
    await bxuntil(`${attentionRow('Box signed this computer out')}?.querySelector('button').textContent === 'Sign in to Box'`)
    const signInsBefore = setupDone.filter((d) => d[0] === 'box:signIn').length
    await bxjs(`${attentionRow('Box signed this computer out')}.querySelector('button').click()`)
    for (let n = 0; n < 50 && setupDone.filter((d) => d[0] === 'box:signIn').length === signInsBefore; n++) await new Promise((r) => setTimeout(r, 30))
    assert.equal(setupDone.filter((d) => d[0] === 'box:signIn').length, signInsBefore + 1, 'Sign in to Box from Needs attention')
    // ⌘K: Sync with Box now.
    boxFixture = signedInBox
    await bxjs(`document.querySelector('.search-pill').click()`)
    await bxuntil(`!!document.querySelector('[role="combobox"]')`)
    await bxjs(`(() => { const i = document.querySelector('[role="combobox"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'sync with box'); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await bxuntil(`[...document.querySelectorAll('[role="option"]')].some((o) => o.textContent.includes('Sync with Box now'))`)
    const syncsBeforeK = setupDone.filter((d) => d[0] === 'box:sync').length
    await bxjs(`[...document.querySelectorAll('[role="option"]')].find((o) => o.textContent.includes('Sync with Box now')).click()`)
    await bxuntil(`document.querySelector('.toasts')?.textContent.includes('In step with Box')`)
    assert.equal(setupDone.filter((d) => d[0] === 'box:sync').length, syncsBeforeK + 1)
    boxwin.destroy()
    boxFixture = boxSignedOut

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
    assert.match(await ejs(`[...document.querySelectorAll('.welcome-req')][0].textContent`), /Included with the app/, 'the plugin shipped in the app counts')
    // A build carrying the organization's sign-in: one button signs in and offers its profiles, named as the file names them.
    companyFixture = companyDefaults
    await ewin.loadFile(resolve('out/renderer/index.html'))
    await euntil(`document.querySelector('.welcome-action.primary.wide')?.textContent.includes('Sign in to Corp AWS')`)
    assert.match(await ejs(`document.querySelector('.welcome-action.primary.wide').textContent`), /Sets up prod-plm, qa-plm/)
    await eshot('welcome-company.png')
    await ejs(`document.querySelector('.welcome-action.primary.wide').click()`)
    await euntil(`document.querySelectorAll('[role="dialog"] tbody tr').length === 3`)
    assert.deepEqual(setupDone.find((d) => d[0] === 'sso:start')[1], { startUrl: 'https://corp.awsapps.com/start', region: 'us-west-2' }, 'the sign-in starts at once with the company start URL')
    const rows = await ejs(`[...document.querySelectorAll('[role="dialog"] tbody tr')].map((r) => [r.querySelector('input[type=checkbox]').checked, r.querySelector('select').value, r.querySelector('input.mono').value, r.querySelector('input[placeholder^="Dev"]').value].join('|'))`)
    assert.deepEqual(rows, ['true|Admin|prod-plm|Prod', 'true|Admin|qa-plm|Corp QA', 'false|Admin|sandbox|Sandbox'], 'the company profiles come named and ticked; other accounts unticked')
    await eshot('welcome-company-accounts.png')
    await ejs(`[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.startsWith('Add 2 accounts')).click()`)
    await euntil(`[...document.querySelectorAll('[role="dialog"] button')].some((b) => b.textContent.trim() === 'Done')`)
    const ssoSaved = setupDone.find((d) => d[0] === 'sso:save')[1]
    assert.equal(ssoSaved.sessionName, 'corp')
    assert.deepEqual(ssoSaved.selections, [{ accountId: '111111111111', roleName: 'Admin', profileName: 'prod-plm', region: 'us-west-2' }, { accountId: '222222222222', roleName: 'Admin', profileName: 'qa-plm', region: 'us-west-1' }], 'each profile keeps its own region')
    assert.deepEqual(settings.accountMeta['prod-plm'], { label: 'Prod', color: 'rose' })
    await ejs(`[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === 'Done').click()`)
    await euntil(`!document.querySelector('[role="dialog"]')`)
    // Import a setup exported on another Mac: what it brings, then the data folder it used.
    assert.match(await ejs(`document.querySelector('.welcome-import').textContent`), /sign in to Box to bring it from there/, 'with Box in the build, the welcome offers it')
    await ejs(`document.querySelector('.welcome-import button').click()`)
    await euntil(`document.querySelector('.setup-import')?.textContent.includes('Old Mac')`)
    assert.match(await ejs(`document.querySelector('.setup-import').textContent`), /prod-plm.*Will be added.*qa-plm.*A different one by this name stays/)
    assert.match(await ejs(`document.querySelector('.setup-import').textContent`), /3 favorites · 2 host settings/)
    assert.match(await ejs(`document.querySelector('.setup-import').textContent`), /old-keys.*access keys/)
    await eshot('setup-import.png')
    await ejs(`[...document.querySelectorAll('.setup-import button')].find((b) => b.textContent === 'Import').click()`)
    await euntil(`document.querySelector('.setup-import')?.textContent.includes('Added 1 AWS profile (prod-plm)')`)
    assert.deepEqual(setupDone.find((d) => d[0] === 'apply'), ['apply', 'imp-1'])
    assert.ok(settings.favorites.includes('imported/us-east-1/i-imported'), 'the merged settings are saved')
    await ejs(`[...document.querySelectorAll('.setup-import button')].find((b) => b.textContent === 'Use it on this Mac').click()`)
    await euntil(`document.querySelector('.setup-import').textContent.includes('This Mac now syncs with it too')`)
    await ejs(`[...document.querySelectorAll('.setup-import button')].find((b) => b.textContent === 'Done').click()`)
    await euntil(`!document.querySelector('.setup-import')`)
    // Settings → Data: Export setup.
    await ejs(`document.querySelector('button[aria-label="Settings"]').click()`)
    await euntil(`!!document.querySelector('.settings-nav [data-section="data"]')`)
    await ejs(`document.querySelector('.settings-nav [data-section="data"]').click()`)
    await euntil(`[...document.querySelectorAll('.settings-body button')].some((b) => b.textContent === 'Export…')`)
    await ejs(`[...document.querySelectorAll('.settings-body button')].find((b) => b.textContent === 'Export…').click()`)
    await euntil(`document.querySelector('.toasts')?.textContent.includes('Setup exported to /Users/fixture/Desktop')`)
    await eshot('settings-data-setup.png')
    // Settings → Data → Box: sign in (the Mac opens the browser itself), the status pushed back, Sync now, Sign out.
    await euntil(`[...document.querySelectorAll('.settings-body button')].some((b) => b.textContent === 'Sign in to Box…')`)
    await ejs(`[...document.querySelectorAll('.settings-body button')].find((b) => b.textContent === 'Sign in to Box…').click()`)
    await euntil(`document.querySelector('.settings-body').textContent.includes('Signed in as Fixture Person (person@example.com)')`)
    assert.deepEqual(setupDone.find((d) => d[0] === 'box:signIn'), ['box:signIn', null], 'the Mac asks with no origin: its own loopback sign-in')
    assert.match(await ejs(`document.querySelector('.settings-body').textContent`), /Sent 2 to Box.*1 larger than your Box plan takes stay on this Mac/)
    await eshot('settings-box.png')
    await ejs(`[...document.querySelectorAll('.settings-body button')].find((b) => b.textContent === 'Sync now' && b.closest('.set-group')?.textContent.includes('Box')).click()`)
    for (let n = 0; n < 50 && !setupDone.some((d) => d[0] === 'box:sync'); n++) await new Promise((r) => setTimeout(r, 30))
    assert.ok(setupDone.some((d) => d[0] === 'box:sync'), 'Sync now')
    await ejs(`window.confirm = () => true; [...document.querySelectorAll('.settings-body button')].find((b) => b.textContent === 'Sign out').click()`)
    await euntil(`[...document.querySelectorAll('.settings-body button')].some((b) => b.textContent === 'Sign in to Box…')`)
    // A new Mac signed in to Box: the setup another Mac keeps there (not its own), one click to the same preview.
    boxFixture = { available: true, signedIn: true, syncing: false, user: { name: 'Fixture Person', login: 'person@example.com' }, folder: { id: '123', name: 'Remote Access Tool' }, lastSync: Date.now() }
    await ewin.loadFile(resolve('out/renderer/index.html'))
    await euntil(`[...document.querySelectorAll('.welcome-box button')].map((b) => b.textContent).join('|').startsWith('Bring the setup from Old Mac') && document.querySelectorAll('.welcome-box button').length === 1`)
    await eshot('welcome-box-setup.png')
    await ejs(`document.querySelector('.welcome-box button').click()`)
    await euntil(`document.querySelector('.setup-import')?.textContent.includes('Box: Old Mac.json')`)
    assert.deepEqual(setupDone.find((d) => d[0] === 'fromBox'), ['fromBox', '901'])
    await ejs(`[...document.querySelectorAll('.setup-import button')].find((b) => b.textContent === 'Cancel').click()`)
    await euntil(`!document.querySelector('.setup-import')`)
    boxFixture = boxSignedOut
    companyFixture = null
    ewin.destroy()
    settings.theme = savedTheme
    emptyScenario = false
    await screens()
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

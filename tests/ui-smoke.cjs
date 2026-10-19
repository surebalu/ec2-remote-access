// Runs the built renderer with synthetic data and no production main process or AWS access.
const { app, BrowserWindow, ipcMain, session, webContents } = require('electron')
const http = require('node:http')
const { mkdtempSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const assert = require('node:assert/strict')
const output = mkdtempSync(join(tmpdir(), 'ec2ra-ui-'))
app.setPath('userData', output)
app.setPath('sessionData', output)
const now = Date.now()
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
  const title = u.pathname.startsWith('/console') ? 'AWS Console fixture' : { '/one': 'Fixture page one', '/two': 'Fixture page two' }[u.pathname] ?? 'Fixture'
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(`<!doctype html><title>${title}</title><body style="font:15px -apple-system,system-ui;padding:36px;line-height:1.6"><h1>${title}</h1><p>${u.pathname}${u.search}</p><p>find me, find me</p><a href="/two" target="_blank">two</a></body>`)
})
app.on('session-created', (ses) => {
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    if (ses === session.defaultSession) return callback({ cancel: /^(https?|wss?):/.test(details.url) })
    const u = new URL(details.url)
    if (u.hostname === '127.0.0.1') return callback({})
    if (/(^|\.)console\.aws\.amazon\.com$/.test(u.hostname)) return callback({ redirectURL: `http://127.0.0.1:${webPort}/console${u.pathname}${u.search}` })
    callback({ cancel: /^(https?|wss?):/.test(details.url) })
  })
})
// A fake zsh for the Terminal tab: shell-integration markers, echo, a few commands, ⌃C.
let termSaved = null
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
    case 'notes:search': return []
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
    case 'local:reveal': return
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
    case 'ssh:close': case 'ssh:write': case 'ssh:resize': case 'clipboard:write': case 'theme:set': return
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
    assert.equal(await js(`document.querySelector('.titlebar .brand-name').textContent`), 'Remote Access Tool')
    assert.equal(await js(`getComputedStyle(document.querySelector('thead th button')).textTransform`), 'uppercase', 'sortable headers match the others')
    assert.equal(await js(`!!document.querySelector('[data-host-key="${stopped.key}"]')`), false, 'running filter initially hides stopped host')

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
    // The right-click menu lands at the pointer even inside the zoomed hosts list.
    await js(`(() => { const row = document.querySelector('[data-host-key="${running.key}"]'); const r = row.getBoundingClientRect(); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 200, clientY: r.top + 10 })) })()`)
    await until(`!!document.querySelector('body > .panel.modal.fixed')`)
    assert.equal(await js(`(() => { const row = document.querySelector('[data-host-key="${running.key}"]').getBoundingClientRect(); const m = document.querySelector('body > .panel.modal.fixed').getBoundingClientRect(); return Math.abs(m.left - (row.left + 200)) < 3 && Math.abs(m.top - (row.top + 10)) < 3 })()`), true, 'context menu opens at the pointer')
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
    // The app font: Monaco unless chosen otherwise, for every label (Tailwind's font-sans and font-mono included).
    assert.match(await js(`getComputedStyle(document.body).fontFamily`), /^Monaco/, 'Monaco by default')
    assert.match(await js(`getComputedStyle(document.querySelector('.settings-nav-item')).fontFamily`), /^Monaco/)
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
    await puntil(`!!document.querySelector('.m-app') && document.querySelectorAll('.m-tabbar button').length === 3`)
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
    bwin.webContents.send('web:shortcut', { webContentsId: guestAt('/two').id, key: 'w', shift: false, alt: false })
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
    // Favorites: page one becomes a favorite, shown in every space and keeping General's logins; ⌘W only unloads it.
    await bjs(`[...document.querySelectorAll('.web-tabs .web-tab')].find((t) => t.textContent.includes('Fixture page one')).click()`)
    await buntil(`document.querySelector('.web-tab.on .web-tab-title')?.textContent === 'Fixture page one'`, 'page one selected')
    const oneId = guestAt('/one').id
    await bkey('d', { shiftKey: true })
    await buntil(`document.querySelectorAll('.web-fav').length === 1 && !document.querySelector('.web-tabs .web-tab') && !!document.querySelector('.web-fav.on')`, 'favorited')
    await bjs(`document.querySelector('.web-space-dot[aria-label="Space sandbox"]').click()`)
    await buntil(`document.querySelector('.web-space-name')?.textContent === 'sandbox' && !!document.querySelector('.web-fav .web-fav-dot')`, 'favorite shown in another space')
    await bjs(`document.querySelector('.web-fav').click()`)
    await buntil(`!!document.querySelector('.web-fav.on') && document.querySelector('.web-space-name')?.textContent === 'sandbox' && document.querySelector('.web-url-host')?.textContent.startsWith('127.0.0.1')`, 'favorite opens in the showing space')
    assert.equal(guestAt('/one')?.id, oneId, 'the favorite is the same page, not reloaded')
    await bshot('browser-favorites.png')
    await bkey('w')
    await buntil(`!!document.querySelector('.web-fav.asleep') && document.querySelector('.web-tab.on .web-tab-title')?.textContent === 'AWS Console fixture'`, '⌘W unloads the favorite')
    for (let n = 0; n < 50 && guestAt('/one'); n++) await new Promise((r) => setTimeout(r, 30))
    assert.equal(guestAt('/one'), undefined, 'unloaded favorite releases its page')
    // General was showing the favorite: it loads again there (unloading is not closing).
    await bjs(`document.querySelector('.web-space-dot[aria-label="Space General"]').click()`)
    await buntil(`!!document.querySelector('.web-fav.on:not(.asleep)') && document.querySelector('.web-space-name')?.textContent === 'General'`, 'back in General')
    await buntil(`document.querySelector('.web-url-host')?.textContent.startsWith('127.0.0.1')`)
    for (let n = 0; n < 60 && !guestAt('/one'); n++) await new Promise((r) => setTimeout(r, 30))
    assert.ok(guestAt('/one'), 'the favorite loads again where it was showing')
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
    browserScenario = false
    bwin.destroy()
    webServer.close()

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

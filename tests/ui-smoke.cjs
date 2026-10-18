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
ipcMain.handle('fixture:invoke', async (_e, channel, ...args) => {
  calls.push({ channel, args })
  switch (channel) {
    case 'settings:get': return settings
    case 'settings:set': settings = { ...settings, ...args[0] }; return settings
    case 'inventory:cached': return cached
    case 'inventory:scan': cached = { ...cached, instances: cached.instances.map((i) => ({ ...i, staleReason: undefined, lastSeenAt: Date.now() })), errors: [], scannedAt: Date.now() }; return cached
    case 'profiles:list': return ssoScenario ? [ssoProfile] : browserScenario ? [...profiles, awsProfile] : profiles
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
    case 'ssh:listShells': return [
      { name: 'ec2ra-old1', label: 'debug', user: '3dxadmin', args: 'bash', preview: '3dxadmin@ip-10-1-2-144:/etc/systemd/system$', command: 'bash', path: '/etc/systemd/system', idleSec: 5, ageSec: 7200, current: true, attached: true },
      { name: 'ec2ra-other', label: '', user: 'root', args: 'tail -f /var/log/messages', preview: 'Oct 17 21:40:01 ip-10-1-2-144 systemd[1]: Started Session 42.', command: 'tail', path: '/root', idleSec: 60, ageSec: 300, current: false, attached: false }
    ]
    case 'ssh:switchShell': return { name: args[1] ?? 'ec2ra-new', label: args[2]?.label ?? (args[1] === 'ec2ra-old1' ? 'debug' : '') }
    case 'ssh:renameShell': return String(args[2]).trim()
    case 'ssh:close': case 'ssh:write': case 'ssh:resize': case 'clipboard:write': case 'theme:set': return
    default: throw new Error(`Unexpected fixture IPC: ${channel}`)
  }
})

app.whenReady().then(async () => {
  app.dock?.hide()
  await new Promise((r) => webServer.listen(0, '127.0.0.1', r))
  webPort = webServer.address().port
  const win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { preload: join(__dirname, 'ui-preload.cjs'), contextIsolation: true, backgroundThrottling: false } })
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }))
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message) })
  const js = (code) => win.webContents.executeJavaScript(code)
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
    assert.equal(await js(`getComputedStyle(document.querySelector('thead th button')).textTransform`), 'uppercase', 'sortable headers match the others')
    assert.equal(await js(`!!document.querySelector('[data-host-key="${stopped.key}"]')`), false, 'running filter initially hides stopped host')

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
    await js(`document.querySelector('button[title="Settings"]').click()`)
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
    await js(`document.querySelector('button[title="Settings"]').click()`)
    await until(`!!document.querySelector('[role="dialog"]')`)
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
    await js(`[...document.querySelectorAll('.notes-file')].find((b) => b.textContent.includes('Runbook')).click()`)
    await until(`document.querySelector('.notes-tab .cm-content')?.textContent.includes('see [[PLM upgrade]]')`)
    // Real clicks and keys, as a person edits: the window-wide user-select: none once kept clicks from placing a caret.
    const lastLine = await js(`(() => { const r = [...document.querySelectorAll('.notes-tab .cm-line')].at(-1).getBoundingClientRect(); return { x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2) } })()`)
    win.webContents.focus()
    win.webContents.sendInputEvent({ type: 'mouseDown', x: lastLine.x, y: lastLine.y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: lastLine.x, y: lastLine.y, button: 'left', clickCount: 1 })
    await until(`document.activeElement?.classList.contains('cm-content') && getSelection().rangeCount > 0`)
    for (const ch of 'Checked the logs. ') win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
    await until(`document.querySelector('.notes-tab .cm-content').textContent.includes('Checked the logs.')`)
    assert.match(await js(`document.querySelector('.notes-tab .cm-content').textContent`), /see \[\[PLM upgrade\]\]\.Checked the logs\./, 'typing goes where the click put the caret')
    for (let n = 0; n < 100 && !calls.some((c) => c.channel === 'notes:write' && c.args[0] === 'Runbook.md' && c.args[1].includes('Checked the logs.')); n++) await new Promise((r) => setTimeout(r, 30))
    assert.ok(calls.some((c) => c.channel === 'notes:write' && c.args[0] === 'Runbook.md' && c.args[1].includes('Checked the logs.') && typeof c.args[2] === 'number'), 'typing autosaves, with the loaded version for conflict checks')
    await until(`document.querySelector('.notes-status')?.textContent === 'Saved'`)
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
    assert.match(await js(`document.querySelector('button[title^="All sessions"]').textContent`), new RegExp(`All\\s*${sessionCount}$`))
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
    await bjs(`document.querySelector('.space-form').requestSubmit()`)
    await buntil(`document.querySelector('.web-space-name')?.textContent === 'Jira' && !!document.querySelector('.start-page')`, 'new space')
    // Leaving the browser for another tab and coming back keeps its pages (no reload, same page process).
    await bjs(`document.querySelector('.web-space-dot[aria-label="Space General"]').click()`)
    await buntil(`document.querySelector('.web-pinned .web-tab.on') !== null`, 'pinned tab active in General')
    g1 = guestAt('/two')
    const before = g1.id
    // ⌘1 belongs to the browser's tabs here; ⌘⇧[ goes to the previous app tab (Hosts).
    await bkey('{', { shiftKey: true })
    await buntil(`!document.querySelector('.browser') || document.querySelector('.browser').getClientRects().length === 0`, 'hosts shown')
    await bjs(`[...document.querySelectorAll('.tab')].find((t) => t.textContent.includes('Browser')).click()`)
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
    // ⌘1…⌘9 follow the sidebar: Favorites, then Pinned, then Today.
    await bkey('2')
    await buntil(`!!document.querySelector('.web-pinned .web-tab.on')`, '⌘2 selects the pinned tab')
    await bkey('1')
    await buntil(`!!document.querySelector('.web-fav.on')`, '⌘1 selects the favorite')
    // One zoom for every page: ⌘+ on one page zooms the other open pages too, and ⌘0 resets them all.
    await bkey('=')
    await buntil(`document.querySelector('.web-zoom')?.textContent === '110%'`, 'zoom badge')
    for (let n = 0; n < 50 && guestAt('/two')?.getZoomFactor() !== 1.1; n++) await new Promise((r) => setTimeout(r, 30))
    assert.equal(guestAt('/one').getZoomFactor(), 1.1)
    assert.equal(guestAt('/two').getZoomFactor(), 1.1, 'the page in the background zooms too')
    await bkey('0')
    await buntil(`!document.querySelector('.web-zoom')`, 'zoom reset')
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

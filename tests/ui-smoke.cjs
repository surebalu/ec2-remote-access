// Runs the built renderer with synthetic data and no production main process or AWS access.
const { app, BrowserWindow, ipcMain } = require('electron')
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
  externalTerminal: 'Terminal', sessionManagerPluginPath: '', awsCliPath: '', connectTimeoutSec: 20, preferDirect: false, overrides: {}
}
let cached = { instances: [running, stopped, stale], errors: [{ profile: 'development', region: 'us-east-1', message: stale.staleReason }], scannedAt: now }
let failSsh = false
ipcMain.handle('fixture:invoke', async (_e, channel, ...args) => {
  calls.push({ channel, args })
  switch (channel) {
    case 'settings:get': return settings
    case 'settings:set': settings = { ...settings, ...args[0] }; return settings
    case 'inventory:cached': return cached
    case 'inventory:scan': cached = { ...cached, instances: cached.instances.map((i) => ({ ...i, staleReason: undefined, lastSeenAt: Date.now() })), errors: [], scannedAt: Date.now() }; return cached
    case 'profiles:list': return profiles
    case 'profiles:check': return profiles.map((p) => ({ profile: p.name, state: 'ok', accountId: p.accountId, checkedAt: Date.now() }))
    case 'tunnels:list': case 'sso:sessions': return []
    case 'app:paths': return { sessionManagerPlugin: '/fixture/plugin', awsCli: null, windowsApp: false }
    case 'diag:log': return { path: '/fixture/main.log', text: '' }
    case 'phone:status': return { enabled: true, running: true, port: 8321, bind: 'https', tailscaleAvailable: true, tailscaleHostname: 'fixture-mac.tail1234.ts.net', tailscaleHttps: true, urls: ['https://fixture-mac.tail1234.ts.net/#token=fixture-token'], token: 'fixture-token', clients: [{ address: '100.101.102.5', since: Date.now() - 120000 }] }
    case 'ssh:open':
      if (failSsh) throw new Error('Fixture: authentication failed')
      return { sessionId: args[0].sessionId, instanceKey: running.key, title: running.name, route: 'ssm', host: running.instanceId, user: 'ubuntu' }
    case 'ssh:close': case 'ssh:write': case 'ssh:resize': case 'clipboard:write': case 'theme:set': return
    default: throw new Error(`Unexpected fixture IPC: ${channel}`)
  }
})

app.whenReady().then(async () => {
  app.dock?.hide()
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

// Runs against ui-smoke's synthetic IPC; no production data, real shells, or AWS connections.
const { BrowserWindow } = require('electron')
const { join, resolve } = require('node:path')
const { writeFileSync } = require('node:fs')
const assert = require('node:assert/strict')

module.exports = async function workspaceChecks({ calls, output, getSettings, seed, restore, failNotes, hostKey, webPort }) {
  const win = new BrowserWindow({ show: false, width: 1300, height: 900, webPreferences: { preload: join(__dirname, 'ui-preload.cjs'), contextIsolation: true, backgroundThrottling: false, webviewTag: true } })
  const errors = []
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' && !(/^Uncaught Error: Invalid guestInstanceId: \d+$/.test(e.message) && e.sourceId.includes('isolated_bundle'))) errors.push(e.message)
  })
  const js = (code) => win.webContents.executeJavaScript(code)
  const until = async (code) => {
    for (let n = 0; n < 200; n++) { if (await js(code)) return; await new Promise((r) => setTimeout(r, 30)) }
    throw new Error(`Workspace UI timeout: ${code}`)
  }
  const shot = async (name) => { await new Promise((r) => setTimeout(r, 150)); writeFileSync(join(output, name), (await win.webContents.capturePage()).toPNG()) }
  const input = (selector, value) => js(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  const key = (k, mods = {}) => js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, metaKey: true, bubbles: true, cancelable: true, ...${JSON.stringify(mods)} }))`)
  const command = (c) => win.webContents.send('app:command', c)
  const palette = async (query) => {
    await key('k')
    await until(`!!document.querySelector('[role="combobox"]')`)
    await input('[role="combobox"]', '>' + query)
    await until(`!!document.querySelector('[role="option"]')`)
    await js(`document.querySelector('[role="option"]').click()`)
  }
  const countCalls = (channel) => calls.filter((c) => c.channel === channel).length
  const terminal = {
    tabs: [
      { id: 'project-shell', title: 'API build', profile: 'development', root: { type: 'split', dir: 'row', children: [{ type: 'pane', id: 'project-api' }, { type: 'pane', id: 'project-tests' }], sizes: [.65, .35] }, activePane: 'project-api' },
      { id: 'other-shell', title: 'Unrelated work', root: { type: 'pane', id: 'other-pane' }, activePane: 'other-pane' }
    ], activeTab: 'project-shell', cwds: { 'project-api': '/Users/fixture/proj', 'project-tests': '/Users/fixture/proj/tests', 'other-pane': '/Users/fixture/other' }
  }
  const browser = {
    spaces: [{ id: 'general', name: 'General', color: 'sky' }],
    tabs: [{ id: 'docs', spaceId: 'general', url: `http://127.0.0.1:${webPort}/one`, title: 'API docs', lastActive: 1 }, { id: 'personal', spaceId: 'general', url: '', title: 'Unrelated page', lastActive: 0 }],
    activeSpace: 'general', activeTab: { general: 'docs' }, history: [{ url: 'https://private.example', title: 'Private history', at: 1, spaceId: 'general' }]
  }
  try {
    seed({ terminal, browser })
    await win.loadFile(resolve('out/renderer/index.html'))
    await until(`document.querySelectorAll('[data-host-key]').length === 3`)
    command({ kind: 'section', section: 'local' })
    await until(`document.querySelectorAll('.term-tab').length === 2 && document.querySelector('.trib-chip.folder')?.textContent.includes('proj')`)
    command({ kind: 'section', section: 'browser' })
    await until(`document.querySelectorAll('.web-tab').length === 2`)
    command({ kind: 'note', path: 'Runbook.md' })
    await until(`!!document.querySelector('.notes-tab') && document.body.textContent.includes('Runbook')`)
    command({ kind: 'section', section: 'local' })
    await key('\\')
    await until(`!!document.querySelector('[role="combobox"]')`)
    await input('[role="combobox"]', 'Notes')
    await js(`document.querySelector('[role="option"]').click()`)
    await until(`document.querySelectorAll('.split-pane:not(.hidden)').length === 2`)
    await palette('Save open tabs as a workspace')
    await until(`!!document.querySelector('.workspace-save')`)
    assert.equal(await js(`document.querySelectorAll('.workspace-pick').length`), 3, 'tools-only workspaces can be saved')
    // Select a project subset, excluding unrelated shell and page.
    await js(`document.querySelectorAll('.workspace-subpicks').forEach((d) => d.open = true); document.querySelectorAll('.workspace-subpicks')[0].querySelectorAll('input')[1].click(); document.querySelectorAll('.workspace-subpicks')[1].querySelectorAll('input')[1].click()`)
    await input('.workspace-name input', 'Payments development')
    await shot('project-workspace-save.png')
    await js(`document.querySelector('.workspace-save').requestSubmit()`)
    await until(`!document.querySelector('.workspace-save')`)
    const ws = getSettings().workspaces.find((w) => w.name === 'Payments development')
    assert.ok(ws)
    assert.equal(ws.tabs.length, 0)
    assert.equal(ws.tools.length, 3)
    assert.equal(ws.tools.find((t) => t.kind === 'local').terminal.tabs.length, 1)
    assert.equal(ws.tools.find((t) => t.kind === 'browser').browser.tabs.length, 1)
    assert.equal(ws.tools.find((t) => t.kind === 'notes').path, 'Runbook.md')
    assert.equal(ws.layout.type, 'split')
    assert.equal(JSON.stringify(ws).includes('private.example'), false, 'history is excluded')
    assert.equal(JSON.stringify(ws).includes('Unrelated'), false, 'unselected tabs are excluded')
    const opensBefore = countCalls('term:open')
    command({ kind: 'workspace', id: ws.id })
    await until(`document.body.textContent.includes('Opened “Payments development”')`)
    assert.equal(countCalls('term:open'), opensBefore, 'live shells reused without restarting')
    assert.equal(await js(`document.querySelectorAll('.term-tab').length`), 2)
    // A new window starts with another live shell. Restore appends the project and maps the outer split to new ids.
    await win.loadURL('about:blank')
    seed({ terminal: { tabs: [terminal.tabs[1]], activeTab: 'other-shell', cwds: { 'other-pane': '/Users/fixture/other' } }, browser: { ...browser, tabs: [], activeTab: {}, history: [] } })
    await win.loadFile(resolve('out/renderer/index.html'))
    await until(`document.querySelectorAll('[data-host-key]').length === 3`)
    command({ kind: 'section', section: 'local' })
    await until(`document.querySelectorAll('.term-tab').length === 1 && !!document.querySelector('.trib-chip.folder')`)
    const restoredAt = calls.length
    command({ kind: 'workspace', id: ws.id })
    await until(`document.querySelectorAll('.term-tab').length === 2 && document.querySelectorAll('.split-pane:not(.hidden)').length === 2 && !!document.querySelector('.notes-tab')`)
    await until(`document.querySelectorAll('.web-tab').length === 1`)
    for (let n = 0; n < 100 && calls.slice(restoredAt).filter((c) => c.channel === 'term:open').length < 2; n++) await new Promise((r) => setTimeout(r, 30))
    const opened = calls.slice(restoredAt).filter((c) => c.channel === 'term:open').map((c) => c.args[0])
    assert.deepEqual(opened.map((p) => p.cwd).sort(), ['/Users/fixture/proj', '/Users/fixture/proj/tests'])
    assert.ok(opened.every((p) => p.env.AWS_PROFILE === 'development'))
    assert.equal(await js(`document.querySelectorAll('.term-tab')[0].textContent.includes('Unrelated work')`), true)
    await shot('project-workspace-restored.png')
    const reopenedAt = countCalls('term:open')
    command({ kind: 'workspace', id: ws.id })
    await until(`document.body.textContent.includes('Opened “Payments development”')`)
    assert.equal(countCalls('term:open'), reopenedAt)
    assert.equal(await js(`document.querySelectorAll('.web-tab').length`), 1)
    // A workspace cannot replace a note whose edits failed to save.
    command({ kind: 'note', path: 'Projects/PLM upgrade.md' })
    await until(`document.querySelector('.notes-tab .cm-content')?.textContent.includes('index rebuild')`)
    failNotes(true)
    win.webContents.focus()
    await js(`document.querySelector('.notes-tab .cm-content').focus()`)
    await win.webContents.insertText('Unsaved project draft. ')
    await until(`document.querySelector('.notes-tab .cm-content').textContent.includes('Unsaved project draft.')`)
    command({ kind: 'workspace', id: ws.id })
    await until(`document.body.textContent.includes('Save the current note or resolve its conflict')`)
    assert.ok(await js(`document.querySelector('.notes-tab .cm-content').textContent.includes('Unsaved project draft.')`))
    failNotes(false)
    await js(`document.querySelector('.notes-tab .cm-content').dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true }))`)
    await until(`document.querySelector('.notes-status')?.textContent === 'Saved'`)
    // Legacy workspaces still connect and reuse an existing restored remote tab.
    await js(`window.api.invoke('settings:set', { workspaces: [...${JSON.stringify(getSettings().workspaces)}, { id: 'legacy-project-test', name: 'Legacy project', savedAt: 1, tabs: [{ kind: 'ssh', instanceKey: ${JSON.stringify(hostKey)} }] }] })`)
    await win.loadURL('about:blank')
    await win.loadFile(resolve('out/renderer/index.html'))
    await until(`document.querySelectorAll('[data-host-key]').length === 3`)
    const sshBefore = countCalls('ssh:open')
    command({ kind: 'workspace', id: 'legacy-project-test' })
    for (let n = 0; n < 100 && countCalls('ssh:open') === sshBefore; n++) await new Promise((r) => setTimeout(r, 30))
    assert.equal(countCalls('ssh:open'), sshBefore + 1)
    command({ kind: 'workspace', id: 'legacy-project-test' })
    await until(`document.body.textContent.includes('Opened “Legacy project”')`)
    assert.equal(countCalls('ssh:open'), sshBefore + 1)
    assert.deepEqual(errors, [])
    console.log('Project workspace UI checks passed.')
  } catch (e) { await shot('project-workspace-failure.png'); throw e }
  finally { win.destroy(); restore() }
}

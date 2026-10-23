import { test } from 'node:test'
import assert from 'node:assert/strict'
import { captureBrowser, captureTerminal, restoreBrowser, restoreTerminal, workspaceLayout, workspacePageUrl, workspaceSize, workspaceSummary } from '../src/shared/workspaces.ts'
import type { BrowserState, PaneNode, TerminalState, Workspace } from '../src/shared/types.ts'

const pane = (id: string): PaneNode => ({ type: 'pane', id })
const split = (children: PaneNode[], sizes: number[]): PaneNode => ({ type: 'split', dir: 'row', children, sizes })
const terminal = (): TerminalState => ({
  tabs: [
    { id: 'build', title: 'Build', profile: 'production', root: split([pane('a'), pane('b')], [.7, .3]), activePane: 'b', maximized: 'b', workspaceSource: 'old/source' },
    { id: 'logs', root: pane('c'), activePane: 'c' }
  ], activeTab: 'build', cwds: { a: '/repo', b: '/repo/api', c: '/logs', stale: '/unused' }, input: 'shell', notify: true
})
const browser = (): BrowserState => ({
  spaces: [{ id: 'general', name: 'General', color: 'sky' }],
  tabs: [
    { id: 'one', spaceId: 'general', title: 'API docs', url: 'https://example.com/docs', lastActive: 1 },
    { id: 'two', spaceId: 'aws-prod', title: 'Console', url: 'https://console.aws.amazon.com/ec2/', lastActive: 2 }
  ], activeTab: { general: 'one', 'aws-prod': 'two' }, activeSpace: 'aws-prod',
  history: [{ url: 'https://private.example', title: 'Private', spaceId: 'general', at: 10 }], downloads: [], zoom: 1.2
})
const sequence = () => { let n = 0; return () => `fresh-${++n}` }

test('legacy remote workspaces remain readable and summaries include tools', () => {
  const w: Workspace = { id: 'old', name: 'Legacy', savedAt: 0, tabs: [{ kind: 'ssh', instanceKey: 'prod/us/i-1' }] }
  assert.equal(workspaceSize(w), 1)
  assert.equal(workspaceSummary(w), '1 remote session')
  w.tools = [{ id: 'terminal', kind: 'local', terminal: captureTerminal(terminal()) }, { id: 'notes', kind: 'notes', path: 'Runbook.md' }]
  assert.equal(workspaceSize(w), 3)
  assert.match(workspaceSummary(w), /1 remote session · 2 terminal tabs · Notes/)
})

test('layout drops missing panes, normalizes surviving widths, and collapses nested splits', () => {
  const root = split([pane('a'), split([pane('b'), pane('c')], [.5, .5]), pane('d')], [.5, .3, .2])
  const before = structuredClone(root)
  assert.deepEqual(workspaceLayout(root, new Map([['a', 'A'], ['c', 'C']])), split([pane('A'), pane('C')], [.5 / .8, .3 / .8]))
  assert.deepEqual(root, before)
  assert.equal(workspaceLayout(root, new Map()), null)
  assert.deepEqual(workspaceLayout(root, new Map([['d', 'D']])), pane('D'))
})

test('layout de-duplicates singleton tools and handles invalid saved shares', () => {
  assert.deepEqual(workspaceLayout(split([pane('a'), pane('b'), pane('c')], [NaN, 0, -1]), new Map([['a', 'A'], ['b', 'A'], ['c', 'C']])), split([pane('A'), pane('C')], [.5, .5]))
})

test('terminal capture includes only selected tabs and their directories, without UI/session state', () => {
  const s = terminal()
  const saved = captureTerminal(s, ['logs'])
  assert.equal(saved.activeTab, 'logs')
  assert.deepEqual(saved.cwds, { c: '/logs' })
  assert.equal(saved.tabs.length, 1)
  assert.equal('input' in saved, false)
  assert.equal('workspaceSource' in captureTerminal(s).tabs[0], false)
  assert.equal('maximized' in captureTerminal(s).tabs[0], false)
  saved.tabs[0].root = pane('changed')
  assert.deepEqual(s.tabs[1].root, pane('c'))
})

test('terminal restore remaps all pane ids, keeps splits/profiles/cwds, and leaves existing shells untouched', () => {
  const current: TerminalState = { tabs: [{ id: 'live', root: pane('live-pane'), activePane: 'live-pane' }], activeTab: 'live', cwds: { 'live-pane': '/running' }, input: 'shell' }
  const before = structuredClone(current)
  const restored = restoreTerminal(current, captureTerminal(terminal(), ['build']), 'project', sequence())
  assert.deepEqual(current, before)
  assert.equal(restored.tabs[0], current.tabs[0])
  assert.equal(restored.tabs.length, 2)
  assert.equal(restored.input, 'shell')
  assert.equal(restored.activeTab, 'fresh-3')
  assert.deepEqual(restored.tabs[1].root, split([pane('fresh-1'), pane('fresh-2')], [.7, .3]))
  assert.equal(restored.tabs[1].activePane, 'fresh-2')
  assert.equal(restored.tabs[1].profile, 'production')
  assert.deepEqual(restored.cwds, { 'live-pane': '/running', 'fresh-1': '/repo', 'fresh-2': '/repo/api' })
})

test('repeated terminal restore reuses running tabs without resetting their directories', () => {
  const saved = captureTerminal(terminal())
  const current: TerminalState = { tabs: [], activeTab: '', cwds: {} }
  const next = restoreTerminal(current, saved, 'project', sequence())
  next.cwds[next.tabs[0].activePane] = '/now-elsewhere'
  const again = restoreTerminal(next, saved, 'project', () => { throw new Error('must reuse') })
  assert.equal(again.tabs.length, 2)
  assert.equal(again.cwds[next.tabs[0].activePane], '/now-elsewhere')
  assert.equal(restoreTerminal(terminal(), saved, 'project', () => { throw new Error('original still open') }).tabs.length, 2)
})

test('workspace URLs remove auth handoffs/credentials while retaining useful page routes', () => {
  assert.equal(workspacePageUrl('https://user:secret@example.com/issues?q=hello&access_token=secret#section'), 'https://example.com/issues?q=hello#section')
  assert.equal(workspacePageUrl('https://signin.aws.amazon.com/federation?SigninToken=secret&Destination=https%3A%2F%2Fconsole.aws.amazon.com%2Fec2%2F'), 'https://console.aws.amazon.com/ec2/')
  assert.equal(workspacePageUrl('https://example.com/#access_token=secret&state=123'), 'https://example.com/')
  assert.equal(workspacePageUrl('https://example.com/?X-Amz-Signature=secret&x=1'), 'https://example.com/?x=1')
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hello', 'invalid', 'https://signin.aws.amazon.com/federation?Destination=javascript:alert(1)']) assert.equal(workspacePageUrl(url), '')
})

test('browser capture filters page selections and never copies history, downloads, or space configuration', () => {
  const saved = captureBrowser(browser(), ['one'])
  assert.equal(saved.activeSpace, 'general')
  assert.deepEqual(saved.activeTab, { general: 'one' })
  assert.deepEqual(Object.keys(saved).sort(), ['activeSpace', 'activeTab', 'tabs'])
  assert.equal(saved.tabs.length, 1)
})

test('browser restore reuses pages only in the same account space', () => {
  const current = browser()
  const saved = captureBrowser(current)
  const before = structuredClone(current)
  saved.tabs.push({ ...saved.tabs[0], id: 'other-account', spaceId: 'aws-prod' })
  const { state, skipped } = restoreBrowser(current, saved, ['general', 'aws-prod'], sequence())
  assert.equal(skipped, 0)
  assert.equal(state.tabs.length, 3)
  assert.equal(state.tabs[2].id, 'fresh-1')
  assert.equal(state.tabs[2].spaceId, 'aws-prod')
  assert.equal(state.tabs[0], current.tabs[0])
  assert.equal(state.zoom, 1.2)
  assert.deepEqual(current, before)
  assert.equal(restoreBrowser(state, saved, ['general', 'aws-prod'], sequence()).state.tabs.length, 3)
})

test('missing browser spaces are skipped, and focus falls back to an available selected page', () => {
  const current = browser()
  current.tabs = []
  const { state, skipped } = restoreBrowser(current, captureBrowser(browser()), ['general'], sequence())
  assert.equal(skipped, 1)
  assert.equal(state.tabs.length, 1)
  assert.equal(state.activeSpace, 'general')
  assert.equal(state.activeTab.general, state.tabs[0].id)
  assert.equal(state.tabs.some((t) => t.url.includes('console.aws')), false)
})

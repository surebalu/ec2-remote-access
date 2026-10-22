import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fillExtensionApis, type ExtensionFrame } from '../src/shared/extensionApis.ts'

const ID = 'aeblfdkhhhdcdjpifhhbdiojplfjncoa'
type Api = Record<string, any>

/** A worker's globals as Electron leaves them: `chrome` and Chromium's own `browser` share namespaces, not objects. */
function worker(opts: { url?: string; popup?: string; manifest?: object } = {}): { chrome: Api; browser: Api; opened: [string, boolean][]; tabsGet: number[] } {
  const opened: [string, boolean][] = []
  const tabsGet: number[] = []
  let popup = opts.popup ?? ''
  const nativeClicked = { addListener: () => undefined }
  const shared = {
    runtime: { id: ID, getManifest: () => opts.manifest ?? { permissions: ['storage', 'tabs'], host_permissions: ['<all_urls>'], commands: { _execute_action: { description: 'Open' } } } },
    tabs: { query: async () => [], get: async (id: number) => { tabsGet.push(id); return { id, url: 'https://example.com/' } } },
    action: { onClicked: nativeClicked, getPopup: async () => popup, setPopup: async (p: { popup: string }) => { popup = p.popup } }
  }
  const chrome: Api = { ...shared }
  const browser: Api = { ...shared }
  Object.assign(globalThis, { chrome, browser, location: { protocol: new URL(opts.url ?? `chrome-extension://${ID}/background.js`).protocol, href: opts.url ?? `chrome-extension://${ID}/background.js` } })
  return { chrome, browser, opened, tabsGet }
}

/** Tab 7: a login page with 1Password's fill menu in an iframe of its own (what main answers for it). */
const PAGE: ExtensionFrame[] = [
  { frameId: 0, parentFrameId: -1, url: 'https://login.example/', processId: 9, errorOccurred: false, documentLifecycle: 'active', frameType: 'outermost_frame' },
  { frameId: 41, parentFrameId: 0, url: `chrome-extension://${ID}/inline/menu/menu.html`, processId: 3, errorOccurred: false, documentLifecycle: 'active', frameType: 'sub_frame' }
]
const fill = (opened: [string, boolean][]): ReturnType<typeof fillExtensionApis> =>
  fillExtensionApis((url, active) => { opened.push([url, active]) }, async (tabId) => (tabId === 7 ? PAGE : null))

test('does nothing in a website\'s service worker', () => {
  const w = worker({ url: 'https://example.com/sw.js' })
  assert.equal(fill(w.opened), null)
  assert.equal(w.chrome.contextMenus, undefined)
})

test('the missing namespaces, on chrome and on browser', () => {
  const w = worker()
  const tabsQuery = w.chrome.tabs.query
  fill(w.opened)
  // 1Password's first lines: these threw and the worker never registered.
  w.chrome.contextMenus.onClicked.addListener(() => undefined)
  assert.equal(w.browser.windows.WINDOW_ID_NONE, -1)
  assert.equal(w.browser.contextMenus, w.chrome.contextMenus, 'one object for both')
  assert.equal(w.chrome.tabs.query, tabsQuery, 'what Electron has is left alone')
  assert.equal(w.chrome.tabs.TAB_ID_NONE, -1)
  for (const ns of ['notifications', 'downloads', 'privacy', 'webNavigation', 'permissions', 'commands', 'sidePanel']) assert.equal(typeof w.chrome[ns], 'object', ns)
  assert.equal(w.chrome.webNavigation.onCommitted.hasListeners(), false)
})

test('answers through a callback or a promise, as Chrome does', async () => {
  const w = worker()
  fill(w.opened)
  assert.deepEqual(await w.chrome.privacy.services.passwordSavingEnabled.get({}), { value: false, levelOfControl: 'not_controllable' })
  const all = await new Promise((resolve) => w.chrome.notifications.getAll(resolve))
  assert.deepEqual(all, {})
  assert.equal(await w.chrome.notifications.create('n1', {}), 'n1')
  assert.equal(w.chrome.contextMenus.create({ id: 'fill', title: 'Fill' }), 'fill', 'the id comes back at once')
  assert.equal((await w.chrome.windows.getCurrent()).id, 1)
  assert.deepEqual(await w.chrome.commands.getAll(), [{ name: '_execute_action', description: 'Open', shortcut: '' }])
})

test('a page\'s frames come from main', async () => {
  const w = worker()
  fill(w.opened)
  // 1Password passes a login picked in its menu to the menu's parent frame.
  assert.equal((await w.browser.webNavigation.getFrame({ tabId: 7, frameId: 41 })).parentFrameId, 0)
  assert.deepEqual(await w.chrome.webNavigation.getAllFrames({ tabId: 7 }), PAGE)
  assert.equal(await w.chrome.webNavigation.getFrame({ tabId: 7, frameId: 5 }), null)
  assert.equal(await w.chrome.webNavigation.getAllFrames({ tabId: 8 }), null, 'a page not in this space')
  const top = await new Promise((resolve) => w.chrome.webNavigation.getFrame({ tabId: 7, frameId: 0 }, resolve))
  assert.equal((top as ExtensionFrame).url, 'https://login.example/')
})

test('permissions are what the manifest gave', async () => {
  const w = worker()
  fill(w.opened)
  assert.equal(await w.chrome.permissions.contains({ permissions: ['storage'], origins: ['https://example.com/*'] }), true)
  assert.equal(await w.chrome.permissions.contains({ permissions: ['downloads'] }), false)
  assert.equal(await w.chrome.permissions.request({ permissions: ['downloads'] }), false, 'nothing can be granted later')
})

test('tabs.create and windows.create open Browser tabs', async () => {
  const w = worker()
  fill(w.opened)
  const tab = await w.chrome.tabs.create({ url: '/app/app.html#/page/welcome' })
  assert.equal(tab.pendingUrl, `chrome-extension://${ID}/app/app.html#/page/welcome`)
  await w.chrome.tabs.create({ url: 'https://start.1password.com/', active: false })
  await w.chrome.windows.create({ url: ['https://a.example/', 'https://b.example/'] })
  await w.chrome.tabs.create({})
  assert.deepEqual(w.opened, [
    [`chrome-extension://${ID}/app/app.html#/page/welcome`, true],
    ['https://start.1password.com/', false],
    ['https://a.example/', true],
    ['https://b.example/', true]
  ])
})

test('the toolbar click: the popup when one is set, else onClicked', async () => {
  const w = worker()
  const click = fill(w.opened)!
  const got: unknown[] = []
  w.browser.action.onClicked.addListener((tab: unknown) => got.push(tab))
  assert.equal(await click(12), '', 'no popup set: the extension took it')
  assert.deepEqual(got, [{ id: 12, url: 'https://example.com/' }])
  await w.chrome.action.setPopup({ popup: 'popup/index.html' })
  assert.equal(await click(12), `chrome-extension://${ID}/popup/index.html`)
  assert.equal(got.length, 1, 'a popup means no onClicked')
})

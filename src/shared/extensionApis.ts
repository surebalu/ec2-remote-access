/**
 * Stand-ins for the Chrome extension APIs Electron does not have, put into each extension's service worker before the
 * extension's own script runs (src/preload/extensionWorker.ts). Electron gives a worker no chrome.contextMenus,
 * notifications, downloads, privacy, webNavigation, windows, permissions or commands, and no tabs.create; a background
 * script that touches one at start-up throws, the worker never registers, and the extension is dead: 1Password reads
 * chrome.contextMenus.onClicked first thing, and its popup then waits for the background for ever. The stand-ins take
 * every call and do nothing (events never fire, getters answer "nothing" or "not allowed"), except what the Browser
 * can really do for an extension: open a tab (tabs.create, windows.create with a url), name a page's frames
 * (webNavigation.getFrame / getAllFrames, from main: 1Password's fill menu is an iframe of its own, and picking a login
 * there is passed to the page's frame found this way) and the toolbar. Electron has none, and its chrome.action keeps
 * nothing (getPopup answers '' even for the manifest's popup), so the popup an extension sets is kept in main,
 * onClicked is fired from here and openPopup opens the Browser's Extensions panel: 1Password sets no popup while no
 * account is signed in (a click opens its sign-in page) and, locked, asks for its popup to be opened to unlock.
 *
 * `fillExtensionApis` is serialized into the worker (contextBridge.executeInMainWorld), so it must not use anything
 * from outside its own body. tests/extensionApis.test.ts runs it against a fake `chrome`.
 */

/** Presses the toolbar button: the popup page to show (an absolute URL), or '' when the click went to onClicked. */
export type ExtensionClick = (tabId: number | null) => Promise<string>

/** What the worker asks of main (src/preload/extensionWorker.ts carries it). */
export interface ExtensionBridge {
  /** Opens a page as a Browser tab in the extension's space. */
  openTab: (url: string, active: boolean) => void
  /** The frames of the page with this tab id, or null when it is no page of this space. */
  frames: (tabId: number) => Promise<ExtensionFrame[] | null>
  /** Shows this popup page in the Browser's Extensions panel. */
  openPopup: (url: string) => void
  /** action.setPopup: the page (absolute, '' for none), for one tab or (null) every tab. Kept in main. */
  setPopup: (url: string, tabId: number | null) => void
  /** What was set for that tab, else for every tab; null when the extension never set one. */
  getPopup: (tabId: number | null) => Promise<string | null>
}

/** A frame as webNavigation.getAllFrames gives it: frameId 0 is the top frame, parentFrameId -1 means none. */
export interface ExtensionFrame {
  frameId: number
  parentFrameId: number
  url: string
  processId: number
  errorOccurred: boolean
  documentLifecycle: 'active'
  frameType: 'outermost_frame' | 'sub_frame'
}

/**
 * Fills the missing APIs in on `chrome` (and Chromium's own `browser`, a second object that shares chrome's
 * namespaces, so a namespace added to one is not on the other). Does nothing outside an extension's worker (the
 * preload runs in websites' service workers too) and returns null there.
 */
export function fillExtensionApis(bridge: ExtensionBridge): ExtensionClick | null {
  type Fn = (...args: unknown[]) => unknown
  type Api = Record<string, unknown>
  const g = globalThis as unknown as { chrome?: Record<string, Api | undefined>; browser?: Record<string, Api | undefined>; location?: { protocol: string; href: string } }
  const chrome = g.chrome
  const here = g.location
  if (!chrome?.runtime || here?.protocol !== 'chrome-extension:') return null
  const call = (api: Api | undefined, name: string, ...args: unknown[]): Promise<unknown> => Promise.resolve().then(() => (api?.[name] as Fn)(...args))

  const event = (fns = new Set<Fn>()): Api => ({
    addListener: (f: Fn) => { fns.add(f) },
    removeListener: (f: Fn) => { fns.delete(f) },
    hasListener: (f: Fn) => fns.has(f),
    hasListeners: () => fns.size > 0
  })
  // A call that does nothing and answers `value` (or what `value` makes of the arguments): through the callback when
  // the last argument is one, else as a promise, as Chrome's own APIs do.
  const answers = (value?: unknown) => (...args: unknown[]): unknown => {
    const done = args[args.length - 1]
    const result = Promise.resolve(typeof value === 'function' ? (value as Fn)(...args) : value)
    if (typeof done !== 'function') return result
    void result.then((v) => (done as Fn)(v))
    return undefined
  }
  const nothing = (): Fn => answers(undefined) as Fn
  const events = (...names: string[]): Record<string, () => unknown> => Object.fromEntries(names.map((n) => [n, () => event()]))
  const setting = (): Api => ({ get: answers({ value: false, levelOfControl: 'not_controllable' }), set: nothing(), clear: nothing(), onChange: event() })
  const settings = (...names: string[]): () => Api => () => Object.fromEntries(names.map((n) => [n, setting()]))

  const manifest = ((chrome.runtime.getManifest as Fn | undefined)?.() ?? {}) as {
    permissions?: string[]; host_permissions?: string[]; commands?: Record<string, { description?: string }>
    action?: { default_popup?: string }; browser_action?: { default_popup?: string }
  }
  const granted = new Set([...(manifest.permissions ?? []), ...(manifest.host_permissions ?? [])])
  const has = (p: { permissions?: string[]; origins?: string[] } = {}): boolean =>
    (p.permissions ?? []).every((x) => granted.has(x)) && (p.origins ?? []).every((x) => granted.has(x) || granted.has('<all_urls>'))

  const open = (url: unknown, active: unknown): string | null => {
    if (typeof url !== 'string' || !url) return null
    let abs: string
    try { abs = new URL(url, here.href).href } catch { return null }
    bridge.openTab(abs, active !== false)
    return abs
  }
  const WINDOW = { id: 1, focused: true, incognito: false, alwaysOnTop: false, type: 'normal', state: 'normal' }
  let next = 0

  const missing: Record<string, Record<string, () => unknown>> = {
    tabs: {
      TAB_ID_NONE: () => -1,
      TAB_INDEX_NONE: () => -1,
      ...events('onActivated', 'onAttached', 'onCreated', 'onDetached', 'onHighlighted', 'onMoved', 'onRemoved', 'onReplaced', 'onUpdated', 'onZoomChange'),
      // The page opens as a Browser tab in this space; the tab object is a placeholder (the real tab's id is not known yet).
      create: () => answers((p?: { url?: string; active?: boolean }) => {
        const url = open(p?.url, p?.active)
        return { id: -1, index: -1, windowId: WINDOW.id, active: p?.active !== false, highlighted: p?.active !== false, pinned: false, incognito: false, url: url ?? undefined, pendingUrl: url ?? undefined }
      }),
      remove: nothing, duplicate: nothing, discard: nothing, goBack: nothing, goForward: nothing, highlight: nothing, move: nothing,
      group: nothing, ungroup: nothing, getCurrent: nothing, captureVisibleTab: nothing, insertCSS: nothing, detectLanguage: () => answers('und')
    },
    windows: {
      WINDOW_ID_NONE: () => -1,
      WINDOW_ID_CURRENT: () => -2,
      ...events('onCreated', 'onRemoved', 'onFocusChanged', 'onBoundsChanged'),
      get: () => answers(WINDOW), getCurrent: () => answers(WINDOW), getLastFocused: () => answers(WINDOW), getAll: () => answers([WINDOW]),
      // A new window's pages open as tabs.
      create: () => answers((p?: { url?: string | string[]; focused?: boolean }) => {
        for (const u of Array.isArray(p?.url) ? p.url : [p?.url]) open(u, p?.focused)
        return WINDOW
      }),
      update: () => answers(WINDOW), remove: nothing
    },
    contextMenus: {
      ACTION_MENU_TOP_LEVEL_LIMIT: () => 6,
      onClicked: () => event(),
      // Chrome returns the new item's id at once, not through the callback.
      create: () => (p?: { id?: string }, done?: unknown) => {
        if (typeof done === 'function') setTimeout(done as Fn)
        return p?.id ?? ++next
      },
      update: nothing, remove: nothing, removeAll: nothing
    },
    notifications: {
      ...events('onClicked', 'onClosed', 'onButtonClicked', 'onPermissionLevelChanged', 'onShowSettings'),
      create: () => answers((id?: unknown) => (typeof id === 'string' ? id : `n${++next}`)),
      update: () => answers(false), clear: () => answers(false), getAll: () => answers({}), getPermissionLevel: () => answers('denied')
    },
    downloads: {
      ...events('onCreated', 'onChanged', 'onErased', 'onDeterminingFilename'),
      download: nothing, search: () => answers([]), pause: nothing, resume: nothing, cancel: nothing, erase: () => answers([]), open: nothing, show: nothing, showDefaultFolder: nothing
    },
    privacy: {
      services: settings('alternateErrorPagesEnabled', 'autofillEnabled', 'autofillAddressEnabled', 'autofillCreditCardEnabled', 'passwordSavingEnabled', 'safeBrowsingEnabled', 'searchSuggestEnabled', 'spellingServiceEnabled', 'translationServiceEnabled'),
      network: settings('networkPredictionEnabled', 'webRTCIPHandlingPolicy'),
      websites: settings('thirdPartyCookiesAllowed', 'hyperlinkAuditingEnabled', 'referrersEnabled', 'doNotTrackEnabled', 'protectedContentEnabled')
    },
    webNavigation: {
      ...events('onBeforeNavigate', 'onCommitted', 'onDOMContentLoaded', 'onCompleted', 'onErrorOccurred', 'onCreatedNavigationTarget', 'onReferenceFragmentUpdated', 'onTabReplaced', 'onHistoryStateUpdated'),
      getFrame: () => answers(async (d?: { tabId?: number; frameId?: number }) => (await bridge.frames(Number(d?.tabId)))?.find((f) => f.frameId === d?.frameId) ?? null),
      getAllFrames: () => answers((d?: { tabId?: number }) => bridge.frames(Number(d?.tabId)))
    },
    // What it was given at load is all it has: nothing can be granted later.
    permissions: {
      ...events('onAdded', 'onRemoved'),
      contains: () => answers(has), request: () => answers(has), remove: () => answers(false),
      getAll: () => answers({ permissions: (manifest.permissions ?? []).filter((x) => !x.includes('://')), origins: manifest.host_permissions ?? [] }),
      addHostAccessRequest: nothing, removeHostAccessRequest: nothing
    },
    commands: {
      ...events('onCommand', 'onChanged'),
      getAll: () => answers(Object.entries(manifest.commands ?? {}).map(([name, c]) => ({ name, description: c.description ?? '', shortcut: '' }))),
      update: nothing, reset: nothing
    },
    sidePanel: { ...events('onOpened', 'onClosed'), setOptions: nothing, getOptions: () => answers({ enabled: false }), setPanelBehavior: nothing, getPanelBehavior: () => answers({ openPanelOnActionClick: false }), open: nothing }
  }
  const roots = [chrome, g.browser].filter((r, i, all): r is Record<string, Api | undefined> => !!r && all.indexOf(r) === i)
  for (const [name, members] of Object.entries(missing)) {
    const api = chrome[name] ?? {}
    for (const [member, make] of Object.entries(members)) if (!(member in api)) api[member] = make()
    for (const r of roots) if (!r[name]) r[name] = api
  }

  // The toolbar button. Electron keeps the popup an extension sets (action.setPopup) but never fires onClicked, so it
  // is replaced by one this side can fire: a click with no popup set goes to the extension, as in Chrome. openPopup
  // shows the popup set now in the Browser's Extensions panel.
  const action = chrome.action ?? chrome.browserAction
  const clicks = new Set<Fn>()
  const declared = (manifest.action ?? manifest.browser_action)?.default_popup ?? ''
  const popupFor = async (tabId: number | null): Promise<string> => {
    const popup = (await bridge.getPopup(tabId).catch(() => null)) ?? declared
    return popup ? new URL(popup, here.href).href : ''
  }
  const tabOf = (d?: { tabId?: unknown }): number | null => (typeof d?.tabId === 'number' ? d.tabId : null)
  if (action) {
    action.onClicked = event(clicks)
    action.setPopup = answers((d?: { popup?: string; tabId?: number }) => { bridge.setPopup(d?.popup ? new URL(d.popup, here.href).href : '', tabOf(d)) })
    action.getPopup = answers((d?: { tabId?: number }) => popupFor(tabOf(d)))
    action.openPopup = async (): Promise<void> => {
      const popup = await popupFor(null)
      if (popup) bridge.openPopup(popup)
    }
  }
  return async (tabId) => {
    if (!action) return ''
    const popup = await popupFor(tabId)
    if (popup) return popup
    const tab = tabId == null ? undefined : await call(chrome.tabs, 'get', tabId).catch(() => undefined)
    for (const f of clicks) {
      try { f(tab ?? { id: tabId ?? -1, windowId: WINDOW.id, active: true }) } catch (e) { console.error(e) }
    }
    return ''
  }
}

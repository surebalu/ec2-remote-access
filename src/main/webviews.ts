/**
 * The built-in browser's pages are <webview> guests of the app window. This keeps them a plain browser: no preload,
 * no Node, sandboxed, only web addresses, each space's own partition, and no permissions beyond clipboard writes and
 * full screen. It also gives pages what a browser has and a bare guest lacks: new windows become tabs, a context menu,
 * app shortcuts while a page has the keyboard, and download notices. Electron-only (index.ts calls it).
 */
import { app, BrowserWindow, clipboard, Menu, shell, type MenuItemConstructorOptions, type Session, type WebContents } from 'electron'
import { isWebUrl } from '@shared/browser'

/** Shortcuts the browser tab handles even while a page has focus (pages otherwise swallow them). */
const FORWARDED = new Set(['t', 'w', 'l', 'r', '[', ']', '{', '}', 'f', 'k', 's', 'd', '=', '+', '-', '0', 'n', 'b', 'c'])
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen'])

export function initWebviews(win: BrowserWindow): void {
  // Whatever the renderer asks for, a guest gets a locked-down page in one of the browser's own partitions.
  win.webContents.on('will-attach-webview', (event, prefs, params) => {
    delete prefs.preload
    prefs.nodeIntegration = false
    prefs.nodeIntegrationInSubFrames = false
    prefs.contextIsolation = true
    prefs.sandbox = true
    prefs.webSecurity = true
    if (!params.partition?.startsWith('persist:web-') || !isWebUrl(params.src)) event.preventDefault()
  })
}

const seenSessions = new WeakSet<Session>()

/** Per-partition setup, once: deny permissions, report downloads. */
function prepareSession(session: Session, host: WebContents): void {
  if (seenSessions.has(session)) return
  seenSessions.add(session)
  session.setPermissionRequestHandler((_wc, permission, done) => done(ALLOWED_PERMISSIONS.has(permission)))
  session.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission))
  session.on('will-download', (_e, item) => {
    item.once('done', (_ev, state) => {
      if (!host.isDestroyed()) host.send('web:download', { name: item.getFilename(), path: item.getSavePath(), state })
    })
  })
}

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return
  const host = (): WebContents | undefined => contents.hostWebContents ?? undefined
  const h0 = host()
  if (h0) prepareSession(contents.session, h0)
  else contents.once('did-start-loading', () => { const h = host(); if (h) prepareSession(contents.session, h) })

  contents.setWindowOpenHandler(({ url, disposition }) => {
    if (isWebUrl(url)) host()?.send('web:window', { webContentsId: contents.id, url, background: disposition === 'background-tab' })
    return { action: 'deny' }
  })
  contents.on('will-navigate', (e, url) => { if (!isWebUrl(url)) e.preventDefault() })
  contents.on('will-frame-navigate', (e) => { if (e.isMainFrame && !isWebUrl(e.url)) e.preventDefault() })

  contents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return
    const key = input.key.toLowerCase()
    // ⌥⌘↑/↓ switch spaces; plain ⌘↑/↓ stay with the page (top / bottom of a field or the page).
    const forward = (input.control && key === 'tab') || (input.meta && (FORWARDED.has(key) || /^[1-9]$/.test(key) || (input.alt && (key === 'arrowup' || key === 'arrowdown'))))
    // The page keeps its editing keys (copy, paste, select all, undo); ⌘⇧C (copy the address) is the browser's.
    if (!forward || (input.meta && !input.shift && ['c', 'v', 'x', 'a', 'z'].includes(key))) return
    e.preventDefault()
    host()?.send('web:shortcut', { webContentsId: contents.id, key, shift: input.shift, alt: input.alt })
  })

  contents.on('context-menu', (_e, p) => {
    const h = host()
    const send = (url: string, background = true): void => h?.send('web:window', { webContentsId: contents.id, url, background })
    const items: MenuItemConstructorOptions[] = []
    if (p.linkURL && isWebUrl(p.linkURL)) {
      items.push(
        { label: 'Open Link in New Tab', click: () => send(p.linkURL) },
        { label: 'Open Link in Your Browser', click: () => void shell.openExternal(p.linkURL) },
        { label: 'Copy Link', click: () => clipboard.writeText(p.linkURL) },
        { type: 'separator' }
      )
    }
    if (p.mediaType === 'image' && p.srcURL) {
      items.push(
        { label: 'Open Image in New Tab', click: () => send(p.srcURL) },
        { label: 'Copy Image', click: () => contents.copyImageAt(p.x, p.y) },
        { label: 'Copy Image Address', click: () => clipboard.writeText(p.srcURL) },
        { type: 'separator' }
      )
    }
    if (p.isEditable) {
      items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'selectAll' }, { type: 'separator' })
    } else if (p.selectionText.trim()) {
      const text = p.selectionText.trim()
      items.push(
        { role: 'copy' },
        { label: `Search Google for “${text.length > 30 ? `${text.slice(0, 30)}…` : text}”`, click: () => send(`https://www.google.com/search?q=${encodeURIComponent(text)}`, false) },
        { type: 'separator' }
      )
    }
    items.push(
      { label: 'Back', enabled: contents.navigationHistory.canGoBack(), click: () => contents.navigationHistory.goBack() },
      { label: 'Forward', enabled: contents.navigationHistory.canGoForward(), click: () => contents.navigationHistory.goForward() },
      { label: 'Reload', click: () => contents.reload() },
      { type: 'separator' },
      { label: 'Copy Page Address', click: () => clipboard.writeText(contents.getURL()) },
      ...(process.platform === 'darwin' ? [{ role: 'shareMenu' as const, sharingItem: { urls: [contents.getURL()] } }] : []),
      { label: "Add Page to Today's Note", click: () => h?.send('web:menu', { webContentsId: contents.id, action: 'note', url: contents.getURL(), title: contents.getTitle() }) },
      { label: 'Open Page in Your Browser', click: () => void shell.openExternal(contents.getURL()) },
      { type: 'separator' },
      { label: 'Inspect Element', click: () => contents.inspectElement(p.x, p.y) }
    )
    const owner = h ? BrowserWindow.fromWebContents(h) : null
    Menu.buildFromTemplate(items).popup(owner ? { window: owner } : {})
  })
})

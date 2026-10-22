/**
 * The built-in browser's pages are <webview> guests of the app window. This keeps them a plain browser: no preload,
 * no Node, sandboxed, only web addresses, each space's own partition, and no permissions beyond clipboard writes and
 * full screen. It also gives pages what a browser has and a bare guest lacks: new windows become tabs, a context menu,
 * app shortcuts while a page has the keyboard, and download notices. Electron-only (index.ts calls it).
 */
import { existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { app, BrowserWindow, clipboard, Menu, shell, webContents, type DownloadItem, type MenuItemConstructorOptions, type Session, type WebContents } from 'electron'
import { isWebUrl, loginMatches } from '@shared/browser'
import { isAllowedExtensionPage, openFromExtension } from './extensions'
import { isDictationKey } from '@shared/dictation'
import { comboOf, sectionFor } from '@shared/keyCombos'
import type { WebDownload } from '@shared/types'
import { getSettings } from './store'
import { isDictating } from './voice'
import { getPaneTargets } from './browser'
import { track } from './sessionCookies'

/**
 * Shortcuts the browser tab handles even while a page has focus (pages otherwise swallow them); ⌘\ opens beside. The
 * rail sections' own shortcuts (Settings → Keyboard) are passed on too.
 */
const FORWARDED = new Set(['t', 'w', 'l', 'r', '[', ']', '{', '}', 'f', 'k', 's', 'd', '=', '+', '-', '0', 'n', 'b', 'c', '\\'])
/**
 * Claude's and ChatGPT's pages (their own partitions, persist:web-app-*) keep their own shortcuts (⌘⇧C copies the
 * last code block, ⌘⇧S folds the sidebar…); only the app's tab and pane keys leave them.
 */
const CHAT_FORWARDED = new Set(['t', 'w', 'r', '[', ']', '{', '}', 'n', 'k', '\\', ','])
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
    // An extension's popup or options page is shown in a webview of the space it runs in.
    if (!params.partition?.startsWith('persist:web-') || !(isWebUrl(params.src) || isAllowedExtensionPage(params.src))) event.preventDefault()
    // Its session cookies (sign-ins) are kept across restarts from here on.
    else track(params.partition)
  })
}

const seenSessions = new WeakSet<Session>()
/** Downloads still running, by the id the renderer knows them by (for Cancel). */
const running = new Map<string, DownloadItem>()
const reserved = new Set<string>()

/** "report.pdf" in the Downloads folder, or "report (1).pdf" when that is taken (also by a download in progress). */
function freePath(dir: string, name: string): string {
  const ext = extname(name)
  const stem = basename(name, ext) || 'download'
  let p = join(dir, `${stem}${ext}`)
  for (let n = 1; existsSync(p) || reserved.has(p); n++) p = join(dir, `${stem} (${n})${ext}`)
  return p
}

export function cancelDownload(id: string): void {
  running.get(id)?.cancel()
}

/**
 * Finds the login fields of the page and types the values in: the username field before the password field (or one
 * marked autocomplete=username/email), the password field, and a one-time code field on a page that asks only for a
 * code. Values go through the native setter plus input/change events so frameworks (React, Angular) see them.
 */
const FILL_SCRIPT = `(v) => {
  const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
  const inputs = [...document.querySelectorAll('input')].filter((i) => visible(i) && !i.disabled && !i.readOnly)
  const hint = (i) => [i.name, i.id, i.placeholder, i.getAttribute('aria-label'), i.autocomplete].join(' ')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  const put = (el, value) => { el.focus(); setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })) }
  const textual = (i) => ['text', 'email', 'tel', ''].includes(i.type)
  const filled = []
  const pw = inputs.find((i) => i.type === 'password')
  if (v.username) {
    const user = inputs.find((i) => /username|email/.test(i.autocomplete))
      ?? (pw ? inputs.slice(0, inputs.indexOf(pw)).reverse().find(textual) : inputs.find((i) => textual(i) && /user|login|mail|account|name/i.test(hint(i))))
    if (user) { put(user, v.username); filled.push('username') }
  }
  if (pw && v.password) { put(pw, v.password); filled.push('password') }
  if (!pw && v.otp) {
    const code = inputs.find((i) => i.autocomplete === 'one-time-code' || /otp|totp|mfa|2fa|one.?time|verif|code/i.test(hint(i)))
    if (code) { put(code, v.otp); filled.push('code') }
  }
  if (filled.length) document.activeElement?.blur?.()
  return filled
}`

/**
 * Types a login into a browser page. Runs in an isolated world (page scripts cannot see or patch the code doing it)
 * and checks, right before filling, that the page is still on a site the login is saved for (unless `allowedUrls` is
 * null because the user confirmed another site).
 */
export async function fillPage(webContentsId: number, values: { username?: string; password?: string; otp?: string }, allowedUrls: string[] | null): Promise<string[]> {
  const wc = webContents.fromId(webContentsId)
  if (!wc || wc.isDestroyed() || wc.getType() !== 'webview') throw new Error('That page is closed.')
  if (allowedUrls && !loginMatches(allowedUrls, wc.getURL())) throw new Error('This page is not on the site the login is saved for; nothing was filled.')
  const result = await wc.executeJavaScriptInIsolatedWorld(1000, [{ code: `(${FILL_SCRIPT})(${JSON.stringify(values)})` }], true)
  return Array.isArray(result) ? result.map(String) : []
}

/** Per-partition setup, once: deny permissions, report downloads. */
function prepareSession(session: Session, host: WebContents): void {
  if (seenSessions.has(session)) return
  seenSessions.add(session)
  session.setPermissionRequestHandler((_wc, permission, done) => done(ALLOWED_PERMISSIONS.has(permission)))
  session.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission))
  // Like a browser, files go straight to Downloads (no save dialog), and the sidebar's Downloads button shows them.
  session.on('will-download', (_e, item) => {
    const id = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const path = freePath(app.getPath('downloads'), item.getFilename())
    item.setSavePath(path)
    reserved.add(path)
    running.set(id, item)
    const at = Date.now()
    const report = (state: WebDownload['state'], icon?: string): void => {
      if (!host.isDestroyed()) host.send('web:download', { id, name: basename(path), path, state, received: item.getReceivedBytes(), total: item.getTotalBytes(), at, icon })
    }
    report('progressing')
    let last = 0
    item.on('updated', () => {
      if (Date.now() - last < 300) return
      last = Date.now()
      report('progressing')
    })
    item.once('done', (_ev, state) => {
      running.delete(id)
      reserved.delete(path)
      if (state !== 'completed') return report(state)
      app.getFileIcon(path, { size: 'normal' }).then((i) => report(state, i.toDataURL()), () => report(state))
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
    const background = disposition === 'background-tab'
    // An extension's own page (its popup, which is no tab, or a page of it in a tab) opens links in the space it runs in.
    if (contents.getURL().startsWith('chrome-extension://')) openFromExtension(contents.session, contents.getURL(), url, !background)
    else if (isWebUrl(url)) host()?.send('web:window', { webContentsId: contents.id, url, background })
    return { action: 'deny' }
  })
  // Web pages, and the pages of an enabled extension (its sign-in page moving on to the next step).
  const mayShow = (url: string): boolean => isWebUrl(url) || isAllowedExtensionPage(url)
  contents.on('will-navigate', (e, url) => { if (!mayShow(url)) e.preventDefault() })
  contents.on('will-frame-navigate', (e) => { if (e.isMainFrame && !mayShow(e.url)) e.preventDefault() })

  contents.on('before-mouse-event', (_e, mouse) => {
    if (mouse.type === 'mouseDown') host()?.send('web:pointer', { webContentsId: contents.id })
  })
  // Hold-to-talk dictation (src/renderer/voice.ts) while a page has the keyboard, which the app's document never sees:
  // the dictation key going down and up, other keys while it is held (an ⌥ combination, not a hold), and Escape to
  // cancel a dictation in progress. Sent to the app window only.
  let dictationHeld = false
  contents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' && input.type !== 'keyUp') return
    const down = input.type === 'keyDown'
    if (isDictationKey(input, getSettings().dictationKey)) {
      if (down && (input.isAutoRepeat || dictationHeld)) return
      dictationHeld = down
      host()?.send('voice:key', { key: 'dictation', down })
    } else if (down && input.key === 'Escape' && isDictating()) {
      e.preventDefault()
      host()?.send('voice:key', { key: 'escape', down: true })
    } else if (down && dictationHeld) host()?.send('voice:key', { key: 'other', down: true })
  })
  const forwarded = /[/\\]web-app-[^/\\]*$/.test(contents.session.storagePath ?? '') ? CHAT_FORWARDED : FORWARDED
  contents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return
    const key = input.key.toLowerCase()
    // ⌥⌘↑/↓ switch spaces and ⌥⌘←/→ move between the panes of a split; plain ⌘ arrows stay with the page (top /
    // bottom of a field or the page). ⌘⇧↩ shows the split's focused pane alone.
    const arrow = key === 'arrowup' || key === 'arrowdown' || key === 'arrowleft' || key === 'arrowright'
    const section = !input.isAutoRepeat && !!sectionFor(getSettings().shortcuts, comboOf({ code: input.code, key: input.key, meta: input.meta, ctrl: input.control, alt: input.alt, shift: input.shift }))
    const forward = section || (input.control && key === 'tab') || (input.meta && (forwarded.has(key) || /^[1-9]$/.test(key) || (input.alt && arrow) || (input.shift && key === 'enter')))
    // The page keeps its editing keys (copy, paste, select all, undo); ⌘⇧C (copy the address) is the browser's.
    if (!forward || (input.meta && !input.shift && ['c', 'v', 'x', 'a', 'z'].includes(key))) return
    e.preventDefault()
    host()?.send('web:shortcut', { webContentsId: contents.id, key, code: input.code, meta: input.meta, ctrl: input.control, shift: input.shift, alt: input.alt })
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
      items.push(
        { label: 'Fill from 1Password…', click: () => h?.send('web:menu', { webContentsId: contents.id, action: 'fill', url: contents.getURL(), title: contents.getTitle() }) },
        { type: 'separator' }
      )
      items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'selectAll' }, { type: 'separator' })
    } else if (p.selectionText.trim()) {
      const text = p.selectionText.trim()
      items.push(
        { role: 'copy' },
        { label: `Search Google for “${text.length > 30 ? `${text.slice(0, 30)}…` : text}”`, click: () => send(`https://www.google.com/search?q=${encodeURIComponent(text)}`, false) },
        { type: 'separator' }
      )
      // Beside terminals in a split: hand them the selection (pasted at the prompt, never run), or look for it everywhere.
      const targets = getPaneTargets()
      if (targets.length) {
        const menu = (action: 'paste' | 'find', target?: string): void => h?.send('web:menu', { webContentsId: contents.id, action, url: contents.getURL(), title: contents.getTitle(), text, target })
        for (const t of targets) items.push({ label: `Paste into ${t.title}`, click: () => menu('paste', t.id) })
        items.push({ label: 'Find in All Panes', click: () => menu('find') }, { type: 'separator' })
      }
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

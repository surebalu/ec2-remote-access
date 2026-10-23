import { app, BrowserWindow, globalShortcut, screen, shell } from 'electron'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import type { AppCommand } from '@shared/types'
import { toAccelerator } from '@shared/keyCombos'
import { launcherBounds } from '@shared/launcher'
import { browserFor, parseAppInfo, parseFrontPage, scriptProblem, type FrontPage, type LinksPanelMode } from '@shared/linksPanel'
import { getSettings } from './store'
import { mainWindow } from './windows'

/**
 * The Links panels, as Anybox has them: from any app, one key (⌃S) drops a card for saving the page in front to Links,
 * another (⌃F) one for searching Links. A panel window like the launcher's (it takes the keyboard without bringing
 * the app forward and goes away when you click elsewhere), made on first use and hidden rather than closed, loading
 * the renderer with ?links (src/renderer/linksPanel). The page in front is asked of the browser with AppleScript, the
 * only way another app's address can be read; this app's own Browser reports its page instead (browser:frontPage).
 * Electron-only; handlers.ts reaches it through host().linksPanel.
 */

let win: BrowserWindow | null = null
let mode: LinksPanelMode = 'find'
/** What was in front when the save key was last pressed (the panel asks for it once it shows). */
let page: Promise<FrontPage> = Promise.resolve({ url: '', title: '' })
/** True while the browser is being asked: macOS may put its Automation question up, which must not put the panel away. */
let reading = false
/** The page this app's Browser shows while it is in front. */
let ownPage: { url: string; title: string } | null = null
/** The accelerators macOS gave us, '' when none. */
const registered: Record<LinksPanelMode, string> = { save: '', find: '' }
let paused = false

/** The card is 600 wide; the window adds a margin for its shadow (it is transparent). The renderer reports the height. */
const WIDTH = 640
let height = 240

function run(cmd: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }))
      else resolve(stdout)
    })
  })
}

async function readFrontPage(): Promise<FrontPage> {
  const main = mainWindow()
  if (main?.isFocused()) return ownPage ? { ...ownPage, app: 'Browser' } : { url: '', title: '', app: app.getName(), problem: 'not-browser' }
  let front: { name: string; bundleId: string }
  try {
    // lsappinfo answers at once and needs no permission; the panel never makes this app the one in front.
    const asn = (await run('lsappinfo', ['front'], 3000)).trim()
    front = parseAppInfo(await run('lsappinfo', ['info', asn], 3000))
  } catch {
    return { url: '', title: '', problem: 'failed' }
  }
  const browser = browserFor(front.bundleId)
  if (!browser) return { url: '', title: '', app: front.name, problem: 'not-browser' }
  if (!browser.script) return { url: '', title: '', app: browser.name, problem: 'no-script' }
  try {
    // The first time, macOS asks whether this app may control the browser, and the script waits for the answer.
    return { ...parseFrontPage(await run('osascript', ['-e', browser.script], 120_000)), app: browser.name }
  } catch (e) {
    return { url: '', title: '', app: browser.name, problem: scriptProblem(String((e as { stderr?: string }).stderr || (e as Error).message)) }
  }
}

function create(): BrowserWindow {
  const w = new BrowserWindow({
    width: WIDTH,
    height,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    type: 'panel',
    alwaysOnTop: true,
    webPreferences: { preload: join(__dirname, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  })
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  w.on('blur', () => { if (!reading && !w.webContents.isDevToolsOpened()) w.hide() })
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  w.webContents.on('will-navigate', (e) => e.preventDefault())
  w.on('closed', () => { if (win === w) win = null })
  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(`${process.env.ELECTRON_RENDERER_URL}?links=1`)
  else void w.loadFile(join(__dirname, '../renderer/index.html'), { query: { links: '1' } })
  return w
}

export function showLinksPanel(m: LinksPanelMode): void {
  if (m === 'save') {
    // Asked before the panel shows, while the browser is still the app in front.
    reading = true
    page = readFrontPage().finally(() => {
      reading = false
      // macOS's Automation question took the keyboard: give it back to the panel.
      if (win?.isVisible() && !win.isFocused()) win.focus()
    })
  }
  mode = m
  const w = win ?? (win = create())
  // Over the app's window when the app is in front; from another app, on the screen with the pointer, like Spotlight.
  const main = mainWindow()
  const appWindow = main && main.isVisible() && !main.isMinimized() && main.isFocused() ? main.getBounds() : null
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const at = launcherBounds({ width: WIDTH, height: 446 }, appWindow, appWindow && screen.getDisplayMatching(appWindow).workArea, area)
  w.setBounds({ ...at, height })
  const reveal = (): void => {
    w.show()
    w.focus()
    w.webContents.send('linksPanel:shown', { mode: m, at: Date.now() })
  }
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', reveal)
  else reveal()
}

export function hideLinksPanel(): void {
  if (win?.isVisible()) win.hide()
}

function onKey(m: LinksPanelMode): void {
  if (win?.isVisible() && win.isFocused() && mode === m) hideLinksPanel()
  else showLinksPanel(m)
}

/** The page the panel saves: what was in front when the save key was pressed. */
export const linksPanelPage = (): Promise<FrontPage> => page

/** Fits the window to the card, keeping its top where it is so the card grows downwards. */
export function resizeLinksPanel(h: number): void {
  if (!Number.isFinite(h)) return
  height = Math.round(Math.max(120, Math.min(h, 720)))
  if (win) { const b = win.getBounds(); if (b.height !== height) win.setBounds({ ...b, height }) }
}

/** Puts the panel away and has the main window carry out `c`, bringing it to the front. */
export function linksPanelCommand(c: AppCommand): void {
  hideLinksPanel()
  const main = mainWindow()
  if (!main) return
  if (main.isMinimized()) main.restore()
  main.show()
  app.focus({ steal: true })
  main.webContents.send('app:command', c)
}

export function openAutomationSettings(): void {
  hideLinksPanel()
  void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Automation')
}

export function setOwnPage(p: { url: string; title: string } | null): void {
  ownPage = p && typeof p.url === 'string' && /^https?:\/\//i.test(p.url) ? { url: p.url, title: typeof p.title === 'string' ? p.title.slice(0, 500) : '' } : null
}

const keyOf = (m: LinksPanelMode): string => (m === 'save' ? getSettings().linkSaveKey : getSettings().linkFindKey) ?? ''

/** Takes the keys Settings names, letting go of the previous ones. Safe to call repeatedly (after every settings save). */
export function updateLinksPanelKeys(): void {
  const modes: LinksPanelMode[] = ['save', 'find']
  const want = Object.fromEntries(modes.map((m) => [m, paused ? '' : toAccelerator(keyOf(m))])) as Record<LinksPanelMode, string>
  // Every changed key is let go before any is taken, so swapping the two keys works.
  for (const m of modes) {
    if (want[m] === registered[m] || !registered[m]) continue
    globalShortcut.unregister(registered[m])
    registered[m] = ''
  }
  for (const m of modes) {
    if (!want[m] || want[m] === registered[m]) continue
    try {
      if (globalShortcut.register(want[m], () => onKey(m))) registered[m] = want[m]
      else console.warn(`[links] ${want[m]} is taken by another app`)
    } catch (e) {
      console.warn(`[links] could not take ${want[m]}:`, (e as Error).message)
    }
  }
}

/** Lets go of the keys while Settings records a new key (pressing one would open a panel), or takes them again. */
export function pauseLinksPanelKeys(pause: boolean): void {
  paused = pause
  updateLinksPanelKeys()
}

export function linksPanelStatus(): Record<LinksPanelMode, { key: string; registered: boolean }> {
  const one = (m: LinksPanelMode): { key: string; registered: boolean } => {
    const key = keyOf(m)
    return { key, registered: !!key && registered[m] !== '' && registered[m] === toAccelerator(key) }
  }
  return { save: one('save'), find: one('find') }
}

/** With the main window gone the app quits, which needs every window closed; and the keys go back to macOS. */
export function closeLinksPanel(): void {
  for (const m of ['save', 'find'] as const) if (registered[m]) globalShortcut.unregister(registered[m])
  registered.save = ''
  registered.find = ''
  win?.destroy()
  win = null
}

import { app, BrowserWindow, globalShortcut, screen } from 'electron'
import { join } from 'node:path'
import type { AppCommand } from '@shared/types'
import { toAccelerator } from '@shared/keyCombos'
import { getSettings } from './store'
import { mainWindow } from './windows'

/**
 * The launcher: a search bar that drops over whatever app is in front, opened by a key that works in every app
 * (Settings → Keyboard → Launcher). It is a panel, as Spotlight and Raycast are: it takes the keyboard without
 * bringing this app's main window forward, shows on every desktop and over full-screen apps, and goes away when
 * you click elsewhere. One window, made on first use and hidden rather than closed, loading the same renderer with
 * ?launcher (src/renderer/launcher). Electron-only; handlers.ts reaches it through host().launcher.
 */

let win: BrowserWindow | null = null
/** The accelerator macOS gave us, '' when none. */
let registered = ''
/** Settings is recording a new key: let go of the old one meanwhile, or pressing it would open the launcher. */
let paused = false

/** The card plus a margin for its shadow (the window is transparent). */
const SIZE = { width: 760, height: 520 }

function create(): BrowserWindow {
  const w = new BrowserWindow({
    ...SIZE,
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
  w.on('blur', () => { if (!w.webContents.isDevToolsOpened()) w.hide() })
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  w.webContents.on('will-navigate', (e) => e.preventDefault())
  w.on('closed', () => { if (win === w) win = null })
  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(`${process.env.ELECTRON_RENDERER_URL}?launcher=1`)
  else void w.loadFile(join(__dirname, '../renderer/index.html'), { query: { launcher: '1' } })
  return w
}

export function showLauncher(): void {
  const w = win ?? (win = create())
  // On the screen with the pointer, a fifth of the way down, like Spotlight.
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  w.setBounds({ x: Math.round(area.x + (area.width - SIZE.width) / 2), y: Math.round(area.y + area.height * 0.18), ...SIZE })
  const reveal = (): void => {
    w.show()
    w.focus()
    w.webContents.send('launcher:shown', { at: Date.now() })
  }
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', reveal)
  else reveal()
}

export function hideLauncher(): void {
  if (win?.isVisible()) win.hide()
}

function toggleLauncher(): void {
  if (win?.isVisible() && win.isFocused()) hideLauncher()
  else showLauncher()
}

/** Puts the launcher away and has the main window carry out `c`, bringing it to the front. */
export function launcherCommand(c: AppCommand): void {
  hideLauncher()
  const main = mainWindow()
  if (!main) return
  if (main.isMinimized()) main.restore()
  main.show()
  app.focus({ steal: true })
  main.webContents.send('app:command', c)
}

/** Takes the key Settings names, letting go of the previous one. Safe to call repeatedly (after every settings save). */
export function updateLauncherKey(): void {
  const want = paused ? '' : toAccelerator(getSettings().launcherKey ?? '')
  if (want === registered) return
  if (registered) globalShortcut.unregister(registered)
  registered = ''
  if (!want) return
  try {
    if (globalShortcut.register(want, toggleLauncher)) registered = want
    else console.warn(`[launcher] ${want} is taken by another app`)
  } catch (e) {
    console.warn(`[launcher] could not take ${want}:`, (e as Error).message)
  }
}

export function pauseLauncherKey(pause: boolean): void {
  paused = pause
  updateLauncherKey()
}

export function launcherStatus(): { key: string; registered: boolean } {
  const key = getSettings().launcherKey ?? ''
  return { key, registered: !!key && registered !== '' && registered === toAccelerator(key) }
}

/** With the main window gone the app quits, which needs every window closed; and the key goes back to macOS. */
export function closeLauncher(): void {
  if (registered) globalShortcut.unregister(registered)
  registered = ''
  win?.destroy()
  win = null
}

const icons = new Map<string, string>()

/** Finder's icon for each path (an app's own, a file type's), as data URLs, remembered for the run. */
export async function fileIcons(paths: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const p of paths.slice(0, 80)) {
    if (typeof p !== 'string' || !p.startsWith('/')) continue
    let url = icons.get(p)
    if (url === undefined) {
      try { url = (await app.getFileIcon(p, { size: 'normal' })).toDataURL() } catch { url = '' }
      if (icons.size > 2000) icons.clear()
      icons.set(p, url)
    }
    if (url) out[p] = url
  }
  return out
}

import { app, BrowserWindow, nativeTheme, screen } from 'electron'
import { join } from 'node:path'
import { isToolKind, toolWindowBounds, type DetachableTool } from '@shared/toolWindows'
import { initWebviews } from './webviews'
import { mainWindow } from './windows'

/**
 * Detached tools: a rail section (Finder, Notes, the Browser…) dragged out of the main window, or Open in New Window,
 * gets a window of its own showing just that tool (the renderer with ?tool=<kind>, renderer/ToolWindow.tsx); dragging
 * its icon back onto the main window, or Attach, puts it back. One window per tool, as the main window has one tab per
 * tool: the main window closes its tab first, and the rail button brings the window forward while it is out. Each
 * window's webviews are locked down as the main window's are. Electron-only; handlers.ts reaches it through
 * host().toolWindows, and the main window learns which tools are out from tools:detached.
 */

const windows = new Map<DetachableTool, BrowserWindow>()

const tell = (): void => {
  const kinds = [...windows.keys()]
  for (const w of [mainWindow(), ...windows.values()]) if (w && !w.isDestroyed()) w.webContents.send('tools:detached', kinds)
}

/** The windows events go to besides the main one, so a detached tool hears what its tab would. */
export const toolWindowList = (): BrowserWindow[] => [...windows.values()].filter((w) => !w.isDestroyed())

/** Opens `kind` in a window of its own near `at` (the screen point it was dropped on), or brings its window forward. */
export function detachTool(kind: string, at?: { x: number; y: number }): void {
  if (!isToolKind(kind)) throw new Error('Not a tool that can have a window of its own.')
  const have = windows.get(kind)
  if (have && !have.isDestroyed()) {
    if (have.isMinimized()) have.restore()
    have.show()
    have.focus()
    return
  }
  const main = mainWindow()
  const point = at && Number.isFinite(at.x) && Number.isFinite(at.y) ? { x: Math.round(at.x), y: Math.round(at.y) } : screen.getCursorScreenPoint()
  const bounds = toolWindowBounds(point, screen.getDisplayNearestPoint(point).workArea, main?.getBounds() ?? null)
  const w = new BrowserWindow({
    ...bounds,
    minWidth: 480,
    minHeight: 360,
    title: 'EC2 Remote Access',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 13 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0b0f' : '#f3f4f7',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  })
  initWebviews(w)
  windows.set(kind, w)
  w.once('ready-to-show', () => { w.show(); w.focus() })
  w.on('closed', () => {
    if (windows.get(kind) === w) windows.delete(kind)
    tell()
  })
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  w.webContents.on('will-navigate', (e) => e.preventDefault())
  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(`${process.env.ELECTRON_RENDERER_URL}?tool=${kind}`)
  else void w.loadFile(join(__dirname, '../renderer/index.html'), { query: { tool: kind } })
  tell()
}

/** Closes the tool's window and shows the tool in the main window again. */
export function attachTool(kind: string): void {
  if (!isToolKind(kind)) return
  const w = windows.get(kind)
  windows.delete(kind)
  if (w && !w.isDestroyed()) w.close()
  tell()
  const main = mainWindow()
  if (!main) return
  if (main.isMinimized()) main.restore()
  main.show()
  app.focus({ steal: true })
  main.webContents.send('app:command', { kind: 'section', section: kind })
}

export const detachedTools = (): DetachableTool[] => [...windows.keys()]

/** The store calls a detached tool's window may be handed (the store checks them again on its side). */
const RELAYED = new Set(['openBrowser', 'openNotes', 'openTerminal', 'openFinder', 'openBoard', 'openTool', 'showInLinks', 'askAssistant'])

/**
 * The main window wants to open something in a tool that is out ("this page in the Browser"): its window does it and
 * comes forward. False when the tool has no window (the main window then opens it itself).
 */
export function relayToTool(kind: string, method: string, args: unknown[]): boolean {
  if (!isToolKind(kind) || !RELAYED.has(method)) return false
  const w = windows.get(kind)
  if (!w || w.isDestroyed()) return false
  w.webContents.send('tools:relay', { method, args })
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
  return true
}

/** With the main window gone the app quits, which needs every window closed. */
export function closeToolWindows(): void {
  for (const w of windows.values()) if (!w.isDestroyed()) w.destroy()
  windows.clear()
}

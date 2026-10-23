import { app, BrowserWindow, Menu, shell, nativeTheme } from 'electron'
import { join } from 'node:path'
import { registerIpc } from './ipc'
import { updateTray } from './tray'
import { setHost } from './host'
import { electronHost } from './electronHost'
import { closeAllSsh } from './ssh/session'
import { closeAllSftp } from './sftp/session'
import { closeAllTunnels } from './tunnels'
import { closeAllLocal } from './localterm'
import { closeAllVoice } from './voice'
import { closeOnePassword } from './onepassword'
import { closePlmHealth } from './plmHealth'
import { closeDbLocks } from './dbLocks'
import { flushDataFolder, updateDataFolder } from './dataFolder'
import { releaseAllRdp } from './rdp/sessions'
import { stopProxy } from './rdp/cleanpath'
import { getSettings } from './store'
import { setupAutoUpdate } from './updater'
import { startPhoneAccess, stopPhoneAccess } from './phoneAccess'
import { initLog } from './log'
import { initWebviews } from './webviews'
import { initExtensions } from './extensions'
import { restoreSessionCookies, saveSessionCookies } from './sessionCookies'
import { mainWindow, setMainWindow } from './windows'
import { closeLauncher, updateLauncherKey } from './launcherWindow'
import { closeLinksPanel, updateLinksPanelKeys } from './linksPanel'

setHost(electronHost)

if (process.env.ELECTRON_RENDERER_URL && process.env.RDP_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.RDP_DEBUG_PORT)
}

/**
 * The default menu binds Cmd+W to Close Window, which would take every open session with it. The renderer uses Cmd+W
 * to close the current tab instead, so the window close moves to Cmd+Shift+W.
 */
function setMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { label: 'File', submenu: [{ label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' }] },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
          { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }
        ]
      },
      { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] }
    ])
  )
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'EC2 Remote Access',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0b0f' : '#f3f4f7',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The built-in browser's pages; ./webviews locks every guest down before it attaches.
      webviewTag: true
    }
  })
  setMainWindow(win)
  // The launcher's hidden window would otherwise keep the app running with no window to show.
  win.on('closed', () => { closeLauncher(); closeLinksPanel() })
  initWebviews(win)
  if (process.env.ELECTRON_RENDERER_URL) {
    win.webContents.on('console-message', (ev) => {
      if (ev.level === 'error' || ev.level === 'warning') console.log(`[renderer:${ev.level}] ${ev.message} (${ev.sourceId}:${ev.lineNumber})`)
    })
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(async () => {
  initLog(electronHost.logsDir())
  console.log(`[app] EC2 Remote Access ${app.getVersion()} starting (packaged=${app.isPackaged})`)
  nativeTheme.themeSource = getSettings().theme
  // Before any Browser session exists (restoring sign-ins creates them): each loads its extensions as it is created.
  initExtensions()
  // The browser's sign-ins from the last run, before any page can load (bounded, so a stuck store never delays the window).
  await Promise.race([restoreSessionCookies().catch(() => undefined), new Promise((r) => setTimeout(r, 3000))])
  registerIpc(() => {
    updateTray()
    updateLauncherKey()
    updateLinksPanelKeys()
  })
  setMenu()
  createWindow()
  updateTray()
  updateLauncherKey()
  updateLinksPanelKeys()
  updateDataFolder()
  if (getSettings().phoneAccessEnabled) void startPhoneAccess()
  void setupAutoUpdate()
  app.on('activate', () => {
    if (!mainWindow()) {
      createWindow()
      updateLauncherKey()
      updateLinksPanelKeys()
    }
  })
})

let quitting = false
app.on('before-quit', (e) => {
  if (quitting) return
  e.preventDefault()
  quitting = true
  closeAllLocal()
  closeAllVoice()
  closeOnePassword()
  Promise.all([saveSessionCookies(), closeAllSsh(), closeAllSftp(), releaseAllRdp(), closeAllTunnels(), stopPhoneAccess(), closePlmHealth(), closeDbLocks(), flushDataFolder()])
    .then(() => stopProxy())
    .catch(() => undefined)
    .finally(() => app.quit())
})

app.on('window-all-closed', () => {
  app.quit()
})

import { app, BrowserWindow, shell, nativeTheme } from 'electron'
import { join } from 'node:path'
import { registerIpc } from './ipc'
import { setHost } from './host'
import { electronHost } from './electronHost'
import { closeAllSsh } from './ssh/session'
import { closeAllSftp } from './sftp/session'
import { closeAllTunnels } from './tunnels'
import { releaseAllRdp } from './rdp/sessions'
import { stopProxy } from './rdp/cleanpath'
import { getSettings } from './store'
import { setupAutoUpdate } from './updater'
import { startPhoneAccess, stopPhoneAccess } from './phoneAccess'

setHost(electronHost)

if (process.env.ELECTRON_RENDERER_URL && process.env.RDP_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.RDP_DEBUG_PORT)
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
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f6f7f9',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
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

app.whenReady().then(() => {
  nativeTheme.themeSource = getSettings().theme
  registerIpc()
  createWindow()
  if (getSettings().phoneAccessEnabled) void startPhoneAccess()
  void setupAutoUpdate()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let quitting = false
app.on('before-quit', (e) => {
  if (quitting) return
  e.preventDefault()
  quitting = true
  Promise.all([closeAllSsh(), closeAllSftp(), releaseAllRdp(), closeAllTunnels(), stopPhoneAccess()])
    .then(() => stopProxy())
    .catch(() => undefined)
    .finally(() => app.quit())
})

app.on('window-all-closed', () => {
  app.quit()
})

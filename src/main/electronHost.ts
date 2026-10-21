import { app, BrowserWindow, clipboard, ClipboardItem, dialog, nativeTheme, safeStorage, ShareMenu, shell, systemPreferences } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Host, LauncherHost, VoiceHost } from './host'
import { broadcastToPhones } from './phoneAccess'
import { cancelDownload, fillPage } from './webviews'
import { mainWindow } from './windows'
import { fileIcons, hideLauncher, launcherCommand, launcherConfirm, launcherQuickLook, launcherStatus, pauseLauncherKey, showLauncher, thumbnail } from './launcherWindow'

/** Dictation on this Mac: the helper beside the app's resources, and macOS's microphone permission for the app. */
const electronVoice: VoiceHost = {
  helperPath() {
    if (process.platform !== 'darwin') return null
    // Packaged: copied into Resources/dictation (electron-builder extraResources); in development, what
    // scripts/build-dictation.sh built, as tray.ts finds its icon.
    const p = app.isPackaged ? join(process.resourcesPath, 'dictation', 'ec2ra-dictate') : join(app.getAppPath(), 'build', 'native', 'ec2ra-dictate')
    return existsSync(p) ? p : null
  },
  microphoneStatus() {
    if (process.platform !== 'darwin') return 'unknown'
    const s = systemPreferences.getMediaAccessStatus('microphone')
    return s === 'granted' ? 'authorized' : s === 'not-determined' ? 'notDetermined' : s === 'denied' || s === 'restricted' ? s : 'unknown'
  },
  askMicrophone: async () => process.platform === 'darwin' && systemPreferences.askForMediaAccess('microphone'),
  send(channel, payload) {
    mainWindow()?.webContents.send(channel, payload)
  },
  openPrivacy: (pane) => shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?Privacy_${pane === 'microphone' ? 'Microphone' : 'SpeechRecognition'}`)
}

const electronLauncher: LauncherHost = {
  show: showLauncher,
  hide: hideLauncher,
  command: launcherCommand,
  pause: pauseLauncherKey,
  status: launcherStatus,
  icons: fileIcons,
  thumbnail,
  quickLook: launcherQuickLook,
  confirm: launcherConfirm
}

/** Host implementation backed by Electron: real windows, native dialogs, Keychain-backed safeStorage. */
export const electronHost: Host = {
  // The main window only: the launcher's window has no use for sessions' events.
  broadcast(channel, payload) {
    mainWindow()?.webContents.send(channel, payload)
    broadcastToPhones(channel, payload)
  },
  userDataDir: () => app.getPath('userData'),
  logsDir: () => app.getPath('logs'),
  openExternal: (url) => shell.openExternal(url),
  revealPath: (p) => shell.showItemInFolder(p),
  async trashPaths(paths) {
    for (const p of paths) await shell.trashItem(p)
  },
  downloadsDir: () => app.getPath('downloads'),
  async openPath(path) {
    const error = await shell.openPath(path)
    if (error) throw new Error(`Could not open ${path}: ${error}`)
  },
  cancelDownload,
  fillWebPage: fillPage,
  showEmojiPanel: () => app.showEmojiPanel(),
  quickLook(path) {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow()
    win?.previewFile(path)
  },
  shareUrl(url) {
    if (process.platform !== 'darwin') return false
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow()
    new ShareMenu({ urls: [url] }).popup(win ? { window: win } : {})
    return true
  },
  clipboardWrite(text) {
    clipboard.writeText(text)
    return true
  },
  async copyFiles(paths) {
    // One list of paths in the classic filenames type: macOS turns it into one file URL per item, as Finder writes
    // them, and Electron 44 keeps only one clipboard item per write, so the list is the way to copy several.
    const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><array>${paths.map((p) => `<string>${esc(p)}</string>`).join('')}</array></plist>`
    await clipboard.write([new ClipboardItem({ 'electron application/osclipboard;format="NSFilenamesPboardType"': new Blob([plist]) })])
  },
  paste() {
    mainWindow()?.webContents.paste()
  },
  setThemeSource(theme) {
    nativeTheme.themeSource = theme
  },
  async pickPaths(opts) {
    const properties: Electron.OpenDialogOptions['properties'] = ['showHiddenFiles']
    if (opts.kind !== 'directory') properties.push('openFile')
    if (opts.kind !== 'file') properties.push('openDirectory', 'createDirectory')
    if (opts.multiple) properties.push('multiSelections')
    const r = await dialog.showOpenDialog({ title: opts.title, properties, buttonLabel: opts.buttonLabel })
    return r.canceled ? null : r.filePaths
  },
  async pickSavePath(opts) {
    const r = await dialog.showSaveDialog({ title: opts.title, defaultPath: opts.defaultPath, buttonLabel: opts.buttonLabel })
    return r.canceled || !r.filePath ? null : r.filePath
  },
  async askQuestion(opts) {
    const r = await dialog.showMessageBox({
      type: 'question', title: opts.title, message: opts.message, detail: opts.detail,
      buttons: opts.buttons, defaultId: opts.defaultId, cancelId: opts.cancelId, noLink: true
    })
    return r.response
  },
  encrypt: (plain) => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(plain) : null),
  decrypt: (cipher) => safeStorage.decryptString(cipher),
  voice: electronVoice,
  launcher: electronLauncher
}

import { app, BrowserWindow, clipboard, dialog, nativeTheme, safeStorage, shell } from 'electron'
import type { Host } from './host'
import { broadcastToPhones } from './phoneAccess'

/** Host implementation backed by Electron: real windows, native dialogs, Keychain-backed safeStorage. */
export const electronHost: Host = {
  broadcast(channel, payload) {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload)
    broadcastToPhones(channel, payload)
  },
  userDataDir: () => app.getPath('userData'),
  logsDir: () => app.getPath('logs'),
  openExternal: (url) => shell.openExternal(url),
  revealPath: (p) => shell.showItemInFolder(p),
  async trashPaths(paths) {
    for (const p of paths) await shell.trashItem(p)
  },
  clipboardWrite(text) {
    clipboard.writeText(text)
    return true
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
  decrypt: (cipher) => safeStorage.decryptString(cipher)
}

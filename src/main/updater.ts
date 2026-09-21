import { app, dialog } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Auto-update via electron-updater. Only active in a packaged build that was produced with UPDATE_URL set
 * (electron-builder then ships app-update.yml). macOS requires a Developer-ID-signed app for updates to install.
 */
export async function setupAutoUpdate(): Promise<void> {
  if (!app.isPackaged) return
  if (!existsSync(join(process.resourcesPath, 'app-update.yml'))) return
  try {
    const mod = await import('electron-updater')
    // electron-updater is CJS; under an ESM import the class instance may sit on `.default` instead of the named export.
    const autoUpdater = mod.autoUpdater ?? (mod as unknown as { default?: { autoUpdater?: typeof mod.autoUpdater } }).default?.autoUpdater
    if (!autoUpdater) { console.warn('[updater] disabled: autoUpdater export not found'); return }
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('update-downloaded', (info) => {
      void dialog
        .showMessageBox({
          type: 'info',
          buttons: ['Restart now', 'Later'],
          defaultId: 0,
          message: `EC2 Remote Access ${info.version} is ready`,
          detail: 'The update has been downloaded and will be applied when the app restarts.'
        })
        .then((r) => {
          if (r.response === 0) autoUpdater.quitAndInstall()
        })
    })
    autoUpdater.on('error', (e) => console.warn('[updater]', e.message))
    await autoUpdater.checkForUpdates()
    setInterval(() => void autoUpdater.checkForUpdates().catch(() => undefined), 6 * 60 * 60 * 1000)
  } catch (e) {
    console.warn('[updater] disabled:', (e as Error).message)
  }
}

import type { BrowserWindow } from 'electron'

/**
 * The app's main window. The launcher is a second window, so code that used to take "the" window (the menu-bar
 * icon, events, Quick Look) asks here instead. Electron-only, like everything that holds a BrowserWindow.
 */
let main: BrowserWindow | null = null

export function setMainWindow(win: BrowserWindow): void {
  main = win
  win.on('closed', () => {
    if (main === win) main = null
  })
}

export function mainWindow(): BrowserWindow | null {
  return main && !main.isDestroyed() ? main : null
}

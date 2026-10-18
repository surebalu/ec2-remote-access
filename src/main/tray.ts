import { app, BrowserWindow, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron'
import { join } from 'node:path'
import type { AppCommand, Instance } from '@shared/types'
import { manualToInstance } from '@shared/manual'
import { getCachedInventory, getSettings } from './store'

/**
 * The menu-bar icon: favorite hosts to connect to without bringing the window forward first, plus Find a host,
 * Rescan and Quit. The menu is built when it opens, so it always shows the current favorites. Commands go to the
 * Mac's own window as `app:command`, never through host.broadcast, which would also reach paired phones.
 */

let tray: Tray | null = null

function iconPath(): string {
  // Packaged: copied next to the app's resources (electron-builder extraResources); in development, the repo's.
  return join(app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources'), 'trayTemplate.png')
}

function command(c: AppCommand): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  app.focus({ steal: true })
  win.webContents.send('app:command', c)
}

function favorites(): Instance[] {
  const s = getSettings()
  const inventory = getCachedInventory()?.instances ?? []
  const byKey = new Map<string, Instance>(inventory.map((i) => [i.key, i]))
  for (const h of s.manualHosts) byKey.set(`manual/${h.id}`, manualToInstance(h))
  return s.favorites.map((k) => byKey.get(k)).filter((i): i is Instance => !!i).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
}

function menu(): Menu {
  const s = getSettings()
  const label = (i: Instance): string => {
    const account = i.manual ? 'server' : (s.accountMeta[i.profile]?.label ?? i.profile)
    return `${i.name}  ·  ${account}${i.state !== 'running' && !i.manual ? ` (${i.state})` : ''}`
  }
  const favs = favorites()
  const items: MenuItemConstructorOptions[] = [
    { label: 'Favorites', enabled: false },
    ...(favs.length
      ? favs.slice(0, 25).map((i): MenuItemConstructorOptions => ({ label: label(i), enabled: i.manual || (i.state === 'running' && (i.ssmOnline || !!i.publicIp || !!i.privateIp)), click: () => command({ kind: 'connect', key: i.key }) }))
      : [{ label: 'Star hosts in the app to list them here', enabled: false }]),
    { type: 'separator' },
    { label: 'Find a Host…', click: () => command({ kind: 'switcher' }) },
    { label: 'Rescan Accounts', click: () => command({ kind: 'scan' }) },
    { label: 'Open EC2 Remote Access', click: () => { const w = BrowserWindow.getAllWindows()[0]; w?.show(); app.focus({ steal: true }) } },
    { type: 'separator' },
    { label: 'Quit EC2 Remote Access', role: 'quit' }
  ]
  return Menu.buildFromTemplate(items)
}

/** Shows or removes the icon to match Settings → General → Show in the menu bar. Safe to call repeatedly. */
export function updateTray(): void {
  if (process.platform !== 'darwin') return
  const want = getSettings().menuBarIcon !== false
  if (!want) {
    tray?.destroy()
    tray = null
    return
  }
  if (tray) return
  const img = nativeImage.createFromPath(iconPath())
  if (img.isEmpty()) { console.warn('[tray] icon missing at', iconPath()); return }
  img.setTemplateImage(true)
  tray = new Tray(img)
  tray.setToolTip('EC2 Remote Access')
  console.log('[tray] menu-bar icon shown')
  const open = (): void => tray?.popUpContextMenu(menu())
  tray.on('click', open)
  tray.on('right-click', open)
}

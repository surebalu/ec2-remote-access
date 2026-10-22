/**
 * Preload for service workers in the Browser's sessions (main/extensions.ts registers it on each). It runs in every
 * service worker there, websites' too, and does nothing outside an extension. In an extension's worker it fills in
 * the Chrome APIs Electron lacks before the extension's own script runs (src/shared/extensionApis.ts), and carries
 * what the Browser does for the extension: the tabs and popups it opens and its questions about a page's frames go to
 * main, and main's toolbar clicks come back in.
 */
import { contextBridge, ipcRenderer } from 'electron'
import { fillExtensionApis, type ExtensionBridge, type ExtensionClick } from '@shared/extensionApis'

const bridge: ExtensionBridge = {
  openTab: (url, active) => ipcRenderer.send('ext-worker:open', url, active),
  frames: (tabId) => ipcRenderer.invoke('ext-worker:frames', tabId),
  openPopup: (url) => ipcRenderer.send('ext-worker:popup', url),
  setPopup: (url, tabId) => ipcRenderer.send('ext-worker:setPopup', url, tabId),
  getPopup: (tabId) => ipcRenderer.invoke('ext-worker:getPopup', tabId)
}
const click = contextBridge.executeInMainWorld({ func: fillExtensionApis, args: [bridge] }) as ExtensionClick | null

if (click) {
  ipcRenderer.on('ext-worker:click', (_e, n: number, tabId: number | null) => {
    click(tabId).then((popup) => ipcRenderer.send('ext-worker:clicked', n, popup), () => ipcRenderer.send('ext-worker:clicked', n, null))
  })
}

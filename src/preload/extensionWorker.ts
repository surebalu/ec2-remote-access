/**
 * Preload for service workers in the Browser's sessions (main/extensions.ts registers it on each). It runs in every
 * service worker there, websites' too, and does nothing outside an extension. In an extension's worker it fills in
 * the Chrome APIs Electron lacks before the extension's own script runs (src/shared/extensionApis.ts), and carries
 * what the Browser does for the extension: the tabs it opens and its questions about a page's frames go to main, and
 * main's toolbar clicks come back in.
 */
import { contextBridge, ipcRenderer } from 'electron'
import { fillExtensionApis, type ExtensionClick, type ExtensionFrame } from '@shared/extensionApis'

const openTab = (url: string, active: boolean): void => ipcRenderer.send('ext-worker:open', url, active)
const frames = (tabId: number): Promise<ExtensionFrame[] | null> => ipcRenderer.invoke('ext-worker:frames', tabId)
const click = contextBridge.executeInMainWorld({ func: fillExtensionApis, args: [openTab, frames] }) as ExtensionClick | null

if (click) {
  ipcRenderer.on('ext-worker:click', (_e, n: number, tabId: number | null) => {
    click(tabId).then((popup) => ipcRenderer.send('ext-worker:clicked', n, popup), () => ipcRenderer.send('ext-worker:clicked', n, null))
  })
}

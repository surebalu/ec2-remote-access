import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import Launcher from './launcher/Launcher'
import LinksPanel from './linksPanel/LinksPanel'
import ToolWindow from './ToolWindow'
import { isSession, toolWindowKind, useStore } from './store'
import { createWsApi, setSessionCheck } from './wsApi'
import { watchChunkFailures } from './updates'
import './styles.css'

// Served by the gateway (no Electron preload): talk to it over WebSocket instead of ipcRenderer. Such a page can
// outlive an update of the gateway; updates.ts reloads it (or offers to) when its build is behind.
if (!window.api) {
  setSessionCheck(() => useStore.getState().tabs.some(isSession))
  window.api = createWsApi()
  watchChunkFailures()
}

// The launcher's floating window (main/launcherWindow.ts) loads this same page with ?launcher.
const launcher = new URLSearchParams(location.search).has('launcher')
if (launcher) document.documentElement.classList.add('launcher-page')
// And the Links panels' (main/linksPanel.ts) with ?links.
const linksPanel = new URLSearchParams(location.search).has('links')
if (linksPanel) document.documentElement.classList.add('links-panel-page')

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {launcher ? <Launcher /> : linksPanel ? <LinksPanel /> : toolWindowKind ? <ToolWindow kind={toolWindowKind} /> : <App />}
  </React.StrictMode>
)

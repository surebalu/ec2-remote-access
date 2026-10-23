import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import Launcher from './launcher/Launcher'
import LinksPanel from './linksPanel/LinksPanel'
import ToolWindow from './ToolWindow'
import { toolWindowKind } from './store'
import { createWsApi } from './wsApi'
import './styles.css'

// Served by the gateway (no Electron preload): talk to it over WebSocket instead of ipcRenderer.
if (!window.api) window.api = createWsApi()

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

import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import Launcher from './launcher/Launcher'
import { createWsApi } from './wsApi'
import './styles.css'

// Served by the gateway (no Electron preload): talk to it over WebSocket instead of ipcRenderer.
if (!window.api) window.api = createWsApi()

// The launcher's floating window (main/launcherWindow.ts) loads this same page with ?launcher.
const launcher = new URLSearchParams(location.search).has('launcher')
if (launcher) document.documentElement.classList.add('launcher-page')

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {launcher ? <Launcher /> : <App />}
  </React.StrictMode>
)

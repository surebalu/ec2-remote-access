import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { createWsApi } from './wsApi'
import './styles.css'

// Served by the gateway (no Electron preload): talk to it over WebSocket instead of ipcRenderer.
if (!window.api) window.api = createWsApi()

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

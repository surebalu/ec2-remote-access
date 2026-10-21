const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('api', {
  invoke: (channel, ...args) => ipcRenderer.invoke('fixture:invoke', channel, ...args),
  on: (channel, callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  // Real files have paths; the smoke test's pasted files carry theirs in the name ('fixture-path|Users|fixture|a.txt').
  pathForFile: (f) => (f && typeof f.name === 'string' && f.name.startsWith('fixture-path|') ? `/${f.name.slice(13).split('|').join('/')}` : '')
})

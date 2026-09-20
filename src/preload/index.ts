import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcApi, IpcEvents } from '@shared/ipc'

const api = {
  invoke<K extends keyof IpcApi>(channel: K, ...args: Parameters<IpcApi[K]>): ReturnType<IpcApi[K]> {
    return ipcRenderer.invoke(channel, ...args) as ReturnType<IpcApi[K]>
  },
  on<K extends keyof IpcEvents>(channel: K, cb: (payload: IpcEvents[K]) => void): () => void {
    const listener = (_e: Electron.IpcRendererEvent, payload: IpcEvents[K]): void => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  /** Absolute path of a File dropped from Finder (the renderer cannot read it otherwise). */
  pathForFile(file: File): string {
    return webUtils.getPathForFile(file)
  }
}

export type Api = typeof api
contextBridge.exposeInMainWorld('api', api)

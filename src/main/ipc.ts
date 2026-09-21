import { ipcMain } from 'electron'
import type { IpcApi } from '@shared/ipc'
import { handlers } from './handlers'

/** Registers every engine handler with Electron's ipcMain, logging failures (except expected cancellations). */
export function registerIpc(): void {
  for (const channel of Object.keys(handlers) as (keyof IpcApi)[]) {
    const fn = handlers[channel] as (...a: unknown[]) => unknown
    ipcMain.handle(channel, async (_e, ...args) => {
      try {
        return await fn(...args)
      } catch (e) {
        // Expected when a renderer remount supersedes an in-flight connect; not worth a stack trace.
        if ((e as Error).message === 'cancelled') throw e
        console.error(`[ipc ${channel}]`, (e as Error).message)
        throw e
      }
    })
  }
}

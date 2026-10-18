import { ipcMain } from 'electron'
import type { IpcApi } from '@shared/ipc'
import { handlers } from './handlers'

/**
 * Registers every engine handler with Electron's ipcMain, logging failures (except expected cancellations).
 * `onSettingsSaved` lets Electron-only pieces (the menu-bar icon) follow settings the engine itself does not act on.
 */
export function registerIpc(onSettingsSaved?: () => void): void {
  for (const channel of Object.keys(handlers) as (keyof IpcApi)[]) {
    const fn = handlers[channel] as (...a: unknown[]) => unknown
    ipcMain.handle(channel, async (_e, ...args) => {
      try {
        const result = await fn(...args)
        if (channel === 'settings:set') onSettingsSaved?.()
        return result
      } catch (e) {
        // Expected when a renderer remount supersedes an in-flight connect; not worth a stack trace.
        if ((e as Error).message === 'cancelled') throw e
        console.error(`[ipc ${channel}]`, (e as Error).message)
        throw e
      }
    })
  }
}

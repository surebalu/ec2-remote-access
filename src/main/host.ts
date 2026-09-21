/**
 * Everything the connection engine needs from its surroundings that differs between Electron and the headless
 * gateway. Modules under src/main call `host()` instead of importing 'electron', so the same SSH/SFTP/RDP/AWS
 * code runs inside the desktop app and inside `src/gateway` (a Node server reached from a phone's browser).
 */
import type { Theme } from '@shared/types'

export interface OpenDialogOptions {
  title: string
  /** 'file' picks files, 'directory' picks folders, 'any' allows both; `multiple` allows several. */
  kind: 'file' | 'directory' | 'any'
  multiple?: boolean
  buttonLabel?: string
}

export interface MessageBoxOptions {
  title: string
  message: string
  detail?: string
  buttons: string[]
  defaultId?: number
  cancelId?: number
}

export interface Host {
  /** Push an event (see IpcEvents) to every connected UI. */
  broadcast(channel: string, payload: unknown): void
  /** Directory for settings, inventory cache and generated files. */
  userDataDir(): string
  /** Open a URL in the user's browser. May be a no-op when no browser is reachable (headless gateway). */
  openExternal(url: string): Promise<void>
  /** Reveal a local path in the file manager, if there is one. */
  revealPath(path: string): void
  /** Move local paths to the trash. */
  trashPaths(paths: string[]): Promise<void>
  /** Copy text to the clipboard. Returns false when the host has no clipboard (the UI then copies client-side). */
  clipboardWrite(text: string): boolean
  /** Apply the app-wide light/dark preference to native chrome; no-op without native windows. */
  setThemeSource(theme: Theme): void
  /** Native pickers. Resolve to null when the host cannot show dialogs (gateway), which callers treat as cancelled. */
  pickPaths(opts: OpenDialogOptions): Promise<string[] | null>
  pickSavePath(opts: { title: string; defaultPath?: string; buttonLabel?: string }): Promise<string | null>
  /** Modal question. Resolves to the chosen button index; hosts without dialogs return `defaultId`. */
  askQuestion(opts: MessageBoxOptions): Promise<number>
  /** Secret storage for saved RDP passwords. `encrypt` returns null when no secure store is available. */
  encrypt(plain: string): Buffer | null
  decrypt(cipher: Buffer): string
}

let current: Host | null = null

export function setHost(h: Host): void {
  current = h
}

export function host(): Host {
  if (!current) throw new Error('Host not initialised: call setHost() before using the connection engine')
  return current
}

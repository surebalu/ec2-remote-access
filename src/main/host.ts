/**
 * Everything the connection engine needs from its surroundings that differs between Electron and the headless
 * gateway. Modules under src/main call `host()` instead of importing 'electron', so the same SSH/SFTP/RDP/AWS
 * code runs inside the desktop app and inside `src/gateway` (a Node server reached from a phone's browser).
 */
import type { AppCommand, Theme, VoiceEvent, VoicePermission } from '@shared/types'

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
  /** Directory for main.log (see log.ts). */
  logsDir(): string
  /** Open a URL in the user's browser. May be a no-op when no browser is reachable (headless gateway). */
  openExternal(url: string): Promise<void>
  /** Reveal a local path in the file manager, if there is one. */
  revealPath(path: string): void
  /** Move local paths to the trash. */
  trashPaths(paths: string[]): Promise<void>
  /** The user's Downloads folder, where the browser saves files; null when the host has no browser (gateway). */
  downloadsDir(): string | null
  /** Opens a local file or folder with its default app. */
  openPath(path: string): Promise<void>
  /** Types a 1Password login into a browser page (see webviews.ts fillPage); returns what was filled. */
  fillWebPage(webContentsId: number, values: { username?: string; password?: string; otp?: string }, allowedUrls: string[] | null): Promise<string[]>
  /** Stops a browser download in progress. */
  cancelDownload(id: string): void
  /** Shows the system Share menu for a link (Messages, Notes, Anybox…) at the pointer. False when there is none. */
  shareUrl(url: string): boolean
  /** Opens the system emoji picker for the focused text field (macOS). Absent where there is none. */
  showEmojiPanel?(): void
  /** Quick Look for a file (macOS). Absent where there is none. */
  quickLook?(path: string): void
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
  /** Voice dictation needs this Mac's microphone and speech recognizer (see voice.ts); null where there are none (gateway). */
  voice: VoiceHost | null
  /** The launcher's window and its key in every app (main/launcherWindow.ts); null without a desktop (gateway). */
  launcher: LauncherHost | null
}

/** What the launcher needs from the Mac app. */
export interface LauncherHost {
  show(): void
  hide(): void
  /** Hides the launcher and has the main window carry out `c`, bringing it to the front. */
  command(c: AppCommand): void
  /** Lets go of the launcher's key while Settings records a new one, or takes it again. */
  pause(paused: boolean): void
  status(): { key: string; registered: boolean }
  icons(paths: string[]): Promise<Record<string, string>>
  /** A Quick Look thumbnail as a data URL ('' when there is none). */
  thumbnail(path: string, px: number): Promise<string>
  quickLook(path: string): void
}

/** What dictation (voice.ts) needs from the Mac app. */
export interface VoiceHost {
  /** The ec2ra-dictate helper: in the app's Resources when packaged, build/native in development; null when missing. */
  helperPath(): string | null
  /** The app's microphone permission as macOS reports it, without asking. */
  microphoneStatus(): VoicePermission
  /** Asks macOS for the microphone (a prompt the first time only); true when allowed. Only on a real user action. */
  askMicrophone(): Promise<boolean>
  /** Delivers a dictation event to this computer's own windows, never to paired devices (unlike broadcast). */
  send(channel: 'voice:event', payload: VoiceEvent): void
  /** Opens System Settings at Privacy & Security → Microphone or Speech Recognition. */
  openPrivacy(pane: 'microphone' | 'speech'): Promise<void>
}

let current: Host | null = null

export function setHost(h: Host): void {
  current = h
}

export function host(): Host {
  if (!current) throw new Error('Host not initialised: call setHost() before using the connection engine')
  return current
}

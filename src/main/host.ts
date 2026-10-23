/**
 * Everything the connection engine needs from its surroundings that differs between Electron and the headless
 * gateway. Modules under src/main call `host()` instead of importing 'electron', so the same SSH/SFTP/RDP/AWS
 * code runs inside the desktop app and inside `src/gateway` (a Node server reached from a phone's browser).
 */
import type { ExtensionInfo } from '@shared/extensions'
import type { FrontPage, LinksPanelMode } from '@shared/linksPanel'
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
  /**
   * Where the mouse pointer is, in the main window's page coordinates (CSS pixels), or null outside it. The page
   * cannot tell while the pointer is over a web page or a remote desktop, which keep its moves to themselves.
   */
  pointer?(): { x: number; y: number } | null
  /** Quick Look for a file (macOS). Absent where there is none. */
  quickLook?(path: string): void
  /** Puts files on the clipboard as Finder's Copy does, so Finder and other apps paste the files themselves (macOS). */
  copyFiles?(paths: string[]): Promise<void>
  /** Edit → Paste in the main window, for a Paste menu item: macOS hands the page what is on the clipboard. */
  paste?(): void
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
  /** The Links panels over any app and their keys (main/linksPanel.ts); null without a desktop (gateway). */
  linksPanel: LinksPanelHost | null
  /** Tools in windows of their own (main/toolWindows.ts); null without a desktop (gateway). */
  toolWindows: ToolWindowsHost | null
  /** Chrome extensions in the Browser (main/extensions.ts); null where there is no Browser (gateway). */
  extensions: ExtensionsHost | null
  /** The Storage tool's scan process (main/storage/scanClient.ts); null without a Mac to scan (gateway). */
  storage: StorageHost | null
  /** Window layouts, app hotkeys and the Mac's calendars (main/desktopKeys.ts, main/macControl.ts); null without a Mac (gateway). */
  mac: MacHost | null
}

/** What the window layouts, app hotkeys and the Mac's calendars need from the Mac app. */
export interface MacHost {
  /** The ec2ra-control helper: in the app's Resources when packaged, build/native in development; null when missing. */
  controlPath(): string | null
  /** Moves the window in front to a layout (src/shared/windowLayouts.ts), or does what it names (Restore, Full Screen). */
  layout(id: string): Promise<void>
  /** Opens or brings forward the app at `path`, then moves its window to the layout. */
  layoutApp(path: string, id: string): Promise<void>
  /** Each window and app key in Settings, and whether macOS gave it to the app. */
  hotkeys(): { id: string; combo: string; registered: boolean }[]
  /** Opens System Settings at Privacy & Security → Accessibility or Calendars. */
  openPrivacy(pane: 'accessibility' | 'calendars'): Promise<void>
}

/** The Storage tool's disk scan, run apart from the main process (main/storage/scanProcess.ts). */
export interface StorageHost {
  /** Asks the scan process (starting it when needed): 'scan', 'view', 'largest', 'search', 'hidden', 'duplicates'… */
  call<T>(op: string, args?: Record<string, unknown>): Promise<T>
  /** Progress the scan process reports while it works. */
  onEvent(fn: (e: { event: string } & Record<string, unknown>) => void): void
  running(): boolean
  /** Ends the scan process, and the memory its tree holds. */
  stop(): void
}

/** What the Browser's extensions need from the Mac app. */
export interface ExtensionsHost {
  list(): ExtensionInfo[]
  installFromStore(input: string): Promise<ExtensionInfo>
  addFolder(): Promise<ExtensionInfo | null>
  setEnabled(id: string, on: boolean): Promise<ExtensionInfo[]>
  remove(id: string): ExtensionInfo[]
  action(id: string, partition: string, tabId: number | null): Promise<string | null>
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
  /** Asks before something that cannot be undone, with the app brought forward so the question is not hidden. */
  confirm(message: string, detail: string, button: string): Promise<boolean>
}

/** What detached tools need from the Mac app. */
export interface ToolWindowsHost {
  detach(kind: string, at?: { x: number; y: number }): void
  attach(kind: string): void
  list(): string[]
  /** Hands an opener call ("open this page in the Browser") to the tool's own window, and brings it forward. */
  relay(kind: string, method: string, args: unknown[]): boolean
}

/** What the Links panels need from the Mac app. */
export interface LinksPanelHost {
  show(mode: LinksPanelMode): void
  hide(): void
  page(): Promise<FrontPage>
  resize(height: number): void
  command(c: AppCommand): void
  automation(): void
  status(): Record<LinksPanelMode, { key: string; registered: boolean }>
  /** What this app's Browser shows while it is in front, for the save key pressed in this app. */
  setOwnPage(page: { url: string; title: string } | null): void
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

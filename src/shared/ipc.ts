import type {
  AwsProfile, ProfileStatus, ScanResult, ScanProgress, Settings, Instance,
  SshOpenRequest, SshSessionInfo, SshEvent, Tunnel, RdpOpenRequest, WindowsPasswordResult, RouteDecision,
  RdpPrepareRequest, RdpPrepared, StoredCredential, Theme,
  SsoStartRequest, SsoDeviceFlow, SsoAccount, SsoSaveRequest, StaticProfileRequest, SsoSessionInfo,
  SftpOpenRequest, SftpSessionInfo, SftpEntry, SftpTransfer, SftpEvent, ScanTarget, PhoneAccessStatus,
  PortForwardRequest, HostHealth, HostShell, NotesInfo, NoteEntry, NoteFile, NoteHit, BrowserState, WebDownload, WebLogin, LocalTermOpen, LocalTermInfo, LocalTermEvent, TerminalState, Board, BoardSummary, AppAbout, AppCommand, RunCommandRequest, RunState } from './types'
import type { GitStatus } from './gitStatus'

/** Request/response channels (ipcRenderer.invoke) */
export interface IpcApi {
  'profiles:list': () => Promise<AwsProfile[]>
  'profiles:check': (profile?: string) => Promise<ProfileStatus[]>
  'profiles:login': (profile: string) => Promise<ProfileStatus>
  'profiles:addStatic': (req: StaticProfileRequest) => Promise<void>
  'profiles:remove': (name: string) => Promise<void>
  'profiles:rename': (from: string, to: string) => Promise<void>
  'sso:sessions': () => Promise<SsoSessionInfo[]>
  'sso:start': (req: SsoStartRequest) => Promise<SsoDeviceFlow>
  'sso:wait': (flowId: string) => Promise<SsoAccount[]>
  'sso:save': (req: SsoSaveRequest) => Promise<string[]>
  'sso:cancel': (flowId: string) => Promise<void>
  'sso:loginSession': (sessionName: string, opts?: { openBrowser?: boolean }) => Promise<SsoDeviceFlow>
  'shell:open': (url: string) => Promise<void>
  'inventory:cached': () => Promise<ScanResult | null>
  'inventory:scan': (profiles?: string[], retryTargets?: ScanTarget[]) => Promise<ScanResult>
  'settings:get': () => Promise<Settings>
  'settings:set': (patch: Partial<Settings>) => Promise<Settings>
  'route:decide': (instanceKey: string, kind: 'ssh' | 'rdp', force?: 'direct' | 'ssm') => Promise<RouteDecision>
  'ssh:open': (req: SshOpenRequest) => Promise<SshSessionInfo>
  'ssh:write': (sessionId: string, data: string) => Promise<void>
  'ssh:resize': (sessionId: string, cols: number, rows: number) => Promise<void>
  /** endShell also ends the tab's tmux shell on the host (closing the tab); otherwise it keeps running to resume. */
  'ssh:close': (sessionId: string, opts?: { endShell?: boolean }) => Promise<void>
  /** Ends a persistent shell another tab left running on this session's host. */
  'ssh:endShell': (sessionId: string, name: string) => Promise<void>
  /** The persistent shells on this session's host. */
  'ssh:listShells': (sessionId: string) => Promise<HostShell[]>
  /** Shows another of the host's shells in this tab (null = a new one); the one it leaves keeps running unless endPrevious. */
  'ssh:switchShell': (sessionId: string, name: string | null, opts?: { endPrevious?: boolean; label?: string }) => Promise<{ name: string; label: string }>
  /** Names one of the host's shells ('' clears the name); returns the name as stored. */
  'ssh:renameShell': (sessionId: string, name: string, label: string) => Promise<string>
  'ssh:external': (req: SshOpenRequest) => Promise<void>
  'sftp:open': (req: SftpOpenRequest) => Promise<SftpSessionInfo>
  'sftp:list': (sessionId: string, path: string) => Promise<SftpEntry[]>
  'sftp:realpath': (sessionId: string, path: string) => Promise<string>
  'sftp:mkdir': (sessionId: string, path: string) => Promise<void>
  'sftp:rename': (sessionId: string, from: string, to: string) => Promise<void>
  'sftp:delete': (sessionId: string, entries: SftpEntry[]) => Promise<void>
  /** Opens the file/folder picker and queues uploads into remoteDir. Returns the number of files queued. */
  'sftp:pickUploads': (sessionId: string, remoteDir: string) => Promise<number>
  /** Queues uploads of the given local paths (files or folders) into remoteDir. */
  'sftp:upload': (sessionId: string, localPaths: string[], remoteDir: string) => Promise<number>
  /** Asks where to save, then queues downloads. Returns the number of files queued (0 if cancelled). */
  'sftp:download': (sessionId: string, entries: SftpEntry[]) => Promise<number>
  /** Queues downloads straight into a local folder (no dialog). */
  'sftp:downloadTo': (sessionId: string, entries: SftpEntry[], localDir: string) => Promise<number>
  'local:home': () => Promise<string>
  'local:list': (path: string) => Promise<SftpEntry[]>
  'local:realpath': (path: string) => Promise<string>
  'local:mkdir': (path: string) => Promise<void>
  'local:rename': (from: string, to: string) => Promise<void>
  'local:trash': (paths: string[]) => Promise<void>
  'local:reveal': (path: string) => Promise<void>
  'sftp:cancel': (transferId: string) => Promise<void>
  'sftp:transfers': (sessionId: string) => Promise<SftpTransfer[]>
  'sftp:clearTransfers': (sessionId: string) => Promise<void>
  'sftp:close': (sessionId: string) => Promise<void>
  'rdp:open': (req: RdpOpenRequest) => Promise<Tunnel | null>
  'rdp:prepare': (req: RdpPrepareRequest) => Promise<RdpPrepared>
  'rdp:release': (sessionId: string) => Promise<void>
  'rdp:lastError': (sessionId: string) => Promise<string | undefined>
  'creds:get': (instanceKey: string) => Promise<StoredCredential | null>
  'creds:set': (instanceKey: string, cred: StoredCredential) => Promise<void>
  'creds:delete': (instanceKey: string) => Promise<void>
  'creds:keys': () => Promise<string[]>
  'tunnels:list': () => Promise<Tunnel[]>
  'tunnels:close': (id: string) => Promise<void>
  /** SSM port forward to the instance (or remoteHost through it); resolves once it is listening. */
  'tunnels:open': (req: PortForwardRequest) => Promise<Tunnel>
  'ec2:health': (instanceKey: string) => Promise<HostHealth>
  'ec2:password': (instanceKey: string, pemFile?: string) => Promise<WindowsPasswordResult>
  'ec2:start': (instanceKey: string) => Promise<void>
  'ec2:stop': (instanceKey: string) => Promise<void>
  'ec2:regions': (profile: string) => Promise<string[]>
  'notes:info': () => Promise<NotesInfo>
  'notes:list': () => Promise<NoteEntry[]>
  'notes:read': (path: string) => Promise<NoteFile>
  /** baseMtime: when the editor loaded it; a newer file on disk comes back as `conflict` instead of being overwritten. */
  'notes:write': (path: string, text: string, baseMtime?: number) => Promise<{ mtime: number; conflict?: NoteFile }>
  'notes:stat': (path: string) => Promise<number | null>
  'notes:create': (path: string) => Promise<string>
  /** The host's note (created on first use); returns its path. */
  'notes:hostNote': (instanceKey: string) => Promise<string>
  'notes:daily': () => Promise<string>
  /** Whiteboards (main/boards.ts), newest first. */
  'boards:list': () => Promise<BoardSummary[]>
  'boards:load': (id: string) => Promise<Board | null>
  'boards:save': (board: Board) => Promise<void>
  'boards:delete': (id: string) => Promise<void>
  /** Saves a PNG (data: URL) into the notes folder (EC2 Remote/Boards) and returns its path there, for ![[embeds]]. */
  'notes:saveImage': (name: string, dataUrl: string) => Promise<string>
  /** Opens a note in the Obsidian app. */
  'notes:openInObsidian': (path: string) => Promise<void>
  'notes:append': (path: string, text: string) => Promise<void>
  'notes:search': (query: string) => Promise<NoteHit[]>
  'notes:pickFolder': () => Promise<string | null>
  'notes:mkdir': (path: string) => Promise<string>
  /** Renames or moves a note or folder; returns the new path. Never replaces an existing one. */
  'notes:rename': (from: string, to: string) => Promise<string>
  /** Moves a note or folder to the Trash. */
  'notes:delete': (path: string) => Promise<void>
  'browser:load': () => Promise<BrowserState | null>
  'browser:save': (state: BrowserState) => Promise<void>
  /** A one-time sign-in link to the AWS console of `profile` (SSO credentials), landing on `destination`. */
  'browser:consoleUrl': (profile: string, destination: string) => Promise<string>
  /** Local terminals (the Terminal tab). Desktop only: the gateway refuses term:* calls and never forwards term:* events. */
  /** Whether this page may open terminals: always in the Mac app; on a paired device only when the computer allows it. */
  'term:available': () => Promise<boolean>
  'term:open': (req: LocalTermOpen) => Promise<LocalTermInfo>
  'term:write': (id: string, data: string) => Promise<void>
  'term:resize': (id: string, cols: number, rows: number) => Promise<void>
  'term:close': (id: string) => Promise<void>
  /** Recent commands from the shell's history file, oldest first, without repeats. */
  'term:history': () => Promise<string[]>
  'term:loadState': () => Promise<TerminalState | null>
  'term:saveState': (state: TerminalState) => Promise<void>
  /** Git status of a terminal's folder for its ribbon (branch, changed files, lines); null outside a repository. */
  'term:git': (cwd: string) => Promise<GitStatus | null>
  /** Opens a downloaded file, shows it in Finder, or opens the Downloads folder (no path). Only inside Downloads. */
  'browser:openDownload': (path: string | null, how: 'open' | 'reveal') => Promise<void>
  'browser:cancelDownload': (id: string) => Promise<void>
  /** 1Password logins (through the 1Password CLI), those saved for `pageUrl`'s site marked `matches`. */
  'browser:logins': (pageUrl: string, refresh?: boolean) => Promise<WebLogin[]>
  /**
   * Types a 1Password login into a page (by its webContents id); returns what was filled ('username', 'password',
   * 'code'). Refuses a page on another site than the login's unless `anySite` (the user confirmed).
   */
  'browser:fill': (webContentsId: number, account: string, itemId: string, anySite?: boolean) => Promise<string[]>
  /** The system Share menu for a page; false when the host has none (gateway). */
  'browser:share': (url: string) => Promise<boolean>
  'clipboard:write': (text: string) => Promise<void>
  'theme:set': (theme: Theme) => Promise<void>
  'dialog:pickFile': (title: string) => Promise<string | null>
  'app:paths': () => Promise<{ sessionManagerPlugin: string | null; awsCli: string | null; windowsApp: boolean }>
  /** Sends a command to many hosts with SSM Run Command; poll run:status for results (pushed events can be missed). */
  'run:start': (req: RunCommandRequest) => Promise<RunState>
  'run:status': (id: string) => Promise<RunState | null>
  'run:cancel': (id: string) => Promise<void>
  /** Recent runs, newest first. */
  'run:list': () => Promise<RunState[]>
  'app:about': () => Promise<AppAbout>
  /** Shows the app's data or log folder in Finder. */
  'app:reveal': (which: 'data' | 'logs') => Promise<void>
  'phone:status': () => Promise<PhoneAccessStatus>
  /** Saves enabled/port/bind and (re)starts or stops the in-app gateway accordingly. */
  /** Lets paired devices open terminals on this Mac, or stops that (closing the ones they have open). Desktop only. */
  'phone:terminals': (allow: boolean) => Promise<PhoneAccessStatus>
  'phone:configure': (patch: Partial<Pick<Settings, 'phoneAccessEnabled' | 'phoneAccessPort' | 'phoneAccessBind'>>) => Promise<PhoneAccessStatus>
  'phone:rotateToken': () => Promise<PhoneAccessStatus>
  /** Tail of main.log for "Copy diagnostics"; `filter` is a case-insensitive regular expression. */
  'diag:log': (opts?: { lines?: number; filter?: string }) => Promise<{ path: string | null; text: string }>
}

/** Push channels (main -> renderer) */
export interface IpcEvents {
  'app:command': AppCommand
  'scan:progress': ScanProgress
  'ssh:event': SshEvent
  'sftp:transfer': SftpTransfer
  'sftp:event': SftpEvent
  'tunnels:changed': Tunnel[]
  'profiles:status': ProfileStatus
  'instances:updated': Instance[]
  'phone:changed': PhoneAccessStatus
  /** A page asked for a new window (target=_blank, window.open) or "Open link in new tab": open it as a tab. */
  'web:window': { webContentsId: number; url: string; background: boolean }
  /** A browser shortcut pressed while a page had the keyboard (pages swallow keys before the app sees them). */
  'web:shortcut': { webContentsId: number; key: string; shift: boolean; alt: boolean }
  /** The mouse went down inside a page (the app's document never sees those clicks). */
  'web:pointer': { webContentsId: number }
  /** A page context-menu action the app carries out (Add to note, Fill from 1Password). */
  'web:menu': { webContentsId: number; action: 'note' | 'fill'; url: string; title: string }
  /** Output and exit of a local terminal. */
  'term:event': LocalTermEvent
  /** A download started, progressed or finished (main/webviews.ts). */
  'web:download': WebDownload
}

export type IpcChannel = keyof IpcApi
export type IpcEventChannel = keyof IpcEvents

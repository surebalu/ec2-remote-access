import type { ServiceDef } from './services'
import type { RailSection } from './keyCombos'
import type { Quicklink } from './quicklinks'

export type Platform = 'linux' | 'windows' | 'unknown'
export type InstanceState = 'pending' | 'running' | 'stopping' | 'stopped' | 'shutting-down' | 'terminated'

export interface AwsProfile {
  name: string
  region: string
  /** 'sso' when the profile uses an sso-session / sso_start_url; 'static' for credentials file; 'other' for role/process */
  kind: 'sso' | 'static' | 'other'
  ssoSession?: string
  accountId?: string
  enabled: boolean
}

export type AuthState = 'unknown' | 'checking' | 'ok' | 'login-required' | 'error'

export interface ProfileStatus {
  profile: string
  state: AuthState
  accountId?: string
  arn?: string
  message?: string
  checkedAt?: number
}

export interface Instance {
  /** unique key: `${profile}/${region}/${instanceId}` */
  key: string
  profile: string
  accountId?: string
  region: string
  instanceId: string
  name: string
  platform: Platform
  platformDetails: string
  osHint: string
  state: InstanceState
  instanceType: string
  publicIp?: string
  privateIp?: string
  publicDns?: string
  keyName?: string
  imageId?: string
  vpcId?: string
  subnetId?: string
  az?: string
  launchTime?: string
  ssmOnline: boolean
  ssmPingStatus?: string
  ssmAgentVersion?: string
  /** ISO time the SSM agent last checked in (DescribeInstanceInformation LastPingDateTime). */
  ssmLastPing?: string
  ssmError?: string
  /** Last successful EC2 scan, retained when a refresh fails. */
  lastSeenAt?: number
  staleReason?: string
  tags: Record<string, string>
  /** true for servers added by hand (not from AWS) */
  manual?: boolean
}

/** A server outside AWS, added by the user. Connection settings live in Settings.overrides[key]. */
export interface ManualHost {
  id: string
  name: string
  /** hostname or IP */
  host: string
  platform: 'linux' | 'windows'
  group: string
  notes?: string
}

export type Theme = 'system' | 'light' | 'dark'

/** State of the in-app gateway that lets a phone browser use the app (see main/phoneAccess.ts). */
export type PhoneAccessBind = 'https' | 'tailscale' | 'all'

export interface PhoneAccessStatus {
  enabled: boolean
  running: boolean
  port: number
  bind: PhoneAccessBind
  tailscaleAvailable: boolean
  /** MagicDNS name of this machine when Tailscale is running (used by the 'https' bind mode). */
  tailscaleHostname?: string
  /** Whether the tailnet can issue HTTPS certificates (admin console → DNS → HTTPS Certificates). */
  tailscaleHttps: boolean
  /** One URL per reachable address, token included in the fragment; empty when not running. */
  urls: string[]
  token: string
  /** Connected browsers: remote address and when they attached. */
  clients: { address: string; since: number }[]
  /** Paired devices may open shells on this Mac (Settings.phoneTerminals). */
  terminals: boolean
  error?: string
}

/** Environment label and color for an account (or a manual-host group). */
export interface AccountMeta {
  label?: string
  color?: AccentColor
}
export type AccentColor = 'emerald' | 'amber' | 'rose' | 'violet' | 'sky' | 'teal' | 'orange' | 'slate'
export type GroupBy = 'account' | 'os' | 'none'

export type Route = 'direct' | 'ssm' | 'unreachable' | 'not-running'

export interface RouteDecision {
  route: Route
  reason: string
  host?: string
}

export interface HostOverride {
  sshUser?: string
  sshPort?: number
  rdpUser?: string
  rdpPort?: number
  forceRoute?: 'direct' | 'ssm'
  identityFile?: string
  useAgent?: boolean
  /** Shell input sent right after an SSH session opens. Empty string disables the global default for this host. */
  initCommand?: string
  /** Keep SSH shells running in tmux on this host; undefined follows Settings.persistentShells. */
  persistentShell?: boolean
}

/** Per-AWS-account SSH defaults. When set, the SSH button connects immediately without the dialog. */
export interface ProfileDefaults {
  sshUser?: string
  identityFile?: string
}

export interface Settings {
  /** keyed by AWS profile name */
  profileDefaults: Record<string, ProfileDefaults>
  /** instance keys pinned to the top of the list */
  favorites: string[]
  /** Named host filters, shared by the desktop and paired browsers. */
  hostViews: import('./hostViews').HostView[]
  hostDensity: 'comfortable' | 'compact'
  manualHosts: ManualHost[]
  /** user-created folders for non-AWS servers (a folder may be empty); color/label live in accountMeta['group:<name>'] */
  manualFolders: string[]
  theme: Theme
  /** Colour scheme id for embedded SSH terminals (see renderer/terminalThemes.ts); 'auto' follows `theme`. */
  terminalTheme: string
  /** Font family for embedded SSH terminals. Default Monaco. */
  terminalFont: string
  terminalFontSize: number
  /** keyed by profile name, or `group:<name>` for manual-host groups */
  accountMeta: Record<string, AccountMeta>
  groupBy: GroupBy
  collapsedGroups: string[]
  extraRegions: string[]
  scanAllRegions: boolean
  disabledProfiles: string[]
  /** Profiles removed from the sidebar entirely (stale entries in ~/.aws). */
  hiddenProfiles: string[]
  defaultLinuxUser: string
  defaultWindowsUser: string
  /** Sent to every new SSH shell (e.g. a coloured PS1 and ls --color aliases). Per-host overrides.initCommand wins. */
  sshInitCommand: string
  /** Run SSH shells inside tmux on Linux hosts so a dropped connection leaves them running and Reconnect resumes them. */
  persistentShells: boolean
  /** An icon in the macOS menu bar listing favorite hosts to connect to (Electron only). */
  menuBarIcon: boolean
  /** Folders added to the Finder tab's Favorites in this app (besides the macOS Finder sidebar's). */
  finderExtra: string[]
  /** macOS Finder favorites hidden from the Finder tab (Finder itself keeps them). */
  finderHidden: string[]
  /** A colour theme for the whole app (renderer/appThemes.ts), '' for the default look that follows `theme`. */
  colorTheme: string
  /** The font of the whole interface (renderer/uiFont.ts); notes and terminals have their own. Default System. */
  uiFont: string
  /** Text size of sections of the hosts view (renderer/sectionZoom.ts), 1 = default; keyed 'sidebar' | 'hosts'. */
  sectionZoom: Record<string, number>
  /** Folder of Markdown notes ('' = the vault Obsidian has open, else ~/Documents/EC2 Remote Access/Notes). */
  notesDir: string
  /** Subfolder of the notes folder that holds one note per host. */
  notesHostFolder: string
  /** In-app gateway for phone browsers: start with the app, TCP port, and whether to bind only the Tailscale address. */
  phoneAccessEnabled: boolean
  phoneAccessPort: number
  phoneAccessBind: PhoneAccessBind
  /** Font and text size of the Notes editor and preview (see components/NotesToolbar.tsx NOTE_FONTS). */
  notesFont?: string
  notesFontSize?: number
  /** Paired devices may open terminals (shells) on this Mac. Off by default; only this Mac's own window can change it. */
  phoneTerminals?: boolean
  sshAgentSock: string
  defaultIdentityFile: string
  pemFile: string
  externalTerminal: 'Warp' | 'Terminal' | 'iTerm'
  sessionManagerPluginPath: string
  awsCliPath: string
  connectTimeoutSec: number
  /** Auto-route: when true and a public IP exists, use it even if SSM is online. Default false (SSM first). */
  preferDirect: boolean
  overrides: Record<string, HostOverride>
  /** Saved shell commands, offered in SSH tabs and the quick switcher. */
  snippets: Snippet[]
  /** Saved port forwards, one click to reopen from the tunnel bar or the quick switcher. */
  portForwards: PortForwardPreset[]
  /** Settings → Services: the services and their systemd units that service control offers ([] = the defaults). */
  serviceCatalog: ServiceDef[]
  /** Named sets of session tabs that reopen together. */
  workspaces: Workspace[]
  /** Write every SSH session's output (ANSI codes stripped) to a log file in sessionLogDir. */
  sessionLogging: boolean
  /** Empty = ~/Documents/EC2 Remote Access/Session logs. */
  sessionLogDir: string
  /** The key held down to dictate (Mac app only); 'off' leaves only the mic buttons. Default Right Option. */
  dictationKey?: DictationKey
  /** Dictation language as a BCP 47 tag (en-US); '' follows the macOS language. */
  dictationLocale?: string
  /**
   * Keyboard shortcuts for the app rail's sections (Settings → Keyboard): section → combination such as 'ctrl+cmd+c'
   * (src/shared/keyCombos.ts). Sections left out keep their default; '' turns one off.
   */
  shortcuts?: Record<string, string>
  /** Opens the launcher from any app (Settings → Keyboard), a combination like 'alt+space'; '' for none, the default. */
  launcherKey?: string
  /**
   * Keep the 1Password CLI approvals given in this run from lapsing after ten idle minutes (main/onepassword.ts), so
   * filling asks once per account per app start, for up to twelve hours.
   */
  onePasswordStayApproved?: boolean
  /** Launcher quicklinks: a keyword that opens a page (src/shared/quicklinks.ts). */
  quicklinks?: Quicklink[]
  /**
   * Where the Health tab reads the 3DEXPERIENCE platform's metrics: a Prometheus server reached over SSM through
   * `instanceKey` (default: a running host with "monitor" or "prometheus" in its name), at `host` (default: that
   * host's private address) and `port` (default 9090).
   */
  healthSource?: { instanceKey?: string; host?: string; port?: number }
  /** The Grafana that shows the same metrics in full, for the Health tab's Open in Grafana. */
  grafanaUrl?: string
}

export interface Snippet {
  id: string
  name: string
  command: string
  /** Instance key the snippet belongs to; omitted = offered on every host. */
  hostKey?: string
  /** Press Enter after typing the command. Off pastes it for editing first. */
  run: boolean
}

export interface PortForwardPreset {
  id: string
  instanceKey: string
  name: string
  remotePort: number
  /** Omitted = any free local port. */
  localPort?: number
  /** Forward to this host as seen from the instance (e.g. an RDS endpoint) instead of the instance itself. */
  remoteHost?: string
}

export interface PortForwardRequest {
  instanceKey: string
  remotePort: number
  localPort?: number
  remoteHost?: string
  name?: string
}

/** Connection parameters worth keeping for a tab in a workspace. RDP passwords are never stored here. */
export interface WorkspaceTab {
  /** Stable reference for the workspace layout; absent on older saved workspaces. */
  id?: string
  kind: 'ssh' | 'rdp' | 'sftp'
  instanceKey: string
  user?: string
  port?: number
  identityFile?: string
  useAgent?: boolean
  forceRoute?: 'direct' | 'ssm'
  initCommand?: string
}

export interface Workspace {
  id: string
  name: string
  tabs: WorkspaceTab[]
  tools?: WorkspaceTool[]
  layout?: PaneNode | null
  activeTab?: string
  savedAt: number
}

export type WorkspaceTerminal = Pick<TerminalState, 'tabs' | 'activeTab' | 'cwds'>
export type WorkspaceBrowser = Pick<BrowserState, 'tabs' | 'activeSpace' | 'activeTab'>
/** Only navigation context is copied. Documents, shell output, cookies and tool drafts stay in their own tools. */
export type WorkspaceTool = { id: string } & (
  | { kind: 'local'; terminal: WorkspaceTerminal }
  | { kind: 'browser'; browser: WorkspaceBrowser }
  | { kind: 'notes'; path?: string }
  | { kind: 'finder'; path?: string }
  | { kind: 'board' | 'claude' | 'chatgpt' | 'health' | 'devtools' }
)

/** EC2 status checks, recent CPU and SSM check-in for the host details panel. */
export interface HostHealth {
  /** EC2 instance status check: ok | impaired | initializing | insufficient-data | not-applicable */
  instanceStatus?: string
  systemStatus?: string
  /** Scheduled events such as a retirement or reboot. */
  events: { code: string; description: string; notBefore?: string }[]
  /** CPUUtilization, 5-minute averages for the last 3 hours, oldest first. */
  cpu: { t: number; v: number }[]
  ssmLastPing?: string
  fetchedAt: number
  /** Partial failures (e.g. no cloudwatch:GetMetricData permission); the rest of the fields still apply. */
  errors: string[]
}

export interface ScanProgress {
  profile: string
  region: string
  status: 'running' | 'done' | 'error'
  count?: number
  message?: string
}

export interface ScanResult {
  instances: Instance[]
  errors: { profile: string; region: string; message: string; allRegions?: boolean }[]
  scannedAt: number
}

export interface ScanTarget {
  profile: string
  /** Omitted to refresh the profile's configured regions. */
  regions?: string[]
}

export interface SshOpenRequest {
  /** Renderer-chosen id so events emitted during connect are not lost. */
  sessionId?: string
  instanceKey: string
  user?: string
  port?: number
  identityFile?: string
  useAgent?: boolean
  forceRoute?: 'direct' | 'ssm'
  /** Shell input to send once the shell is open; undefined = resolve from host override / global setting. */
  initCommand?: string
  /** Open the shell on the connection of this existing SSH/SFTP session (same host and user) instead of logging in again. */
  reuseSessionId?: string
  /** Keep the shell running in tmux on the host; undefined = host override, then the global setting. */
  persistent?: boolean
  /** The tmux shell to attach instead of the tab's own: the one it switched to (Sessions list, Resume) before reconnecting. */
  shellName?: string
  /** The tab showed its shell before (a reconnect), so a missing one is reported as ended. */
  shellResume?: boolean
  /** Name for the shell this tab creates (connect dialog). */
  shellLabel?: string
  /** Print the shell's earlier output before attaching: a new tab opening a shell that is already running. */
  shellHistory?: boolean
  cols: number
  rows: number
}

/**
 * A browser space: one cookie container, like Arc's spaces. Every AWS account gets one automatically (`profile` set,
 * id `aws-<profile>`), which signs in to that account's console; others are the user's own (General, Jira…).
 */
export interface WebSpace {
  id: string
  name: string
  color: AccentColor
  profile?: string
  /** A colour of its own (#rrggbb) instead of `color`; with `to`, a gradient from one to the other. */
  custom?: { from: string; to?: string }
  /** An emoji shown in place of the initials. */
  icon?: string
}

export interface WebTab {
  id: string
  spaceId: string
  /** '' = a new tab, showing the start page. */
  url: string
  title: string
  favicon?: string
  /** Pinned tabs sit at the top of their space's list and survive Clear; ⌘W unloads them instead of closing. */
  pinned?: boolean
  /**
   * Favorites are the icon grid at the top of their own space (`spaceId`), as Arc gives each profile its own: they use
   * that space's logins, so they are not shown in other spaces (a Work Gmail favorite would sign Personal in as Work).
   */
  favorite?: boolean
  /** The page a pinned tab or favorite goes back to when it is unloaded (⌘W) or reset. */
  homeUrl?: string
  /** A name the user gave a pinned tab or favorite, shown instead of the page's title. */
  name?: string
  lastActive: number
}

export interface WebHistoryEntry {
  url: string
  title: string
  spaceId: string
  at: number
}

/** One thing drawn on a whiteboard (components/board). Coordinates are board units; the view pans and zooms. */
export interface BoardItem {
  id: string
  type: 'pen' | 'highlighter' | 'line' | 'arrow' | 'rect' | 'ellipse' | 'diamond' | 'text' | 'note' | 'image'
  /** Shapes, text, notes, images: the box. Pen, highlighter, line, arrow: the bounding box of `points`. */
  x: number
  y: number
  w: number
  h: number
  /** Pen and highlighter: [x, y, pressure]; line and arrow: start and end. Absolute board coordinates. */
  points?: number[][]
  /** A colour, 'ink' (follows light/dark), or 'gradient'. */
  color: string
  width: number
  fill?: 'none' | 'tint' | 'solid'
  dashed?: boolean
  text?: string
  fontSize?: number
  /** Image items: a data: URL. */
  src?: string
}

export interface Board {
  id: string
  name: string
  items: BoardItem[]
  background: 'dots' | 'grid' | 'plain'
  view: { x: number; y: number; zoom: number }
  updatedAt: number
}

export interface BoardSummary {
  id: string
  name: string
  updatedAt: number
  items: number
}

/** Opens a shell on this computer for a pane of the Terminal tab (main/localterm.ts). */
export interface LocalTermOpen {
  /** The pane id; also the session id in later term:* calls and events. */
  id: string
  cols: number
  rows: number
  cwd?: string
  /** Added to the environment (AWS_PROFILE for an AWS account tab). */
  env?: Record<string, string>
}

export interface LocalTermInfo {
  shell: string
  /** Shell integration is loaded: prompts, commands and exit codes are marked (zsh). */
  integration: boolean
  cwd: string
}

export type LocalTermEvent = { id: string; type: 'data'; data: string } | { id: string; type: 'exit'; code: number }

/** A Terminal tab's panes: one pane, or panes side by side ('row') or stacked ('column'), with their shares. */
export type PaneNode = { type: 'pane'; id: string } | { type: 'split'; dir: 'row' | 'column'; children: PaneNode[]; sizes: number[] }

export interface TermTabState {
  id: string
  /** Reuse a workspace's shell while it is still open instead of starting duplicate processes. */
  workspaceSource?: string
  /** A name the user gave the tab; otherwise it shows the running command or the folder. */
  title?: string
  color?: AccentColor
  /** AWS profile the tab's shells start with (AWS_PROFILE). */
  profile?: string
  root: PaneNode
  activePane: string
  /** A pane shown alone (⌘⇧↵) until restored. */
  maximized?: string
}

/** The Terminal tab's layout, kept between runs (terminal.json beside the settings); shells start again in `cwds`. */
export interface TerminalState {
  tabs: TermTabState[]
  activeTab: string
  cwds: Record<string, string>
  /** 'editor' = Warp-style input box at the bottom of each pane; 'shell' = type straight into the shell. */
  input?: 'editor' | 'shell'
  /** Notify when a command that ran 10 s or more finishes while you are elsewhere. */
  notify?: boolean
  /** Tabs down the left side (default) or across the top, and the side list's width in px. */
  tabBar?: 'vertical' | 'horizontal'
  tabBarWidth?: number
}

/** A 1Password login as the browser's Fill menu lists it: no secrets, only what identifies it. */
export interface WebLogin {
  id: string
  /** The 1Password account (user id) the item is in. */
  account: string
  accountName: string
  title: string
  username: string
  vault: string
  urls: string[]
  /** Saved for the site of the page it was asked for. */
  matches: boolean
}

/** A file the browser downloaded (always into the Downloads folder). */
export interface WebDownload {
  id: string
  name: string
  path: string
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  received: number
  total: number
  at: number
  /** The file's Finder icon as a data URL, once it has finished. */
  icon?: string
}

/** Everything the browser keeps between runs (main/browser.ts, browser.json beside the settings). */
export interface BrowserState {
  /** The user's own spaces; AWS account spaces are derived from the profiles and only stored as tab owners. */
  spaces: WebSpace[]
  tabs: WebTab[]
  activeSpace: string
  activeTab: Record<string, string>
  history: WebHistoryEntry[]
  /** Last favicon seen per host, for the start page's frequent sites. */
  favicons?: Record<string, string>
  sidebarHidden?: boolean
  /** Recent downloads, newest first. */
  downloads?: WebDownload[]
  /** Page zoom for every page in the browser (1 = 100%). */
  zoom?: number
  /** Sidebar width in px when the user dragged its edge; unset = the default. */
  sidebarWidth?: number
  /** A colour of their own and an emoji for AWS account spaces, by space id (their name and named colour follow the account). */
  spaceLooks?: Record<string, Pick<WebSpace, 'custom' | 'icon'>>
}

/** Where notes live (main/notes.ts) and how that was decided. */
/** What the menu-bar icon asks the app window to do (sent to the Mac's own window only, never to paired phones). */
/**
 * What the menu-bar icon (main/tray.ts) and the launcher (src/renderer/launcher) ask the app's window to do: connect
 * to a host, find one, rescan; show a rail section, a host's details, a folder in the Finder tab or a new Terminal
 * tab, a page in the Browser (a tab or space of its own), an account's AWS console (signed in), a question for Claude or
 * ChatGPT, a note, today's note; or a host's files, Run Command, a port forward, or starting or stopping it.
 */
export type AppCommand =
  | { kind: 'connect'; key: string }
  | { kind: 'switcher' }
  | { kind: 'scan' }
  | { kind: 'section'; section: RailSection }
  | { kind: 'reveal'; key: string }
  | { kind: 'finder'; path: string }
  | { kind: 'terminal'; cwd?: string; profile?: string }
  | { kind: 'workspace'; id: string }
  | { kind: 'portForward'; id: string }
  | { kind: 'browse'; url: string; space?: string; tab?: string }
  | { kind: 'note'; path: string }
  | { kind: 'files'; key: string }
  | { kind: 'run'; key: string }
  | { kind: 'forward'; key: string }
  | { kind: 'power'; key: string; action: 'start' | 'stop' }
  | { kind: 'console'; profile: string; url?: string }
  | { kind: 'ask'; app: 'claude' | 'chatgpt'; text: string }
  | { kind: 'today' }

/* ---------- Run Command (SSM SendCommand on many hosts) ---------- */

export type RunStatus = 'pending' | 'running' | 'success' | 'failed' | 'timed-out' | 'cancelled' | 'skipped' | 'error'

export interface RunTarget {
  key: string
  name: string
  profile: string
  region: string
  instanceId: string
  platform: Platform
  status: RunStatus
  exitCode?: number
  stdout?: string
  stderr?: string
  /** Why a host was skipped or the send failed, in words. */
  message?: string
  commandId?: string
  startedAt?: number
  endedAt?: number
}

export interface RunState {
  id: string
  command: string
  timeoutSec: number
  startedAt: number
  /** Set once every host has finished (or been skipped). */
  finishedAt?: number
  targets: RunTarget[]
}

export interface RunCommandRequest {
  keys: string[]
  command: string
  /** How long a host may run the command before SSM stops it (default 600). */
  timeoutSec?: number
}

/** What Settings → About shows: the build and where the app keeps its data. */
export interface AppAbout {
  version: string
  electron: string | null
  chrome: string | null
  node: string
  platform: string
  arch: string
  dataDir: string
  logsDir: string
}

export interface NotesInfo {
  dir: string
  source: 'setting' | 'obsidian' | 'default'
  hostFolder: string
  exists: boolean
}

export interface NoteEntry {
  /** Relative to the notes folder, forward slashes. */
  path: string
  /** A folder rather than a note (listed so empty folders show too). */
  folder?: boolean
  mtime: number
  size: number
}

export interface NoteFile {
  path: string
  text: string
  mtime: number
}

export interface NoteHit {
  path: string
  /** 0 = the note's name matched. */
  line: number
  text: string
}

/** A persistent shell on a host that no tab is showing (the app quit, a phone page was lost, the user detached). */
export interface DetachedShell {
  name: string
  /** The name the user gave it, e.g. "debug" ('' = unnamed). Stored on the host with the shell. */
  label: string
  /** Owner and command line of what runs in the foreground, e.g. "3dxadmin" and "tail -f catalina.out". */
  user: string
  args: string
  /** Last non-blank line on its screen: usually the prompt (user@host:dir) or the latest output. */
  preview: string
  /** Foreground program of its pane, e.g. bash or top. */
  command: string
  /** Working directory of that program, when tmux can read it. */
  path: string
  idleSec: number | null
}

/** A persistent shell on a host, as listed in a terminal tab's session list. */
export interface HostShell extends DetachedShell {
  /** Seconds since it was started. */
  ageSec: number | null
  /** Shown in the tab asking. */
  current: boolean
  /** Shown by some client: this tab, another tab, or another device. */
  attached: boolean
}

export interface SshSessionInfo {
  sessionId: string
  instanceKey: string
  title: string
  route: Route
  host: string
  user: string
  /** Where this session's output is being recorded, when session logging is on. */
  logFile?: string
  /** The shell runs in tmux on the host and survives a dropped connection. */
  persistent?: boolean
  /** Attached to a shell that was already running rather than starting one. */
  resumed?: boolean
  /** The name of the shell this session shows ('' = unnamed). */
  shellLabel?: string
  /** tmux session id of that shell, for naming or switching it later. */
  shellName?: string
  /** Other persistent shells on the host that no tab is showing, offered for resuming when this tab started a new one. */
  detached?: DetachedShell[]
}

export interface SshEvent {
  sessionId: string
  type: 'data' | 'status' | 'closed' | 'error'
  data?: string
  message?: string
}

export interface Tunnel {
  id: string
  instanceKey: string
  title: string
  kind: 'rdp' | 'ssh' | 'port'
  localPort: number
  remotePort: number
  /** Forward target as seen from the instance, when it is not the instance itself. */
  remoteHost?: string
  status: 'starting' | 'ready' | 'closed' | 'error'
  message?: string
  startedAt: number
}

export interface RdpOpenRequest {
  instanceKey: string
  user?: string
  port?: number
  forceRoute?: 'direct' | 'ssm'
}

export interface WindowsPasswordResult {
  password?: string
  error?: string
}

export interface RdpPrepareRequest {
  /** Renderer-chosen id, shared with the tab. */
  sessionId: string
  instanceKey: string
  user?: string
  port?: number
  forceRoute?: 'direct' | 'ssm'
}

export interface RdpPrepared {
  sessionId: string
  /** One-time token the web client presents to the local RDCleanPath proxy. */
  token: string
  proxyUrl: string
  destination: string
  route: Route
  title: string
  user: string
}

export interface StoredCredential {
  user: string
  password: string
  domain?: string
}

export interface SsoStartRequest {
  startUrl: string
  region: string
  openBrowser?: boolean
}
export interface SsoDeviceFlow {
  flowId: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresIn: number
}
export interface SsoAccount {
  accountId: string
  accountName: string
  email?: string
  roles: string[]
}
export interface SsoSelection {
  accountId: string
  roleName: string
  profileName: string
  region?: string
}
export interface SsoSaveRequest {
  flowId: string
  sessionName: string
  defaultRegion: string
  selections: SsoSelection[]
}
export interface StaticProfileRequest {
  profileName: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  region: string
}
export interface SsoSessionInfo {
  name: string
  startUrl?: string
  region?: string
  tokenValid: boolean
  /** ISO time the cached access token expires (the SDK may silently renew it via refresh token) */
  expiresAt?: string
  hasRefreshToken: boolean
  /** profiles that use this session */
  profiles: string[]
}

/* ---------- SFTP ---------- */

export interface SftpOpenRequest {
  /** Renderer-chosen id, shared with the tab. */
  sessionId: string
  instanceKey: string
  user?: string
  port?: number
  identityFile?: string
  useAgent?: boolean
  forceRoute?: 'direct' | 'ssm'
  /** Open the SFTP channel on the connection of this existing SSH/SFTP session (same host and user) instead of logging in again. */
  reuseSessionId?: string
}

export interface SftpSessionInfo {
  sessionId: string
  instanceKey: string
  title: string
  route: Route
  host: string
  user: string
  /** Absolute path of the login directory. */
  home: string
}

export interface SftpEntry {
  name: string
  /** Absolute remote path. */
  path: string
  type: 'file' | 'dir' | 'link' | 'other'
  size: number
  /** Unix epoch milliseconds. */
  mtime: number
  mode: number
}

export interface SftpTransfer {
  id: string
  sessionId: string
  kind: 'upload' | 'download'
  name: string
  localPath: string
  remotePath: string
  total: number
  done: number
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled' | 'skipped'
  message?: string
}

export interface SftpEvent {
  sessionId: string
  type: 'closed' | 'error'
  message?: string
}

/* ---------- Voice dictation (src/main/voice.ts, native/dictation, src/renderer/voice.ts) ---------- */

/** KeyboardEvent.code of the hold-to-talk key; 'Fn' is matched on KeyboardEvent.key, which Chromium may not report. */
export type DictationKey = 'AltRight' | 'MetaRight' | 'Fn' | 'off'

/** A macOS privacy permission as the dictation helper reads it (it never asks while reporting). */
export type VoicePermission = 'authorized' | 'denied' | 'restricted' | 'notDetermined' | 'unknown'

export interface VoiceStatus {
  /** Whether dictation can run here at all; false on the gateway, off macOS or without the helper (`message` says why). */
  available: boolean
  /** The ec2ra-dictate helper is installed (packaged with the app, or built into build/native for development). */
  helper: boolean
  message?: string
  mic: VoicePermission
  speech: VoicePermission
  /** The language is recognized on this Mac, so the audio never leaves it; otherwise Apple's speech service does it. */
  onDevice: boolean
  /** The language in use (BCP 47), and whether the recognizer supports it. */
  locale: string
  supported: boolean
  /** Languages the recognizer supports, for Settings. */
  locales: string[]
}

/** One line from the helper (see native/dictation/main.swift), as the renderer receives it. */
export interface VoiceEvent {
  id: string
  /** `end` follows every dictation, after its final text or error, once the helper has exited. */
  kind: 'ready' | 'partial' | 'final' | 'level' | 'error' | 'end'
  text?: string
  level?: number
  message?: string
  onDevice?: boolean
}

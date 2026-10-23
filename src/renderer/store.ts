import { create } from 'zustand'
import type { AwsProfile, Instance, ProfileStatus, ScanProgress, ScanResult, ScanTarget, Settings, Tunnel, Route, SshOpenRequest, SftpOpenRequest, ManualHost, HostOverride, Theme, AccentColor, SsoSessionInfo, SsoDeviceFlow, PortForwardRequest, Workspace, WorkspaceTab, WorkspaceTool, WorkspaceTerminal, WorkspaceBrowser, HostShell, PaneNode } from '@shared/types'
import { manualToInstance, manualKey } from '@shared/manual'
import { clearHostFilters, matchesHost } from '@shared/hostSearch'
import { captureHostFilters, upsertHostView, type HostView, type HostViewFilters } from '@shared/hostViews'
import { captureBrowser, captureTerminal, workspaceLayout, workspaceSummary } from '@shared/workspaces'
import { readWorkspaceContext } from './workspaceContext'
import { ssoWaitOutcome } from '@shared/ssoWait'
import { applyColorTheme } from './appThemes'
import { applyUiFont } from './uiFont'
import { applySectionZoom, type ZoomSection } from './sectionZoom'
import { arrange, insertPane, paneIds, removePane, swapPanes, type Arrangement, type Direction } from './termLayout'
import { askUrl, isWebApp, WEB_APPS, type WebAppKind } from './webApps'

export interface RdpTabRequest {
  user: string
  password: string
  domain?: string
  port?: number
  forceRoute?: 'direct' | 'ssm'
}

export interface Tab {
  id: string
  kind: 'ssh' | 'rdp' | 'sftp' | ToolKind
  instanceKey: string
  title: string
  route?: Route
  status: 'connecting' | 'connected' | 'closed' | 'error'
  message?: string
  /** SSH connection parameters; the terminal issues ssh:open once it knows its size. */
  request?: Omit<SshOpenRequest, 'cols' | 'rows'>
  /** RDP parameters; the RDP tab issues rdp:prepare and connects the embedded client. */
  rdpRequest?: RdpTabRequest
  /** SFTP parameters; the Files tab issues sftp:open on mount. */
  sftpRequest?: Omit<SftpOpenRequest, 'sessionId'>
  /** When the current connection came up; drives the tab's uptime tooltip. */
  connectedAt?: number
  /** Session transcript being written by the main process (Settings → Session logs). */
  logFile?: string
  /** The SSH shell runs in tmux on the host, so it outlives this connection (see main/ssh/persist.ts). */
  persistent?: boolean
  /** The name of the persistent shell the tab shows ("debug"), shown next to its title. */
  shellLabel?: string
  /** tmux session id of that shell, to tell which of a host's shells already have a tab. */
  shellName?: string
  /** Opened only to show a shell as a tile of a host's session grid: kept out of the tab bar, closed with the grid. */
  transient?: boolean
  /** Notes tab: the note it shows (relative to the notes folder). */
  notesPath?: string
  workspaceSource?: string
}

export interface BrowserRequest {
  workspace?: WorkspaceBrowser
  url?: string
  profile?: string
  space?: string
  tab?: string
  /** Only in the space with this partition, or nowhere (an extension's page needs the session it runs in). */
  partition?: string
  /** Open it without bringing the Browser or the new tab forward. */
  background?: boolean
}

/** The built-in tools: one tab each, opened from the app rail. */
export type ToolKind = 'local' | 'browser' | 'notes' | 'board' | 'finder' | 'storage' | 'claude' | 'chatgpt' | 'health' | 'devtools' | 'tasks' | 'calendar' | 'links'
export const TOOL_KINDS: readonly ToolKind[] = ['local', 'browser', 'notes', 'board', 'finder', 'storage', 'claude', 'chatgpt', 'health', 'devtools', 'tasks', 'calendar', 'links']
export const TOOL_NAMES: Record<ToolKind, string> = { local: 'Terminal', browser: 'Browser', notes: 'Notes', board: 'Whiteboard', finder: 'Finder', storage: 'Storage', claude: 'Claude', chatgpt: 'ChatGPT', health: 'Health', devtools: 'Dev tools', tasks: 'Tasks', calendar: 'Calendar', links: 'Links' }
/** Tools that are one tab with nothing in main to open or close: shown as they are, on every device. */
const PLAIN_TOOLS: readonly ToolKind[] = ['health', 'devtools', 'tasks', 'calendar', 'links']
/** Tools that need the Mac app (its shells, files or embedded web pages); a browser on the gateway has the others. */
export const DESKTOP_TOOLS: readonly ToolKind[] = ['local', 'browser', 'finder', 'storage', 'claude', 'chatgpt']
/** Tools about this Mac itself (its shells, files and disk): not shown at all off the Mac app. */
export const MAC_TOOLS: readonly ToolKind[] = ['local', 'finder', 'storage']
const inElectron = /\bElectron\//.test(navigator.userAgent)
/** This page is a detached tool's own window (main/toolWindows.ts loads it with ?tool=<kind>). */
export const toolWindowKind = ((): ToolKind | null => {
  const k = new URLSearchParams(location.search).get('tool')
  return k && (TOOL_KINDS as readonly string[]).includes(k) ? (k as ToolKind) : null
})()

/** How many tabs the side-by-side view shows at once. */
export const MAX_SPLIT = 6

/** Where a new tab opens: next to this tab, on that side (right by default). */
export interface Beside {
  tab: string
  side?: Direction
}

export interface Toast {
  id: number
  kind: 'info' | 'error' | 'success'
  text: string
}

export type OsFilter = 'all' | 'linux' | 'windows'
export type StateFilter = 'running' | 'all'
export type ReachFilter = 'all' | 'reachable' | 'unreachable'
export type HostPageTab = 'overview' | 'processes' | 'disks' | 'network' | 'connections' | 'properties'
export interface HostPageView { key: string; tab: HostPageTab; pid?: number }
/** A place the host page can lead back to: the tab in front, the grid, an open Services dialog, an earlier host page. */
export interface NavStop { label: string; activeTab: string; gridView: boolean; hostPage: HostPageView | null; servicesFor: State['servicesFor'] }

interface State {
  profiles: AwsProfile[]
  statuses: Record<string, ProfileStatus>
  instances: Instance[]
  scanErrors: ScanResult['errors']
  scannedAt?: number
  scanning: boolean
  progress: Record<string, ScanProgress>
  settings?: Settings
  tunnels: Tunnel[]
  tabs: Tab[]
  activeTab: string // 'hosts' or tab id
  /** All sessions tiled on one page (SessionPanes); activeTab is then the tile that has the keyboard. */
  gridView: boolean
  /** Shows or leaves the all-sessions grid; showing it needs at least one session. */
  showGrid: (on: boolean) => void
  /** Set while the grid shows only one host's SSH sessions (every shell kept on it), rather than every tab. */
  gridHost: string | null
  /**
   * Tiles every persistent shell of a tab's host: shells without a tab here get a transient one on that tab's
   * connection. Shells open on another device are left alone; returns how many.
   */
  showHostGrid: (fromId: string, shells: HostShell[]) => number
  toasts: Toast[]
  search: string
  osFilter: OsFilter
  stateFilter: StateFilter
  reachFilter: ReachFilter
  profileFilter: string | null
  favoritesOnly: boolean
  selectedKey: string | null
  detailsFor: string | null
  quickSwitcherOpen: boolean
  /** Text the quick switcher opens with, e.g. '>' for the command list. */
  quickSwitcherQuery: string
  openQuickSwitcher: (query?: string, opts?: { beside?: string }) => void
  /** The quick switcher is picking something to open beside this tab. */
  quickSwitcherBeside: string | null
  recentHosts: string[]
  /**
   * Tabs shown side by side, in reading order. The group is on screen while its focused pane (activeTab) is one of
   * them. Always the panes of splitTree.
   */
  splitGroup: string[]
  /** How the split is laid out: rows and columns of tabs with their sizes (termLayout); null when nothing is split. */
  splitTree: PaneNode | null
  /** A pane of the split shown on its own for now (⌘⇧↩); the others keep their places. */
  splitZoom: string | null
  /** Keystrokes typed in one pane of the split group go to every connected SSH pane in it. */
  broadcastInput: boolean
  /** Shows `otherId` beside `tabId` (on `side`, right by default), starting a split or joining tabId's. */
  splitWith: (tabId: string, otherId: string, side?: Direction) => void
  /** Moves tab `id` next to pane `target` of the split; `center` swaps the two (or shows `id` in its place). */
  dockPane: (id: string, target: string, side: Direction | 'center') => void
  unsplit: (tabId: string) => void
  setSplitTree: (tree: PaneNode) => void
  arrangeSplit: (kind: Arrangement) => void
  /** Leaves the side-by-side view: the focused pane stays on screen, the others stay open as tabs. */
  endSplit: () => void
  /** The tab that was in front before Hosts (⌘1), so a host can open beside it from the hosts list. */
  lastTab: string | null
  /** Gives a pane of the split the keyboard (a click or ⌥⌘ arrow); a pane shown alone goes back into the layout. */
  focusPane: (id: string) => void
  /** A session tab or a tool being dragged over the session area, to be docked beside a pane. */
  dockDrag: { tabId?: string; tool?: ToolKind } | null
  /** The tab of a tool, opened in the background when it is not open yet. */
  toolTab: (kind: ToolKind) => string
  /** Shows a tool, as its rail button does. Off the Mac app, Claude and ChatGPT open in a new browser tab instead. */
  openTool: (kind: ToolKind) => void
  /** Opens Claude or ChatGPT on a new chat that asks `text` (the launcher's Ask). */
  askAssistant: (kind: WebAppKind, text: string) => void
  /** The latest page a chat tab is asked to load (nonce makes repeats distinct). */
  webAppRequest: { kind: WebAppKind; url: string; nonce: number } | null
  /** Tools that have windows of their own (main/toolWindows.ts); their rail buttons bring those windows forward. */
  detachedTools: ToolKind[]
  /** Gives a tool a window of its own near a screen point, closing its tab here (the Terminal's shells end). */
  detachTool: (kind: ToolKind, at?: { x: number; y: number }) => Promise<void>
  /** In a tool's own window: settings, the look and the cached hosts, without the main window's sign-in checks and scans. */
  initToolWindow: (kind: ToolKind) => Promise<void>
  /** What Links is asked to show (a view such as 'tag:aws', or an item), from the Links search panel's ⌘↵. */
  linksRequest: { view?: string; id?: string; nonce: number } | null
  showInLinks: (req: { view?: string; id?: string }) => void
  moveTab: (id: string, beforeId: string | null) => void
  /** Opens another session with the same parameters; `split` shows it next to the original. */
  duplicateTab: (id: string, split?: boolean) => void
  /** Opens a persistent shell of a tab's host in a new tab, on that tab's connection. */
  openShellTab: (fromId: string, shell: HostShell) => void
  /** Shows the Notes tab (there is one), on `path` when given; `beside` shows it next to that tab in a split. */
  openNotes: (path?: string, opts?: { beside?: string }) => void
  /**
   * Shows the Browser tab (there is one), opening `url` in a new web tab when given: in the AWS account space of
   * `profile`, or in `space`; `tab` shows that tab (a favorite) in its own space.
   */
  openBrowser: (req?: BrowserRequest) => void
  /** The latest open request for the Browser tab to carry out (nonce makes repeats distinct). */
  browserRequest: (BrowserRequest & { nonce: number }) | null
  /** Shows the Terminal tab (local shells; there is one), opening a new terminal tab when asked, for an AWS profile or a folder. */
  openTerminal: (req?: { profile?: string; cwd?: string; newTab?: boolean }) => void
  terminalRequest: { profile?: string; cwd?: string; newTab?: boolean; workspace?: { id: string; terminal: WorkspaceTerminal }; nonce: number } | null
  /** Shows the Whiteboard tab (there is one). */
  openBoard: () => void
  /** Shows the Finder tab (local files; there is one), at `path` when given. */
  openFinder: (path?: string) => void
  finderRequest: { path: string; nonce: number } | null
  portForwardFor: { key?: string; presetId?: string } | null
  /** Open Run Command dialog: the hosts it starts with (editable there), or a past run to show. */
  runCommandFor: { keys: string[]; runId?: string } | null
  /** The Services dialog (service control) for these servers; `label` names a server ("3DSpace 01"), `env` its environment. */
  servicesFor: { targets: { key: string; label?: string }[]; title: string; env?: string } | null
  /** The Database locks dialog, on this database (or the first of `env`, else the last one shown). */
  dbLocksFor: { id?: string; env?: string } | null
  /** The host page (in place of the hosts list): one server in depth, `pid` one of its processes. */
  hostPage: HostPageView | null
  /**
   * Opens a server's host page. `from` names the place being left ("Services · Production"); it goes on the trail so
   * the page can lead back there (the dialog reopened, the tab shown) instead of stranding the user in the hosts list.
   */
  openHostPage: (key: string, opts?: { tab?: HostPageTab; pid?: number; from?: string }) => void
  /** One step back from the host page: a process to its host, then along the trail, then to the hosts list. */
  hostBack: () => void
  /** Back to the trail's stop `index` (the breadcrumb), dropping the stops after it. */
  hostBackTo: (index: number) => void
  /** Where the host page was reached from, oldest first. */
  trail: NavStop[]
  openPortForward: (req: PortForwardRequest) => Promise<Tunnel | null>
  snippetsOpen: { hostKey?: string } | null
  workspaceSaveOpen: boolean
  saveWorkspace: (name: string, ids: string[], options?: { layout?: boolean; terminalTabs?: string[]; browserTabs?: string[] }) => Promise<void>
  openingWorkspace: string | null
  openWorkspace: (id: string) => Promise<void>
  deleteWorkspace: (id: string) => Promise<void>
  shortcutsOpen: boolean
  clearFilters: () => void
  applyHostView: (filters: HostViewFilters) => void
  saveHostView: (name: string, id?: string, filters?: HostViewFilters) => Promise<void>
  deleteHostView: (id: string) => Promise<void>
  revealHost: (key: string) => void
  /** `beside`: where the new session opens, next to another tab. */
  connectFor: { kind: 'ssh' | 'rdp' | 'sftp'; key: string; beside?: Beside } | null
  passwordFor: string | null
  settingsOpen: boolean
  /** null = closed; 'new' = add; otherwise the ManualHost id being edited */
  manualHostEditor: string | null
  /** preselected folder when adding a server from a folder's "+" */
  manualHostFolder: string | null
  /** null = closed; 'new' = create; otherwise the folder name being edited */
  folderEditor: string | null
  addAccountOpen: boolean
  /** profile name being edited, or null */
  editAccount: string | null
  ssoSessions: SsoSessionInfo[]
  ssoWait: { flow: SsoDeviceFlow; session: string; error?: string } | null
  /** Icon-only sidebar. Remembered per machine in localStorage. */
  sidebarCollapsed: boolean
  /** Appearance pane (themes/font) shown inside SSH tabs. Remembered per machine in localStorage. */
  terminalPaneOpen: boolean
  toggleTerminalPane: (open?: boolean) => void
  authBannerDismissedFor: string | null
  refreshSsoSessions: () => Promise<void>
  /** Derived: are any enabled SSO accounts expired / expiring soon? */
  authState: () => { kind: 'ok' } | { kind: 'expired' | 'expiring'; key: string; minutesLeft: number; profiles: string[] }
  /** Called by connect paths when an operation fails; re-checks auth if the error smells like an expired token. */
  noteOperationError: (message: string) => void

  init: () => Promise<void>
  refreshProfiles: () => Promise<void>
  checkAuth: (profile?: string) => Promise<void>
  login: (profile: string) => Promise<void>
  /** Runs `aws sso login` for the shared SSO session (same as the user's `aws-login` alias), then re-checks and rescans. */
  refreshToken: () => Promise<void>
  loggingIn: boolean
  scan: (profiles?: string[], retryTargets?: ScanTarget[]) => Promise<void>
  retryFailedScans: () => Promise<void>
  saveSettings: (patch: Partial<Settings>) => Promise<void>
  saveManualHost: (host: ManualHost, override: HostOverride) => Promise<void>
  /** Create or rename a folder and set its color. `oldName` null = create. */
  saveFolder: (oldName: string | null, name: string, color: AccentColor) => Promise<void>
  /** Delete a folder; its servers move to `moveTo` (or are deleted when moveTo is null). */
  deleteFolder: (name: string, moveTo: string | null) => Promise<void>
  folders: () => string[]
  deleteManualHost: (id: string) => Promise<void>
  /** Auto / Light / Dark. Picking one goes back to the default colours (it clears a colour theme); the terminal follows. */
  setTheme: (theme: Theme) => Promise<void>
  /** A colour theme for the whole app ('' for the default); it decides light or dark itself, and the terminal follows. */
  setColorTheme: (id: string) => Promise<void>
  /** The interface font (UI_FONTS id). */
  setUiFont: (id: string) => Promise<void>
  /** Text size of one section of the hosts view (1 = default). */
  setSectionZoom: (section: ZoomSection, zoom: number) => Promise<void>
  toggleGroup: (key: string) => Promise<void>
  setAllGroups: (keys: string[], collapsed: boolean) => Promise<void>
  isFavorite: (key: string) => boolean
  toggleFavorite: (key: string) => Promise<void>
  toast: (kind: Toast['kind'], text: string) => void
  dismissToast: (id: number) => void
  /** `beside` shows the new tab next to another one in the split. */
  addTab: (tab: Tab, opts?: { beside?: Beside }) => void
  updateTab: (id: string, patch: Partial<Tab>) => void
  /** `detach` leaves a persistent SSH shell running on the host instead of ending it. */
  closeTab: (id: string, opts?: { detach?: boolean }) => Promise<void>
  setActive: (id: string) => void
  set: (patch: Partial<State>) => void
  toggleSidebar: (collapsed?: boolean) => void
}

let toastSeq = 0

const SIDEBAR_KEY = 'ui.sidebarCollapsed'
const TERMINAL_PANE_KEY = 'ui.terminalPaneOpen'

function readPref(key: string): boolean {
  try { return localStorage.getItem(key) === '1' } catch { return false }
}

/**
 * A tool that has a window of its own opens things there: the main window hands the call on (tools:relay) instead of
 * opening a second copy of the tool here. Never in the tool's own window.
 */
function relayed(kind: ToolKind, method: string, args: unknown[]): boolean {
  if (toolWindowKind || !useStore.getState().detachedTools.includes(kind)) return false
  void window.api.invoke('tools:relay', kind, method, args).catch(() => undefined)
  return true
}
/** The calls a tool's window carries out for the main window. */
const RELAYED: Record<string, (s: State, args: unknown[]) => void> = {
  openBrowser: (s, a) => s.openBrowser(a[0] as BrowserRequest | undefined),
  openNotes: (s, a) => s.openNotes(typeof a[0] === 'string' ? a[0] : undefined),
  openTerminal: (s, a) => s.openTerminal(a[0] as { profile?: string; cwd?: string; newTab?: boolean } | undefined),
  openFinder: (s, a) => s.openFinder(typeof a[0] === 'string' ? a[0] : undefined),
  openBoard: (s) => s.openBoard(),
  openTool: (s, a) => { if ((TOOL_KINDS as readonly unknown[]).includes(a[0])) s.openTool(a[0] as ToolKind) },
  showInLinks: (s, a) => s.showInLinks((a[0] ?? {}) as { view?: string; id?: string }),
  askAssistant: (s, a) => { if (a[0] === 'claude' || a[0] === 'chatgpt') s.askAssistant(a[0], String(a[1] ?? '')) }
}

export const useStore = create<State>((set, get) => ({
  profiles: [],
  statuses: {},
  sidebarCollapsed: readSidebarPref(),
  terminalPaneOpen: readPref(TERMINAL_PANE_KEY),
  instances: [],
  scanErrors: [],
  scanning: false,
  loggingIn: false,
  progress: {},
  tunnels: [],
  tabs: [],
  activeTab: 'hosts',
  gridView: false,
  showGrid: (on) => set((s) => {
    // Either way the host grid's transient tabs go (unmounting a tab detaches its shell; it keeps running).
    const tabs = s.tabs.filter((t) => !t.transient)
    // Tiles are sessions, so the Notes tab neither counts nor takes the focus.
    const sessions = tabs.filter(isSession)
    if (!on || !sessions.length) return { gridView: false, gridHost: null, tabs }
    return { gridView: true, gridHost: null, tabs, activeTab: sessions.some((t) => t.id === s.activeTab) ? s.activeTab : sessions[0].id }
  }),
  gridHost: null,
  showHostGrid: (fromId, shells) => {
    const st = get()
    const from = st.tabs.find((t) => t.id === fromId)
    if (!from?.request) return 0
    const inTabs = new Set(st.tabs.filter((t) => t.instanceKey === from.instanceKey && t.shellName).map((t) => t.shellName))
    const missing = shells.filter((sh) => !sh.current && !inTabs.has(sh.name))
    const extra = missing.filter((sh) => !sh.attached).map((sh) => shellTab(from, sh, true))
    set((s) => ({ tabs: [...s.tabs.filter((t) => !t.transient), ...extra], gridView: true, gridHost: from.instanceKey, activeTab: fromId }))
    return missing.length - extra.length
  },
  toasts: [],
  search: '',
  osFilter: 'all',
  stateFilter: 'running',
  reachFilter: 'all',
  profileFilter: null,
  favoritesOnly: false,
  selectedKey: null,
  detailsFor: null,
  quickSwitcherOpen: false,
  quickSwitcherQuery: '',
  quickSwitcherBeside: null,
  openQuickSwitcher: (query = '', opts) => set({ quickSwitcherOpen: true, quickSwitcherQuery: query, quickSwitcherBeside: opts?.beside ?? null }),
  recentHosts: readRecentHosts(),
  splitGroup: [],
  splitTree: null,
  splitZoom: null,
  broadcastInput: false,
  splitWith: (tabId, otherId, side = 'right') => {
    const s = get()
    if (tabId === otherId || !s.tabs.some((t) => t.id === tabId) || !s.tabs.some((t) => t.id === otherId)) return
    // Splitting a tab outside the current split starts a new one; a tab already in it moves rather than showing twice.
    const base: PaneNode = s.splitTree && s.splitGroup.includes(tabId) ? s.splitTree : { type: 'pane', id: tabId }
    const rest = paneIds(base).includes(otherId) ? removePane(base, otherId) ?? { type: 'pane', id: tabId } : base
    if (paneIds(rest).length >= MAX_SPLIT) { s.toast('info', `Up to ${MAX_SPLIT} tabs fit side by side; take one out of the split first.`); return }
    set((st) => ({ ...splitFields(insertPane(rest, tabId, otherId, side), { ...st, splitZoom: null }) }))
    get().setActive(otherId)
  },
  dockPane: (id, target, side) => {
    const s = get()
    if (id === target || !s.tabs.some((t) => t.id === id)) return
    const tree = s.splitTree && s.splitGroup.includes(target) ? s.splitTree : null
    if (side !== 'center') {
      if (!tree) { get().splitWith(target, id, side); return }
      const rest = s.splitGroup.includes(id) ? removePane(tree, id) ?? { type: 'pane', id: target } : tree
      if (!s.splitGroup.includes(id) && s.splitGroup.length >= MAX_SPLIT) { s.toast('info', `Up to ${MAX_SPLIT} tabs fit side by side; take one out of the split first.`); return }
      set((st) => splitFields(insertPane(rest, target, id, side), { ...st, splitZoom: null }))
    } else if (tree) {
      // Two panes of the split trade places; a tab from outside takes the target's place (the target stays a tab).
      set((st) => splitFields(swapPanes(tree, id, target), { ...st, splitZoom: null }))
    }
    get().setActive(id)
  },
  unsplit: (tabId) => set((s) => (s.splitTree ? splitFields(removePane(s.splitTree, tabId), s) : {})),
  setSplitTree: (tree) => set((s) => splitFields(tree, s)),
  arrangeSplit: (kind) => set((s) => (s.splitTree ? splitFields(arrange(kind, s.splitGroup), { ...s, splitZoom: null }) : {})),
  endSplit: () => set((s) => splitFields(null, s)),
  lastTab: null,
  focusPane: (id) => set((s) => (s.activeTab === id ? {} : { activeTab: id, splitZoom: null })),
  dockDrag: null,
  toolTab: (kind) => {
    const have = get().tabs.find((t) => t.kind === kind)
    if (have) return have.id
    const tab: Tab = { id: `${kind}-${Date.now().toString(36)}`, kind, instanceKey: '', title: TOOL_NAMES[kind], status: 'connected' }
    set((s) => ({ tabs: [...s.tabs, tab] }))
    return tab.id
  },
  openTool: (kind) => {
    if (relayed(kind, 'openTool', [kind])) return
    const s = get()
    if (kind === 'local') s.openTerminal()
    else if (kind === 'browser') s.openBrowser()
    else if (kind === 'notes') s.openNotes()
    else if (kind === 'finder') s.openFinder()
    else if (kind === 'board') s.openBoard()
    else if (PLAIN_TOOLS.includes(kind) || kind === 'storage') s.setActive(s.toolTab(kind))
    else if (inElectron) s.setActive(s.toolTab(kind))
    else void window.api.invoke('shell:open', WEB_APPS[kind as WebAppKind].home)
  },
  webAppRequest: null,
  detachedTools: [],
  detachTool: async (kind, at) => {
    const s = get()
    const tabs = s.tabs.filter((t) => t.kind === kind)
    if (kind === 'local' && tabs.length && !window.confirm('Move the Terminal to a window of its own? Its shells start again there, so commands running in them stop.')) return
    for (const t of tabs) await get().closeTab(t.id)
    await window.api.invoke('tools:detach', kind, at)
  },
  initToolWindow: async (kind) => {
    const [settings, cached] = await Promise.all([window.api.invoke('settings:get'), window.api.invoke('inventory:cached')])
    set({ settings })
    applyUiFont(settings.uiFont)
    applySectionZoom(settings.sectionZoom)
    applyAppearance(settings.theme, settings.colorTheme)
    if (cached) set({ instances: cached.instances, scanErrors: cached.errors, scannedAt: cached.scannedAt })
    // What the main window hands on ("open this page in the Browser"), for this window's tool only.
    window.api.on('tools:relay', ({ method, args }) => {
      const fn = RELAYED[method]
      if (fn) fn(get(), args)
    })
    window.api.on('ext:openTab', (d) => { if (kind === 'browser') get().openBrowser({ url: d.url, partition: d.partition, background: d.background }) })
    await get().refreshProfiles()
    get().setActive(get().toolTab(kind))
  },
  linksRequest: null,
  showInLinks: (req) => {
    if (relayed('links', 'showInLinks', [req])) return
    set({ linksRequest: { ...req, nonce: Date.now() + Math.random() } })
    get().openTool('links')
  },
  askAssistant: (kind, text) => {
    if (relayed(kind, 'askAssistant', [kind, text])) return
    if (!inElectron) {
      void window.api.invoke('shell:open', askUrl(kind, text))
      return
    }
    set({ webAppRequest: { kind, url: askUrl(kind, text), nonce: Date.now() + Math.random() } })
    get().openTool(kind)
  },
  moveTab: (id, beforeId) => set((s) => {
    const tab = s.tabs.find((t) => t.id === id)
    if (!tab || id === beforeId) return {}
    const rest = s.tabs.filter((t) => t.id !== id)
    const at = beforeId ? rest.findIndex((t) => t.id === beforeId) : -1
    rest.splice(at < 0 ? rest.length : at, 0, tab)
    return { tabs: rest }
  }),
  terminalRequest: null,
  openTerminal: (req) => {
    if (relayed('local', 'openTerminal', [req])) return
    const id = get().toolTab('local')
    if (req) set({ terminalRequest: { ...req, nonce: Date.now() + Math.random() } })
    get().setActive(id)
  },
  finderRequest: null,
  openFinder: (path) => {
    if (relayed('finder', 'openFinder', [path])) return
    const id = get().toolTab('finder')
    if (path) set({ finderRequest: { path, nonce: Date.now() + Math.random() } })
    get().setActive(id)
  },
  openBoard: () => { if (!relayed('board', 'openBoard', [])) get().setActive(get().toolTab('board')) },
  browserRequest: null,
  openBrowser: (req) => {
    if (relayed('browser', 'openBrowser', [req])) return
    const id = get().toolTab('browser')
    if (req?.url || req?.profile || req?.space || req?.tab) set({ browserRequest: { ...req, nonce: Date.now() + Math.random() } })
    if (!req?.background) get().setActive(id)
  },
  openNotes: (path, opts) => {
    if (relayed('notes', 'openNotes', [path])) return
    const id = get().toolTab('notes')
    if (path) get().updateTab(id, { notesPath: path })
    if (opts?.beside && opts.beside !== id && get().tabs.some((t) => t.id === opts.beside)) get().splitWith(opts.beside, id)
    else get().setActive(id)
  },
  openShellTab: (fromId, shell) => {
    const st = get()
    const tab = st.tabs.find((t) => t.id === fromId)
    if (tab?.request) st.addTab(shellTab(tab, shell, false))
  },
  duplicateTab: (id, split = false) => {
    const st = get()
    const tab = st.tabs.find((t) => t.id === id)
    if (!tab) return
    const nid = `${tab.kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const base = { id: nid, kind: tab.kind, instanceKey: tab.instanceKey, title: tab.title, status: 'connecting' as const }
    // A connected SSH/SFTP tab lends its authenticated connection, as quickConnect does.
    const reuse = tab.status === 'connected' && tab.kind !== 'rdp' ? tab.id : undefined
    // A duplicate starts a shell of its own rather than attaching to the one the original shows.
    if (tab.kind === 'ssh' && tab.request) st.addTab({ ...base, request: { ...tab.request, sessionId: nid, reuseSessionId: reuse, shellName: undefined, shellHistory: undefined, shellLabel: undefined } })
    else if (tab.kind === 'sftp' && tab.sftpRequest) st.addTab({ ...base, sftpRequest: { ...tab.sftpRequest, reuseSessionId: reuse } })
    else if (tab.kind === 'rdp' && tab.rdpRequest) st.addTab({ ...base, rdpRequest: tab.rdpRequest })
    else return
    if (split) get().splitWith(id, nid)
  },
  portForwardFor: null,
  runCommandFor: null,
  servicesFor: null,
  dbLocksFor: null,
  hostPage: null,
  trail: [],
  openHostPage: (key, opts = {}) => {
    const s = get()
    const here: NavStop | null = opts.from ? { label: opts.from, activeTab: s.activeTab, gridView: s.gridView, hostPage: s.activeTab === 'hosts' ? s.hostPage : null, servicesFor: s.servicesFor } : null
    s.setActive('hosts')
    set((x) => ({
      hostPage: { key, tab: opts.tab ?? (opts.pid ? 'processes' : 'overview'), pid: opts.pid },
      // Opened from the list itself, a new walk starts.
      trail: here ? [...x.trail, here].slice(-8) : x.hostPage ? x.trail : [],
      servicesFor: null, selectedKey: key
    }))
  },
  hostBack: () => {
    const s = get()
    if (s.hostPage?.pid) return set({ hostPage: { ...s.hostPage, pid: undefined, tab: 'processes' } })
    if (s.trail.length) return s.hostBackTo(s.trail.length - 1)
    set({ hostPage: null })
  },
  hostBackTo: (index) => {
    const s = get()
    const stop = s.trail[index]
    if (!stop) return
    // The tab may have been closed since; the hosts list stands in for it.
    const tab = stop.activeTab === 'hosts' || s.tabs.some((t) => t.id === stop.activeTab) ? stop.activeTab : 'hosts'
    s.setActive(tab)
    set({ trail: s.trail.slice(0, index), hostPage: stop.hostPage, servicesFor: stop.servicesFor })
    if (stop.gridView && tab !== 'hosts') get().showGrid(true)
  },
  openPortForward: async (req) => {
    try {
      const t = await window.api.invoke('tunnels:open', req)
      get().toast('success', `Forwarding localhost:${t.localPort} → ${t.remoteHost ?? t.title.split(':')[0]}:${t.remotePort}`)
      return t
    } catch (e) {
      get().noteOperationError((e as Error).message)
      get().toast('error', (e as Error).message)
      return null
    }
  },
  snippetsOpen: null,
  workspaceSaveOpen: false,
  saveWorkspace: async (name, ids, options = {}) => {
    const state = get()
    const selected = state.tabs.filter((t) => ids.includes(t.id) && !t.transient)
    if (!name.trim() || !selected.length) throw new Error('Choose a name and at least one tab for this workspace.')
    const tabs: WorkspaceTab[] = []
    const tools: WorkspaceTool[] = []
    for (const t of selected) {
      if (isSession(t)) { tabs.push({ ...workspaceTabOf(t), id: t.id }); continue }
      if (t.kind === 'local' || t.kind === 'browser' || t.kind === 'finder') {
        const context = readWorkspaceContext(t.kind)
        if (!context) throw new Error(`${TOOL_NAMES[t.kind]} is still loading. Open it, then save the workspace again.`)
        if (context.kind === 'local') {
          const terminal = captureTerminal(context.terminal, options.terminalTabs)
          if (!terminal.tabs.length) throw new Error('Choose at least one terminal tab, or deselect Terminal.')
          tools.push({ id: t.id, kind: 'local', terminal })
        } else if (context.kind === 'browser') tools.push({ id: t.id, kind: 'browser', browser: captureBrowser(context.browser, options.browserTabs) })
        else tools.push({ ...context, id: t.id })
      } else if (t.kind === 'notes') tools.push({ id: t.id, kind: 'notes', path: t.notesPath })
      else tools.push({ id: t.id, kind: t.kind as 'board' | 'claude' | 'chatgpt' | 'health' | 'devtools' | 'tasks' | 'calendar' | 'links' })
    }
    const cur = state.settings?.workspaces ?? []
    const existing = cur.find((w) => w.name.toLowerCase() === name.trim().toLowerCase())
    const refs = new Map(selected.map((t) => [t.id, t.id]))
    const ws: Workspace = {
      id: existing?.id ?? `ws-${Date.now().toString(36)}`, name: name.trim(), tabs, tools, savedAt: Date.now(),
      layout: options.layout === false ? null : workspaceLayout(state.splitTree, refs),
      activeTab: refs.get(state.activeTab) ?? selected[0].id
    }
    await get().saveSettings({ workspaces: [...cur.filter((w) => w.id !== ws.id), ws].sort((a, b) => a.name.localeCompare(b.name)) })
    get().toast('success', `Workspace “${ws.name}” saved · ${workspaceSummary(ws)}`)
  },
  openingWorkspace: null,
  openWorkspace: async (id) => {
    const ws = get().settings?.workspaces.find((w) => w.id === id)
    if (!ws || get().openingWorkspace) return
    set({ openingWorkspace: id })
    try {
      const known = new Set(visibleInstances(get()).map((i) => i.key))
      const refs = new Map<string, string>()
      const skipped: string[] = []
      const credentials: string[] = []
      for (const [index, t] of ws.tabs.entries()) {
        if (!known.has(t.instanceKey)) { skipped.push('host missing or account disabled'); continue }
        const source = `${ws.id}/${t.id ?? index}`
        const live = get().tabs.find((x) => !x.transient && (x.id === t.id || x.workspaceSource === source) && (x.status === 'connected' || x.status === 'connecting'))
        const tabId = live?.id ?? await openWorkspaceTab(t, source)
        if (tabId) refs.set(t.id ?? `legacy-${index}`, tabId)
        else credentials.push(t.instanceKey)
      }
      for (const t of ws.tools ?? []) {
        if (!inElectron && DESKTOP_TOOLS.includes(t.kind)) {
          const allowed = t.kind === 'local' && await window.api.invoke('term:available').catch(() => false)
          if (!allowed) { skipped.push(`${TOOL_NAMES[t.kind]} unavailable on this device`); continue }
        }
        const tabId = get().toolTab(t.kind)
        refs.set(t.id, tabId)
        const nonce = Date.now() + Math.random()
        if (t.kind === 'local') set({ terminalRequest: { workspace: { id: ws.id, terminal: t.terminal }, nonce } })
        else if (t.kind === 'browser') set({ browserRequest: { workspace: t.browser, nonce } })
        else if (t.kind === 'finder' && t.path) set({ finderRequest: { path: t.path, nonce } })
        else if (t.kind === 'notes') get().updateTab(tabId, { notesPath: t.path })
      }
      const active = refs.get(ws.activeTab ?? '') ?? refs.values().next().value
      if (active) {
        get().setActive(active)
        set({ ...splitFields(workspaceLayout(ws.layout, refs), { broadcastInput: false, splitZoom: null }), hostPage: null })
      }
      if (credentials.length) {
        skipped.push(`${credentials.length} RDP ${credentials.length === 1 ? 'session needs' : 'sessions need'} credentials`)
        // Only one credential dialog can be shown at a time; other missing credentials remain visible in the summary.
        set({ connectFor: { kind: 'rdp', key: credentials[0] } })
      }
      get().toast(skipped.length ? 'info' : 'success', `${active ? 'Opened' : 'Could not open'} “${ws.name}”${skipped.length ? ` · ${skipped.join('; ')}` : ''}`)
    } catch (e) { get().toast('error', `Could not finish opening “${ws.name}”: ${(e as Error).message}`) }
    finally { set({ openingWorkspace: null }) }
  },
  deleteWorkspace: async (id) => {
    await get().saveSettings({ workspaces: (get().settings?.workspaces ?? []).filter((w) => w.id !== id) })
  },
  shortcutsOpen: false,
  clearFilters: () => set({ ...clearHostFilters }),
  applyHostView: (filters) => {
    get().setActive('hosts')
    set({ ...captureHostFilters(filters), selectedKey: null, detailsFor: null, hostPage: null, trail: [] })
  },
  saveHostView: async (name, id, filters) => {
    // Paired browsers on plain HTTP do not expose randomUUID; this identifier is only a settings key.
    const view: HostView = { id: id ?? `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`, name, filters: captureHostFilters(filters ?? get()) }
    await get().saveSettings({ hostViews: upsertHostView(get().settings?.hostViews ?? [], view) })
  },
  deleteHostView: async (id) => {
    await get().saveSettings({ hostViews: (get().settings?.hostViews ?? []).filter((v) => v.id !== id) })
  },
  revealHost: (key) => {
    const st = get()
    const inst = allInstances(st).find((i) => i.key === key)
    if (!inst) return
    const group = inst.manual ? `group:${inst.region}` : inst.profile
    const collapsedGroups = st.settings?.collapsedGroups.filter((g) => !['fav', group, `os:${inst.platform}`].includes(g)) ?? []
    set({ ...clearHostFilters, activeTab: 'hosts', selectedKey: key, detailsFor: key, hostPage: null, trail: [],
      settings: st.settings ? { ...st.settings, collapsedGroups } : undefined })
    if (collapsedGroups.length !== st.settings?.collapsedGroups.length) {
      void get().saveSettings({ collapsedGroups }).catch((e: Error) => get().toast('error', e.message))
    }
  },
  connectFor: null,
  passwordFor: null,
  settingsOpen: false,
  manualHostEditor: null,
  manualHostFolder: null,
  folderEditor: null,
  addAccountOpen: false,
  editAccount: null,
  ssoSessions: [],
  ssoWait: null,
  authBannerDismissedFor: null,

  set: (patch) => set(patch),
  toggleSidebar: (collapsed) => {
    const next = collapsed ?? !get().sidebarCollapsed
    set({ sidebarCollapsed: next })
    applySidebar(next)
    try {
      localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0')
    } catch {
      /* storage unavailable */
    }
  },

  init: async () => {
    const [settings, cached, tunnels] = await Promise.all([
      window.api.invoke('settings:get'),
      window.api.invoke('inventory:cached'),
      window.api.invoke('tunnels:list')
    ])
    set({ settings, tunnels })
    applyUiFont(settings.uiFont)
    applySectionZoom(settings.sectionZoom)
    const shade = applyAppearance(settings.theme, settings.colorTheme)
    if (settings.colorTheme) void window.api.invoke('theme:set', shade)
    if (cached) set({ instances: cached.instances, scanErrors: cached.errors, scannedAt: cached.scannedAt })
    window.api.on('scan:progress', (p) => set((s) => ({ progress: { ...s.progress, [`${p.profile}/${p.region}`]: p } })))
    window.api.on('tunnels:changed', (tunnels) => set({ tunnels }))
    if (inElectron) {
      const tools = (kinds: string[]): ToolKind[] => kinds.filter((k): k is ToolKind => (TOOL_KINDS as readonly string[]).includes(k))
      window.api.on('tools:detached', (kinds) => set({ detachedTools: tools(kinds) }))
      void window.api.invoke('tools:list').then((kinds) => set({ detachedTools: tools(kinds) }), () => undefined)
    }
    window.api.on('ext:openTab', (d) => get().openBrowser({ url: d.url, partition: d.partition, background: d.background }))
    window.api.on('profiles:status', (st) => {
      if (st.profile.startsWith('sso-session:')) {
        if (st.state === 'error') {
          const w = get().ssoWait
          if (w) set({ ssoWait: { ...w, error: st.message ?? 'SSO login failed' }, loggingIn: false })
          else get().toast('error', st.message ?? 'SSO login failed')
        }
        return
      }
      set((s) => ({ statuses: { ...s.statuses, [st.profile]: st } }))
    })
    await get().refreshProfiles()
    await get().checkAuth()
    await get().refreshSsoSessions()
    setInterval(() => void get().refreshSsoSessions(), 60_000)
    const auth = get().authState()
    if (auth.kind === 'expired') get().toast('error', 'Your AWS session has expired. Click Sign in to refresh it.')
    if (!cached) void get().scan()
  },

  refreshSsoSessions: async () => {
    try {
      const ssoSessions = await window.api.invoke('sso:sessions')
      set({ ssoSessions })
      // When the cached token just expired, re-verify with STS so the sidebar dots and banner agree.
      const nowExpired = ssoSessions.some((x) => !x.tokenValid && !x.hasRefreshToken)
      const anyOk = Object.values(get().statuses).some((st) => st.state === 'ok')
      if (nowExpired && anyOk) void get().checkAuth()
    } catch {
      /* ignore */
    }
  },

  authState: () => {
    const st = get()
    const enabled = new Set(st.profiles.filter((p) => p.enabled && p.kind === 'sso').map((p) => p.name))
    const needLogin = Object.values(st.statuses).filter((x) => enabled.has(x.profile) && x.state === 'login-required').map((x) => x.profile)
    if (needLogin.length) return { kind: 'expired', key: `expired:${needLogin.sort().join(',')}`, minutesLeft: 0, profiles: needLogin }
    let soonest: SsoSessionInfo | null = null
    for (const x of st.ssoSessions) {
      if (!x.profiles.some((p) => enabled.has(p)) || !x.expiresAt) continue
      if (!soonest || new Date(x.expiresAt) < new Date(soonest.expiresAt!)) soonest = x
    }
    if (soonest?.expiresAt) {
      const minutesLeft = Math.round((new Date(soonest.expiresAt).getTime() - Date.now()) / 60_000)
      // With a refresh token the SDK renews silently; only warn when it cannot.
      if (minutesLeft <= 0 && !soonest.hasRefreshToken) return { kind: 'expired', key: `expired:${soonest.name}`, minutesLeft: 0, profiles: soonest.profiles }
      if (minutesLeft > 0 && minutesLeft <= 10 && !soonest.hasRefreshToken) return { kind: 'expiring', key: `expiring:${soonest.name}:${soonest.expiresAt}`, minutesLeft, profiles: soonest.profiles }
    }
    return { kind: 'ok' }
  },

  noteOperationError: (message) => {
    if (/token|sso|expired|credential|UnrecognizedClient|InvalidClientTokenId|ExpiredToken|not authorized/i.test(message)) {
      void get().checkAuth()
      void get().refreshSsoSessions()
    }
  },

  refreshProfiles: async () => {
    const profiles = await window.api.invoke('profiles:list')
    set({ profiles })
  },

  checkAuth: async (profile) => {
    const targets = profile ? [profile] : get().profiles.filter((p) => p.enabled).map((p) => p.name)
    set((s) => {
      const statuses = { ...s.statuses }
      for (const t of targets) statuses[t] = { profile: t, state: 'checking' }
      return { statuses }
    })
    const results = await window.api.invoke('profiles:check', profile)
    set((s) => {
      const statuses = { ...s.statuses }
      for (const r of results) statuses[r.profile] = r
      return { statuses }
    })
  },

  login: async (profile) => {
    set((s) => ({ statuses: { ...s.statuses, [profile]: { profile, state: 'checking', message: 'Waiting for browser login...' } } }))
    try {
      const r = await window.api.invoke('profiles:login', profile)
      set((s) => ({ statuses: { ...s.statuses, [profile]: r } }))
      if (r.state === 'ok') {
        get().toast('success', `Logged in: ${profile}`)
        // SSO sessions are shared; re-check siblings and rescan.
        await get().checkAuth()
        void get().scan()
      } else get().toast('error', r.message ?? 'Login failed')
    } catch (e) {
      get().toast('error', (e as Error).message)
      set((s) => ({ statuses: { ...s.statuses, [profile]: { profile, state: 'error', message: (e as Error).message } } }))
    }
  },

  refreshToken: async () => {
    const sso = get().profiles.find((p) => p.enabled && p.kind === 'sso') ?? get().profiles.find((p) => p.kind === 'sso')
    if (!sso) {
      get().toast('error', 'No SSO profile found in ~/.aws/config')
      return
    }
    if (!sso.ssoSession) {
      // legacy profile without an sso-session block: fall back to the CLI-driven login
      set({ loggingIn: true })
      try {
        await get().login(sso.name)
      } finally {
        set({ loggingIn: false })
      }
      return
    }
    set({ loggingIn: true })
    try {
      // From a phone or browser the approval page belongs on that device; opening it on the Mac helps nobody.
      const remote = !/\bElectron\//.test(navigator.userAgent)
      const flow = await window.api.invoke('sso:loginSession', sso.ssoSession, { openBrowser: !remote })
      set({ ssoWait: { flow, session: sso.ssoSession } })
      if (remote) void window.api.invoke('shell:open', flow.verificationUriComplete)
      // Completion normally arrives via profiles:status pushes (see init); watch for all-ok.
      const started = Date.now()
      const expiresAtBefore = get().ssoSessions.find((x) => x.name === sso.ssoSession)?.expiresAt
      const accountsOk = (sinceStart: boolean): boolean => {
        const st = get()
        const enabled = st.profiles.filter((p) => p.enabled && p.ssoSession === sso.ssoSession)
        return enabled.length > 0 && enabled.every((p) => st.statuses[p.name]?.state === 'ok' && (!sinceStart || (st.statuses[p.name]?.checkedAt ?? 0) > started))
      }
      let finished = false
      const finish = (): void => {
        if (finished) return
        finished = true
        clearInterval(timer)
        set({ ssoWait: null, loggingIn: false, authBannerDismissedFor: null })
        get().toast('success', 'Signed in. Refreshing inventory…')
        void get().refreshSsoSessions()
        void get().scan()
      }
      // A push only reaches sockets open at that moment. On a phone the user approves in Safari, iOS suspends the
      // page and drops its socket, and the "signed in" push is gone by the time it reconnects. So also ask the
      // computer what token it holds (see ssoWaitOutcome); this works however long the page was away.
      let asking = false
      const askComputer = async (): Promise<void> => {
        try {
          const list = await window.api.invoke('sso:sessions')
          const w = get().ssoWait
          if (finished || !w) return
          set({ ssoSessions: list })
          const outcome = ssoWaitOutcome({ session: list.find((x) => x.name === sso.ssoSession), expiresAtBefore, startedAt: started, flowExpiresInSec: flow.expiresIn, now: Date.now() })
          if (outcome === 'signed-in') {
            await get().checkAuth()
            if (!finished && get().ssoWait && accountsOk(false)) finish()
          } else if (outcome === 'expired') {
            clearInterval(timer)
            set({ ssoWait: { ...w, error: 'The login code expired. Start again.' }, loggingIn: false })
          }
        } catch {
          /* computer unreachable for the moment (reconnecting); the next tick asks again */
        }
      }
      let ticks = 0
      const timer = setInterval(() => {
        const st = get()
        if (!st.ssoWait) {
          clearInterval(timer)
          set({ loggingIn: false })
          return
        }
        if (accountsOk(true)) {
          finish()
          return
        }
        if (++ticks % 3 === 0 && !asking) {
          asking = true
          void askComputer().finally(() => { asking = false })
        }
      }, 1000)
    } catch (e) {
      set({ loggingIn: false })
      get().toast('error', (e as Error).message)
    }
  },

  scan: async (profiles, retryTargets) => {
    if (get().scanning) return
    set({ scanning: true, progress: {} })
    try {
      const r = await window.api.invoke('inventory:scan', profiles, retryTargets)
      set({ instances: r.instances, scanErrors: r.errors, scannedAt: r.scannedAt })
      if (r.errors.length) {
        get().toast('error', `${r.errors.length} account/region scan(s) failed. See sidebar.`)
        void get().checkAuth()
        void get().refreshSsoSessions()
      }
    } catch (e) {
      get().toast('error', (e as Error).message)
    } finally {
      set({ scanning: false })
    }
  },

  retryFailedScans: async () => {
    const targets = new Map<string, ScanTarget>()
    for (const e of get().scanErrors) {
      const target = targets.get(e.profile)
      if (e.allRegions) targets.set(e.profile, { profile: e.profile })
      else if (!target) targets.set(e.profile, { profile: e.profile, regions: [e.region] })
      else if (target.regions && !target.regions.includes(e.region)) target.regions.push(e.region)
    }
    if (targets.size) await get().scan(undefined, [...targets.values()])
  },

  saveManualHost: async (host, override) => {
    const hosts = (get().settings?.manualHosts ?? []).filter((h) => h.id !== host.id)
    hosts.push(host)
    hosts.sort((a, b) => a.name.localeCompare(b.name))
    const overrides = { ...(get().settings?.overrides ?? {}), [manualKey(host.id)]: override }
    await get().saveSettings({ manualHosts: hosts, overrides })
  },
  folders: () => {
    const st = get().settings
    const fromHosts = (st?.manualHosts ?? []).map((h) => h.group)
    return Array.from(new Set([...(st?.manualFolders ?? []), ...fromHosts])).filter(Boolean).sort((a, b) => a.localeCompare(b))
  },
  saveFolder: async (oldName, name, color) => {
    const st = get().settings!
    const trimmed = name.trim()
    if (!trimmed) throw new Error('Folder name is required')
    const others = get().folders().filter((f) => f !== oldName)
    if (others.some((f) => f.toLowerCase() === trimmed.toLowerCase())) throw new Error(`A folder named "${trimmed}" already exists`)
    const folders = Array.from(new Set([...others, trimmed]))
    const accountMeta = { ...st.accountMeta }
    if (oldName && oldName !== trimmed) delete accountMeta[`group:${oldName}`]
    accountMeta[`group:${trimmed}`] = { ...(oldName ? st.accountMeta[`group:${oldName}`] : {}), color }
    const manualHosts = oldName && oldName !== trimmed ? st.manualHosts.map((h) => (h.group === oldName ? { ...h, group: trimmed } : h)) : st.manualHosts
    const collapsedGroups = st.collapsedGroups.map((k) => (k === `group:${oldName}` ? `group:${trimmed}` : k))
    await get().saveSettings({ manualFolders: folders, accountMeta, manualHosts, collapsedGroups })
    if (oldName && get().profileFilter === `group:${oldName}`) set({ profileFilter: `group:${trimmed}` })
  },
  deleteFolder: async (name, moveTo) => {
    const st = get().settings!
    const doomed = st.manualHosts.filter((h) => h.group === name)
    const overrides = { ...st.overrides }
    let favorites = st.favorites
    let manualHosts: ManualHost[]
    if (moveTo === null) {
      for (const h of doomed) delete overrides[manualKey(h.id)]
      favorites = favorites.filter((k) => !doomed.some((h) => manualKey(h.id) === k))
      manualHosts = st.manualHosts.filter((h) => h.group !== name)
    } else {
      manualHosts = st.manualHosts.map((h) => (h.group === name ? { ...h, group: moveTo } : h))
    }
    const accountMeta = { ...st.accountMeta }
    delete accountMeta[`group:${name}`]
    await get().saveSettings({
      manualFolders: st.manualFolders.filter((f) => f !== name),
      manualHosts,
      overrides,
      favorites,
      accountMeta,
      collapsedGroups: st.collapsedGroups.filter((k) => k !== `group:${name}`)
    })
    if (get().profileFilter === `group:${name}`) set({ profileFilter: null })
  },
  deleteManualHost: async (id) => {
    const hosts = (get().settings?.manualHosts ?? []).filter((h) => h.id !== id)
    const overrides = { ...(get().settings?.overrides ?? {}) }
    delete overrides[manualKey(id)]
    const favorites = (get().settings?.favorites ?? []).filter((k) => k !== manualKey(id))
    await get().saveSettings({ manualHosts: hosts, overrides, favorites })
  },
  setTheme: async (theme) => {
    applyAppearance(theme, '')
    // The terminal follows the main theme: picking one puts the terminal scheme back on "Match app".
    await get().saveSettings({ theme, colorTheme: '', terminalTheme: 'auto' })
    await window.api.invoke('theme:set', theme)
  },
  setSectionZoom: async (section, zoom) => {
    const cur = get().settings
    const sectionZoom = { ...(cur?.sectionZoom ?? {}), [section]: Math.round(zoom * 100) / 100 }
    // Kept in the store at once, not after the save: holding ⌘+ sends steps faster than a save round trip, and each
    // step must start from the last one.
    if (cur) set({ settings: { ...cur, sectionZoom } })
    applySectionZoom(sectionZoom)
    await get().saveSettings({ sectionZoom })
  },
  setUiFont: async (id) => {
    applyUiFont(id)
    await get().saveSettings({ uiFont: id })
  },
  setColorTheme: async (id) => {
    const theme = get().settings?.theme ?? 'system'
    const shade = applyAppearance(theme, id)
    await get().saveSettings({ colorTheme: id, terminalTheme: 'auto' })
    // Native controls, scrollbars and the window background follow the theme's light or dark.
    await window.api.invoke('theme:set', id ? shade : theme)
  },

  toggleGroup: async (key) => {
    const cur = get().settings?.collapsedGroups ?? []
    await get().saveSettings({ collapsedGroups: cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key] })
  },
  setAllGroups: async (keys, collapsed) => {
    await get().saveSettings({ collapsedGroups: collapsed ? keys : [] })
  },

  isFavorite: (key) => (get().settings?.favorites ?? []).includes(key),
  toggleFavorite: async (key) => {
    const cur = get().settings?.favorites ?? []
    const next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]
    await get().saveSettings({ favorites: next })
  },

  saveSettings: async (patch) => {
    const settings = await window.api.invoke('settings:set', patch)
    set({ settings })
  },

  toast: (kind, text) => {
    const id = ++toastSeq
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }))
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 9000 : 4000)
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  addTab: (tab, opts) => {
    set((s) => ({ tabs: [...s.tabs, tab], activeTab: tab.id }))
    if (opts?.beside) get().splitWith(opts.beside.tab, tab.id, opts.beside.side)
  },
  updateTab: (id, patch) => set((s) => {
    const tab = s.tabs.find((t) => t.id === id)
    if (tab && patch.status && patch.status !== tab.status) patch = { ...patch, connectedAt: patch.status === 'connected' ? Date.now() : undefined }
    const recentHosts = tab && patch.status === 'connected'
      ? [tab.instanceKey, ...s.recentHosts.filter((key) => key !== tab.instanceKey)].slice(0, 20) : s.recentHosts
    if (recentHosts !== s.recentHosts) {
      try { localStorage.setItem('ui.recentHosts', JSON.stringify(recentHosts)) } catch { /* storage unavailable */ }
    }
    return { tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)), recentHosts }
  }),
  closeTab: async (id, opts) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (tab?.kind === 'rdp') await window.api.invoke('rdp:release', id).catch(() => undefined)
    else if (tab?.kind === 'sftp') await window.api.invoke('sftp:close', id).catch(() => undefined)
    else if (tab?.kind === 'notes' || tab?.kind === 'browser' || tab?.kind === 'board' || tab?.kind === 'finder' || tab?.kind === 'storage' || (tab && (PLAIN_TOOLS.includes(tab.kind as ToolKind) || isWebApp(tab.kind)))) { /* nothing in main to close: they save as they go */ }
    else await window.api.invoke('ssh:close', id, { endShell: !opts?.detach }).catch(() => undefined)
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id)
      const tabs = s.tabs.filter((t) => t.id !== id)
      const tree = s.splitTree ? removePane(s.splitTree, id) : null
      const left = tree ? paneIds(tree) : []
      const inSplit = s.splitGroup.includes(id)
      // Focus stays inside a split when a pane closes; otherwise the neighbour to the left takes over.
      const next = inSplit && left.length ? left[Math.max(0, s.splitGroup.indexOf(id) - 1)] : (tabs[Math.max(0, idx - 1)]?.id ?? 'hosts')
      const activeTab = s.activeTab === id ? next : s.activeTab
      // The host grid ends with the last of its host's terminals.
      const hostGrid = !!s.gridHost && tabs.some((t) => t.instanceKey === s.gridHost && t.kind === 'ssh')
      return { tabs, activeTab, gridView: s.gridView && tabs.some(isSession) && (!s.gridHost || hostGrid), gridHost: hostGrid ? s.gridHost : null, ...splitFields(tree, s) }
    })
  },
  toggleTerminalPane: (open) => {
    const next = open ?? !get().terminalPaneOpen
    set({ terminalPaneOpen: next })
    try { localStorage.setItem(TERMINAL_PANE_KEY, next ? '1' : '0') } catch { /* storage unavailable */ }
  },
  // Picking a tab or Hosts shows it on its own; tiles in the grid take focus through set({ activeTab }).
  // Leaving a host grid closes its transient tabs, except the one picked, which becomes a normal tab.
  setActive: (id) => set((s) => ({
    activeTab: id, gridView: false, gridHost: null, splitZoom: s.splitZoom === id ? id : null,
    lastTab: id === 'hosts' && s.activeTab !== 'hosts' && !s.gridView ? s.activeTab : s.lastTab,
    tabs: s.tabs.some((t) => t.transient) ? s.tabs.filter((t) => !t.transient || t.id === id).map((t) => (t.id === id && t.transient ? { ...t, transient: false } : t)) : s.tabs
  }))
}))


/** Remote sessions, as opposed to the built-in tools; used for host/session counts and grids. */
export function isSession(t: Tab): boolean {
  return t.kind === 'ssh' || t.kind === 'rdp' || t.kind === 'sftp'
}

/** The split fields for a layout tree: a tree of one pane (or none) is no split. */
function splitFields(tree: PaneNode | null, s: Pick<State, 'broadcastInput' | 'splitZoom'>): Pick<State, 'splitTree' | 'splitGroup' | 'broadcastInput' | 'splitZoom'> {
  const ids = tree ? paneIds(tree) : []
  const on = ids.length > 1
  return { splitTree: on ? tree : null, splitGroup: on ? ids : [], broadcastInput: on && s.broadcastInput, splitZoom: on && s.splitZoom && ids.includes(s.splitZoom) ? s.splitZoom : null }
}

/** A tab that attaches one of a host's persistent shells on another tab's connection, replaying its scrollback. */
function shellTab(from: Tab, shell: HostShell, transient: boolean): Tab {
  const id = `ssh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id, kind: 'ssh', instanceKey: from.instanceKey, title: from.title, status: 'connecting', shellLabel: shell.label || undefined, shellName: shell.name, transient,
    request: { ...from.request!, sessionId: id, reuseSessionId: from.status === 'connected' ? from.id : undefined, shellName: shell.name, shellHistory: true, shellLabel: undefined }
  }
}

/** Reopens one saved workspace tab through the same openers the hosts table uses. */
async function openWorkspaceTab(t: WorkspaceTab, workspaceSource: string): Promise<string | null> {
  const s = useStore.getState()
  const i = allInstances(s).find((x) => x.key === t.instanceKey)
  if (!i) return null
  const id = `${t.kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const title = `${i.name} @ ${i.profile}`
  const params = { user: t.user, port: t.port, identityFile: t.identityFile, useAgent: t.useAgent, forceRoute: t.forceRoute }
  const base = { id, instanceKey: i.key, title, status: 'connecting' as const, workspaceSource }
  if (t.kind === 'ssh') s.addTab({ ...base, kind: 'ssh', request: { instanceKey: i.key, sessionId: id, ...params, initCommand: t.initCommand } })
  else if (t.kind === 'sftp') s.addTab({ ...base, kind: 'sftp', sftpRequest: { instanceKey: i.key, ...params } })
  else {
    const cred = await window.api.invoke('creds:get', i.key).catch(() => null)
    if (!cred) return null
    s.addTab({ ...base, kind: 'rdp', rdpRequest: { user: t.user ?? cred.user, password: cred.password, domain: cred.domain, port: t.port, forceRoute: t.forceRoute } })
  }
  return id
}

/** What a workspace remembers about an open tab. */
export function workspaceTabOf(t: Tab): WorkspaceTab {
  const r = t.kind === 'ssh' ? t.request : t.kind === 'sftp' ? t.sftpRequest : undefined
  if (t.kind === 'rdp') return { kind: 'rdp', instanceKey: t.instanceKey, user: t.rdpRequest?.user, port: t.rdpRequest?.port, forceRoute: t.rdpRequest?.forceRoute }
  return { kind: t.kind === 'sftp' ? 'sftp' : 'ssh', instanceKey: t.instanceKey, user: r?.user, port: r?.port, identityFile: r?.identityFile, useAgent: r?.useAgent, forceRoute: r?.forceRoute, initCommand: t.kind === 'ssh' ? t.request?.initCommand : undefined }
}

function readRecentHosts(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem('ui.recentHosts') ?? '[]')
    return Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string').slice(0, 20) : []
  } catch { return [] }
}

function readSidebarPref(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === '1'
  } catch {
    return false
  }
}

/** The title bar's brand segment shares the sidebar width through this attribute (see styles.css). */
export function applySidebar(collapsed: boolean): void {
  document.documentElement.setAttribute('data-sidebar', collapsed ? 'collapsed' : 'expanded')
}
applySidebar(readSidebarPref())

export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
}

/**
 * Applies Auto / Light / Dark and the colour theme together: a colour theme brings its own tokens and fixes light or
 * dark (so isDarkMode() and the stylesheet's dark rules agree with it). Returns the appearance it settled on.
 */
export function applyAppearance(theme: Theme, colorTheme: string | undefined): Theme {
  const t = applyColorTheme(colorTheme)
  const shade: Theme = t ? (t.dark ? 'dark' : 'light') : theme
  applyTheme(shade)
  return shade
}

export function isDarkMode(): boolean {
  const t = document.documentElement.getAttribute('data-theme')
  if (t === 'dark') return true
  if (t === 'light') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** AWS inventory plus hand-added servers, the list every view renders. */
export function allInstances(s: { instances: Instance[]; settings?: Settings }): Instance[] {
  const manual = (s.settings?.manualHosts ?? []).map(manualToInstance)
  return manual.length ? [...s.instances, ...manual] : s.instances
}

/** Instances shown in the table: everything except AWS accounts whose checkbox is off. Manual servers always show. */
export function visibleInstances(s: { instances: Instance[]; settings?: Settings; profiles: AwsProfile[] }): Instance[] {
  const disabled = new Set(s.profiles.filter((p) => !p.enabled).map((p) => p.name))
  if (!disabled.size) return allInstances(s)
  return allInstances(s).filter((i) => i.manual || !disabled.has(i.profile))
}

/** The hosts the current filter bar selects (search, account, OS, state, reachability, favorites), unsorted. */
export function filteredInstances(s: Pick<State, 'instances' | 'settings' | 'profiles' | 'search' | 'favoritesOnly' | 'profileFilter' | 'osFilter' | 'stateFilter' | 'reachFilter'>): Instance[] {
  const q = s.search.trim().toLowerCase()
  const favs = new Set(s.settings?.favorites ?? [])
  return visibleInstances(s)
    .filter((i) => (s.favoritesOnly ? favs.has(i.key) : true))
    .filter((i) => {
      if (!s.profileFilter) return true
      if (s.profileFilter.startsWith('group:')) return !!i.manual && i.region === s.profileFilter.slice(6)
      return i.profile === s.profileFilter
    })
    .filter((i) => (s.osFilter === 'all' ? true : i.platform === s.osFilter))
    .filter((i) => (s.stateFilter === 'all' ? true : i.state === 'running'))
    .filter((i) => {
      if (s.reachFilter === 'all') return true
      const r = routeOf(i, s.settings).route
      return s.reachFilter === 'reachable' ? r === 'direct' || r === 'ssm' : r === 'unreachable'
    })
    .filter((i) => !q || matchesHost(i, q))
}

export function routeOf(i: Instance, settings?: Settings): { route: Route; reason: string } {
  if (i.manual) return { route: 'direct', reason: 'Manually added server' }
  const force = settings?.overrides[i.key]?.forceRoute
  if (i.state !== 'running') return { route: 'not-running', reason: i.state }
  if (force === 'ssm') return i.ssmOnline ? { route: 'ssm', reason: 'SSM (forced)' } : { route: 'unreachable', reason: 'SSM forced, agent offline' }
  if (force === 'direct') return i.publicIp || i.privateIp ? { route: 'direct', reason: 'Direct (forced)' } : { route: 'unreachable', reason: 'No IP' }
  if (settings?.preferDirect && i.publicIp) return { route: 'direct', reason: 'Public IP' }
  if (i.ssmOnline) return { route: 'ssm', reason: 'SSM Session Manager' }
  if (i.publicIp) return { route: 'direct', reason: 'Public IP (no SSM)' }
  if (i.ssmError) return { route: 'unreachable', reason: `SSM status unknown: ${i.ssmError}. Open connection options to try a private IP over VPN.` }
  return { route: 'unreachable', reason: i.ssmPingStatus ? `SSM ${i.ssmPingStatus}` : 'Private, no SSM' }
}

if (import.meta.env.DEV) (window as unknown as { __store: typeof useStore }).__store = useStore

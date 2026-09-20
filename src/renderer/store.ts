import { create } from 'zustand'
import type { AwsProfile, Instance, ProfileStatus, ScanProgress, ScanResult, ScanTarget, Settings, Tunnel, Route, SshOpenRequest, SftpOpenRequest, ManualHost, HostOverride, Theme, AccentColor, SsoSessionInfo, SsoDeviceFlow } from '@shared/types'
import { manualToInstance, manualKey } from '@shared/manual'
import { clearHostFilters } from '@shared/hostSearch'

export interface RdpTabRequest {
  user: string
  password: string
  domain?: string
  port?: number
  forceRoute?: 'direct' | 'ssm'
}

export interface Tab {
  id: string
  kind: 'ssh' | 'rdp' | 'sftp'
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
}

export interface Toast {
  id: number
  kind: 'info' | 'error' | 'success'
  text: string
}

export type OsFilter = 'all' | 'linux' | 'windows'
export type StateFilter = 'running' | 'all'
export type ReachFilter = 'all' | 'reachable' | 'unreachable'

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
  recentHosts: string[]
  clearFilters: () => void
  revealHost: (key: string) => void
  connectFor: { kind: 'ssh' | 'rdp' | 'sftp'; key: string } | null
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
  setTheme: (theme: Theme) => Promise<void>
  toggleGroup: (key: string) => Promise<void>
  setAllGroups: (keys: string[], collapsed: boolean) => Promise<void>
  isFavorite: (key: string) => boolean
  toggleFavorite: (key: string) => Promise<void>
  toast: (kind: Toast['kind'], text: string) => void
  dismissToast: (id: number) => void
  addTab: (tab: Tab) => void
  updateTab: (id: string, patch: Partial<Tab>) => void
  closeTab: (id: string) => Promise<void>
  setActive: (id: string) => void
  set: (patch: Partial<State>) => void
  toggleSidebar: (collapsed?: boolean) => void
}

let toastSeq = 0

export const useStore = create<State>((set, get) => ({
  profiles: [],
  statuses: {},
  sidebarCollapsed: readSidebarPref(),
  instances: [],
  scanErrors: [],
  scanning: false,
  loggingIn: false,
  progress: {},
  tunnels: [],
  tabs: [],
  activeTab: 'hosts',
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
  recentHosts: readRecentHosts(),
  clearFilters: () => set({ ...clearHostFilters }),
  revealHost: (key) => {
    const st = get()
    const inst = allInstances(st).find((i) => i.key === key)
    if (!inst) return
    const group = inst.manual ? `group:${inst.region}` : inst.profile
    const collapsedGroups = st.settings?.collapsedGroups.filter((g) => !['fav', group, `os:${inst.platform}`].includes(g)) ?? []
    set({ ...clearHostFilters, activeTab: 'hosts', selectedKey: key, detailsFor: key,
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
    applyTheme(settings.theme)
    if (cached) set({ instances: cached.instances, scanErrors: cached.errors, scannedAt: cached.scannedAt })
    window.api.on('scan:progress', (p) => set((s) => ({ progress: { ...s.progress, [`${p.profile}/${p.region}`]: p } })))
    window.api.on('tunnels:changed', (tunnels) => set({ tunnels }))
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
      const flow = await window.api.invoke('sso:loginSession', sso.ssoSession)
      set({ ssoWait: { flow, session: sso.ssoSession } })
      // completion arrives via profiles:status pushes (see init); watch for all-ok
      const started = Date.now()
      const timer = setInterval(() => {
        const st = get()
        if (!st.ssoWait) {
          clearInterval(timer)
          set({ loggingIn: false })
          return
        }
        const enabled = st.profiles.filter((p) => p.enabled && p.ssoSession === sso.ssoSession)
        const allOk = enabled.length > 0 && enabled.every((p) => st.statuses[p.name]?.state === 'ok' && (st.statuses[p.name]?.checkedAt ?? 0) > started)
        if (allOk) {
          clearInterval(timer)
          set({ ssoWait: null, loggingIn: false, authBannerDismissedFor: null })
          get().toast('success', 'Signed in. Refreshing inventory…')
          void get().refreshSsoSessions()
          void get().scan()
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
    applyTheme(theme)
    await get().saveSettings({ theme })
    await window.api.invoke('theme:set', theme)
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

  addTab: (tab) => set((s) => ({ tabs: [...s.tabs, tab], activeTab: tab.id })),
  updateTab: (id, patch) => set((s) => {
    const tab = s.tabs.find((t) => t.id === id)
    const recentHosts = tab && patch.status === 'connected'
      ? [tab.instanceKey, ...s.recentHosts.filter((key) => key !== tab.instanceKey)].slice(0, 20) : s.recentHosts
    if (recentHosts !== s.recentHosts) {
      try { localStorage.setItem('ui.recentHosts', JSON.stringify(recentHosts)) } catch { /* storage unavailable */ }
    }
    return { tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)), recentHosts }
  }),
  closeTab: async (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (tab?.kind === 'rdp') await window.api.invoke('rdp:release', id).catch(() => undefined)
    else if (tab?.kind === 'sftp') await window.api.invoke('sftp:close', id).catch(() => undefined)
    else await window.api.invoke('ssh:close', id).catch(() => undefined)
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id)
      const activeTab = s.activeTab === id ? (tabs.at(-1)?.id ?? 'hosts') : s.activeTab
      return { tabs, activeTab }
    })
  },
  setActive: (id) => set({ activeTab: id })
}))

const SIDEBAR_KEY = 'ui.sidebarCollapsed'

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

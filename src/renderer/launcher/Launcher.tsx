import { workspaceSummary } from '@shared/workspaces'
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppCommand, AwsProfile, BrowserState, Instance, NoteHit, Settings } from '@shared/types'
import type { RecentFile } from '@shared/finder'
import { displayPath, formatDate, formatSize, parentOf } from '@shared/finder'
import { calculate, convert, formatNumber, issueKey, jiraSite, matchScore, recentIds, usageBoost, type LauncherApp, type LauncherPreview, type LauncherUsage, type SystemAction } from '@shared/launcher'
import { comboOf, formatCombo, RAIL_SECTIONS, SECTION_NAMES, sectionKeys, type RailSection } from '@shared/keyCombos'
import { manualToInstance } from '@shared/manual'
import { matchesHost } from '@shared/hostSearch'
import { consoleHome, ec2InstanceUrl, hostOf, normalizeInput, spaceIdForProfile } from '@shared/browser'
import { DEFAULT_SPACE, EXTERNAL, checkQuicklink, cleanQuicklink, quicklinkFor, quicklinkUrl, takesQuery, type Quicklink } from '@shared/quicklinks'
import { applyAppearance } from '../store'
import { applyUiFont } from '../uiFont'
import { Icon } from '../components/icons'
import { Favicon } from '../components/browser/parts'

/**
 * The launcher: Raycast's search bar for this Mac and this app, in its own floating window (main/launcherWindow.ts)
 * opened by a key that works in every app, or the rail's Launcher button. One field searches the apps on the Mac,
 * files anywhere on it (Spotlight), your hosts, notes and browser favorites and history, the app's sections and
 * commands and AWS consoles, the web, and does arithmetic. The list is on the left and the chosen result's details
 * (a file's thumbnail, size and dates, a host's addresses) on the right. ↵ runs a result's first action, ⌘↵ its
 * second, ⌘Y is Quick Look, ⌘K lists every action. The app's window carries out anything inside the app
 * (launcher:command → app:command).
 */

interface Action {
  title: string
  /** A combination as keyCombos.ts writes them: 'enter' for the first action, 'cmd+enter' for the second. */
  key?: string
  run: () => void
}

/** What the side pane shows for a result. */
type Detail =
  | { kind: 'path'; path: string }
  | { kind: 'host'; host: Instance }
  | { kind: 'note'; path: string; text: string }
  | { kind: 'web'; url: string; space: string; favicon?: string }
  | { kind: 'calc'; value: number; expr: string; unit?: string }
  | { kind: 'quicklink'; link: Quicklink; url: string }

interface Row {
  id: string
  title: string
  subtitle?: string
  /** Words it is also found by. */
  keywords?: string
  icon: ReactNode
  /** A file or app whose icon (the app that opens it, for a file) replaces `icon` once it has loaded. */
  iconPath?: string
  accessory?: ReactNode
  detail?: Detail
  actions: Action[]
}

interface Group {
  title: string
  rows: Row[]
  /** How well its first row matches, which orders the groups between the calculator and web search. */
  best?: number
}

interface Data {
  apps: LauncherApp[]
  usage: LauncherUsage
  settings: Settings | null
  hosts: Instance[]
  profiles: AwsProfile[]
  browser: BrowserState | null
  home: string
}

const EMPTY: Data = { apps: [], usage: {}, settings: null, hosts: [], profiles: [], browser: null, home: '' }
const NO_LINKS: Quicklink[] = []

const SECTION_ICONS: Record<RailSection, (p: { className?: string }) => ReactElement> = {
  devtools: Icon.code, tasks: Icon.tasks, calendar: Icon.calendar, links: Icon.bookmark, hosts: Icon.server, overview: Icon.grid, health: Icon.health, local: Icon.console, finder: Icon.finder, storage: Icon.storage, browser: Icon.globe, notes: Icon.note, board: Icon.board, claude: Icon.claude, chatgpt: Icon.chatgpt
}
const SECTION_ABOUT: Record<RailSection, string> = {
  devtools: 'Local developer utilities', tasks: 'Today, upcoming and your projects', calendar: 'Month, week and day', links: 'Your bookmarks and notes', hosts: 'Every account’s hosts', overview: 'All open sessions on one page', health: 'The 3DEXPERIENCE platform at a glance', local: 'Shells on this Mac', finder: 'Files on this Mac', storage: 'Disk space and clean-up',
  browser: 'AWS console spaces and web tabs', notes: 'Your Markdown notes', board: 'The scratch pad', claude: 'Chat, signed in on its own', chatgpt: 'Chat, signed in on its own'
}
const SECTION_WORDS: Record<RailSection, string> = {
  devtools: 'json base64 url jwt uuid timestamp hash developer utilities', tasks: 'todo to-do things todoist reminders checklist projects', calendar: 'events schedule agenda meetings ical', links: 'bookmarks anybox saved pages urls', hosts: 'instances servers ec2 list', overview: 'all sessions grid', health: 'status monitoring 3dexperience prometheus grafana alerts', local: 'shell zsh console warp', finder: 'files folders', storage: 'disk space clean cleaner junk large files duplicates trash strata', browser: 'web tabs arc',
  notes: 'obsidian markdown', board: 'whiteboard draw sketch', claude: 'ai chat anthropic', chatgpt: 'ai chat openai gpt'
}

const hide = (): void => void window.api.invoke('launcher:hide')
const used = (id: string): void => void window.api.invoke('launcher:used', id).catch(() => undefined)
/** Has the app's window do `c` (it comes to the front), counting a use of `id`. */
const inApp = (id: string, c: AppCommand) => (): void => {
  used(id)
  void window.api.invoke('launcher:command', c)
}
const openPath = (id: string, path: string) => (): void => void window.api.invoke('launcher:open', path, id).catch(() => undefined)
const copy = (text: string) => (): void => {
  void window.api.invoke('clipboard:write', text)
  hide()
}
const external = (url: string) => (): void => {
  void window.api.invoke('shell:open', url)
  hide()
}
const reveal = (path: string) => (): void => {
  void window.api.invoke('local:reveal', path)
  hide()
}
const quickLook = (path: string) => (): void => void window.api.invoke('launcher:quickLook', path)
const system = (id: string, action: SystemAction) => (): void => {
  used(id)
  void window.api.invoke('launcher:system', action).catch(() => undefined)
}

/** The Mac commands, found by name only (never in the empty launcher). */
const MAC_COMMANDS: { action: SystemAction; title: string; subtitle: string; words: string; icon: ReactElement }[] = [
  { action: 'sleep', title: 'Sleep', subtitle: 'Put the Mac to sleep', words: 'sleep suspend', icon: <Icon.moon /> },
  { action: 'lock', title: 'Lock Screen', subtitle: 'Sleep the displays, which locks the Mac', words: 'lock screen displays away', icon: <Icon.lock /> },
  { action: 'darkMode', title: 'Toggle Dark Mode', subtitle: 'Switch macOS between light and dark', words: 'dark light appearance theme', icon: <Icon.auto /> },
  { action: 'mute', title: 'Mute or Unmute Sound', subtitle: 'The Mac’s output volume', words: 'mute unmute sound volume audio', icon: <Icon.mic /> },
  { action: 'emptyTrash', title: 'Empty Trash…', subtitle: 'Asks first', words: 'empty trash bin delete', icon: <Icon.x /> },
  { action: 'restart', title: 'Restart…', subtitle: 'Asks first', words: 'restart reboot', icon: <Icon.refresh /> },
  { action: 'shutdown', title: 'Shut Down…', subtitle: 'Asks first', words: 'shut down shutdown power off', icon: <Icon.alert /> }
]

const baseName = (p: string): string => p.replace(/\/+$/, '').split('/').pop() ?? p

/** The best of the title's and the keywords' match, plus how often and lately it was used. */
function rankRows(rows: Row[], q: string, usage: LauncherUsage, now: number): { rows: Row[]; best: number } {
  const scored = rows
    .map((r) => {
      // Keywords (IPs, tags, addresses) count where a word starts or the text appears, never as scattered letters.
      const k = r.keywords ? matchScore(q, r.keywords) : 0
      const m = Math.max(matchScore(q, r.title), k >= 45 ? k * 0.6 : 0)
      return { r, s: m ? m + usageBoost(usage[r.id], now) : 0 }
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
  return { rows: scored.map((x) => x.r), best: scored[0]?.s ?? 0 }
}

/** Files: how well the name matches, then how lately you opened it. */
function fileScore(f: RecentFile, q: string, now: number): number {
  const age = now - f.lastUsed
  const day = 86_400_000
  return matchScore(q, f.name) + (!f.lastUsed ? 0 : age < 7 * day ? 25 : age < 30 * day ? 15 : age < 365 * day ? 8 : 0)
}

export default function Launcher(): ReactElement {
  const [data, setData] = useState<Data>(EMPTY)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const [panel, setPanel] = useState<number | null>(null)
  const [files, setFiles] = useState<RecentFile[]>([])
  const [notes, setNotes] = useState<NoteHit[]>([])
  const [icons, setIcons] = useState<Record<string, string>>({})
  const [previews, setPreviews] = useState<Record<string, LauncherPreview | null>>({})
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const searchSeq = useRef(0)
  /** The Create/Edit Quicklink form, over the list; `id` is '' for a new one. */
  const [form, setForm] = useState<Quicklink | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const load = async (): Promise<void> => {
    const soft = <T,>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback)
    const [apps, usage, settings, cached, profiles, browser, home] = await Promise.all([
      soft(window.api.invoke('launcher:apps'), [] as LauncherApp[]),
      soft(window.api.invoke('launcher:usage'), {} as LauncherUsage),
      soft(window.api.invoke('settings:get'), null),
      soft(window.api.invoke('inventory:cached'), null),
      soft(window.api.invoke('profiles:list'), [] as AwsProfile[]),
      soft(window.api.invoke('browser:load'), null),
      soft(window.api.invoke('local:home'), '')
    ])
    if (settings) {
      applyUiFont(settings.uiFont)
      applyAppearance(settings.theme, settings.colorTheme)
    }
    const off = new Set(profiles.filter((p) => !p.enabled).map((p) => p.name))
    const hosts = [...(cached?.instances ?? []).filter((i) => !off.has(i.profile)), ...(settings?.manualHosts ?? []).map(manualToInstance)]
    setData({ apps, usage, settings, hosts, profiles, browser, home })
  }

  useEffect(() => {
    void load()
    // Each time it appears: an empty field with the keyboard, and fresh lists (apps installed, hosts scanned since).
    return window.api.on('launcher:shown', () => {
      setQ('')
      setSel(0)
      setPanel(null)
      setFiles([])
      setNotes([])
      setPreviews({})
      setForm(null)
      setTimeout(() => input.current?.focus(), 0)
      void load()
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ----- rows -----
  const settings = data.settings
  const accountLabel = (i: Instance): string => (i.manual ? (i.profile === 'servers' ? 'Server' : i.profile) : settings?.accountMeta?.[i.profile]?.label ?? i.profile)
  const spaceName = (id: string): string => {
    const own = data.browser?.spaces.find((s) => s.id === id)
    if (own) return own.name
    const p = data.profiles.find((x) => spaceIdForProfile(x.name) === id)
    return p ? (settings?.accountMeta?.[p.name]?.label ?? p.name) : 'Browser'
  }

  const appRow = (a: LauncherApp): Row => {
    const id = `app:${a.path}`
    return {
      id, title: a.name, subtitle: displayPath(parentOf(a.path), data.home), icon: <Icon.openTab />, iconPath: a.path, accessory: 'Application', detail: { kind: 'path', path: a.path },
      actions: [
        { title: 'Open', key: 'enter', run: openPath(id, a.path) },
        { title: 'Show in Finder', key: 'cmd+enter', run: reveal(a.path) },
        { title: 'Quick Look', key: 'cmd+y', run: quickLook(a.path) },
        { title: 'Copy Path', key: 'shift+cmd+c', run: copy(a.path) }
      ]
    }
  }

  const fileRow = (f: Pick<RecentFile, 'name' | 'path' | 'type'>): Row => {
    const id = `file:${f.path}`
    const dir = f.type === 'dir' ? f.path : parentOf(f.path)
    return {
      id, title: f.name, subtitle: displayPath(parentOf(f.path), data.home), icon: f.type === 'dir' ? <Icon.folder /> : <Icon.note />, iconPath: f.path, detail: { kind: 'path', path: f.path },
      actions: [
        { title: 'Open', key: 'enter', run: openPath(id, f.path) },
        { title: 'Show in Finder', key: 'cmd+enter', run: reveal(f.path) },
        { title: 'Quick Look', key: 'cmd+y', run: quickLook(f.path) },
        { title: 'Copy Path', key: 'shift+cmd+c', run: copy(f.path) },
        { title: 'Open in the Finder Tab', key: 'shift+cmd+f', run: inApp(id, { kind: 'finder', path: dir }) },
        { title: 'Open a Terminal Here', key: 'shift+cmd+t', run: inApp(id, { kind: 'terminal', cwd: dir }) }
      ]
    }
  }

  const hostRow = (i: Instance): Row => {
    const id = `host:${i.key}`
    const windows = i.platform === 'windows'
    const running = i.manual || i.state === 'running'
    const address = i.privateIp ?? i.publicIp ?? ''
    const actions: Action[] = [
      { title: windows ? 'Remote Desktop' : 'Connect with SSH', key: 'enter', run: inApp(id, { kind: 'connect', key: i.key }) },
      { title: 'Show in Hosts', key: 'cmd+enter', run: inApp(id, { kind: 'reveal', key: i.key }) }
    ]
    if (!windows && running) actions.push({ title: 'Browse Files (SFTP)', key: 'shift+cmd+f', run: inApp(id, { kind: 'files', key: i.key }) })
    if (!i.manual && running && i.ssmOnline) {
      actions.push({ title: 'Run a Command…', key: 'shift+cmd+r', run: inApp(id, { kind: 'run', key: i.key }) })
      actions.push({ title: 'Forward a Port…', key: 'shift+cmd+p', run: inApp(id, { kind: 'forward', key: i.key }) })
    }
    if (!i.manual) actions.push({ title: 'Open in the AWS Console', key: 'shift+cmd+o', run: inApp(id, { kind: 'console', profile: i.profile, url: ec2InstanceUrl(i.region, i.instanceId) }) })
    if (address) actions.push({ title: `Copy IP Address (${address})`, key: 'shift+cmd+c', run: copy(address) })
    if (!i.manual) actions.push({ title: 'Copy Instance ID', key: 'shift+cmd+i', run: copy(i.instanceId) })
    if (!i.manual && i.state === 'stopped') actions.push({ title: 'Start Instance…', run: inApp(id, { kind: 'power', key: i.key, action: 'start' }) })
    if (!i.manual && i.state === 'running') actions.push({ title: 'Stop Instance…', run: inApp(id, { kind: 'power', key: i.key, action: 'stop' }) })
    return {
      id, title: i.name, subtitle: [accountLabel(i), i.manual ? '' : i.region, address || i.instanceId].filter(Boolean).join(' · '),
      keywords: [i.instanceId, address, i.publicIp, i.profile, accountLabel(i), ...Object.values(i.tags ?? {})].filter(Boolean).join(' '),
      icon: windows ? <Icon.monitor /> : <Icon.terminal />, detail: { kind: 'host', host: i },
      accessory: running ? (settings?.favorites.includes(i.key) ? <Icon.star className="launcher-fav" /> : undefined) : <span className="launcher-state">{i.state}</span>,
      actions
    }
  }

  const noteRow = (path: string, text: string): Row => {
    const id = `note:${path}`
    return {
      id, title: baseName(path).replace(/\.md$/i, ''), subtitle: text || parentOf(path), icon: <Icon.note />, detail: { kind: 'note', path, text },
      actions: [{ title: 'Open in Notes', key: 'enter', run: inApp(id, { kind: 'note', path }) }]
    }
  }

  const webRow = (o: { id: string; title: string; url: string; space: string; tab?: string; favicon?: string; pinned?: boolean }): Row => ({
    id: o.id, title: o.title || hostOf(o.url), subtitle: `${spaceName(o.space)} · ${hostOf(o.url)}`, keywords: o.url,
    icon: <Favicon src={o.favicon} url={o.url} size={18} />, accessory: o.pinned ? <Icon.star className="launcher-pin" /> : undefined,
    detail: { kind: 'web', url: o.url, space: o.space, favicon: o.favicon },
    actions: [
      { title: `Open in ${spaceName(o.space)}`, key: 'enter', run: inApp(o.id, { kind: 'browse', url: o.url, space: o.space, tab: o.tab }) },
      { title: 'Open in Your Browser', key: 'cmd+enter', run: external(o.url) },
      { title: 'Copy Link', key: 'shift+cmd+c', run: copy(o.url) }
    ]
  })

  const links = settings?.quicklinks ?? NO_LINKS
  const editLink = (l: Quicklink | null): void => { setFormError(null); setForm(l ?? { id: '', name: '', keyword: '', url: '', space: DEFAULT_SPACE }) }
  /** Writes the list (main merges it into the settings); the main window reads it again where it shows quicklinks. */
  const saveLinks = async (next: Quicklink[]): Promise<void> => {
    const saved = await window.api.invoke('settings:set', { quicklinks: next })
    setData((d) => ({ ...d, settings: saved }))
  }
  const quicklinkRow = (l: Quicklink, rest = ''): Row => {
    const id = `quicklink:${l.id}`
    const url = quicklinkUrl(l, rest)
    const external_ = l.space === EXTERNAL
    const where = external_ ? 'Your Browser' : spaceName(l.space)
    return {
      id, title: rest ? `${l.name}: ${rest}` : l.name, subtitle: `Quicklink · ${takesQuery(l) && !rest ? `type “${l.keyword} …”` : hostOf(url)}`,
      keywords: `${l.keyword} quicklink ${l.url}`, icon: <Favicon url={url} size={18} />, accessory: l.keyword ? <kbd className="kbd">{l.keyword}</kbd> : undefined,
      detail: { kind: 'quicklink', link: l, url },
      actions: [
        { title: `Open in ${where}`, key: 'enter', run: external_ ? () => { used(id); external(url)() } : inApp(id, { kind: 'browse', url, space: l.space }) },
        external_
          ? { title: 'Open in the Browser Tab', key: 'cmd+enter', run: inApp(id, { kind: 'browse', url, space: DEFAULT_SPACE }) }
          : { title: 'Open in Your Browser', key: 'cmd+enter', run: external(url) },
        { title: 'Copy Link', key: 'shift+cmd+c', run: copy(url) },
        { title: 'Edit Quicklink…', key: 'cmd+e', run: () => editLink(l) },
        { title: 'Delete Quicklink', run: () => { void saveLinks(links.filter((x) => x.id !== l.id)) } }
      ]
    }
  }

  const keys = sectionKeys(settings?.shortcuts)
  const appRows: Row[] = useMemo(() => [
    ...RAIL_SECTIONS.map((sec): Row => {
      const SecIcon = SECTION_ICONS[sec]
      const id = `section:${sec}`
      return {
        id, title: SECTION_NAMES[sec], subtitle: SECTION_ABOUT[sec], keywords: SECTION_WORDS[sec], icon: <SecIcon />,
        accessory: keys[sec] ? <kbd className="kbd">{formatCombo(keys[sec])}</kbd> : undefined,
        actions: [{ title: `Open ${SECTION_NAMES[sec]}`, key: 'enter', run: inApp(id, { kind: 'section', section: sec }) }]
      }
    }),
    { id: 'cmd:today', title: 'Today’s Note', subtitle: 'Notes', keywords: 'daily journal obsidian', icon: <Icon.note />, actions: [{ title: 'Open Today’s Note', key: 'enter', run: inApp('cmd:today', { kind: 'today' }) }] },
    { id: 'cmd:scan', title: 'Rescan AWS Accounts', subtitle: 'Hosts', keywords: 'refresh inventory reload', icon: <Icon.refresh />, actions: [{ title: 'Rescan', key: 'enter', run: inApp('cmd:scan', { kind: 'scan' }) }] },
    { id: 'cmd:quicklink', title: 'Create Quicklink…', subtitle: 'A word that opens a page, such as “aws” for the AWS sign-in', keywords: 'quicklink bookmark link shortcut alias keyword url', icon: <Icon.plus />, actions: [{ title: 'Create Quicklink', key: 'enter', run: () => editLink(null) }] },
    ...(settings?.workspaces ?? []).map((w): Row => ({
      id: `workspace:${w.id}`, title: `Workspace: ${w.name}`, subtitle: workspaceSummary(w), keywords: 'workspace session layout tabs', icon: <Icon.grid />,
      actions: [{ title: 'Open the Workspace', key: 'enter', run: inApp(`workspace:${w.id}`, { kind: 'workspace', id: w.id }) }]
    })),
    ...(settings?.portForwards ?? []).map((p): Row => ({
      id: `forward:${p.id}`, title: `Forward: ${p.name}`, subtitle: `${p.remoteHost ? `${p.remoteHost}:` : 'port '}${p.remotePort}${p.localPort ? ` → localhost:${p.localPort}` : ''}`, keywords: 'tunnel port forward database', icon: <Icon.plug />,
      actions: [{ title: 'Open the Forward', key: 'enter', run: inApp(`forward:${p.id}`, { kind: 'portForward', id: p.id }) }]
    })),
    ...(settings?.snippets ?? []).map((sn): Row => ({
      id: `snippet:${sn.id}`, title: `Snippet: ${sn.name}`, subtitle: sn.command, keywords: `snippet command ${sn.command}`, icon: <Icon.snippet />,
      actions: [{ title: 'Copy the Command', key: 'enter', run: copy(sn.command) }]
    })),
    ...data.profiles.filter((p) => p.enabled && p.kind !== 'static').map((p): Row => {
      const id = `console:${p.name}`
      const label = settings?.accountMeta?.[p.name]?.label ?? p.name
      return {
        id, title: `AWS Console: ${label}`, subtitle: `${p.name} · ${p.region}`, keywords: `aws console ${p.name}`, icon: <Icon.cloud />,
        actions: [{ title: 'Open Signed In', key: 'enter', run: inApp(id, { kind: 'console', profile: p.name, url: consoleHome(p.region) }) }]
      }
    }),
    ...data.profiles.filter((p) => p.enabled).map((p): Row => {
      const id = `aws-terminal:${p.name}`
      return {
        id, title: `Terminal with AWS profile: ${settings?.accountMeta?.[p.name]?.label ?? p.name}`, subtitle: `AWS_PROFILE=${p.name}`, keywords: `terminal shell cli aws_profile ${p.name}`, icon: <Icon.console />,
        actions: [{ title: 'Open a Terminal Tab', key: 'enter', run: inApp(id, { kind: 'terminal', profile: p.name }) }]
      }
    })
  ], [data, keys.hosts, keys.overview, keys.health, keys.devtools, keys.tasks, keys.calendar, keys.links, keys.local, keys.finder, keys.browser, keys.notes, keys.board, keys.claude, keys.chatgpt]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Browser favorites and pinned tabs (each opens in its own space), then pages from history, newest of each address. */
  const webRows: Row[] = useMemo(() => {
    const b = data.browser
    if (!b) return []
    const kept = b.tabs.filter((t) => (t.favorite || t.pinned) && (t.url || t.homeUrl))
    const seen = new Set(kept.map((t) => `${t.spaceId} ${t.url || t.homeUrl}`))
    const history: Row[] = []
    for (let n = b.history.length - 1; n >= 0 && history.length < 400; n--) {
      const h = b.history[n]
      const k = `${h.spaceId} ${h.url}`
      if (seen.has(k) || !/^https?:/.test(h.url)) continue
      seen.add(k)
      history.push(webRow({ id: `web:${h.spaceId}:${h.url}`, title: h.title, url: h.url, space: h.spaceId }))
    }
    return [...kept.map((t) => webRow({ id: `web:tab:${t.id}`, title: t.name || t.title, url: t.url || t.homeUrl || '', space: t.spaceId, tab: t.id, favicon: t.favicon, pinned: true })), ...history]
  }, [data]) // eslint-disable-line react-hooks/exhaustive-deps

  const query = q.trim()
  const calc = useMemo(() => {
    const v = calculate(query)
    return v === null || formatNumber(v) === query ? null : v
  }, [query])
  const conversion = useMemo(() => convert(query), [query])
  /** Where your Jira lives, from the Browser's history and tabs, for a typed issue key. */
  const jira = useMemo(() => {
    const b = data.browser
    if (!b) return null
    return jiraSite([...b.history.map((h) => ({ url: h.url, space: h.spaceId, at: h.at })), ...b.tabs.map((t) => ({ url: t.url, space: t.spaceId, at: t.lastActive ?? 0 }))])
  }, [data.browser])

  // Files anywhere on the Mac (Spotlight) and notes, once two letters are typed and it is not a sum.
  useEffect(() => {
    const n = ++searchSeq.current
    if (query.length < 2 || calc !== null || conversion !== null) {
      setFiles([])
      setNotes([])
      return
    }
    const t = setTimeout(() => {
      window.api.invoke('launcher:files', query).then((found) => {
        if (n !== searchSeq.current) return
        const now = Date.now()
        setFiles(found.map((f) => ({ f, s: fileScore(f, query, now) })).sort((a, b) => b.s - a.s).map((x) => x.f).slice(0, 12))
      }).catch(() => undefined)
      window.api.invoke('notes:search', query).then((hits) => { if (n === searchSeq.current) setNotes(hits) }).catch(() => undefined)
    }, 120)
    return () => clearTimeout(t)
  }, [query, calc, conversion])

  const groups: Group[] = useMemo(() => {
    const now = Date.now()
    if (!query) {
      const byId = new Map<string, Row>()
      for (const a of data.apps) byId.set(`app:${a.path}`, appRow(a))
      for (const h of data.hosts) byId.set(`host:${h.key}`, hostRow(h))
      for (const r of [...appRows, ...webRows]) byId.set(r.id, r)
      const recent = recentIds(data.usage, now, 8)
        .map((id) => byId.get(id) ?? (id.startsWith('file:') ? fileRow({ name: baseName(id.slice(5)), path: id.slice(5), type: 'file' }) : id.startsWith('note:') ? noteRow(id.slice(5), '') : undefined))
        .filter((r): r is Row => !!r)
      const favorites = (settings?.favorites ?? []).map((k) => byId.get(`host:${k}`)).filter((r): r is Row => !!r && !recent.includes(r)).slice(0, 5)
      return [
        { title: 'Recent', rows: recent },
        { title: 'Quicklinks', rows: links.filter((l) => !recent.some((r) => r.id === `quicklink:${l.id}`)).slice(0, 6).map((l) => quicklinkRow(l)) },
        { title: 'Favorite Hosts', rows: favorites },
        { title: 'EC2 Remote Access', rows: appRows.slice(0, RAIL_SECTIONS.length + 2) }
      ].filter((g) => g.rows.length)
    }
    const out: Group[] = []
    // A quicklink's keyword comes first, so "aws" ↩ opens it.
    const keyword = quicklinkFor(query, links)
    if (keyword) out.push({ title: 'Quicklink', rows: [quicklinkRow(keyword.link, keyword.rest)] })
    if (calc !== null) {
      out.push({ title: 'Calculator', rows: [{
        id: 'calc', title: formatNumber(calc), subtitle: query, icon: <span className="launcher-calc">=</span>, detail: { kind: 'calc', value: calc, expr: query },
        actions: [{ title: 'Copy Answer', key: 'enter', run: copy(String(calc)) }, { title: 'Copy Sum and Answer', key: 'cmd+enter', run: copy(`${query} = ${String(calc)}`) }]
      }] })
    }
    if (conversion) {
      const answer = `${formatNumber(conversion.value)} ${conversion.unit}`
      out.push({ title: 'Convert', rows: [{
        id: 'convert', title: answer, subtitle: `${conversion.from} =`, icon: <span className="launcher-calc">⇄</span>, detail: { kind: 'calc', value: conversion.value, expr: conversion.from, unit: conversion.unit },
        actions: [{ title: 'Copy Answer', key: 'enter', run: copy(String(conversion.value)) }, { title: 'Copy With the Unit', key: 'cmd+enter', run: copy(answer) }]
      }] })
    }
    const key = issueKey(query)
    if (key && jira) {
      const url = `${jira.base}/browse/${key}`
      out.push({ title: 'Jira', rows: [webRow({ id: `jira:${key}`, title: `Open ${key}`, url, space: jira.space })] })
    }
    const middle: Group[] = []
    const apps = rankRows(data.apps.map(appRow), query, data.usage, now)
    middle.push({ title: 'Applications', rows: apps.rows.slice(0, 6), best: apps.best })
    const named = rankRows(data.hosts.map(hostRow), query, data.usage, now)
    // Every word of the query in a host's name, IPs, account, region or tags finds it too.
    const more = named.rows.length < 6 ? data.hosts.filter((h) => matchesHost(h, query) && !named.rows.some((r) => r.id === `host:${h.key}`)).map(hostRow) : []
    middle.push({ title: 'Hosts', rows: [...named.rows, ...more].slice(0, 6), best: Math.max(named.best, more.length ? 40 : 0) })
    middle.push({ title: 'Files', rows: files.map(fileRow), best: files.length ? fileScore(files[0], query, now) : 0 })
    const byNote = new Map<string, NoteHit>()
    for (const h of notes) if (!byNote.has(h.path) || h.line === 0) byNote.set(h.path, h)
    const noteRows = [...byNote.values()].slice(0, 5).map((h) => noteRow(h.path, h.line === 0 ? '' : h.text.trim()))
    middle.push({ title: 'Notes', rows: noteRows, best: noteRows.length ? Math.max(30, matchScore(query, noteRows[0].title)) : 0 })
    const ql = rankRows(links.filter((l) => l.id !== keyword?.link.id).map((l) => quicklinkRow(l)), query, data.usage, now)
    middle.push({ title: 'Quicklinks', rows: ql.rows.slice(0, 4), best: ql.best })
    const web = rankRows(webRows, query, data.usage, now)
    middle.push({ title: 'Browser', rows: web.rows.slice(0, 5), best: web.best })
    const inside = rankRows(appRows, query, data.usage, now)
    middle.push({ title: 'EC2 Remote Access', rows: inside.rows.slice(0, 6), best: inside.best })
    const mac = rankRows(MAC_COMMANDS.map((c): Row => ({
      id: `mac:${c.action}`, title: c.title, subtitle: c.subtitle, keywords: c.words, icon: c.icon,
      actions: [{ title: c.title.replace(/…$/, ''), key: 'enter', run: system(`mac:${c.action}`, c.action) }]
    })), query, data.usage, now)
    middle.push({ title: 'Mac', rows: mac.rows.slice(0, 4), best: mac.best })
    // Groups in the order of their best match (a stable sort keeps this order on ties).
    out.push(...middle.filter((g) => g.rows.length).sort((a, b) => (b.best ?? 0) - (a.best ?? 0)))
    const url = normalizeInput(query)
    const search: Row[] = []
    if (!url.startsWith('https://www.google.com/search')) {
      search.push({ id: 'web:open', title: `Open ${url}`, icon: <Icon.globe />, actions: [
        { title: 'Open in Your Browser', key: 'enter', run: external(url) }, { title: 'Open in the Browser Tab', key: 'cmd+enter', run: inApp('web:open', { kind: 'browse', url }) },
        { title: 'Create Quicklink…', key: 'cmd+e', run: () => { setFormError(null); setForm({ id: '', name: hostOf(url), keyword: '', url, space: DEFAULT_SPACE }) } }
      ] })
    }
    const google = `https://www.google.com/search?q=${encodeURIComponent(query)}`
    search.push(
      { id: 'web:google', title: `Search Google for “${query}”`, icon: <Icon.search />, actions: [{ title: 'Search in Your Browser', key: 'enter', run: external(google) }, { title: 'Search in the Browser Tab', key: 'cmd+enter', run: inApp('web:google', { kind: 'browse', url: google }) }] },
      { id: 'ask:claude', title: `Ask Claude: “${query}”`, icon: <Icon.claude />, actions: [{ title: 'Ask in the Claude Tab', key: 'enter', run: inApp('ask:claude', { kind: 'ask', app: 'claude', text: query }) }] },
      { id: 'ask:chatgpt', title: `Ask ChatGPT: “${query}”`, icon: <Icon.chatgpt />, actions: [{ title: 'Ask in the ChatGPT Tab', key: 'enter', run: inApp('ask:chatgpt', { kind: 'ask', app: 'chatgpt', text: query }) }] }
    )
    out.push({ title: 'Search', rows: search })
    return out
  }, [query, data, files, notes, calc, conversion, jira, appRows, webRows, links]) // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => groups.flatMap((g) => g.rows), [groups])
  const current = rows[Math.min(sel, rows.length - 1)]
  useEffect(() => setSel(0), [query])

  // The icons for the apps and files on screen (an app's own; for a file, the app that opens it).
  useEffect(() => {
    const need = [...new Set(rows.map((r) => r.iconPath).filter((p): p is string => !!p && icons[p] === undefined))]
    if (!need.length) return
    void window.api.invoke('launcher:icons', need).then((found) => {
      setIcons((cur) => ({ ...cur, ...Object.fromEntries(need.map((p) => [p, found[p] ?? ''])) }))
    }).catch(() => undefined)
  }, [rows]) // eslint-disable-line react-hooks/exhaustive-deps

  // The side pane's thumbnail and details for the chosen file or app, a moment after the selection settles.
  const previewPath = current?.detail?.kind === 'path' ? current.detail.path : ''
  useEffect(() => {
    if (!previewPath || previews[previewPath] !== undefined) return
    const t = setTimeout(() => {
      window.api.invoke('launcher:preview', previewPath)
        .then((p) => setPreviews((cur) => ({ ...cur, [previewPath]: p })), () => setPreviews((cur) => ({ ...cur, [previewPath]: null })))
    }, 70)
    return () => clearTimeout(t)
  }, [previewPath]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    list.current?.querySelector('.launcher-item.on')?.scrollIntoView({ block: 'nearest' })
  }, [sel, rows])

  const run = (a: Action | undefined): void => {
    if (!a) return
    setPanel(null)
    a.run()
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    const ev = e.nativeEvent
    const actions = current?.actions ?? []
    const move = (step: number, length: number, set: (fn: (n: number) => number) => void): void => {
      e.preventDefault()
      if (length) set((n) => (n + step + length) % length)
    }
    const down = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')
    const up = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')
    if (panel !== null) {
      if (down) return move(1, actions.length, (fn) => setPanel((n) => fn(n ?? 0)))
      if (up) return move(-1, actions.length, (fn) => setPanel((n) => fn(n ?? 0)))
      if (e.key === 'Enter') { e.preventDefault(); return run(actions[panel]) }
      if (e.key === 'Escape' || (e.metaKey && e.key.toLowerCase() === 'k')) { e.preventDefault(); return setPanel(null) }
    }
    if (down) return move(1, rows.length, setSel)
    if (up) return move(-1, rows.length, setSel)
    if (e.key === 'Escape') {
      e.preventDefault()
      if (q) setQ('')
      else hide()
      return
    }
    if (e.metaKey && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      if (actions.length) setPanel(0)
      return
    }
    const combo = comboOf({ code: ev.code, key: ev.key, meta: ev.metaKey, ctrl: ev.ctrlKey, alt: ev.altKey, shift: ev.shiftKey })
    const hit = combo ? actions.find((a) => a.key === combo) : undefined
    if (hit) {
      e.preventDefault()
      run(hit)
    }
  }

  let index = -1
  const keyLabel = (k: string): string => (k === 'enter' ? '↩' : formatCombo(k))
  return (
    <div className="launcher-frame" onMouseDown={(e) => { if (e.target === e.currentTarget) hide() }}>
      <div className="launcher" role="dialog" aria-label="Launcher">
        <div className="launcher-search">
          <Icon.search className="launcher-search-icon" />
          <input
            ref={input}
            autoFocus
            spellCheck={false}
            aria-label="Search apps, files, hosts and commands"
            placeholder="Search apps, files, hosts, notes…"
            value={q}
            onChange={(e) => { setQ(e.target.value); setPanel(null) }}
            onKeyDown={onKeyDown}
          />
          {q && <button type="button" className="launcher-clear" aria-label="Clear" onMouseDown={(e) => e.preventDefault()} onClick={() => setQ('')}><Icon.x /></button>}
        </div>
        <div className="launcher-body">
          <div className="launcher-list" ref={list}>
            {groups.map((g) => (
              <div key={g.title} role="group" aria-label={g.title}>
                <div className="launcher-group">{g.title}</div>
                {g.rows.map((r) => {
                  const at = ++index
                  const img = r.iconPath ? icons[r.iconPath] : ''
                  return (
                    <div
                      key={`${g.title}:${r.id}`}
                      role="option"
                      aria-selected={at === sel}
                      className={`launcher-item ${at === sel ? 'on' : ''}`}
                      onMouseMove={() => { if (sel !== at) setSel(at) }}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => run(r.actions[0])}
                    >
                      <span className="launcher-icon">{img ? <img src={img} alt="" /> : r.icon}</span>
                      <span className="launcher-text">
                        <span className="launcher-title">{r.title}</span>
                        {r.subtitle && <span className="launcher-sub">{r.subtitle}</span>}
                      </span>
                      {r.accessory && <span className="launcher-acc">{r.accessory}</span>}
                    </div>
                  )
                })}
              </div>
            ))}
            {!rows.length && <div className="launcher-empty">Loading…</div>}
          </div>
          <aside className="launcher-detail" aria-label="Details">
            {current && <DetailPane row={current} preview={previewPath ? previews[previewPath] : undefined} icon={current.iconPath ? icons[current.iconPath] : ''} home={data.home} accountLabel={accountLabel} spaceName={spaceName} />}
          </aside>
        </div>
        <div className="launcher-foot">
          <span className="brand-mark launcher-mark">&gt;_</span>
          <span className="flex-1" />
          {current?.actions.slice(0, 3).filter((a) => a.key).map((a) => (
            <button key={a.title} type="button" className="launcher-hint" onMouseDown={(e) => e.preventDefault()} onClick={() => run(a)}>{a.title} <kbd className="kbd">{keyLabel(a.key!)}</kbd></button>
          ))}
          {current && current.actions.length > 1 && (
            <button type="button" className="launcher-hint" onMouseDown={(e) => e.preventDefault()} onClick={() => setPanel(panel === null ? 0 : null)}>Actions <kbd className="kbd">⌘K</kbd></button>
          )}
        </div>
        {form && (
          <QuicklinkForm form={form} error={formError} spaces={data.browser?.spaces.map((x) => ({ id: x.id, name: x.name })) ?? [{ id: DEFAULT_SPACE, name: 'Browser' }]}
            onChange={(f) => { setForm(f); setFormError(null) }}
            onCancel={() => { setForm(null); setTimeout(() => input.current?.focus(), 0) }}
            onSave={() => {
              const link = cleanQuicklink(form)
              const others = links.filter((l) => l.id !== form.id)
              const why = checkQuicklink(link, others)
              if (why) { setFormError(why); return }
              void saveLinks(form.id ? links.map((l) => (l.id === form.id ? link : l)) : [...links, link]).then(() => {
                setForm(null)
                setQ(link.keyword || link.name)
                setTimeout(() => input.current?.focus(), 0)
              }, (e: Error) => setFormError(e.message))
            }} />
        )}
        {panel !== null && current && (
          <div className="launcher-actions" role="menu" aria-label="Actions">
            <div className="launcher-actions-title">{current.title}</div>
            {current.actions.map((a, n) => (
              <div key={a.title} role="menuitem" className={`launcher-action ${n === panel ? 'on' : ''}`} onMouseMove={() => setPanel(n)} onMouseDown={(e) => e.preventDefault()} onClick={() => run(a)}>
                <span>{a.title}</span>
                {a.key && <kbd className="kbd">{keyLabel(a.key)}</kbd>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** The right-hand pane: a thumbnail and the facts about the chosen result. */
function DetailPane({ row, preview, icon, home, accountLabel, spaceName }: {
  row: Row
  preview: LauncherPreview | null | undefined
  icon: string
  home: string
  accountLabel: (i: Instance) => string
  spaceName: (id: string) => string
}): ReactElement {
  const d = row.detail
  const facts = (items: [string, ReactNode][]): ReactElement => (
    <dl className="launcher-facts">
      {items.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => (
        <div key={k} className="contents"><dt>{k}</dt><dd>{v}</dd></div>
      ))}
    </dl>
  )
  if (d?.kind === 'path') {
    const p = preview
    const isApp = d.path.endsWith('.app')
    return (
      <>
        <div className={`launcher-thumb ${isApp ? 'app' : ''}`}>
          {p?.thumbnail ? <img src={p.thumbnail} alt="" /> : icon ? <img className="small" src={icon} alt="" /> : <span className="launcher-thumb-blank">{row.icon}</span>}
        </div>
        <div className="launcher-detail-title">{row.title}</div>
        {facts([
          ['Kind', p?.kind],
          ['Where', displayPath(parentOf(d.path), home, 80)],
          ['Size', p && !p.isDir ? formatSize({ name: row.title, size: p.size, type: 'file' }) : undefined],
          ['Created', p?.created ? formatDate(p.created) : undefined],
          ['Modified', p?.modified ? formatDate(p.modified) : undefined],
          ['Last opened', p ? (p.lastOpened ? formatDate(p.lastOpened) : 'Never') : undefined]
        ])}
      </>
    )
  }
  if (d?.kind === 'host') {
    const i = d.host
    return (
      <>
        <div className="launcher-thumb host">{i.platform === 'windows' ? <Icon.monitor /> : <Icon.terminal />}</div>
        <div className="launcher-detail-title">{i.name}</div>
        {facts([
          ['Account', accountLabel(i)],
          ['Region', i.manual ? undefined : i.region],
          ['State', i.manual ? undefined : <span className="launcher-state">{i.state}</span>],
          ['Private IP', i.privateIp],
          ['Public IP', i.publicIp],
          ['Instance', i.manual ? undefined : i.instanceId],
          ['Type', i.manual ? undefined : i.instanceType],
          ['System', i.osHint || i.platformDetails],
          ['SSM', i.manual ? undefined : i.ssmOnline ? 'Online' : 'Offline']
        ])}
      </>
    )
  }
  if (d?.kind === 'note') {
    return (
      <>
        <div className="launcher-thumb host"><Icon.note /></div>
        <div className="launcher-detail-title">{row.title}</div>
        {d.text && <p className="launcher-snippet">{d.text}</p>}
        {facts([['Note', d.path]])}
      </>
    )
  }
  if (d?.kind === 'web') {
    return (
      <>
        <div className="launcher-thumb host"><Favicon src={d.favicon} url={d.url} size={40} /></div>
        <div className="launcher-detail-title">{row.title}</div>
        {facts([['Space', spaceName(d.space)], ['Address', <span className="launcher-url">{d.url}</span>]])}
      </>
    )
  }
  if (d?.kind === 'quicklink') {
    return (
      <>
        <div className="launcher-thumb host"><Favicon url={d.url} size={40} /></div>
        <div className="launcher-detail-title">{d.link.name}</div>
        {facts([
          ['Keyword', d.link.keyword ? <kbd className="kbd">{d.link.keyword}</kbd> : 'none (found by name)'],
          ['Opens in', d.link.space === EXTERNAL ? 'Your browser' : spaceName(d.link.space)],
          ['Address', <span className="launcher-url">{d.link.url}</span>]
        ])}
        {takesQuery(d.link) && <p className="launcher-snippet">Type “{d.link.keyword || d.link.name} something” to put the words where the address says {'{query}'}.</p>}
      </>
    )
  }
  if (d?.kind === 'calc') {
    return (
      <div className="launcher-calc-big">
        <div className="muted">{d.expr} =</div>
        <div className="launcher-calc-value">{formatNumber(d.value)}{d.unit ? ` ${d.unit}` : ''}</div>
      </div>
    )
  }
  return (
    <>
      <div className="launcher-thumb host">{row.icon}</div>
      <div className="launcher-detail-title">{row.title}</div>
      {row.subtitle && <p className="launcher-snippet">{row.subtitle}</p>}
      {row.actions[0] && <p className="launcher-snippet">↩ {row.actions[0].title}</p>}
    </>
  )
}

/** Create or edit a quicklink, over the launcher's list: ↩ saves, Esc goes back. */
function QuicklinkForm({ form, error, spaces, onChange, onCancel, onSave }: {
  form: Quicklink
  error: string | null
  spaces: { id: string; name: string }[]
  onChange: (f: Quicklink) => void
  onCancel: () => void
  onSave: () => void
}): ReactElement {
  const keys = (e: ReactKeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel() }
    if (e.key === 'Enter') { e.preventDefault(); onSave() }
  }
  const field = (k: 'name' | 'keyword' | 'url', label: string, placeholder: string, hint?: string, autoFocus = false): ReactElement => (
    <label className="launcher-form-row">
      <span>{label}</span>
      <input className="input" value={form[k]} placeholder={placeholder} autoFocus={autoFocus} spellCheck={false} onChange={(e) => onChange({ ...form, [k]: e.target.value })} onKeyDown={keys} />
      {hint && <small className="muted">{hint}</small>}
    </label>
  )
  return (
    <div className="launcher-form" role="dialog" aria-label={form.id ? 'Edit Quicklink' : 'Create Quicklink'}>
      <div className="launcher-form-title"><Icon.globe /> {form.id ? 'Edit Quicklink' : 'Create Quicklink'}</div>
      {field('name', 'Name', 'AWS sign-in', undefined, !form.url)}
      {field('keyword', 'Keyword', 'aws', 'Type this word in the launcher and press ↩ to open it.', !!form.url)}
      {field('url', 'Address', 'https://mainspring.awsapps.com/start', 'Put {query} where words typed after the keyword should go.')}
      <label className="launcher-form-row">
        <span>Open in</span>
        <select className="input" value={form.space} onChange={(e) => onChange({ ...form, space: e.target.value })} onKeyDown={keys}>
          {spaces.map((sp) => <option key={sp.id} value={sp.id}>The app’s Browser: {sp.name}</option>)}
          <option value={EXTERNAL}>Your Mac’s default browser</option>
        </select>
      </label>
      {error && <div className="launcher-form-error">{error}</div>}
      <div className="launcher-form-buttons">
        <button type="button" className="btn btn-sm" onClick={onCancel}>Cancel <kbd className="kbd">esc</kbd></button>
        <button type="button" className="btn btn-sm btn-primary" onClick={onSave}>Save <kbd className="kbd">↩</kbd></button>
      </div>
    </div>
  )
}

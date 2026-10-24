import { workspaceSummary } from '@shared/workspaces'
import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react'
import { matchesHost } from '@shared/hostSearch'
import { readIntent, type Intent, type IntentContext } from '@shared/intent'
import { DEFAULT_SERVICES } from '@shared/services'
import { quickTask, type Project, type Task } from '@shared/tasks'
import { itemsOf, newRecordId } from '@shared/records'
import { RAIL_SECTIONS, SECTION_NAMES } from '@shared/keyCombos'
import { applyRecords } from '../records'
import { consoleHome, hostOf, spaceIdForProfile } from '@shared/browser'
import type { BrowserState, Instance, WebSpace } from '@shared/types'
import { formatCombo, type ShortcutTarget } from '@shared/keyCombos'
import { DESKTOP_TOOLS, filteredInstances, isSession, routeOf, TOOL_NAMES, useStore, visibleInstances, type Tab, type ToolKind, type WebTabInfo } from '../store'
import { consoleHomeFor, hasBrowser, openAccountConsole, openDefaultFor, openFilesFor, openRdpFor, openSshFor } from '../quickConnect'
import { runSnippet, snippetsFor } from './TerminalTab'
import { openHostNote } from './HostActions'
import { isMobile } from '../mobile'
import { APP_THEMES } from '../appThemes'
import { openKeyboardSettings, openRadial, sectionKeyLabel, terminalAction } from '../shortcuts'
import Modal from './Modal'
import MicButton from './MicButton'
import { Icon } from './icons'
import { Favicon, SpaceAvatar } from './browser/parts'
import { metaFor } from '../colors'

type IconFn = (p: { className?: string }) => ReactElement

interface Result {
  id: string
  title: string
  subtitle: string
  /** Host the result is about, for Shift+Enter (details). */
  key?: string
  icon: IconFn
  /** Drawn instead of `icon` (a site's favicon). */
  image?: ReactElement
  /** How far it is indented under the rows before it: 1 for a Browser space under the Browser's tab, 2 for its sites. */
  nested?: 1 | 2
  /** What it is, on the right of the row as the launcher labels them (Session, Host, Site, Command…). */
  type?: string
  /** A command's shortcut (⌘B) or a short note beside the type. */
  keys?: string
  /** More actions than ↩ and ⇧↩ (host details), in the Actions menu (⌘K): open beside, close a tab. */
  more?: { title: string; key: string; run: () => void }[]
  hint: string
  action: () => void
}

interface Command {
  id: string
  title: string
  keywords?: string
  hint?: string
  icon: IconFn
  run: () => void
  when?: boolean
}

/** Actions the palette offers; "when" hides ones that do not apply right now. */
function commands(): Command[] {
  const s = useStore.getState()
  const active = s.tabs.find((t) => t.id === s.activeTab)
  const inSplit = !s.gridView && s.splitGroup.includes(s.activeTab)
  const keyOf = (section: ShortcutTarget): string | undefined => sectionKeyLabel(section, s.settings?.shortcuts) || undefined
  const cmds: Command[] = [
    { id: 'rescan', title: 'Rescan inventory', keywords: 'refresh scan reload', icon: Icon.refresh, run: () => void s.scan() },
    { id: 'signin', title: 'Sign in / refresh SSO token', keywords: 'aws sso login token', icon: Icon.key, run: () => void s.refreshToken() },
    { id: 'settings', title: 'Open settings', keywords: 'preferences', icon: Icon.settings, run: () => s.set({ settingsOpen: true }) },
    { id: 'theme-light', title: 'Theme: light', keywords: 'appearance', icon: Icon.sun, run: () => void s.setTheme('light') },
    { id: 'theme-dark', title: 'Theme: dark', keywords: 'appearance', icon: Icon.moon, run: () => void s.setTheme('dark') },
    { id: 'theme-system', title: 'Theme: follow macOS', keywords: 'appearance system auto', icon: Icon.auto, run: () => void s.setTheme('system') },
    ...APP_THEMES.map((t) => ({ id: `color-theme:${t.id}`, title: `Theme: ${t.name}`, keywords: `colour color theme palette appearance ${t.dark ? 'dark' : 'light'}`, icon: Icon.palette, run: () => void s.setColorTheme(t.id) })),
    { id: 'sidebar', title: s.sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar', hint: '⌘B', icon: Icon.panelRight, run: () => s.toggleSidebar() },
    { id: 'hosts', title: 'Go to hosts', hint: '⌘1', icon: Icon.cloud, run: () => s.setActive('hosts') },
    { id: 'notes', title: 'Open notes', keywords: 'obsidian markdown vault', hint: keyOf('notes'), icon: Icon.note, run: () => s.openNotes() },
    { id: 'notes-today', title: "Open today's note", keywords: 'daily journal obsidian', icon: Icon.note, run: () => void window.api.invoke('notes:daily').then((p) => s.openNotes(p)) },
    { id: 'run-command', title: 'Run a command on hosts…', keywords: 'ssm run command send fleet bulk script shell powershell many all', icon: Icon.broadcast, run: () => s.set({ runCommandFor: { keys: filteredInstances(s).filter((i) => !i.manual && i.state === 'running' && i.ssmOnline).map((i) => i.key) } }) },
    { id: 'browser', title: 'Open browser', keywords: 'web arc tabs internet', hint: keyOf('browser'), icon: Icon.globe, run: () => s.openBrowser(), when: hasBrowser() },
    { id: 'finder', title: 'Open Finder', keywords: 'files folders local mac favorites recents documents downloads', hint: keyOf('finder'), icon: Icon.finder, run: () => s.openFinder(), when: hasBrowser() },
    { id: 'storage', title: 'Open Storage', keywords: 'disk space clean cleaner junk caches large files duplicates trash strata free up mac', hint: keyOf('storage'), icon: Icon.storage, run: () => s.openTool('storage'), when: hasBrowser() },
    { id: 'cad', title: 'Open the CAD viewer', keywords: 'step stp iges cad 3d model part assembly solidworks review viewer', hint: keyOf('cad'), icon: Icon.cube, run: () => s.openCad() },
    { id: 'health', title: 'Open health', keywords: '3dexperience platform status monitoring prometheus grafana metrics alerts', hint: keyOf('health'), icon: Icon.health, run: () => s.openTool('health') },
    { id: 'tasks', title: 'Open tasks', keywords: 'todo to-do things todoist reminders today upcoming projects checklist', hint: keyOf('tasks'), icon: Icon.tasks, run: () => s.openTool('tasks') },
    { id: 'calendar', title: 'Open calendar', keywords: 'events schedule agenda meetings month week ical', hint: keyOf('calendar'), icon: Icon.calendar, run: () => s.openTool('calendar') },
    { id: 'links', title: 'Open links', keywords: 'bookmarks anybox saved pages urls reading list', hint: keyOf('links'), icon: Icon.bookmark, run: () => s.openTool('links') },
    { id: 'devtools', title: 'Open developer tools', keywords: 'json format minify base64 encode decode url jwt uuid timestamp hash sha256 utilities', icon: Icon.code, run: () => s.openTool('devtools') },
    { id: 'board', title: 'Open whiteboard', keywords: 'scratch pad draw sketch brainstorm presentify canvas', hint: keyOf('board'), icon: Icon.board, run: () => s.openBoard() },
    { id: 'claude', title: 'Open Claude', keywords: 'ai assistant chat anthropic llm ask', hint: keyOf('claude'), icon: Icon.claude, run: () => s.openTool('claude') },
    { id: 'chatgpt', title: 'Open ChatGPT', keywords: 'ai assistant chat openai gpt llm ask', hint: keyOf('chatgpt'), icon: Icon.chatgpt, run: () => s.openTool('chatgpt') },
    { id: 'terminal', title: 'New terminal tab', keywords: 'local shell zsh warp console', icon: Icon.console, run: () => s.openTerminal({ newTab: true }), when: hasBrowser() },
    { id: 'notes-host', title: 'Open the note for this host', keywords: 'notes obsidian', icon: Icon.note, run: () => openHostNote(active!.instanceKey, active!.id), when: !!active?.instanceKey },
    { id: 'dblocks', title: 'Database locks…', keywords: 'oracle rds blocking blocked lock session kill deadlock dba', icon: Icon.database, run: () => s.set({ dbLocksFor: {} }) },
    { id: 'services', title: 'Control services…', keywords: 'systemctl restart start stop service 3dspace tomee systemd', icon: Icon.layers, run: () => s.set({ servicesFor: { targets: filteredInstances(s).filter((i) => !i.manual && i.platform !== 'windows' && i.state === 'running' && i.ssmOnline).map((i) => ({ key: i.key })), title: 'Hosts shown' } }) },
    { id: 'forward', title: 'Forward a port…', keywords: 'tunnel port forward database', icon: Icon.plug, run: () => s.set({ portForwardFor: {} }) },
    { id: 'snippets', title: 'Edit snippets…', keywords: 'commands saved', icon: Icon.snippet, run: () => s.set({ snippetsOpen: {} }) },
    { id: 'ws-save', title: 'Save open tabs as a workspace…', keywords: 'workspace session layout', icon: Icon.grid, run: () => s.set({ workspaceSaveOpen: true }), when: s.tabs.length > 0 },
    { id: 'add-host', title: 'Add a server outside AWS…', keywords: 'manual host', icon: Icon.server, run: () => s.set({ manualHostEditor: 'new' }) },
    { id: 'add-account', title: 'Add AWS account…', keywords: 'sso profile', icon: Icon.cloud, run: () => s.set({ addAccountOpen: true }) },
    {
      id: 'box-sync', title: 'Sync with Box now', keywords: 'box cloud sync upload tasks links calendar whiteboards', icon: Icon.cloud,
      run: () => void window.api.invoke('box:sync').then((b) => {
        if (!b.available) s.toast('info', 'This build has no Box app (Settings → Data).')
        else if (!b.signedIn) s.openSettings('data')
        else s.toast(b.lastError ? 'error' : 'success', b.lastError ? `Box: ${b.lastError}` : b.syncing ? 'Syncing with Box…' : 'In step with Box')
      }, (e: Error) => s.toast('error', e.message))
    },
    { id: 'shortcuts', title: 'Keyboard shortcuts', hint: '⌘/', icon: Icon.keyboard, run: () => s.set({ shortcutsOpen: true }) },
    { id: 'radial', title: 'Open the radial menu', keywords: 'wheel circle ring pie switch sections', hint: keyOf('radial'), icon: Icon.radial, run: () => openRadial(), when: !isMobile() },
    { id: 'launcher', title: 'Open the launcher', keywords: 'raycast spotlight alfred search apps files anywhere', hint: s.settings?.launcherKey ? formatCombo(s.settings.launcherKey) : undefined, icon: Icon.launcher, run: () => void window.api.invoke('launcher:show'), when: hasBrowser() },
    { id: 'shortcuts-edit', title: 'Set keyboard shortcuts for the sections…', keywords: 'keys hotkey customize rail claude chatgpt terminal finder', icon: Icon.keyboard, run: () => openKeyboardSettings() },
    { id: 'close', title: 'Close current tab', hint: '⌘W', icon: Icon.x, run: () => void s.closeTab(active!.id), when: !!active },
    { id: 'beside', title: 'Open beside this tab…', keywords: 'split side by side compare next to pane', hint: '⌘\\', icon: Icon.split, run: () => s.openQuickSwitcher('', { beside: active!.id }), when: !!active },
    { id: 'split', title: 'Split: same session beside this one', hint: '⌘D', icon: Icon.split, run: () => s.duplicateTab(active!.id, true), when: !!active && active.kind !== 'rdp' && isSession(active) },
    { id: 'arrange-columns', title: 'Side by side: all in a row', keywords: 'split layout arrange columns', icon: Icon.split, run: () => s.arrangeSplit('columns'), when: inSplit },
    { id: 'arrange-rows', title: 'Side by side: stacked', keywords: 'split layout arrange rows', icon: Icon.splitRows, run: () => s.arrangeSplit('rows'), when: inSplit },
    { id: 'arrange-main', title: 'Side by side: one large, the rest stacked', keywords: 'split layout arrange main', icon: Icon.splitMain, run: () => s.arrangeSplit('main'), when: inSplit && s.splitGroup.length > 2 },
    { id: 'arrange-grid', title: 'Side by side: grid', keywords: 'split layout arrange grid', icon: Icon.grid, run: () => s.arrangeSplit('grid'), when: inSplit && s.splitGroup.length > 2 },
    { id: 'split-zoom', title: s.splitZoom ? 'Side by side: show every pane' : 'Side by side: show this pane alone', keywords: 'split zoom maximize', hint: '⌘⇧↩', icon: Icon.maximize, run: () => s.set({ splitZoom: s.splitZoom ? null : s.activeTab }), when: inSplit },
    { id: 'split-done', title: 'Side by side: done (show the focused pane on its own)', keywords: 'split unsplit exit close', icon: Icon.x, run: () => s.endSplit(), when: inSplit },
    { id: 'dup', title: 'Duplicate current session', hint: '⌘⇧D', icon: Icon.plus, run: () => s.duplicateTab(active!.id), when: !!active && active.kind !== 'rdp' },
    { id: 'broadcast', title: s.broadcastInput ? 'Stop broadcasting input' : 'Broadcast input to all panes in the split', hint: '⌘⇧I', icon: Icon.broadcast, run: () => s.set({ broadcastInput: !s.broadcastInput }), when: s.splitGroup.includes(s.activeTab) },
    { id: 'find', title: 'Find in terminal', hint: '⌘F', icon: Icon.search, run: () => terminalAction(active!.id, 'find'), when: active?.kind === 'ssh' }
  ]
  for (const p of s.profiles.filter((x) => x.enabled && x.kind !== 'static')) {
    cmds.push({ id: `console:${p.name}`, title: `AWS console: ${p.name}`, keywords: 'aws console browser web account', icon: Icon.globe, run: () => openAccountConsole(p.name, consoleHome(p.region)) })
  }
  if (hasBrowser()) {
    for (const p of s.profiles.filter((x) => x.enabled)) {
      cmds.push({ id: `term:${p.name}`, title: `Terminal with AWS profile: ${p.name}`, keywords: 'local shell aws_profile cli terminal', icon: Icon.console, run: () => s.openTerminal({ profile: p.name }) })
    }
  }
  for (const w of s.settings?.workspaces ?? []) {
    cmds.push({ id: `ws:${w.id}`, title: `Open workspace: ${w.name}`, keywords: 'workspace', hint: workspaceSummary(w), icon: Icon.grid, run: () => s.openWorkspace(w.id) })
  }
  for (const v of s.settings?.hostViews ?? []) {
    cmds.push({ id: `view:${v.id}`, title: `Host view: ${v.name}`, keywords: `saved filters ${v.filters.search} ${v.filters.profileFilter ?? ''}`, icon: Icon.server, run: () => s.applyHostView(v.filters) })
  }
  for (const p of s.settings?.portForwards ?? []) {
    cmds.push({ id: `pf:${p.id}`, title: `Forward: ${p.name}`, keywords: 'tunnel port', hint: `:${p.remotePort}`, icon: Icon.plug,
      run: () => void s.openPortForward({ instanceKey: p.instanceKey, remotePort: p.remotePort, localPort: p.localPort, remoteHost: p.remoteHost, name: p.name }) })
  }
  if (active?.kind === 'ssh' && active.status === 'connected') {
    for (const sn of snippetsFor(active.instanceKey, s.settings?.snippets)) {
      cmds.push({ id: `sn:${sn.id}`, title: `Run snippet: ${sn.name}`, keywords: `snippet ${sn.command}`, hint: sn.run ? '↵' : 'paste', icon: Icon.snippet, run: () => runSnippet(active.id, sn) })
    }
  }
  return cmds.filter((c) => c.when !== false)
}

/** The tabs a saved Browser state holds, for when the Browser is not open in this window (store.webTabs is null). */
function savedWebTabs(b: BrowserState | null, names: (space: string) => string): WebTabInfo[] {
  if (!b) return []
  return b.tabs.filter((t) => /^https?:/.test(t.url || t.homeUrl || '')).map((t) => ({
    id: t.id, title: t.name || t.title, url: t.url || t.homeUrl || '', favicon: t.favicon, space: t.spaceId, spaceName: names(t.spaceId), pinned: t.pinned, favorite: t.favorite, current: b.activeTab[t.spaceId] === t.id
  }))
}

/** A site in the Browser, to switch straight to its tab (in its own space). */
function siteResult(t: WebTabInfo): Result {
  const host = hostOf(t.url)
  return {
    id: `site:${t.id}`, title: t.title || host, subtitle: `${t.current ? 'Showing' : t.favorite ? 'Favorite' : t.pinned ? 'Pinned' : 'Open'} · ${host}`,
    icon: Icon.globe, image: <Favicon src={t.favicon} url={t.url} size={16} />, hint: 'Switch',
    action: () => useStore.getState().openBrowser({ tab: t.id })
  }
}

/** The saved state's spaces in the Browser's order: its own, then one per AWS account (as BrowserTab derives them). */
function savedSpaces(b: BrowserState | null, profiles: { name: string; enabled: boolean; kind?: string }[], settings: Parameters<typeof metaFor>[1]): WebSpace[] {
  if (!b) return []
  const aws = profiles.filter((p) => p.enabled && p.kind !== 'static').map((p): WebSpace => {
    const m = metaFor(p.name, settings)
    const id = spaceIdForProfile(p.name)
    return { id, name: m.label, color: m.color, ...b.spaceLooks?.[id] }
  })
  return [...b.spaces, ...aws]
}

/**
 * The Browser's sites grouped by space (a Work page never mixed in with Prod's): each space a row of its own that
 * switches the Browser to it, then its sites, the one it shows first, then favorites, pinned and open tabs. Without a
 * query a space lists a few; the space row says how many it has.
 */
function siteGroups(sites: WebTabInfo[], spaces: WebSpace[], q: string): Result[] {
  const rank = (t: WebTabInfo): number => (t.current ? 0 : t.favorite ? 1 : t.pinned ? 2 : 3)
  const order = new Map(spaces.map((x, i) => [x.id, i]))
  const ids = [...new Set(sites.map((t) => t.space))].sort((a, b) => (order.get(a) ?? 999) - (order.get(b) ?? 999))
  const out: Result[] = []
  for (const id of ids) {
    const mine = sites.filter((t) => t.space === id).sort((a, b) => rank(a) - rank(b))
    const space = spaces.find((x) => x.id === id) ?? { id, name: mine[0].spaceName, color: 'slate' as WebSpace['color'] }
    const shown = mine.slice(0, q ? 12 : 5)
    out.push({
      id: `space:${id}`, title: space.name, subtitle: `Browser space · ${mine.length} ${q ? 'matching ' : ''}site${mine.length === 1 ? '' : 's'}${shown.length < mine.length ? `, ${shown.length} shown` : ''}`,
      icon: Icon.globe, image: <SpaceAvatar space={space} size={18} />, hint: 'Switch space', nested: 1,
      action: () => useStore.getState().openBrowser({ space: id })
    })
    out.push(...shown.map((t) => ({ ...siteResult(t), nested: 2 as const })))
  }
  return out
}

const fuzzy = (text: string, q: string): boolean => q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => text.toLowerCase().includes(w))

const TOOL_ICONS: Record<ToolKind, IconFn> = { local: Icon.console, browser: Icon.globe, notes: Icon.note, board: Icon.board, finder: Icon.finder, storage: Icon.storage, cad: Icon.cube, claude: Icon.claude, chatgpt: Icon.chatgpt, health: Icon.health, devtools: Icon.code, tasks: Icon.tasks, calendar: Icon.calendar, links: Icon.bookmark }
const tabIcon = (t: Tab): IconFn => (t.kind === 'rdp' ? Icon.monitor : t.kind === 'sftp' ? Icon.folder : t.kind === 'ssh' ? Icon.terminal : TOOL_ICONS[t.kind])

/**
 * Picking what to show beside a tab (⌘\): open tabs not already beside it, the tools, then hosts (a new session there).
 * Hosts come first once something is typed, since that is what a name or an IP most likely means.
 */
function besideResults(anchor: Tab, query: string, hosts: Instance[]): Result[] {
  const s = useStore.getState()
  const q = query.trim().toLowerCase()
  const group = s.splitGroup.includes(anchor.id) ? s.splitGroup : [anchor.id]
  const tabs = s.tabs.filter((t) => !t.transient && !group.includes(t.id) && `${t.title} ${t.shellLabel ?? ''} ${t.kind}`.toLowerCase().includes(q))
  const tools = (Object.keys(TOOL_NAMES) as ToolKind[])
    .filter((k) => (hasBrowser() || !DESKTOP_TOOLS.includes(k)) && !s.tabs.some((t) => t.kind === k) && TOOL_NAMES[k].toLowerCase().includes(q))
  const tabResults: Result[] = tabs.map((t) => ({ id: `tab:${t.id}`, title: t.title, subtitle: t.message && !isSessionKind(t) ? t.message : `Open tab · ${t.kind === 'ssh' ? 'SSH' : t.kind.toUpperCase()}`, icon: tabIcon(t), hint: 'Show beside', action: () => s.splitWith(anchor.id, t.id) }))
  const toolResults: Result[] = tools.map((k) => ({ id: `tool:${k}`, title: TOOL_NAMES[k], subtitle: 'Open beside', icon: TOOL_ICONS[k], hint: 'Open beside', action: () => s.splitWith(anchor.id, s.toolTab(k)) }))
  const hostResults: Result[] = hosts.slice(0, 40).map((i) => {
    const available = ['ssm', 'direct'].includes(routeOf(i, s.settings).route)
    return { id: i.key, title: i.name, subtitle: `${i.profile} · ${i.region} · ${i.instanceId}${i.state !== 'running' ? ` · ${i.state}` : ''}`, key: i.key,
      icon: i.platform === 'windows' ? Icon.monitor : Icon.terminal, hint: available ? `${i.platform === 'windows' ? 'Desktop' : 'SSH'} beside` : 'Details',
      action: () => (available ? openDefaultFor(i.key, { tab: anchor.id }) : s.revealHost(i.key)) }
  })
  return q ? [...tabResults, ...hostResults, ...toolResults] : [...tabResults, ...toolResults, ...hostResults]
}

const isSessionKind = (t: Tab): boolean => t.kind === 'ssh' || t.kind === 'rdp' || t.kind === 'sftp'

async function power(i: Instance, action: 'start' | 'stop'): Promise<void> {
  const s = useStore.getState()
  if (!window.confirm(`${action === 'start' ? 'Start' : 'Stop'} ${i.name} (${i.instanceId}) in ${i.profile}?`)) return
  try {
    await window.api.invoke(action === 'start' ? 'ec2:start' : 'ec2:stop', i.key)
    s.toast('success', `${action === 'start' ? 'Starting' : 'Stopping'} ${i.name}. Rescan in a minute.`)
  } catch (e) {
    s.toast('error', (e as Error).message)
  }
}

/** What the switcher does with a sentence (src/shared/intent.ts); the launcher handles the Mac's own (apps, windows). */
const SWITCHER_INTENTS = new Set<Intent['kind']>(['connect', 'files', 'power', 'forward', 'service', 'run', 'details', 'url', 'site', 'console', 'section', 'today', 'ask', 'search', 'capture', 'task'])
const INTENT_ICONS: Partial<Record<Intent['kind'], IconFn>> = {
  files: Icon.folder, power: Icon.power, forward: Icon.plug, service: Icon.layers, run: Icon.broadcast, details: Icon.server, url: Icon.globe, site: Icon.globe,
  console: Icon.cloud, section: Icon.grid, today: Icon.note, ask: Icon.claude, search: Icon.search, capture: Icon.note, task: Icon.tasks
}
const INTENT_TYPES: Partial<Record<Intent['kind'], string>> = {
  connect: 'Host', files: 'Host', power: 'Host', forward: 'Host', service: 'Host', run: 'Host', details: 'Host', url: 'Web Page', site: 'Browser Tab',
  console: 'AWS Console', section: 'Section', today: 'Note', ask: 'AI', search: 'Web Search', capture: 'Note', task: 'Task'
}

function runIntent(it: Intent, instances: Instance[]): void {
  const s = useStore.getState()
  const fail = (e: Error): void => s.toast('error', e.message)
  const inst = 'host' in it ? instances.find((i) => i.key === it.host.key) : undefined
  switch (it.kind) {
    case 'connect':
      if (it.via === 'ssh') openSshFor(it.host.key)
      else if (it.via === 'rdp') void openRdpFor(it.host.key)
      else if (inst && ['ssm', 'direct'].includes(routeOf(inst, s.settings).route)) openDefaultFor(it.host.key)
      else s.revealHost(it.host.key)
      return
    case 'files': return openFilesFor(it.host.key)
    case 'power': if (inst) void power(inst, it.action); return
    case 'forward': return s.set({ portForwardFor: { key: it.host.key, remotePort: it.port } })
    case 'service': return s.set({ servicesFor: { targets: [{ key: it.host.key }], title: it.host.name } })
    case 'run': return s.set({ runCommandFor: { keys: [it.host.key], command: it.command || undefined } })
    case 'details': return s.revealHost(it.host.key)
    case 'url':
      if (it.external || !hasBrowser()) void window.api.invoke('shell:open', it.url)
      else s.openBrowser({ url: it.url, space: it.space?.id })
      return
    case 'site': return s.openBrowser({ tab: it.site.id })
    case 'console': return it.account ? openAccountConsole(it.account.profile, consoleHomeFor(it.account.profile)) : s.openBrowser()
    case 'section':
      if (it.section === 'hosts') s.setActive('hosts')
      else if (it.section === 'overview') s.showGrid(true)
      else s.openTool(it.section as ToolKind)
      return
    case 'today': void window.api.invoke('notes:daily').then((p) => s.openNotes(p), fail); return
    case 'ask': return s.askAssistant(it.to, it.text)
    case 'search': {
      const url = `https://www.google.com/search?q=${encodeURIComponent(it.text)}`
      if (hasBrowser()) s.openBrowser({ url })
      else void window.api.invoke('shell:open', url)
      return
    }
    case 'capture': void window.api.invoke('notes:capture', it.text, it.task).then((p) => s.toast('success', `Added to ${p.split('/').pop()}`), fail); return
    case 'task':
      void window.api.invoke('records:load', 'tasks').then(async (doc) => {
        const made = quickTask(it.text, itemsOf<Project>(doc, 'project'), itemsOf<Task>(doc, 'task'), Date.now(), () => newRecordId())
        if (!made) return
        await applyRecords('tasks', made.ops)
        s.toast('success', `Task added: ${made.task.title}`)
      }).catch(fail)
      return
    default: return
  }
}

/** The rows a sentence reads as: "ssh to 3dspace1 in qa", "open mainspringenergy.com", "remind me to …". */
function intentResults(query: string, ctx: IntentContext, instances: Instance[]): Result[] {
  return readIntent(query, ctx).filter((m) => SWITCHER_INTENTS.has(m.intent.kind)).slice(0, 6).map((m, n): Result => {
    const it = m.intent
    const host = 'host' in it ? it.host : undefined
    const icon: IconFn = it.kind === 'connect' ? (it.via === 'rdp' || (it.via === 'any' && it.host.platform === 'windows') ? Icon.monitor : Icon.terminal)
      : it.kind === 'ask' && it.to === 'chatgpt' ? Icon.chatgpt : INTENT_ICONS[it.kind] ?? Icon.launcher
    const url = it.kind === 'url' ? it.url : it.kind === 'site' ? it.site.url : ''
    return {
      id: `do:${n}:${m.title}`, title: m.title, subtitle: m.subtitle ?? '', key: host?.key, icon, image: url ? <Favicon url={url} size={16} /> : undefined,
      hint: m.title.replace(/…$/, ''), type: INTENT_TYPES[it.kind], action: () => runIntent(it, instances)
    }
  })
}

export default function QuickSwitcher(): ReactElement {
  const s = useStore()
  const [query, setQuery] = useState(s.quickSwitcherQuery)
  const [selected, setSelected] = useState(0)
  const listId = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const close = (): void => s.set({ quickSwitcherOpen: false, quickSwitcherQuery: '', quickSwitcherBeside: null })
  const beside = s.quickSwitcherBeside ? s.tabs.find((t) => t.id === s.quickSwitcherBeside) : undefined
  const commandMode = !beside && query.startsWith('>')
  const q = commandMode ? query.slice(1).trim() : query.trim()
  const recentRank = (key: string): number => { const n = s.recentHosts.indexOf(key); return n < 0 ? 100 : n }
  const visible = visibleInstances(s)
  // The Browser's sites: live from the Browser tab, or as it last saved them when it is not open in this window.
  const [saved, setSaved] = useState<BrowserState | null>(null)
  useEffect(() => {
    if (s.webTabs === null && hasBrowser()) void window.api.invoke('browser:load').then(setSaved, () => undefined)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const spaceName = (id: string): string => {
    const own = saved?.spaces.find((x) => x.id === id)
    if (own) return own.name
    const p = s.profiles.find((x) => spaceIdForProfile(x.name) === id)
    return p ? (s.settings?.accountMeta?.[p.name]?.label ?? p.name) : 'Browser'
  }
  const sites = s.webTabs ?? savedWebTabs(saved, spaceName)
  const spaces = s.webSpaces ?? savedSpaces(saved, s.profiles, s.settings)
  const intentCtx: IntentContext = useMemo(() => ({
    hosts: visible.map((i) => ({ key: i.key, name: i.name, platform: i.platform, profile: i.profile, account: i.manual ? (i.profile === 'servers' ? 'Server' : i.profile) : s.settings?.accountMeta?.[i.profile]?.label ?? i.profile, region: i.manual ? undefined : i.region, state: i.manual ? 'running' : i.state, privateIp: i.privateIp, publicIp: i.publicIp, instanceId: i.manual ? undefined : i.instanceId, tags: Object.values(i.tags ?? {}) })),
    sites: sites.map((t) => ({ id: t.id, title: t.title, url: t.url, space: t.space })),
    spaces: spaces.map((x) => ({ id: x.id, name: x.name })),
    services: s.settings?.serviceCatalog?.length ? s.settings.serviceCatalog : DEFAULT_SERVICES,
    accounts: s.profiles.filter((p) => p.enabled).map((p) => ({ profile: p.name, label: s.settings?.accountMeta?.[p.name]?.label ?? p.name })),
    sections: RAIL_SECTIONS.map((sec) => ({ id: sec, name: SECTION_NAMES[sec] }))
  }), [visible, sites, spaces, s.settings, s.profiles]) // eslint-disable-line react-hooks/exhaustive-deps

  const cmdResults: Result[] = commands()
    .filter((c) => !q || fuzzy(`${c.title} ${c.keywords ?? ''}`, q))
    .map((c): Result => ({ id: `cmd:${c.id}`, title: c.title, subtitle: '', icon: c.icon, hint: 'Run Command', keys: c.hint, type: 'Command', action: c.run }))
  let results: Result[]
  if (beside) {
    results = besideResults(beside, query, visible.filter((i) => matchesHost(i, query)).sort((a, b) =>
      recentRank(a.key) - recentRank(b.key) || Number(s.isFavorite(b.key)) - Number(s.isFavorite(a.key)) || a.name.localeCompare(b.name)))
  } else if (commandMode) results = cmdResults
  else {
    const hosts = visible.filter((i) => matchesHost(i, query)).sort((a, b) =>
      recentRank(a.key) - recentRank(b.key) || Number(s.isFavorite(b.key)) - Number(s.isFavorite(a.key)) || a.name.localeCompare(b.name)
    )
    const tabs = s.tabs.filter((t) => !t.transient && `${t.title} ${t.shellLabel ?? ''} ${t.kind} ${t.status}`.toLowerCase().includes(q.toLowerCase()))
    // Every word in the site's title, address or space; the Browser's own tab stays first, its sites right under it.
    const siteHits = sites.filter((t) => !q || fuzzy(`${t.title} ${t.url} ${t.spaceName} site web`, q))
    const tabResults: Result[] = tabs.flatMap((t) => {
      const nSpaces = new Set(sites.map((x) => x.space)).size
      const r: Result = {
        id: `tab:${t.id}`, title: t.title, subtitle: isSession(t) ? `${t.kind.toUpperCase()} · ${t.status}` : t.kind === 'browser' && sites.length ? `${sites.length} site${sites.length === 1 ? '' : 's'} in ${nSpaces} space${nSpaces === 1 ? '' : 's'}` : '',
        key: t.instanceKey || undefined, icon: tabIcon(t), action: () => s.setActive(t.id), hint: 'Switch to Tab', type: isSession(t) ? 'Session' : 'Tab',
        more: [{ title: 'Close Tab', key: 'cmd+backspace', run: () => void s.closeTab(t.id) }]
      }
      return t.kind === 'browser' ? [r, ...siteGroups(siteHits, spaces, q)] : [r]
    })
    // Sites whose Browser tab is not open here (a detached Browser, or the Browser closed since): still listed.
    const orphanSites = tabs.some((t) => t.kind === 'browser') ? [] : siteGroups(siteHits, spaces, q).map((x) => ({ ...x, nested: x.nested === 2 ? 1 as const : undefined }))
    results = [
      ...intentResults(query, intentCtx, visible),
      ...tabResults,
      ...orphanSites,
      ...hosts.map((i) => {
        const available = ['ssm', 'direct'].includes(routeOf(i, s.settings).route)
        const anchor = s.tabs.find((t) => t.id === s.activeTab && !t.transient)
        return { id: i.key, title: i.name, subtitle: `${i.profile} · ${i.region} · ${i.instanceId}${i.staleReason ? ' · cached' : ''}`, key: i.key,
          icon: i.platform === 'windows' ? Icon.monitor : Icon.terminal, hint: available ? 'Connect' : 'Show Details', type: i.state !== 'running' && !i.manual ? `${i.state[0].toUpperCase()}${i.state.slice(1)}` : 'Host',
          action: () => available ? openDefaultFor(i.key) : s.revealHost(i.key),
          more: available && anchor ? [{ title: `${i.platform === 'windows' ? 'Remote Desktop' : 'SSH'} Beside ${anchor.title}`, key: 'cmd+enter', run: () => openDefaultFor(i.key, { tab: anchor.id }) }] : [] } as Result
      }),
      // Matching commands trail the hosts so a host name never loses the top slot to a command.
      ...(q.length >= 2 ? cmdResults.slice(0, 5) : [])
    ]
  }
  results = results.slice(0, 60)
  const index = Math.min(selected, Math.max(0, results.length - 1))
  const current = results[index]
  const [panel, setPanel] = useState<number | null>(null)
  useEffect(() => { setSelected(0); setPanel(null) }, [query])
  useEffect(() => { listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [index, query])
  const activate = (n: number, details = false): void => {
    const item = results[n]
    if (!item) return
    close()
    if (details && item.key) s.revealHost(item.key)
    else item.action()
  }
  /** ↩, then ⇧↩ (a host's details) and the item's own (⌘↩ beside, ⌘⌫ close), as the launcher's Actions menu lists them. */
  const actions: { title: string; key: string; run: () => void }[] = current ? [
    { title: current.hint || 'Open', key: 'enter', run: () => activate(index) },
    ...(current.key && !beside && !current.id.startsWith('tab:') ? [{ title: 'Show Host Details', key: 'shift+enter', run: () => activate(index, true) }] : []),
    ...(current.more ?? []).map((a) => ({ ...a, run: () => { close(); a.run() } }))
  ] : []
  const hasBrowserTab = results.some((r) => r.id.startsWith('tab:') && results[results.indexOf(r) + 1]?.id.startsWith('space:'))
  const groupOf = (r: Result): string => r.id.startsWith('do:') ? 'Do This' : r.id.startsWith('cmd:') ? 'Commands' : r.id.startsWith('tool:') ? 'Tools'
    : /^(start|stop|fwd|ssh|files):/.test(r.id) ? 'Actions' : r.id.startsWith('tab:') ? 'Open Tabs'
      : /^(space|site):/.test(r.id) ? (hasBrowserTab ? 'Open Tabs' : 'Browser') : beside ? 'Hosts' : 'Hosts'
  const typeOf = (r: Result): string => r.type ?? (r.id.startsWith('tool:') ? 'Tool' : r.id.startsWith('space:') ? 'Space' : r.id.startsWith('site:') ? 'Site' : r.id.startsWith('tab:') ? 'Tab' : /^(start|stop|fwd|ssh|files):/.test(r.id) ? 'Action' : 'Host')
  const toggleMode = (): void => { setQuery(commandMode ? q : `>${q}`); inputRef.current?.focus() }
  const caps = (k: string): string[] => (k === 'enter' ? ['↩'] : (() => { const f = formatCombo(k); const m = f.match(/^[⌃⌥⇧⌘]*/)?.[0] ?? ''; return [...m, f.slice(m.length)].filter(Boolean) })())
  let lastGroup = ''
  return <Modal title={beside ? `Open beside ${beside.title}` : commandMode ? 'Commands' : 'Quick switcher'} onClose={close} width="max-w-[760px]" bare className="switcher-modal">
    <div className={`launcher switcher ${commandMode ? 'commands' : ''}`}>
      <div className="launcher-search">
        <span className="launcher-logo" aria-hidden="true">{commandMode ? '>' : beside ? <Icon.split /> : <>&gt;_</>}</span>
        <input ref={inputRef} autoFocus spellCheck={false} aria-label="Find a host or open session" role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list" aria-activedescendant={results.length ? `${listId}-${index}` : undefined}
          placeholder={beside ? 'A host, an open tab or a tool to show beside it…' : commandMode ? 'Search commands and tools…' : 'Find a host, session or site, or say what to do: “ssh to 3dspace1”…'} value={query} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            const plain = !e.metaKey && !e.ctrlKey && !e.altKey
            if (panel !== null) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setPanel((n) => ((n ?? 0) + (e.key === 'ArrowDown' ? 1 : -1) + actions.length) % actions.length); return }
              if (e.key === 'Enter') { e.preventDefault(); actions[panel]?.run(); return }
              // Esc and ⌘K close the menu only (stopped here, before the dialog's and the app's own handlers).
              if (e.key === 'Escape' || (e.metaKey && e.key.toLowerCase() === 'k')) { e.preventDefault(); e.stopPropagation(); setPanel(null); return }
            }
            if (e.metaKey && !e.altKey && !e.ctrlKey && e.key.toLowerCase() === 'k') { e.preventDefault(); e.stopPropagation(); if (actions.length > 1) setPanel(0); return }
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setSelected((index + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % (results.length || 1)) }
            if (e.key === 'Enter' && e.metaKey) {
              const hit = actions.find((a) => a.key === 'cmd+enter')
              if (hit) { e.preventDefault(); hit.run() }
              return
            }
            if (e.key === 'Backspace' && e.metaKey) {
              const hit = actions.find((a) => a.key === 'cmd+backspace')
              if (hit) { e.preventDefault(); hit.run() }
              return
            }
            if (e.key === 'Enter' && plain) { e.preventDefault(); activate(index, e.shiftKey) }
            if (e.key === 'Backspace' && query === '>') { e.preventDefault(); setQuery('') }
          }} />
        <MicButton className="launcher-mic" target={() => inputRef.current} />
        {!beside && (
          <button type="button" className="launcher-quickai" title={commandMode ? 'Back to hosts and sessions' : 'Commands and tools (type >)'} onMouseDown={(e) => e.preventDefault()} onClick={toggleMode}>
            {commandMode ? 'Hosts & Sessions' : 'Commands'} <kbd className="launcher-cap">{commandMode ? '⌫' : '>'}</kbd>
          </button>
        )}
      </div>
      <div className="launcher-body">
        <div ref={listRef} id={listId} role="listbox" aria-label="Hosts and sessions" className="launcher-list">
          {results.map((item, n) => {
            const group = groupOf(item)
            const head = group !== lastGroup ? group : ''
            lastGroup = group
            const keys = item.keys && /^[⌃⌥⇧⌘]/.test(item.keys) ? item.keys : ''
            return (
              <div key={item.id} className="contents">
                {head && <div className="launcher-group" aria-hidden="true">{head}</div>}
                <button id={`${listId}-${n}`} type="button" role="option" aria-selected={n === index} tabIndex={-1}
                  className={`launcher-item switcher-result ${n === index ? 'on' : ''} ${item.nested ? `nested-${item.nested}` : ''} ${item.id.startsWith('space:') ? 'space' : ''}`}
                  onMouseMove={() => { if (n !== index) setSelected(n) }} onClick={() => activate(n)}>
                  <span className="launcher-icon">{item.image ?? <item.icon />}</span>
                  <span className="launcher-text"><span className="launcher-title">{item.title}</span>{item.subtitle && <span className="launcher-sub">{item.subtitle}</span>}</span>
                  {keys ? <span className="launcher-caps">{[...keys.match(/^[⌃⌥⇧⌘]*/)![0], keys.replace(/^[⌃⌥⇧⌘]*/, '')].filter(Boolean).map((k, i) => <kbd key={i} className="launcher-cap">{k}</kbd>)}</span>
                    : item.keys ? <span className="launcher-acc">{item.keys}</span> : null}
                  <span className="launcher-type">{typeOf(item)}</span>
                </button>
              </div>
            )
          })}
          {!results.length && <div className="launcher-empty">{commandMode ? 'No matching commands.' : 'No matching hosts, sessions or sites. Try a name, IP or account, or type > for commands.'}</div>}
        </div>
      </div>
      <div className="launcher-bar">
        {beside
          ? <span className="launcher-pill launcher-command" title="Shown side by side with it; drag a pane’s header to move it, or its border to resize"><Icon.split /><span>Beside {beside.title}</span></span>
          : <button type="button" className="launcher-pill launcher-command" title={commandMode ? 'Back to hosts and sessions' : 'Commands and tools (type >)'} onMouseDown={(e) => e.preventDefault()} onClick={toggleMode}>
            {commandMode ? <Icon.launcher /> : <Icon.search />}<span>{commandMode ? 'Commands & Tools' : 'Hosts & Sessions'}</span>
          </button>}
        <span className="flex-1" />
        {actions[0] && (
          <div className="launcher-pill launcher-actionbar">
            <button type="button" className="launcher-primary" onMouseDown={(e) => e.preventDefault()} onClick={() => actions[0].run()}>{actions[0].title} <kbd className="launcher-cap">↩</kbd></button>
            {actions.length > 1 && <>
              <span className="launcher-pill-sep" />
              <button type="button" className="launcher-hint" onMouseDown={(e) => e.preventDefault()} onClick={() => setPanel(panel === null ? 0 : null)}>Actions <kbd className="launcher-cap">⌘</kbd><kbd className="launcher-cap">K</kbd></button>
            </>}
          </div>
        )}
      </div>
      {panel !== null && current && (
        <div className="launcher-actions" role="menu" aria-label="Actions">
          <div className="launcher-actions-title">{current.title}</div>
          {actions.map((a, n) => (
            <div key={a.title} role="menuitem" className={`launcher-action ${n === panel ? 'on' : ''}`} onMouseMove={() => setPanel(n)} onMouseDown={(e) => e.preventDefault()} onClick={() => a.run()}>
              <span>{a.title}</span>
              <span className="launcher-caps">{caps(a.key).map((k, i) => <kbd key={i} className="launcher-cap">{k}</kbd>)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  </Modal>
}

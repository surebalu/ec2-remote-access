import { workspaceSummary } from '@shared/workspaces'
import { useEffect, useId, useRef, useState, type ReactElement } from 'react'
import { matchesHost } from '@shared/hostSearch'
import { consoleHome } from '@shared/browser'
import type { Instance } from '@shared/types'
import { formatCombo, type ShortcutTarget } from '@shared/keyCombos'
import { DESKTOP_TOOLS, filteredInstances, isSession, routeOf, TOOL_NAMES, useStore, visibleInstances, type Tab, type ToolKind } from '../store'
import { hasBrowser, openAccountConsole, openDefaultFor, openFilesFor, openSshFor } from '../quickConnect'
import { runSnippet, snippetsFor } from './TerminalTab'
import { openHostNote } from './HostActions'
import { isMobile } from '../mobile'
import { APP_THEMES } from '../appThemes'
import { openKeyboardSettings, openRadial, sectionKeyLabel, terminalAction } from '../shortcuts'
import Modal from './Modal'
import { Icon } from './icons'

type IconFn = (p: { className?: string }) => ReactElement

interface Result {
  id: string
  title: string
  subtitle: string
  /** Host the result is about, for Shift+Enter (details). */
  key?: string
  icon: IconFn
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

const fuzzy = (text: string, q: string): boolean => q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => text.toLowerCase().includes(w))

const TOOL_ICONS: Record<ToolKind, IconFn> = { local: Icon.console, browser: Icon.globe, notes: Icon.note, board: Icon.board, finder: Icon.finder, storage: Icon.storage, claude: Icon.claude, chatgpt: Icon.chatgpt, health: Icon.health, devtools: Icon.code, tasks: Icon.tasks, calendar: Icon.calendar, links: Icon.bookmark }
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

/** "start web", "stop web", "forward db", "ssh web", "files web": a verb followed by a host query. */
function hostVerbs(q: string, hosts: Instance[]): Result[] {
  const m = /^(start|stop|forward|port|ssh|files|sftp)\s+(.+)$/i.exec(q.trim())
  if (!m) return []
  const verb = m[1].toLowerCase()
  const s = useStore.getState()
  const matches = hosts.filter((i) => matchesHost(i, m[2])).slice(0, 8)
  const power = async (i: Instance, action: 'start' | 'stop'): Promise<void> => {
    if (!window.confirm(`${action === 'start' ? 'Start' : 'Stop'} ${i.name} (${i.instanceId}) in ${i.profile}?`)) return
    try {
      await window.api.invoke(action === 'start' ? 'ec2:start' : 'ec2:stop', i.key)
      s.toast('success', `${action === 'start' ? 'Starting' : 'Stopping'} ${i.name}. Rescan in a minute.`)
    } catch (e) {
      s.toast('error', (e as Error).message)
    }
  }
  return matches.flatMap((i): Result[] => {
    const sub = `${i.profile} · ${i.region} · ${i.state}`
    if (verb === 'start' && !i.manual && i.state === 'stopped') return [{ id: `start:${i.key}`, key: i.key, title: `Start ${i.name}`, subtitle: sub, icon: Icon.play, hint: 'Start', action: () => void power(i, 'start') }]
    if (verb === 'stop' && !i.manual && i.state === 'running') return [{ id: `stop:${i.key}`, key: i.key, title: `Stop ${i.name}`, subtitle: sub, icon: Icon.x, hint: 'Stop…', action: () => void power(i, 'stop') }]
    if ((verb === 'forward' || verb === 'port') && !i.manual && i.ssmOnline && i.state === 'running') return [{ id: `fwd:${i.key}`, key: i.key, title: `Forward a port on ${i.name}…`, subtitle: sub, icon: Icon.plug, hint: 'Forward', action: () => s.set({ portForwardFor: { key: i.key } }) }]
    if (verb === 'ssh' && i.platform !== 'windows') return [{ id: `ssh:${i.key}`, key: i.key, title: `SSH to ${i.name}`, subtitle: sub, icon: Icon.terminal, hint: 'SSH', action: () => openSshFor(i.key) }]
    if ((verb === 'files' || verb === 'sftp') && i.platform !== 'windows') return [{ id: `files:${i.key}`, key: i.key, title: `Files on ${i.name}`, subtitle: sub, icon: Icon.folder, hint: 'Files', action: () => openFilesFor(i.key) }]
    return []
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

  const cmdResults: Result[] = commands()
    .filter((c) => !q || fuzzy(`${c.title} ${c.keywords ?? ''}`, q))
    .map((c) => ({ id: `cmd:${c.id}`, title: c.title, subtitle: commandMode ? '' : 'Command', icon: c.icon, hint: c.hint ?? '', action: c.run }))
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
    results = [
      ...hostVerbs(query, visible),
      ...tabs.map((t) => ({ id: `tab:${t.id}`, title: t.title, subtitle: isSession(t) ? `Open ${t.kind.toUpperCase()} session · ${t.status}` : 'Open tab', key: t.instanceKey || undefined, icon: tabIcon(t), action: () => s.setActive(t.id), hint: 'Switch' })),
      ...hosts.map((i) => {
        const available = ['ssm', 'direct'].includes(routeOf(i, s.settings).route)
        return { id: i.key, title: i.name, subtitle: `${i.profile} · ${i.region} · ${i.instanceId}${i.staleReason ? ' · cached' : ''}`, key: i.key,
          icon: i.platform === 'windows' ? Icon.monitor : Icon.terminal, hint: available ? 'Connect' : 'Details',
          action: () => available ? openDefaultFor(i.key) : s.revealHost(i.key) }
      }),
      // Matching commands trail the hosts so a host name never loses the top slot to a command.
      ...(q.length >= 2 ? cmdResults.slice(0, 5) : [])
    ]
  }
  results = results.slice(0, 60)
  const index = Math.min(selected, Math.max(0, results.length - 1))
  useEffect(() => { setSelected(0) }, [query])
  useEffect(() => { listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [index, query])
  const activate = (n: number, details = false): void => {
    const item = results[n]
    if (!item) return
    close()
    if (details && item.key) s.revealHost(item.key)
    else item.action()
  }
  return <Modal title={beside ? `Open beside ${beside.title}` : commandMode ? 'Commands' : 'Quick switcher'} onClose={close} width="max-w-2xl">
    {!beside && <div className="switcher-modes" role="group" aria-label="Search mode">
      <button aria-pressed={!commandMode} onClick={() => { setQuery(q); inputRef.current?.focus() }}><Icon.search />Hosts & sessions</button>
      <button aria-pressed={commandMode} onClick={() => { setQuery(`>${q}`); inputRef.current?.focus() }}><Icon.launcher />Commands & tools</button>
    </div>}
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-3 muted"><Icon.search /></span>
      <input ref={inputRef} autoFocus className="input !h-10 !pl-9 !text-sm" aria-label="Find a host or open session" role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list" aria-activedescendant={results.length ? `${listId}-${index}` : undefined}
        placeholder={beside ? 'A host (name, IP, instance ID), an open tab, or a tool' : 'Find a host, IP, account, region, tag or session. Type > for commands.'} value={query} onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setSelected((index + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % (results.length || 1)) }
          if (e.key === 'Enter') { e.preventDefault(); activate(index, e.shiftKey) }
          if (e.key === 'Backspace' && query === '>') { e.preventDefault(); setQuery('') }
        }} />
    </div>
    <p className="muted my-3 text-xs">{query ? `${results.length}${results.length === 60 ? '+' : ''} result${results.length === 1 ? '' : 's'}` : beside ? 'Shown side by side with it; drag a pane’s header to move it, or its border to resize' : 'Open sessions, recent connections, and favorites first'}</p>
    <div ref={listRef} id={listId} role="listbox" aria-label="Hosts and sessions" className="max-h-[50vh] overflow-y-auto space-y-1">
      {results.map((item, n) => <button key={item.id} id={`${listId}-${n}`} type="button" role="option" aria-selected={n === index} tabIndex={-1}
        className={`switcher-result ${n === index ? 'on' : ''}`} onMouseMove={() => setSelected(n)} onClick={() => activate(n)}>
        <item.icon /><span className="min-w-0 flex-1 text-left"><span className="block truncate font-medium">{item.title}</span>{item.subtitle && <span className="muted block truncate text-[11px]">{item.subtitle}</span>}</span>
        {item.hint && <span className="muted text-[11px]">{item.hint}</span>}
      </button>)}
      {!results.length && <p className="muted py-10 text-center">{commandMode ? 'No matching commands.' : 'No matching hosts or sessions. Try a name, IP, or account, or type > for commands.'}</p>}
    </div>
    <div className="muted mt-3 flex flex-wrap gap-4 border-t border-default pt-3 text-[11px]"><span>↑ ↓ Navigate</span><span>↵ Open</span><span>⇧ ↵ Host details</span><span><span className="mono">&gt;</span> Commands</span><span>start / stop / forward &lt;host&gt;</span><span>Esc Close</span></div>
  </Modal>
}

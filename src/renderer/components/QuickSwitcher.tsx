import { useEffect, useId, useRef, useState, type ReactElement } from 'react'
import { matchesHost } from '@shared/hostSearch'
import type { Instance } from '@shared/types'
import { routeOf, useStore, visibleInstances } from '../store'
import { openDefaultFor, openFilesFor, openSshFor } from '../quickConnect'
import { runSnippet, snippetsFor } from './TerminalTab'
import { terminalAction } from '../shortcuts'
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
  const cmds: Command[] = [
    { id: 'rescan', title: 'Rescan inventory', keywords: 'refresh scan reload', icon: Icon.refresh, run: () => void s.scan() },
    { id: 'signin', title: 'Sign in / refresh SSO token', keywords: 'aws sso login token', icon: Icon.key, run: () => void s.refreshToken() },
    { id: 'settings', title: 'Open settings', keywords: 'preferences', icon: Icon.settings, run: () => s.set({ settingsOpen: true }) },
    { id: 'theme-light', title: 'Theme: light', keywords: 'appearance', icon: Icon.sun, run: () => void s.setTheme('light') },
    { id: 'theme-dark', title: 'Theme: dark', keywords: 'appearance', icon: Icon.moon, run: () => void s.setTheme('dark') },
    { id: 'theme-system', title: 'Theme: follow macOS', keywords: 'appearance system auto', icon: Icon.auto, run: () => void s.setTheme('system') },
    { id: 'sidebar', title: s.sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar', hint: '⌘B', icon: Icon.panelRight, run: () => s.toggleSidebar() },
    { id: 'hosts', title: 'Go to hosts', hint: '⌘1', icon: Icon.cloud, run: () => s.setActive('hosts') },
    { id: 'forward', title: 'Forward a port…', keywords: 'tunnel port forward database', icon: Icon.plug, run: () => s.set({ portForwardFor: {} }) },
    { id: 'snippets', title: 'Edit snippets…', keywords: 'commands saved', icon: Icon.snippet, run: () => s.set({ snippetsOpen: {} }) },
    { id: 'ws-save', title: 'Save open tabs as a workspace…', keywords: 'workspace session layout', icon: Icon.grid, run: () => s.set({ workspaceSaveOpen: true }), when: s.tabs.length > 0 },
    { id: 'add-host', title: 'Add a server outside AWS…', keywords: 'manual host', icon: Icon.server, run: () => s.set({ manualHostEditor: 'new' }) },
    { id: 'add-account', title: 'Add AWS account…', keywords: 'sso profile', icon: Icon.cloud, run: () => s.set({ addAccountOpen: true }) },
    { id: 'shortcuts', title: 'Keyboard shortcuts', hint: '⌘/', icon: Icon.keyboard, run: () => s.set({ shortcutsOpen: true }) },
    { id: 'close', title: 'Close current tab', hint: '⌘W', icon: Icon.x, run: () => void s.closeTab(active!.id), when: !!active },
    { id: 'split', title: 'Split: same session beside this one', hint: '⌘D', icon: Icon.split, run: () => s.duplicateTab(active!.id, true), when: !!active && active.kind !== 'rdp' },
    { id: 'dup', title: 'Duplicate current session', hint: '⌘⇧D', icon: Icon.plus, run: () => s.duplicateTab(active!.id), when: !!active && active.kind !== 'rdp' },
    { id: 'broadcast', title: s.broadcastInput ? 'Stop broadcasting input' : 'Broadcast input to all panes in the split', hint: '⌘⇧I', icon: Icon.broadcast, run: () => s.set({ broadcastInput: !s.broadcastInput }), when: s.splitGroup.includes(s.activeTab) },
    { id: 'find', title: 'Find in terminal', hint: '⌘F', icon: Icon.search, run: () => terminalAction(active!.id, 'find'), when: active?.kind === 'ssh' }
  ]
  for (const w of s.settings?.workspaces ?? []) {
    cmds.push({ id: `ws:${w.id}`, title: `Open workspace: ${w.name}`, keywords: 'workspace', hint: `${w.tabs.length} tabs`, icon: Icon.grid, run: () => s.openWorkspace(w.id) })
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

const fuzzy = (text: string, q: string): boolean => q.split(/\s+/).filter(Boolean).every((w) => text.toLowerCase().includes(w))

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
  const close = (): void => s.set({ quickSwitcherOpen: false, quickSwitcherQuery: '' })
  const commandMode = query.startsWith('>')
  const q = commandMode ? query.slice(1).trim() : query.trim()
  const recentRank = (key: string): number => { const n = s.recentHosts.indexOf(key); return n < 0 ? 100 : n }
  const visible = visibleInstances(s)

  const cmdResults: Result[] = commands()
    .filter((c) => !q || fuzzy(`${c.title} ${c.keywords ?? ''}`, q))
    .map((c) => ({ id: `cmd:${c.id}`, title: c.title, subtitle: commandMode ? '' : 'Command', icon: c.icon, hint: c.hint ?? '', action: c.run }))
  let results: Result[]
  if (commandMode) results = cmdResults
  else {
    const hosts = visible.filter((i) => matchesHost(i, query)).sort((a, b) =>
      recentRank(a.key) - recentRank(b.key) || Number(s.isFavorite(b.key)) - Number(s.isFavorite(a.key)) || a.name.localeCompare(b.name)
    )
    const tabs = s.tabs.filter((t) => `${t.title} ${t.kind} ${t.status}`.toLowerCase().includes(q.toLowerCase()))
    results = [
      ...hostVerbs(query, visible),
      ...tabs.map((t) => ({ id: `tab:${t.id}`, title: t.title, subtitle: `Open ${t.kind.toUpperCase()} session · ${t.status}`, key: t.instanceKey, icon: t.kind === 'rdp' ? Icon.monitor : t.kind === 'sftp' ? Icon.folder : Icon.terminal, action: () => s.setActive(t.id), hint: 'Switch' })),
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
  return <Modal title={commandMode ? 'Commands' : 'Quick switcher'} onClose={close} width="max-w-2xl">
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-3 muted"><Icon.search /></span>
      <input autoFocus className="input !h-10 !pl-9 !text-sm" aria-label="Find a host or open session" role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list" aria-activedescendant={results.length ? `${listId}-${index}` : undefined}
        placeholder="Find a host, IP, account, region, tag or session. Type > for commands." value={query} onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setSelected((index + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % (results.length || 1)) }
          if (e.key === 'Enter') { e.preventDefault(); activate(index, e.shiftKey) }
          if (e.key === 'Backspace' && query === '>') { e.preventDefault(); setQuery('') }
        }} />
    </div>
    <p className="muted my-3 text-xs">{query ? `${results.length}${results.length === 60 ? '+' : ''} result${results.length === 1 ? '' : 's'}` : 'Open sessions, recent connections, and favorites first'}</p>
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

import type { BrowserState, PaneNode, TerminalState, Workspace, WorkspaceBrowser, WorkspaceTerminal } from './types'

export const workspaceSize = (w: Workspace): number => w.tabs.length + (w.tools?.length ?? 0)
export function workspaceSummary(w: Workspace): string {
  const parts: string[] = []
  if (w.tabs.length) parts.push(`${w.tabs.length} remote ${w.tabs.length === 1 ? 'session' : 'sessions'}`)
  for (const t of w.tools ?? []) {
    if (t.kind === 'local') parts.push(`${t.terminal.tabs.length} terminal ${t.terminal.tabs.length === 1 ? 'tab' : 'tabs'}`)
    else if (t.kind === 'browser') parts.push(`${t.browser.tabs.length} browser ${t.browser.tabs.length === 1 ? 'page' : 'pages'}`)
    else parts.push(({ notes: 'Notes', finder: 'Finder', board: 'Whiteboard', claude: 'Claude', chatgpt: 'ChatGPT', health: 'Health', devtools: 'Dev tools' })[t.kind])
  }
  return parts.join(' · ') || 'Empty workspace'
}

/** Remap only surviving panes, collapse empty splits and preserve the relative widths of the survivors. */
export function workspaceLayout(root: PaneNode | null | undefined, ids: ReadonlyMap<string, string>): PaneNode | null {
  const seen = new Set<string>()
  const visit = (node: PaneNode): PaneNode | null => {
    if (node.type === 'pane') {
      const id = ids.get(node.id)
      if (!id || seen.has(id)) return null
      seen.add(id)
      return { type: 'pane', id }
    }
    const kept = node.children.map((child, i) => ({ child: visit(child), size: node.sizes[i] })).filter((v) => v.child !== null)
    if (!kept.length) return null
    if (kept.length === 1) return kept[0].child
    const sizes = kept.map((v) => Number.isFinite(v.size) && v.size > 0 ? v.size : 1)
    const total = sizes.reduce((a, b) => a + b, 0)
    return { type: 'split', dir: node.dir, children: kept.map((v) => v.child!), sizes: sizes.map((n) => n / total) }
  }
  return root ? visit(root) : null
}

function paneKeys(root: PaneNode): string[] {
  return root.type === 'pane' ? [root.id] : root.children.flatMap(paneKeys)
}

export function captureTerminal(s: WorkspaceTerminal, selected?: readonly string[]): WorkspaceTerminal {
  const tabs = s.tabs.filter((t) => !selected || selected.includes(t.id)).map((t) => ({
    id: t.id, title: t.title, color: t.color, profile: t.profile,
    root: workspaceLayout(t.root, new Map(paneKeys(t.root).map((id) => [id, id])))!, activePane: t.activePane
  }))
  const panes = new Set(tabs.flatMap((t) => paneKeys(t.root)))
  return {
    tabs, activeTab: tabs.some((t) => t.id === s.activeTab) ? s.activeTab : tabs[0]?.id ?? '',
    cwds: Object.fromEntries(Object.entries(s.cwds).filter(([id]) => panes.has(id)))
  }
}

/** Keep running shells intact; only missing tabs get fresh pane ids and new shells in the saved directories. */
export function restoreTerminal(current: TerminalState, saved: WorkspaceTerminal, workspaceId: string, newId: () => string): TerminalState {
  const tabs = [...current.tabs]
  const cwds = { ...current.cwds }
  const ids = new Map<string, string>()
  for (const t of captureTerminal(saved).tabs) {
    const source = `${workspaceId}/${t.id}`
    const live = tabs.find((x) => x.id === t.id || x.workspaceSource === source)
    if (live) { ids.set(t.id, live.id); continue }
    const panes = new Map(paneKeys(t.root).map((id) => [id, newId()]))
    const id = newId()
    ids.set(t.id, id)
    tabs.push({ ...t, id, workspaceSource: source, root: workspaceLayout(t.root, panes)!, activePane: panes.get(t.activePane) ?? [...panes.values()][0] })
    for (const [old, fresh] of panes) if (saved.cwds[old]) cwds[fresh] = saved.cwds[old]
  }
  return { ...current, tabs, cwds, activeTab: ids.get(saved.activeTab) ?? ids.values().next().value ?? current.activeTab }
}

/** Store web destinations rather than authentication handoffs, embedded credentials or executable URLs. */
export function workspacePageUrl(raw: string): string {
  if (!raw || raw === 'about:blank') return raw
  try {
    let url = new URL(raw)
    if (url.hostname === 'signin.aws.amazon.com' && url.pathname === '/federation') url = new URL(url.searchParams.get('Destination') ?? '')
    if (!['http:', 'https:'].includes(url.protocol)) return ''
    url.username = ''; url.password = ''
    const sensitive = /^(access_token|id_token|refresh_token|signinToken|password|passwd|api[-_]?key|token|authorization|code|x-amz-.+)$/i
    for (const key of [...url.searchParams.keys()]) if (sensitive.test(key)) url.searchParams.delete(key)
    if (url.hash.includes('=')) {
      const hash = new URLSearchParams(url.hash.slice(1))
      if ([...hash.keys()].some((key) => sensitive.test(key))) url.hash = ''
    }
    return url.href
  } catch { return '' }
}

export function captureBrowser(s: WorkspaceBrowser, selected?: readonly string[]): WorkspaceBrowser {
  const tabs = s.tabs.filter((t) => !selected || selected.includes(t.id)).map((t) => ({
    id: t.id, spaceId: t.spaceId, url: workspacePageUrl(t.url), title: t.title,
    name: t.name, pinned: t.pinned, favorite: t.favorite, homeUrl: t.homeUrl ? workspacePageUrl(t.homeUrl) : undefined, lastActive: 0
  }))
  const activeTab = Object.fromEntries([...new Set(tabs.map((t) => t.spaceId))].map((space) => [
    space, tabs.find((t) => t.spaceId === space && t.id === s.activeTab[space])?.id ?? tabs.find((t) => t.spaceId === space)!.id
  ]))
  return { tabs, activeTab, activeSpace: activeTab[s.activeSpace] ? s.activeSpace : tabs[0]?.spaceId ?? s.activeSpace }
}

/** Pages never cross cookie containers. A removed/disabled account space is skipped instead of using another login. */
export function restoreBrowser(current: BrowserState, saved: WorkspaceBrowser, availableSpaces: readonly string[], newId: () => string): { state: BrowserState; skipped: number } {
  const tabs = [...current.tabs]
  const ids = new Map<string, string>()
  let skipped = 0
  for (const t of captureBrowser(saved).tabs) {
    if (!availableSpaces.includes(t.spaceId)) { skipped++; continue }
    const live = tabs.find((x) => x.spaceId === t.spaceId && x.url === t.url)
    const id = live?.id ?? newId()
    ids.set(t.id, id)
    if (!live) tabs.push({ ...t, id, lastActive: Date.now() })
  }
  const activeTab = { ...current.activeTab }
  for (const [space, old] of Object.entries(saved.activeTab)) {
    const id = ids.get(old)
    if (id) activeTab[space] = id
  }
  const first = tabs.find((t) => t.id === ids.values().next().value)
  const activeSpace = ids.has(saved.activeTab[saved.activeSpace]) ? saved.activeSpace : first?.spaceId ?? current.activeSpace
  return { state: { ...current, tabs, activeTab, activeSpace }, skipped }
}

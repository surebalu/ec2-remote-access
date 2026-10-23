import { workspaceSize, workspaceSummary } from '@shared/workspaces'
import { useState, type ReactElement } from 'react'
import { useStore, visibleInstances } from '../../store'
import { hasBrowser } from '../../quickConnect'
import { EXTERNAL, quicklinkUrl, takesQuery, type Quicklink } from '@shared/quicklinks'
import { Icon } from '../icons'

export default function SavedWork(): ReactElement {
  const s = useStore()
  const [search, setSearch] = useState('')
  const [queryFor, setQueryFor] = useState<Quicklink | null>(null)
  const [query, setQuery] = useState('')
  const matches = (name: string): boolean => name.toLowerCase().includes(search.trim().toLowerCase())
  const hosts = new Map(visibleInstances(s).map((i) => [i.key, i]))
  const workspaces = (s.settings?.workspaces ?? []).filter((w) => matches(w.name))
  const views = (s.settings?.hostViews ?? []).filter((v) => matches(v.name))
  const forwards = (s.settings?.portForwards ?? []).filter((p) => matches(p.name))
  const links = (s.settings?.quicklinks ?? []).filter((l) => matches(`${l.name} ${l.keyword}`))
  const openLink = (link: Quicklink, text = ''): void => {
    const url = quicklinkUrl(link, text)
    if (link.space === EXTERNAL || !hasBrowser()) void window.api.invoke('shell:open', url).catch((e: Error) => s.toast('error', e.message))
    else s.openBrowser({ url, space: link.space })
    setQueryFor(null)
  }
  const settings = (section: string): void => {
    try { localStorage.setItem('ui.settingsSection', section) } catch { /* storage unavailable */ }
    s.set({ settingsOpen: true })
  }
  return <div className="ws-saved">
    <div className="ws-saved-top"><input className="input" type="search" aria-label="Search saved work" placeholder="Find a workspace, view, tunnel or quicklink…" value={search} onChange={(e) => setSearch(e.target.value)} />
      <button className="btn btn-sm" disabled={!s.tabs.some((t) => !t.transient)} onClick={() => s.set({ workspaceSaveOpen: true })}><Icon.plus />Save workspace</button>
    </div>
    {queryFor && <form className="ws-link-query" onSubmit={(e) => { e.preventDefault(); if (query.trim()) openLink(queryFor, query.trim()) }}>
      <label htmlFor="workspace-link-query">Search {queryFor.name}</label><input id="workspace-link-query" className="input" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} />
      <button className="btn btn-primary btn-sm" disabled={!query.trim()}>Open</button><button type="button" className="btn btn-sm" onClick={() => setQueryFor(null)}>Cancel</button>
    </form>}
    <div className="ws-saved-grid">
      <section><h3><Icon.grid />Workspaces <span>{workspaces.length}</span></h3>
        {workspaces.map((w) => {
          const unavailable = w.tabs.filter((t) => !hosts.has(t.instanceKey)).length
          return <button className="ws-saved-item" key={w.id} disabled={!!s.openingWorkspace || unavailable === workspaceSize(w)} title={`${workspaceSummary(w)}${unavailable ? ' · Unavailable hosts will be skipped' : ''}`} onClick={() => void s.openWorkspace(w.id)}><strong>{w.name}</strong><small>{workspaceSummary(w)}{unavailable ? ` · ${unavailable} unavailable` : ''}</small></button>
        })}
        {!workspaces.length && <p>Save your terminals, browser pages, notes, and remote sessions as a project workspace.</p>}
      </section>
      <section><h3><Icon.layers />Host views <span>{views.length}</span></h3>
        {views.map((v) => <button className="ws-saved-item" key={v.id} onClick={() => s.applyHostView(v.filters)}><strong>{v.name}</strong><small>{[v.filters.profileFilter, v.filters.search, v.filters.favoritesOnly && 'Favorites'].filter(Boolean).join(' · ') || 'Saved inventory filters'}</small></button>)}
        {!views.length && <p>Choose inventory filters below, then select Save view.</p>}
      </section>
      <section><h3><Icon.plug />Port forwards <span>{forwards.length}</span></h3>
        {forwards.map((p) => <button className="ws-saved-item" key={p.id} disabled={!hosts.has(p.instanceKey)} onClick={() => s.set({ portForwardFor: { key: p.instanceKey, presetId: p.id } })}><strong>{p.name}</strong><small>{hosts.get(p.instanceKey)?.name ?? 'Host unavailable'} · port {p.remotePort}</small></button>)}
        {!forwards.length && <p>Save a port forward from a host’s connection options.</p>}
      </section>
      <section><h3><Icon.globe />Quicklinks <span>{links.length}</span><button className="ws-text-action" onClick={() => settings('launcher')}>Manage</button></h3>
        {links.map((l) => <button className="ws-saved-item" key={l.id} onClick={() => takesQuery(l) ? (setQueryFor(l), setQuery('')) : openLink(l)}><strong>{l.name}</strong><small>{l.keyword ? `${l.keyword} · ` : ''}{takesQuery(l) ? 'Enter a search' : l.space === EXTERNAL ? 'Default browser' : 'Browser space'}</small></button>)}
        {!links.length && <p>Keep consoles, tickets and runbooks one click away.</p>}
      </section>
    </div>
    {!workspaces.length && !views.length && !forwards.length && !links.length && search && <p role="status" className="ws-no-results">No saved work matches “{search}”.</p>}
  </div>
}

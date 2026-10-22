import { useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { clearHostFilters } from '@shared/hostSearch'
import { captureHostFilters, sameHostFilters, type HostView, type HostViewFilters } from '@shared/hostViews'
import { useStore } from '../store'
import Modal from './Modal'
import { Icon } from './icons'

const BUILT_INS: { name: string; filters: HostViewFilters }[] = [
  { name: 'All hosts', filters: { ...clearHostFilters } },
  { name: 'Running', filters: { ...clearHostFilters, stateFilter: 'running' } },
  { name: 'Favorites', filters: { ...clearHostFilters, favoritesOnly: true } }
]

function describe(filters: HostViewFilters): string {
  return [filters.search && `“${filters.search}”`, filters.profileFilter, filters.favoritesOnly && 'Favorites',
    filters.osFilter !== 'all' && filters.osFilter, filters.stateFilter !== 'all' && filters.stateFilter,
    filters.reachFilter !== 'all' && (filters.reachFilter === 'reachable' ? 'Route available' : 'No automatic route')]
    .filter(Boolean).join(' · ') || 'All hosts, across every enabled account'
}

export default function SavedHostViews(): ReactElement {
  const s = useStore()
  const views = s.settings?.hostViews ?? []
  const [editor, setEditor] = useState<{ id?: string; filters: HostViewFilters } | null>(null)
  const [name, setName] = useState('')
  const [manage, setManage] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const edit = (view?: HostView): void => {
    setManage(false)
    setError('')
    setName(view?.name ?? '')
    setEditor({ id: view?.id, filters: captureHostFilters(view?.filters ?? s) })
  }
  const close = (): void => { if (!busy) { setEditor(null); setManage(false); setError('') } }
  const save = async (): Promise<void> => {
    if (!editor || busy) return
    setBusy(true)
    setError('')
    try {
      await s.saveHostView(name, editor.id, editor.filters)
      setEditor(null)
      s.toast('success', editor.id ? 'View renamed' : 'View saved')
    } catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }
  const remove = async (id: string): Promise<void> => {
    setBusy(true)
    setError('')
    try { await s.deleteHostView(id) }
    catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }
  return <>
    <nav className="host-views" aria-label="Host views">
      <div className="host-views-scroll">
        {BUILT_INS.map((v) => <button key={v.name} className={`host-view ${sameHostFilters(s, v.filters) ? 'on' : ''}`} aria-pressed={sameHostFilters(s, v.filters)} aria-label={`View: ${v.name}`} onClick={() => s.applyHostView(v.filters)}>{v.name === 'Favorites' && <Icon.star />}{v.name}</button>)}
        {views.length > 0 && <span className="host-view-divider" />}
        {views.map((v) => <button key={v.id} className={`host-view saved ${sameHostFilters(s, v.filters) ? 'on' : ''}`} aria-pressed={sameHostFilters(s, v.filters)} aria-label={`View: ${v.name}`} title={describe(v.filters)} onClick={() => s.applyHostView(v.filters)}><Icon.layers /><span>{v.name}</span></button>)}
      </div>
      <button className="btn btn-ghost" onClick={() => edit()}><Icon.plus /> Save view</button>
      {views.length > 0 && <button className="btn btn-ghost btn-icon" aria-label="Manage saved views" title="Manage saved views" onClick={() => { setError(''); setManage(true) }}><Icon.more /></button>}
    </nav>
    {editor && createPortal(<Modal title={editor.id ? 'Rename saved view' : 'Save current view'} onClose={close}>
      <form onSubmit={(e) => { e.preventDefault(); void save() }}>
        <p className="text-2 mb-4 text-xs">Keep this combination of search and filters one click away. Views are also available in ⌘K.</p>
        <label className="block text-xs font-medium" htmlFor="host-view-name">View name</label>
        <input id="host-view-name" className="input mt-2" autoFocus maxLength={60} placeholder="e.g. Production Linux" value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
        <div className="view-filter-summary"><span className="section-title">Included filters</span><p>{describe(editor.filters)}</p></div>
        {error && <p role="alert" className="mt-3 text-xs text-[var(--err)]">{error}</p>}
        <div className="mt-5 flex justify-end gap-2"><button type="button" className="btn" disabled={busy} onClick={close}>Cancel</button><button className="btn btn-primary" disabled={busy || !name.trim()}>{busy ? 'Saving…' : editor.id ? 'Save name' : 'Save view'}</button></div>
      </form>
    </Modal>, document.body)}
    {manage && createPortal(<Modal title="Manage saved views" onClose={close}>
      <p className="text-2 mb-4 text-xs">Rename a view or remove it. Removing a view keeps all hosts and connections.</p>
      <div className="saved-view-list">
        {views.map((v) => <div key={v.id} className="saved-view-row"><div className="min-w-0 flex-1"><strong>{v.name}</strong><p>{describe(v.filters)}</p></div><button className="btn btn-sm" disabled={busy} aria-label={`Rename ${v.name}`} onClick={() => edit(v)}>Rename</button><button className="btn btn-ghost btn-sm" disabled={busy} aria-label={`Delete ${v.name}`} onClick={() => void remove(v.id)}><Icon.x /></button></div>)}
        {!views.length && <p className="muted py-4 text-xs">No saved views. Use Save view to keep your current filters.</p>}
      </div>
      {error && <p role="alert" className="mt-3 text-xs text-[var(--err)]">{error}</p>}
    </Modal>, document.body)}
  </>
}

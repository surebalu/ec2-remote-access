import type { ReactElement } from 'react'
import { useStore, type OsFilter, type StateFilter, type ReachFilter } from '../store'
import { metaFor } from '../colors'

export default function HostFilters(): ReactElement {
  const s = useStore()
  const active = s.search || s.profileFilter || s.favoritesOnly || s.osFilter !== 'all' || s.stateFilter !== 'all' || s.reachFilter !== 'all'
  return <div className="flex flex-wrap items-center gap-2 px-4 pb-3 text-xs">
    <label className="flex items-center gap-1.5 text-2">OS
      <select className="input !w-auto" value={s.osFilter} onChange={(e) => s.set({ osFilter: e.target.value as OsFilter })}>
        <option value="all">All systems</option><option value="linux">Linux</option><option value="windows">Windows</option>
      </select>
    </label>
    <label className="flex items-center gap-1.5 text-2">State
      <select className="input !w-auto" value={s.stateFilter} onChange={(e) => s.set({ stateFilter: e.target.value as StateFilter })}>
        <option value="all">Any state</option><option value="running">Running</option>
      </select>
    </label>
    <label className="flex items-center gap-1.5 text-2">Route
      <select className="input !w-auto" value={s.reachFilter} onChange={(e) => s.set({ reachFilter: e.target.value as ReachFilter })}>
        <option value="all">All routes</option><option value="reachable">Route available</option><option value="unreachable">No automatic route</option>
      </select>
    </label>
    {s.profileFilter && <button className="filter-chip" onClick={() => s.set({ profileFilter: null })} title="Remove account filter">{metaFor(s.profileFilter, s.settings).label} ×</button>}
    {s.favoritesOnly && <button className="filter-chip" onClick={() => s.set({ favoritesOnly: false })}>Favorites ×</button>}
    {s.search && <button className="filter-chip max-w-48 truncate" onClick={() => s.set({ search: '' })} title="Clear search">“{s.search}” ×</button>}
    {active && <button className="btn btn-ghost btn-sm" onClick={s.clearFilters}>Clear filters</button>}
  </div>
}

export function ScanNotice(): ReactElement | null {
  const s = useStore()
  if (!s.scanErrors.length) return null
  const stale = s.instances.filter((i) => i.staleReason).length
  return <div className="scan-notice mx-4 mb-3 rounded-lg border px-3 py-2 text-xs" role="status">
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-medium">Inventory refresh incomplete</span>
      <span className="text-2">{stale ? `${stale} host${stale === 1 ? '' : 's'} shown from the last successful scan.` : 'Some accounts or regions could not be scanned.'}</span>
      <button className="btn btn-sm ml-auto" disabled={s.scanning} onClick={() => void s.retryFailedScans()}>{s.scanning ? 'Scanning…' : 'Retry failed scans'}</button>
    </div>
    <details className="mt-1 text-2">
      <summary className="cursor-pointer">View {s.scanErrors.length} scan error{s.scanErrors.length === 1 ? '' : 's'}</summary>
      <ul className="mt-2 max-h-36 space-y-2 overflow-auto select-text">
        {s.scanErrors.map((e, n) => <li key={`${e.profile}/${e.region}/${n}`}><strong>{e.profile} · {e.allRegions ? 'All regions' : e.region}</strong><p className="break-words">{e.message}</p></li>)}
      </ul>
    </details>
  </div>
}

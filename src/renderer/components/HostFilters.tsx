import { useRef, useState, type ReactElement } from 'react'
import { useStore, type OsFilter, type StateFilter, type ReachFilter } from '../store'
import { metaFor } from '../colors'
import Popover, { MenuItem } from './Popover'
import { Icon } from './icons'

/** A compact "Label: value ▾" button with a menu of values; highlighted while it narrows the list. */
function FilterChip<T extends string>({ label, value, options, fallback, onChange }: {
  label: string
  value: T
  options: [T, string][]
  /** The value that means "no filter". */
  fallback: T
  onChange: (v: T) => void
}): ReactElement {
  const btn = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const current = options.find(([v]) => v === value)?.[1] ?? value
  return (
    <>
      <button ref={btn} type="button" className={`filter-chip ${value !== fallback ? 'active' : ''}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="muted">{label}</span> {current} <Icon.caret />
      </button>
      {open && (
        <Popover anchor={btn.current} onClose={() => setOpen(false)}>
          {options.map(([v, l]) => (
            <MenuItem key={v} on={v === value} onClick={() => { onChange(v); setOpen(false) }}>{l}</MenuItem>
          ))}
        </Popover>
      )}
    </>
  )
}

export default function HostFilters(): ReactElement {
  const s = useStore()
  const active = s.search || s.profileFilter || s.favoritesOnly || s.osFilter !== 'all' || s.stateFilter !== 'all' || s.reachFilter !== 'all'
  return <div className="flex flex-wrap items-center gap-1.5 text-xs">
    <FilterChip<OsFilter> label="OS" value={s.osFilter} fallback="all" onChange={(v) => s.set({ osFilter: v })}
      options={[['all', 'Any'], ['linux', 'Linux'], ['windows', 'Windows']]} />
    <FilterChip<StateFilter> label="State" value={s.stateFilter} fallback="all" onChange={(v) => s.set({ stateFilter: v })}
      options={[['all', 'Any'], ['running', 'Running']]} />
    <FilterChip<ReachFilter> label="Route" value={s.reachFilter} fallback="all" onChange={(v) => s.set({ reachFilter: v })}
      options={[['all', 'Any'], ['reachable', 'Available'], ['unreachable', 'No automatic route']]} />
    {s.profileFilter && <button className="filter-chip active" onClick={() => s.set({ profileFilter: null })} title="Remove account filter">{metaFor(s.profileFilter, s.settings).label} <Icon.x /></button>}
    {s.favoritesOnly && <button className="filter-chip active" onClick={() => s.set({ favoritesOnly: false })}>Favorites <Icon.x /></button>}
    {active && <button className="btn btn-ghost btn-sm" onClick={s.clearFilters}>Clear filters</button>}
  </div>
}

export function ScanNotice(): ReactElement | null {
  const s = useStore()
  const [open, setOpen] = useState(false)
  if (!s.scanErrors.length) return null
  const stale = s.instances.filter((i) => i.staleReason).length
  const n = s.scanErrors.length
  return <div className="scan-notice mx-4 mb-2 rounded-lg border px-3 py-1.5 text-xs" role="status">
    <div className="flex flex-wrap items-center gap-2">
      <Icon.alert className="shrink-0" />
      <span className="font-medium">Inventory refresh incomplete.</span>
      <span className="text-2">{stale ? `${stale} host${stale === 1 ? '' : 's'} shown from the last successful scan.` : 'Some accounts or regions could not be scanned.'}</span>
      <button className="text-2 underline" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide' : 'View'} {n} error{n === 1 ? '' : 's'}</button>
      <button className="btn btn-sm ml-auto" disabled={s.scanning} onClick={() => void s.retryFailedScans()}>{s.scanning ? 'Scanning…' : 'Retry failed scans'}</button>
    </div>
    {open && (
      <ul className="text-2 mt-2 max-h-36 space-y-2 overflow-auto select-text">
        {s.scanErrors.map((e, i) => <li key={`${e.profile}/${e.region}/${i}`}><strong>{e.profile} · {e.allRegions ? 'All regions' : e.region}</strong><p className="break-words">{e.message}</p></li>)}
      </ul>
    )}
  </div>
}

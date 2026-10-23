import { useEffect, useRef, useState, type ReactElement } from 'react'
import { bytes, plural, type MapNode } from '@shared/storage'
import { Icon } from '../icons'
import { useLocal } from '../plan/parts'
import { ItemMenu, ItemRow, modified, NeedsScan, NodeIcon, RoomHead, tilde, TrashBar, useNodeIcons, useScanTree, useTicks } from './parts'
import { openInMap } from './state'

/**
 * Search: names in the last scan (folders, and files of 1 MB or more, which the scan keeps by name), filtered by size,
 * sorted by size, name or date. Presets look for kinds of file at once; a search can be kept under Saved Searches.
 */

const PRESETS: { label: string; query: string; icon: () => ReactElement }[] = [
  { label: 'Videos', query: '.mp4 .mov .m4v .mkv .avi .webm .mts', icon: () => <Icon.play /> },
  { label: 'Pictures', query: '.jpg .jpeg .png .heic .psd .tif .tiff .raw .dng', icon: () => <Icon.palette /> },
  { label: 'Documents', query: '.pdf .docx .doc .pages .key .pptx .xlsx .numbers', icon: () => <Icon.note /> },
  { label: 'Archives', query: '.zip .rar .7z .tar .gz .tgz .xz', icon: () => <Icon.archive /> },
  { label: 'Installers', query: '.dmg .pkg .iso .xip .ipsw', icon: () => <Icon.download /> },
  { label: 'Developer', query: '"node_modules" "deriveddata" ".build" "target" .log', icon: () => <Icon.code /> }
]
const MINS = [0, 10e6, 100e6, 1e9]

function useSaved(): [string[], (q: string) => void, (q: string) => void] {
  const [list, setList] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem('storage.savedSearches') ?? '[]') as string[] } catch { return [] } })
  const save = (next: string[]): void => { setList(next); try { localStorage.setItem('storage.savedSearches', JSON.stringify(next)) } catch { /* private window */ } }
  return [list, (q) => save([q, ...list.filter((x) => x !== q)].slice(0, 20)), (q) => save(list.filter((x) => x !== q))]
}

export default function SearchRoom({ active }: { active: boolean }): ReactElement {
  const { live, version } = useScanTree()
  const [query, setQuery] = useState('')
  const [min, setMin] = useLocal<string>('storage.searchMin', '0')
  const [sort, setSort] = useLocal<'size' | 'name' | 'date'>('storage.searchSort', 'size')
  const [hits, setHits] = useState<MapNode[] | null>(null)
  const [saved, save, unsave] = useSaved()
  const [menu, setMenu] = useState<{ node: MapNode; anchor: HTMLElement } | null>(null)
  const [ticks, tick, setTicks] = useTicks(`${query}:${version}`, () => [])
  const input = useRef<HTMLInputElement>(null)
  const icons = useNodeIcons(hits ?? [])

  useEffect(() => { if (active) setTimeout(() => input.current?.focus(), 0) }, [active])
  useEffect(() => {
    if (!live || !query.trim()) { setHits(null); return }
    let on = true
    const t = setTimeout(() => {
      window.api.invoke('storage:search', query, Number(min), sort).then((h) => { if (on) setHits(h) }, () => { if (on) setHits([]) })
    }, 180)
    return () => { on = false; clearTimeout(t) }
  }, [live, version, query, min, sort])

  if (!live) return <div className="plan-scroll st-scroll"><RoomHead icon={<Icon.search />} title="Search" sub="Find files and folders by name, extension or kind." /><NeedsScan what="what to search" /></div>
  const picked = (hits ?? []).filter((h) => ticks.has(h.path))
  return (
    <div className="st-list-room">
      <RoomHead icon={<Icon.search />} title="Search" sub={hits ? `${plural(hits.length, 'match', 'matches')}${hits.length >= 400 ? ', the first 400' : ''}` : 'Folders, and files of 1 MB or more, are searched by name.'} />
      <div className="st-toolbar">
        <label className="links-search st-search">
          <Icon.search />
          <input ref={input} value={query} placeholder="Search files and folders, or type extensions (.mp4 .dmg)" aria-label="Search the scan" onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setQuery('') }} />
        </label>
        <select className="input st-select" value={min} aria-label="At least" onChange={(e) => setMin(e.target.value)}>
          {MINS.map((m) => <option key={m} value={String(m)}>{m ? `${bytes(m)} or more` : 'Any size'}</option>)}
        </select>
        <select className="input st-select" value={sort} aria-label="Order" onChange={(e) => setSort(e.target.value as 'size' | 'name' | 'date')}>
          <option value="size">Largest first</option><option value="date">Newest first</option><option value="name">By name</option>
        </select>
        {query.trim() && !saved.includes(query.trim()) && <button type="button" className="btn btn-sm" onClick={() => save(query.trim())}><Icon.star />Save search</button>}
      </div>
      <div className="st-chips">
        {PRESETS.map((p) => <button key={p.label} type="button" className={`st-chip ${query === p.query ? 'on' : ''}`} title={p.query} onClick={() => setQuery(p.query)}>{p.icon()}{p.label}</button>)}
        {saved.map((q) => (
          <span key={q} className={`st-chip saved ${query === q ? 'on' : ''}`}>
            <button type="button" onClick={() => setQuery(q)} title="Saved search"><Icon.star />{q}</button>
            <button type="button" className="st-chip-x" aria-label={`Remove ${q} from Saved Searches`} onClick={() => unsave(q)}><Icon.x /></button>
          </span>
        ))}
      </div>
      <div className="plan-scroll st-list">
        {!hits && <div className="st-empty"><p>Start typing to search the scan, or pick a kind above.</p></div>}
        {hits && !hits.length && <div className="st-empty"><p>Nothing by that name in the last scan.</p><p className="muted">Folders, and files of 1 MB or more, are listed by name. Smaller files were counted together, without their names.</p></div>}
        {hits?.map((h) => (
          <ItemRow key={h.id} checked={ticks.has(h.path)} onCheck={(on) => tick(h.path, on)} icon={<NodeIcon node={h} icons={icons} />}
            title={h.name} sub={<span title={h.path}>{tilde(h.path.replace(/\/[^/]+$/, '')) || '/'}</span>} note={h.dir ? plural(h.files, 'file') : modified(h.mtime)} size={h.size}
            onOpen={() => (h.dir ? openInMap(h.path) : void window.api.invoke('local:quickLook', h.path))} onMenu={(anchor) => setMenu({ node: h, anchor })} />
        ))}
      </div>
      {hits && hits.length > 0 && (
        <div className="st-selectline">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setTicks(picked.length === hits.length ? [] : hits.map((h) => h.path))}>{picked.length === hits.length ? 'Select none' : 'Select all'}</button>
        </div>
      )}
      <TrashBar items={picked.map((h) => ({ path: h.path, size: h.size, dir: h.dir }))} from="Search" onDone={() => setTicks([])} />
      {menu && <ItemMenu node={menu.node} anchor={menu.anchor} from="Search" onClose={() => setMenu(null)} />}
    </div>
  )
}

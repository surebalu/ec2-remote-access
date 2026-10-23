import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { bytes, plural, type MapNode } from '@shared/storage'
import { Icon } from '../icons'
import { changed, ItemMenu, NeedsScan, NodeIcon, Row, Segmented, TopBar, TrashFooter, useNodeIcons, useScanTree, useTicks, where } from './parts'
import { openInMap, useStorage } from './state'

/**
 * Search: names in the last scan (folders, and files of 1 MB or more, which the scan keeps by name), narrowed by kind
 * and size and sorted by size, date or name. With nothing typed: searches to try, saved searches, and kinds of file.
 */

type Tab = 'all' | 'files' | 'folders' | 'documents' | 'images' | 'videos' | 'audio' | 'archives' | 'apps' | 'other'
const TABS: { id: Tab; label: string; query?: string }[] = [
  { id: 'all', label: 'All' }, { id: 'files', label: 'Files' }, { id: 'folders', label: 'Folders' },
  { id: 'documents', label: 'Documents', query: '.pdf .docx .doc .pages .key .pptx .xlsx .numbers .txt .md' },
  { id: 'images', label: 'Images', query: '.jpg .jpeg .png .heic .gif .psd .tif .tiff .raw .dng .webp' },
  { id: 'videos', label: 'Videos', query: '.mp4 .mov .m4v .mkv .avi .webm .mts' },
  { id: 'audio', label: 'Audio', query: '.mp3 .m4a .wav .aiff .flac .aac' },
  { id: 'archives', label: 'Archives', query: '.zip .rar .7z .tar .gz .tgz .xz .dmg .pkg .iso' },
  { id: 'apps', label: 'Applications', query: '.app' },
  { id: 'other', label: 'Other' }
]
const TRY = ['.mp4', '.mov', '.dmg', '.zip', '.pkg', 'node_modules', 'Screen Recording', 'cache', 'backup']
const QUICK: { title: string; sub: string; query: string; color: string; icon: () => ReactElement }[] = [
  { title: 'Video Files', sub: 'Find .mp4, .mov and more', query: '.mp4 .mov .m4v .mkv .avi .webm .mts', color: '#6366f1', icon: () => <Icon.play /> },
  { title: 'Images', sub: 'Find .jpg, .png and more', query: '.jpg .jpeg .png .heic .psd .tif .raw .dng', color: '#22c55e', icon: () => <Icon.palette /> },
  { title: 'Documents', sub: 'Find .pdf, .docx and more', query: '.pdf .docx .doc .pages .key .pptx .xlsx', color: '#ef4444', icon: () => <Icon.note /> },
  { title: 'Archives', sub: 'Find .zip, .rar and more', query: '.zip .rar .7z .tar .gz .tgz .xz', color: '#8b5cf6', icon: () => <Icon.archive /> },
  { title: 'Installers', sub: 'Find .dmg, .pkg and more', query: '.dmg .pkg .iso .xip .ipsw', color: '#f59e0b', icon: () => <Icon.download /> },
  { title: 'Developer Files', sub: 'Find node_modules, .log and more', query: '"node_modules" "deriveddata" ".build" "target" .log', color: '#64748b', icon: () => <Icon.code /> }
]
const SIZES = [0, 10e6, 100e6, 1e9]

function useSaved(): [string[], (q: string) => void, (q: string) => void] {
  const [list, setList] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem('storage.savedSearches') ?? '[]') as string[] } catch { return [] } })
  const save = (next: string[]): void => { setList(next); try { localStorage.setItem('storage.savedSearches', JSON.stringify(next)) } catch { /* private window */ } }
  return [list, (q) => save([q, ...list.filter((x) => x !== q)].slice(0, 20)), (q) => save(list.filter((x) => x !== q))]
}

const fits = (tab: Tab, n: MapNode): boolean => {
  if (tab === 'files') return !n.dir
  if (tab === 'folders') return n.dir && !n.package
  if (tab === 'apps') return n.path.endsWith('.app')
  if (tab === 'documents') return n.kind === 'document'
  if (tab === 'images') return n.kind === 'image'
  if (tab === 'videos') return n.kind === 'video'
  if (tab === 'audio') return n.kind === 'audio'
  if (tab === 'archives') return n.kind === 'archive' || n.kind === 'diskimage'
  if (tab === 'other') return !n.dir && (n.kind === 'other' || n.kind === 'developer')
  return true
}

export default function SearchRoom({ active }: { active: boolean }): ReactElement {
  const { live, version } = useScanTree()
  const request = useStorage((s) => s.searchRequest)
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<Tab>('all')
  const [min, setMin] = useState(0)
  const [sort, setSort] = useState<'size' | 'name' | 'date'>('size')
  const [hits, setHits] = useState<MapNode[] | null>(null)
  const [saved, save, unsave] = useSaved()
  const [menu, setMenu] = useState<{ node: MapNode; anchor: HTMLElement } | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => { if (active) setTimeout(() => input.current?.focus(), 0) }, [active])
  useEffect(() => {
    if (!request) return
    useStorage.setState({ searchRequest: null })
    setQuery(request.query)
    setTab('all')
  }, [request?.nonce]) // eslint-disable-line react-hooks/exhaustive-deps
  // A kind's tab with nothing typed looks for that kind.
  const q = query.trim() || TABS.find((t) => t.id === tab)?.query || ''
  useEffect(() => {
    if (!live || !q) { setHits(null); return }
    let on = true
    const t = setTimeout(() => {
      window.api.invoke('storage:search', q, min, sort).then((h) => { if (on) setHits(h) }, () => { if (on) setHits([]) })
    }, 160)
    return () => { on = false; clearTimeout(t) }
  }, [live, version, q, min, sort])
  const shown = useMemo(() => (hits ?? []).filter((h) => fits(tab, h)), [hits, tab])
  const [ticks, tick, setTicks] = useTicks(`${q}:${tab}:${version}`, () => [])
  const icons = useNodeIcons(shown)
  const picked = shown.filter((h) => ticks.has(h.path))

  if (!live) return <div className="st-room"><TopBar title="Search" /><div className="st-scroll"><NeedsScan what="what to search" /></div></div>
  return (
    <div className="st-room">
      <TopBar title="Search" />
      <div className="st-search-head">
        <label className="st-searchbox big">
          <Icon.search />
          <input ref={input} value={query} placeholder="Search files, folders, or type a file extension (e.g. .mp4, .dmg, .zip)" aria-label="Search the scan" onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setQuery('') }} />
          {query && <button type="button" className="st-iconbtn" aria-label="Clear" onClick={() => setQuery('')}><Icon.x /></button>}
        </label>
        <div className="st-search-tabs">
          <Segmented value={tab} onChange={setTab} options={TABS.map((t) => ({ id: t.id, label: t.label }))} />
          <span className="flex-1" />
          <select className="st-select" value={min} aria-label="At least" onChange={(e) => setMin(Number(e.target.value))}>{SIZES.map((s) => <option key={s} value={s}>{s ? `${bytes(s)} or more` : 'Any size'}</option>)}</select>
          <select className="st-select" value={sort} aria-label="Order" onChange={(e) => setSort(e.target.value as 'size' | 'name' | 'date')}><option value="size">Largest first</option><option value="date">Newest first</option><option value="name">By name</option></select>
          {query.trim() && !saved.includes(query.trim()) && <button type="button" className="st-button" onClick={() => save(query.trim())}><Icon.bookmark />Save</button>}
        </div>
      </div>
      {!q ? (
        <div className="st-scroll">
          <section className="st-panel st-searchcard">
            <h3><Icon.search />Try a Search</h3>
            <div className="st-chips">{TRY.map((t) => <button key={t} type="button" className="st-chip" onClick={() => setQuery(t)}><Icon.search />{t}</button>)}</div>
          </section>
          <section className="st-panel st-searchcard">
            <h3><Icon.bookmark />Saved Searches</h3>
            {!saved.length && <p className="muted">Search for something, then choose Save beside the tabs to keep it here. Right-click one to remove it.</p>}
            <div className="st-chips">
              {saved.map((s, i) => (
                <button key={s} type="button" className="st-chip saved" style={{ '--chip': QUICK[i % QUICK.length].color } as CSSProperties} onClick={() => setQuery(s)} onContextMenu={(e) => { e.preventDefault(); unsave(s) }} title="Right-click to remove">
                  <span className="st-chip-sq">{QUICK[i % QUICK.length].icon()}</span>{s}
                </button>
              ))}
            </div>
          </section>
          <section className="st-panel st-searchcard">
            <h3><Icon.sparkles />Quick Access</h3>
            <div className="st-quick">
              {QUICK.map((k) => (
                <button key={k.title} type="button" className="st-quick-tile" style={{ '--chip': k.color } as CSSProperties} onClick={() => setQuery(k.query)}>
                  <span className="st-chip-sq lg">{k.icon()}</span><span><b>{k.title}</b><small>{k.sub}</small></span>
                </button>
              ))}
            </div>
          </section>
          <div className="st-empty">
            <span className="st-empty-art"><Icon.search /></span>
            <h3>Start typing to search your files</h3>
            <p>Search by name, extension, or file type to find exactly what you need.</p>
            <p className="muted">Folders, and files of 1 MB or more, are listed by name. Smaller files were counted into their folder.</p>
          </div>
        </div>
      ) : (
        <>
          <div className="st-listbar"><span className="st-listbar-text">{hits ? `${plural(shown.length, 'match', 'matches')}${hits.length >= 400 ? ', the first 400' : ''} · ${bytes(shown.reduce((s, h) => s + h.size, 0))}` : 'Searching…'}</span></div>
          <div className="st-list">
            {hits && !shown.length && <div className="st-empty"><h3>Nothing by that name</h3><p className="muted">Folders, and files of 1 MB or more, are listed by name. Smaller files were counted together, without their names.</p></div>}
            {shown.map((h) => (
              <Row key={h.id} checked={ticks.has(h.path)} onCheck={(on) => tick(h.path, on)} icon={<NodeIcon node={h} icons={icons} />}
                title={h.name} sub={`${where(h.path)}${h.dir ? ` · ${plural(h.files, 'file')}` : h.mtime ? ` · ${changed(h.mtime)}` : ''}`} size={h.size} reveal={h.path}
                onOpen={() => (h.dir ? openInMap(h.path) : void window.api.invoke('local:quickLook', h.path))} onMenu={(anchor) => setMenu({ node: h, anchor })} />
            ))}
          </div>
          <TrashFooter items={picked.map((h) => ({ path: h.path, size: h.size, dir: h.dir }))} from="Search" onDone={() => setTicks([])}
            links={[{ label: 'Select All', onClick: () => setTicks(shown.map((h) => h.path)), disabled: !shown.length }, { label: 'Select None', onClick: () => setTicks([]), disabled: !picked.length }]} />
        </>
      )}
      {menu && <ItemMenu node={menu.node} anchor={menu.anchor} from="Search" onClose={() => setMenu(null)} />}
    </div>
  )
}

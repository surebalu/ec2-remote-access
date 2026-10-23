import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { ago, bytes, KIND_NAMES, plural, type FileKind, type KindGroup, type MapView, type NestNode } from '@shared/storage'
import { squarify, type Rect } from '@shared/treemap'
import { useStore } from '../../store'
import { Icon } from '../icons'
import { setTabKeys } from '../../shortcuts'
import { DiskBar, ItemIcon, ItemMenu, NeedsScan, ScopePicker, Segmented, tilde, useIcons, useLoad, useScanTree } from './parts'
import { openSearch, trashItems, useStorage } from './state'

/**
 * Space Map: the scanned place as cards sized by the space they take, three levels deep (squarified treemaps inside
 * each other), with what did not fit as a "+N more" tile; or the apps, the folders alone, or the kinds of file. A
 * panel on the right shows the chosen item: its dates, its largest parts, Open in Finder. Double-click a card (or its
 * chevron) to go in; Back, ⌘[ or ⌫ to come out.
 */

type Mode = 'all' | 'apps' | 'folders' | 'types'
const PALETTE = ['#4ea8a1', '#e2766b', '#7c7fe2', '#5aa4d9', '#de6b5f', '#a68c2f', '#58ad6a', '#c97a3a', '#cf6d9c', '#9478dc']
const KIND_CARD: Record<FileKind | 'small', string> = {
  other: '#a08a35', developer: '#58ad6a', app: '#5aa4d9', archive: '#c97a3a', image: '#4ea8a1', diskimage: '#7c7fe2', video: '#9478dc', document: '#4f8fe0', audio: '#cf6d9c', small: '#2b303b'
}
const KIND_ICON: Partial<Record<FileKind | 'small', () => ReactElement>> = {
  developer: () => <Icon.code />, app: () => <Icon.apps />, archive: () => <Icon.archive />, image: () => <Icon.palette />, diskimage: () => <Icon.disk />, video: () => <Icon.play />, document: () => <Icon.note />, audio: () => <Icon.mic />, other: () => <Icon.note />, small: () => <Icon.layers />
}
const closedNote: Record<NonNullable<NestNode['closed']>, string> = {
  unreadable: 'macOS did not let the app read this folder, so what is in it was not counted.',
  protected: 'macOS keeps this closed to apps without Full Disk Access, so what is in it was not counted.',
  cloud: 'This folder is in the cloud. Reading it would download it, so it was not counted.',
  timeout: 'This folder did not answer in time, so it was skipped.',
  mount: 'Another drive or volume, not part of this scan.'
}

/** One card of the map: a node, or a "+N more" tile, or a kind of file. */
interface Card { key: string; name: string; size: number; sub?: string; color: string; icon?: ReactNode; node?: NestNode; children?: NestNode[]; rest?: { count: number; size: number }; kind?: FileKind | 'small'; more?: boolean; dark?: boolean }

export default function SpaceMap({ active }: { active: boolean }): ReactElement {
  const { live, version } = useScanTree()
  const scan = useStorage((s) => s.scan)
  const request = useStorage((s) => s.mapRequest)
  const [mode, setMode] = useState<Mode>('all')
  const [layout, setLayout] = useState<'cards' | 'list'>(() => { try { return (localStorage.getItem('storage.mapLayout') as 'cards' | 'list' | null) ?? 'cards' } catch { return 'cards' } })
  const [where, setWhere] = useState<{ id?: number; path?: string }>({})
  const [selected, setSelected] = useState<NestNode | null>(null)
  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState<{ node: NestNode; anchor: HTMLElement } | null>(null)
  const history = useRef<{ id?: number; path?: string; mode: Mode }[]>([])
  const pickLayout = (l: 'cards' | 'list'): void => { setLayout(l); try { localStorage.setItem('storage.mapLayout', l) } catch { /* private window */ } }

  useEffect(() => {
    if (!request) return
    useStorage.setState({ mapRequest: null })
    history.current = []
    setMode('all')
    setWhere({ path: request.path })
  }, [request?.nonce]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!request) { setWhere({}); history.current = [] } }, [scan.summary?.at]) // eslint-disable-line react-hooks/exhaustive-deps

  const ref = where.id !== undefined || where.path ? where : { path: scan.summary?.root }
  const nest = useLoad(() => (live && (mode === 'all' || mode === 'folders') ? window.api.invoke('storage:nest', ref, mode === 'folders') : Promise.resolve(null)), [live, version, mode, where.id, where.path])
  const apps = useLoad(() => (live && mode === 'apps' ? window.api.invoke('storage:appsMap') : Promise.resolve(null)), [live, version, mode])
  const kinds = useLoad<KindGroup[] | null>(() => (live && mode === 'types' ? window.api.invoke('storage:kinds') : Promise.resolve(null)), [live, version, mode])
  const list = useLoad<MapView | null>(() => (live && layout === 'list' && (mode === 'all' || mode === 'folders') ? window.api.invoke('storage:view', ref) : Promise.resolve(null)), [live, version, layout, mode, where.id, where.path])
  const root = nest.data?.node ?? null
  useEffect(() => { setSelected(null) }, [root?.id, mode])

  const go = (n: { id: number }, toMode: Mode = mode === 'apps' || mode === 'types' ? 'all' : mode): void => {
    history.current.push({ ...(root ? { id: root.id } : where), mode })
    setMode(toMode)
    setWhere({ id: n.id })
  }
  const back = (): void => {
    const prev = history.current.pop()
    if (prev) { setMode(prev.mode); setWhere(prev.id !== undefined ? { id: prev.id } : { path: prev.path }) }
    else { const up = nest.data?.chain.at(-1); if (up) setWhere({ id: up.id }) }
  }
  const up = (): void => { const parent = nest.data?.chain.at(-1); if (parent) { history.current.push({ id: root?.id, mode }); setWhere({ id: parent.id }) } }
  const open = (n: NestNode): void => {
    if (n.dir && !n.closed && (n.more || n.children?.length)) go(n)
    else if (!n.dir) void window.api.invoke('local:quickLook', n.path)
  }

  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined)
  keyRef.current = (e) => {
    const t = e.target as HTMLElement | null
    if ((t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) || document.querySelector('.modal-backdrop')) return
    if (e.metaKey && e.key === 'Backspace' && selected) { e.preventDefault(); void trashItems([{ path: selected.path, size: selected.size, dir: selected.dir }], 'Space Map') }
    else if ((e.metaKey && e.key === 'ArrowUp') || (!e.metaKey && e.key === 'Backspace')) { e.preventDefault(); up() }
    else if (e.key === 'Enter' && selected) { e.preventDefault(); open(selected) }
    else if (e.key === ' ' && selected && !selected.dir) { e.preventDefault(); void window.api.invoke('local:quickLook', selected.path) }
    else if (e.key === 'Escape') setSelected(null)
  }
  useEffect(() => {
    if (!active) return
    const on = (e: KeyboardEvent): void => keyRef.current(e)
    document.addEventListener('keydown', on)
    setTabKeys('storage', (k) => { if (k.key === '[') { back(); return true } return false })
    return () => { document.removeEventListener('keydown', on); setTabKeys('storage', null) }
  }, [active]) // eslint-disable-line react-hooks/exhaustive-deps

  // The cards for the mode.
  const cards: Card[] = useMemo(() => {
    if (mode === 'apps' && apps.data) {
      const c: Card[] = apps.data.apps.map((a, i) => ({ key: String(a.id), name: a.name.replace(/\.app$/, ''), size: a.size, sub: `in ${a.path.split('/').slice(-2, -1)[0] ?? ''}`, color: PALETTE[i % PALETTE.length], node: a, children: a.children, rest: a.rest }))
      if (apps.data.rest.count) c.push({ key: 'rest', name: `+${apps.data.rest.count} more`, size: apps.data.rest.size, color: '#2b303b', more: true, dark: true })
      return c
    }
    if (mode === 'types' && kinds.data) {
      return kinds.data.map((k) => ({
        key: k.kind, name: k.kind === 'small' ? `${k.count.toLocaleString('en-US')} smaller files` : KIND_NAMES[k.kind], size: k.size, sub: k.kind === 'small' ? 'under 1 MB, counted with their folders' : plural(k.count, 'item'),
        color: KIND_CARD[k.kind], kind: k.kind, dark: k.kind === 'small', children: k.top, ...(k.count > k.top.length && k.kind !== 'small' ? { rest: { count: k.count - k.top.length, size: Math.max(0, k.size - k.top.reduce((s, t) => s + t.size, 0)) } } : {}),
        icon: KIND_ICON[k.kind]?.()
      }))
    }
    if (root) {
      const c: Card[] = (root.children ?? []).map((n, i) => ({ key: String(n.id), name: n.name, size: n.size, color: PALETTE[i % PALETTE.length], node: n, children: n.children, rest: n.rest, sub: n.dir ? undefined : n.kind ? KIND_NAMES[n.kind] : undefined }))
      if (root.rest) c.push({ key: 'rest', name: `+${root.rest.count.toLocaleString('en-US')} more`, size: root.rest.size, color: '#2b303b', more: true, dark: true })
      return c
    }
    return []
  }, [mode, apps.data, kinds.data, root])

  const appIcons = useIcons(mode === 'apps' ? (apps.data?.apps ?? []).map((a) => a.path) : [])
  const count = mode === 'apps' ? `${(apps.data?.count ?? 0).toLocaleString('en-US')} apps · ${bytes(apps.data?.total ?? 0)}` : mode === 'types' ? `${kinds.data?.length ?? 0} kinds · ${bytes(kinds.data?.reduce((s, k) => s + k.size, 0) ?? 0)}` : root ? `${plural(root.items, 'item')} · ${bytes(root.size)}` : ''
  const placeName = (name: string): string => (name === '/' ? useStorage.getState().disk?.name ?? 'Macintosh HD' : name.startsWith('/') ? tilde(name) : name)
  const searchKey = (e: ReactKeyboardEvent<HTMLInputElement>): void => { if (e.key === 'Enter' && query.trim()) openSearch(query.trim()) }

  if (!live) return <div className="st-room"><MapTop mode={mode} setMode={setMode} layout={layout} setLayout={pickLayout} query={query} setQuery={setQuery} onSearch={searchKey} back={back} canBack={false} /><div className="st-scroll"><NeedsScan what="where the space went" /></div></div>

  return (
    <div className="st-room">
      <MapTop mode={mode} setMode={(m) => { history.current = []; setMode(m); if (m === 'all' || m === 'folders') setWhere({}) }} layout={layout} setLayout={pickLayout} query={query} setQuery={setQuery} onSearch={searchKey} back={back} canBack={history.current.length > 0 || !!nest.data?.chain.length} />
      <div className="st-map-wrap">
        <div className="st-map-col">
          <section className="st-panel st-map-disk">
            <span className="st-hd"><Icon.disk /></span>
            <div className="st-map-disk-num"><b>{bytes((useStorage.getState().disk?.total ?? 0) - (useStorage.getState().disk?.free ?? 0))}</b><span>of {bytes(useStorage.getState().disk?.total ?? 0)} used</span></div>
            <DiskBar compact />
          </section>
          <div className="st-crumbs">
            {mode === 'all' || mode === 'folders' ? (
              <>
                {nest.data?.chain.map((c) => <span key={c.id}><button type="button" onClick={() => { history.current.push({ id: root?.id, mode }); setWhere({ id: c.id }) }}>{placeName(c.name)}</button><Icon.chevron /></span>)}
                <b>{root ? placeName(root.name) : ''}</b>
                {mode === 'folders' && <><Icon.chevron /><b className="accent">Folders</b></>}
              </>
            ) : <><span><button type="button" onClick={() => { setMode('all'); setWhere({}) }}>{placeName(scan.summary?.root ?? '/')}</button><Icon.chevron /></span><b className="accent">{mode === 'apps' ? 'Applications' : 'File Types'}</b></>}
            <span className="flex-1" />
            <span className="muted">{count}</span>
          </div>
          {(nest.error || apps.error || kinds.error) && <div className="plan-error"><Icon.alert />{nest.error ?? apps.error ?? kinds.error}</div>}
          {layout === 'list' && (mode === 'all' || mode === 'folders')
            ? <MapList view={list.data} onOpen={(id) => go({ id })} onSelect={(n) => setSelected(n)} selected={selected} />
            : <Cards cards={cards} appIcons={appIcons} selected={selected} onSelect={setSelected} onOpen={(n) => open(n)}
              onCard={(c) => { if (c.node) open(c.node); else if (c.kind && c.kind !== 'small') openSearch(KIND_QUERY[c.kind] ?? '') ; else if (c.more) pickLayout('list') }}
              onMenu={(n, anchor) => { setSelected(n); setMenu({ node: n, anchor }) }} />}
        </div>
        <Inspector node={selected ?? root} root={!selected} onOpen={(n) => go(n)} />
      </div>
      {menu && <ItemMenu node={menu.node} anchor={menu.anchor} from="Space Map" inMap onClose={() => setMenu(null)} />}
    </div>
  )
}

/** Searches for a kind of file, from the File Types view. */
const KIND_QUERY: Partial<Record<FileKind, string>> = {
  video: '.mp4 .mov .m4v .mkv .avi .webm', audio: '.mp3 .m4a .wav .aiff .flac', image: '.jpg .jpeg .png .heic .psd .tif .raw', document: '.pdf .docx .pages .key .pptx .xlsx',
  archive: '.zip .rar .7z .tar .gz .xz', diskimage: '.dmg .iso .img .sparseimage .vmdk', developer: '.json .sqlite .db .log .gguf .safetensors .pack', app: '.app'
}

function MapTop({ mode, setMode, layout, setLayout, query, setQuery, onSearch, back, canBack }: {
  mode: Mode; setMode: (m: Mode) => void; layout: 'cards' | 'list'; setLayout: (l: 'cards' | 'list') => void
  query: string; setQuery: (q: string) => void; onSearch: (e: ReactKeyboardEvent<HTMLInputElement>) => void; back: () => void; canBack: boolean
}): ReactElement {
  return (
    <header className="st-top">
      <button type="button" className="st-top-back" aria-label="Back" title="Back (⌘[)" disabled={!canBack} onClick={back}><Icon.back /></button>
      <h1>Space Map</h1>
      <span className="flex-1" />
      <Segmented value={mode} onChange={setMode} options={[{ id: 'all', label: 'All Items' }, { id: 'apps', label: 'Applications' }, { id: 'folders', label: 'Folders' }, { id: 'types', label: 'File Types' }]} />
      <span className="flex-1" />
      <label className="st-searchbox sm"><Icon.search /><input value={query} placeholder="Search files, folders or apps" aria-label="Search the scan" onChange={(e) => setQuery(e.target.value)} onKeyDown={onSearch} /></label>
      <Segmented value={layout} onChange={setLayout} options={[{ id: 'cards', label: <Icon.treemap />, title: 'Cards' }, { id: 'list', label: <Icon.list />, title: 'List' }]} />
      <ScopePicker />
    </header>
  )
}

/** Level-one cards with their children and grandchildren inside, laid out to fill the box. */
function Cards({ cards, appIcons, selected, onSelect, onOpen, onCard, onMenu }: {
  cards: Card[]; appIcons: Map<string, string>; selected: NestNode | null
  onSelect: (n: NestNode) => void; onOpen: (n: NestNode) => void; onCard: (c: Card) => void; onMenu: (n: NestNode, anchor: HTMLElement) => void
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const laid = useMemo(() => squarify(cards.map((c) => ({ value: c.size, c })), { x: 0, y: 0, w: box.w, h: box.h }), [cards, box.w, box.h])
  return (
    <div ref={ref} className="st-cards">
      {!cards.length && <div className="st-empty"><p>Nothing here takes any space.</p></div>}
      {laid.map(({ item: { c }, rect }) => (
        <div key={c.key} className={`st-card ${c.dark ? 'dark' : ''} ${c.more ? 'more' : ''} ${selected && c.node && selected.id === c.node.id ? 'selected' : ''}`}
          style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, '--card': c.color } as CSSProperties}
          onClick={(e) => { if (e.target === e.currentTarget || (e.target as HTMLElement).closest('.st-card-head')) { if (c.node) onSelect(c.node); else if (c.more) onCard(c) } }}
          onDoubleClick={(e) => { if ((e.target as HTMLElement).closest('.st-tile')) return; onCard(c) }}
          onContextMenu={(e) => { if (!c.node || (e.target as HTMLElement).closest('.st-tile')) return; e.preventDefault(); onMenu(c.node, e.currentTarget) }}>
          {rect.w > 60 && rect.h > 34 && (
            <div className="st-card-head">
              <span className="st-card-icon">{c.node && c.node.path.endsWith('.app') && appIcons.get(c.node.path) ? <img src={appIcons.get(c.node.path)} alt="" /> : c.icon ?? (c.more ? <Icon.plus /> : c.node?.dir ? <Icon.folder /> : <Icon.note />)}</span>
              <span className="st-card-text"><b>{c.name}</b><span>{bytes(c.size)}{c.sub ? ` · ${c.sub}` : ''}</span></span>
              {(c.node?.dir || c.kind) && !c.more && rect.w > 140 && <button type="button" className="st-card-go" aria-label={`Open ${c.name}`} onClick={(e) => { e.stopPropagation(); onCard(c) }}><Icon.chevron /></button>}
            </div>
          )}
          {(c.children?.length || c.rest) && rect.w > 90 && rect.h > 90 && (
            <Tiles items={c.children ?? []} rest={c.rest} box={{ x: 8, y: 52, w: rect.w - 16, h: rect.h - 60 }} depth={2} selected={selected} onSelect={onSelect} onOpen={onOpen} onMenu={onMenu} />
          )}
        </div>
      ))}
    </div>
  )
}

/** Children inside a card (and theirs inside them), with a dashed "+N more" for the rest. */
function Tiles({ items, rest, box, depth, selected, onSelect, onOpen, onMenu }: {
  items: NestNode[]; rest?: { count: number; size: number }; box: Rect; depth: number; selected: NestNode | null
  onSelect: (n: NestNode) => void; onOpen: (n: NestNode) => void; onMenu: (n: NestNode, anchor: HTMLElement) => void
}): ReactElement | null {
  if (box.w < 20 || box.h < 20) return null
  const entries: { value: number; n?: NestNode; rest?: boolean }[] = items.filter((n) => n.size > 0).map((n) => ({ value: n.size, n }))
  if (rest && rest.size > 0) entries.push({ value: rest.size, rest: true })
  const laid = squarify(entries, box)
  return (
    <>
      {laid.map(({ item, rect }, i) => {
        const big = rect.w > 64 && rect.h > 34
        if (item.rest) {
          return (
            <div key={`rest-${i}`} className="st-tile more" style={{ left: rect.x + 2, top: rect.y + 2, width: rect.w - 4, height: rect.h - 4 }} title={`${rest!.count.toLocaleString('en-US')} more · ${bytes(rest!.size)}`}>
              {big && <span className="st-tile-text"><b><Icon.plus />{rest!.count.toLocaleString('en-US')} more</b><span>{bytes(rest!.size)}</span></span>}
            </div>
          )
        }
        const n = item.n!
        const inner = depth < 3 && (n.children?.length || n.rest) && rect.w > 80 && rect.h > 70
        return (
          <div key={n.id} className={`st-tile d${depth} ${selected?.id === n.id ? 'selected' : ''} ${n.closed ? 'closed' : ''}`} style={{ left: rect.x + 2, top: rect.y + 2, width: rect.w - 4, height: rect.h - 4 }}
            title={`${n.name} · ${bytes(n.size)}${n.closed ? ` · ${closedNote[n.closed]}` : ''}`}
            onClick={(e) => { e.stopPropagation(); onSelect(n) }} onDoubleClick={(e) => { e.stopPropagation(); onOpen(n) }}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onMenu(n, e.currentTarget) }}>
            {big && <span className="st-tile-text"><b>{n.dir ? <Icon.folder /> : <Icon.note />}{n.name}</b><span>{bytes(n.size)}</span>{n.dir && rect.h > 52 && <span className="st-tile-items">{plural(n.items, 'item')}</span>}</span>}
            {inner && <Tiles items={n.children ?? []} rest={n.rest} box={{ x: 5, y: rect.h > 90 ? 50 : 30, w: rect.w - 14, h: rect.h - (rect.h > 90 ? 58 : 38) }} depth={depth + 1} selected={selected} onSelect={onSelect} onOpen={onOpen} onMenu={onMenu} />}
          </div>
        )
      })}
    </>
  )
}

function MapList({ view, onOpen, onSelect, selected }: { view: MapView | null; onOpen: (id: number) => void; onSelect: (n: NestNode) => void; selected: NestNode | null }): ReactElement {
  const icons = useIcons(view?.children.map((c) => c.path) ?? [])
  if (!view) return <div className="st-empty"><div className="st-spinner" /></div>
  const total = view.node.size || 1
  return (
    <div className="st-list">
      {view.children.map((n, i) => (
        <div key={n.id} className={`st-row ${selected?.id === n.id ? 'selected' : ''}`} onClick={() => onSelect({ ...n, items: n.files })} onDoubleClick={() => (n.dir && n.more && !n.closed ? onOpen(n.id) : void window.api.invoke('local:quickLook', n.path))}>
          <span className="st-row-tick" />
          <ItemIcon path={n.path} icons={icons} dir={n.dir && !n.package} />
          <div className="st-row-body"><div className="st-row-title"><span className="st-row-name">{n.name}</span>{n.closed && <span className="st-badge warn" title={closedNote[n.closed]}>not counted</span>}</div><div className="st-row-sub">{n.dir ? plural(n.files, 'file') : n.mtime ? `changed ${ago(n.mtime)}` : ''}</div></div>
          <span className="st-bar wide"><span style={{ width: `${(n.size / total) * 100}%`, background: PALETTE[i % PALETTE.length] }} /></span>
          <span className="st-pct">{Math.round((n.size / total) * 100)}%</span>
          <span className="st-size">{bytes(n.size)}</span>
        </div>
      ))}
      {view.small.bytes > 0 && (
        <div className="st-row disabled">
          <span className="st-row-tick" /><span className="st-icon st-icon-glyph"><Icon.layers /></span>
          <div className="st-row-body"><div className="st-row-title">Small files</div><div className="st-row-sub">{plural(view.small.files, 'file')} under 1 MB, counted together without their names</div></div>
          <span className="st-bar wide"><span style={{ width: `${(view.small.bytes / total) * 100}%` }} /></span>
          <span className="st-pct">{Math.round((view.small.bytes / total) * 100)}%</span>
          <span className="st-size">{bytes(view.small.bytes)}</span>
        </div>
      )}
    </div>
  )
}

/** The panel on the right: the chosen item (or the place) with its dates, its largest parts, and Open in Finder. */
function Inspector({ node, root, onOpen }: { node: NestNode | null; root: boolean; onOpen: (n: NestNode) => void }): ReactElement {
  const [tab, setTab] = useState<'overview' | 'files' | 'info'>('overview')
  const dates = useLoad(() => (node ? window.api.invoke('storage:dates', node.path) : Promise.resolve(null)), [node?.path])
  const kids = useLoad(() => (node?.dir && !node.closed ? window.api.invoke('storage:view', { id: node.id }) : Promise.resolve(null)), [node?.id])
  const icons = useIcons([node?.path, ...(kids.data?.children.slice(0, 40).map((c) => c.path) ?? [])])
  if (!node) return <aside className="st-inspector"><div className="st-empty"><p className="muted">Choose a card to see it here.</p></div></aside>
  const isVolume = node.path === '/'
  const kind = isVolume ? 'Volume' : node.path.endsWith('.app') ? 'Application' : node.package ? 'Package' : node.dir ? 'Folder' : node.kind ? KIND_NAMES[node.kind].replace(/s$/, '') : 'File'
  const date = (t?: number): string => (t ? new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : 'Unknown')
  const name = isVolume ? useStorage.getState().disk?.name ?? 'Macintosh HD' : node.name
  return (
    <aside className="st-inspector">
      <div className="st-insp-head">
        <ItemIcon path={isVolume ? undefined : node.path} icons={icons} dir={node.dir && !node.package} size={40} />
        <div><b title={node.path}>{name}</b><span>{bytes(node.size)}</span></div>
      </div>
      <Segmented value={tab} onChange={setTab} options={[{ id: 'overview', label: 'Overview' }, { id: 'files', label: 'Files' }, { id: 'info', label: 'Info' }]} />
      {tab === 'overview' && (
        <>
          <dl className="st-props">
            <div><dt>Kind</dt><dd>{kind}</dd></div>
            <div><dt>Size</dt><dd>{bytes(node.size)}</dd></div>
            {node.dir && <div><dt>Items</dt><dd>{(kids.data ? kids.data.node.files : node.items).toLocaleString('en-US')}</dd></div>}
            <div><dt>Created</dt><dd>{date(dates.data?.created)}</dd></div>
            <div><dt>Modified</dt><dd>{date(dates.data?.modified)}</dd></div>
            <div><dt>Last opened</dt><dd>{date(dates.data?.opened)}</dd></div>
          </dl>
          <div className="st-pathbox"><Icon.folder /><span title={node.path}>{tilde(node.path)}</span>
            <button type="button" className="st-iconbtn" aria-label="Copy the path" title="Copy the path" onClick={() => void window.api.invoke('clipboard:write', node.path).then(() => useStore.getState().toast('success', 'Path copied'))}><Icon.copy /></button>
          </div>
          {kids.data && kids.data.children.length > 0 && (
            <>
              <h4 className="st-insp-h">Top Items</h4>
              {kids.data.children.slice(0, 6).map((c) => (
                <button key={c.id} type="button" className="st-insp-item" onClick={() => (c.dir && c.more ? onOpen({ ...c, items: c.files }) : void window.api.invoke('local:quickLook', c.path))}>
                  <ItemIcon path={c.path} icons={icons} dir={c.dir && !c.package} size={18} /><span className="flex-1">{c.name}</span><span className="muted">{bytes(c.size)}</span><Icon.chevron />
                </button>
              ))}
            </>
          )}
        </>
      )}
      {tab === 'files' && (
        <div className="st-insp-files">
          {!kids.data && <p className="muted">{node.dir ? 'Reading…' : 'A single file.'}</p>}
          {kids.data?.children.slice(0, 40).map((c) => (
            <button key={c.id} type="button" className="st-insp-item" onClick={() => (c.dir && c.more ? onOpen({ ...c, items: c.files }) : void window.api.invoke('local:quickLook', c.path))}>
              <ItemIcon path={c.path} icons={icons} dir={c.dir && !c.package} size={18} /><span className="flex-1">{c.name}</span><span className="muted">{bytes(c.size)}</span>
            </button>
          ))}
          {kids.data && kids.data.small.bytes > 0 && <p className="muted st-insp-note">{plural(kids.data.small.files, 'file')} under 1 MB, {bytes(kids.data.small.bytes)}, counted together.</p>}
        </div>
      )}
      {tab === 'info' && (
        <dl className="st-props">
          <div><dt>Path</dt><dd className="wrap">{node.path}</dd></div>
          <div><dt>Kind</dt><dd>{kind}</dd></div>
          {node.closed && <div><dt>Note</dt><dd className="wrap">{closedNote[node.closed]}</dd></div>}
          {root && <div><dt>Scanned</dt><dd>{(() => { const s = useStorage.getState().scan.summary; return s ? `${ago(s.at)}, in ${Math.max(1, Math.round(s.took / 1000))} s` : '—' })()}</dd></div>}
        </dl>
      )}
      <span className="flex-1" />
      <button type="button" className="st-primary wide" onClick={() => void window.api.invoke('local:reveal', node.path)}><Icon.finder />Open in Finder</button>
    </aside>
  )
}

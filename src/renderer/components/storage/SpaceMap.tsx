import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { ago, bytes, plural, type MapNode, type MapView } from '@shared/storage'
import { squarify, type Rect } from '@shared/treemap'
import { Icon } from '../icons'
import { useLocal } from '../plan/parts'
import { setTabKeys } from '../../shortcuts'
import { ItemMenu, KIND_COLORS, NeedsScan, NodeIcon, RoomHead, ShareBar, tilde, useNodeIcons, useScanTree } from './parts'
import { trashItems, useStorage } from './state'

/**
 * Space Map: the scanned folder's contents as cards sized by the space they take (a squarified treemap, each folder's
 * card showing its own largest parts faintly), or as a list. Double-click a folder to go in; Back, ⌘↑ or ⌫ to come
 * out. Small files are one card, "Small files", since the scan counts them without their names.
 */

const SMALL = -1
const closedNote: Record<NonNullable<MapNode['closed']>, string> = {
  unreadable: 'macOS did not let the app read this folder, so what is in it was not counted.',
  protected: 'macOS keeps this closed to apps without Full Disk Access, so what is in it was not counted.',
  cloud: 'This folder is in the cloud. Reading it would download it, so it was not counted.',
  timeout: 'This folder did not answer in time, so it was skipped.',
  mount: 'Another drive or volume, not part of this scan.'
}

/** A folder's card colour: steady per name, so a folder keeps its colour from one visit to the next. */
function hueOf(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return h % 360
}
const colorOf = (n: { dir: boolean; name?: string; kind?: MapNode['kind'] }): string => (n.dir && n.kind !== 'app' && n.kind !== 'diskimage' ? `hsl(${hueOf(n.name ?? '')} 55% 55%)` : KIND_COLORS[n.kind ?? 'other'])

export default function SpaceMap({ active }: { active: boolean }): ReactElement {
  const { live, version } = useScanTree()
  const scan = useStorage((s) => s.scan)
  const request = useStorage((s) => s.mapRequest)
  const [layout, setLayout] = useLocal<'map' | 'list'>('storage.mapLayout', 'map')
  const [where, setWhere] = useState<{ id?: number; path?: string }>({})
  const [view, setView] = useState<MapView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [menu, setMenu] = useState<{ node: MapNode; anchor: HTMLElement } | null>(null)
  const history = useRef<{ id?: number; path?: string }[]>([])

  // "Open in the Space Map" from another room.
  useEffect(() => {
    if (!request) return
    useStorage.setState({ mapRequest: null })
    history.current = []
    setWhere({ path: request.path })
  }, [request?.nonce]) // eslint-disable-line react-hooks/exhaustive-deps
  // A new scan starts at its top.
  useEffect(() => { if (!request) { setWhere({}); history.current = [] } }, [scan.summary?.at]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!live) return
    let on = true
    window.api.invoke('storage:view', where.id !== undefined || where.path ? where : { path: scan.summary?.root }).then((v) => {
      if (!on) return
      setView(v)
      setError(null)
    }, (e: Error) => { if (on) setError(e.message) })
    return () => { on = false }
  }, [live, version, where.id, where.path]) // eslint-disable-line react-hooks/exhaustive-deps

  const go = (to: { id?: number; path?: string }): void => {
    if (view) history.current.push({ id: view.node.id })
    setSelected(null)
    setWhere(to)
  }
  const back = (): void => {
    const prev = history.current.pop()
    if (prev) { setSelected(null); setWhere(prev) } else up()
  }
  const up = (): void => {
    const parent = view?.chain.at(-1)
    if (parent) { setSelected(view!.node.id); setWhere({ id: parent.id }) }
  }
  const open = (n: MapNode): void => { if (n.dir && n.more && !n.closed) go({ id: n.id }) }
  const sel = view?.children.find((c) => c.id === selected) ?? null

  // Keys while the map is in front: ↵ opens, ⌘↑ or ⌫ goes up, ⌘⌫ to the Trash, Space for Quick Look.
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined)
  keyRef.current = (e) => {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) || document.querySelector('.modal-backdrop')) return
    const kids = view?.children ?? []
    const at = kids.findIndex((c) => c.id === selected)
    if (e.metaKey && e.key === 'Backspace' && sel) { e.preventDefault(); void trashItems([{ path: sel.path, size: sel.size, dir: sel.dir }], 'Space Map') }
    else if ((e.metaKey && e.key === 'ArrowUp') || (!e.metaKey && e.key === 'Backspace')) { e.preventDefault(); up() }
    else if ((e.key === 'Enter' || (e.metaKey && e.key === 'ArrowDown')) && sel) { e.preventDefault(); open(sel) }
    else if (e.key === ' ' && sel && !sel.dir) { e.preventDefault(); void window.api.invoke('local:quickLook', sel.path) }
    else if (!e.metaKey && (e.key === 'ArrowDown' || e.key === 'ArrowRight')) { e.preventDefault(); setSelected(kids[Math.min(kids.length - 1, at + 1)]?.id ?? null) }
    else if (!e.metaKey && (e.key === 'ArrowUp' || e.key === 'ArrowLeft')) { e.preventDefault(); setSelected(kids[Math.max(0, at - 1)]?.id ?? kids[0]?.id ?? null) }
    else if (e.key === 'Escape') setSelected(null)
  }
  useEffect(() => {
    if (!active) return
    const on = (e: KeyboardEvent): void => keyRef.current(e)
    document.addEventListener('keydown', on)
    setTabKeys('storage', (k) => { if (k.key === '[') { back(); return true } return false })
    return () => { document.removeEventListener('keydown', on); setTabKeys('storage', null) }
  }, [active]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!live) return <div className="plan-scroll st-scroll"><RoomHead icon={<Icon.treemap />} title="Space Map" sub="Every folder as a card sized by the space it takes." /><NeedsScan what="where the space went" /></div>

  return (
    <div className="st-map-room">
      <RoomHead icon={<Icon.treemap />} title={view ? (view.node.id === 0 && view.node.name === '/' ? 'Macintosh HD' : view.node.name.split('/').pop() || view.node.name) : 'Space Map'}
        sub={view ? `${bytes(view.node.size)} · ${plural(view.node.files, 'file')}` : undefined}>
        <span className="plan-segment" role="radiogroup" aria-label="Layout">
          <button type="button" role="radio" aria-checked={layout === 'map'} className={layout === 'map' ? 'on' : ''} onClick={() => setLayout('map')} aria-label="Cards" title="Cards"><Icon.treemap /></button>
          <button type="button" role="radio" aria-checked={layout === 'list'} className={layout === 'list' ? 'on' : ''} onClick={() => setLayout('list')} aria-label="List" title="List"><Icon.list /></button>
        </span>
      </RoomHead>
      <nav className="st-crumbs" aria-label="Folder path">
        <button type="button" className="plan-add" aria-label="Back" title="Back (⌘[)" disabled={!history.current.length && !view?.chain.length} onClick={back}><Icon.back /></button>
        {view?.chain.map((c) => (
          <span key={c.id}><button type="button" onClick={() => go({ id: c.id })}>{c.name === '/' ? 'Macintosh HD' : c.id === 0 ? tilde(c.name) : c.name}</button><Icon.chevron /></span>
        ))}
        {view && <b>{view.node.id === 0 ? (view.node.name === '/' ? 'Macintosh HD' : tilde(view.node.name)) : view.node.name}</b>}
      </nav>
      {error && <div className="plan-error st-pad"><Icon.alert />{error}</div>}
      {view && (layout === 'map'
        ? <Treemap view={view} selected={selected} onSelect={setSelected} onOpen={open} onMenu={(node, anchor) => setMenu({ node, anchor })} />
        : <MapList view={view} selected={selected} onSelect={setSelected} onOpen={open} onMenu={(node, anchor) => setMenu({ node, anchor })} />)}
      <footer className="st-map-foot">
        {sel ? (
          <>
            <span className="st-dot" style={{ background: colorOf(sel) }} />
            <span className="st-map-foot-name" title={sel.path}>{tilde(sel.path)}</span>
            <span className="muted">{bytes(sel.size)}{sel.dir ? ` · ${plural(sel.files, 'file')}` : sel.mtime ? ` · modified ${ago(sel.mtime)}` : ''}</span>
            {sel.closed && <span className="st-row-note warn">{closedNote[sel.closed]}</span>}
            <span className="flex-1" />
            {sel.dir && sel.more && !sel.closed && <button type="button" className="btn btn-sm" onClick={() => open(sel)}>Open</button>}
            <button type="button" className="btn btn-sm" onClick={() => void window.api.invoke('local:reveal', sel.path)}><Icon.finder />Show in Finder</button>
            <button type="button" className="btn btn-sm btn-danger" onClick={() => void trashItems([{ path: sel.path, size: sel.size, dir: sel.dir }], 'Space Map')}><Icon.trash />Move to Trash</button>
          </>
        ) : <span className="muted">{view ? 'Click a card to select it, double-click a folder to go in. Right-click for more.' : 'Reading the scan…'}</span>}
      </footer>
      {menu && <ItemMenu node={menu.node} anchor={menu.anchor} from="Space Map" inMap onClose={() => setMenu(null)} />}
    </div>
  )
}

function Treemap({ view, selected, onSelect, onOpen, onMenu }: { view: MapView; selected: number | null; onSelect: (id: number | null) => void; onOpen: (n: MapNode) => void; onMenu: (n: MapNode, anchor: HTMLElement) => void }): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const cells = useMemo(() => {
    const items: { value: number; node: MapNode }[] = view.children.filter((c) => c.size > 0).map((c) => ({ value: c.size, node: c }))
    if (view.small.bytes > 0) items.push({ value: view.small.bytes, node: { id: SMALL, name: 'Small files', path: view.node.path, size: view.small.bytes, files: view.small.files, dir: false } })
    return squarify(items, { x: 0, y: 0, w: box.w, h: box.h })
  }, [view, box.w, box.h])
  if (!view.children.length && !view.small.bytes) return <div ref={ref} className="st-map"><div className="st-empty"><p>This folder is empty, or everything in it is too small to draw.</p></div></div>
  return (
    <div ref={ref} className="st-map" onClick={(e) => { if (e.target === e.currentTarget) onSelect(null) }}>
      {cells.map(({ item, rect }) => {
        const n = item.node
        const small = n.id === SMALL
        const big = rect.w > 74 && rect.h > 40
        const inner = !small && n.dir ? view.inner?.[n.id] : undefined
        return (
          <div key={n.id} className={`st-cell ${selected === n.id ? 'selected' : ''} ${small ? 'small' : ''} ${n.closed ? 'closed' : ''}`}
            style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, '--c': small ? 'var(--muted)' : colorOf(n) } as CSSProperties}
            title={`${small ? `Small files: ${plural(n.files, 'file')} under 1 MB, counted together` : n.name} · ${bytes(n.size)}`}
            onClick={() => !small && onSelect(n.id)} onDoubleClick={() => !small && onOpen(n)}
            onContextMenu={(e) => { if (small) return; e.preventDefault(); onSelect(n.id); onMenu(n, e.currentTarget) }}>
            {inner && rect.w > 60 && rect.h > 60 && <Inner parts={inner} w={rect.w - 8} h={rect.h - (big ? 40 : 8)} top={big ? 36 : 4} />}
            {big && (
              <div className="st-cell-label">
                <span className="st-cell-name">{n.name}{n.dir && !n.package && !small ? '/' : ''}</span>
                <span className="st-cell-size">{bytes(n.size)}</span>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** A folder card's own largest parts, drawn faintly inside it. */
function Inner({ parts, w, h, top }: { parts: { size: number; kind?: MapNode['kind']; dir: boolean }[]; w: number; h: number; top: number }): ReactElement | null {
  const rects: { item: { value: number; c: string }; rect: Rect }[] = squarify(parts.map((p) => ({ value: p.size, c: p.dir ? 'currentColor' : KIND_COLORS[p.kind ?? 'other'] })), { x: 4, y: top, w, h })
  if (!rects.length) return null
  return (
    <svg className="st-cell-inner" width={w + 8} height={top + h + 4} aria-hidden="true">
      {rects.map(({ item, rect }, i) => rect.w > 3 && rect.h > 3 && <rect key={i} x={rect.x + 1} y={rect.y + 1} width={rect.w - 2} height={rect.h - 2} rx={3} fill={item.c} />)}
    </svg>
  )
}

function MapList({ view, selected, onSelect, onOpen, onMenu }: { view: MapView; selected: number | null; onSelect: (id: number | null) => void; onOpen: (n: MapNode) => void; onMenu: (n: MapNode, anchor: HTMLElement) => void }): ReactElement {
  const icons = useNodeIcons(view.children)
  const total = view.node.size || 1
  return (
    <div className="plan-scroll st-list">
      {view.children.map((n) => (
        <div key={n.id} className={`st-row ${selected === n.id ? 'selected' : ''}`} onClick={() => onSelect(n.id)} onDoubleClick={() => onOpen(n)}
          onContextMenu={(e) => { e.preventDefault(); onSelect(n.id); onMenu(n, e.currentTarget) }}>
          <NodeIcon node={n} icons={icons} />
          <div className="st-row-body">
            <div className="st-row-title">{n.name}{n.closed && <span className="st-badge warn" title={closedNote[n.closed]}>not counted</span>}</div>
            <div className="st-row-sub">{n.dir ? plural(n.files, 'file') : n.mtime ? `Modified ${ago(n.mtime)}` : ''}</div>
          </div>
          <ShareBar pct={(n.size / total) * 100} color={colorOf(n)} />
          <span className="st-pct">{Math.round((n.size / total) * 100)}%</span>
          <span className="st-size">{bytes(n.size)}</span>
          {n.dir && n.more && !n.closed ? <button type="button" className="st-more" aria-label={`Open ${n.name}`} onClick={(e) => { e.stopPropagation(); onOpen(n) }}><Icon.chevron /></button> : <span className="st-more" />}
        </div>
      ))}
      {view.small.bytes > 0 && (
        <div className="st-row disabled">
          <span className="st-icon st-icon-glyph"><Icon.layers /></span>
          <div className="st-row-body"><div className="st-row-title">Small files</div><div className="st-row-sub">{plural(view.small.files, 'file')} under 1 MB, counted together without their names</div></div>
          <ShareBar pct={(view.small.bytes / total) * 100} />
          <span className="st-pct">{Math.round((view.small.bytes / total) * 100)}%</span>
          <span className="st-size">{bytes(view.small.bytes)}</span>
          <span className="st-more" />
        </div>
      )}
    </div>
  )
}

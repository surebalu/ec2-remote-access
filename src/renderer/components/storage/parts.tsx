import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { ago, bytes, KIND_NAMES, plural, tildePath, type FileKind, type MapNode } from '@shared/storage'
import { useStore } from '../../store'
import { Icon } from '../icons'
import Popover, { MenuItem, MenuSep } from '../Popover'
import { useFileIcons } from '../plan/parts'
import { openInMap, startScan, trashItems, useStorage } from './state'

/** Pieces the Storage rooms share (storage.css): headings, rows, the item menu, the Move to Trash bar. */

/** The user's home folder, read once per page (paths show as ~/…). */
let homeDir = ''
void window.api?.invoke('local:home').then((h) => { homeDir = h }, () => undefined)
export const tilde = (p: string): string => tildePath(p, homeDir)
export const homePath = (): string => homeDir

/** A colour per kind of file, for the Space Map's cards and the kind bars. */
export const KIND_COLORS: Record<FileKind, string> = {
  video: '#8b5cf6', audio: '#ec4899', image: '#10b981', document: '#3b82f6', archive: '#f59e0b',
  diskimage: '#f97316', developer: '#14b8a6', app: '#6366f1', other: '#94a3b8'
}

export function RoomHead({ icon, title, sub, children }: { icon: ReactNode; title: string; sub?: ReactNode; children?: ReactNode }): ReactElement {
  return (
    <header className="plan-head st-head">
      <span className="st-head-icon" aria-hidden="true">{icon}</span>
      <div className="st-head-text">
        <h1>{title}</h1>
        {sub && <p className="plan-sub">{sub}</p>}
      </div>
      <span className="flex-1" />
      {children}
    </header>
  )
}

/** What a room shows until there is a scan to look into: the scan in progress, or the ways to start one. */
export function NeedsScan({ what }: { what: string }): ReactElement {
  const scan = useStorage((s) => s.scan)
  if (scan.status === 'scanning') return <ScanProgressCard />
  const stale = scan.status === 'done' && !scan.live
  return (
    <div className="st-empty">
      <Icon.treemap className="plan-empty-icon" />
      <p>{stale ? `The last scan is no longer in memory. Scan again to see ${what}.` : `Scan the Mac to see ${what}.`}</p>
      <ScanButtons kind={scan.summary?.kind} path={scan.summary?.root} />
      <p className="muted">The scan only reads sizes, here on the Mac. Nothing is uploaded and nothing is changed.</p>
    </div>
  )
}

export function ScanButtons({ kind, path }: { kind?: string; path?: string }): ReactElement {
  return (
    <div className="st-scan-buttons">
      {kind === 'path' && path ? <button type="button" className="btn btn-primary" onClick={() => void startScan('path', path)}><Icon.refresh />Scan {path.split('/').pop()} again</button> : null}
      <button type="button" className={`btn ${kind === 'path' && path ? '' : 'btn-primary'}`} onClick={() => void startScan('mac')}><Icon.disk />Scan the whole Mac</button>
      <button type="button" className="btn" onClick={() => void startScan('home')}><Icon.server />Your home folder</button>
      <button type="button" className="btn" onClick={() => void startScan('path')}><Icon.folder />A folder or drive…</button>
    </div>
  )
}

export function ScanProgressCard(): ReactElement {
  const scan = useStorage((s) => s.scan)
  const p = scan.progress
  return (
    <div className="st-empty">
      <div className="st-spinner" aria-hidden="true" />
      <p>Scanning {scan.root === '/' ? 'the whole Mac' : tilde(scan.root ?? '')}…</p>
      {p && <p className="muted">{plural(p.files, 'file')} in {plural(p.dirs, 'folder')} · {bytes(p.bytes)}</p>}
      {p?.path && <p className="st-progress-path" title={p.path}>{tilde(p.path)}</p>}
      <button type="button" className="btn btn-sm" onClick={() => void window.api.invoke('storage:cancel')}>Stop</button>
    </div>
  )
}

/** Whether the scan's tree can be asked now, and a value that changes whenever lists should reload. */
export function useScanTree(): { live: boolean; version: string } {
  const scan = useStorage((s) => s.scan)
  const trashed = useStorage((s) => s.trashed)
  const live = scan.status === 'done' && !!scan.live
  return { live, version: `${scan.summary?.at ?? 0}:${trashed}` }
}

/** A file's or folder's icon: Finder's own (Mac app), else a folder or document glyph. */
export function NodeIcon({ node, icons }: { node: Pick<MapNode, 'path' | 'dir' | 'package'>; icons: Map<string, string> }): ReactElement {
  const url = icons.get(node.path)
  if (url) return <img className="st-icon" src={url} alt="" />
  return <span className="st-icon st-icon-glyph" aria-hidden="true">{node.dir && !node.package ? <Icon.folder /> : <Icon.note />}</span>
}

export function useNodeIcons(nodes: { path: string }[]): Map<string, string> {
  return useFileIcons(useMemo(() => nodes.slice(0, 300).map((n) => n.path), [nodes]))
}

/** A selectable row: tick box, icon, name and where it is, a note, its size. */
export function ItemRow({ checked, onCheck, icon, title, sub, note, badge, size, extra, selected, onSelect, onOpen, onMenu, disabled, warn }: {
  checked?: boolean
  onCheck?: (on: boolean) => void
  icon: ReactNode
  title: ReactNode
  sub?: ReactNode
  note?: ReactNode
  badge?: ReactNode
  size?: number
  extra?: ReactNode
  selected?: boolean
  onSelect?: () => void
  onOpen?: () => void
  onMenu?: (anchor: HTMLElement) => void
  disabled?: boolean
  warn?: boolean
}): ReactElement {
  return (
    <div className={`st-row ${selected ? 'selected' : ''} ${disabled ? 'disabled' : ''}`} onClick={onSelect} onDoubleClick={onOpen}
      onContextMenu={onMenu ? (e) => { e.preventDefault(); onMenu(e.currentTarget) } : undefined}>
      {onCheck && <input type="checkbox" className="st-check" checked={!!checked} disabled={disabled} aria-label="Select" onClick={(e) => e.stopPropagation()} onChange={(e) => onCheck(e.target.checked)} />}
      {icon}
      <div className="st-row-body">
        <div className="st-row-title">{title}{badge}</div>
        {sub && <div className="st-row-sub">{sub}</div>}
        {note && <div className={`st-row-note ${warn ? 'warn' : ''}`}>{note}</div>}
      </div>
      {extra}
      {size !== undefined && <span className="st-size">{bytes(size)}</span>}
      {onMenu && <button type="button" className="st-more" aria-label="More" onClick={(e) => { e.stopPropagation(); onMenu(e.currentTarget) }}><Icon.more /></button>}
    </div>
  )
}

/** The menu for one file or folder: Finder, open, Quick Look, the Space Map, copy its path, the Trash. */
export function ItemMenu({ node, anchor, from, onClose, inMap }: { node: Pick<MapNode, 'path' | 'dir' | 'size'>; anchor: HTMLElement; from: string; onClose: () => void; inMap?: boolean }): ReactElement {
  const st = useStore.getState()
  const parent = node.path.replace(/\/[^/]+$/, '') || '/'
  const close = (fn: () => void) => (): void => { onClose(); fn() }
  return (
    <Popover anchor={anchor} onClose={onClose} width={240}>
      <MenuItem onClick={close(() => void window.api.invoke('local:reveal', node.path))}><Icon.finder />Show in Finder</MenuItem>
      <MenuItem onClick={close(() => st.openFinder(node.dir ? node.path : parent))}><Icon.folder />Open in the Finder tab</MenuItem>
      <MenuItem onClick={close(() => void window.api.invoke('local:open', node.path).catch((e: Error) => st.toast('error', e.message)))}><Icon.external />Open</MenuItem>
      {!node.dir && <MenuItem onClick={close(() => void window.api.invoke('local:quickLook', node.path))} hint="Space"><Icon.search />Quick Look</MenuItem>}
      {!inMap && <MenuItem onClick={close(() => openInMap(node.dir ? node.path : parent))}><Icon.treemap />{node.dir ? 'Open in the Space Map' : 'Its folder in the Space Map'}</MenuItem>}
      <MenuItem onClick={close(() => void window.api.invoke('clipboard:write', node.path).then(() => st.toast('success', 'Path copied')))}><Icon.copy />Copy path</MenuItem>
      <MenuSep />
      <MenuItem danger onClick={close(() => void trashItems([{ path: node.path, size: node.size, dir: node.dir }], from))} hint="⌘⌫"><Icon.trash />Move to Trash</MenuItem>
    </Popover>
  )
}

/** The bar under a list with ticked items: how many, how much, and Move to Trash. */
export function TrashBar({ items, from, label = 'Move to Trash', onDone, note }: { items: { path: string; size: number; dir?: boolean }[]; from: string; label?: string; onDone?: () => void; note?: ReactNode }): ReactElement | null {
  const [busy, setBusy] = useState(false)
  const total = items.reduce((s, i) => s + i.size, 0)
  return (
    <div className="st-trashbar">
      <span className="st-trashbar-text">
        {items.length ? <><b>{bytes(total)}</b> in {plural(items.length, 'item')} selected</> : 'Nothing selected'}
        {note && <span className="muted"> · {note}</span>}
      </span>
      <span className="flex-1" />
      <span className="muted st-trashbar-hint">Everything goes to the Trash, and can be put back.</span>
      <button type="button" className="btn btn-sm btn-danger" disabled={!items.length || busy} onClick={() => {
        setBusy(true)
        void trashItems(items, from).finally(() => { setBusy(false); onDone?.() })
      }}><Icon.trash />{busy ? 'Moving…' : label}</button>
    </div>
  )
}

/** A set of ticked keys, reset when `resetKey` changes, with the ones ticked for you first. */
export function useTicks(resetKey: string, initial: () => string[]): [Set<string>, (key: string, on: boolean) => void, (keys: string[]) => void] {
  const [ticks, setTicks] = useState<Set<string>>(() => new Set(initial()))
  useEffect(() => { setTicks(new Set(initial())) }, [resetKey]) // eslint-disable-line react-hooks/exhaustive-deps
  return [ticks, (key, on) => setTicks((t) => { const n = new Set(t); if (on) n.add(key); else n.delete(key); return n }), (keys) => setTicks(new Set(keys))]
}

export const modified = (mtime?: number): string => (mtime ? `Modified ${ago(mtime)}` : '')
export const kindLabel = (k?: FileKind): string => (k ? KIND_NAMES[k] : '')

/** A thin horizontal share bar. */
export function ShareBar({ pct, color }: { pct: number; color?: string }): ReactElement {
  return <span className="st-share" aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(100, pct))}%`, ...(color ? { background: color } : {}) }} /></span>
}

/** Pulls a list from main when the room opens and whenever `version` changes; `error` says why it could not. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [n, setN] = useState(0)
  useEffect(() => {
    let live = true
    setLoading(true)
    load().then((d) => { if (live) { setData(d); setError(null) } }, (e: Error) => { if (live) setError(e.message) }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [...deps, n]) // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, loading, reload: () => setN((x) => x + 1) }
}

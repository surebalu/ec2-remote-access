import { useEffect, useMemo, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { ago, bytes, DISK_PARTS, KIND_NAMES, plural, tildePath, type DiskPart, type DiskTarget, type FileKind, type MapNode } from '@shared/storage'
import type { Badge as BadgeT } from '@shared/cleanup'
import { useStore } from '../../store'
import { Icon } from '../icons'
import Popover, { MenuItem, MenuLabel, MenuSep } from '../Popover'
import { useFileIcons } from '../plan/parts'
import { openInMap, startScan, trashItems, useStorage } from './state'

/**
 * Pieces every Storage room is built from (storage.css), after Strata's layout: a top bar with the scan's size and the
 * disk picker, a line saying what the room is for, a bar with the count, the order and Select links, dense rows with
 * Reveal and the size, group headers with a coloured icon, and a footer with what is selected and Move to Trash.
 */

/** The user's home folder, read once per page (paths show as ~/…). */
let homeDir = ''
void window.api?.invoke('local:home').then((h) => { homeDir = h }, () => undefined)
export const tilde = (p: string): string => tildePath(p, homeDir)
export const homePath = (): string => homeDir
const parentOf = (p: string): string => p.replace(/\/[^/]+$/, '') || '/'

/** A colour per kind of file, for the Space Map's cards and the kind bars. */
export const KIND_COLORS: Record<FileKind | 'small', string> = {
  video: '#a855f7', audio: '#ec4899', image: '#14b8a6', document: '#3b82f6', archive: '#d97706',
  diskimage: '#6366f1', developer: '#22c55e', app: '#38bdf8', other: '#a3a033', small: '#64748b'
}
export const PART_COLORS: Record<DiskPart | 'free', string> = {
  apps: '#3b82f6', documents: '#d97706', downloads: '#14b8a6', pictures: '#ec4899', library: '#8b5cf6', other: '#22c55e', trash: '#ef4444', system: '#94a3b8', free: 'transparent'
}

/** The coloured squircles group headers and tiles wear. */
export const LOOKS: Record<string, { color: string; icon: () => ReactElement }> = {
  caches: { color: '#3b82f6', icon: () => <Icon.layers /> },
  logs: { color: '#64748b', icon: () => <Icon.note /> },
  downloads: { color: '#22c55e', icon: () => <Icon.download /> },
  'downloads-old': { color: '#14b8a6', icon: () => <Icon.history /> },
  developer: { color: '#8b5cf6', icon: () => <Icon.code /> },
  installers: { color: '#f59e0b', icon: () => <Icon.archive /> },
  vms: { color: '#475569', icon: () => <Icon.monitor /> },
  leftover: { color: '#64748b', icon: () => <Icon.box /> },
  ai: { color: '#8b5cf6', icon: () => <Icon.brain /> },
  apple: { color: '#52525b', icon: () => <Icon.sparkles /> },
  system: { color: '#f59e0b', icon: () => <Icon.disk /> },
  backups: { color: '#3b82f6', icon: () => <Icon.phone /> },
  mail: { color: '#14b8a6', icon: () => <Icon.clipboard /> },
  messages: { color: '#22c55e', icon: () => <Icon.note /> },
  simulators: { color: '#3b82f6', icon: () => <Icon.phone /> },
  music: { color: '#ec4899', icon: () => <Icon.play /> },
  snapshots: { color: '#8b5cf6', icon: () => <Icon.history /> },
  trash: { color: '#ef4444', icon: () => <Icon.trash /> },
  junk: { color: '#ef4444', icon: () => <Icon.trash /> },
  large: { color: '#3b82f6', icon: () => <Icon.note /> },
  unused: { color: '#f59e0b', icon: () => <Icon.apps /> },
  duplicates: { color: '#a855f7', icon: () => <Icon.copy /> },
  items: { color: '#10b981', icon: () => <Icon.layers /> },
  hidden: { color: '#64748b', icon: () => <Icon.eyeOff /> },
  developer2: { color: '#0ea5e9', icon: () => <Icon.code /> }
}

export function Squircle({ look, size = 32 }: { look: string; size?: number }): ReactElement {
  const l = LOOKS[look] ?? LOOKS.items
  return <span className="st-sq" style={{ '--sq': l.color, width: size, height: size } as CSSProperties} aria-hidden="true">{l.icon()}</span>
}

export function Badge({ tone = 'muted', children }: { tone?: BadgeT['tone']; children: ReactNode }): ReactElement {
  return <span className={`st-badge ${tone}`}>{children}</span>
}

/** A row of choices, one on (Largest | Name). */
export function Segmented<T extends string>({ value, options, onChange, small }: { value: T; options: { id: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; small?: boolean }): ReactElement {
  return (
    <span className={`st-seg ${small ? 'small' : ''}`} role="radiogroup">
      {options.map((o) => <button key={o.id} type="button" role="radio" aria-checked={value === o.id} aria-label={o.title} title={o.title} className={value === o.id ? 'on' : ''} onClick={() => onChange(o.id)}>{o.label}</button>)}
    </span>
  )
}

/** The room's title on the left; the scan's size and the disk picker on the right. */
export function TopBar({ title, icon, children, back }: { title: ReactNode; icon?: ReactNode; children?: ReactNode; back?: () => void }): ReactElement {
  return (
    <header className="st-top">
      {back && <button type="button" className="st-top-back" aria-label="Back" title="Back (⌘[)" onClick={back}><Icon.back /></button>}
      {icon && <span className="st-top-icon">{icon}</span>}
      <h1>{title}</h1>
      <span className="flex-1" />
      {children}
      <ScopePicker />
    </header>
  )
}

/** "503 GB · Macintosh HD ▾": what the last scan covered, and the places that can be scanned. */
export function ScopePicker(): ReactElement {
  const scan = useStorage((s) => s.scan)
  const disk = useStorage((s) => s.disk)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [targets, setTargets] = useState<DiskTarget[] | null>(null)
  useEffect(() => { if (anchor) void window.api.invoke('storage:targets').then(setTargets, () => setTargets([])) }, [anchor])
  const s = scan.summary
  const label = s ? (s.kind === 'mac' ? disk?.name ?? 'Macintosh HD' : s.kind === 'home' ? 'Home folder' : s.root.split('/').pop() || s.root) : disk?.name ?? 'Macintosh HD'
  return (
    <>
      {s && <span className="st-scope-size">{bytes(s.bytes)}</span>}
      <button type="button" className="st-scope" onClick={(e) => setAnchor(anchor ? null : e.currentTarget)} aria-haspopup="menu" title="Choose what to scan">
        <Icon.disk />{label}<Icon.caret />
      </button>
      {anchor && (
        <Popover anchor={anchor} align="right" width={280} onClose={() => setAnchor(null)}>
          <MenuLabel>Scan</MenuLabel>
          {(targets ?? [{ kind: 'mac', label: disk?.name ?? 'Macintosh HD' }, { kind: 'home', label: 'Your home folder' }] as DiskTarget[]).map((t) => (
            <MenuItem key={`${t.kind}:${t.path ?? ''}`} on={!!s && s.kind === t.kind && (t.kind !== 'path' || s.root === t.path)} hint={t.total ? `${bytes(t.free ?? 0)} free` : undefined}
              onClick={() => { setAnchor(null); void startScan(t.kind, t.path) }}>
              {t.kind === 'home' ? <Icon.server /> : <Icon.disk />}{t.label}
            </MenuItem>
          ))}
          <MenuSep />
          <MenuItem onClick={() => { setAnchor(null); void startScan('path') }}><Icon.folder />Choose a folder…</MenuItem>
        </Popover>
      )}
    </>
  )
}

/** What the room is for, with its own buttons on the right (Look Again). */
export function Intro({ children, actions }: { children: ReactNode; actions?: ReactNode }): ReactElement {
  return <div className="st-intro"><p>{children}</p>{actions && <div className="st-intro-actions">{actions}</div>}</div>
}

/** "237 items, 70.2 GB" with the order and the Select links. */
export function ListBar({ text, children, links }: { text: ReactNode; children?: ReactNode; links?: { label: string; onClick: () => void; disabled?: boolean }[] }): ReactElement {
  return (
    <div className="st-listbar">
      <span className="st-listbar-text">{text}</span>
      <span className="flex-1" />
      {children}
      {links?.map((l) => <button key={l.label} type="button" className="st-link" disabled={l.disabled} onClick={l.onClick}>{l.label}</button>)}
    </div>
  )
}

/** The bottom of a list: how many are selected and their size, a line about what happens, and the main button. */
export function Footer({ count, size, note, children, links }: { count: number; size?: number; note?: ReactNode; children?: ReactNode; links?: { label: string; onClick: () => void; disabled?: boolean }[] }): ReactElement {
  return (
    <footer className="st-footer">
      <div className="st-footer-text">
        <b>{count ? `${count.toLocaleString('en-US')} selected${size !== undefined ? ` · ${bytes(size, '0 bytes')}` : ''}` : 'Nothing selected'}</b>
        {links?.map((l) => <button key={l.label} type="button" className="st-link" disabled={l.disabled} onClick={l.onClick}>{l.label}</button>)}
        {note && <p>{note}</p>}
      </div>
      <span className="flex-1" />
      {children}
    </footer>
  )
}

/** The footer with Move to Trash… for ticked items (everything goes to the Trash, and can be put back). */
export function TrashFooter({ items, from, note, label = 'Move to Trash…', onDone, links, extra }: {
  items: { path: string; size: number; dir?: boolean }[]
  from: string
  note?: ReactNode
  label?: string
  onDone?: () => void
  links?: { label: string; onClick: () => void; disabled?: boolean }[]
  extra?: ReactNode
}): ReactElement {
  const [busy, setBusy] = useState(false)
  return (
    <Footer count={items.length} size={items.reduce((s, i) => s + i.size, 0)} note={note ?? 'Everything goes to the Trash, and can be put back.'} links={links}>
      {extra}
      <button type="button" className="st-primary" disabled={!items.length || busy} onClick={() => {
        setBusy(true)
        void trashItems(items, from).finally(() => { setBusy(false); onDone?.() })
      }}>{busy ? 'Moving…' : label}</button>
    </Footer>
  )
}

/** Finder's icons for files and apps (Mac app only), by path. */
export function useIcons(paths: (string | undefined)[]): Map<string, string> {
  return useFileIcons(useMemo(() => [...new Set(paths.filter((p): p is string => !!p && p.startsWith('/')))].slice(0, 400), [paths.join('\u0000')])) // eslint-disable-line react-hooks/exhaustive-deps
}
export const useNodeIcons = (nodes: { path: string }[]): Map<string, string> => useIcons(nodes.map((n) => n.path))

/** A file's, folder's or app's icon: Finder's own, else a glyph. */
export function ItemIcon({ path, icons, dir, size = 26 }: { path?: string; icons: Map<string, string>; dir?: boolean; size?: number }): ReactElement {
  const url = path ? icons.get(path) : undefined
  if (url) return <img className="st-icon" style={{ width: size, height: size }} src={url} alt="" />
  return <span className="st-icon st-icon-glyph" style={{ width: size, height: size }} aria-hidden="true">{dir ? <Icon.folder /> : <Icon.note />}</span>
}
export const NodeIcon = ({ node, icons }: { node: Pick<MapNode, 'path' | 'dir' | 'package'>; icons: Map<string, string> }): ReactElement => <ItemIcon path={node.path} icons={icons} dir={node.dir && !node.package} />

/** A dense row: tick, icon, title with badges, a line beneath, then Reveal and the size. */
export function Row({ checked, onCheck, icon, title, badges, sub, extra, size, reveal, selected, disabled, onSelect, onOpen, onMenu, lock, indent, bar }: {
  checked?: boolean
  onCheck?: (on: boolean) => void
  icon?: ReactNode
  title: ReactNode
  badges?: ReactNode
  sub?: ReactNode
  extra?: ReactNode
  size?: number
  reveal?: string
  selected?: boolean
  disabled?: boolean
  onSelect?: () => void
  onOpen?: () => void
  onMenu?: (anchor: HTMLElement) => void
  /** Shown in the tick's place when it cannot be ticked (a lock). */
  lock?: boolean
  indent?: boolean
  /** A share bar before the size (Hidden Files). */
  bar?: number
}): ReactElement {
  return (
    <div className={`st-row ${selected ? 'selected' : ''} ${disabled ? 'disabled' : ''} ${indent ? 'indent' : ''}`} onClick={onSelect} onDoubleClick={onOpen}
      onContextMenu={onMenu ? (e) => { e.preventDefault(); onMenu(e.currentTarget) } : undefined}>
      <span className="st-row-tick">
        {onCheck ? <input type="checkbox" className="st-check" checked={!!checked} aria-label="Select" onClick={(e) => e.stopPropagation()} onChange={(e) => onCheck(e.target.checked)} />
          : lock ? <span className="st-lock" title="Cannot be moved from here"><Icon.lock /></span> : null}
      </span>
      {icon}
      <div className="st-row-body">
        <div className="st-row-title"><span className="st-row-name">{title}</span>{badges}</div>
        {sub && <div className="st-row-sub">{sub}</div>}
      </div>
      {extra}
      {bar !== undefined && <span className="st-bar" aria-hidden="true"><span style={{ width: `${Math.max(2, Math.min(100, bar))}%` }} /></span>}
      {reveal && <button type="button" className="st-link st-reveal" onClick={(e) => { e.stopPropagation(); void window.api.invoke('local:reveal', reveal) }}>Reveal</button>}
      {size !== undefined && <span className="st-size">{bytes(size, '0 bytes')}</span>}
    </div>
  )
}

/** A group's header: its tick for all, a coloured icon, what it is, its size, and a chevron that folds it. */
export function GroupHead({ look, icon, title, sub, size, state, onTick, open, onToggle, extra, badge }: {
  look?: string
  icon?: ReactNode
  title: ReactNode
  sub?: ReactNode
  size?: number
  state?: 'all' | 'some' | 'none' | 'off'
  onTick?: (on: boolean) => void
  open?: boolean
  onToggle?: () => void
  extra?: ReactNode
  badge?: ReactNode
}): ReactElement {
  return (
    <div className="st-ghead" onClick={onToggle}>
      <span className="st-row-tick">
        {state && state !== 'off' && onTick && <input type="checkbox" className="st-check" aria-label="Select all in this group" checked={state === 'all'}
          ref={(el) => { if (el) el.indeterminate = state === 'some' }} onClick={(e) => e.stopPropagation()} onChange={(e) => onTick(e.target.checked)} />}
      </span>
      {icon ?? (look ? <Squircle look={look} /> : null)}
      <div className="st-row-body">
        <div className="st-ghead-title">{title}{badge}</div>
        {sub && <div className="st-row-sub">{sub}</div>}
      </div>
      {extra}
      {size !== undefined && <span className="st-size strong">{bytes(size, '0 bytes')}</span>}
      {onToggle && <span className={`st-chev ${open ? 'open' : ''}`} aria-hidden="true"><Icon.caret /></span>}
    </div>
  )
}

/** The disk as a stacked bar of its parts, with a legend underneath (Overview, Space Map). */
export function DiskBar({ compact }: { compact?: boolean }): ReactElement | null {
  const disk = useStorage((s) => s.disk)
  const summary = useStorage((s) => s.scan.summary)
  const [hover, setHover] = useState<string | null>(null)
  if (!disk) return null
  const used = disk.total - disk.free
  const parts = summary?.parts?.length && summary.kind !== 'path' ? summary.parts : []
  const partSum = parts.reduce((s, p) => s + p.bytes, 0) || 1
  const segs = parts.length ? parts.map((p) => ({ id: p.id as string, bytes: p.bytes, share: ((p.bytes / partSum) * used) / disk.total })) : [{ id: 'used', bytes: used, share: used / disk.total }]
  const label = (id: string): string => (id === 'library' ? 'App Data' : id === 'system' ? 'System' : DISK_PARTS.find((d) => d.id === id)?.label ?? 'Used')
  return (
    <div className={`st-diskbar ${compact ? 'compact' : ''}`} onMouseLeave={() => setHover(null)}>
      <div className="st-stack">
        {segs.map((p) => <span key={p.id} className={hover && hover !== p.id ? 'dim' : ''} style={{ width: `${p.share * 100}%`, background: PART_COLORS[p.id as DiskPart] ?? 'var(--text-2)' }} onMouseEnter={() => setHover(p.id)} title={`${label(p.id)}: ${bytes(p.bytes)}`} />)}
      </div>
      <div className="st-legend">
        {segs.filter((p) => p.id !== 'used').map((p) => (
          <span key={p.id} className={`st-legend-item ${hover === p.id ? 'on' : ''}`} onMouseEnter={() => setHover(p.id)} title={DISK_PARTS.find((d) => d.id === p.id)?.hint}>
            <span className="st-dot" style={{ background: PART_COLORS[p.id as DiskPart] }} /><span className="st-legend-label">{label(p.id)}</span><b>{bytes(p.bytes)}</b>
          </span>
        ))}
        <span className="st-legend-item"><span className="st-dot free" /><span className="st-legend-label">Free</span><b>{bytes(disk.free)}</b></span>
      </div>
    </div>
  )
}

/** What a room shows until there is a scan to look into: the scan in progress, or the ways to start one. */
export function NeedsScan({ what }: { what: string }): ReactElement {
  const scan = useStorage((s) => s.scan)
  if (scan.status === 'scanning') return <ScanProgressCard />
  const stale = scan.status === 'done' && !scan.live
  return (
    <div className="st-empty">
      <span className="st-empty-art"><Icon.treemap /></span>
      <h3>{stale ? 'Scan again to look into it' : 'Nothing scanned yet'}</h3>
      <p>{stale ? `The last scan is no longer in memory. Scan again to see ${what}.` : `Scan the Mac to see ${what}.`}</p>
      <ScanButtons kind={scan.summary?.kind} path={scan.summary?.root} />
      <p className="muted">The scan only reads sizes, here on the Mac. Nothing is uploaded and nothing is changed.</p>
    </div>
  )
}

export function ScanButtons({ kind, path }: { kind?: string; path?: string }): ReactElement {
  return (
    <div className="st-scan-buttons">
      {kind === 'path' && path ? <button type="button" className="st-primary" onClick={() => void startScan('path', path)}><Icon.refresh />Scan {path.split('/').pop()} again</button> : null}
      <button type="button" className={kind === 'path' && path ? 'st-button' : 'st-primary'} onClick={() => void startScan('mac')}><Icon.disk />Scan the whole Mac</button>
      <button type="button" className="st-button" onClick={() => void startScan('home')}><Icon.server />Your home folder</button>
      <button type="button" className="st-button" onClick={() => void startScan('path')}><Icon.folder />A folder or drive…</button>
    </div>
  )
}

export function ScanProgressCard(): ReactElement {
  const scan = useStorage((s) => s.scan)
  const p = scan.progress
  return (
    <div className="st-empty">
      <div className="st-spinner" aria-hidden="true" />
      <h3>Scanning {scan.root === '/' ? 'the whole Mac' : tilde(scan.root ?? '')}…</h3>
      {p && <p className="muted">{plural(p.files, 'file')} in {plural(p.dirs, 'folder')} · {bytes(p.bytes)}</p>}
      {p?.path && <p className="st-progress-path" title={p.path}>{tilde(p.path)}</p>}
      <button type="button" className="st-button" onClick={() => void window.api.invoke('storage:cancel')}>Stop</button>
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

/** The menu for one file or folder: Finder, open, Quick Look, the Space Map, copy its path, the Trash. */
export function ItemMenu({ node, anchor, from, onClose, inMap }: { node: Pick<MapNode, 'path' | 'dir' | 'size'>; anchor: HTMLElement; from: string; onClose: () => void; inMap?: boolean }): ReactElement {
  const st = useStore.getState()
  const close = (fn: () => void) => (): void => { onClose(); fn() }
  return (
    <Popover anchor={anchor} onClose={onClose} width={240}>
      <MenuItem onClick={close(() => void window.api.invoke('local:reveal', node.path))}><Icon.finder />Show in Finder</MenuItem>
      <MenuItem onClick={close(() => st.openFinder(node.dir ? node.path : parentOf(node.path)))}><Icon.folder />Open in the Finder tab</MenuItem>
      <MenuItem onClick={close(() => void window.api.invoke('local:open', node.path).catch((e: Error) => st.toast('error', e.message)))}><Icon.external />Open</MenuItem>
      {!node.dir && <MenuItem onClick={close(() => void window.api.invoke('local:quickLook', node.path))} hint="Space"><Icon.search />Quick Look</MenuItem>}
      {!inMap && <MenuItem onClick={close(() => openInMap(node.dir ? node.path : parentOf(node.path)))}><Icon.treemap />{node.dir ? 'Open in the Space Map' : 'Its folder in the Space Map'}</MenuItem>}
      <MenuItem onClick={close(() => void window.api.invoke('clipboard:write', node.path).then(() => st.toast('success', 'Path copied')))}><Icon.copy />Copy path</MenuItem>
      <MenuSep />
      <MenuItem danger onClick={close(() => void trashItems([{ path: node.path, size: node.size, dir: node.dir }], from))} hint="⌘⌫"><Icon.trash />Move to Trash</MenuItem>
    </Popover>
  )
}

/** A set of ticked keys, reset when `resetKey` changes. */
export function useTicks(resetKey: string, initial: () => string[]): [Set<string>, (key: string, on: boolean) => void, (keys: string[]) => void] {
  const [ticks, setTicks] = useState<Set<string>>(() => new Set(initial()))
  useEffect(() => { setTicks(new Set(initial())) }, [resetKey]) // eslint-disable-line react-hooks/exhaustive-deps
  return [ticks, (key, on) => setTicks((t) => { const n = new Set(t); if (on) n.add(key); else n.delete(key); return n }), (keys) => setTicks(new Set(keys))]
}

export const changed = (mtime?: number): string => (mtime ? `changed ${ago(mtime)}` : '')
export const kindLabel = (k?: FileKind): string => (k ? KIND_NAMES[k] : '')
export const where = (p: string): string => tilde(parentOf(p))

/** Pulls a list from main when the room opens and whenever the deps change. */
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

/** Sorts by size (largest first) or by name. */
export function sortBy<T>(list: T[], by: 'size' | 'name', size: (x: T) => number, name: (x: T) => string): T[] {
  return [...list].sort(by === 'name' ? (a, b) => name(a).localeCompare(name(b)) : (a, b) => size(b) - size(a))
}

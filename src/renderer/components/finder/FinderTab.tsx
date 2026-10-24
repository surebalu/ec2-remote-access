import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactElement, type ReactNode } from 'react'
import { isCadFile } from '@shared/cad'
import type { SftpEntry } from '@shared/types'
import {
  favoritePatch, folderHints, formatDate, formatSize, freeName, isBundle, kindOf, parentOf, pathSteps, resolveTyped, sortEntries, tildePath, typedParts,
  type FinderPlace, type FinderPlaces, type FinderSort, type OpenWithApp, type RecentFile
} from '@shared/finder'
import { registerWorkspaceContext } from '../../workspaceContext'
import { useStore, type Tab } from '../../store'
import { setTabKeys, type TabKey } from '../../shortcuts'
import { Icon } from '../icons'
import Popover, { MenuItem, MenuSep } from '../Popover'

/**
 * The Finder tab: the files on this Mac with the macOS Finder's sidebar (Recents, the Favorites from Finder's own
 * sidebar plus folders added here, and Locations: iCloud Drive, cloud drives, disks), a sortable list, a path bar, Quick
 * Look and Spotlight search. Folders open in the app's Terminal; files open in their default app, or Open With another.
 * Copy puts the files themselves on the clipboard, so ⌘V pastes them here or in Finder, and files copied in Finder paste
 * here: ⌘V is Edit → Paste, which macOS treats as the user's own paste and which hands the page the files.
 */

const RECENTS = 'recents'
const LOC_KEY = 'ui.finder.loc'
const SORT_KEY = 'ui.finder.sort'
const HIDDEN_KEY = 'ui.finder.hidden'
const PATH_DRAG = 'application/x-ec2ra-path'

const read = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d } catch { return d } }
const write = (k: string, v: unknown): void => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* storage off */ } }

type Entry = SftpEntry & { lastUsed?: number }

/** Open With's apps by kind of item (a file's extension, or folder), and their icons, kept for the run. */
const appsByKind = new Map<string, OpenWithApp[]>()
const appIcons = new Map<string, string>()
const kindKey = (e: Pick<SftpEntry, 'name' | 'path' | 'type'>): string => (e.type === 'dir' ? '/folder' : /\.([^./]+)$/.exec(e.name)?.[1]?.toLowerCase() ?? e.path)

/** A file's icon, drawn like Finder's: a blue folder, an application tile, or a page with a coloured band for its kind. */
function FileIcon({ e, size = 18 }: { e: Pick<SftpEntry, 'name' | 'type'>; size?: number }): ReactElement {
  if (e.type === 'dir' && !isBundle(e)) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="fi-icon">
        <path d="M2.5 6.2a1.7 1.7 0 0 1 1.7-1.7h4.6l2.1 2h8.9a1.7 1.7 0 0 1 1.7 1.7v9.6a1.7 1.7 0 0 1-1.7 1.7H4.2a1.7 1.7 0 0 1-1.7-1.7z" fill="#5aaef5" />
        <path d="M2.5 9.1h19v8.7a1.7 1.7 0 0 1-1.7 1.7H4.2a1.7 1.7 0 0 1-1.7-1.7z" fill="#3e98ee" />
      </svg>
    )
  }
  if (isBundle(e)) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="fi-icon">
        <rect x="3" y="3" width="18" height="18" rx="5" fill="url(#fi-app)" />
        <path d="M8 16l4-8 4 8M9.4 13.2h5.2" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <defs><linearGradient id="fi-app" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#7cc4ff" /><stop offset="1" stopColor="#2f6fe0" /></linearGradient></defs>
      </svg>
    )
  }
  const kind = kindOf(e)
  const band = /image/i.test(kind) ? '#34c759' : /PDF/.test(kind) ? '#ff3b30' : /code|Markdown/i.test(kind) ? '#8e8e93' : /archive|disk image|installer/i.test(kind) ? '#ff9500' : /spreadsheet/i.test(kind) ? '#30a14e' : /presentation/i.test(kind) ? '#ff9f0a' : /video|audio/i.test(kind) ? '#af52de' : '#64a3f2'
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="fi-icon">
      <path d="M6 2.8h8.2L19 7.6v12.1a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.7V4.3a1.5 1.5 0 0 1 1-1.5z" fill="#f5f6f8" stroke="#c9ccd3" strokeWidth=".8" />
      <path d="M14.2 2.8v3.3a1.5 1.5 0 0 0 1.5 1.5H19" fill="#e3e6eb" stroke="#c9ccd3" strokeWidth=".8" />
      <rect x="5.4" y="14.5" width="13.2" height="4" rx=".8" fill={band} />
    </svg>
  )
}

const svg = (d: ReactNode): ReactElement => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
const PLACE_ICONS: Record<FinderPlace['kind'], ReactElement> = {
  recents: svg(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>),
  home: svg(<path d="M4 11l8-6.5 8 6.5M6 9.5V19h12V9.5" />),
  desktop: svg(<><rect x="3.5" y="4.5" width="17" height="12" rx="1.5" /><path d="M9 20h6M12 16.5V20" /></>),
  documents: svg(<><path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20z" /><path d="M14 3.5V8h4" /></>),
  downloads: svg(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5v8M8.5 12.5l3.5 3.5 3.5-3.5" /></>),
  applications: svg(<path d="M6 19l6-14 6 14M8.6 13.5h6.8" />),
  folder: svg(<path d="M3.5 7a1.5 1.5 0 0 1 1.5-1.5h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" />),
  icloud: svg(<path d="M7 18.5h10.5a4 4 0 0 0 .5-8 6 6 0 0 0-11.4-1.3A4.7 4.7 0 0 0 7 18.5z" />),
  cloud: svg(<><path d="M7 18.5h10.5a4 4 0 0 0 .5-8 6 6 0 0 0-11.4-1.3A4.7 4.7 0 0 0 7 18.5z" /><path d="M10 14.5l2-3 2 3" /></>),
  volume: svg(<><rect x="3.5" y="7" width="17" height="10" rx="2" /><path d="M7 14h.01M16 14h2" /></>),
  computer: svg(<><rect x="4" y="5" width="16" height="10.5" rx="1.5" /><path d="M2.5 19h19" /></>)
}

export default function FinderTab({ tab, active }: { tab: Tab; active: boolean }): ReactElement {
  const settings = useStore((s) => s.settings)
  const toast = useStore((s) => s.toast)
  const request = useStore((s) => s.finderRequest)
  const [places, setPlaces] = useState<FinderPlaces | null>(null)
  const [loc, setLoc] = useState<string | null>(null)
  const locRef = useRef(loc)
  locRef.current = loc
  useEffect(() => registerWorkspaceContext('finder', () => locRef.current ? { id: tab.id, kind: 'finder', path: locRef.current } : null), [tab.id])
  const [history, setHistory] = useState<{ back: string[]; fwd: string[] }>({ back: [], fwd: [] })
  const [entries, setEntries] = useState<Entry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [sel, setSel] = useState<string[]>([])
  const [sort, setSort] = useState<FinderSort>(() => read(SORT_KEY, { key: 'name', dir: 1 } as FinderSort))
  const [showHidden, setShowHidden] = useState(() => read(HIDDEN_KEY, false))
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Entry[] | null>(null)
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null)
  const [menu, setMenu] = useState<{ anchor: HTMLElement; entry?: Entry; place?: FinderPlace } | null>(null)
  /** Open With's submenu: the row it opens beside, and the apps (null while they load). */
  const [sub, setSub] = useState<HTMLElement | null>(null)
  const [apps, setApps] = useState<OpenWithApp[] | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [dropFav, setDropFav] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const anchorEl = useRef<HTMLDivElement>(null)
  const typeAhead = useRef<{ text: string; at: number }>({ text: '', at: 0 })
  /** A file Go to Folder named: selected once its folder has loaded (loading clears the selection). */
  const pendingSel = useRef<string | null>(null)
  const lastClick = useRef<string | null>(null)

  const loadPlaces = useCallback(() => void window.api.invoke('finder:places').then(setPlaces, (e: Error) => toast('error', e.message)), [toast])
  useEffect(() => { loadPlaces() }, [loadPlaces, settings?.finderExtra, settings?.finderHidden])
  // The Finder sidebar may change while the app runs; read it again whenever the tab comes back to the front.
  useEffect(() => { if (active) loadPlaces() }, [active]) // eslint-disable-line react-hooks/exhaustive-deps

  // Where to start: the last place, else the home folder.
  useEffect(() => {
    if (loc || !places) return
    setLoc(read<string | null>(LOC_KEY, null) ?? places.home)
  }, [places]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (request) { go(request.path); useStore.getState().set({ finderRequest: null }) }
  }, [request?.nonce]) // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async (where: string, quiet = false): Promise<void> => {
    if (!quiet) { setLoading(true); setError(null) }
    try {
      const list = where === RECENTS ? await window.api.invoke('finder:recents') : await window.api.invoke('local:list', where)
      setEntries(list)
      if (!quiet) { setSel(pendingSel.current ? [pendingSel.current] : []); pendingSel.current = null }
    } catch (e) {
      if (!quiet) { setEntries([]); setError((e as Error).message.replace(/^[A-Z]+: /, '')) }
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [])
  useEffect(() => {
    if (!loc) return
    write(LOC_KEY, loc)
    setQuery('')
    setResults(null)
    void load(loc)
  }, [loc, load])
  // Changes made outside the app show up within a few seconds, as in Finder.
  useEffect(() => {
    if (!active || !loc || loc === RECENTS) return
    const t = setInterval(() => { if (!renaming && document.hasFocus()) void load(loc, true) }, 4000)
    return () => clearInterval(t)
  }, [active, loc, renaming, load])

  // Spotlight search inside this folder, as the user types.
  useEffect(() => {
    const q = query.trim()
    if (!q || !loc || loc === RECENTS) { setResults(null); return }
    const t = setTimeout(() => void window.api.invoke('finder:search', q, loc).then(setResults, () => setResults([])), 250)
    return () => clearTimeout(t)
  }, [query, loc])

  const go = (where: string): void => {
    if (where === loc) return
    setHistory((h) => ({ back: loc ? [...h.back.slice(-49), loc] : h.back, fwd: [] }))
    setLoc(where)
  }
  const goBack = (): void => {
    const prev = history.back.at(-1)
    if (!prev || !loc) return
    setHistory((h) => ({ back: h.back.slice(0, -1), fwd: [loc, ...h.fwd] }))
    setLoc(prev)
  }
  const goForward = (): void => {
    const next = history.fwd[0]
    if (!next || !loc) return
    setHistory((h) => ({ back: [...h.back, loc], fwd: h.fwd.slice(1) }))
    setLoc(next)
  }

  // ----- Go to Folder (⇧⌘G, or a click on the title): any path, hidden folders included -----
  const [goto, setGoto] = useState<{ text: string; error?: string } | null>(null)
  const [hints, setHints] = useState<Entry[]>([])
  const [hintAt, setHintAt] = useState(-1)
  const home = places?.home ?? ''
  const here = loc && loc !== RECENTS ? loc : home
  const openGoto = (): void => { setGoto({ text: loc && loc !== RECENTS ? `${tildePath(loc, home).replace(/\/$/, '')}/` : '~/' }); setHintAt(-1) }
  // The folders under what is typed so far, as Finder offers them.
  useEffect(() => {
    if (!goto) { setHints([]); return }
    const { dir, partial } = typedParts(goto.text)
    let gone = false
    const t = setTimeout(() => void window.api.invoke('local:list', resolveTyped(dir || '.', home, here)).then(
      (list) => { if (!gone) { setHints(folderHints(list, partial, showHidden)); setHintAt(-1) } },
      () => { if (!gone) setHints([]) }), 120)
    return () => { gone = true; clearTimeout(t) }
  }, [goto?.text, home, here, showHidden]) // eslint-disable-line react-hooks/exhaustive-deps
  const completion = (h: Entry): string => { const { dir } = typedParts(goto?.text ?? ''); return `${dir === '~' ? '~/' : dir}${h.name}/` }
  const submitGoto = async (text: string): Promise<void> => {
    if (!text.trim()) return
    const target = resolveTyped(text, home, here)
    const shownName = tildePath(target, home)
    try {
      await window.api.invoke('local:list', target)
      setGoto(null)
      go(target)
      return
    } catch { /* not a folder that can be listed: a file, a locked folder, or nothing */ }
    const parent = parentOf(target)
    const name = target.slice(parent === '/' ? 1 : parent.length + 1)
    const found = (await window.api.invoke('local:list', parent).catch(() => null))?.find((x) => x.name === name)
    if (!found) { setGoto({ text, error: `There is no folder at ${shownName}.` }); return }
    setGoto(null)
    // A locked folder opens to its own error, as clicking it does; a file opens its folder with the file selected.
    if (found.type === 'dir') { go(target); return }
    if (name.startsWith('.') && !showHidden) setShowHidden(true)
    if (parent === loc) setSel([found.path])
    else { pendingSel.current = found.path; go(parent) }
  }
  const gotoKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setGoto(null) }
    else if (e.key === 'Enter') { e.preventDefault(); void submitGoto(hintAt >= 0 && hints[hintAt] ? completion(hints[hintAt]) : goto?.text ?? '') }
    else if (e.key === 'Tab' && hints.length) { e.preventDefault(); setGoto({ text: completion(hints[Math.max(0, hintAt)]) }) }
    else if (e.key === 'ArrowDown' && hints.length) { e.preventDefault(); setHintAt((i) => Math.min(hints.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp' && hints.length) { e.preventDefault(); setHintAt((i) => Math.max(-1, i - 1)) }
  }

  const shown: Entry[] = useMemo(() => {
    const base = results ?? entries
    const visible = showHidden ? base : base.filter((e) => !e.name.startsWith('.'))
    if (loc === RECENTS && !results) return [...visible].sort((a, b) => ((sort.key === 'mtime' ? (a.lastUsed ?? 0) - (b.lastUsed ?? 0) : 0) * sort.dir) || (sort.key === 'mtime' ? 0 : sortEntries([a, b], sort)[0] === a ? -1 : 1))
    return sortEntries(visible, sort)
  }, [entries, results, showHidden, sort, loc])
  const selected = shown.filter((e) => sel.includes(e.path))

  const open = (e: Entry): void => {
    if (e.type === 'dir' && !isBundle(e)) go(e.path)
    // STEP, IGES and other models open in the app's CAD viewer; Open With still offers the Mac's apps.
    else if (isCadFile(e.path)) useStore.getState().openCad(e.path)
    else void window.api.invoke('local:open', e.path).catch((err: Error) => toast('error', err.message))
  }
  const quickLook = (): void => { const e = selected[0]; if (e) void window.api.invoke('local:quickLook', e.path) }
  const trash = async (list = selected): Promise<void> => {
    if (!list.length) return
    try {
      await window.api.invoke('local:trash', list.map((e) => e.path))
      toast('success', list.length === 1 ? `“${list[0].name}” moved to the Trash` : `${list.length} items moved to the Trash`)
      setSel([])
      if (loc) void load(loc, true)
    } catch (e) { toast('error', (e as Error).message) }
  }
  const newFolder = async (): Promise<void> => {
    if (!loc || loc === RECENTS) return
    const name = freeName('untitled folder', entries.map((e) => e.name))
    const path = `${loc.replace(/\/$/, '')}/${name}`
    try {
      await window.api.invoke('local:mkdir', path)
      await load(loc, true)
      setSel([path])
      setRenaming({ path, value: name })
    } catch (e) { toast('error', (e as Error).message) }
  }
  const commitRename = async (): Promise<void> => {
    const r = renaming
    setRenaming(null)
    if (!r) return
    const name = r.value.trim()
    const from = entries.find((e) => e.path === r.path)
    if (!from || !name || name === from.name) return
    if (name.includes('/')) { toast('error', 'A name cannot contain “/”.'); return }
    // A plain rename would replace a file of the same name; Finder refuses instead, and so does this.
    if (entries.some((e) => e.path !== from.path && e.name.toLowerCase() === name.toLowerCase())) { toast('error', `The name “${name}” is already taken. Please choose a different name.`); return }
    const to = `${parentOf(from.path).replace(/\/$/, '')}/${name}`
    try {
      await window.api.invoke('local:rename', from.path, to)
      if (loc) await load(loc, true)
      setSel([to])
    } catch (e) { toast('error', (e as Error).message) }
  }
  const copyPaths = (list = selected): void => {
    if (!list.length) return
    void window.api.invoke('clipboard:write', list.map((e) => e.path).join('\n')).then(() => toast('success', list.length === 1 ? 'Path copied' : `${list.length} paths copied`))
  }
  /** The files themselves onto the clipboard, as Finder's Copy: ⌘V pastes them here, in Finder, or in a mail. */
  const copyFiles = (list = selected): void => {
    if (!list.length) return
    window.api.invoke('finder:copy', list.map((e) => e.path)).then(
      () => toast('success', list.length === 1 ? `Copied “${list[0].name}”` : `Copied ${list.length} items`),
      (e: Error) => toast('error', e.message)
    )
  }
  /** Copies items into this folder (Paste) or beside themselves (Duplicate), then selects the copies. */
  const copyInto = async (run: () => Promise<string[]>, count: number): Promise<void> => {
    // A big folder takes a while; say so rather than look stuck.
    const slow = setTimeout(() => toast('info', `Copying ${count === 1 ? '1 item' : `${count} items`}…`), 800)
    try {
      const made = await run()
      if (loc) await load(loc, true)
      setSel(made)
      listRef.current?.querySelector(`[data-path="${CSS.escape(made[made.length - 1] ?? '')}"]`)?.scrollIntoView({ block: 'nearest' })
    } catch (e) { toast('error', (e as Error).message) } finally { clearTimeout(slow) }
  }
  const pasteFiles = (paths: string[]): void => {
    if (!loc || loc === RECENTS) { toast('info', 'Open a folder to paste into.'); return }
    if (!paths.length) { toast('info', 'There are no files on the clipboard. Copy some here or in Finder (⌘C) first.'); return }
    void copyInto(() => window.api.invoke('finder:paste', paths, loc), paths.length)
  }
  const duplicate = (list = selected): void => {
    if (list.length) void copyInto(() => window.api.invoke('finder:duplicate', list.map((e) => e.path)), list.length)
  }
  /** The Paste menu item goes through Edit → Paste too, so it pastes exactly what ⌘V would. */
  const pasteFromMenu = (): void => void window.api.invoke('finder:pasteCommand')
  const openWith = (app: string | null, list = selected): void => {
    if (!list.length) return
    const paths = list.map((e) => e.path)
    const done = app ? window.api.invoke('finder:openWith', paths, app) : window.api.invoke('finder:openWithOther', paths)
    done.catch((e: Error) => toast('error', e.message))
  }
  /** Asks for an item's apps as its menu opens, so Open With is ready by the time the pointer gets there. */
  const loadApps = (e: Entry): void => {
    const key = kindKey(e)
    const known = appsByKind.get(key)
    if (known) { setApps(known); return }
    setApps(null)
    void window.api.invoke('finder:openWithApps', e.path).then(async (list) => {
      const missing = list.map((a) => a.path).filter((p) => !appIcons.has(p))
      if (missing.length) for (const [p, url] of Object.entries(await window.api.invoke('launcher:icons', missing).catch(() => ({})))) appIcons.set(p, url)
      appsByKind.set(key, list)
      setApps(list)
    }, () => setApps([]))
  }
  const inTerminal = (path: string): void => useStore.getState().openTerminal({ cwd: path, newTab: true })
  const setFavorite = (path: string, add: boolean): void => {
    const s = useStore.getState()
    void s.saveSettings(favoritePatch(s.settings ?? {}, path, add)).then(() => toast('success', add ? 'Added to Favorites' : 'Removed from the sidebar here (Finder keeps it)'))
  }
  const isFavorite = (path: string): boolean => !!places?.favorites.some((f) => f.path === path)

  // ----- selection -----
  const clickRow = (e: Entry, ev: { metaKey: boolean; shiftKey: boolean }): void => {
    if (ev.metaKey) setSel((s) => (s.includes(e.path) ? s.filter((p) => p !== e.path) : [...s, e.path]))
    else if (ev.shiftKey && lastClick.current) {
      const a = shown.findIndex((x) => x.path === lastClick.current)
      const b = shown.findIndex((x) => x.path === e.path)
      if (a >= 0 && b >= 0) setSel(shown.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.path))
    } else setSel([e.path])
    if (!ev.shiftKey) lastClick.current = e.path
  }
  const moveSel = (dir: 1 | -1, extend: boolean): void => {
    if (!shown.length) return
    const last = sel.length ? shown.findIndex((x) => x.path === sel[sel.length - 1]) : -1
    const next = Math.max(0, Math.min(shown.length - 1, last < 0 ? (dir > 0 ? 0 : shown.length - 1) : last + dir))
    const p = shown[next].path
    setSel(extend ? [...new Set([...sel, p])] : [p])
    lastClick.current = p
    listRef.current?.querySelector(`[data-path="${CSS.escape(p)}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  // ----- keyboard -----
  const onTabKey = (k: TabKey): boolean => {
    if (k.ctrl) return false
    const el = document.activeElement
    const typing = el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
    switch (k.key) {
      case 'arrowup': if (typing) return false; if (loc && loc !== RECENTS) go(parentOf(loc)); return true
      case 'arrowdown': if (typing) return false; if (selected[0]) open(selected[0]); return true
      case 'o': if (selected[0]) open(selected[0]); return true
      case '[': if (k.shift) return false; goBack(); return true
      case ']': if (k.shift) return false; goForward(); return true
      case 'backspace': if (typing) return false; void trash(); return true
      case 'n': if (k.shift) { void newFolder(); return true } return false
      case 'f': searchRef.current?.focus(); searchRef.current?.select(); return true
      case 'a': if (typing) return false; setSel(shown.map((e) => e.path)); return true
      // ⌥⌘C (Copy as Pathname in Finder) arrives as ç on a US keyboard.
      case 'c': case 'ç': if (typing || !selected.length) return false; if (k.alt) copyPaths(); else copyFiles(); return true
      case 'd': if (typing || !selected.length || k.shift) return false; duplicate(); return true
      case '.': if (!k.shift) return false; setShowHidden((v) => { write(HIDDEN_KEY, !v); return !v }); return true
      case 'g': if (!k.shift) return false; openGoto(); return true
      case 'y': quickLook(); return true
    }
    return false
  }
  const keyRef = useRef(onTabKey)
  keyRef.current = onTabKey
  useEffect(() => {
    if (!active) return
    setTabKeys('finder', (k) => keyRef.current(k))
    return () => setTabKeys('finder', null)
  }, [active])
  const plainKey = useRef<(e: KeyboardEvent) => void>(() => undefined)
  plainKey.current = (e: KeyboardEvent): void => {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector('.modal-backdrop') || document.querySelector('.popover')) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveSel(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey); return }
    if (e.key === ' ') { e.preventDefault(); quickLook(); return }
    if (e.key === 'Enter' && selected.length === 1 && loc !== RECENTS) { e.preventDefault(); setRenaming({ path: selected[0].path, value: selected[0].name }); return }
    if (e.key === 'Escape') { if (query) setQuery(''); else setSel([]); return }
    // Typing a name's first letters selects it, as in Finder.
    if (e.key.length === 1 && /\S/.test(e.key)) {
      const now = Date.now()
      const text = (now - typeAhead.current.at < 900 ? typeAhead.current.text : '') + e.key.toLowerCase()
      typeAhead.current = { text, at: now }
      const hit = shown.find((x) => x.name.toLowerCase().startsWith(text))
      if (hit) { setSel([hit.path]); lastClick.current = hit.path; listRef.current?.querySelector(`[data-path="${CSS.escape(hit.path)}"]`)?.scrollIntoView({ block: 'nearest' }) }
    }
  }
  useEffect(() => {
    if (!active) return
    // On document: the window-level key guard (for the RDP client) stops window listeners for other tabs.
    const down = (e: KeyboardEvent): void => plainKey.current(e)
    document.addEventListener('keydown', down)
    return () => document.removeEventListener('keydown', down)
  }, [active])

  // ⌘V (and the Paste menu item) arrive as a paste event carrying the clipboard's files, wherever they were copied.
  const pasteRef = useRef(pasteFiles)
  pasteRef.current = pasteFiles
  useEffect(() => {
    if (!active) return
    const onPaste = (e: ClipboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (t && t !== document.body && !rootRef.current?.contains(t)) return
      if (document.querySelector('.modal-backdrop')) return
      e.preventDefault()
      pasteRef.current([...(e.clipboardData?.files ?? [])].map((f) => window.api.pathForFile(f)).filter((p) => !!p))
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [active])
  useEffect(() => { if (!menu) setSub(null) }, [menu])

  // ----- drag a folder onto Favorites -----
  const dragRow = (e: Entry) => (ev: DragEvent): void => {
    ev.dataTransfer.setData(PATH_DRAG, e.path)
    ev.dataTransfer.setData('text/plain', e.path)
    ev.dataTransfer.effectAllowed = 'copyLink'
  }
  const dropOnFavorites = (ev: DragEvent): void => {
    setDropFav(false)
    const path = ev.dataTransfer.getData(PATH_DRAG)
    const e = [...entries, ...(results ?? [])].find((x) => x.path === path)
    if (!path || !e || e.type !== 'dir' || isBundle(e)) return
    ev.preventDefault()
    if (!isFavorite(path)) setFavorite(path, true)
  }

  const contextFor = (anchor: HTMLElement, entry?: Entry, place?: FinderPlace): void => {
    if (entry && !sel.includes(entry.path)) setSel([entry.path])
    if (entry && !isBundle(entry)) loadApps(entry)
    setMenu({ anchor, entry, place })
  }
  const openMenuAt = (ev: React.MouseEvent, entry?: Entry, place?: FinderPlace): void => {
    ev.preventDefault()
    const a = anchorEl.current
    if (!a) return
    a.style.left = `${ev.clientX}px`
    a.style.top = `${ev.clientY}px`
    contextFor(a, entry, place)
  }

  const title = loc === RECENTS ? 'Recents' : loc ? (loc === '/' ? 'Macintosh HD' : loc.split('/').filter(Boolean).at(-1) ?? loc) : ''
  const searching = !!query.trim() && loc !== RECENTS
  const place = (p: FinderPlace): ReactElement => (
    <button
      key={p.path + p.kind}
      type="button"
      className={`fi-place ${loc === p.path ? 'on' : ''}`}
      title={p.path}
      onClick={() => go(p.path)}
      onContextMenu={(ev) => openMenuAt(ev, undefined, p)}
    >
      <span className="fi-place-icon">{PLACE_ICONS[p.kind]}</span>
      <span className="truncate">{p.name}</span>
    </button>
  )
  const sortTh = (key: FinderSort['key'], label: string, cls = ''): ReactElement => (
    <button type="button" className={`fi-th ${cls} ${sort.key === key ? 'on' : ''}`} onClick={() => { const next: FinderSort = { key, dir: sort.key === key ? (sort.dir === 1 ? -1 : 1) : key === 'mtime' ? -1 : 1 }; setSort(next); write(SORT_KEY, next) }}>
      {label}{sort.key === key && <span className="fi-sort">{sort.dir === 1 ? '▲' : '▼'}</span>}
    </button>
  )

  return (
    <div ref={rootRef} className="finder">
      <aside className="fi-side" aria-label="Finder sidebar">
        <button type="button" className={`fi-place ${loc === RECENTS ? 'on' : ''}`} onClick={() => go(RECENTS)}>
          <span className="fi-place-icon">{PLACE_ICONS.recents}</span>
          <span>Recents</span>
        </button>
        <div
          className={`fi-group ${dropFav ? 'drop' : ''}`}
          onDragOver={(ev) => { if (ev.dataTransfer.types.includes(PATH_DRAG)) { ev.preventDefault(); setDropFav(true) } }}
          onDragLeave={() => setDropFav(false)}
          onDrop={dropOnFavorites}
        >
          <div className="fi-section">Favorites</div>
          {places?.favorites.map(place)}
          {places && !places.favorites.length && <div className="fi-empty-note">Drag a folder here to keep it in reach.</div>}
        </div>
        {!!places?.locations.length && (
          <div className="fi-group">
            <div className="fi-section">Locations</div>
            {places.locations.map(place)}
          </div>
        )}
      </aside>

      <section className="fi-main">
        <header className="fi-toolbar">
          <span className="fi-nav">
            <button type="button" className="fi-btn" aria-label="Back" title="Back (⌘[)" disabled={!history.back.length} onClick={goBack}><Icon.back /></button>
            <button type="button" className="fi-btn" aria-label="Forward" title="Forward (⌘])" disabled={!history.fwd.length} onClick={goForward}><Icon.forward /></button>
          </span>
          {goto ? (
            <div className="fi-goto">
              <input autoFocus aria-label="Go to folder" value={goto.text} spellCheck={false} autoCapitalize="off" autoCorrect="off"
                placeholder="~/.aws, /usr/local, Projects/app" aria-autocomplete="list" aria-expanded={hints.length > 0}
                onChange={(e) => setGoto({ text: e.target.value })} onKeyDown={gotoKey} onFocus={(e) => e.target.select()} onBlur={() => setGoto(null)} />
              {(hints.length > 0 || goto.error) && (
                <ul className="fi-goto-hints" role="listbox" aria-label="Folders">
                  {goto.error && <li className="fi-goto-error" role="alert">{goto.error}</li>}
                  {hints.map((h, i) => (
                    <li key={h.path} role="option" aria-selected={i === hintAt} className={i === hintAt ? 'on' : ''}
                      onMouseDown={(e) => { e.preventDefault(); void submitGoto(completion(h)) }} onMouseEnter={() => setHintAt(i)}>
                      <FileIcon e={h} size={14} /><span>{h.name}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <h2 className="fi-title"><button type="button" title="Go to folder (⇧⌘G)" onClick={openGoto}>{title}</button></h2>
          )}
          <span className="flex-1" />
          <button type="button" className="fi-btn" aria-label="Go to folder" title="Go to folder: type any path, hidden folders included (⇧⌘G)" onClick={openGoto}>{svg(<><path d="M3.5 7a1.5 1.5 0 0 1 1.5-1.5h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" /><path d="M9 13.5h6M12.5 11l2.5 2.5-2.5 2.5" /></>)}</button>
          <button type="button" className="fi-btn" aria-label="New folder" title="New folder (⌘⇧N)" disabled={!loc || loc === RECENTS} onClick={() => void newFolder()}>{svg(<><path d="M3.5 7a1.5 1.5 0 0 1 1.5-1.5h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" /><path d="M12 10.5v5M9.5 13h5" /></>)}</button>
          <button type="button" className="fi-btn" aria-label="Open in Terminal" title="Open this folder in the Terminal tab" disabled={!loc || loc === RECENTS} onClick={() => loc && inTerminal(loc)}><Icon.console /></button>
          <button type="button" className="fi-btn" aria-label="Quick Look" title="Quick Look (Space)" disabled={!selected.length} onClick={quickLook}>{svg(<><path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></>)}</button>
          <span className="fi-search">
            <Icon.search />
            <input ref={searchRef} aria-label="Search this folder" placeholder={loc === RECENTS ? 'Search' : `Search “${title}”`} disabled={loc === RECENTS} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { setQuery(''); (e.target as HTMLInputElement).blur() } }} />
            {query && <button type="button" aria-label="Clear search" onClick={() => setQuery('')}><Icon.x /></button>}
          </span>
        </header>

        <div className="fi-head" role="row">
          {sortTh('name', 'Name', 'name')}
          {sortTh('mtime', loc === RECENTS ? 'Date Last Opened' : 'Date Modified', 'date')}
          {sortTh('size', 'Size', 'size')}
          {sortTh('kind', 'Kind', 'kind')}
        </div>
        <div ref={listRef} className="fi-list" role="listbox" aria-multiselectable="true" aria-label={title} onClick={(ev) => { if (ev.target === ev.currentTarget) setSel([]) }} onContextMenu={(ev) => { if (ev.target === ev.currentTarget) openMenuAt(ev) }}>
          {searching && <div className="fi-banner">{results ? `${shown.length} found for “${query.trim()}” in ${title}` : `Searching “${query.trim()}”…`}</div>}
          {error && <div className="fi-empty">{/permitted|EPERM|EACCES/i.test(error) ? `macOS has not allowed this app into “${title}”. Allow it in System Settings → Privacy & Security → Files and Folders.` : error}</div>}
          {!error && !loading && !shown.length && <div className="fi-empty">{loc === RECENTS ? 'Nothing opened recently.' : searching ? 'No matches.' : 'This folder is empty.'}</div>}
          {shown.map((e, i) => {
            const on = sel.includes(e.path)
            return (
              <div
                key={e.path}
                data-path={e.path}
                role="option"
                aria-selected={on}
                className={`fi-row ${on ? 'on' : ''} ${i % 2 ? 'alt' : ''} ${e.name.startsWith('.') ? 'hidden-file' : ''}`}
                draggable={!renaming}
                onDragStart={dragRow(e)}
                onClick={(ev) => clickRow(e, ev)}
                onDoubleClick={() => open(e)}
                onContextMenu={(ev) => openMenuAt(ev, e)}
              >
                <span className="fi-cell name">
                  <FileIcon e={e} />
                  {renaming?.path === e.path ? (
                    <input
                      className="fi-rename"
                      autoFocus
                      value={renaming.value}
                      onFocus={(ev) => { const dot = ev.target.value.lastIndexOf('.'); ev.target.setSelectionRange(0, e.type === 'dir' || dot <= 0 ? ev.target.value.length : dot) }}
                      onChange={(ev) => setRenaming({ path: e.path, value: ev.target.value })}
                      onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); void commitRename() } else if (ev.key === 'Escape') { ev.preventDefault(); setRenaming(null) } }}
                      onBlur={() => void commitRename()}
                      onClick={(ev) => ev.stopPropagation()}
                    />
                  ) : (
                    <span className="truncate">{e.name}</span>
                  )}
                  {(searching || loc === RECENTS) && <span className="fi-where truncate">{parentOf(e.path).replace(places?.home ?? '\0', '~')}</span>}
                </span>
                <span className="fi-cell date">{formatDate(loc === RECENTS ? (e.lastUsed ?? e.mtime) : e.mtime)}</span>
                <span className="fi-cell size">{formatSize(e)}</span>
                <span className="fi-cell kind">{kindOf(e)}</span>
              </div>
            )
          })}
        </div>

        <footer className="fi-pathbar">
          {loc && loc !== RECENTS ? pathSteps(loc).map((s, i, all) => (
            <span key={s.path} className="fi-step">
              <button type="button" onClick={() => go(s.path)} onDoubleClick={() => go(s.path)}>
                {i === 0 ? PLACE_ICONS.computer : <FileIcon e={{ name: s.name, type: 'dir' }} size={13} />}
                <span>{s.name}</span>
              </button>
              {i < all.length - 1 && <span className="fi-sep">›</span>}
            </span>
          )) : <span className="muted">Recently opened files on this Mac</span>}
          <span className="flex-1" />
          <span className="muted">{selected.length ? `${selected.length} of ${shown.length} selected` : `${shown.length} item${shown.length === 1 ? '' : 's'}`}</span>
        </footer>
      </section>

      <div ref={anchorEl} className="fi-menu-anchor" style={{ position: 'fixed', width: 1, height: 1 } as CSSProperties} />
      {menu && (
        <Popover anchor={menu.anchor} width={230} onClose={() => setMenu(null)}>
          {menu.place ? (
            <>
              <MenuItem onClick={() => { setMenu(null); go(menu.place!.path) }}>Open</MenuItem>
              <MenuItem onClick={() => { setMenu(null); inTerminal(menu.place!.path) }}>Open in Terminal</MenuItem>
              <MenuItem onClick={() => { setMenu(null); void window.api.invoke('local:reveal', menu.place!.path) }}>Show in Finder</MenuItem>
              <MenuItem onClick={() => { setMenu(null); void window.api.invoke('clipboard:write', menu.place!.path).then(() => toast('success', 'Path copied')) }}>Copy Path</MenuItem>
              {places?.favorites.some((f) => f.path === menu.place!.path) && (
                <>
                  <MenuSep />
                  <MenuItem onClick={() => { setMenu(null); setFavorite(menu.place!.path, false) }}>Remove from Sidebar</MenuItem>
                </>
              )}
            </>
          ) : menu.entry ? (
            // Hovering any other row closes Open With's submenu, as in a Mac menu.
            <div onMouseOver={(ev) => { if (!(ev.target as HTMLElement).closest('[data-submenu]')) setSub(null) }}>
              <MenuItem onClick={() => { setMenu(null); open(menu.entry!) }} hint="⌘O">Open</MenuItem>
              {!isBundle(menu.entry) && (
                <button type="button" data-submenu className="menu-item" aria-haspopup="menu" aria-expanded={!!sub} onMouseEnter={(ev) => setSub(ev.currentTarget)} onClick={(ev) => setSub(ev.currentTarget)}>
                  <span className="min-w-0 flex-1 truncate text-left">Open With</span>
                  <span className="muted shrink-0 text-[11px]">›</span>
                </button>
              )}
              <MenuItem onClick={() => { setMenu(null); quickLook() }} hint="Space">Quick Look</MenuItem>
              <MenuItem onClick={() => { setMenu(null); inTerminal(menu.entry!.type === 'dir' && !isBundle(menu.entry!) ? menu.entry!.path : parentOf(menu.entry!.path)) }}>Open in Terminal</MenuItem>
              <MenuItem onClick={() => { setMenu(null); void window.api.invoke('local:reveal', menu.entry!.path) }}>Show in Finder</MenuItem>
              <MenuSep />
              <MenuItem onClick={() => { setMenu(null); copyFiles() }} hint="⌘C">{selected.length > 1 ? `Copy ${selected.length} Items` : 'Copy'}</MenuItem>
              <MenuItem onClick={() => { setMenu(null); copyPaths() }} hint="⌥⌘C">{selected.length > 1 ? `Copy ${selected.length} Paths` : 'Copy Path'}</MenuItem>
              <MenuItem onClick={() => { setMenu(null); duplicate() }} hint="⌘D">Duplicate</MenuItem>
              <MenuItem disabled={!loc || loc === RECENTS} onClick={() => { setMenu(null); pasteFromMenu() }} hint="⌘V">Paste</MenuItem>
              <MenuSep />
              {selected.length === 1 && loc !== RECENTS && <MenuItem onClick={() => { setMenu(null); setRenaming({ path: menu.entry!.path, value: menu.entry!.name }) }} hint="↩">Rename</MenuItem>}
              {menu.entry.type === 'dir' && !isBundle(menu.entry) && !isFavorite(menu.entry.path) && <MenuItem onClick={() => { setMenu(null); setFavorite(menu.entry!.path, true) }}>Add to Favorites</MenuItem>}
              <MenuItem danger onClick={() => { setMenu(null); void trash() }} hint="⌘⌫">Move to Trash</MenuItem>
            </div>
          ) : (
            <>
              <MenuItem disabled={!loc || loc === RECENTS} onClick={() => { setMenu(null); void newFolder() }} hint="⌘⇧N">New Folder</MenuItem>
              <MenuItem disabled={!loc || loc === RECENTS} onClick={() => { setMenu(null); pasteFromMenu() }} hint="⌘V">Paste</MenuItem>
              <MenuSep />
              <MenuItem disabled={!loc || loc === RECENTS} onClick={() => { setMenu(null); if (loc) inTerminal(loc) }}>Open in Terminal</MenuItem>
              <MenuItem disabled={!loc || loc === RECENTS} onClick={() => { setMenu(null); if (loc) void window.api.invoke('local:reveal', loc) }}>Show in Finder</MenuItem>
              <MenuSep />
              <MenuItem on={showHidden} onClick={() => { setMenu(null); setShowHidden((v) => { write(HIDDEN_KEY, !v); return !v }) }} hint="⌘⇧.">Show Hidden Files</MenuItem>
              <MenuItem onClick={() => { setMenu(null); openGoto() }} hint="⇧⌘G">Go to Folder…</MenuItem>
            </>
          )}
        </Popover>
      )}
      {menu?.entry && sub && (
        // Re-placed once the apps arrive, since the list changes its height.
        <Popover key={apps ? 'apps' : 'loading'} anchor={sub} side width={250} onClose={() => setSub(null)}>
          {!apps && <div className="muted px-3 py-1.5">Looking for apps…</div>}
          {apps && !apps.length && <div className="muted px-3 py-1.5">No app says it opens this.</div>}
          {apps?.map((a, i) => (
            <Fragment key={a.path}>
              <MenuItem title={a.path} onClick={() => { setMenu(null); openWith(a.path) }}>
                <span className="fi-app">
                  {appIcons.get(a.path) ? <img src={appIcons.get(a.path)} alt="" /> : <span className="fi-app-blank" />}
                  <span className="truncate">{a.name}{a.isDefault && <span className="muted"> (default)</span>}</span>
                </span>
              </MenuItem>
              {a.isDefault && i === 0 && apps.length > 1 && <MenuSep />}
            </Fragment>
          ))}
          <MenuSep />
          <MenuItem onClick={() => { setMenu(null); openWith(null) }}>Other…</MenuItem>
        </Popover>
      )}
    </div>
  )
}

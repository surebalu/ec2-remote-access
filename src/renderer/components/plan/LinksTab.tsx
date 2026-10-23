import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactElement } from 'react'
import { allLinkTags, asUrl, domainOf, exportLinksCsv, exportLinksHtml, exportLinksJson, folderAndBelow, folderPath, folderTree, hasTag, tagTree, parseLinksFile, planImport, searchLinks, sortLinks, viewLinks, type ImportPlan, type LinkFolder, type LinkItem, type LinkSort, type LinkView, type ParsedLink } from '@shared/links'
import { relativeDay, ymd } from '@shared/naturalDate'
import { itemsOf, puts, type RecordOp } from '@shared/records'
import { hasBrowser } from '../../quickConnect'
import { applyRecords, useRecords } from '../../records'
import { setTabKeys } from '../../shortcuts'
import { useStore, type Tab } from '../../store'
import { Icon } from '../icons'
import Modal from '../Modal'
import Popover, { MenuItem } from '../Popover'
import { downloadText, NavItem, newId, pickTextFile, typing, UndoBar, useLocal, useLocalSet, useToday } from './parts'
import './plan.css'

/**
 * Links: a bookmark library in the spirit of Anybox (rules and import/export formats in src/shared/links.ts, kept as
 * records). Folders nest, tags cross them, a star marks favourites, and a keyword finds one at once. Search covers
 * the title, address, description, comment, note text, tags and folders. Paste an address in the add box (or drop a
 * link on the list) and the page's title and description are fetched. Import from Anybox on this Mac (its own
 * library, main/anybox.ts) or an export file; export as JSON (everything), HTML (browsers, Anybox) or CSV.
 * Keys: ⌘F or / search, ⌘N add, ↑↓ to move, ↩ to open, ⌫ to delete, Esc to clear.
 */

const VIEWS: { id: LinkView; label: string; icon: () => ReactElement }[] = [
  { id: 'all', label: 'All Links', icon: () => <Icon.bookmark /> },
  { id: 'starred', label: 'Starred', icon: () => <Icon.star /> },
  { id: 'unsorted', label: 'Unsorted', icon: () => <Icon.download /> },
  { id: 'notes', label: 'Notes', icon: () => <Icon.note /> },
  { id: 'files', label: 'Files', icon: () => <Icon.disk /> },
  { id: 'archived', label: 'Archived', icon: () => <Icon.layers /> }
]

const extOf = (l: LinkItem): string => ((l.path ?? l.title).match(/\.([a-z0-9]{1,6})$/i)?.[1] ?? '').toLowerCase()
const sizeLabel = (n?: number): string => (n === undefined ? '' : n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`)
/** A colour per kind of file, for the badge shown where Finder's icon is not available (phones). */
const TYPE_COLORS: [RegExp, string][] = [
  [/^pdf$/, '#e5484d'], [/^(docx?|pages|rtf|odt)$/, '#2b7cd3'], [/^(xlsx?|numbers|csv|tsv|ods)$/, '#1f9d55'], [/^(pptx?|key|odp)$/, '#e8702a'],
  [/^(png|jpe?g|gif|heic|webp|svg|tiff?|bmp)$/, '#8e4ec6'], [/^(zip|gz|tgz|tar|7z|rar|dmg)$/, '#a16207'], [/^(md|txt|log|rtfd)$/, '#64748b'],
  [/^(js|ts|tsx|jsx|py|sh|json|ya?ml|xml|html?|css|java|go|rb|sql|c|cpp|h|swift|kt|rs|ps1|bat)$/, '#0e7490']
]
const typeColor = (ext: string): string => TYPE_COLORS.find(([re]) => re.test(ext))?.[1] ?? '#6b7280'

/** Finder's icon for each file's type (Mac app only), fetched once per path for the page. */
const fileIcons = new Map<string, string>()
function useFileIcons(paths: string[]): Map<string, string> {
  const [, setTick] = useState(0)
  const want = paths.filter((p) => !fileIcons.has(p)).slice(0, 400)
  const key = want.join('\u0000')
  useEffect(() => {
    if (!want.length || !hasBrowser()) return
    for (const p of want) fileIcons.set(p, '')
    void window.api.invoke('launcher:icons', want).then((icons) => {
      for (const [p, url] of Object.entries(icons)) fileIcons.set(p, url)
      setTick((n) => n + 1)
    }, () => undefined)
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return fileIcons
}

/** A link's site icon, a note's icon, or a file's type icon (Finder's, else a coloured badge with its extension). */
function ItemIcon({ link, icons }: { link: LinkItem; icons: Map<string, string> }): ReactElement {
  if (link.kind === 'file') {
    const icon = link.path ? icons.get(link.path) : undefined
    if (icon) return <img className="link-icon" src={icon} alt="" />
    const ext = extOf(link)
    return <span className="link-icon badge" style={{ background: typeColor(ext) }} aria-hidden="true">{(ext || 'file').slice(0, 4).toUpperCase()}</span>
  }
  return <Favicon url={link.url} title={link.title} />
}

/** A site's icon from the site itself, or its first letter when there is none. */
function Favicon({ url, title }: { url?: string; title: string }): ReactElement {
  const [failed, setFailed] = useState(false)
  const host = domainOf(url)
  if (!host || failed || !/^https?:/i.test(url ?? '')) {
    return <span className="link-icon letter" aria-hidden="true">{url ? (host[0] ?? title[0] ?? '?').toUpperCase() : <Icon.note />}</span>
  }
  return <img className="link-icon" src={`${new URL(url!).origin}/favicon.ico`} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
}

export default function LinksTab({ active }: { tab: Tab; active: boolean }): ReactElement {
  const toast = useStore((s) => s.toast)
  const openBrowser = useStore((s) => s.openBrowser)
  const { doc, error } = useRecords('links')
  const today = useToday()
  const [view, setView] = useLocal<LinkView>('links.view', 'all')
  const [sort, setSort] = useLocal<LinkSort>('links.sort', 'added')
  const [layout, setLayout] = useLocal<'list' | 'cards'>('links.layout', 'list')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [undo, setUndo] = useState<{ label: string; key: number; ops: RecordOp[] } | null>(null)
  const [menu, setMenu] = useState<{ kind: 'import' | 'export' | 'folder'; anchor: HTMLElement; folder?: LinkFolder } | null>(null)
  const [pending, setPending] = useState<{ source: string; links: ParsedLink[]; plan: ImportPlan; note?: string } | null>(null)
  const [adding, setAdding] = useState(false)
  /** Why Anybox's library could not be read (macOS privacy), with the file import offered instead. */
  const [anyboxHelp, setAnyboxHelp] = useState<string | null>(null)
  const [newFolder, setNewFolder] = useState<{ parentId?: string } | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const addRef = useRef<HTMLInputElement>(null)

  const links = useMemo(() => (doc ? itemsOf<LinkItem>(doc, 'link') : []), [doc])
  const folders = useMemo(() => (doc ? itemsOf<LinkFolder>(doc, 'folder') : []), [doc])
  const folderById = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders])
  const tree = useMemo(() => folderTree(folders), [folders])
  const tags = useMemo(() => allLinkTags(links.filter((l) => !l.archived)), [links])
  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const v of VIEWS) c[v.id] = viewLinks(v.id, links, folders).length
    for (const f of folders) c[`folder:${f.id}`] = viewLinks(`folder:${f.id}`, links, folders).length
    return c
  }, [links, folders])
  const folder = view.startsWith('folder:') ? folderById.get(view.slice(7)) : undefined
  // The folder and tag trees: what is open is remembered; the way to the list on screen is always open.
  const [openFolders, toggleFolder, setOpenFolders] = useLocalSet('links.openFolders')
  const [openTags, toggleTag, setOpenTags] = useLocalSet('links.openTags')
  const parents = useMemo(() => new Set(folders.map((f) => f.parentId).filter((x): x is string => !!x)), [folders])
  const shownFolders = useMemo(() => {
    const reveal = new Set<string>()
    for (let f = folder?.parentId ? folderById.get(folder.parentId) : undefined, i = 0; f && i < 50; f = f.parentId ? folderById.get(f.parentId) : undefined, i++) reveal.add(f.id)
    const isOpen = (id: string): boolean => openFolders.has(id) || reveal.has(id)
    return tree.filter(({ folder: f }) => {
      for (let p = f.parentId ? folderById.get(f.parentId) : undefined, i = 0; p && i < 50; p = p.parentId ? folderById.get(p.parentId) : undefined, i++) if (!isOpen(p.id)) return false
      return true
    }).map((x) => ({ ...x, open: isOpen(x.folder.id) }))
  }, [tree, folderById, openFolders, folder])
  const tagNodes = useMemo(() => tagTree(tags), [tags])
  const shownTags = useMemo(() => {
    const current = view.startsWith('tag:') ? view.slice(4) : ''
    const isOpen = (path: string): boolean => openTags.has(path) || current.startsWith(`${path}/`)
    return tagNodes.filter((n) => {
      const parts = n.path.split('/')
      for (let i = 1; i < parts.length; i++) if (!isOpen(parts.slice(0, i).join('/'))) return false
      return true
    }).map((n) => ({ ...n, open: isOpen(n.path) }))
  }, [tagNodes, openTags, view])
  useEffect(() => { if (view.startsWith('folder:') && doc && !folder) setView('all') }, [view, doc, folder]) // eslint-disable-line react-hooks/exhaustive-deps

  // A search looks through everything; otherwise the view, sorted.
  const list = useMemo(() => (query.trim() ? searchLinks(links.filter((l) => !l.archived), query, folderById) : sortLinks(viewLinks(view, links, folders), sort)), [query, links, folders, folderById, view, sort])
  const current = selected ? links.find((l) => l.id === selected) : undefined
  const icons = useFileIcons(useMemo(() => list.filter((l) => l.kind === 'file' && l.path).map((l) => l.path!), [list]))

  const save = (l: LinkItem, patch: Partial<LinkItem>): void => {
    const next = { ...l, ...patch }
    for (const k of Object.keys(patch) as (keyof LinkItem)[]) if (patch[k] === undefined || patch[k] === '') delete next[k]
    void applyRecords('links', puts([next]))
  }
  const remove = (items: LinkItem[]): void => {
    void applyRecords('links', items.map((l) => ({ op: 'delete', id: l.id })))
    setUndo({ label: items.length === 1 ? `Deleted “${items[0].title}”` : `Deleted ${items.length} links`, key: Date.now(), ops: puts(items) })
    setSelected(null)
  }
  const open = (l: LinkItem, external = false): void => {
    if (l.kind === 'file' && l.path) {
      // Files live on the Mac and open in their own app there.
      if (!hasBrowser()) { toast('info', 'Files open in the Mac app.'); return }
      void window.api.invoke('local:open', l.path).then(() => save(l, { openedAt: Date.now() }), (e: Error) => toast('error', e.message))
      return
    }
    if (!l.url) { setSelected(l.id); return }
    if (external || !hasBrowser() || !/^https?:/i.test(l.url)) void window.api.invoke('shell:open', l.url)
    else openBrowser({ url: l.url })
    save(l, { openedAt: Date.now() })
  }

  /** What the view puts on a new link: its folder, its tag, a star. */
  const defaults = (): Partial<LinkItem> => ({
    ...(folder ? { folderId: folder.id } : {}), ...(view.startsWith('tag:') ? { tags: [view.slice(4)] } : {}), ...(view === 'starred' ? { starred: true } : {})
  })
  const addText = async (raw: string): Promise<void> => {
    const text = raw.trim()
    if (!text) return
    const url = asUrl(text)
    const now = Date.now()
    if (!url) {
      const note: LinkItem = { id: newId(), type: 'link', kind: 'note', title: text, text: '', addedAt: now, updatedAt: now, ...defaults() }
      await applyRecords('links', puts([note]))
      setSelected(note.id)
      return
    }
    const dupe = links.find((l) => l.url && domainOf(l.url) === domainOf(url) && l.url.replace(/\/+$/, '') === url.replace(/\/+$/, ''))
    if (dupe) { setSelected(dupe.id); toast('info', 'Already saved.'); return }
    const link: LinkItem = { id: newId(), type: 'link', kind: 'link', url, title: domainOf(url) || url, addedAt: now, updatedAt: now, ...defaults() }
    await applyRecords('links', puts([link]))
    setSelected(link.id)
    // The page's own title and description, when it answers.
    if (/^https?:/i.test(url)) {
      try {
        const p = await window.api.invoke('links:preview', url)
        if (p.title || p.description) save(link, { title: p.title ?? link.title, description: p.description })
      } catch { /* kept with its address as the title */ }
    }
  }

  const prepareImport = (source: string, parsed: ParsedLink[], note?: string): void => {
    if (!parsed.length) { toast('info', `Nothing to import from ${source}.`); return }
    setPending({ source, links: parsed, plan: planImport({ links, folders }, parsed, newId), note })
  }
  const importAnybox = async (): Promise<void> => {
    try {
      const lib = await window.api.invoke('links:anybox')
      prepareImport('Anybox on this Mac', lib.links, lib.skippedFiles ? `${lib.skippedFiles} files Anybox keeps (documents, images) stay in Anybox.` : undefined)
    } catch (e) { setAnyboxHelp((e as Error).message) }
  }
  const importFile = async (): Promise<void> => {
    const file = await pickTextFile('.json,.html,.htm,.csv,application/json,text/html,text/csv')
    if (!file) return
    try {
      const r = parseLinksFile(file.text, file.name)
      prepareImport(`${file.name} (${r.format})`, r.links)
    } catch (e) { toast('error', (e as Error).message) }
  }
  const doExport = (format: 'json' | 'html' | 'csv'): void => {
    const name = `Links ${ymd(new Date())}`
    if (format === 'json') downloadText(`${name}.json`, exportLinksJson(links, folders), 'application/json')
    else if (format === 'html') downloadText(`${name}.html`, exportLinksHtml(links, folders), 'text/html')
    else downloadText(`${name}.csv`, exportLinksCsv(links, folders), 'text/csv')
  }

  // Keys.
  useEffect(() => {
    if (!active) return
    setTabKeys('links', (k) => {
      if (k.shift || k.alt) return false
      if (k.key === 'f') { searchRef.current?.focus(); searchRef.current?.select(); return true }
      if (k.key === 'n') { setAdding(true); setTimeout(() => addRef.current?.focus(), 0); return true }
      return false
    })
    return () => setTabKeys('links', null)
  }, [active])
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined)
  keyRef.current = (e: KeyboardEvent): void => {
    if (typing(e) || e.metaKey || e.ctrlKey || e.altKey || pending || document.querySelector('.modal-backdrop')) return
    const at = list.findIndex((l) => l.id === selected)
    const k = e.key.toLowerCase()
    if (k === '/') { e.preventDefault(); searchRef.current?.focus() } else if (k === 'arrowdown' || k === 'j') { e.preventDefault(); setSelected(list[Math.min(list.length - 1, at + 1)]?.id ?? null) } else if (k === 'arrowup' || k === 'k') { e.preventDefault(); setSelected(list[Math.max(0, at - 1)]?.id ?? list[0]?.id ?? null) } else if (k === 'enter' && current) { e.preventDefault(); open(current) } else if ((k === 'backspace' || k === 'delete') && current) { e.preventDefault(); remove([current]) } else if (k === 'escape') { setSelected(null); setQuery('') }
  }
  useEffect(() => {
    if (!active) return
    const on = (e: KeyboardEvent): void => keyRef.current(e)
    document.addEventListener('keydown', on)
    return () => document.removeEventListener('keydown', on)
  }, [active])

  // A link dropped from a page or another app.
  const onDrop = (e: DragEvent): void => {
    const uri = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')
    const url = uri && asUrl(uri.split('\n').find((l) => l && !l.startsWith('#')) ?? '')
    if (!url) return
    e.preventDefault()
    void addText(url)
  }

  const title = query.trim() ? `Search` : folder ? folder.name : view.startsWith('tag:') ? `#${view.slice(4)}` : VIEWS.find((v) => v.id === view)?.label ?? 'Links'

  return (
    <section className="plan links" aria-label="Links">
      <div className="plan-frame">
        <aside className="plan-side" aria-label="Link lists">
          {VIEWS.map((v) => <NavItem key={v.id} icon={v.icon()} label={v.label} count={counts[v.id]} on={!query && view === v.id} onClick={() => { setQuery(''); setView(v.id) }} />)}
          <h4>Folders
            <span className="plan-head-actions">
              {parents.size > 0 && <>
                <button type="button" className="plan-add" aria-label="Expand all folders" title="Expand all" onClick={() => setOpenFolders([...parents])}><Icon.expandAll /></button>
                <button type="button" className="plan-add" aria-label="Collapse all folders" title="Collapse all" onClick={() => setOpenFolders([])}><Icon.collapseAll /></button>
              </>}
              <button type="button" className="plan-add" aria-label="New folder" title="New folder" onClick={() => setNewFolder({})}><Icon.plus /></button>
            </span>
          </h4>
          {shownFolders.map(({ folder: f, depth, open }) => (
            <NavItem key={f.id} icon={<Icon.folder />} label={f.name} depth={depth} count={counts[`folder:${f.id}`]} on={!query && view === `folder:${f.id}`}
              tree={{ open, hasChildren: parents.has(f.id), onToggle: () => toggleFolder(f.id) }}
              onClick={() => { setQuery(''); setView(`folder:${f.id}`) }} onContextMenu={(e) => { e.preventDefault(); setMenu({ kind: 'folder', anchor: e.currentTarget, folder: f }) }} />
          ))}
          {newFolder && (
            <input className="input plan-side-input" autoFocus placeholder={newFolder.parentId ? `Inside ${folderById.get(newFolder.parentId)?.name ?? 'folder'}` : 'Folder name'} aria-label="New folder name"
              onBlur={() => setNewFolder(null)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setNewFolder(null)
                if (e.key !== 'Enter') return
                const name = e.currentTarget.value.trim()
                const parentId = newFolder.parentId
                setNewFolder(null)
                if (!name) return
                const f: LinkFolder = { id: newId(), type: 'folder', name, order: folders.reduce((m, x) => Math.max(m, x.order), 0) + 1, updatedAt: Date.now(), ...(parentId ? { parentId } : {}) }
                void applyRecords('links', puts([f]))
                setView(`folder:${f.id}`)
              }} />
          )}
          {!folders.length && !newFolder && <p className="plan-side-hint">Folders and tags come over when you import from Anybox.</p>}
          {tags.length > 0 && (
            <h4>Tags
              {tagNodes.some((n) => n.hasChildren) && (
                <span className="plan-head-actions">
                  <button type="button" className="plan-add" aria-label="Expand all tags" title="Expand all" onClick={() => setOpenTags(tagNodes.filter((n) => n.hasChildren).map((n) => n.path))}><Icon.expandAll /></button>
                  <button type="button" className="plan-add" aria-label="Collapse all tags" title="Collapse all" onClick={() => setOpenTags([])}><Icon.collapseAll /></button>
                </span>
              )}
            </h4>
          )}
          {shownTags.map((n) => (
            <NavItem key={n.path} icon={<span className="plan-hash">#</span>} label={n.name} title={n.path} depth={n.depth} count={links.filter((l) => !l.archived && hasTag(l, n.path)).length}
              on={!query && view === `tag:${n.path}`} tree={{ open: n.open, hasChildren: n.hasChildren, onToggle: () => toggleTag(n.path) }}
              onClick={() => { setQuery(''); setView(`tag:${n.path}`) }} />
          ))}
        </aside>

        <div className="plan-main" onDragOver={(e) => { if ([...e.dataTransfer.types].some((t) => t === 'text/uri-list' || t === 'text/plain')) e.preventDefault() }} onDrop={onDrop}>
          <header className="plan-head links-head">
            <h1>{title}</h1>
            <span className="plan-sub">{list.length} {list.length === 1 ? 'item' : 'items'}</span>
            <span className="flex-1" />
            <label className="links-search">
              <Icon.search />
              <input ref={searchRef} value={query} placeholder="Search links, notes, tags…" aria-label="Search links" onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => {
                if (e.key === 'Escape') { setQuery(''); e.currentTarget.blur() }
                if (e.key === 'Enter' && list[0]) { e.preventDefault(); open(list[0], e.metaKey) }
                if (e.key === 'ArrowDown') { e.preventDefault(); e.currentTarget.blur(); setSelected(list[0]?.id ?? null) }
              }} />
            </label>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => { setAdding(true); setTimeout(() => addRef.current?.focus(), 0) }}><Icon.plus />Add</button>
            <button type="button" className="btn btn-sm" onClick={(e) => setMenu({ kind: 'import', anchor: e.currentTarget })}><Icon.download />Import</button>
            <button type="button" className="btn btn-sm" onClick={(e) => setMenu({ kind: 'export', anchor: e.currentTarget })} disabled={!links.length}><Icon.share />Export</button>
          </header>
          <div className="links-bar">
            <span className="plan-segment" role="radiogroup" aria-label="Layout">
              <button type="button" role="radio" aria-checked={layout === 'list'} className={layout === 'list' ? 'on' : ''} onClick={() => setLayout('list')} aria-label="List"><Icon.list /></button>
              <button type="button" role="radio" aria-checked={layout === 'cards'} className={layout === 'cards' ? 'on' : ''} onClick={() => setLayout('cards')} aria-label="Cards"><Icon.grid /></button>
            </span>
            {!query && (
              <select className="input links-sort" value={sort} aria-label="Sort" onChange={(e) => setSort(e.target.value as LinkSort)}>
                <option value="added">Newest first</option><option value="opened">Recently opened</option><option value="title">Title</option><option value="domain">Website</option>
              </select>
            )}
          </div>
          {adding && (
            <form className="tasks-add links-add" onSubmit={(e) => { e.preventDefault(); const v = addRef.current?.value ?? ''; if (addRef.current) addRef.current.value = ''; setAdding(false); void addText(v) }}>
              <Icon.plus className="tasks-add-icon" />
              <input ref={addRef} className="tasks-add-input" placeholder="Paste a link, or type a note's title" aria-label="New link or note" onBlur={(e) => { if (!e.currentTarget.value) setAdding(false) }}
                onKeyDown={(e) => { if (e.key === 'Escape') setAdding(false) }} />
            </form>
          )}
          <div className="links-body">
            <div className={`plan-scroll links-list ${layout}`} onClick={(e) => { if (e.target === e.currentTarget) setSelected(null) }}>
              {error && <div className="plan-error"><Icon.alert />{error}</div>}
              {!doc && !error && <div className="plan-empty">Loading…</div>}
              {doc && !links.length && (
                <div className="plan-empty links-welcome">
                  <Icon.bookmark className="plan-empty-icon" />
                  <p>Your links will live here.</p>
                  <div className="links-welcome-actions">
                    <button type="button" className="btn btn-primary" onClick={() => void importAnybox()}><Icon.download />Import from Anybox</button>
                    <button type="button" className="btn" onClick={() => void importFile()}>Import a file…</button>
                  </div>
                  <p className="muted">Or paste a link with <kbd>⌘N</kbd>, or drop one here.</p>
                </div>
              )}
              {doc && links.length > 0 && !list.length && <div className="plan-empty">{query ? `Nothing matches “${query}”.` : 'Nothing here.'}</div>}
              {list.map((l) => (
                <div key={l.id} className={`link-row ${selected === l.id ? 'selected' : ''}`} onClick={() => setSelected(l.id)} onDoubleClick={() => open(l)} data-link={l.id}>
                  <ItemIcon link={l} icons={icons} />
                  <div className="link-body">
                    <div className="link-title">{l.title}</div>
                    <div className="link-meta">
                      {l.url && <span className="link-domain">{domainOf(l.url) || l.url}</span>}
                      {l.kind === 'note' && <span className="link-domain">Note</span>}
                      {l.kind === 'file' && <span className="link-domain">{[extOf(l).toUpperCase() || 'File', sizeLabel(l.size)].filter(Boolean).join(' · ')}</span>}
                      {layout === 'cards' && (l.description || l.text) && <p className="link-desc">{l.description ?? l.text}</p>}
                      {l.folderId && !folder && folderById.has(l.folderId) && <span className="plan-chip"><Icon.folder />{folderPath(l.folderId, folderById).join(' / ')}</span>}
                      {l.tags?.map((t) => <span key={t} className="plan-chip tag">#{t}</span>)}
                      {l.note && <span className="plan-chip" title={l.note}><Icon.edit /></span>}
                    </div>
                  </div>
                  <span className="link-date">{relativeDay(ymd(new Date(l.addedAt)), today)}</span>
                  <button type="button" className={`link-star ${l.starred ? 'on' : ''}`} aria-label={l.starred ? 'Unstar' : 'Star'} aria-pressed={!!l.starred} onClick={(e) => { e.stopPropagation(); save(l, { starred: l.starred ? undefined : true }) }}><Icon.star /></button>
                  {(l.url || l.path) && <button type="button" className="link-go" aria-label={`Open ${l.title}`} title={hasBrowser() ? 'Open in the Browser (⌘-click: your default browser)' : 'Open'} onClick={(e) => { e.stopPropagation(); open(l, e.metaKey) }}><Icon.external /></button>}
                </div>
              ))}
            </div>
            {current && <LinkDetail key={current.id} link={current} icons={icons} folders={folders} tags={tags} today={today} onSave={(p) => save(current, p)} onOpen={(ext) => open(current, ext)} onDelete={() => remove([current])} onClose={() => setSelected(null)} />}
          </div>
          <UndoBar undo={undo} onUndo={() => { if (undo) void applyRecords('links', undo.ops); setUndo(null) }} onDone={() => setUndo(null)} />
        </div>
      </div>

      {menu?.kind === 'import' && (
        <Popover anchor={menu.anchor} onClose={() => setMenu(null)} width={290}>
          <MenuItem onClick={() => { setMenu(null); void importAnybox() }}><Icon.bookmark />From Anybox on this Mac</MenuItem>
          <MenuItem onClick={() => { setMenu(null); void importFile() }}><Icon.download />From a file… (Anybox, browser, Pinboard, Pocket, CSV)</MenuItem>
        </Popover>
      )}
      {menu?.kind === 'export' && (
        <Popover anchor={menu.anchor} onClose={() => setMenu(null)} width={260}>
          <MenuItem onClick={() => { setMenu(null); doExport('json') }} hint="everything">JSON</MenuItem>
          <MenuItem onClick={() => { setMenu(null); doExport('html') }} hint="browsers, Anybox">HTML bookmarks</MenuItem>
          <MenuItem onClick={() => { setMenu(null); doExport('csv') }} hint="spreadsheets">CSV</MenuItem>
        </Popover>
      )}
      {menu?.kind === 'folder' && menu.folder && (
        <Popover anchor={menu.anchor} onClose={() => setMenu(null)} width={200}>
          <MenuItem onClick={() => { const f = menu.folder!; setMenu(null); const name = window.prompt('Rename folder', f.name)?.trim(); if (name) void applyRecords('links', puts([{ ...f, name }])) }}>Rename…</MenuItem>
          <MenuItem onClick={() => { const f = menu.folder!; setMenu(null); setNewFolder({ parentId: f.id }) }}>New folder inside</MenuItem>
          <MenuItem danger onClick={() => {
            const f = menu.folder!
            setMenu(null)
            const ids = folderAndBelow(f.id, folders)
            const below = folders.filter((x) => ids.has(x.id))
            const inside = links.filter((l) => l.folderId && ids.has(l.folderId))
            if (!window.confirm(`Delete “${f.name}”${below.length > 1 ? ` and ${below.length - 1} folder${below.length === 2 ? '' : 's'} in it` : ''}? ${inside.length ? `Its ${inside.length} link${inside.length === 1 ? '' : 's'} move to Unsorted.` : ''}`)) return
            void applyRecords('links', [...puts(inside.map((l) => { const n = { ...l }; delete n.folderId; return n })), ...below.map((b) => ({ op: 'delete' as const, id: b.id }))])
            if (view.startsWith('folder:')) setView('all')
          }}>Delete…</MenuItem>
        </Popover>
      )}
      {anyboxHelp && (
        <Modal title="Import from Anybox" onClose={() => setAnyboxHelp(null)}>
          <div className="links-import">
            <p>{anyboxHelp}</p>
            <div className="cal-edit-foot">
              <span className="flex-1" />
              <button type="button" className="btn btn-sm" onClick={() => setAnyboxHelp(null)}>Close</button>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => { setAnyboxHelp(null); void importFile() }}>Import a file…</button>
            </div>
          </div>
        </Modal>
      )}
      {pending && (
        <Modal title="Import links" onClose={() => setPending(null)}>
          <div className="links-import">
            <p>From <b>{pending.source}</b>:</p>
            <ul>
              <li><b>{pending.plan.added}</b> new ({(['link', 'note', 'file'] as const).map((k) => [k, pending.links.filter((l) => l.kind === k).length] as const).filter(([, n]) => n).map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`).join(', ')} read)</li>
              {pending.plan.folders > 0 && <li><b>{pending.plan.folders}</b> new folder{pending.plan.folders === 1 ? '' : 's'}</li>}
              {pending.plan.merged > 0 && <li><b>{pending.plan.merged}</b> already saved, given their tags or star</li>}
              {pending.plan.skipped > 0 && <li><b>{pending.plan.skipped}</b> already saved, left as they are</li>}
            </ul>
            {pending.note && <p className="muted">{pending.note}</p>}
            <div className="cal-edit-foot">
              <span className="flex-1" />
              <button type="button" className="btn btn-sm" onClick={() => setPending(null)}>Cancel</button>
              <button type="button" className="btn btn-sm btn-primary" disabled={!pending.plan.ops.length} onClick={() => {
                const p = pending
                setPending(null)
                void applyRecords('links', p.plan.ops).then(() => toast('success', `Imported ${p.plan.added} item${p.plan.added === 1 ? '' : 's'}${p.plan.merged ? `, updated ${p.plan.merged}` : ''}.`))
                setView('all')
              }}>Import</button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  )
}

function LinkDetail({ link, icons, folders, tags, today, onSave, onOpen, onDelete, onClose }: {
  link: LinkItem; icons: Map<string, string>; folders: LinkFolder[]; tags: string[]; today: string
  onSave: (patch: Partial<LinkItem>) => void; onOpen: (external: boolean) => void; onDelete: () => void; onClose: () => void
}): ReactElement {
  const [title, setTitle] = useState(link.title)
  const [url, setUrl] = useState(link.url ?? '')
  const [note, setNote] = useState(link.note ?? '')
  const [text, setText] = useState(link.text ?? '')
  const [keyword, setKeyword] = useState(link.keyword ?? '')
  const [tag, setTag] = useState('')
  const tree = folderTree(folders)
  const commit = (patch: Partial<LinkItem>): void => { if (Object.keys(patch).length) onSave(patch) }
  const addTag = (raw: string): void => {
    const t = raw.trim().replace(/^#/, '')
    if (t && !link.tags?.includes(t)) onSave({ tags: [...(link.tags ?? []), t] })
    setTag('')
  }
  return (
    <aside className="link-detail" aria-label="Link details">
      <div className="link-detail-head">
        <ItemIcon link={link} icons={icons} />
        <span className="flex-1 muted">{link.kind === 'note' ? 'Note' : link.kind === 'file' ? [extOf(link).toUpperCase() || 'File', sizeLabel(link.size)].filter(Boolean).join(' · ') : domainOf(link.url)}</span>
        <button type="button" className="plan-add" aria-label="Close" onClick={onClose}><Icon.x /></button>
      </div>
      <textarea className="link-detail-title" value={title} rows={2} aria-label="Title" onChange={(e) => setTitle(e.target.value)} onBlur={() => { if (title.trim() && title !== link.title) commit({ title: title.trim() }) }} />
      {link.kind === 'link' && (
        <>
          <input className="input link-detail-url" value={url} aria-label="Address" spellCheck={false} onChange={(e) => setUrl(e.target.value)} onBlur={() => { const u = asUrl(url); if (u && u !== link.url) commit({ url: u }) }} />
          <div className="link-detail-actions">
            <button type="button" className="btn btn-sm btn-primary" onClick={() => onOpen(false)}><Icon.external />Open</button>
            {hasBrowser() && <button type="button" className="btn btn-sm" onClick={() => onOpen(true)}>In your browser</button>}
            <button type="button" className="btn btn-sm" onClick={() => void window.api.invoke('clipboard:write', link.url!).then(() => useStore.getState().toast('success', 'Link copied'))}><Icon.copy />Copy</button>
          </div>
          {link.description && <p className="link-detail-desc">{link.description}</p>}
        </>
      )}
      {link.kind === 'file' && link.path && (
        <>
          <p className="link-detail-path" title={link.path}>{link.path.replace(/^\/Users\/[^/]+/, '~')}</p>
          <div className="link-detail-actions">
            <button type="button" className="btn btn-sm btn-primary" onClick={() => onOpen(false)}><Icon.external />Open</button>
            {hasBrowser() && <button type="button" className="btn btn-sm" onClick={() => useStore.getState().openFinder(link.path!.replace(/\/[^/]+$/, ''))}><Icon.finder />Show in Finder</button>}
            <button type="button" className="btn btn-sm" onClick={() => void window.api.invoke('clipboard:write', link.path!).then(() => useStore.getState().toast('success', 'Path copied'))}><Icon.copy />Copy path</button>
          </div>
        </>
      )}
      {link.kind === 'note' && <textarea className="input link-detail-text" value={text} placeholder="Write the note…" aria-label="Note text" rows={8} onChange={(e) => setText(e.target.value)} onBlur={() => { if (text !== (link.text ?? '')) commit({ text }) }} />}
      <label className="link-field"><span>Comment</span>
        <textarea className="input" value={note} placeholder="Why it is worth keeping" rows={3} onChange={(e) => setNote(e.target.value)} onBlur={() => { if (note !== (link.note ?? '')) commit({ note: note || undefined }) }} />
      </label>
      <label className="link-field"><span>Folder</span>
        <select className="input" value={link.folderId ?? ''} onChange={(e) => onSave({ folderId: e.target.value || undefined })}>
          <option value="">Unsorted</option>
          {tree.map(({ folder: f, depth }) => <option key={f.id} value={f.id}>{' '.repeat(depth)}{f.name}</option>)}
        </select>
      </label>
      <div className="link-field"><span>Tags</span>
        <div className="task-tag-list">
          {link.tags?.map((t) => <button key={t} type="button" className="plan-chip tag" title="Remove" onClick={() => onSave({ tags: link.tags!.filter((x) => x !== t).length ? link.tags!.filter((x) => x !== t) : undefined })}>#{t} <Icon.x /></button>)}
          <input className="task-tag-input" list="link-tag-options" value={tag} placeholder="Add tag" aria-label="Add a tag" onChange={(e) => setTag(e.target.value)}
            onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ',') && tag.trim()) { e.preventDefault(); addTag(tag) } }} onBlur={() => { if (tag.trim()) addTag(tag) }} />
          <datalist id="link-tag-options">{tags.filter((t) => !link.tags?.includes(t)).map((t) => <option key={t} value={t} />)}</datalist>
        </div>
      </div>
      <label className="link-field"><span>Keyword</span>
        <input className="input" value={keyword} placeholder="Type it in search to find this at once" onChange={(e) => setKeyword(e.target.value)} onBlur={() => { if (keyword.trim() !== (link.keyword ?? '')) commit({ keyword: keyword.trim() || undefined }) }} />
      </label>
      <div className="link-detail-flags">
        <label><input type="checkbox" checked={!!link.starred} onChange={() => onSave({ starred: link.starred ? undefined : true })} />Starred</label>
        <label><input type="checkbox" checked={!!link.archived} onChange={() => onSave({ archived: link.archived ? undefined : true })} />Archived</label>
      </div>
      <p className="link-detail-dates muted">Added {relativeDay(ymd(new Date(link.addedAt)), today)}{link.openedAt ? ` · opened ${relativeDay(ymd(new Date(link.openedAt)), today)}` : ''}</p>
      <button type="button" className="btn btn-sm btn-ghost link-detail-delete" onClick={onDelete}><Icon.x />Delete</button>
    </aside>
  )
}

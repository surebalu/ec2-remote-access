import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { formatDate } from '@shared/finder'
import { asUrl, domainOf, extOf, folderPath, folderTree, sizeLabel, type LinkFolder, type LinkItem } from '@shared/links'
import { cleanTag, findSaved, panelEntries, savedItem, tagSuggestions, type FrontPage, type LinksPanelMode, type PanelEntry, type PanelScope } from '@shared/linksPanel'
import { itemsOf, newRecordId, puts } from '@shared/records'
import type { AppCommand } from '@shared/types'
import { applyRecords, reloadRecords, useRecords } from '../records'
import { applyAppearance } from '../store'
import { applyUiFont } from '../uiFont'
import { Favicon } from '../components/browser/parts'
import { Icon } from '../components/icons'
import { typeColor, useFileIcons } from '../components/plan/parts'
import './linksPanel.css'

/**
 * The Links panels' page, in their own floating window (main/linksPanel.ts loads the renderer with ?links). Save: the
 * page that was in front when the key was pressed, with its title selected to rename, a comment, tags, a folder and a
 * star, as Anybox's quick save has them; ↵ saves, and a page saved before is updated, not added twice. Find: one field
 * over Links, its tags and folders (src/shared/linksPanel.ts ranks them); ↵ opens, a tag or folder narrows the search
 * to it, ⌘↵ shows it in the Links tab. The app's window carries out anything inside the app (linksPanel:command).
 */

const hide = (): void => void window.api.invoke('linksPanel:hide')
const command = (c: AppCommand): void => void window.api.invoke('linksPanel:command', c)

export default function LinksPanel(): ReactElement {
  const [mode, setMode] = useState<LinksPanelMode>('find')
  /** Changes each time the panel appears, which starts its form or search afresh. */
  const [shown, setShown] = useState(0)
  const card = useRef<HTMLDivElement>(null)
  const { doc } = useRecords('links')

  useEffect(() => {
    const look = (): void => void window.api.invoke('settings:get').then((s) => { applyUiFont(s.uiFont); applyAppearance(s.theme, s.colorTheme) }, () => undefined)
    look()
    // The window stays loaded while hidden and main sends Links' changes only to the app's window: read it again.
    return window.api.on('linksPanel:shown', ({ mode: m, at }) => { setMode(m); setShown(at); look(); void reloadRecords('links') })
  }, [])

  // The window is as tall as the card (plus the margin its shadow needs).
  useEffect(() => {
    const el = card.current
    if (!el) return
    const ro = new ResizeObserver(() => void window.api.invoke('linksPanel:resize', el.offsetHeight + 32).catch(() => undefined))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const links = useMemo(() => (doc ? itemsOf<LinkItem>(doc, 'link') : []), [doc])
  const folders = useMemo(() => (doc ? itemsOf<LinkFolder>(doc, 'folder') : []), [doc])
  return (
    <div className="lp-frame">
      <div className="lp-card" ref={card} data-mode={mode}>
        {mode === 'save' ? <SavePanel key={shown} links={links} folders={folders} /> : <FindPanel key={shown} links={links} folders={folders} />}
      </div>
    </div>
  )
}

// ----- save -----

/** Why the page in front could not be read, in words, with what to do instead. */
function problemText(p: FrontPage): string | null {
  const app = p.app ?? 'The app in front'
  switch (p.problem) {
    case 'not-browser': return `${app} is not a browser: paste the address to save.`
    case 'no-script': return `${app} cannot tell other apps its page. Copy the address there (⌘L, ⌘C) and paste it here.`
    case 'not-allowed': return `macOS has not let this app read ${app}’s page.`
    case 'no-window': return `${app} has no window open: paste the address to save.`
    case 'failed': return `Could not read the page from ${app}: paste the address to save.`
    default: return null
  }
}

function SavePanel({ links, folders }: { links: LinkItem[]; folders: LinkFolder[] }): ReactElement {
  /** null while main is still asking the browser. */
  const [page, setPage] = useState<FrontPage | null>(null)
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [folderId, setFolderId] = useState<string | undefined>()
  const [starred, setStarred] = useState(false)
  const [description, setDescription] = useState<string | undefined>()
  const [open, setOpen] = useState<'tags' | 'folder' | null>(null)
  /** Once saved: whether it was a new link or an update (after saving, the link is found as kept either way). */
  const [done, setDone] = useState<'added' | 'updated' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const urlRef = useRef<HTMLInputElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  /** The saved link whose values were put in the form, so they are put there once. */
  const prefilled = useRef('')

  useEffect(() => {
    let live = true
    const fill = (p: FrontPage): void => {
      if (!live) return
      setPage(p)
      setUrl(p.url)
      setTitle(p.title)
      setTimeout(() => (p.url ? titleRef.current?.select() : urlRef.current?.focus()), 0)
    }
    void window.api.invoke('linksPanel:page').then(fill, () => fill({ url: '', title: '', problem: 'failed' }))
    return () => { live = false }
  }, [])

  const existing = useMemo(() => findSaved(links, url), [links, url])
  // A page saved before comes with what it was saved with, so saving again updates it rather than starting over.
  useEffect(() => {
    if (!existing || prefilled.current === existing.id) return
    prefilled.current = existing.id
    setTitle(existing.title)
    setNote(existing.note ?? '')
    setTags(existing.tags ?? [])
    setFolderId(existing.folderId)
    setStarred(!!existing.starred)
  }, [existing])

  // The page's own title (when the browser gave none) and description, asked of the site for a new link.
  useEffect(() => {
    const u = asUrl(url)
    if (!u || existing || !/^https?:/i.test(u)) return
    const t = setTimeout(() => void window.api.invoke('links:preview', u).then((p) => {
      if (p.title) setTitle((cur) => cur || p.title!)
      setDescription(p.description)
    }, () => undefined), 400)
    return () => clearTimeout(t)
  }, [url, existing])

  const tagCounts = useMemo(() => {
    const n = new Map<string, number>()
    for (const l of links) for (const t of l.tags ?? []) n.set(t, (n.get(t) ?? 0) + 1)
    return [...n].map(([path, count]) => ({ path, count }))
  }, [links])
  const folderById = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders])
  const folderName = folderId ? folderPath(folderId, folderById).join(' / ') : ''

  const save = async (): Promise<void> => {
    const u = asUrl(url)
    if (!u) {
      setError(url.trim() ? 'That is not a web address.' : 'Paste or type the address to save.')
      urlRef.current?.focus()
      return
    }
    const item = savedItem(existing, { url: u, title, note, tags, folderId: folderId && folderById.has(folderId) ? folderId : undefined, starred }, Date.now(), newRecordId)
    if (!existing && description) item.description = description
    setDone(existing ? 'updated' : 'added')
    await applyRecords('links', puts([item]))
    setTimeout(hide, 650)
    if (!existing && !description && /^https?:/i.test(u)) {
      // Saved before the site answered (↵ at once): its description, and a title if none was given, follow. The
      // window stays loaded while hidden, so this finishes after the panel is gone.
      void window.api.invoke('links:preview', u).then((p) => {
        const named = !title.trim() && p.title
        if (p.description || named) void applyRecords('links', puts([{ ...item, ...(p.description ? { description: p.description } : {}), ...(named ? { title: p.title! } : {}) }]))
      }, () => undefined)
    }
  }

  const onKey = (e: ReactKeyboardEvent): void => {
    const k = e.key.toLowerCase()
    if (e.key === 'Escape') {
      e.preventDefault()
      if (open) setOpen(null)
      else hide()
    } else if (e.metaKey && k === 'enter') {
      e.preventDefault()
      void save()
    } else if (e.metaKey && !e.shiftKey && !e.altKey && k === 't') {
      e.preventDefault()
      setOpen((o) => (o === 'tags' ? null : 'tags'))
    } else if (e.metaKey && !e.shiftKey && !e.altKey && k === 'o') {
      e.preventDefault()
      setOpen((o) => (o === 'folder' ? null : 'folder'))
    } else if (e.metaKey && !e.shiftKey && !e.altKey && k === 'd') {
      e.preventDefault()
      setStarred((s) => !s)
    }
  }
  // ↵ in the address, title or comment saves (the tag and folder pickers use ↵ for themselves).
  const enterSaves = (e: ReactKeyboardEvent): void => {
    if (e.key === 'Enter' && !e.metaKey && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void save()
    }
  }

  const problem = page ? problemText(page) : null
  const status: ReactNode = error
    ? <span className="lp-error">{error}</span>
    : done
      ? <span className="lp-ok"><Icon.check />{done === 'updated' ? 'Updated in Links' : 'Saved to Links'}</span>
      : !page
        ? <span className="lp-muted">Reading the page…</span>
        : existing
          ? <span className="lp-muted">In Links since {formatDate(existing.addedAt)}: Save updates it.</span>
          : problem
            ? <span className="lp-muted">{problem}{page.problem === 'not-allowed' && <button type="button" className="lp-link" onClick={() => void window.api.invoke('linksPanel:automation')}>Open Automation settings</button>}</span>
            : page.app ? <span className="lp-muted">From {page.app}</span> : null

  return (
    <div className="lp-save" onKeyDown={onKey}>
      <input ref={urlRef} className="lp-field" aria-label="Address" placeholder="https://…" value={url} spellCheck={false}
        onChange={(e) => { setUrl(e.target.value); setError(null) }} onKeyDown={enterSaves} />
      <input ref={titleRef} className="lp-field lp-title-field" aria-label="Title" placeholder="Title" value={title}
        onChange={(e) => setTitle(e.target.value)} onKeyDown={enterSaves} />
      <input className="lp-field" aria-label="Comment" placeholder="A brief comment to help remember or find this link" value={note}
        onChange={(e) => setNote(e.target.value)} onKeyDown={enterSaves} />
      {open === 'tags' && <TagEditor all={tagCounts} tags={tags} onChange={setTags} onDone={() => { setOpen(null); titleRef.current?.focus() }} />}
      {open !== 'tags' && tags.length > 0 && (
        <div className="lp-chips" aria-label="Tags">
          {tags.map((t) => <span key={t} className="lp-chip">#{t}</span>)}
        </div>
      )}
      {open === 'folder' && <FolderPicker folders={folders} value={folderId} onPick={(id) => { setFolderId(id); setOpen(null); titleRef.current?.focus() }} />}
      <div className="lp-status">{status}</div>
      <div className="lp-actions">
        <button type="button" className={`lp-btn ${open === 'tags' ? 'on' : ''}`} title="Tags (⌘T)" onClick={() => setOpen((o) => (o === 'tags' ? null : 'tags'))}>
          Tags{tags.length > 0 && <span className="lp-count">{tags.length}</span>}
        </button>
        <button type="button" className={`lp-btn ${open === 'folder' ? 'on' : ''}`} title="Folder (⌘O)" onClick={() => setOpen((o) => (o === 'folder' ? null : 'folder'))}>
          <Icon.folder />{folderName || 'Folder'}
        </button>
        <button type="button" className={`lp-star ${starred ? 'on' : ''}`} aria-pressed={starred} aria-label="Star" title="Star (⌘D)" onClick={() => setStarred((s) => !s)}><Icon.star /></button>
        <span className="flex-1" />
        <button type="button" className="lp-btn" onClick={hide}>Cancel</button>
        <button type="button" className="lp-btn primary" disabled={!!done} onClick={() => void save()}>{(done ? done === 'updated' : !!existing) ? 'Update' : 'Save'}</button>
      </div>
    </div>
  )
}

/** Chosen tags as chips, a field to add one, and the tags already used that match what is typed. */
function TagEditor({ all, tags, onChange, onDone }: { all: { path: string; count: number }[]; tags: string[]; onChange: (tags: string[]) => void; onDone: () => void }): ReactElement {
  const [typed, setTyped] = useState('')
  const [hi, setHi] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus() }, [])
  const clean = cleanTag(typed)
  const found = tagSuggestions(all, typed, tags, 7)
  const isNew = !!clean && ![...found, ...tags].some((t) => t.toLowerCase() === clean.toLowerCase())
  const options = isNew ? [...found, clean] : found
  const add = (t: string): void => {
    if (!t) return
    onChange([...tags, t])
    setTyped('')
    setHi(0)
  }
  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((i) => Math.min(options.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((i) => Math.max(0, i - 1)) }
    else if ((e.key === 'Enter' || e.key === 'Tab') && !e.metaKey && !e.nativeEvent.isComposing) {
      if (!options.length && !clean) { if (e.key === 'Enter') { e.preventDefault(); onDone() } return }
      e.preventDefault()
      add(options[Math.min(hi, options.length - 1)] ?? clean)
    } else if (e.key === ',' && clean) { e.preventDefault(); add(clean) }
    else if (e.key === 'Backspace' && !typed && tags.length) onChange(tags.slice(0, -1))
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onDone() }
  }
  return (
    <div className="lp-tags">
      <div className="lp-tag-field" onClick={() => input.current?.focus()}>
        {tags.map((t) => (
          <span key={t} className="lp-chip">#{t}
            <button type="button" aria-label={`Remove ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))}><Icon.x /></button>
          </span>
        ))}
        <input ref={input} aria-label="Add a tag" placeholder={tags.length ? 'Add another' : 'Add a tag (aws/iam nests it under aws)'} value={typed}
          onChange={(e) => { setTyped(e.target.value); setHi(0) }} onKeyDown={onKey} />
      </div>
      {options.length > 0 && (
        <div className="lp-options" role="listbox" aria-label="Tags">
          {options.map((t, i) => (
            <button key={t} type="button" role="option" aria-selected={i === hi} className={`lp-option ${i === hi ? 'on' : ''}`} onMouseMove={() => setHi(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => add(t)}>
              <span className="lp-hash">#</span>{t}{isNew && i === options.length - 1 && <span className="lp-muted"> (new)</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** The folders as a tree, or those matching what is typed, plus "No folder". */
function FolderPicker({ folders, value, onPick }: { folders: LinkFolder[]; value?: string; onPick: (id: string | undefined) => void }): ReactElement {
  const [typed, setTyped] = useState('')
  const [hi, setHi] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => { input.current?.focus() }, [])
  const byId = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders])
  const q = typed.trim().toLowerCase()
  const rows = useMemo(() => {
    const tree = folderTree(folders)
    const shown = q ? tree.filter(({ folder }) => folder.name.toLowerCase().includes(q)).map(({ folder }) => ({ folder, depth: 0 })) : tree
    return [{ folder: undefined as LinkFolder | undefined, depth: 0 }, ...shown]
  }, [folders, q])
  useEffect(() => { list.current?.querySelector('.lp-option.on')?.scrollIntoView({ block: 'nearest' }) }, [hi])
  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((i) => Math.min(rows.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((i) => Math.max(0, i - 1)) }
    else if (e.key === 'Enter' && !e.metaKey && !e.nativeEvent.isComposing) { e.preventDefault(); onPick(rows[hi]?.folder?.id) }
  }
  return (
    <div className="lp-tags">
      <input ref={input} className="lp-field" aria-label="Find a folder" placeholder="Find a folder" value={typed} onChange={(e) => { setTyped(e.target.value); setHi(0) }} onKeyDown={onKey} />
      <div className="lp-options tall" ref={list} role="listbox" aria-label="Folders">
        {rows.map(({ folder, depth }, i) => (
          <button key={folder?.id ?? '-'} type="button" role="option" aria-selected={i === hi} className={`lp-option ${i === hi ? 'on' : ''} ${folder?.id === value ? 'current' : ''}`}
            style={{ paddingLeft: 10 + depth * 14 }} onMouseMove={() => setHi(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(folder?.id)}>
            {folder ? <><Icon.folder />{q ? folderPath(folder.id, byId).join(' / ') : folder.name}</> : <span className="lp-muted">No folder</span>}
            {folder?.id === value && <Icon.check />}
          </button>
        ))}
      </div>
    </div>
  )
}

// ----- find -----

function FindPanel({ links, folders }: { links: LinkItem[]; folders: LinkFolder[] }): ReactElement {
  const [q, setQ] = useState('')
  const [scope, setScope] = useState<PanelScope>(null)
  const [sel, setSel] = useState(0)
  const [flash, setFlash] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => { setTimeout(() => input.current?.focus(), 0) }, [])

  const byId = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders])
  const entries = useMemo(() => panelEntries(links, folders, q, scope), [links, folders, q, scope])
  useEffect(() => setSel(0), [q, scope])
  useEffect(() => { list.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: 'nearest' }) }, [sel])
  useEffect(() => { if (!flash) return; const t = setTimeout(() => setFlash(null), 1500); return () => clearTimeout(t) }, [flash])
  const icons = useFileIcons(useMemo(() => entries.flatMap((e) => (e.kind === 'item' && e.item.kind === 'file' && e.item.path ? [e.item.path] : [])), [entries]))

  const scopeName = scope ? (scope.kind === 'tag' ? `#${scope.path}` : folderPath(scope.id, byId).join(' / ')) : ''
  const used = (l: LinkItem): void => void applyRecords('links', puts([{ ...l, openedAt: Date.now() }]))
  const open = (e: PanelEntry | undefined, how: 'open' | 'reveal' | 'external'): void => {
    if (!e) return
    if (e.kind !== 'item') {
      const view = e.kind === 'tag' ? `tag:${e.path}` : `folder:${e.folder.id}`
      if (how === 'reveal') command({ kind: 'links', view })
      else { setScope(e.kind === 'tag' ? { kind: 'tag', path: e.path } : { kind: 'folder', id: e.folder.id }); setQ('') }
      return
    }
    const l = e.item
    if (how === 'reveal' || l.kind === 'note' || (!l.url && !l.path)) { command({ kind: 'links', id: l.id }); return }
    if (l.kind === 'file' && l.path) {
      used(l)
      void window.api.invoke('local:open', l.path).then(hide, (err: Error) => setFlash(err.message))
      return
    }
    used(l)
    if (how === 'external' || !/^https?:/i.test(l.url!)) { void window.api.invoke('shell:open', l.url!); hide() }
    else command({ kind: 'browse', url: l.url! })
  }
  const copy = (e: PanelEntry | undefined): void => {
    if (!e) return
    const text = e.kind === 'tag' ? `#${e.path}` : e.kind === 'folder' ? folderPath(e.folder.id, byId).join(' / ') : e.item.url ?? e.item.path ?? e.item.text ?? e.item.title
    void window.api.invoke('clipboard:write', text).then(() => setFlash('Copied'), () => undefined)
  }

  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing) return
    const digit = /^Digit([1-9])$/.exec(e.code)?.[1]
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((i) => Math.min(entries.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((i) => Math.max(0, i - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); open(entries[sel], e.metaKey ? 'reveal' : e.altKey ? 'external' : 'open') }
    else if (e.metaKey && digit) { e.preventDefault(); open(entries[Number(digit) - 1], 'open') }
    else if (e.key === 'Tab' && !e.shiftKey && entries[sel] && entries[sel].kind !== 'item') { e.preventDefault(); open(entries[sel], 'open') }
    else if (e.key === 'Escape') { e.preventDefault(); if (q) setQ(''); else if (scope) setScope(null); else hide() }
    else if (e.key === 'Backspace' && !q && scope) { e.preventDefault(); setScope(null) }
    else if (e.metaKey && e.key.toLowerCase() === 'c' && e.currentTarget.selectionStart === e.currentTarget.selectionEnd) { e.preventDefault(); copy(entries[sel]) }
  }

  const row = (e: PanelEntry, i: number): ReactElement => {
    let icon: ReactNode
    let title: string
    let sub: string
    if (e.kind === 'tag') {
      icon = <span className="lp-hash big">#</span>
      title = e.path.split('/').pop() ?? e.path
      sub = [`Tag · ${e.count} item${e.count === 1 ? '' : 's'}`, e.path.includes('/') ? `in #${e.path.split('/').slice(0, -1).join('/')}` : ''].filter(Boolean).join(' · ')
    } else if (e.kind === 'folder') {
      icon = <Icon.folder />
      title = e.folder.name
      const above = folderPath(e.folder.parentId, byId)
      sub = [`Folder · ${e.count} item${e.count === 1 ? '' : 's'}`, above.length ? `in ${above.join(' / ')}` : ''].filter(Boolean).join(' · ')
    } else {
      const l = e.item
      title = l.title
      const where = folderPath(l.folderId, byId).join(' / ')
      const tagText = (l.tags ?? []).map((t) => `#${t}`).join(' ')
      if (l.kind === 'file') {
        const img = l.path ? icons.get(l.path) : undefined
        const ext = extOf(l)
        icon = img ? <img src={img} alt="" /> : <span className="lp-badge" style={{ background: typeColor(ext) }}>{(ext || 'file').slice(0, 4).toUpperCase()}</span>
        sub = [ext.toUpperCase() || 'File', sizeLabel(l.size), where, tagText].filter(Boolean).join(' · ')
      } else if (l.kind === 'note') {
        icon = <Icon.note />
        sub = ['Note', where, tagText].filter(Boolean).join(' · ')
      } else {
        icon = <Favicon url={l.url ?? ''} src={/^https?:/i.test(l.url ?? '') ? `${new URL(l.url!).origin}/favicon.ico` : undefined} size={18} />
        sub = [domainOf(l.url), where, tagText].filter(Boolean).join(' · ')
      }
      if (l.starred) title = `${title} ★`
    }
    return (
      <div key={`${e.kind}:${e.kind === 'tag' ? e.path : e.kind === 'folder' ? e.folder.id : e.item.id}`} className={`lp-row ${i === sel ? 'on' : ''}`} data-i={i} role="option" aria-selected={i === sel}
        onMouseMove={() => { if (sel !== i) setSel(i) }} onMouseDown={(ev) => ev.preventDefault()} onClick={(ev) => open(e, ev.metaKey ? 'reveal' : ev.altKey ? 'external' : 'open')}>
        <span className="lp-icon">{icon}</span>
        <span className="lp-text"><span className="lp-row-title">{title}</span><span className="lp-row-sub">{sub}</span></span>
        {i < 9 && <kbd className="lp-num">⌘{i + 1}</kbd>}
      </div>
    )
  }

  const sel0 = entries[sel]
  return (
    <div className="lp-find">
      <div className="lp-search">
        <Icon.search className="lp-search-icon" />
        {scope && <button type="button" className="lp-scope" title="Search everything again (⌫)" onClick={() => { setScope(null); input.current?.focus() }}>{scopeName}<Icon.x /></button>}
        <input ref={input} aria-label="Search Links" placeholder={scope ? `Search in ${scopeName}` : 'Search links, notes, files, tags and folders'} value={q} spellCheck={false}
          onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} />
      </div>
      <div className="lp-list" ref={list} role="listbox" aria-label="Links">
        {entries.length ? entries.map(row) : (
          <div className="lp-empty">{links.length ? 'Nothing matches.' : 'Nothing in Links yet. Save the page in front with the save key.'}</div>
        )}
      </div>
      <div className="lp-foot">
        {flash ? <span className="lp-ok"><Icon.check />{flash}</span> : (
          <span>↵ {sel0?.kind === 'item' ? (sel0.item.kind === 'note' ? 'Show' : 'Open') : 'Look inside'} · ⌘↵ Show in Links{sel0?.kind === 'item' && sel0.item.kind === 'link' ? ' · ⌥↵ Default browser' : ''} · ⌘C Copy</span>
        )}
        <span className="flex-1" />
        <span>{scope ? 'Esc: everything' : 'Esc: close'}</span>
      </div>
    </div>
  )
}

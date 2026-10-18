import type { CSSProperties, ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, drawSelection, keymap, placeholder } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown'
import { yamlFrontmatter } from '@codemirror/lang-yaml'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { tags } from '@lezer/highlight'
import type { NoteEntry, NoteFile, NoteHit, NotesInfo } from '@shared/types'
import { useStore, type Tab } from '../store'
import { isMobile } from '../mobile'
import { noteToHtml, resolveWikiLink } from '../notesMarkdown'
import { Icon } from './icons'
import Popover, { MenuItem, MenuSep } from './Popover'
import NotesToolbar, { DEFAULT_NOTE_FONT, DEFAULT_NOTE_SIZE, FORMAT_KEYS, noteFontStack, runFormat } from './NotesToolbar'
import { Highlight, highlightTag, livePreview } from '../notesLive'

/**
 * The Notes tab: the notes folder (by default the Obsidian vault, see main/notes.ts) as a tree with search, and one
 * note in a Markdown editor and/or preview. It saves as you type; a note changed by another app (Obsidian) reloads,
 * or asks which version to keep when this one has unsaved edits too. The tab's `notesPath` says which note is open,
 * so other parts of the app (a host's note beside a terminal) open notes by setting it.
 */

type Mode = 'edit' | 'split' | 'preview'
const MODE_KEY = 'ui.notesMode'
const RECENT_KEY = 'ui.notesRecent'
const COLLAPSED_KEY = 'ui.notesCollapsed'
const LIVE_KEY = 'ui.notesLive'

function readPref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : (JSON.parse(v) as T)
  } catch {
    return fallback
  }
}
function writePref(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage unavailable */ }
}

const noteName = (path: string): string => (path.split('/').pop() ?? path).replace(/\.md$/i, '')
const noteFolder = (path: string): string => path.split('/').slice(0, -1).join('/')

// Markdown styling that follows the app's light/dark colours.
const highlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: '1.45em', fontWeight: '700' },
  { tag: tags.heading2, fontSize: '1.25em', fontWeight: '700' },
  { tag: tags.heading3, fontSize: '1.1em', fontWeight: '650' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], fontWeight: '650' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.link, tags.url], color: 'var(--accent)' },
  { tag: tags.monospace, fontFamily: "'SF Mono', ui-monospace, Menlo, monospace", color: 'var(--text-2)' },
  { tag: tags.quote, color: 'var(--muted)', fontStyle: 'italic' },
  { tag: highlightTag, backgroundColor: 'rgba(255, 213, 0, .38)', borderRadius: '2px' },
  // Marks (#, -, >, **) are dim; a list's text (tagged as a whole) keeps the normal colour.
  { tag: [tags.processingInstruction, tags.meta, tags.contentSeparator], color: 'var(--muted)' }
])
const editorTheme = EditorView.theme({
  // Font and size come from the toolbar (Settings.notesFont / notesFontSize) through CSS variables on the tab.
  '&': { height: '100%', backgroundColor: 'var(--bg)', color: 'var(--text)', fontSize: 'var(--notes-size, 14px)' },
  '.cm-scroller': { fontFamily: 'var(--notes-font, Monaco, monospace)', lineHeight: '1.65' },
  '.cm-content': { padding: '18px 24px 40vh', maxWidth: '880px', caretColor: 'var(--text)' },
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--accent-soft-2) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--text)' },
  '.cm-placeholder': { color: 'var(--muted)' }
})

interface Folder { name: string; path: string; folders: Folder[]; files: NoteEntry[] }

function buildTree(entries: NoteEntry[]): Folder {
  const rootFolder: Folder = { name: '', path: '', folders: [], files: [] }
  const folderAt = (path: string): Folder => {
    let f = rootFolder
    for (const part of path ? path.split('/') : []) {
      const sub = f.path ? `${f.path}/${part}` : part
      let next = f.folders.find((x) => x.name === part)
      if (!next) f.folders.push((next = { name: part, path: sub, folders: [], files: [] }))
      f = next
    }
    return f
  }
  for (const e of entries) {
    if (e.folder) folderAt(e.path)
    else folderAt(noteFolder(e.path)).files.push(e)
  }
  const sort = (f: Folder): void => {
    f.folders.sort((a, b) => a.name.localeCompare(b.name))
    f.files.sort((a, b) => noteName(a.path).localeCompare(noteName(b.path)))
    f.folders.forEach(sort)
  }
  sort(rootFolder)
  return rootFolder
}

export default function NotesTab({ tab, active }: { tab: Tab; active: boolean }): ReactElement {
  const toast = useStore((s) => s.toast)
  const updateTab = useStore((s) => s.updateTab)
  const noteFont = useStore((s) => s.settings?.notesFont) ?? DEFAULT_NOTE_FONT
  const noteSize = useStore((s) => s.settings?.notesFontSize) ?? DEFAULT_NOTE_SIZE
  /** Live mode: Markdown marks hidden except on the line being edited (off = the raw Markdown everywhere). */
  const [live, setLiveState] = useState<boolean>(() => readPref<boolean>(LIVE_KEY, true))
  const liveConf = useRef(new Compartment()).current
  const liveOn = useRef(false)
  const selectionSubs = useRef(new Set<() => void>())
  const subscribe = useCallback((fn: () => void) => { selectionSubs.current.add(fn); return () => { selectionSubs.current.delete(fn) } }, [])
  /** What a ⌘-click on a link in the editor opens (kept current for the editor, which is built once per note). */
  const openLink = useRef<(link: { note?: string; url?: string }) => void>(() => undefined)
  const liveExtension = (): ReturnType<typeof livePreview> => livePreview((l) => openLink.current(l))
  const mobile = isMobile()
  const inElectron = /\bElectron\//.test(navigator.userAgent)
  const [info, setInfo] = useState<NotesInfo | null>(null)
  const [entries, setEntries] = useState<NoteEntry[]>([])
  const [filter, setFilter] = useState('')
  const [hits, setHits] = useState<NoteHit[] | null>(null)
  const [mode, setModeState] = useState<Mode>(() => readPref<Mode>(MODE_KEY, mobile ? 'preview' : 'edit'))
  const [current, setCurrent] = useState<NoteFile | null>(null)
  const [status, setStatus] = useState<'saved' | 'dirty' | 'saving' | 'error'>('saved')
  const [conflict, setConflict] = useState<NoteFile | null>(null)
  const [previewText, setPreviewText] = useState('')
  const [creating, setCreating] = useState<'note' | 'folder' | null>(null)
  const [newName, setNewName] = useState('')
  /** Where New note / New folder create: the folder last clicked, or the open note's folder ('' = the top). */
  const [targetFolder, setTargetFolder] = useState('')
  const [renaming, setRenaming] = useState<{ path: string; folder: boolean; value: string } | null>(null)
  const [menu, setMenu] = useState<{ path: string; folder: boolean; anchor: HTMLElement; move?: boolean } | null>(null)
  /** The row being dragged, and the folder it would land in ('' = the top level). */
  const [drag, setDrag] = useState<{ path: string; folder: boolean } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const expandTimer = useRef<{ folder: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  const [recent, setRecent] = useState<string[]>(() => readPref<string[]>(RECENT_KEY, []))
  const [collapsed, setCollapsed] = useState<string[]>(() => readPref<string[]>(COLLAPSED_KEY, []))
  const [mobileView, setMobileView] = useState<'list' | 'note'>(tab.notesPath ? 'note' : 'list')
  /** Narrow (beside a terminal, a grid tile): the list folds away behind a button and there is no side-by-side preview. */
  const [compact, setCompact] = useState(false)
  const [listOpen, setListOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const editorHost = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  /** The open note as saved: path, the mtime it was loaded or saved at, and whether the editor has changes since. */
  const cur = useRef<{ path: string; mtime: number; dirty: boolean } | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** Set while the editor's text is replaced from disk, so that change is not taken for typing. */
  const applyingDisk = useRef(false)
  const pendingLine = useRef<number | null>(null)

  const setMode = (m: Mode): void => { setModeState(m); writePref(MODE_KEY, m) }

  const refreshList = (): void => {
    window.api.invoke('notes:info').then(setInfo, () => undefined)
    window.api.invoke('notes:list').then(setEntries, (e: Error) => toast('error', e.message))
  }

  const save = async (overwrite = false): Promise<void> => {
    const c = cur.current
    const v = viewRef.current
    if (!c || !v || (!c.dirty && !overwrite)) return
    clearTimeout(saveTimer.current)
    const text = v.state.doc.toString()
    setStatus('saving')
    try {
      const r = await window.api.invoke('notes:write', c.path, text, overwrite ? undefined : c.mtime)
      if (r.conflict) {
        setConflict(r.conflict)
        setStatus('dirty')
        return
      }
      c.mtime = r.mtime
      if (cur.current === c && v.state.doc.toString() !== text) scheduleSave() // typed while it saved
      else {
        c.dirty = false
        if (cur.current === c) setStatus('saved')
      }
    } catch (e) {
      setStatus('error')
      toast('error', `Note not saved: ${(e as Error).message}`)
    }
  }
  const scheduleSave = (): void => {
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void save(), 800)
  }
  const onEdit = (): void => {
    if (applyingDisk.current || !cur.current) return
    cur.current.dirty = true
    setStatus('dirty')
    scheduleSave()
    clearTimeout(previewTimer.current)
    previewTimer.current = setTimeout(() => setPreviewText(viewRef.current?.state.doc.toString() ?? ''), 250)
  }
  const makeState = (doc: string): EditorState =>
    EditorState.create({
      doc,
      extensions: [
        history(),
        drawSelection(),
        keymap.of([
          ...FORMAT_KEYS.map(({ key, fn }) => ({ key, run: (v: EditorView) => { runFormat(v, fn); return true } })),
          { key: 'Mod-s', run: () => { void save(); return true } },
          // Enter continues a list or quote (and ends it on an empty item), Backspace removes its mark.
          ...markdownKeymap,
          indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap
        ]),
        // Frontmatter (a host note's ec2_key, tags) is YAML, not a setext heading. GitHub-flavoured Markdown gives
        // ~~strikethrough~~, task lists and tables; Highlight adds Obsidian's ==highlight==.
        yamlFrontmatter({ content: markdown({ base: markdownLanguage, extensions: [Highlight] }) }),
        liveConf.of(liveOn.current ? liveExtension() : []),
        syntaxHighlighting(highlight),
        highlightSelectionMatches(),
        EditorView.lineWrapping,
        placeholder('Start writing… Markdown, [[links]] to other notes.'),
        editorTheme,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onEdit()
          if (u.docChanged || u.selectionSet) for (const fn of selectionSubs.current) fn()
        })
      ]
    })

  /** Puts disk text in the editor without counting it as an edit, keeping the cursor where it was if it still fits. */
  const applyDisk = (f: NoteFile): void => {
    const v = viewRef.current
    if (!v || !cur.current) return
    applyingDisk.current = true
    const head = Math.min(v.state.selection.main.head, f.text.length)
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: f.text }, selection: { anchor: head } })
    applyingDisk.current = false
    cur.current.mtime = f.mtime
    cur.current.dirty = false
    setPreviewText(f.text)
    setStatus('saved')
  }

  const load = async (path: string): Promise<void> => {
    await save()
    try {
      const f = await window.api.invoke('notes:read', path)
      cur.current = { path: f.path, mtime: f.mtime, dirty: false }
      viewRef.current?.setState(makeState(f.text))
      setCurrent(f)
      setPreviewText(f.text)
      setStatus('saved')
      setConflict(null)
      setMobileView('note')
      setTargetFolder(noteFolder(f.path))
      updateTab(tab.id, { title: `Notes · ${noteName(f.path)}` })
      setRecent((r) => {
        const next = [f.path, ...r.filter((x) => x !== f.path)].slice(0, 6)
        writePref(RECENT_KEY, next)
        return next
      })
      const line = pendingLine.current
      pendingLine.current = null
      const v = viewRef.current
      if (line && v && line <= v.state.doc.lines) {
        const at = v.state.doc.line(line).from
        v.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'center' }) })
      }
    } catch (e) {
      toast('error', (e as Error).message)
    }
  }

  const open = (path: string, line?: number): void => {
    pendingLine.current = line ?? null
    setListOpen(false)
    if (path === tab.notesPath) void load(path)
    else updateTab(tab.id, { notesPath: path })
  }

  // The editor lives for the tab's lifetime; notes are swapped into it.
  useEffect(() => {
    const view = new EditorView({ parent: editorHost.current!, state: makeState('') })
    viewRef.current = view
    refreshList()
    return () => {
      void save()
      view.destroy()
      viewRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab.notesPath && tab.notesPath !== cur.current?.path) void load(tab.notesPath)
  }, [tab.notesPath]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = rootRef.current
    if (!el || mobile) return
    const ro = new ResizeObserver(() => setCompact(el.clientWidth > 0 && el.clientWidth < 760))
    ro.observe(el)
    return () => ro.disconnect()
  }, [mobile])
  const view: Mode = compact && mode === 'split' ? 'edit' : mode

  // Live mode in Edit; Split shows the raw Markdown beside its preview.
  const wantLive = live && view === 'edit'
  useEffect(() => {
    liveOn.current = wantLive
    viewRef.current?.dispatch({ effects: liveConf.reconfigure(wantLive ? liveExtension() : []) })
  }, [wantLive]) // eslint-disable-line react-hooks/exhaustive-deps
  const setLive = (on: boolean): void => { setLiveState(on); writePref(LIVE_KEY, on) }
  const setNoteLook = (patch: { notesFont?: string; notesFontSize?: number }): void => {
    void window.api.invoke('settings:set', patch).then((next) => useStore.getState().set({ settings: next }), (e: Error) => toast('error', e.message))
  }

  // Changes made elsewhere (Obsidian, another device): reload a clean note, offer a choice for one with unsaved edits.
  useEffect(() => {
    if (!active) return
    refreshList()
    const t = setInterval(() => {
      const c = cur.current
      if (!c) return
      void window.api.invoke('notes:stat', c.path).then(async (m) => {
        if (m === null || m <= c.mtime + 1 || cur.current !== c) return
        const disk = await window.api.invoke('notes:read', c.path)
        if (cur.current !== c) return
        if (c.dirty) setConflict(disk)
        else applyDisk(disk)
      }, () => undefined)
    }, 3000)
    return () => clearInterval(t)
  }, [active]) // eslint-disable-line react-hooks/exhaustive-deps

  const runSearch = (): void => {
    const q = filter.trim()
    if (!q) { setHits(null); return }
    window.api.invoke('notes:search', q).then(setHits, (e: Error) => toast('error', e.message))
  }
  const inFolder = (folder: string, name: string): string => (folder ? `${folder}/${name}` : name)
  const startCreate = (kind: 'note' | 'folder', folder = targetFolder): void => {
    setTargetFolder(folder)
    setNewName('')
    setCreating(kind)
    if (folder) setCollapsed((c) => c.filter((x) => x !== folder))
  }
  /** Creates a note or folder inside the working folder; a name with slashes makes subfolders too. */
  const createEntry = (): void => {
    const kind = creating
    const name = newName.trim().replace(/^\/+|\/+$/g, '').replace(/\.md$/i, '')
    setCreating(null)
    setNewName('')
    if (!name || !kind) return
    const path = inFolder(targetFolder, name)
    if (kind === 'folder') {
      window.api.invoke('notes:mkdir', path).then((p) => { setTargetFolder(p); refreshList() }, (e: Error) => toast('error', e.message))
    } else {
      window.api.invoke('notes:create', `${path}.md`).then((p) => { refreshList(); open(p) }, (e: Error) => toast('error', e.message))
    }
  }
  /** Maps a path through a rename (the item itself, or anything inside a renamed folder). */
  const moved = (path: string, from: string, to: string): string => (path === from ? to : path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path)
  const commitRename = (): void => {
    const r = renaming
    setRenaming(null)
    if (!r) return
    const name = r.value.trim().replace(/[\\/]/g, '-').replace(/\.md$/i, '')
    const parent = noteFolder(r.path)
    const oldName = r.folder ? r.path.split('/').pop()! : noteName(r.path)
    if (!name || name === oldName) return
    relocate(r.path, inFolder(parent, r.folder ? name : `${name}.md`))
  }
  /**
   * Renames or moves a note or folder, then carries everything that pointed at it along: the open note (and its tab),
   * the working folder, recent notes and which folders are open.
   */
  const relocate = (from: string, to: string, onDone?: (newPath: string) => void): void => {
    void save().then(() => window.api.invoke('notes:rename', from, to)).then(
      (newPath) => {
        const c = cur.current
        if (c) {
          const p = moved(c.path, from, newPath)
          if (p !== c.path) {
            c.path = p
            setCurrent((f) => (f ? { ...f, path: p } : f))
            updateTab(tab.id, { notesPath: p, title: `Notes · ${noteName(p)}` })
          }
        }
        setTargetFolder((t) => moved(t, from, newPath))
        setRecent((list) => { const next = list.map((x) => moved(x, from, newPath)); writePref(RECENT_KEY, next); return next })
        setCollapsed((list) => { const next = list.map((x) => moved(x, from, newPath)); writePref(COLLAPSED_KEY, next); return next })
        refreshList()
        onDone?.(newPath)
      },
      (e: Error) => toast('error', e.message)
    )
  }
  /** Whether `src` may move into `folder`: not where it already is, and never a folder into itself or below itself. */
  const canMoveInto = (src: { path: string; folder: boolean } | null, folder: string): boolean =>
    !!src && noteFolder(src.path) !== folder && !(src.folder && (folder === src.path || folder.startsWith(`${src.path}/`)))
  const moveInto = (src: { path: string; folder: boolean }, folder: string): void => {
    if (!canMoveInto(src, folder)) return
    const name = src.path.split('/').pop()!
    relocate(src.path, inFolder(folder, name), () => {
      if (folder) setCollapsed((c) => { const next = c.filter((x) => x !== folder); writePref(COLLAPSED_KEY, next); return next })
      toast('success', `Moved "${src.folder ? name : noteName(src.path)}" to ${folder || 'the top level'}`)
    })
  }
  const endDrag = (): void => {
    setDrag(null)
    setDropTarget(null)
    if (expandTimer.current) clearTimeout(expandTimer.current.timer)
    expandTimer.current = null
  }
  /** Drag-and-drop handlers for a row: it can be dragged, and it is a drop target for `folder` (its own folder for a note). */
  const dragProps = (path: string, isFolder: boolean, folder: string) => ({
    draggable: renaming?.path !== path,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData('application/x-ec2ra-note', path)
      e.dataTransfer.effectAllowed = 'move'
      setDrag({ path, folder: isFolder })
    },
    onDragEnd: endDrag,
    onDragOver: (e: React.DragEvent) => {
      e.stopPropagation()
      if (!canMoveInto(drag, folder)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (dropTarget !== folder) setDropTarget(folder)
      // Hovering a closed folder opens it, so a note can go deeper than the folders already shown.
      if (isFolder && collapsed.includes(folder) && expandTimer.current?.folder !== folder) {
        if (expandTimer.current) clearTimeout(expandTimer.current.timer)
        expandTimer.current = { folder, timer: setTimeout(() => setCollapsed((c) => c.filter((x) => x !== folder)), 650) }
      }
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const src = drag
      endDrag()
      if (src) moveInto(src, folder)
    }
  })
  /** Folders a row could move to, for Move to… (the top level first). */
  const moveTargets = (src: { path: string; folder: boolean }): string[] =>
    ['', ...entries.filter((e) => e.folder).map((e) => e.path).sort((a, b) => a.localeCompare(b))].filter((f) => canMoveInto(src, f))
  /** Moves a note or folder to the Trash after asking; the open note is closed first if it goes with it. */
  const removeEntry = (path: string, folder: boolean): void => {
    const inside = folder ? entries.filter((e) => !e.folder && e.path.startsWith(`${path}/`)).length : 0
    const what = folder ? `the folder "${path}"${inside ? ` and the ${inside} note${inside === 1 ? '' : 's'} in it` : ''}` : `"${noteName(path)}"`
    if (!window.confirm(`Move ${what} to the Trash?`)) return
    const c = cur.current
    if (c && (c.path === path || (folder && c.path.startsWith(`${path}/`)))) {
      clearTimeout(saveTimer.current)
      cur.current = null
      setCurrent(null)
      setConflict(null)
      viewRef.current?.setState(makeState(''))
      updateTab(tab.id, { notesPath: undefined, title: 'Notes' })
    }
    window.api.invoke('notes:delete', path).then(
      () => {
        if (targetFolder === path || targetFolder.startsWith(`${path}/`)) setTargetFolder(noteFolder(path))
        refreshList()
        toast('success', `Moved ${folder ? 'the folder' : `"${noteName(path)}"`} to the Trash`)
      },
      (e: Error) => toast('error', e.message)
    )
  }
  const openToday = (): void => {
    window.api.invoke('notes:daily').then((p) => { refreshList(); open(p) }, (e: Error) => toast('error', e.message))
  }
  const toggleFolder = (path: string): void => {
    setTargetFolder(path)
    setCollapsed((c) => {
      const next = c.includes(path) ? c.filter((x) => x !== path) : [...c, path]
      writePref(COLLAPSED_KEY, next)
      return next
    })
  }
  const onPreviewClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    e.preventDefault()
    const note = a.getAttribute('data-note')
    if (note) {
      const found = resolveWikiLink(note, entries.map((x) => x.path))
      if (found) open(found)
      else window.api.invoke('notes:create', `${note}.md`).then((p) => { refreshList(); open(p) }, (err: Error) => toast('error', err.message))
      return
    }
    const href = a.getAttribute('href') ?? ''
    if (/^https?:\/\//i.test(href)) void window.api.invoke('shell:open', href)
  }

  openLink.current = (link) => {
    if (link.note) {
      const found = resolveWikiLink(link.note, entries.map((x) => x.path))
      if (found) open(found)
      else window.api.invoke('notes:create', `${link.note}.md`).then((p) => { refreshList(); open(p) }, (err: Error) => toast('error', err.message))
    } else if (link.url && /^https?:\/\//i.test(link.url)) {
      if (inElectron) useStore.getState().openBrowser({ url: link.url })
      else void window.api.invoke('shell:open', link.url)
    }
  }

  const html = useMemo(() => DOMPurify.sanitize(noteToHtml(previewText)), [previewText])
  const tree = useMemo(() => buildTree(entries), [entries])
  const files = useMemo(() => entries.filter((e) => !e.folder), [entries])
  const q = filter.trim().toLowerCase()
  const matches = q ? files.filter((e) => e.path.toLowerCase().includes(q)).slice(0, 200) : []
  const known = new Set(files.map((e) => e.path))

  /** The "⋯" (and right-click) menu of a note or folder row. */
  const openMenu = (e: React.MouseEvent<HTMLElement>, path: string, folder: boolean): void => {
    e.preventDefault()
    e.stopPropagation()
    const row = (e.currentTarget.closest('.notes-row') as HTMLElement | null) ?? e.currentTarget
    setMenu({ path, folder, anchor: row })
  }
  const renameInput = (r: { path: string; folder: boolean; value: string }): ReactElement => (
    <input
      autoFocus
      className="input notes-rename"
      aria-label="New name"
      value={r.value}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setRenaming({ ...r, value: e.target.value })}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(null) }}
      onBlur={commitRename}
    />
  )

  const fileRow = (e: NoteEntry, depth: number, showFolder = false, keyPrefix = ''): ReactElement => (
    <div key={`${keyPrefix}${e.path}`} {...dragProps(e.path, false, noteFolder(e.path))} className={`notes-row notes-file ${current?.path === e.path ? 'on' : ''} ${drag?.path === e.path ? 'dragging' : ''}`} style={{ paddingLeft: 10 + depth * 14 }} title={e.path} role="button" tabIndex={0}
      onClick={() => { if (renaming?.path !== e.path) open(e.path) }} onContextMenu={(ev) => openMenu(ev, e.path, false)}>
      <Icon.note className="shrink-0" />
      {renaming?.path === e.path && !keyPrefix ? renameInput(renaming) : <span className="truncate">{noteName(e.path)}</span>}
      {showFolder && noteFolder(e.path) && <span className="notes-file-folder truncate">{noteFolder(e.path)}</span>}
      <button className="notes-row-more" aria-label={`More for ${noteName(e.path)}`} title="Rename, delete" onClick={(ev) => openMenu(ev, e.path, false)}>⋯</button>
    </div>
  )
  const folderRows = (f: Folder, depth: number): ReactElement[] =>
    f.folders.flatMap((sub) => {
      const closed = collapsed.includes(sub.path)
      return [
        <div key={`d:${sub.path}`} {...dragProps(sub.path, true, sub.path)} className={`notes-row notes-folder ${targetFolder === sub.path ? 'target' : ''} ${dropTarget === sub.path ? 'drop-target' : ''} ${drag?.path === sub.path ? 'dragging' : ''}`} style={{ paddingLeft: 10 + depth * 14 }} role="button" tabIndex={0}
          onClick={() => { if (renaming?.path !== sub.path) toggleFolder(sub.path) }} onContextMenu={(ev) => openMenu(ev, sub.path, true)}>
          <Icon.chevron open={!closed} className="shrink-0" />
          {renaming?.path === sub.path ? renameInput(renaming) : <span className="truncate">{sub.name}</span>}
          <button className="notes-row-more" aria-label={`More for folder ${sub.name}`} title="New note or folder here, rename, delete" onClick={(ev) => openMenu(ev, sub.path, true)}>⋯</button>
        </div>,
        ...(closed ? [] : [...folderRows(sub, depth + 1), ...sub.files.map((x) => fileRow(x, depth + 1))])
      ]
    })

  const side = (
    <aside className="notes-side">
      <div className="notes-side-head">
        <b>Notes</b>
        <span className="notes-vault truncate" title={info?.dir}>{info ? (info.source === 'obsidian' ? 'Obsidian vault' : info.dir.split('/').pop()) : ''}</span>
        <span className="flex-1" />
        <button className="btn btn-ghost btn-sm" title="Open today's note" onClick={openToday}>Today</button>
        <button className="btn btn-ghost btn-sm btn-icon" title={`New note in ${targetFolder || 'the top folder'}`} aria-label="New note" onClick={() => startCreate('note')}><Icon.plus /></button>
        <button className="btn btn-ghost btn-sm btn-icon" title={`New folder in ${targetFolder || 'the top folder'}`} aria-label="New folder" onClick={() => startCreate('folder')}><Icon.folder /></button>
      </div>
      {targetFolder && (
        <div className="notes-target">
          <span className="muted">New items go in</span>
          <span className="notes-target-chip truncate" title={targetFolder}>{targetFolder}</span>
          <button className="btn btn-ghost btn-sm btn-icon" title="Create at the top level instead" aria-label="Create at the top level" onClick={() => setTargetFolder('')}><Icon.x /></button>
        </div>
      )}
      {creating && (
        <form className="notes-new" onSubmit={(e) => { e.preventDefault(); createEntry() }}>
          <input autoFocus className="input" placeholder={creating === 'folder' ? 'Folder name' : 'Note name'} aria-label={creating === 'folder' ? 'New folder name' : 'New note name'} value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setCreating(null) }} />
          <button type="submit" className="btn btn-primary btn-sm">{creating === 'folder' ? 'Create folder' : 'Create'}</button>
        </form>
      )}
      <div className="notes-search">
        <Icon.search className="muted shrink-0" />
        <input
          className="min-w-0 flex-1 bg-transparent outline-none"
          placeholder="Filter by name · Enter searches text"
          aria-label="Search notes"
          value={filter}
          onChange={(e) => { setFilter(e.target.value); setHits(null) }}
          onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); if (e.key === 'Escape') { setFilter(''); setHits(null) } }}
        />
      </div>
      <div
        className={`notes-list ${drag && dropTarget === '' ? 'drop-root' : ''}`}
        onDragOver={(e) => {
          if (!canMoveInto(drag, '')) return
          e.preventDefault()
          if (dropTarget !== '') setDropTarget('')
        }}
        onDragLeave={(e) => { if (e.currentTarget === e.target && dropTarget === '') setDropTarget(null) }}
        onDrop={(e) => {
          e.preventDefault()
          const src = drag
          endDrag()
          if (src) moveInto(src, '')
        }}
      >
        {drag && canMoveInto(drag, '') && <div className="notes-drop-hint">Drop on a folder to move it there, or here for the top level</div>}
        {hits ? (
          <>
            <div className="notes-group">{hits.length ? `Text matches for “${filter.trim()}”` : `No note contains “${filter.trim()}”`}</div>
            {hits.map((h, i) => (
              <button key={`${h.path}:${h.line}:${i}`} className="notes-hit" onClick={() => open(h.path, h.line || undefined)}>
                <span className="truncate font-semibold">{noteName(h.path)}</span>
                {h.text && <span className="muted truncate">{h.text}</span>}
              </button>
            ))}
          </>
        ) : q ? (
          <>
            {matches.map((e) => fileRow(e, 0, true))}
            {!matches.length && <div className="notes-empty muted">No note name matches. Press Enter to search inside notes.</div>}
          </>
        ) : (
          <>
            {recent.filter((p) => known.has(p)).length > 0 && (
              <>
                <div className="notes-group">Recent</div>
                {recent.filter((p) => known.has(p)).slice(0, 5).map((p) => fileRow({ path: p, mtime: 0, size: 0 }, 0, true, 'recent:'))}
                <div className="notes-group">All notes</div>
              </>
            )}
            {folderRows(tree, 0)}
            {tree.files.map((e) => fileRow(e, 0))}
            {info && !entries.length && (
              <div className="notes-empty muted">{info.exists ? 'No notes here yet. Create one with +, or open today’s note.' : `The notes folder does not exist yet: ${info.dir}. Creating a note creates it.`}</div>
            )}
          </>
        )}
      </div>
      <div className="notes-side-foot muted" title={info?.dir}>
        <span className="truncate">{info?.dir}</span>
        <button className="underline" onClick={() => useStore.getState().set({ settingsOpen: true })}>Change</button>
      </div>
    </aside>
  )

  const main = (
    <section className="notes-main">
      <div className="notes-head">
        {mobile && <button className="btn btn-ghost btn-sm notes-back" onClick={() => setMobileView('list')}><Icon.chevron className="rotate-180" /> Notes</button>}
        {compact && <button className={`btn btn-ghost btn-sm btn-icon ${listOpen ? 'on' : ''}`} title="Notes list" aria-label="Notes list" aria-pressed={listOpen} onClick={() => setListOpen((o) => !o)}><Icon.panelRight className="-scale-x-100" filled={listOpen} /></button>}
        <div className="min-w-0 flex-1">
          <div className="notes-title truncate">{current ? noteName(current.path) : 'No note open'}</div>
          {current && noteFolder(current.path) && <div className="notes-path truncate">{noteFolder(current.path)}</div>}
        </div>
        {current && <span className={`notes-status ${status}`}>{status === 'saving' ? 'Saving…' : status === 'dirty' ? 'Edited' : status === 'error' ? 'Not saved' : 'Saved'}</span>}
        <div className="notes-modes" role="radiogroup" aria-label="View">
          {(['edit', 'split', 'preview'] as const).filter((m) => !(mobile || compact) || m !== 'split').map((m) => (
            <button key={m} role="radio" aria-checked={view === m} className={view === m ? 'on' : ''} onClick={() => setMode(m)}>{m === 'edit' ? 'Edit' : m === 'split' ? 'Split' : 'Preview'}</button>
          ))}
        </div>
        <button className="btn btn-ghost btn-sm btn-icon" title="Close notes (everything is saved)" aria-label="Close notes" onClick={() => { void save().then(() => useStore.getState().closeTab(tab.id)) }}><Icon.x /></button>
        {current && inElectron && info && (
          <button className="btn btn-ghost btn-sm" title="Open this note in Obsidian" onClick={() => { void save().then(() => window.api.invoke('notes:openInObsidian', current.path)).catch((e: Error) => toast('error', e.message)) }}>Obsidian</button>
        )}
      </div>
      {conflict && (
        <div className="notes-conflict">
          <Icon.alert className="shrink-0" />
          <span className="min-w-0 flex-1">This note was changed in another app while you were editing it here.</span>
          <button className="btn btn-sm" onClick={() => { applyDisk(conflict); setConflict(null) }}>Use the other version</button>
          <button className="btn btn-primary btn-sm" onClick={() => { setConflict(null); void save(true) }}>Keep mine</button>
        </div>
      )}
      {current && view !== 'preview' && (
        <NotesToolbar
          view={viewRef.current}
          subscribe={subscribe}
          font={noteFont}
          size={noteSize}
          live={live}
          onFont={(id) => setNoteLook({ notesFont: id })}
          onSize={(n) => setNoteLook({ notesFontSize: n })}
          onLive={setLive}
        />
      )}
      <div className={`notes-body mode-${view}`}>
        <div className="notes-editor" ref={editorHost} style={{ display: current && view !== 'preview' ? undefined : 'none' }} />
        {current && view !== 'edit' && <div className="notes-preview" title={view === 'preview' ? 'Double-click to edit' : undefined} onClick={onPreviewClick} onDoubleClick={() => { if (view === 'preview') setMode('edit') }} dangerouslySetInnerHTML={{ __html: html }} />}
        {!current && (
          <div className="notes-welcome muted">
            <Icon.note />
            <p>Pick a note on the left, open <button className="underline" onClick={openToday}>today’s note</button>, or open a host’s note from its terminal with <b>Note</b>.</p>
          </div>
        )}
      </div>
    </section>
  )

  const menuEl = menu && menu.move ? (
    <Popover anchor={menu.anchor} align="right" width={240} onClose={() => setMenu(null)}>
      <div className="notes-move-list">
        {moveTargets(menu).map((f) => (
          <MenuItem key={f || '(top)'} onClick={() => { setMenu(null); moveInto(menu, f) }}>
            <span style={{ paddingLeft: f ? (f.split('/').length - 1) * 12 : 0 }}>{f ? f.split('/').pop() : 'Top level'}</span>
          </MenuItem>
        ))}
        {!moveTargets(menu).length && <div className="muted px-3 py-2">No other folder to move it to.</div>}
      </div>
    </Popover>
  ) : menu && (
    <Popover anchor={menu.anchor} align="right" width={200} onClose={() => setMenu(null)}>
      {menu.folder && <MenuItem onClick={() => { setMenu(null); startCreate('note', menu.path) }}>New note here</MenuItem>}
      {menu.folder && <MenuItem onClick={() => { setMenu(null); startCreate('folder', menu.path) }}>New folder here</MenuItem>}
      {menu.folder && <MenuSep />}
      <MenuItem onClick={() => { setMenu(null); setRenaming({ path: menu.path, folder: menu.folder, value: menu.folder ? menu.path.split('/').pop()! : noteName(menu.path) }) }}>Rename</MenuItem>
      <MenuItem onClick={() => setMenu({ ...menu, move: true })}>Move to…</MenuItem>
      <MenuItem danger onClick={() => { setMenu(null); removeEntry(menu.path, menu.folder) }}>Move to Trash</MenuItem>
    </Popover>
  )

  return (
    <div ref={rootRef} className={`notes-tab ${mobile ? `mobile view-${mobileView}` : ''} ${compact ? 'compact' : ''} ${listOpen ? 'list-open' : ''}`} style={{ '--notes-font': noteFontStack(noteFont), '--notes-size': `${noteSize}px` } as CSSProperties}>
      {side}
      {main}
      {menuEl}
    </div>
  )
}

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type * as THREE from 'three'
import {
  CAD_EXTENSIONS, cadFormat, formatDims, formatLength, isCadFile, newChecklist, nextPin, reviewReport, verdictLabel,
  type CadFileRecord, type CadFormat, type CadIssueRecord, type CadMeasureRecord, type CadNoteRecord, type CadView
} from '@shared/cad'
import { ymd } from '@shared/naturalDate'
import { itemsOf, newRecordId, type RecordDoc, type RecordOp } from '@shared/records'
import { sha256Hex } from '@shared/sha256'
import { applyRecords, useRecords } from '../../records'
import { isDarkMode, useStore, type Tab } from '../../store'
import { setTabKeys } from '../../shortcuts'
import { downloadText } from '../plan/parts'
import { Icon } from '../icons'
import { loadModel } from './cadLoad'
import { ON_MAC } from './cadCache'
import { CadScene, EDGE_TRIANGLE_LIMIT, type CadTool, type PickHit, type SectionAxis, type StandardView, type UpAxis } from './cadScene'
import CadTree from './CadTree'
import CadReview, { type ReviewTab } from './CadReview'
import './cad.css'

/**
 * The CAD tool: a STEP (IGES, B-rep, STL, glTF, OBJ, 3MF) viewer with a design review beside it, built from
 * ReviewBench's viewer and review sidebar for files on this Mac. Open a file (Open…, drop it here, the Finder tab or
 * the launcher), turn it about, cut it with a section plane, measure, and pin numbered comments to the model; raise
 * issues, work through the manufacturing checklist, approve or ask for changes, and save the review as a note with a
 * picture of the pinned model. Reviews follow the file's content (cad.ts), so they come back whenever it is opened.
 */

/** `path` is '' for a file picked on an iPhone or iPad: the page gets its bytes, never where it lives. */
interface OpenFile { name: string; path: string; size: number; mtime: number; sha256: string; format: CadFormat }
type ReadFile = OpenFile & { bytes: Uint8Array }
interface Recent { path: string; name: string; at: number }

const RECENT = 'cad.recent'
const readRecent = (): Recent[] => { try { return JSON.parse(localStorage.getItem(RECENT) ?? '[]') as Recent[] } catch { return [] } }
const local = <T,>(key: string, fallback: T): T => { try { const v = localStorage.getItem(key); return v === null ? fallback : (JSON.parse(v) as T) } catch { return fallback } }
const keep = (key: string, value: unknown): void => { try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage off */ } }
const VIEWS: { id: StandardView; label: string; key: string }[] = [
  { id: 'iso', label: 'Iso', key: '1' }, { id: 'front', label: 'Front', key: '2' }, { id: 'top', label: 'Top', key: '3' }, { id: 'right', label: 'Right', key: '4' },
  { id: 'back', label: 'Back', key: '5' }, { id: 'bottom', label: 'Bottom', key: '6' }, { id: 'left', label: 'Left', key: '7' }
]
/** A phone's Safari gives a page far less memory than the Mac app has. */
const DEVICE_MAX = 400 * 1024 * 1024
const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
const dataBlob = (url: string): Blob => {
  const [head, b64] = url.split(',')
  return new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: head.slice(5).split(';')[0] })
}
const typing = (t: EventTarget | null): boolean => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
const cssVar = (name: string, fallback: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback

export default function CadTab({ tab, active }: { tab: Tab; active: boolean }): ReactElement {
  const toast = useStore((s) => s.toast)
  const request = useStore((s) => s.cadRequest)
  const themeKey = useStore((s) => `${s.settings?.theme ?? ''}:${s.settings?.colorTheme ?? ''}`)
  const stageRef = useRef<HTMLDivElement>(null)
  const sectionRef = useRef<HTMLElement>(null)
  const pickRef = useRef<HTMLInputElement>(null)
  const sceneRef = useRef<CadScene | null>(null)
  const cubeRef = useRef<HTMLDivElement>(null)
  const pinEls = useRef(new Map<string, HTMLElement>())
  const labelEls = useRef(new Map<string, HTMLElement>())
  const composerEl = useRef<HTMLDivElement>(null)
  const loadSeq = useRef(0)

  const [file, setFile] = useState<OpenFile | null>(null)
  const [root, setRoot] = useState<THREE.Group | null>(null)
  const [stats, setStats] = useState<{ size: [number, number, number]; triangles: number; parts: number; fromCache: boolean; unitsNote?: string } | null>(null)
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [treeVersion, setTreeVersion] = useState(0)
  const [selected, setSelected] = useState<THREE.Object3D | null>(null)
  const [tool, setTool] = useState<CadTool>('orbit')
  const [section, setSectionState] = useState<{ axis: SectionAxis; offset: number; flip: boolean }>({ axis: 'none', offset: 0.5, flip: false })
  const [edges, setEdges] = useState(true)
  const [wire, setWire] = useState(false)
  const [up, setUp] = useState<UpAxis>(() => local<UpAxis>('cad.up', 'y'))
  const [panels, setPanels] = useState<{ tree: boolean; review: boolean }>(() => local('cad.panels', { tree: true, review: true }))
  // Beside another pane there is room for one side panel: the one opened last.
  const [narrow, setNarrow] = useState(false)
  // A phone: the model takes the screen and the parts or the review slide up over it as a sheet.
  const [compact, setCompact] = useState(false)
  const [sheet, setSheet] = useState<'tree' | 'review' | null>(null)
  const [lastPanel, setLastPanel] = useState<'tree' | 'review'>('review')
  const [reviewTab, setReviewTab] = useState<ReviewTab>('comments')
  const [composer, setComposer] = useState<{ hit: PickHit; view: CadView } | null>(null)
  const [draft, setDraft] = useState('')
  const [activePin, setActivePin] = useState<string | null>(null)
  const [menu, setMenu] = useState<'report' | 'view' | null>(null)
  const [dragging, setDragging] = useState(false)
  const [recent, setRecent] = useState<Recent[]>(readRecent)

  // ----- the review's records -----
  const { doc } = useRecords('reviews')
  const fileRec = file && doc ? (doc.items[file.sha256] as CadFileRecord | undefined) : undefined
  const notes = useMemo(() => (file && doc ? itemsOf<CadNoteRecord>(doc, 'cadnote').filter((n) => n.fileId === file.sha256) : []), [doc, file])
  const issues = useMemo(() => (file && doc ? itemsOf<CadIssueRecord>(doc, 'cadissue').filter((n) => n.fileId === file.sha256) : []), [doc, file])
  const measures = useMemo(() => (file && doc ? itemsOf<CadMeasureRecord>(doc, 'cadmeasure').filter((n) => n.fileId === file.sha256).sort((a, b) => a.createdAt - b.createdAt) : []), [doc, file])
  const reviewed = useMemo(() => (doc ? itemsOf<CadFileRecord>(doc, 'cadfile').sort((a, b) => b.openedAt - a.openedAt).slice(0, 12) : []), [doc])
  const latest = useRef({ notes, measures, composer })
  latest.current = { notes, measures, composer }

  const save = (ops: RecordOp[]): void => { void applyRecords('reviews', ops).catch((e: Error) => toast('error', e.message)) }

  // ----- the 3D view -----
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const scene = new CadScene(el, {
      onSelect: (hit) => {
        scene.highlight(hit?.object ?? null)
        setSelected(hit?.object ?? null)
      },
      onMeasure: (a, b, length) => {
        const f = fileRef.current
        if (!f) return
        save([{ op: 'put', item: { id: newRecordId(), type: 'cadmeasure', fileId: f.sha256, a, b, length, createdAt: Date.now(), updatedAt: Date.now() } as CadMeasureRecord }])
        setReviewTab('measure')
      },
      onPin: (hit) => {
        setDraft('')
        setComposer({ hit, view: scene.getView() })
      },
      onFrame: () => {
        const { notes: ns, measures: ms, composer: c } = latest.current
        for (const n of ns) {
          const el2 = pinEls.current.get(n.id)
          if (!el2 || n.anchor.kind !== 'point') continue
          const p = scene.project(n.anchor.p)
          el2.style.transform = `translate(${p.x}px, ${p.y}px)`
          el2.style.visibility = p.visible ? 'visible' : 'hidden'
        }
        for (const m of ms) {
          const el2 = labelEls.current.get(m.id)
          if (!el2) continue
          const p = scene.project([(m.a[0] + m.b[0]) / 2, (m.a[1] + m.b[1]) / 2, (m.a[2] + m.b[2]) / 2])
          el2.style.transform = `translate(${p.x}px, ${p.y}px)`
          el2.style.visibility = p.visible ? 'visible' : 'hidden'
        }
        if (c && composerEl.current) {
          const p = scene.project(c.hit.point)
          composerEl.current.style.transform = `translate(${Math.min(p.x + 14, el.clientWidth - 290)}px, ${Math.min(p.y - 10, el.clientHeight - 170)}px)`
        }
        if (cubeRef.current) cubeRef.current.style.transform = `translateZ(-40px) ${scene.cubeMatrix()}`
      }
    })
    sceneRef.current = scene
    return () => { scene.dispose(); sceneRef.current = null }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const fileRef = useRef<OpenFile | null>(null)
  fileRef.current = file

  useEffect(() => { sceneRef.current?.setActive(active && !!root) }, [active, root])
  useEffect(() => { sceneRef.current?.setDark(isDarkMode()) }, [themeKey])
  useEffect(() => { sceneRef.current?.setMeasures(measures.map((m) => ({ a: m.a, b: m.b }))) }, [measures, root])
  useEffect(() => { sceneRef.current?.setTool(tool) }, [tool])

  // ----- opening a file -----
  /** The Mac app: a file on this Mac by its path, read in main. */
  const open = (path: string): Promise<void> => load(() => window.api.invoke('cad:read', path))
  /** Anywhere else: a file picked or dropped on this device, read here. */
  const openPicked = (picked: File): Promise<void> => load(async () => {
    const format = cadFormat(picked.name)
    if (!format) throw new Error(`${picked.name} is not a CAD file the viewer reads (${CAD_EXTENSIONS.slice(0, 8).join(', ')}…).`)
    if (picked.size > DEVICE_MAX) throw new Error(`${picked.name} is ${Math.round(picked.size / 1024 / 1024)} MB, more than this device can open. Open it in the Mac app.`)
    const bytes = new Uint8Array(await picked.arrayBuffer())
    return { name: picked.name, path: '', size: picked.size, mtime: picked.lastModified, sha256: await sha256Hex(bytes), format, bytes }
  })
  const load = async (read: () => Promise<ReadFile>): Promise<void> => {
    const n = ++loadSeq.current
    setError(null)
    setComposer(null)
    setLoading('Opening…')
    try {
      const f = await read()
      if (n !== loadSeq.current) return
      setLoading(`Reading ${f.name}…`)
      const model = await loadModel(f, (t) => { if (n === loadSeq.current) setLoading(t) })
      if (n !== loadSeq.current) return
      const scene = sceneRef.current!
      scene.setSection('none')
      setSectionState((s) => ({ ...s, axis: 'none' }))
      scene.setModel(model.group)
      scene.setWireframe(wire)
      const st = scene.stats()
      let parts = 0
      model.group.traverse((o) => { if (!(o as THREE.Mesh).isMesh && o.children.some((c) => (c as THREE.Mesh).isMesh)) parts++ })
      setStats({ ...st, parts, fromCache: model.fromCache, unitsNote: model.unitsNote })
      setEdges(scene.edgesEnabled())
      setRoot(model.group)
      setSelected(null)
      setTreeVersion((v) => v + 1)
      const meta: OpenFile = { name: f.name, path: f.path, size: f.size, mtime: f.mtime, sha256: f.sha256, format: f.format }
      setFile(meta)
      if (up !== 'y') scene.setUp(up)
      if (f.path) {
        const next = [{ path: f.path, name: f.name, at: Date.now() }, ...readRecent().filter((r) => r.path !== f.path)].slice(0, 15)
        keep(RECENT, next)
        setRecent(next)
      }
      await recordOpen(meta)
      // A small picture for the list of reviewed files, once the model is on screen.
      setTimeout(() => { if (n === loadSeq.current) void saveThumb(meta) }, 900)
    } catch (e) {
      if (n === loadSeq.current) setError((e as Error).message)
    } finally {
      if (n === loadSeq.current) setLoading(null)
    }
  }

  const recordOpen = async (f: OpenFile): Promise<void> => {
    const fresh: RecordDoc = await window.api.invoke('records:load', 'reviews')
    const had = fresh.items[f.sha256] as CadFileRecord | undefined
    const now = Date.now()
    const item: CadFileRecord = had?.type === 'cadfile'
      ? { ...had, name: f.name, path: f.path || had.path, size: f.size, openedAt: now, updatedAt: now }
      : { id: f.sha256, type: 'cadfile', name: f.name, path: f.path, size: f.size, format: f.format, checklist: newChecklist(), verdict: 'open', openedAt: now, updatedAt: now }
    await applyRecords('reviews', [{ op: 'put', item }])
  }

  const saveThumb = async (f: OpenFile): Promise<void> => {
    const scene = sceneRef.current
    if (!scene) return
    const img = new Image()
    img.src = scene.screenshot(cssVar('--panel', '#ffffff'))
    await img.decode().catch(() => undefined)
    const c = document.createElement('canvas')
    c.width = 240
    c.height = Math.round((240 * img.height) / Math.max(1, img.width))
    c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height)
    const thumb = c.toDataURL('image/jpeg', 0.72)
    const cur = (await window.api.invoke('records:load', 'reviews')).items[f.sha256] as CadFileRecord | undefined
    if (cur?.type === 'cadfile') await applyRecords('reviews', [{ op: 'put', item: { ...cur, thumb, updatedAt: Date.now() } as CadFileRecord }])
  }

  // Off the Mac the file input is clicked in the tap itself (no await before it), or iOS ignores it.
  const pick = async (): Promise<void> => {
    if (!ON_MAC) { pickRef.current?.click(); return }
    const path = await window.api.invoke('cad:pick').catch(() => null)
    if (path) void open(path)
  }
  /** A review from the list: on the Mac by its path; on a phone or iPad the file is chosen again (its hash finds the review). */
  const reopen = (r: { path: string; name: string }): void => {
    if (ON_MAC && r.path) { void open(r.path); return }
    toast('info', `Choose ${r.name} to open its review.`)
    void pick()
  }

  useEffect(() => {
    if (!request) return
    useStore.getState().set({ cadRequest: null })
    void open(request.path)
  }, [request?.nonce]) // eslint-disable-line react-hooks/exhaustive-deps

  // ----- tools and keys -----
  const setSection = (axis: SectionAxis, offset = section.offset, flip = section.flip): void => {
    sceneRef.current?.setSection(axis, offset, flip)
    setSectionState({ axis, offset, flip })
  }
  const toggleEdges = (): void => { const on = !edges; sceneRef.current?.setEdges(on); setEdges(on) }
  const toggleWire = (): void => { const on = !wire; sceneRef.current?.setWireframe(on); setWire(on) }
  const setUpAxis = (u: UpAxis): void => { setUp(u); keep('cad.up', u); sceneRef.current?.setUp(u) }
  const setPanel = (k: 'tree' | 'review', on: boolean): void => {
    if (compact) { setSheet(on ? k : null); return }
    if (on) setLastPanel(k)
    setPanels((p) => { const next = { ...p, [k]: on }; keep('cad.panels', next); return next })
  }
  useEffect(() => {
    const el = sectionRef.current
    if (!el) return
    const ro = new ResizeObserver(() => { setNarrow(el.clientWidth < 900); setCompact(el.clientWidth < 640) })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!active) return
    setTabKeys('cad', (k) => {
      if (k.key.toLowerCase() === 'o' && !k.shift && !k.alt) { void pick(); return true }
      return false
    })
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || !root) return
      const k = e.key.toLowerCase()
      const scene = sceneRef.current
      if (!scene) return
      if (k === 'escape') { if (composer) setComposer(null); else if (tool !== 'orbit') setTool('orbit'); else { scene.highlight(null); setSelected(null) } }
      else if (k === 'f') scene.fit()
      else if (k === 'm') setTool(tool === 'measure' ? 'orbit' : 'measure')
      else if (k === 'c') setTool(tool === 'pin' ? 'orbit' : 'pin')
      else if (k === 'v') setTool('orbit')
      else if (k === 'e') toggleEdges()
      else if (k === 'w') toggleWire()
      else if (k === 'x' || k === 'y' || k === 'z') setSection(section.axis === k ? 'none' : k)
      else if (k === 'h' && selected) { scene.setVisible(selected, false); setTreeVersion((v) => v + 1) }
      else { const v = VIEWS.find((x) => x.key === k); if (!v) return; scene.view(v.id) }
      e.preventDefault()
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); setTabKeys('cad', null) }
  }) // eslint-disable-line react-hooks/exhaustive-deps

  // ----- comments on the model -----
  const savePin = (): void => {
    if (!composer || !file || !draft.trim()) return
    const { hit, view } = composer
    save([{ op: 'put', item: { id: newRecordId(), type: 'cadnote', fileId: file.sha256, pin: nextPin(notes), body: draft.trim(), anchor: { kind: 'point', p: hit.point, part: hit.part }, view, createdAt: Date.now(), updatedAt: Date.now() } as CadNoteRecord }])
    setComposer(null)
    setDraft('')
    setReviewTab('comments')
    // On a phone the sheet would cover the model just pinned.
    if (!compact) setPanel('review', true)
  }
  const goTo = (n: CadNoteRecord): void => {
    setActivePin(n.id)
    if (n.view) sceneRef.current?.flyTo(n.view)
  }

  // ----- the report -----
  const reportImage = async (): Promise<string> => {
    const scene = sceneRef.current!
    const bg = cssVar('--panel', '#ffffff')
    const img = new Image()
    img.src = scene.screenshot(bg)
    await img.decode().catch(() => undefined)
    const ratio = img.width / Math.max(1, stageRef.current!.clientWidth)
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const g = c.getContext('2d')!
    g.drawImage(img, 0, 0)
    // The pins and lengths are HTML over the canvas: drawn into the picture so its numbers match the report.
    g.font = `600 ${12 * ratio}px -apple-system, sans-serif`
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    for (const n of notes) {
      if (n.anchor.kind !== 'point') continue
      const p = scene.project(n.anchor.p)
      if (!p.visible) continue
      g.fillStyle = n.resolvedAt ? '#9aa3b2' : '#e11d48'
      g.beginPath(); g.arc(p.x * ratio, p.y * ratio, 11 * ratio, 0, Math.PI * 2); g.fill()
      g.fillStyle = '#fff'
      g.fillText(String(n.pin), p.x * ratio, p.y * ratio + ratio * 0.5)
    }
    for (const m of measures) {
      const p = scene.project([(m.a[0] + m.b[0]) / 2, (m.a[1] + m.b[1]) / 2, (m.a[2] + m.b[2]) / 2])
      if (!p.visible) continue
      const text = formatLength(m.length)
      const w = g.measureText(text).width + 12 * ratio
      g.fillStyle = '#f59e0b'
      g.fillRect(p.x * ratio - w / 2, p.y * ratio - 10 * ratio, w, 20 * ratio)
      g.fillStyle = '#1c1917'
      g.fillText(text, p.x * ratio, p.y * ratio + ratio * 0.5)
    }
    return c.toDataURL('image/png')
  }
  const reportText = (image?: string): string => reviewReport(fileRec!, notes, issues, measures, { dims: stats ? formatDims(stats.size) : undefined, parts: stats?.parts, image })
  const day = (): string => ymd(new Date())
  const saveToNotes = async (): Promise<void> => {
    setMenu(null)
    if (!file || !fileRec) return
    try {
      const path = await window.api.invoke('notes:saveReview', `${file.name.replace(/\.[^.]+$/, '')} review ${day()}`, reportText('{image}'), await reportImage())
      toast('success', `Saved to Notes: ${path}`)
      useStore.getState().openNotes(path, { beside: tab.id })
    } catch (e) {
      toast('error', (e as Error).message)
    }
  }
  const copyPicture = async (): Promise<void> => {
    setMenu(null)
    try {
      // Safari takes a clipboard item only while the tap lasts, so the picture goes in as a promise.
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': reportImage().then(dataBlob) })])
      toast('success', 'Picture copied')
    } catch (e) {
      toast('error', `Could not copy the picture: ${(e as Error).message}`)
    }
  }

  // ----- dropping a file -----
  const onDrop = (e: React.DragEvent): void => {
    setDragging(false)
    const f = e.dataTransfer.files[0]
    if (!f) return
    e.preventDefault()
    if (!ON_MAC) { void openPicked(f); return }
    const path = window.api.pathForFile?.(f)
    if (path && isCadFile(path)) void open(path)
    else toast('error', `${f.name} is not a CAD file the viewer reads (${CAD_EXTENSIONS.slice(0, 8).join(', ')}…).`)
  }

  const visibleNotes = notes.filter((n) => n.anchor.kind === 'point')
  const hasTree = panels.tree && !!root
  const hasReview = panels.review && !!fileRec
  const showTree = compact ? sheet === 'tree' && !!root : hasTree && !(narrow && hasReview && lastPanel === 'review')
  const showReview = compact ? sheet === 'review' && !!fileRec : hasReview && !(narrow && showTree)
  const asSheet = (k: 'tree' | 'review', title: string, node: ReactElement): ReactElement => (compact
    ? <div className="cad-sheet" role="dialog" aria-label={title}>
      <div className="cad-sheet-bar"><b>{title}</b><span className="flex-1" /><button type="button" className="btn btn-sm" onClick={() => setPanel(k, false)}>Done</button></div>
      {node}
    </div>
    : node)
  const panelButton = (k: 'tree' | 'review', shown: boolean): (() => void) => () => setPanel(k, !shown)
  const info = file && stats ? (
    <div className="cad-info">
      <dl>
        <dt>File</dt><dd title={file.path}>{file.name}</dd>
        {file.path && <><dt>Folder</dt><dd className="mono">{file.path.replace(/\/[^/]+$/, '').replace(/^\/Users\/[^/]+/, '~')}</dd></>}
        <dt>Format</dt><dd>{file.format.toUpperCase()}{stats.fromCache ? ' · from the cache' : ''}</dd>
        <dt>Size on disk</dt><dd>{(file.size / 1024 / 1024).toFixed(2)} MB</dd>
        <dt>Model size</dt><dd>{formatDims(stats.size)}</dd>
        <dt>Parts</dt><dd>{stats.parts}</dd>
        <dt>Triangles</dt><dd>{stats.triangles.toLocaleString()}</dd>
        <dt>SHA-256</dt><dd className="mono" title={file.sha256}>{file.sha256.slice(0, 16)}…</dd>
        {selected && <><dt>Selected</dt><dd>{selected.name}</dd></>}
      </dl>
      {stats.unitsNote && <p className="cad-hint">{stats.unitsNote}</p>}
      {stats.triangles > EDGE_TRIANGLE_LIMIT && <p className="cad-hint">A large model: edge lines start off (E turns them on).</p>}
      {ON_MAC && file.path && (
        <div className="cad-info-actions">
          <button type="button" className="btn btn-sm" onClick={() => void window.api.invoke('local:reveal', file.path)}>Show in Finder</button>
          <button type="button" className="btn btn-sm" onClick={() => void window.api.invoke('clipboard:write', file.path)}>Copy path</button>
        </div>
      )}
    </div>
  ) : null

  return (
    <section ref={sectionRef} className={`cad ${file ? 'has-file' : ''} ${narrow ? 'narrow' : ''} ${compact ? 'compact' : ''} ${showTree && !compact ? '' : 'no-tree'} ${showReview && !compact ? '' : 'no-review'}`} aria-label="CAD viewer"
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true) } }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
      <header className="cad-head">
        <Icon.cube className="cad-head-icon" />
        {file ? (
          <div className="cad-head-file">
            <b title={file.path}>{file.name}</b>
            <span className="cad-chip">{file.format.toUpperCase()}</span>
            {stats && <span className="cad-head-sub">{formatDims(stats.size)} · {stats.parts} part{stats.parts === 1 ? '' : 's'}</span>}
            {fileRec && <span className="cad-chip verdict" data-verdict={fileRec.verdict}>{verdictLabel(fileRec.verdict)}</span>}
          </div>
        ) : <div className="cad-head-file"><b>CAD Viewer</b><span className="cad-head-sub">STEP · IGES · STL · glTF, with reviews</span></div>}
        <span className="flex-1" />
        {file && (
          <>
            <button type="button" className={`cad-icon-btn ${showTree ? 'on' : ''}`} aria-pressed={showTree} title="Parts" onClick={panelButton('tree', showTree)}><Icon.layers /></button>
            <button type="button" className={`cad-icon-btn ${showReview ? 'on' : ''}`} aria-pressed={showReview} title="Review" onClick={panelButton('review', showReview)}><Icon.comment /></button>
            <div className="cad-menu-wrap">
              <button type="button" className="btn btn-sm" onClick={() => setMenu(menu === 'report' ? null : 'report')}><Icon.note /> Report</button>
              {menu === 'report' && (
                <div className="cad-menu" role="menu" onMouseLeave={() => setMenu(null)}>
                  <button type="button" role="menuitem" onClick={() => void saveToNotes()}>Save to Notes (with a picture)</button>
                  <button type="button" role="menuitem" onClick={() => { setMenu(null); void window.api.invoke('clipboard:write', reportText()); toast('success', 'Report copied as Markdown') }}>Copy as Markdown</button>
                  <button type="button" role="menuitem" onClick={() => { setMenu(null); downloadText(`${file.name.replace(/\.[^.]+$/, '')} review.md`, reportText(), 'text/markdown') }}>Download .md</button>
                  <button type="button" role="menuitem" onClick={() => void copyPicture()}>Copy picture</button>
                </div>
              )}
            </div>
          </>
        )}
        <button type="button" className="btn btn-sm" onClick={() => void pick()} title="Open a CAD file (⌘O)">Open…</button>
      </header>

      <div className="cad-body">
        {showTree && root && asSheet('tree', 'Parts',
          <CadTree root={root} version={treeVersion} selected={selected}
            onSelect={(o) => { sceneRef.current?.highlight(o); setSelected(o) }}
            onToggle={(o, on) => { sceneRef.current?.setVisible(o, on); setTreeVersion((v) => v + 1) }}
            onFrame={(o) => sceneRef.current?.zoomTo(o)}
            onIsolate={(o) => { sceneRef.current?.isolate(o); setTreeVersion((v) => v + 1); if (o) sceneRef.current?.zoomTo(o); else sceneRef.current?.fit() }} />
        )}

        <main className={`cad-stage tool-${tool}`} ref={stageRef}>
          {root && (
            <div className="cad-overlay" aria-hidden={false}>
              {visibleNotes.map((n) => (
                <button key={n.id} type="button" className={`cad-pin ${n.resolvedAt ? 'resolved' : ''} ${activePin === n.id ? 'on' : ''}`} data-pin={n.pin}
                  ref={(el) => { if (el) pinEls.current.set(n.id, el); else pinEls.current.delete(n.id) }}
                  title={n.body} onClick={() => { setActivePin(n.id); setReviewTab('comments'); setPanel('review', true) }}>{n.pin}</button>
              ))}
              {measures.map((m) => (
                <span key={m.id} className="cad-len" ref={(el) => { if (el) labelEls.current.set(m.id, el); else labelEls.current.delete(m.id) }}>{formatLength(m.length)}</span>
              ))}
              {composer && (
                <div className="cad-composer" ref={composerEl} role="dialog" aria-label="New comment">
                  <span className="cad-composer-head"><b>Comment {nextPin(notes)}</b> on {composer.hit.part}</span>
                  <textarea className="input" autoFocus rows={3} value={draft} placeholder="What should change here?" aria-label="Comment"
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setComposer(null) }
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) { e.preventDefault(); savePin() }
                    }} />
                  <div className="cad-composer-foot">
                    <span className="muted">↩ saves · ⇧↩ new line</span>
                    <span className="flex-1" />
                    <button type="button" className="btn btn-sm" onClick={() => setComposer(null)}>Cancel</button>
                    <button type="button" className="btn btn-sm btn-primary" disabled={!draft.trim()} onClick={savePin}>Pin</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {root && (
            <div className="cad-cube-wrap" aria-label="View cube">
              <div className="cad-cube" ref={cubeRef}>
                {([['front', 'Front', 'translateZ(40px)'], ['back', 'Back', 'rotateY(180deg) translateZ(40px)'], ['right', 'Right', 'rotateY(90deg) translateZ(40px)'], ['left', 'Left', 'rotateY(-90deg) translateZ(40px)'], ['top', 'Top', 'rotateX(90deg) translateZ(40px)'], ['bottom', 'Bottom', 'rotateX(-90deg) translateZ(40px)']] as const).map(([id, label, tf]) => (
                  <button key={id} type="button" className="cad-cube-face" style={{ transform: tf }} onClick={() => sceneRef.current?.view(id)}>{label}</button>
                ))}
              </div>
              <button type="button" className="cad-cube-iso" onClick={() => sceneRef.current?.view('iso')}>Iso</button>
            </div>
          )}

          {root && (
            <div className="cad-toolbar" role="toolbar" aria-label="CAD tools">
              <button type="button" className={tool === 'orbit' ? 'on' : ''} aria-pressed={tool === 'orbit'} title="Turn, pan and select (V)" onClick={() => setTool('orbit')}><Icon.orbit /></button>
              <button type="button" className={tool === 'measure' ? 'on' : ''} aria-pressed={tool === 'measure'} title="Measure between two points (M)" onClick={() => setTool(tool === 'measure' ? 'orbit' : 'measure')}><Icon.ruler /></button>
              <button type="button" className={tool === 'pin' ? 'on' : ''} aria-pressed={tool === 'pin'} title="Pin a comment (C)" onClick={() => setTool(tool === 'pin' ? 'orbit' : 'pin')}><Icon.comment /></button>
              <i className="cad-sep" />
              <button type="button" title="Fit (F)" onClick={() => sceneRef.current?.fit()}><Icon.fit /></button>
              <div className="cad-menu-wrap up">
                <button type="button" className="cad-text-btn" title="Standard views (1–7)" onClick={() => setMenu(menu === 'view' ? null : 'view')}>Views</button>
                {menu === 'view' && (
                  <div className="cad-menu" role="menu" onMouseLeave={() => setMenu(null)}>
                    {VIEWS.map((v) => <button key={v.id} type="button" role="menuitem" onClick={() => { sceneRef.current?.view(v.id); setMenu(null) }}>{v.label}<kbd className="kbd">{v.key}</kbd></button>)}
                    <hr />
                    <button type="button" role="menuitem" onClick={() => { setUpAxis('y'); setMenu(null) }}>{up === 'y' ? '✓ ' : ''}Y up (SolidWorks)</button>
                    <button type="button" role="menuitem" onClick={() => { setUpAxis('z'); setMenu(null) }}>{up === 'z' ? '✓ ' : ''}Z up (3DEXPERIENCE, CATIA)</button>
                  </div>
                )}
              </div>
              <i className="cad-sep" />
              <span className="cad-seg-mini" role="radiogroup" aria-label="Section plane">
                <Icon.section />
                {(['none', 'x', 'y', 'z'] as const).map((a) => (
                  <button key={a} type="button" role="radio" aria-checked={section.axis === a} className={section.axis === a ? 'on' : ''} title={a === 'none' ? 'No section' : `Cut across ${a.toUpperCase()} (${a.toUpperCase()})`} onClick={() => setSection(a)}>{a === 'none' ? 'Off' : a.toUpperCase()}</button>
                ))}
              </span>
              {section.axis !== 'none' && (
                <>
                  <input type="range" className="cad-range" min={0} max={1} step={0.005} value={section.offset} aria-label="Section position" onChange={(e) => setSection(section.axis, Number(e.target.value))} />
                  <button type="button" className="cad-text-btn" title="Keep the other side" onClick={() => setSection(section.axis, section.offset, !section.flip)}>Flip</button>
                </>
              )}
              <i className="cad-sep" />
              <button type="button" className={edges ? 'on' : ''} aria-pressed={edges} title="Edge lines (E)" onClick={toggleEdges}><Icon.cube /></button>
              <button type="button" className={wire ? 'on' : ''} aria-pressed={wire} title="Wireframe (W)" onClick={toggleWire}><Icon.grid /></button>
              <button type="button" title="Copy a picture" onClick={() => void copyPicture()}><Icon.camera /></button>
            </div>
          )}

          {tool !== 'orbit' && root && (
            <div className="cad-tool-hint">
              <span>{COARSE
                ? (tool === 'measure' ? 'Tap two points; a corner nearby snaps.' : 'Tap the model where the comment goes.')
                : (tool === 'measure' ? 'Click two points; a corner within reach snaps. Esc stops.' : 'Click the model where the comment goes. Esc stops.')}</span>
              <button type="button" onClick={() => setTool('orbit')}>Done</button>
            </div>
          )}

          {!file && !loading && (
            <div className="cad-start">
              <div className={`cad-drop ${dragging ? 'over' : ''}`}>
                <Icon.cube className="cad-drop-icon" />
                <h2>Open a STEP file</h2>
                <p>STEP, IGES, B-rep, STL, glTF, OBJ or 3MF. {ON_MAC ? 'Drop it here, or open it from Finder or the launcher.' : COARSE ? 'Choose one from Files.' : 'Choose one, or drop it here.'}</p>
                <button type="button" className="btn btn-primary" onClick={() => void pick()}>Open…</button>
              </div>
              {reviewed.length > 0 && (
                <section className="cad-recent">
                  <h3>Reviews</h3>
                  <ul>
                    {reviewed.map((r) => (
                      <li key={r.id}>
                        <button type="button" onClick={() => reopen(r)} title={r.path || r.name}>
                          {r.thumb ? <img src={r.thumb} alt="" /> : <span className="cad-thumb-blank"><Icon.cube /></span>}
                          <span className="cad-recent-text"><b>{r.name}</b><span>{r.path ? r.path.replace(/\/[^/]+$/, '').replace(/^\/Users\/[^/]+/, '~') : `${r.format.toUpperCase()} · ${(r.size / 1024 / 1024).toFixed(1)} MB`}</span></span>
                          <span className="cad-chip verdict" data-verdict={r.verdict}>{verdictLabel(r.verdict)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {recent.filter((r) => !reviewed.some((x) => x.path === r.path)).length > 0 && (
                <section className="cad-recent">
                  <h3>Recent</h3>
                  <ul>
                    {recent.filter((r) => !reviewed.some((x) => x.path === r.path)).slice(0, 8).map((r) => (
                      <li key={r.path}><button type="button" onClick={() => void open(r.path)} title={r.path}><span className="cad-thumb-blank"><Icon.cube /></span><span className="cad-recent-text"><b>{r.name}</b><span>{r.path.replace(/\/[^/]+$/, '')}</span></span></button></li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}
          {loading && <div className="cad-loading" role="status"><Icon.cube className="launcher-spin" /><span>{loading}</span></div>}
          {error && (
            <div className="cad-error" role="alert">
              <b>Could not open the file</b>
              <p>{error}</p>
              <button type="button" className="btn btn-sm" onClick={() => setError(null)}>Close</button>
            </div>
          )}
          {dragging && file && <div className="cad-drop-over">Drop to open</div>}
          {!ON_MAC && (
            <input ref={pickRef} type="file" className="cad-file-input" tabIndex={-1} aria-label="Choose a CAD file"
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void openPicked(f) }} />
          )}
        </main>

        {showReview && fileRec && asSheet('review', 'Review',
          <CadReview file={fileRec} notes={notes} issues={issues} measures={measures} tab={reviewTab} onTab={setReviewTab} activePin={activePin} onGoTo={goTo} info={info} />
        )}
      </div>
    </section>
  )
}

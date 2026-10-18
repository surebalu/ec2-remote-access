import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactElement, ReactNode } from 'react'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { Board, BoardItem, BoardSummary } from '@shared/types'
import { useStore, type Tab } from '../../store'
import { setTabKeys, type TabKey } from '../../shortcuts'
import {
  boundsOfPoints, boxOf, fitView, itemsInBox, moveItem, scaleItem, snapAngle, squareFrom, toBoard, toScreen,
  topItemAt, unionBounds, zoomAt, type Box, type Pt, type View
} from '../../boardGeometry'
import { isMobile } from '../../mobile'
import { Icon } from '../icons'
import Popover, { MenuItem, MenuLabel, MenuSep } from '../Popover'
import { exportPng, GRADIENT, GradientDef, ItemView, LINE_HEIGHT, NOTE_FONT, NOTE_PAD, noteLines, textSize } from './items'

/**
 * The Whiteboard tab: an infinite canvas for brainstorming, with the drawing tools of Presentify (pen, highlighter,
 * lines, arrows, shapes, text, five colours and a gradient, auto-erase, spotlight, single-key shortcuts) and what a
 * board needs (sticky notes, select / move / resize, undo, pasted screenshots, several boards, PNG export and adding
 * a board to today's note). Boards are saved by main (boards:*), so an iPad with a pencil gets the same boards.
 */

type Tool = 'select' | 'hand' | 'pen' | 'highlighter' | 'line' | 'arrow' | 'rect' | 'ellipse' | 'diamond' | 'text' | 'note' | 'eraser' | 'laser'
type Shape = 'line' | 'arrow' | 'rect' | 'ellipse' | 'diamond'

const TOOLS: { tool: Tool; key: string; label: string }[] = [
  { tool: 'select', key: 'v', label: 'Select' },
  { tool: 'hand', key: 'h', label: 'Hand (or hold Space)' },
  { tool: 'pen', key: 'p', label: 'Pen' },
  { tool: 'highlighter', key: 'm', label: 'Highlighter' },
  { tool: 'line', key: 'l', label: 'Line' },
  { tool: 'arrow', key: 'a', label: 'Arrow' },
  { tool: 'rect', key: 'r', label: 'Rectangle' },
  { tool: 'ellipse', key: 'o', label: 'Ellipse' },
  { tool: 'diamond', key: 'd', label: 'Diamond' },
  { tool: 'text', key: 't', label: 'Text' },
  { tool: 'note', key: 'n', label: 'Sticky note' },
  { tool: 'eraser', key: 'e', label: 'Eraser' },
  { tool: 'laser', key: 'k', label: 'Laser pointer' }
]
const DEFAULT_PALETTE = ['ink', '#e5484d', '#0090ff', '#30a46c', '#f76b15']
const WIDTHS = [2, 4, 8]
const TEXT_SIZES: Record<number, number> = { 2: 18, 4: 26, 8: 40 }
const FADES = [0, 3, 5, 10]
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const
type Handle = (typeof HANDLES)[number]

const PALETTE_KEY = 'ui.boardPalette'
const LAST_KEY = 'ui.board'
const readJson = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d } catch { return d } }
const writeJson = (k: string, v: unknown): void => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* storage off */ } }
const newId = (p = 'i'): string => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

const freshBoard = (name: string): Board => ({ id: newId('b'), name, items: [], background: 'dots', view: { x: 0, y: 0, zoom: 1 }, updatedAt: Date.now() })

type Drag =
  | { kind: 'pan'; sx: number; sy: number; view0: View }
  | { kind: 'draw'; item: BoardItem; start: Pt }
  | { kind: 'move'; start: Pt; base: BoardItem[]; ids: string[] }
  | { kind: 'resize'; handle: Handle; box0: Box; base: BoardItem[]; ids: string[] }
  | { kind: 'marquee'; start: Pt; box: Box; keep: string[] }
  | { kind: 'erase'; base: BoardItem[]; removed: Set<string> }
  | { kind: 'laser' }
  | { kind: 'place'; at: Pt; note: boolean }

const svgIcon = (d: ReactNode): ReactElement => <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{d}</svg>
const TOOL_ICONS: Record<Tool, ReactElement> = {
  select: svgIcon(<path d="M5 3l14 8-6.5 1.6L10 19z" />),
  hand: svgIcon(<path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11M11 10V4.5a1.5 1.5 0 0 1 3 0V11M14 10V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2.7L3 14.5a1.6 1.6 0 0 1 2.5-2L8 15" />),
  pen: svgIcon(<><path d="M4 20l1.2-4.4L16 4.8a2 2 0 0 1 2.8 0l.4.4a2 2 0 0 1 0 2.8L8.4 18.8z" /><path d="M14.5 6.5l3 3" /></>),
  highlighter: svgIcon(<><path d="M9 15l-2 4h4l1-2" /><path d="M14.5 4.5l5 5-7.5 7.5-5-5z" /></>),
  line: svgIcon(<path d="M5 19L19 5" />),
  arrow: svgIcon(<><path d="M5 19L19 5" /><path d="M10 5h9v9" /></>),
  rect: svgIcon(<rect x="4" y="6" width="16" height="12" rx="2" />),
  ellipse: svgIcon(<ellipse cx="12" cy="12" rx="8.5" ry="6.5" />),
  diamond: svgIcon(<path d="M12 3.5l8.5 8.5-8.5 8.5L3.5 12z" />),
  text: svgIcon(<path d="M5 6V4.5h14V6M12 4.5v15M9 19.5h6" />),
  note: svgIcon(<><path d="M5 4h14v10l-5 6H5z" /><path d="M14 20v-6h5" /></>),
  eraser: svgIcon(<><path d="M16 4l4 4-9.5 9.5H6.5L4 15z" /><path d="M9 20h11" /></>),
  laser: svgIcon(<><circle cx="12" cy="12" r="3" fill="currentColor" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" /></>)
}

export default function BoardTab({ active }: { tab: Tab; active: boolean }): ReactElement {
  const toast = useStore((s) => s.toast)
  const [boards, setBoards] = useState<BoardSummary[]>([])
  const [board, setBoard] = useState<Board | null>(null)
  const [tool, setTool] = useState<Tool>('pen')
  const [palette, setPalette] = useState<string[]>(() => readJson(PALETTE_KEY, DEFAULT_PALETTE))
  const [color, setColor] = useState<string>(palette[0])
  const [width, setWidth] = useState(4)
  const [fill, setFill] = useState<'none' | 'tint' | 'solid'>('none')
  const [dashed, setDashed] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [spotlight, setSpotlight] = useState(false)
  const [spotRadius, setSpotRadius] = useState(150)
  const [fade, setFade] = useState(0)
  const [panel, setPanel] = useState(() => !isMobile() && window.innerWidth > 900)
  const [menu, setMenu] = useState<{ kind: 'more' | 'fade' | 'board'; anchor: HTMLElement; id?: string } | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  const [pointer, setPointer] = useState<Pt | null>(null)
  const [, tick] = useReducer((n: number) => n + 1, 0)

  const root = useRef<HTMLDivElement>(null)
  const svg = useRef<SVGSVGElement>(null)
  const itemsGroup = useRef<SVGGElement>(null)
  const defsRef = useRef<SVGDefsElement>(null)
  const colorInput = useRef<HTMLInputElement>(null)
  const editSlot = useRef<number>(0)
  const drag = useRef<Drag | null>(null)
  const touches = useRef(new Map<number, Pt>())
  const pinch = useRef<{ dist: number; center: Pt; view0: View } | null>(null)
  const spaceDown = useRef(false)
  const past = useRef<BoardItem[][]>([])
  const future = useRef<BoardItem[][]>([])
  /** Ink drawn with auto-erase on: when it disappears (never saved). */
  const fading = useRef(new Map<string, number>())
  const laser = useRef<{ x: number; y: number; t: number }[]>([])
  const clipboard = useRef<BoardItem[]>([])
  const boardRef = useRef(board)
  boardRef.current = board
  const selectedRef = useRef(selected)
  selectedRef.current = selected

  // ----- boards -----
  const persist = (b: Board): void => {
    const keep = { ...b, items: b.items.filter((it) => !fading.current.has(it.id)) }
    void window.api.invoke('boards:save', keep).catch((e: Error) => toast('error', e.message))
    setBoards((list) => [{ id: b.id, name: b.name, updatedAt: b.updatedAt, items: keep.items.length }, ...list.filter((x) => x.id !== b.id)])
  }
  const openBoard = async (id: string): Promise<void> => {
    if (boardRef.current) persist(boardRef.current)
    const b = await window.api.invoke('boards:load', id)
    if (!b) return
    past.current = []
    future.current = []
    fading.current.clear()
    setSelected([])
    setEditing(null)
    setBoard(b)
    writeJson(LAST_KEY, b.id)
  }
  const newBoard = (): void => {
    if (boardRef.current) persist(boardRef.current)
    const n = boards.filter((b) => /^Board( \d+)?$/.test(b.name)).length
    const b = freshBoard(n ? `Board ${n + 1}` : 'Board')
    if (root.current) b.view = { x: root.current.clientWidth / 2, y: root.current.clientHeight / 2, zoom: 1 }
    past.current = []
    future.current = []
    setSelected([])
    setBoard(b)
    persist(b)
    writeJson(LAST_KEY, b.id)
  }
  useEffect(() => {
    void window.api.invoke('boards:list').then(async (list) => {
      setBoards(list)
      const last = readJson<string | null>(LAST_KEY, null)
      const pick = list.find((b) => b.id === last) ?? list[0]
      if (pick) await openBoard(pick.id)
      else {
        const b = freshBoard('Brainstorm')
        if (root.current) b.view = { x: root.current.clientWidth / 2, y: root.current.clientHeight / 2, zoom: 1 }
        setBoard(b)
        persist(b)
      }
    }, (e: Error) => toast('error', e.message))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  // Saved a moment after the last change.
  useEffect(() => {
    if (!board) return
    const t = setTimeout(() => persist(board), 500)
    return () => clearTimeout(t)
  }, [board]) // eslint-disable-line react-hooks/exhaustive-deps

  const items = board?.items ?? []
  const view = board?.view ?? { x: 0, y: 0, zoom: 1 }
  const setView = (v: View): void => setBoard((b) => (b ? { ...b, view: v } : b))
  /** Replaces the items; `record` makes it one undo step (drags record once, when they end). */
  const setItems = useCallback((next: BoardItem[], record = true): void => {
    const b = boardRef.current
    if (!b) return
    if (record) {
      past.current = [...past.current.slice(-99), b.items]
      future.current = []
    }
    setBoard({ ...b, items: next, updatedAt: Date.now() })
  }, [])
  const undo = (): void => {
    const b = boardRef.current
    const prev = past.current.pop()
    if (!b || !prev) return
    future.current.push(b.items)
    setBoard({ ...b, items: prev, updatedAt: Date.now() })
    setSelected([])
  }
  const redo = (): void => {
    const b = boardRef.current
    const next = future.current.pop()
    if (!b || !next) return
    past.current.push(b.items)
    setBoard({ ...b, items: next, updatedAt: Date.now() })
  }

  // ----- auto-erase and laser animation -----
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now()
      if (fading.current.size) {
        const gone = [...fading.current].filter(([, at]) => at <= now).map(([id]) => id)
        if (gone.length) {
          gone.forEach((id) => fading.current.delete(id))
          const b = boardRef.current
          if (b) setBoard({ ...b, items: b.items.filter((it) => !gone.includes(it.id)) })
        } else tick()
      }
      if (laser.current.length) {
        laser.current = laser.current.filter((p) => now - p.t < 650)
        tick()
      }
    }, 50)
    return () => clearInterval(t)
  }, [])

  // ----- coordinates -----
  const screenPt = (e: { clientX: number; clientY: number }): Pt => {
    const r = svg.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const boardPt = (e: { clientX: number; clientY: number }): Pt => toBoard(screenPt(e), boardRef.current?.view ?? view)
  const tolerance = 6 / view.zoom

  const styleFor = (type: BoardItem['type']): Pick<BoardItem, 'color' | 'width' | 'fill' | 'dashed'> => ({
    color,
    width,
    ...(type === 'rect' || type === 'ellipse' || type === 'diamond' ? { fill, dashed } : type === 'line' || type === 'arrow' ? { dashed } : {})
  })

  const addItem = (it: BoardItem, opts: { select?: boolean } = {}): void => {
    setItems([...(boardRef.current?.items ?? []), it])
    if (fade && (it.type === 'pen' || it.type === 'highlighter' || it.type === 'line' || it.type === 'arrow' || it.type === 'rect' || it.type === 'ellipse' || it.type === 'diamond')) {
      fading.current.set(it.id, Date.now() + fade * 1000)
    }
    if (opts.select) setSelected([it.id])
  }
  const patchItem = (id: string, patch: Partial<BoardItem>, record = false): void => {
    setItems((boardRef.current?.items ?? []).map((it) => (it.id === id ? { ...it, ...patch } : it)), record)
  }

  const startText = (p: Pt, note: boolean): void => {
    const it: BoardItem = note
      ? { id: newId(), type: 'note', x: p.x - 100, y: p.y - 70, w: 200, h: 140, color: color === 'ink' ? '#facc15' : color === 'gradient' ? '#a78bfa' : color, width: 1, text: '', fontSize: NOTE_FONT }
      : { id: newId(), type: 'text', x: p.x, y: p.y - (TEXT_SIZES[width] ?? 26) * 0.6, w: 20, h: (TEXT_SIZES[width] ?? 26) * LINE_HEIGHT, color, width: 1, text: '', fontSize: TEXT_SIZES[width] ?? 26 }
    addItem(it, { select: true })
    setEditing(it.id)
  }

  /** Closes the text editor; a text box left empty goes away. */
  const finishEdit = (): void => {
    const cur = boardRef.current?.items.find((it) => it.id === editing)
    if (cur && cur.type === 'text' && !cur.text?.trim()) {
      setItems((boardRef.current?.items ?? []).filter((it) => it.id !== cur.id), false)
      setSelected((ids) => ids.filter((id) => id !== cur.id))
    }
    setEditing(null)
  }

  // ----- pointer -----
  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (!boardRef.current) return
    if (editing) { finishEdit(); return }
    try { svg.current!.setPointerCapture(e.pointerId) } catch { /* not an active pointer (synthetic events) */ }
    const sp = screenPt(e)
    if (e.pointerType === 'touch') {
      touches.current.set(e.pointerId, sp)
      if (touches.current.size === 2) {
        // A second finger: pinch to zoom and pan; whatever the first finger started is dropped.
        const [a, b] = [...touches.current.values()]
        pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, view0: boardRef.current.view }
        if (drag.current?.kind === 'draw') tick()
        drag.current = null
        return
      }
    }
    const p = toBoard(sp, boardRef.current.view)
    if (e.button === 1 || tool === 'hand' || spaceDown.current) {
      drag.current = { kind: 'pan', sx: sp.x, sy: sp.y, view0: boardRef.current.view }
      return
    }
    const pressure = e.pointerType === 'pen' ? e.pressure || 0.5 : 0.5
    switch (tool) {
      case 'pen':
      case 'highlighter':
        drag.current = { kind: 'draw', start: p, item: { id: newId(), type: tool, x: p.x, y: p.y, w: 0, h: 0, points: [[p.x, p.y, pressure]], ...styleFor(tool) } }
        break
      case 'line':
      case 'arrow':
      case 'rect':
      case 'ellipse':
      case 'diamond':
        drag.current = { kind: 'draw', start: p, item: { id: newId(), type: tool, x: p.x, y: p.y, w: 0, h: 0, points: tool === 'line' || tool === 'arrow' ? [[p.x, p.y], [p.x, p.y]] : undefined, ...styleFor(tool) } }
        break
      case 'text':
      case 'note':
        // Placed on release: the mouse-down's own focus change would otherwise blur the new text box at once.
        drag.current = { kind: 'place', at: p, note: tool === 'note' }
        break
      case 'eraser':
        drag.current = { kind: 'erase', base: items, removed: new Set() }
        eraseAt(p)
        break
      case 'laser':
        drag.current = { kind: 'laser' }
        laser.current.push({ ...p, t: Date.now() })
        break
      case 'select': {
        const handle = (e.target as Element).getAttribute('data-handle') as Handle | null
        const box = unionBounds(items.filter((it) => selected.includes(it.id)))
        if (handle && box) {
          drag.current = { kind: 'resize', handle, box0: box, base: items, ids: selected }
          return
        }
        const hit = topItemAt(items, p, tolerance)
        if (hit) {
          const ids = e.shiftKey ? (selected.includes(hit.id) ? selected.filter((x) => x !== hit.id) : [...selected, hit.id]) : selected.includes(hit.id) ? selected : [hit.id]
          setSelected(ids)
          drag.current = { kind: 'move', start: p, base: items, ids }
        } else {
          if (!e.shiftKey) setSelected([])
          drag.current = { kind: 'marquee', start: p, box: { x: p.x, y: p.y, w: 0, h: 0 }, keep: e.shiftKey ? selected : [] }
        }
        break
      }
    }
    tick()
  }

  const eraseAt = (p: Pt): void => {
    const d = drag.current
    if (d?.kind !== 'erase') return
    const hit = topItemAt((boardRef.current?.items ?? []).filter((it) => !d.removed.has(it.id)), p, tolerance * 1.5)
    if (!hit) return
    d.removed.add(hit.id)
    setItems(d.base.filter((it) => !d.removed.has(it.id)), false)
  }

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>): void => {
    const b = boardRef.current
    if (!b) return
    const sp = screenPt(e)
    if (spotlight) setPointer(sp)
    if (e.pointerType === 'touch' && touches.current.has(e.pointerId)) {
      touches.current.set(e.pointerId, sp)
      if (pinch.current && touches.current.size >= 2) {
        const [a, c] = [...touches.current.values()]
        const dist = Math.hypot(a.x - c.x, a.y - c.y)
        const center = { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 }
        const v0 = pinch.current.view0
        const z = zoomAt(v0, pinch.current.center, dist / (pinch.current.dist || 1))
        setView({ ...z, x: z.x + center.x - pinch.current.center.x, y: z.y + center.y - pinch.current.center.y })
        return
      }
    }
    const d = drag.current
    if (!d) return
    const p = toBoard(sp, b.view)
    switch (d.kind) {
      case 'pan':
        setView({ ...d.view0, x: d.view0.x + sp.x - d.sx, y: d.view0.y + sp.y - d.sy })
        break
      case 'draw': {
        const it = d.item
        if (it.type === 'pen' || it.type === 'highlighter') {
          // Coalesced events keep fast strokes smooth (the browser batches pointer moves per frame).
          const evs = (e.nativeEvent as PointerEvent).getCoalescedEvents?.() ?? []
          for (const ce of evs.length ? evs : [e.nativeEvent]) {
            const q = toBoard(screenPt(ce), b.view)
            it.points!.push([q.x, q.y, e.pointerType === 'pen' ? ce.pressure || 0.5 : 0.5])
          }
          Object.assign(it, boundsOfPoints(it.points!))
        } else if (it.type === 'line' || it.type === 'arrow') {
          const end = e.shiftKey ? snapAngle(d.start, p) : p
          it.points = [[d.start.x, d.start.y], [end.x, end.y]]
          Object.assign(it, boundsOfPoints(it.points))
        } else {
          Object.assign(it, boxOf(d.start, e.shiftKey ? squareFrom(d.start, p) : p))
        }
        tick()
        break
      }
      case 'move': {
        const dx = p.x - d.start.x
        const dy = p.y - d.start.y
        setItems(d.base.map((it) => (d.ids.includes(it.id) ? moveItem(it, dx, dy) : it)), false)
        break
      }
      case 'resize': {
        const b0 = d.box0
        let x0 = b0.x, y0 = b0.y, x1 = b0.x + b0.w, y1 = b0.y + b0.h
        if (d.handle.includes('w')) x0 = Math.min(p.x, x1 - 4)
        if (d.handle.includes('e')) x1 = Math.max(p.x, x0 + 4)
        if (d.handle.includes('n')) y0 = Math.min(p.y, y1 - 4)
        if (d.handle.includes('s')) y1 = Math.max(p.y, y0 + 4)
        if (e.shiftKey && b0.w && b0.h) {
          // Keep the shape's proportions.
          const k = Math.max((x1 - x0) / b0.w, (y1 - y0) / b0.h)
          if (d.handle.includes('w')) x0 = x1 - b0.w * k; else x1 = x0 + b0.w * k
          if (d.handle.includes('n')) y0 = y1 - b0.h * k; else y1 = y0 + b0.h * k
        }
        const to = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
        setItems(d.base.map((it) => (d.ids.includes(it.id) ? scaleItem(it, b0, to) : it)), false)
        break
      }
      case 'marquee':
        d.box = boxOf(d.start, p)
        setSelected([...new Set([...d.keep, ...itemsInBox(b.items, d.box)])])
        break
      case 'erase':
        eraseAt(p)
        break
      case 'laser':
        laser.current.push({ ...p, t: Date.now() })
        tick()
        break
    }
  }

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>): void => {
    touches.current.delete(e.pointerId)
    if (touches.current.size < 2) pinch.current = null
    const d = drag.current
    drag.current = null
    const b = boardRef.current
    if (!d || !b) return
    switch (d.kind) {
      case 'draw': {
        const it = d.item
        const tiny = it.w < 3 && it.h < 3
        if ((it.type === 'rect' || it.type === 'ellipse' || it.type === 'diamond') && tiny) {
          // A click without a drag drops a default-sized shape.
          addItem({ ...it, x: d.start.x - 80, y: d.start.y - 50, w: 160, h: 100 }, { select: false })
        } else if ((it.type === 'line' || it.type === 'arrow') && tiny) {
          /* nothing drawn */
        } else addItem(it)
        break
      }
      case 'place': {
        const hit = topItemAt(b.items, d.at, tolerance)
        if (hit && (hit.type === 'text' || hit.type === 'note')) { setSelected([hit.id]); setEditing(hit.id) } else startText(d.at, d.note)
        break
      }
      case 'move':
      case 'resize':
      case 'erase':
        if (b.items !== d.base) {
          past.current = [...past.current.slice(-99), d.base]
          future.current = []
        }
        break
    }
    tick()
  }

  const onDoubleClick = (e: React.MouseEvent): void => {
    if (tool !== 'select' && tool !== 'text') return
    const p = boardPt(e)
    const hit = topItemAt(items, p, tolerance)
    if (hit && (hit.type === 'text' || hit.type === 'note')) { setSelected([hit.id]); setEditing(hit.id) } else if (!hit) startText(p, false)
  }

  // Trackpad: two-finger scroll pans, pinch (ctrl + wheel) zooms around the pointer.
  useEffect(() => {
    const el = svg.current
    if (!el) return
    const wheel = (e: WheelEvent): void => {
      const b = boardRef.current
      if (!b) return
      e.preventDefault()
      const sp = screenPt(e)
      if (e.ctrlKey || e.metaKey) setView(zoomAt(b.view, sp, Math.exp(-e.deltaY * 0.01)))
      else setView({ ...b.view, x: b.view.x - e.deltaX, y: b.view.y - e.deltaY })
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [!!board]) // eslint-disable-line react-hooks/exhaustive-deps

  // ----- editing commands -----
  const selItems = (): BoardItem[] => (boardRef.current?.items ?? []).filter((it) => selectedRef.current.includes(it.id))
  const deleteSelected = (): void => {
    const ids = selectedRef.current
    if (!ids.length) return
    setItems((boardRef.current?.items ?? []).filter((it) => !ids.includes(it.id)))
    setSelected([])
  }
  const duplicate = (src = selItems(), offset = 24): void => {
    if (!src.length) return
    const copies = src.map((it) => ({ ...moveItem(it, offset, offset), id: newId() }))
    setItems([...(boardRef.current?.items ?? []), ...copies])
    setSelected(copies.map((c) => c.id))
  }
  const reorder = (front: boolean): void => {
    const ids = selectedRef.current
    const all = boardRef.current?.items ?? []
    const moving = all.filter((it) => ids.includes(it.id))
    const rest = all.filter((it) => !ids.includes(it.id))
    setItems(front ? [...rest, ...moving] : [...moving, ...rest])
  }
  const restyle = (patch: Partial<BoardItem>): void => {
    const ids = selectedRef.current
    if (!ids.length) return
    setItems((boardRef.current?.items ?? []).map((it) => (ids.includes(it.id) ? { ...it, ...patch, ...(patch.width && it.type === 'text' ? { fontSize: TEXT_SIZES[patch.width] } : {}) } : it)))
  }
  const pickColor = (c: string): void => { setColor(c); restyle({ color: c }) }
  const pickWidth = (w: number): void => { setWidth(w); restyle({ width: w }) }
  const fitAll = (): void => {
    const el = root.current
    if (!el || !boardRef.current) return
    setView(fitView(unionBounds(boardRef.current.items), { w: el.clientWidth, h: el.clientHeight }))
  }
  const zoomBy = (f: number): void => {
    const el = root.current
    if (!el || !boardRef.current) return
    setView(zoomAt(boardRef.current.view, { x: el.clientWidth / 2, y: el.clientHeight / 2 }, f))
  }

  // ----- images, copy and paste -----
  const addImage = (src: string, at?: Pt): void => {
    const img = new Image()
    img.onload = () => {
      const el = root.current
      const v = boardRef.current?.view ?? view
      const c = at ?? toBoard({ x: (el?.clientWidth ?? 800) / 2, y: (el?.clientHeight ?? 600) / 2 }, v)
      const k = Math.min(1, 640 / Math.max(img.width, img.height))
      const w = img.width * k
      const h = img.height * k
      addItem({ id: newId(), type: 'image', x: c.x - w / 2, y: c.y - h / 2, w, h, color: 'ink', width: 1, src }, { select: true })
      setTool('select')
    }
    img.src = src
  }
  const readImage = (file: File, at?: Pt): void => {
    if (file.size > 12 * 1024 * 1024) { toast('error', 'That image is over 12 MB.'); return }
    const r = new FileReader()
    r.onload = () => addImage(String(r.result), at)
    r.readAsDataURL(file)
  }
  useEffect(() => {
    if (!active) return
    const typing = (t: EventTarget | null): boolean => t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
    const onCopy = (e: ClipboardEvent): void => {
      if (typing(e.target) || !selectedRef.current.length) return
      clipboard.current = selItems()
      e.clipboardData?.setData('text/plain', clipboard.current.map((it) => it.text).filter(Boolean).join('\n') || 'Whiteboard items')
      e.preventDefault()
      if (e.type === 'cut') deleteSelected()
    }
    const onPaste = (e: ClipboardEvent): void => {
      if (typing(e.target)) return
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'))
      if (file) { e.preventDefault(); readImage(file); return }
      const text = e.clipboardData?.getData('text/plain') ?? ''
      // What was copied on this board comes back as items; other text becomes a text box.
      if (clipboard.current.length && (text === 'Whiteboard items' || text === clipboard.current.map((it) => it.text).filter(Boolean).join('\n'))) {
        e.preventDefault()
        duplicate(clipboard.current, 24)
      } else if (text.trim()) {
        e.preventDefault()
        const el = root.current
        const c = toBoard({ x: (el?.clientWidth ?? 800) / 2, y: (el?.clientHeight ?? 600) / 2 }, boardRef.current?.view ?? view)
        const fs = TEXT_SIZES[width] ?? 26
        addItem({ id: newId(), type: 'text', x: c.x, y: c.y, ...textSize(text, fs), color, width: 1, text, fontSize: fs }, { select: true })
      }
    }
    document.addEventListener('copy', onCopy)
    document.addEventListener('cut', onCopy)
    document.addEventListener('paste', onPaste)
    return () => {
      document.removeEventListener('copy', onCopy)
      document.removeEventListener('cut', onCopy)
      document.removeEventListener('paste', onPaste)
    }
  }, [active, color, width, fade]) // eslint-disable-line react-hooks/exhaustive-deps

  // ----- keyboard -----
  const onTabKey = (k: TabKey): boolean => {
    if (k.ctrl) return false
    // Typing a note or a board name keeps the text field's own ⌘Z, ⌘A and friends.
    const el = document.activeElement
    if (el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return false
    switch (k.key) {
      case 'z':
        if (k.shift) redo(); else undo()
        return true
      case 'y': redo(); return true
      case 'd': duplicate(); return true
      case 'a': setTool('select'); setSelected(items.map((it) => it.id)); return true
      case '=': case '+': zoomBy(1.2); return true
      case '-': zoomBy(1 / 1.2); return true
      case '0': fitAll(); return true
      case ']': if (!k.shift) { reorder(true); return true } return false
      case '[': if (!k.shift) { reorder(false); return true } return false
    }
    return false
  }
  const keyRef = useRef(onTabKey)
  keyRef.current = onTabKey
  useEffect(() => {
    if (!active) return
    setTabKeys('board', (k) => keyRef.current(k))
    return () => setTabKeys('board', null)
  }, [active])
  const plainKey = useRef<(e: KeyboardEvent) => void>(() => undefined)
  plainKey.current = (e: KeyboardEvent): void => {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
    if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector('.modal-backdrop')) return
    const key = e.key.toLowerCase()
    const t2 = TOOLS.find((x) => x.key === key)
    if (t2 && !e.shiftKey) { e.preventDefault(); setTool(t2.tool); if (t2.tool !== 'select') setSelected([]); return }
    if (key === ' ' && !e.repeat) { spaceDown.current = true; e.preventDefault(); tick(); return }
    if (key === 'backspace' || key === 'delete') { e.preventDefault(); deleteSelected(); return }
    if (key === 'escape') { setSelected([]); setTool('select'); return }
    if (key === 'f') { setSpotlight((s) => !s); return }
    if (key === '[' || key === ']') {
      const up = key === ']'
      if (spotlight) setSpotRadius((r) => Math.max(60, Math.min(500, r + (up ? 30 : -30))))
      else pickWidth(WIDTHS[Math.max(0, Math.min(WIDTHS.length - 1, WIDTHS.indexOf(width) + (up ? 1 : -1)))])
      return
    }
    if (/^[1-6]$/.test(key)) { pickColor(key === '6' ? 'gradient' : palette[Number(key) - 1]); return }
    if (key.startsWith('arrow') && selectedRef.current.length) {
      e.preventDefault()
      const step = e.shiftKey ? 10 : 1
      const dx = key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0
      const dy = key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0
      setItems((boardRef.current?.items ?? []).map((it) => (selectedRef.current.includes(it.id) ? moveItem(it, dx, dy) : it)))
    }
  }
  useEffect(() => {
    if (!active) return
    // On document: the window-level key guard (for the RDP client) stops window listeners for other tabs.
    const down = (e: KeyboardEvent): void => plainKey.current(e)
    const up = (e: KeyboardEvent): void => { if (e.key === ' ') { spaceDown.current = false; tick() } }
    document.addEventListener('keydown', down)
    document.addEventListener('keyup', up)
    return () => { document.removeEventListener('keydown', down); document.removeEventListener('keyup', up) }
  }, [active])

  // ----- export -----
  const colors = (): { ink: string; paper: string } => {
    const cs = getComputedStyle(root.current!)
    // Custom properties compute with their var() references resolved, so these are the theme's current colours.
    return { ink: cs.getPropertyValue('--board-ink').trim() || '#111', paper: cs.getPropertyValue('--board-paper').trim() || '#fff' }
  }
  const png = async (): Promise<string | null> => {
    const box = unionBounds(selected.length ? selItems() : items)
    if (!box || !itemsGroup.current) { toast('info', 'The board is empty.'); return null }
    let group = itemsGroup.current
    if (selected.length) {
      group = itemsGroup.current.cloneNode(true) as SVGGElement
      for (const el of [...group.children]) if (!selected.includes(el.getAttribute('data-id') ?? '')) el.remove()
    }
    return exportPng(group, defsRef.current, box, colors())
  }
  const exportFile = async (): Promise<void> => {
    const url = await png()
    if (!url || !board) return
    const a = document.createElement('a')
    a.href = url
    a.download = `${board.name}.png`
    a.click()
  }
  const copyImage = async (): Promise<void> => {
    const url = await png()
    if (!url) return
    try {
      const blob = await (await fetch(url)).blob()
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      toast('success', 'Image copied')
    } catch {
      toast('error', 'Copying an image is not allowed here; use Export PNG.')
    }
  }
  const toNote = async (): Promise<void> => {
    const url = await png()
    if (!url || !board) return
    try {
      const rel = await window.api.invoke('notes:saveImage', board.name, url)
      const daily = await window.api.invoke('notes:daily')
      await window.api.invoke('notes:append', daily, `![[${rel.split('/').pop()}]]`)
      toast('success', `Board added to today's note`)
    } catch (e) {
      toast('error', (e as Error).message)
    }
  }

  // ----- rendering -----
  if (!board) return <div className="board" />

  const editItem = editing ? items.find((it) => it.id === editing) : undefined
  const selBox = unionBounds(items.filter((it) => selected.includes(it.id)))
  const draft = drag.current?.kind === 'draw' ? drag.current.item : null
  const marquee = drag.current?.kind === 'marquee' ? drag.current.box : null
  const now = Date.now()
  const opacityOf = (id: string): number => {
    const at = fading.current.get(id)
    return at ? Math.max(0, Math.min(1, (at - now) / 700)) : 1
  }
  const grid = 24 * view.zoom
  const cursor = spaceDown.current || tool === 'hand' ? (drag.current?.kind === 'pan' ? 'grabbing' : 'grab') : tool === 'select' ? 'default' : tool === 'text' ? 'text' : tool === 'laser' ? 'none' : 'crosshair'
  const shapeTool = (['rect', 'ellipse', 'diamond'] as Tool[]).includes(tool) || selItems().some((it) => it.type === 'rect' || it.type === 'ellipse' || it.type === 'diamond')
  const lineTool = (['line', 'arrow', 'rect', 'ellipse', 'diamond'] as Tool[]).includes(tool) || selItems().some((it) => it.type === 'line' || it.type === 'arrow' || it.type === 'rect' || it.type === 'ellipse' || it.type === 'diamond')
  const handleAt = (h: Handle, b: Box): Pt => ({
    x: h.includes('w') ? b.x : h.includes('e') ? b.x + b.w : b.x + b.w / 2,
    y: h.includes('n') ? b.y : h.includes('s') ? b.y + b.h : b.y + b.h / 2
  })
  const laserPts = laser.current

  return (
    <div className={`board ${panel ? '' : 'no-panel'}`}>
      {panel && (
        <aside className="board-side">
          <div className="board-side-head">
            <span className="board-side-title">Boards</span>
            <span className="flex-1" />
            <button type="button" className="term-tool" title="New board" aria-label="New board" onClick={newBoard}><Icon.plus /></button>
          </div>
          <div className="board-list">
            {boards.map((b) => (
              <div
                key={b.id}
                className={`board-row ${b.id === board.id ? 'on' : ''}`}
                onClick={() => { if (b.id !== board.id) void openBoard(b.id) }}
                onDoubleClick={() => setRenaming({ id: b.id, value: b.name })}
                onContextMenu={(e) => { e.preventDefault(); setMenu({ kind: 'board', anchor: e.currentTarget, id: b.id }) }}
              >
                {renaming?.id === b.id ? (
                  <input
                    className="term-tab-rename"
                    autoFocus
                    value={renaming.value}
                    onChange={(e) => setRenaming({ id: b.id, value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { const name = renaming.value.trim() || b.name; setRenaming(null); if (b.id === board.id) setBoard({ ...board, name, updatedAt: Date.now() }); else void window.api.invoke('boards:load', b.id).then((x) => { if (x) persist({ ...x, name, updatedAt: Date.now() }) }) }
                      else if (e.key === 'Escape') setRenaming(null)
                    }}
                    onBlur={() => setRenaming(null)}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <>
                    <span className="board-row-name">{b.name}</span>
                    <span className="board-row-sub">{b.items} item{b.items === 1 ? '' : 's'} · {new Date(b.updatedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
                  </>
                )}
              </div>
            ))}
          </div>
        </aside>
      )}

      <div
        ref={root}
        className={`board-canvas bg-${board.background}`}
        style={{ backgroundSize: `${grid}px ${grid}px`, backgroundPosition: `${view.x}px ${view.y}px` } as CSSProperties}
        onDragOver={(e) => { if ([...e.dataTransfer.items].some((i) => i.type.startsWith('image/'))) e.preventDefault() }}
        onDrop={(e) => {
          const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'))
          if (!files.length) return
          e.preventDefault()
          files.forEach((f, i) => readImage(f, { ...boardPt(e), x: boardPt(e).x + i * 30 }))
        }}
      >
        <svg
          ref={svg}
          className="board-svg"
          style={{ cursor }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => setPointer(null)}
          onDoubleClick={onDoubleClick}
        >
          <defs ref={defsRef}>
            {items.map((it) => <GradientDef key={it.id} it={it} />)}
            {draft && <GradientDef it={draft} />}
          </defs>
          <g transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
            <g ref={itemsGroup} className="board-items">
              {items.map((it) => (it.id !== editing ? <ItemView key={it.id} it={it} opacity={opacityOf(it.id)} /> : it.type === 'note' ? <ItemView key={it.id} it={{ ...it, text: '' }} /> : null))}
            </g>
            {draft && <ItemView it={draft} />}
            {laserPts.length > 1 && (
              <polyline
                className="board-laser"
                points={laserPts.map((p) => `${p.x},${p.y}`).join(' ')}
                fill="none"
                strokeWidth={6 / view.zoom}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
            {selBox && !editing && (
              <g className="board-selection">
                <rect x={selBox.x - 4 / view.zoom} y={selBox.y - 4 / view.zoom} width={selBox.w + 8 / view.zoom} height={selBox.h + 8 / view.zoom} vectorEffect="non-scaling-stroke" />
                {tool === 'select' && HANDLES.map((h) => {
                  const p = handleAt(h, { x: selBox.x - 4 / view.zoom, y: selBox.y - 4 / view.zoom, w: selBox.w + 8 / view.zoom, h: selBox.h + 8 / view.zoom })
                  const s = 9 / view.zoom
                  return <rect key={h} data-handle={h} className={`board-handle h-${h}`} x={p.x - s / 2} y={p.y - s / 2} width={s} height={s} rx={2 / view.zoom} vectorEffect="non-scaling-stroke" />
                })}
              </g>
            )}
            {marquee && <rect className="board-marquee" x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h} vectorEffect="non-scaling-stroke" />}
          </g>
        </svg>

        {editItem && (() => {
          const fs = editItem.fontSize ?? (editItem.type === 'note' ? NOTE_FONT : 26)
          const at = toScreen({ x: editItem.x, y: editItem.y }, view)
          const note = editItem.type === 'note'
          const st: CSSProperties = {
            left: at.x,
            top: at.y,
            fontSize: fs * view.zoom,
            lineHeight: LINE_HEIGHT,
            color: editItem.color === 'ink' || note ? 'var(--board-ink)' : editItem.color === 'gradient' ? GRADIENT[0] : editItem.color,
            width: note ? editItem.w * view.zoom : Math.max(60, (editItem.w + fs) * view.zoom),
            height: note ? editItem.h * view.zoom : Math.max(fs * LINE_HEIGHT, editItem.h) * view.zoom + 4,
            padding: note ? NOTE_PAD * view.zoom : 0
          }
          return (
            <textarea
              key={editItem.id}
              className={`board-editor ${note ? 'note' : ''}`}
              style={st}
              autoFocus
              value={editItem.text ?? ''}
              placeholder={note ? 'Note…' : 'Type…'}
              onChange={(e) => {
                const text = e.target.value
                if (note) {
                  const lines = noteLines({ ...editItem, text }).length
                  patchItem(editItem.id, { text, h: Math.max(editItem.h, lines * fs * LINE_HEIGHT + 2 * NOTE_PAD) })
                } else patchItem(editItem.id, { text, ...textSize(text, fs) })
              }}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); finishEdit() } }}
              onBlur={finishEdit}
            />
          )
        })()}

        {spotlight && pointer && (
          <div className="board-spotlight" style={{ background: `radial-gradient(circle at ${pointer.x}px ${pointer.y}px, transparent ${spotRadius}px, rgba(0, 0, 0, .62) ${spotRadius + 1}px)` }} />
        )}

        <div className="board-toolbar" role="toolbar" aria-label="Whiteboard tools">
          {TOOLS.map((t) => (
            <button key={t.tool} type="button" className={`bt-btn ${tool === t.tool ? 'on' : ''}`} title={`${t.label} (${t.key.toUpperCase()})`} aria-label={t.label} aria-pressed={tool === t.tool} onClick={() => { setTool(t.tool); if (t.tool !== 'select') setSelected([]) }}>
              {TOOL_ICONS[t.tool]}
              <span className="bt-key">{t.key.toUpperCase()}</span>
            </button>
          ))}
          <span className="bt-sep" />
          {palette.map((c, i) => (
            <button
              key={i}
              type="button"
              className={`bt-swatch ${color === c ? 'on' : ''} ${c === 'ink' ? 'ink' : ''}`}
              style={c === 'ink' ? undefined : { background: c }}
              title={`${c === 'ink' ? 'Ink (black or white)' : c} (${i + 1}) · right-click to change`}
              aria-label={`Colour ${i + 1}`}
              onClick={() => pickColor(c)}
              onContextMenu={(e) => { e.preventDefault(); editSlot.current = i; if (colorInput.current) { colorInput.current.value = c.startsWith('#') ? c : '#000000'; colorInput.current.click() } }}
            />
          ))}
          <button type="button" className={`bt-swatch gradient ${color === 'gradient' ? 'on' : ''}`} style={{ background: `linear-gradient(135deg, ${GRADIENT.join(', ')})` }} title="Gradient ink (6)" aria-label="Gradient" onClick={() => pickColor('gradient')} />
          <input
            ref={colorInput}
            type="color"
            className="bt-color-input"
            onChange={(e) => {
              const next = palette.map((c, i) => (i === editSlot.current ? e.target.value : c))
              setPalette(next)
              writeJson(PALETTE_KEY, next)
              pickColor(e.target.value)
            }}
          />
          <span className="bt-sep" />
          {WIDTHS.map((w) => (
            <button key={w} type="button" className={`bt-btn width ${width === w ? 'on' : ''}`} title={`${w === 2 ? 'Thin' : w === 4 ? 'Medium' : 'Bold'} ([ and ])`} aria-label={`Width ${w}`} onClick={() => pickWidth(w)}>
              <span className="bt-dot" style={{ width: w + 3, height: w + 3 }} />
            </button>
          ))}
          {shapeTool && (
            <button type="button" className={`bt-btn ${fill !== 'none' ? 'on' : ''}`} title={`Fill: ${fill}`} aria-label="Fill" onClick={() => { const next = fill === 'none' ? 'tint' : fill === 'tint' ? 'solid' : 'none'; setFill(next); restyle({ fill: next }) }}>
              {svgIcon(<rect x="5" y="5" width="14" height="14" rx="2" fill={fill === 'none' ? 'none' : 'currentColor'} fillOpacity={fill === 'tint' ? 0.3 : 1} />)}
            </button>
          )}
          {lineTool && (
            <button type="button" className={`bt-btn ${dashed ? 'on' : ''}`} title="Dashed" aria-label="Dashed" onClick={() => { setDashed(!dashed); restyle({ dashed: !dashed }) }}>
              {svgIcon(<path d="M4 12h3M10.5 12h3M17 12h3" />)}
            </button>
          )}
          <span className="bt-sep" />
          <button type="button" className={`bt-btn ${spotlight ? 'on' : ''}`} title="Spotlight (F; [ ] size)" aria-label="Spotlight" onClick={() => setSpotlight(!spotlight)}>
            {svgIcon(<><circle cx="12" cy="12" r="4" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></>)}
          </button>
          <button type="button" className={`bt-btn ${fade ? 'on' : ''}`} title={fade ? `Auto-erase after ${fade} s` : 'Auto-erase: off'} aria-label="Auto-erase" onClick={(e) => setMenu({ kind: 'fade', anchor: e.currentTarget })}>
            {svgIcon(<><circle cx="12" cy="13" r="7" /><path d="M12 9v4l2.5 2M10 3h4" /></>)}
            {fade > 0 && <span className="bt-badge">{fade}</span>}
          </button>
          <span className="bt-sep" />
          <button type="button" className="bt-btn" title="Undo (⌘Z)" aria-label="Undo" disabled={!past.current.length} onClick={undo}>{svgIcon(<path d="M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />)}</button>
          <button type="button" className="bt-btn" title="Redo (⌘⇧Z)" aria-label="Redo" disabled={!future.current.length} onClick={redo}>{svgIcon(<path d="M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />)}</button>
          <button type="button" className="bt-btn" title="More" aria-label="More" onClick={(e) => setMenu({ kind: 'more', anchor: e.currentTarget })}><Icon.more /></button>
        </div>

        <div className="board-name">
          <button type="button" className="term-tool" title={panel ? 'Hide the boards list' : 'Show the boards list'} aria-label="Boards list" onClick={() => setPanel(!panel)}><Icon.sidebar /></button>
          <span className="truncate">{board.name}</span>
          {selected.length > 0 && <span className="board-count">{selected.length} selected</span>}
        </div>

        <div className="board-zoom">
          <button type="button" className="term-tool" aria-label="Zoom out" title="Zoom out (⌘−)" onClick={() => zoomBy(1 / 1.2)}>−</button>
          <button type="button" className="board-zoom-value" title="Fit everything (⌘0)" onClick={fitAll}>{Math.round(view.zoom * 100)}%</button>
          <button type="button" className="term-tool" aria-label="Zoom in" title="Zoom in (⌘+)" onClick={() => zoomBy(1.2)}>+</button>
        </div>

        {!items.length && !draft && (
          <div className="board-hint">
            Draw with <b>P</b>, add sticky notes with <b>N</b>, text with <b>T</b>, shapes with <b>R O D A L</b>. Paste a screenshot to mark it up. Scroll to pan, pinch to zoom.
          </div>
        )}
      </div>

      {menu?.kind === 'fade' && (
        <Popover anchor={menu.anchor} width={210} onClose={() => setMenu(null)}>
          <MenuLabel>Auto-erase new ink</MenuLabel>
          {FADES.map((s) => <MenuItem key={s} on={fade === s} onClick={() => { setFade(s); setMenu(null) }}>{s ? `After ${s} seconds` : 'Off (keep drawings)'}</MenuItem>)}
          <div className="muted px-3 pb-1.5 pt-1 text-[10.5px] leading-snug">For presenting: what you draw fades away and is not saved, as in Presentify.</div>
        </Popover>
      )}

      {menu?.kind === 'more' && (
        <Popover anchor={menu.anchor} align="right" width={240} onClose={() => setMenu(null)}>
          <MenuLabel>Background</MenuLabel>
          {(['dots', 'grid', 'plain'] as const).map((bg) => <MenuItem key={bg} on={board.background === bg} onClick={() => setBoard({ ...board, background: bg, updatedAt: Date.now() })}>{bg === 'dots' ? 'Dots' : bg === 'grid' ? 'Grid' : 'Plain'}</MenuItem>)}
          <MenuSep />
          <MenuLabel>{selected.length ? 'Selection' : 'Whole board'}</MenuLabel>
          <MenuItem onClick={() => { setMenu(null); void exportFile() }}>Export PNG</MenuItem>
          <MenuItem onClick={() => { setMenu(null); void copyImage() }}>Copy as image</MenuItem>
          <MenuItem onClick={() => { setMenu(null); void toNote() }}>Add to today's note</MenuItem>
          {selected.length > 0 && (
            <>
              <MenuSep />
              <MenuItem onClick={() => { setMenu(null); duplicate() }} hint="⌘D">Duplicate</MenuItem>
              <MenuItem onClick={() => { setMenu(null); reorder(true) }} hint="⌘]">Bring to front</MenuItem>
              <MenuItem onClick={() => { setMenu(null); reorder(false) }} hint="⌘[">Send to back</MenuItem>
              <MenuItem danger onClick={() => { setMenu(null); deleteSelected() }} hint="⌫">Delete</MenuItem>
            </>
          )}
          <MenuSep />
          <MenuItem onClick={() => { setMenu(null); fitAll() }} hint="⌘0">Fit everything</MenuItem>
          <MenuItem danger disabled={!items.length} onClick={() => { setMenu(null); if (window.confirm(`Clear everything on "${board.name}"? (⌘Z brings it back)`)) { setItems([]); setSelected([]) } }}>Clear board</MenuItem>
        </Popover>
      )}

      {menu?.kind === 'board' && menu.id && (
        <Popover anchor={menu.anchor} width={200} onClose={() => setMenu(null)}>
          <MenuItem onClick={() => { const b = boards.find((x) => x.id === menu.id); setMenu(null); if (b) setRenaming({ id: b.id, value: b.name }) }}>Rename</MenuItem>
          <MenuItem onClick={async () => {
            setMenu(null)
            const src = menu.id === board.id ? board : await window.api.invoke('boards:load', menu.id!)
            if (!src) return
            const copy = { ...src, id: newId('b'), name: `${src.name} copy`, updatedAt: Date.now() }
            persist(copy)
            void openBoard(copy.id)
          }}>Duplicate</MenuItem>
          <MenuItem danger onClick={async () => {
            const b = boards.find((x) => x.id === menu.id)
            setMenu(null)
            if (!b || !window.confirm(`Delete the board "${b.name}"? This cannot be undone.`)) return
            await window.api.invoke('boards:delete', b.id)
            const rest = boards.filter((x) => x.id !== b.id)
            setBoards(rest)
            if (b.id === board.id) {
              if (rest[0]) { boardRef.current = null; void openBoard(rest[0].id) } else newBoard()
            }
          }}>Delete board</MenuItem>
        </Popover>
      )}
    </div>
  )
}


import { useEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent, type ReactElement, type RefObject } from 'react'
import type { PaneNode } from '@shared/types'
import { MAX_SPLIT, useStore, type Tab, type ToolKind } from '../store'
import { dockZone, equalize, resizeSplit, type Arrangement, type Direction, type Divider, type Rect } from '../termLayout'
import { findAll, onFindCount, onFindInAllPanes } from '../paneFind'
import { Icon } from './icons'

const ARRANGEMENTS: { kind: Arrangement; label: string; icon: (p: { className?: string }) => ReactElement; min: number }[] = [
  { kind: 'columns', label: 'Side by side', icon: Icon.split, min: 2 },
  { kind: 'rows', label: 'Stacked', icon: Icon.splitRows, min: 2 },
  { kind: 'main', label: 'One large, the rest stacked beside it', icon: Icon.splitMain, min: 3 },
  { kind: 'grid', label: 'Grid', icon: Icon.grid, min: 3 }
]

/** Panes that answer "find in all panes": terminals and web pages. */
const searchable = (t: Tab | undefined): boolean => t?.kind === 'ssh' || t?.kind === 'browser'

/**
 * The strip over a split: arrangements, one find box that searches every terminal and web page in the split at once
 * (with a count per pane, to compare a value across a ticket and the hosts), and the way to add a pane or leave.
 */
export function SplitBar({ ids }: { ids: string[] }): ReactElement {
  const tabs = useStore((s) => s.tabs)
  const activeTab = useStore((s) => s.activeTab)
  const [text, setText] = useState('')
  const [counts, setCounts] = useState<Record<string, number | null>>({})
  const input = useRef<HTMLInputElement>(null)
  const idsRef = useRef(ids)
  idsRef.current = ids
  const textRef = useRef(text)
  textRef.current = text
  const panes = ids.map((id) => tabs.find((t) => t.id === id)).filter((t): t is Tab => !!t)
  const askable = panes.filter(searchable)

  const search = (q: string): void => {
    setText(q)
    setCounts({})
    findAll({ ids: idsRef.current, text: q })
  }
  /** The next match in one pane: the given one, else the focused pane when it has matches, else the first that does. */
  const step = (back: boolean, tabId?: string): void => {
    if (!text) return
    const target = tabId ?? (counts[activeTab] ? activeTab : askable.find((t) => counts[t.id])?.id)
    if (!target) return
    if (target !== activeTab) useStore.getState().focusPane(target)
    findAll({ ids, text, step: { tabId: target, back } })
  }

  useEffect(() => onFindCount((d) => {
    if (idsRef.current.includes(d.tabId)) setCounts((c) => (c[d.tabId] === d.count ? c : { ...c, [d.tabId]: d.count }))
  }), [])
  // Text picked in a pane ("Find in all panes" on a terminal selection or a page's menu).
  useEffect(() => onFindInAllPanes((q) => {
    search(q)
    input.current?.focus()
  }), []) // eslint-disable-line react-hooks/exhaustive-deps
  // A pane joining the split is searched too; leaving the split clears every highlight.
  const idKey = ids.join('|')
  useEffect(() => {
    if (textRef.current) findAll({ ids: idsRef.current, text: textRef.current })
  }, [idKey])
  useEffect(() => () => findAll({ ids: idsRef.current, text: '' }), [])

  const s = useStore.getState()
  const total = askable.reduce((n, t) => n + (counts[t.id] ?? 0), 0)
  return (
    <div className="split-bar" role="toolbar" aria-label="Side by side">
      <span className="split-bar-label"><Icon.split /> Side by side</span>
      <span className="split-bar-group">
        {ARRANGEMENTS.filter((a) => ids.length >= a.min).map((a) => (
          <button key={a.kind} type="button" className="btn btn-ghost btn-sm btn-icon" title={`${a.label}: reset the sizes`} aria-label={a.label} onClick={() => s.arrangeSplit(a.kind)}>
            <a.icon />
          </button>
        ))}
      </span>
      {askable.length > 0 && (
        <span className="split-find">
          <Icon.search className="muted" />
          <input
            ref={input}
            value={text}
            placeholder={`Find in ${askable.length === 1 ? 'the' : `all ${askable.length}`} pane${askable.length === 1 ? '' : 's'}…`}
            aria-label="Find in all panes"
            spellCheck={false}
            onChange={(e) => search(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey) }
              else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); search(''); input.current?.blur() }
            }}
          />
          {text && <button type="button" className="split-find-x" aria-label="Clear" onClick={() => { search(''); input.current?.focus() }}><Icon.x /></button>}
        </span>
      )}
      {text && (
        <span className="split-counts" aria-live="polite">
          {askable.map((t) => {
            const n = counts[t.id]
            return (
              <button
                key={t.id}
                type="button"
                className={`split-count ${n ? 'hit' : n === 0 ? 'miss' : ''} ${t.id === activeTab ? 'on' : ''}`}
                title={n == null ? `${t.title}: nothing to search` : `${t.title}: ${n} match${n === 1 ? '' : 'es'}${n ? '. Click for the next one.' : ''}`}
                disabled={!n}
                onClick={() => step(false, t.id)}
              >
                <span className="truncate">{shortTitle(t)}</span>
                <b>{n ?? '–'}</b>
              </button>
            )
          })}
          {askable.length > 1 && <span className="muted">{total ? `${total} in all` : 'no matches'}</span>}
        </span>
      )}
      <span className="flex-1" />
      <button type="button" className="btn btn-ghost btn-sm" title="Open a host, a tab or a tool beside the focused pane (⌘\)" disabled={ids.length >= MAX_SPLIT} onClick={() => s.openQuickSwitcher('', { beside: activeTab })}>
        <Icon.plus /> Add
      </button>
      <button type="button" className="btn btn-ghost btn-sm" title="Show the focused pane on its own; the others stay open as tabs" onClick={() => s.endSplit()}>
        Done
      </button>
    </div>
  )
}

/** "web-01 @ prod" is long for a count chip; the host part is enough. */
function shortTitle(t: Tab): string {
  return t.kind === 'browser' ? (t.message?.split(' · ')[0] || 'Browser') : t.title.split(' @ ')[0]
}

/**
 * The borders between panes: drag to resize, double-click to make that split even again. While dragging, a shield
 * covers every pane, since a web page or a remote desktop under the pointer would otherwise take the mouse.
 */
export function SplitDividers({ tree, dividers, box }: { tree: PaneNode; dividers: Divider[]; box: RefObject<HTMLDivElement | null> }): ReactElement {
  const [drag, setDrag] = useState<{ dir: 'row' | 'column'; move: (x: number, y: number) => void } | null>(null)
  const lastDown = useRef<{ key: string; at: number } | null>(null)

  useEffect(() => {
    if (!drag) return
    const end = (): void => setDrag(null)
    window.addEventListener('pointerup', end)
    window.addEventListener('blur', end)
    return () => {
      window.removeEventListener('pointerup', end)
      window.removeEventListener('blur', end)
    }
  }, [drag])

  const start = (e: ReactPointerEvent, d: Divider, key: string): void => {
    const b = box.current?.getBoundingClientRect()
    if (!b || e.button !== 0) return
    e.preventDefault()
    // The second press of a double-click lands on the shield, not here, so the double-click is spotted by hand.
    const now = Date.now()
    if (lastDown.current?.key === key && now - lastDown.current.at < 350) {
      lastDown.current = null
      useStore.getState().setSplitTree(equalize(tree, d.path))
      return
    }
    lastDown.current = { key, at: now }
    const origin = d.dir === 'row' ? e.clientX : e.clientY
    const span = d.dir === 'row' ? d.span.w * b.width : d.span.h * b.height
    setDrag({
      dir: d.dir,
      move: (x, y) => useStore.getState().setSplitTree(resizeSplit(tree, d.path, d.index, ((d.dir === 'row' ? x : y) - origin) / span))
    })
  }

  return (
    <>
      {dividers.map((d) => {
        const key = `${d.path.join('.')}:${d.index}`
        return (
          <div
            key={key}
            className={`split-divider ${d.dir}`}
            role="separator"
            aria-orientation={d.dir === 'row' ? 'vertical' : 'horizontal'}
            title="Drag to resize; double-click for equal sizes"
            style={d.dir === 'row'
              ? { left: `calc(${d.at * 100}% - 3px)`, top: `${d.span.y * 100}%`, height: `${d.span.h * 100}%` }
              : { top: `calc(${d.at * 100}% - 3px)`, left: `${d.span.x * 100}%`, width: `${d.span.w * 100}%` }}
            onPointerDown={(e) => start(e, d, key)}
          />
        )
      })}
      {drag && <div className={`split-shield ${drag.dir}`} onPointerMove={(e) => drag.move(e.clientX, e.clientY)} onPointerUp={() => setDrag(null)} />}
    </>
  )
}

const ZONE_LABEL: Record<Direction | 'center', string> = { left: 'Beside, on the left', right: 'Beside, on the right', up: 'Above', down: 'Below', center: 'In its place' }

/**
 * Where a dragged tab (from the tab strip or a pane's header) or tool (from the app rail) lands: the nearest edge of the
 * pane under the pointer, or the middle to swap. It covers the panes for the whole drag, because a web page or a
 * remote desktop would swallow the drag events otherwise.
 */
export function DockShield({ box, paneRect }: { box: RefObject<HTMLDivElement | null>; paneRect: (x: number, y: number) => { id: string; r: Rect } | null }): ReactElement {
  const [hover, setHover] = useState<{ id: string; zone: Direction | 'center'; r: Rect } | null>(null)
  const where = (e: { clientX: number; clientY: number }): { id: string; zone: Direction | 'center'; r: Rect } | null => {
    const b = box.current?.getBoundingClientRect()
    if (!b) return null
    const x = (e.clientX - b.left) / b.width
    const y = (e.clientY - b.top) / b.height
    const hit = paneRect(x, y)
    return hit ? { ...hit, zone: dockZone(hit.r, x, y) } : null
  }
  const st = useStore.getState
  const dragged = (): string | null => {
    const d = st().dockDrag
    return d?.tabId ?? (d?.tool ? st().toolTab(d.tool) : null)
  }
  const draggedTab = st().dockDrag?.tabId
  const zone = hover && hover.id !== draggedTab ? hover : null
  const half = zone && zoneRect(zone.r, zone.zone)
  return (
    <div
      className="dock-shield"
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; const w = where(e); setHover((h) => (h?.id === w?.id && h?.zone === w?.zone ? h : w)) }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHover(null) }}
      onDrop={(e) => {
        e.preventDefault()
        const w = where(e)
        const id = w ? dragged() : null
        st().set({ dockDrag: null })
        if (w && id) st().dockPane(id, w.id, w.zone)
      }}
      // No mouse moves happen during a drag, so one means the drag ended somewhere this shield did not hear about.
      onMouseMove={() => st().set({ dockDrag: null })}
    >
      {half && (
        <div className="dock-hint" style={{ left: `${half.x * 100}%`, top: `${half.y * 100}%`, width: `${half.w * 100}%`, height: `${half.h * 100}%` }}>
          <span>{ZONE_LABEL[zone.zone]}</span>
        </div>
      )}
    </div>
  )
}

function zoneRect(r: Rect, zone: Direction | 'center'): Rect {
  switch (zone) {
    case 'left': return { ...r, w: r.w / 2 }
    case 'right': return { ...r, x: r.x + r.w / 2, w: r.w / 2 }
    case 'up': return { ...r, h: r.h / 2 }
    case 'down': return { ...r, y: r.y + r.h / 2, h: r.h / 2 }
    case 'center': return r
  }
}

/** Starts dragging a tab toward the session area; the shield appears a tick later, since changing the page while a drag starts can cancel it. */
export function startDockDrag(e: DragEvent, what: { tabId?: string; tool?: ToolKind }): void {
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('application/x-ec2ra-dock', what.tabId ?? what.tool ?? '')
  setTimeout(() => useStore.getState().set({ dockDrag: what }), 0)
}

export function endDockDrag(): void {
  if (useStore.getState().dockDrag) useStore.getState().set({ dockDrag: null })
}

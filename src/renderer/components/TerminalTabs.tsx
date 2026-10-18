import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { isSession, useStore, type Tab } from '../store'
import TerminalTab from './TerminalTab'
import RdpTab from './RdpTab'
import SftpTab from './SftpTab'
import NotesTab from './NotesTab'
import BrowserTab from './browser/BrowserTab'
import { Icon } from './icons'

const GAP = 4
/** Session count at which the title-bar brand collapses to its logo. */
const CROWDED_AT = 3
/** Width reserved for the "»" overflow button when some tabs do not fit. */
const OVERFLOW_W = 44

const dotFor = (st: string): string => (st === 'connected' ? 'var(--ok)' : st === 'connecting' ? 'var(--warn)' : st === 'error' ? 'var(--err)' : 'var(--muted)')
const iconFor = (t: Tab): ReactElement => (t.kind === 'rdp' ? <Icon.monitor /> : t.kind === 'sftp' ? <Icon.folder /> : t.kind === 'notes' ? <Icon.note /> : t.kind === 'browser' ? <Icon.globe /> : <Icon.terminal />)

function useWindowWidth(): number {
  const [w, setW] = useState(() => window.innerWidth)
  useEffect(() => {
    const on = (): void => setW(window.innerWidth)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return w
}

function uptime(since?: number): string {
  if (!since) return ''
  const m = Math.floor((Date.now() - since) / 60_000)
  return m < 1 ? 'just now' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`
}

function tabTooltip(t: Tab): string {
  const route = t.route === 'ssm' ? 'SSM Session Manager' : t.route === 'direct' ? 'direct' : undefined
  const head = t.status === 'connected' ? `Connected ${uptime(t.connectedAt)}${route ? ` via ${route}` : ''}` : t.status
  return [t.shellLabel ? `${t.title} · session "${t.shellLabel}"` : t.title, head, t.message].filter(Boolean).join('\n')
}

/** Tab strip rendered inside the title bar. Tabs that do not fit collapse into a "»" menu; the active tab always stays visible. */
export default function TerminalTabs(): ReactElement {
  const s = useStore()
  // A host grid's transient tabs are tiles, not tabs.
  const tabs = s.tabs.filter((t) => !t.transient)
  // The All grid tiles sessions; the Notes tab is not one.
  const sessions = tabs.filter(isSession).length
  const stripRef = useRef<HTMLDivElement>(null)
  const hostsRef = useRef<HTMLButtonElement>(null)
  const gridRef = useRef<HTMLButtonElement>(null)
  const tabRefs = useRef(new Map<string, HTMLDivElement>())
  const [hidden, setHidden] = useState<string[]>([])
  const [menuOpen, setMenuOpen] = useState(false)
  const menuBtnRef = useRef<HTMLButtonElement>(null)
  const [menuPos, setMenuPos] = useState({ top: 0, right: 0 })
  const [dragOver, setDragOver] = useState<string | null>(null)
  const dragId = useRef<string | null>(null)
  // Re-render once a minute so the uptime in tab tooltips stays current.
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000)
    return () => clearInterval(t)
  }, [])

  const measure = (): void => {
    const strip = stripRef.current
    if (!strip) return
    const widthOf = (id: string): number => (tabRefs.current.get(id)?.offsetWidth ?? 0) + GAP
    const order = tabs.map((t) => t.id)
    const fit = (avail: number): string[] => {
      const out: string[] = []
      let used = 0
      for (const id of order) {
        if (used + widthOf(id) > avail) break
        used += widthOf(id)
        out.push(id)
      }
      if (s.activeTab !== 'hosts' && order.includes(s.activeTab) && !out.includes(s.activeTab)) {
        // Make room for the active tab at the end of the visible run.
        while (out.length && used + widthOf(s.activeTab) > avail) used -= widthOf(out.pop()!)
        out.push(s.activeTab)
      }
      return out
    }
    const total = strip.clientWidth - (hostsRef.current?.offsetWidth ?? 0) - (gridRef.current ? gridRef.current.offsetWidth + GAP : 0) - GAP - 8
    let visible = fit(total)
    if (visible.length < order.length) visible = fit(total - OVERFLOW_W)
    const next = order.filter((id) => !visible.includes(id))
    setHidden((prev) => (prev.join('|') === next.join('|') ? prev : next))
  }

  const tabKey = tabs.map((t) => `${t.id}:${t.title}`).join('|')
  useLayoutEffect(measure, [tabKey, s.activeTab]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const ro = new ResizeObserver(measure)
    if (stripRef.current) ro.observe(stripRef.current)
    return () => ro.disconnect()
  }, [tabKey, s.activeTab]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!menuOpen) return
    const close = (): void => setMenuOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuOpen])

  const hiddenSet = new Set(hidden)
  const visibleTabs = [...tabs.filter((t) => !hiddenSet.has(t.id))]
  // The active tab is rendered last when it was pulled forward past hidden ones, matching the measurement.
  const activeIdx = visibleTabs.findIndex((t) => t.id === s.activeTab)
  if (activeIdx >= 0 && hidden.length && tabs.findIndex((t) => t.id === s.activeTab) > tabs.findIndex((t) => t.id === hidden[0])) {
    const [a] = visibleTabs.splice(activeIdx, 1)
    visibleTabs.push(a)
  }
  const hiddenTabs = tabs.filter((t) => hiddenSet.has(t.id))
  // With several sessions open the title bar's brand gives its width to the strip (see styles.css). This keys off the
  // tab count, not overflow: shrinking the brand makes the tabs fit, which would clear an overflow-based flag and
  // re-grow the brand, and the strip would flip between the two layouts forever.
  const crowded = tabs.length >= CROWDED_AT
  useEffect(() => {
    document.documentElement.toggleAttribute('data-tabs-crowded', crowded)
  }, [crowded])
  const splitShown = s.splitGroup.includes(s.activeTab)

  const renderTab = (t: Tab, ghost = false): ReactElement => (
    <div
      key={t.id}
      ref={(el) => {
        if (el) tabRefs.current.set(t.id, el)
        else tabRefs.current.delete(t.id)
      }}
      className={`tab no-drag cursor-default ${s.activeTab === t.id && !s.gridView ? 'on' : ''} ${splitShown && s.splitGroup.includes(t.id) ? 'in-split' : ''} ${dragOver === t.id ? 'drag-over' : ''}`}
      style={ghost ? { position: 'absolute', visibility: 'hidden', pointerEvents: 'none' } : undefined}
      onClick={() => s.setActive(t.id)}
      onAuxClick={(e) => { if (e.button === 1) void s.closeTab(t.id) }}
      title={tabTooltip(t)}
      draggable={!ghost}
      onDragStart={(e) => { dragId.current = t.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.title) }}
      onDragOver={(e) => { if (dragId.current && dragId.current !== t.id) { e.preventDefault(); setDragOver(t.id) } }}
      onDragLeave={() => setDragOver((d) => (d === t.id ? null : d))}
      onDrop={(e) => { e.preventDefault(); if (dragId.current) s.moveTab(dragId.current, t.id); dragId.current = null; setDragOver(null) }}
      onDragEnd={() => { dragId.current = null; setDragOver(null) }}
    >
      <span className="dot" style={{ background: dotFor(t.status), animation: t.status === 'connecting' ? 'pulse 1.2s infinite' : undefined }} />
      {iconFor(t)}
      <span className="max-w-48 truncate">{t.title}</span>
      {t.shellLabel && <span className="shell-chip">{t.shellLabel}</span>}
      {t.status === 'connected' && t.route && <span className={`route-chip ${t.route}`}>{t.route === 'ssm' ? 'SSM' : 'DIR'}</span>}
      <button
        className="close"
        title="Close"
        onClick={(e) => {
          e.stopPropagation()
          void s.closeTab(t.id)
        }}
      >
        <Icon.x />
      </button>
    </div>
  )

  return (
    <div ref={stripRef} className="drag relative flex min-w-0 flex-1 items-center gap-1 overflow-hidden px-2">
      <button ref={hostsRef} className={`tab no-drag ${s.activeTab === 'hosts' ? 'on' : ''}`} onClick={() => s.setActive('hosts')}>
        <Icon.cloud />
        Hosts
      </button>
      {sessions > 0 && (
        <button ref={gridRef} className={`tab no-drag ${s.gridView && !s.gridHost ? 'on' : ''}`} title="All sessions on one page (⌘0)" aria-pressed={s.gridView && !s.gridHost} onClick={() => s.showGrid(!s.gridView || !!s.gridHost)}>
          <Icon.grid />
          All <span className="mono text-[11px]">{sessions}</span>
        </button>
      )}
      {visibleTabs.map((t) => renderTab(t))}
      {/* Hidden tabs stay in the DOM (invisible) so their widths can be measured. */}
      {hiddenTabs.map((t) => renderTab(t, true))}
      {hiddenTabs.length > 0 && (
        <div className="no-drag ml-auto shrink-0" onMouseDown={(e) => e.stopPropagation()}>
          <button
            ref={menuBtnRef}
            className={`tab ${menuOpen ? 'on' : ''}`}
            title={`${hiddenTabs.length} more session${hiddenTabs.length === 1 ? '' : 's'}`}
            onClick={() => {
              const r = menuBtnRef.current?.getBoundingClientRect()
              if (r) setMenuPos({ top: r.bottom + 4, right: window.innerWidth - r.right })
              setMenuOpen(!menuOpen)
            }}
          >
            » <span className="mono text-[11px]">{hiddenTabs.length}</span>
          </button>
          {/* Portal: the strip clips overflow, so the menu floats above the page instead. */}
          {menuOpen &&
            createPortal(
              <div className="panel modal no-drag fixed z-50 min-w-64 border py-1 text-xs" style={{ top: menuPos.top, right: menuPos.right, borderRadius: 10 }} onMouseDown={(e) => e.stopPropagation()}>
              {hiddenTabs.map((t) => (
                <div
                  key={t.id}
                  className="flex cursor-default items-center gap-2 px-3 py-1.5 hover:bg-[var(--accent-soft)]"
                  onClick={() => {
                    s.setActive(t.id)
                    setMenuOpen(false)
                  }}
                >
                  <span className="dot" style={{ background: dotFor(t.status) }} />
                  {iconFor(t)}
                  <span className="min-w-0 flex-1 truncate">{t.title}</span>
                  <button
                    className="muted hover:!opacity-100"
                    title="Close"
                    onClick={(e) => {
                      e.stopPropagation()
                      void s.closeTab(t.id)
                    }}
                  >
                    <Icon.x />
                  </button>
                </div>
              ))}
              </div>,
              document.body
            )}
        </div>
      )}
    </div>
  )
}

/**
 * Session content areas, kept mounted so terminals retain their buffers. While the focused tab belongs to the split
 * group, every tab of the group is laid out side by side and a press inside a pane focuses it.
 *
 * `grid` tiles every session on one page with a header each. It is the same elements in a different layout, so nothing
 * reconnects; terminals refit to their tile, and desktops are letterboxed rather than resized (see RdpTab `tiled`).
 * The focused tile (activeTab) has the keyboard, desktops included. On a touch screen tiles are view-only and open on
 * tap, since the key bars and touch gestures need the full-size session.
 */
export function SessionPanes({ grid = false, touch = false }: { grid?: boolean; touch?: boolean }): ReactElement {
  const s = useStore()
  const width = useWindowWidth()
  const tiled = grid && s.tabs.length > 0
  // A host grid tiles only that machine's terminals (every shell kept on it); the All grid tiles every tab.
  const inGrid = (t: Tab): boolean => isSession(t) && (!s.gridHost || (t.instanceKey === s.gridHost && t.kind === 'ssh'))
  const split = !tiled && s.splitGroup.includes(s.activeTab) ? s.splitGroup : []
  const shown = (id: string): boolean => (tiled ? inGrid(s.tabs.find((t) => t.id === id)!) : id === s.activeTab || split.includes(id))
  const anyShown = s.tabs.some((t) => shown(t.id))
  const n = tiled ? s.tabs.filter(inGrid).length : s.tabs.length
  const cols = Math.max(1, Math.min(n <= 3 ? n : Math.ceil(Math.sqrt(n)), Math.floor(width / 380)))
  const focus = (id: string): void => {
    if (s.activeTab !== id) s.set({ activeTab: id })
  }
  return (
    <div
      className={tiled ? 'session-grid' : `session-panes min-h-0 flex-1 ${anyShown ? 'flex' : 'hidden'}`}
      style={tiled ? { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` } : undefined}
    >
      {s.tabs.map((t) => {
        const shield = tiled && touch
        return (
          <div
            key={t.id}
            data-tab-id={t.id}
            className={`session-pane min-h-0 min-w-0 flex-1 flex-col ${shown(t.id) ? 'flex' : 'hidden'} ${split.includes(t.id) ? 'split-pane' : ''} ${(split.length || tiled) && s.activeTab === t.id ? 'focused' : ''}`}
            style={split.length ? { order: split.indexOf(t.id) } : undefined}
            onMouseDownCapture={() => { if (split.length || tiled) focus(t.id) }}
          >
            <div className="tile-head" onDoubleClick={() => s.setActive(t.id)}>
              <span className="dot" style={{ background: dotFor(t.status), animation: t.status === 'connecting' ? 'pulse 1.2s infinite' : undefined }} />
              {iconFor(t)}
              <span className="tile-title truncate">{t.title}</span>
              {t.shellLabel && <span className="shell-chip">{t.shellLabel}</span>}
              {t.status === 'connected' && t.route && <span className={`route-chip ${t.route}`}>{t.route === 'ssm' ? 'SSM' : 'DIR'}</span>}
              <span className="muted min-w-0 flex-1 truncate">{t.message ?? t.status}</span>
              <button className="btn btn-ghost btn-sm btn-icon" title="Open full size" aria-label={`Open ${t.title}`} onClick={() => s.setActive(t.id)}><Icon.maximize /></button>
              {/* Closing a tile never ends a persistent shell: that stays a deliberate End in the Sessions list. */}
              <button className="btn btn-ghost btn-sm btn-icon" title={t.persistent ? 'Close this tile (the session keeps running on the host)' : 'Close'} aria-label={`Close ${t.title}`} onClick={() => void s.closeTab(t.id, { detach: !!t.persistent })}><Icon.x /></button>
            </div>
            <div className="tile-body relative flex min-h-0 flex-1 flex-col">
              {t.kind === 'rdp' ? <RdpTab tab={t} active={shown(t.id)} tiled={tiled} /> : t.kind === 'sftp' ? <SftpTab tab={t} active={shown(t.id)} /> : t.kind === 'notes' ? <NotesTab tab={t} active={shown(t.id)} /> : t.kind === 'browser' ? <BrowserTab tab={t} active={shown(t.id)} /> : <TerminalTab tab={t} active={s.activeTab === t.id} />}
              {shield && (
                <div
                  className="tile-shield"
                  onClick={() => s.setActive(t.id)}
                />
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** Title strip over a host's session grid: which machine, how many sessions, and the way back. */
export function HostGridBar(): ReactElement | null {
  const s = useStore()
  if (!s.gridView || !s.gridHost) return null
  const host = s.tabs.filter((t) => t.instanceKey === s.gridHost && t.kind === 'ssh')
  return (
    <div className="host-grid-bar panel flex items-center gap-2 border-b px-3 py-1.5 text-[12px]" style={{ borderColor: 'var(--border)' }}>
      <Icon.grid className="muted" />
      <b className="truncate">{host[0]?.title ?? 'Sessions'}</b>
      <span className="muted">{host.length} session{host.length === 1 ? '' : 's'} on this machine · click a tile to type in it, Open to keep one as a tab</span>
      <span className="flex-1" />
      <button className="btn btn-sm" onClick={() => s.showGrid(false)}>Done</button>
    </div>
  )
}

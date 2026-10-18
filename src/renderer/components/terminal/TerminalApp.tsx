import type { DragEvent, PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AccentColor, TermTabState, TerminalState } from '@shared/types'
import { folderName, tildify } from '@shared/termIntegration'
import { useStore, type Tab } from '../../store'
import { isMobile } from '../../mobile'
import { ACCENTS, metaFor } from '../../colors'
import { setTabKeys, type TabKey } from '../../shortcuts'
import { layoutRects, neighbor, paneIds, removePane, resizeSplit, splitPane, type Direction } from '../../termLayout'
import { Icon } from '../icons'
import Popover, { MenuItem, MenuLabel, MenuSep } from '../Popover'
import Pane, { type PaneApi, type PaneInfo } from './Pane'

/**
 * The Terminal tab: shells on this Mac, laid out like Warp. Tabs along the top (rename, colour, AWS profile, drag to
 * reorder), split panes inside a tab, and in each pane command blocks and an input box (Pane, InputDock). Panes are
 * drawn absolutely from the layout (termLayout.ts) so splitting or closing never remounts a terminal. The layout
 * and each pane's folder are saved (terminal.json) and the shells start again there on the next run.
 */

const inElectron = /\bElectron\//.test(navigator.userAgent)
const SIDE_WIDTH = { default: 230, min: 170, max: 440 }
const newId = (p: string): string => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

export default function TerminalApp({ tab, active }: { tab: Tab; active: boolean }): ReactElement {
  // On a paired phone or tablet the computer decides (Settings → Phone access → Terminals, or the gateway's flag).
  const [allowed, setAllowed] = useState<boolean | null>(inElectron ? true : null)
  useEffect(() => {
    if (!inElectron) window.api.invoke('term:available').then(setAllowed, () => setAllowed(false))
  }, [])
  if (allowed === null) return <div className="term-app" />
  if (!allowed) {
    return (
      <div className="browser-unavailable">
        <Icon.console />
        <div className="text-[15px] font-semibold">Terminals from this device are off</div>
        <p className="muted">They open a shell on the computer running the app, so the computer has to allow it: on the Mac, Settings → Phone access → Terminals; for the Pi gateway, deploy with ALLOW_TERMINALS=1. SSH sessions to your hosts work either way.</p>
      </div>
    )
  }
  return <Terminals tab={tab} active={active} />
}

type Menu =
  | { kind: 'tab'; id: string; anchor: HTMLElement }
  | { kind: 'new'; anchor: HTMLElement }
  | { kind: 'settings'; anchor: HTMLElement }

function freshTab(opts: { profile?: string; color?: AccentColor } = {}): TermTabState {
  const pane = newId('p')
  return { id: newId('t'), root: { type: 'pane', id: pane }, activePane: pane, ...opts }
}

function Terminals({ active }: { tab: Tab; active: boolean }): ReactElement {
  const settings = useStore((s) => s.settings)
  const profiles = useStore((s) => s.profiles)
  const request = useStore((s) => s.terminalRequest)
  const [st, setSt] = useState<TerminalState | null>(null)
  const [info, setInfo] = useState<Record<string, PaneInfo>>({})
  const [home, setHome] = useState<string>()
  const [menu, setMenu] = useState<Menu | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null)
  const body = useRef<HTMLDivElement>(null)
  const apis = useRef(new Map<string, PaneApi>())
  const dragTab = useRef<string | null>(null)
  const closedTabs = useRef<{ tab: TermTabState; cwds: Record<string, string> }[]>([])
  const handled = useRef<number | null>(null)
  const stRef = useRef(st)
  stRef.current = st

  useEffect(() => {
    window.api.invoke('local:home').then(setHome, () => undefined)
    window.api.invoke('term:loadState').then(
      (s) => setSt(s?.tabs?.length ? { ...s, cwds: s.cwds ?? {} } : { tabs: [freshTab()], activeTab: '', cwds: {} }),
      () => setSt({ tabs: [freshTab()], activeTab: '', cwds: {} })
    )
  }, [])
  useEffect(() => {
    if (!st) return
    const t = setTimeout(() => void window.api.invoke('term:saveState', st).catch(() => undefined), 800)
    return () => clearTimeout(t)
  }, [st])

  const update = useCallback((fn: (s: TerminalState) => TerminalState) => setSt((s) => (s ? fn(s) : s)), [])
  const current = st ? st.tabs.find((t) => t.id === st.activeTab) ?? st.tabs[0] : undefined
  const currentRef = useRef(current)
  currentRef.current = current
  const inputMode = st?.input ?? 'editor'

  const onInfo = useCallback((pane: string, patch: PaneInfo) => {
    setInfo((m) => ({ ...m, [pane]: { ...m[pane], ...patch } }))
    if (patch.cwd) update((s) => (s.cwds[pane] === patch.cwd ? s : { ...s, cwds: { ...s.cwds, [pane]: patch.cwd! } }))
  }, [update])

  // ----- tabs and panes -----
  const cwdOf = (pane: string | undefined): string | undefined => (pane ? info[pane]?.cwd ?? stRef.current?.cwds[pane] : undefined)
  const openTab = (opts: { profile?: string; cwd?: string } = {}): void => {
    const color = opts.profile ? metaFor(opts.profile, settings).color : undefined
    const t = freshTab({ profile: opts.profile, color })
    const cwd = opts.cwd ?? cwdOf(currentRef.current?.activePane)
    update((s) => {
      const at = s.tabs.findIndex((x) => x.id === (currentRef.current?.id ?? ''))
      const tabs = s.tabs.slice()
      tabs.splice(at < 0 ? tabs.length : at + 1, 0, t)
      return { ...s, tabs, activeTab: t.id, cwds: cwd ? { ...s.cwds, [t.activePane]: cwd } : s.cwds }
    })
  }
  const activateTab = (id: string): void => update((s) => ({ ...s, activeTab: id }))
  const closeTab = (id: string): void => {
    const s = stRef.current
    const t = s?.tabs.find((x) => x.id === id)
    if (!s || !t) return
    const ids = paneIds(t.root)
    closedTabs.current = [...closedTabs.current, { tab: t, cwds: Object.fromEntries(ids.map((p) => [p, cwdOf(p) ?? ''])) }].slice(-10)
    const idx = s.tabs.indexOf(t)
    const rest = s.tabs.filter((x) => x.id !== id)
    const next = s.activeTab === id || !s.activeTab ? rest[Math.min(idx, rest.length - 1)]?.id ?? '' : s.activeTab
    update((x) => ({ ...x, tabs: x.tabs.filter((y) => y.id !== id), activeTab: next, cwds: Object.fromEntries(Object.entries(x.cwds).filter(([p]) => !ids.includes(p))) }))
  }
  /** ⌘⇧T: the last closed tab comes back with the same layout, its shells starting again in the same folders. */
  const reopenTab = (): void => {
    const last = closedTabs.current.pop()
    if (!last) return
    const map: Record<string, string> = {}
    const renew = (n: TermTabState['root']): TermTabState['root'] => (n.type === 'pane' ? { type: 'pane', id: (map[n.id] = newId('p')) } : { ...n, children: n.children.map(renew) })
    const root = renew(last.tab.root)
    const t: TermTabState = { ...last.tab, id: newId('t'), root, activePane: map[last.tab.activePane] ?? paneIds(root)[0], maximized: undefined }
    update((s) => ({ ...s, tabs: [...s.tabs, t], activeTab: t.id, cwds: { ...s.cwds, ...Object.fromEntries(Object.entries(map).map(([old, nu]) => [nu, last.cwds[old]]).filter(([, c]) => c)) } }))
  }
  const patchTab = (id: string, patch: Partial<TermTabState>): void => update((s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))
  const split = (dir: 'row' | 'column'): void => {
    const t = currentRef.current
    if (!t) return
    const pane = newId('p')
    const cwd = cwdOf(t.activePane)
    update((s) => ({
      ...s,
      tabs: s.tabs.map((x) => (x.id === t.id ? { ...x, root: splitPane(x.root, x.activePane, pane, dir), activePane: pane, maximized: undefined } : x)),
      cwds: cwd ? { ...s.cwds, [pane]: cwd } : s.cwds
    }))
  }
  const closePane = (pane: string): void => {
    const s = stRef.current
    const t = s?.tabs.find((x) => paneIds(x.root).includes(pane))
    if (!t) return
    const root = removePane(t.root, pane)
    if (!root) { closeTab(t.id); return }
    const ids = paneIds(root)
    update((x) => ({
      ...x,
      tabs: x.tabs.map((y) => (y.id === t.id ? { ...y, root, activePane: y.activePane === pane ? ids[0] : y.activePane, maximized: y.maximized === pane ? undefined : y.maximized } : y)),
      cwds: Object.fromEntries(Object.entries(x.cwds).filter(([p]) => p !== pane))
    }))
  }
  const focusPane = (pane: string): void => {
    const t = currentRef.current
    if (t && t.activePane !== pane) patchTab(t.id, { activePane: pane })
  }
  const moveFocus = (dir: Direction): void => {
    const t = currentRef.current
    const next = t && neighbor(t.root, t.activePane, dir)
    if (next) focusPane(next)
  }
  const cyclePane = (step: number): void => {
    const t = currentRef.current
    if (!t) return
    const ids = paneIds(t.root)
    focusPane(ids[(ids.indexOf(t.activePane) + step + ids.length) % ids.length])
  }
  const cycleTab = (step: number): void => {
    const s = stRef.current
    if (!s?.tabs.length) return
    const at = s.tabs.findIndex((t) => t.id === currentRef.current?.id)
    activateTab(s.tabs[(at + step + s.tabs.length) % s.tabs.length].id)
  }
  const fontStep = (step: number): void => {
    const now = useStore.getState().settings?.terminalFontSize ?? 13
    const size = step === 0 ? 13 : Math.max(9, Math.min(28, now + step))
    void window.api.invoke('settings:set', { terminalFontSize: size }).then((next) => useStore.getState().set({ settings: next }))
  }

  // Requests from elsewhere in the app (title bar, ⌘K, ⌃`): a new tab, maybe for an AWS profile or a folder.
  useEffect(() => {
    if (!st || !request || handled.current === request.nonce) return
    handled.current = request.nonce
    if (request.profile || request.cwd || request.newTab) openTab({ profile: request.profile, cwd: request.cwd })
  }, [request, !!st]) // eslint-disable-line react-hooks/exhaustive-deps

  // ----- keyboard -----
  const onKey = (k: TabKey): boolean => {
    const t = currentRef.current
    const pane = t ? apis.current.get(t.activePane) : undefined
    if (k.ctrl) {
      if (k.key !== 'tab') return false
      cycleTab(k.shift ? -1 : 1)
      return true
    }
    if (/^[1-9]$/.test(k.key) && !k.shift && !k.alt) {
      const tabs = stRef.current?.tabs ?? []
      const target = k.key === '9' ? tabs.at(-1) : tabs[Number(k.key) - 1]
      if (target) activateTab(target.id)
      return true
    }
    if (k.alt && ['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(k.key)) {
      moveFocus(k.key.slice(5) as Direction)
      return true
    }
    switch (k.key) {
      case 't':
        if (k.shift) reopenTab()
        else openTab()
        return true
      case 'w':
        if (k.shift || !t) return false
        closePane(t.activePane)
        return true
      case 'd':
        split(k.shift ? 'column' : 'row')
        return true
      case 'enter':
        if (!k.shift || !t) return false
        patchTab(t.id, { maximized: t.maximized ? undefined : t.activePane })
        return true
      case '[':
      case ']':
        if (k.shift) return false
        cyclePane(k.key === ']' ? 1 : -1)
        return true
      case 'arrowup':
      case 'arrowdown':
        pane?.jump(k.key === 'arrowup' ? -1 : 1)
        return true
      case 'f':
        if (k.shift) return false
        pane?.find()
        return true
      case '=':
      case '+':
        fontStep(1)
        return true
      case '-':
        fontStep(-1)
        return true
      case '0':
        if (k.shift) return false
        fontStep(0)
        return true
    }
    return false
  }
  const keyRef = useRef(onKey)
  keyRef.current = onKey
  useEffect(() => {
    if (!active) return
    setTabKeys('local', (k) => keyRef.current(k))
    return () => setTabKeys('local', null)
  }, [active])

  const registerApi = useCallback((pane: string, api: PaneApi | null) => {
    if (api) apis.current.set(pane, api)
    else apis.current.delete(pane)
  }, [])

  // ----- rendering -----
  const allPanes = useMemo(() => (st ? st.tabs.flatMap((t) => paneIds(t.root).map((p) => ({ id: p, tab: t }))) : []), [st])
  const rects = useMemo(() => (current ? layoutRects(current.root) : { panes: {}, dividers: [] }), [current])
  if (!st) return <div className="term-app" />

  const titleOf = (t: TermTabState): string => {
    if (t.title) return t.title
    const i = info[t.activePane] ?? {}
    if (i.running) return i.running.split(/\s+/)[0] ?? i.running
    return folderName(cwdOf(t.activePane), home) || 'Terminal'
  }
  const busy = (t: TermTabState): boolean => paneIds(t.root).some((p) => info[p]?.running)
  /** The second line of a tab in the side list: what runs, else the folder; and how many panes. */
  const subtitleOf = (t: TermTabState): string => {
    const running = info[t.activePane]?.running
    const panes = paneIds(t.root).length
    return [running ? `▶ ${running}` : tildify(cwdOf(t.activePane) ?? '', home), panes > 1 ? `${panes} panes` : ''].filter(Boolean).join(' · ')
  }
  // A phone has no room for the side list.
  const vertical = (st.tabBar ?? 'vertical') === 'vertical' && !isMobile()
  const sideWidth = st.tabBarWidth ?? SIDE_WIDTH.default

  const dragProps = (t: TermTabState) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => { dragTab.current = t.id; e.dataTransfer.effectAllowed = 'move' },
    onDragEnd: () => { dragTab.current = null; setDrop(null) },
    onDragOver: (e: DragEvent) => {
      if (!dragTab.current || dragTab.current === t.id) return
      e.preventDefault()
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const after = vertical ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2
      if (drop?.id !== t.id || drop.after !== after) setDrop({ id: t.id, after })
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      const from = dragTab.current
      if (from && drop) {
        update((s) => {
          const moving = s.tabs.find((x) => x.id === from)!
          const tabs = s.tabs.filter((x) => x.id !== from)
          const at = tabs.findIndex((x) => x.id === drop.id) + (drop.after ? 1 : 0)
          tabs.splice(at, 0, moving)
          return { ...s, tabs }
        })
      }
      setDrop(null)
    }
  })

  const startDrag = (e: ReactPointerEvent, d: (typeof rects.dividers)[number]): void => {
    const t = currentRef.current
    const box = body.current?.getBoundingClientRect()
    if (!t || !box) return
    e.preventDefault()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const startRoot = t.root
    const start = d.dir === 'row' ? e.clientX : e.clientY
    const span = d.dir === 'row' ? d.span.w * box.width : d.span.h * box.height
    const move = (ev: PointerEvent): void => {
      const delta = ((d.dir === 'row' ? ev.clientX : ev.clientY) - start) / span
      patchTab(t.id, { root: resizeSplit(startRoot, d.path, d.index, delta) })
    }
    const up = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  const startSideDrag = (e: ReactPointerEvent): void => {
    e.preventDefault()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const x0 = e.clientX
    const w0 = sideWidth
    const move = (ev: PointerEvent): void => {
      const w = Math.round(Math.min(SIDE_WIDTH.max, Math.max(SIDE_WIDTH.min, w0 + ev.clientX - x0)))
      update((x) => (x.tabBarWidth === w ? x : { ...x, tabBarWidth: w }))
    }
    const up = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  const tabRow = (t: TermTabState, i: number): ReactElement => (
    <div
      key={t.id}
      role="tab"
      aria-selected={t.id === current?.id}
      className={`term-tab ${t.id === current?.id ? 'on' : ''} ${drop?.id === t.id ? (drop.after ? 'drop-after' : 'drop-before') : ''}`}
      data-accent={t.color}
      title={`${titleOf(t)}${t.profile ? ` · AWS ${t.profile}` : ''}${i < 8 ? `  ⌘${i + 1}` : ''}\n${cwdOf(t.activePane) ?? ''}`}
      onClick={() => activateTab(t.id)}
      onDoubleClick={() => setRenaming({ id: t.id, value: t.title ?? titleOf(t) })}
      onAuxClick={(e) => { if (e.button === 1) closeTab(t.id) }}
      onContextMenu={(e) => { e.preventDefault(); setMenu({ kind: 'tab', id: t.id, anchor: e.currentTarget }) }}
      {...dragProps(t)}
    >
      {t.color && <span className="term-tab-color" />}
      {busy(t) && t.id !== current?.id ? <span className="term-tab-busy" /> : null}
      <span className="term-tab-main">
        {renaming?.id === t.id ? (
          <input
            className="term-tab-rename"
            autoFocus
            value={renaming.value}
            onChange={(e) => setRenaming({ id: t.id, value: e.target.value })}
            onBlur={() => { patchTab(t.id, { title: renaming.value.trim() || undefined }); setRenaming(null) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { patchTab(t.id, { title: renaming.value.trim() || undefined }); setRenaming(null) }
              else if (e.key === 'Escape') setRenaming(null)
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="term-tab-title">{titleOf(t)}</span>
        )}
        {vertical && <span className="term-tab-sub">{subtitleOf(t)}</span>}
      </span>
      {t.profile && <span className="term-tab-aws">{t.profile}</span>}
      {vertical && (i < 8 || i === st.tabs.length - 1) && <span className="term-tab-key">⌘{i < 8 ? i + 1 : 9}</span>}
      <button type="button" className="term-tab-x" aria-label={`Close ${titleOf(t)}`} onClick={(e) => { e.stopPropagation(); closeTab(t.id) }}><Icon.x /></button>
    </div>
  )
  const moreButton = <button type="button" className="term-tab-more" title="New tab with an AWS profile…" aria-label="New tab options" onClick={(e) => setMenu({ kind: 'new', anchor: e.currentTarget })}><Icon.caret /></button>
  const splitButton = <button type="button" className="term-tool" title="Split right (⌘D)" aria-label="Split right" onClick={() => split('row')}><Icon.split /></button>
  const settingsButton = <button type="button" className="term-tool" title="Terminal settings" aria-label="Terminal settings" onClick={(e) => setMenu({ kind: 'settings', anchor: e.currentTarget })}><Icon.settings /></button>

  const tabMenu = menu?.kind === 'tab' ? st.tabs.find((t) => t.id === menu.id) : undefined
  const awsProfiles = profiles.filter((p) => p.enabled)

  return (
    <div className={`term-app ${vertical ? 'vertical' : ''}`}>
      {vertical ? (
        <aside className="term-side" style={{ width: sideWidth }}>
          <div className="term-side-head">
            <span className="term-side-title">Terminals</span>
            <span className="flex-1" />
            {splitButton}
            {settingsButton}
          </div>
          <div className="term-side-newrow">
            <button type="button" className="term-side-new" title="New tab in the same folder (⌘T)" onClick={() => openTab()}><Icon.plus /> New tab <kbd className="term-side-kbd">⌘T</kbd></button>
            {moreButton}
          </div>
          <div className="term-side-list" role="tablist" aria-orientation="vertical">
            {st.tabs.map(tabRow)}
          </div>
          <div className="term-side-edge" title="Drag to resize · double-click for the default width" onPointerDown={startSideDrag} onDoubleClick={() => update((x) => ({ ...x, tabBarWidth: undefined }))} />
        </aside>
      ) : (
        <div className="term-tabs" role="tablist">
          {st.tabs.map(tabRow)}
          <button type="button" className="term-tab-add" title="New tab (⌘T)" aria-label="New tab" onClick={() => openTab()}><Icon.plus /></button>
          {moreButton}
          <span className="flex-1" />
          {splitButton}
          {settingsButton}
        </div>
      )}

      <div ref={body} className="term-body">
        {allPanes.map(({ id, tab: t }) => {
          const shown = t.id === current?.id && (!t.maximized || t.maximized === id)
          const r = t.maximized === id ? { x: 0, y: 0, w: 1, h: 1 } : t.id === current?.id ? rects.panes[id] : undefined
          return (
            <div
              key={id}
              className="term-slot"
              style={shown && r ? { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` } : { display: 'none' }}
            >
              <Pane
                id={id}
                cwd={st.cwds[id]}
                env={t.profile ? { AWS_PROFILE: t.profile } : undefined}
                visible={active && shown}
                focused={active && t.id === current?.id && t.activePane === id}
                multi={paneIds(t.root).length > 1 && !t.maximized}
                inputMode={inputMode}
                notify={st.notify !== false}
                home={home}
                onFocus={() => focusPane(id)}
                onInfo={onInfo}
                onExit={closePane}
                onReveal={() => { useStore.getState().setActive(useStore.getState().tabs.find((x) => x.kind === 'local')?.id ?? 'hosts'); activateTab(t.id); focusPane(id) }}
                registerApi={registerApi}
              />
            </div>
          )
        })}
        {current && !current.maximized && rects.dividers.map((d) => (
          <div
            key={`${d.path.join('.')}:${d.index}`}
            className={`term-divider ${d.dir}`}
            style={d.dir === 'row'
              ? { left: `calc(${d.at * 100}% - 3px)`, top: `${d.span.y * 100}%`, height: `${d.span.h * 100}%` }
              : { top: `calc(${d.at * 100}% - 3px)`, left: `${d.span.x * 100}%`, width: `${d.span.w * 100}%` }}
            onPointerDown={(e) => startDrag(e, d)}
          />
        ))}
        {!st.tabs.length && (
          <div className="term-empty">
            <Icon.console />
            <div className="text-[15px] font-semibold">No terminals open</div>
            <button type="button" className="btn btn-primary" onClick={() => openTab()}>New terminal <kbd className="kbd">⌘T</kbd></button>
          </div>
        )}
      </div>

      {menu?.kind === 'tab' && tabMenu && (
        <Popover anchor={menu.anchor} width={220} onClose={() => setMenu(null)}>
          <MenuItem onClick={() => { setMenu(null); setRenaming({ id: tabMenu.id, value: tabMenu.title ?? titleOf(tabMenu) }) }}>Rename…</MenuItem>
          <div className="term-swatches">
            <button type="button" className={`term-swatch none ${!tabMenu.color ? 'on' : ''}`} aria-label="No colour" onClick={() => patchTab(tabMenu.id, { color: undefined })} />
            {ACCENTS.map((c) => (
              <button key={c} type="button" data-accent={c} className={`term-swatch ${tabMenu.color === c ? 'on' : ''}`} aria-label={c} onClick={() => patchTab(tabMenu.id, { color: c })} />
            ))}
          </div>
          <MenuSep />
          <MenuItem onClick={() => { setMenu(null); openTab({ profile: tabMenu.profile, cwd: cwdOf(tabMenu.activePane) }) }}>Duplicate tab</MenuItem>
          <MenuItem onClick={() => { setMenu(null); activateTab(tabMenu.id); setTimeout(() => split('row'), 0) }} hint="⌘D">Split right</MenuItem>
          <MenuItem onClick={() => { setMenu(null); activateTab(tabMenu.id); setTimeout(() => split('column'), 0) }} hint="⌘⇧D">Split down</MenuItem>
          {cwdOf(tabMenu.activePane) && <MenuItem onClick={() => { setMenu(null); void window.api.invoke('local:reveal', cwdOf(tabMenu.activePane)!) }}>Show folder in Finder</MenuItem>}
          <MenuSep />
          {st.tabs.length > 1 && <MenuItem onClick={() => { setMenu(null); for (const t of st.tabs) if (t.id !== tabMenu.id) closeTab(t.id) }}>Close other tabs</MenuItem>}
          <MenuItem danger onClick={() => { setMenu(null); closeTab(tabMenu.id) }}>Close tab</MenuItem>
        </Popover>
      )}

      {menu?.kind === 'new' && (
        <Popover anchor={menu.anchor} width={250} onClose={() => setMenu(null)}>
          <MenuItem onClick={() => { setMenu(null); openTab() }} hint="⌘T">New tab</MenuItem>
          <MenuItem onClick={() => { setMenu(null); openTab({ cwd: home }) }}>New tab in your home folder</MenuItem>
          {closedTabs.current.length > 0 && <MenuItem onClick={() => { setMenu(null); reopenTab() }} hint="⌘⇧T">Reopen closed tab</MenuItem>}
          {awsProfiles.length > 0 && (
            <>
              <MenuSep />
              <MenuLabel>With an AWS profile (AWS_PROFILE)</MenuLabel>
              {awsProfiles.map((p) => (
                <MenuItem key={p.name} onClick={() => { setMenu(null); openTab({ profile: p.name }) }}>
                  <span className="inline-flex items-center gap-2"><span className="term-dot" data-accent={metaFor(p.name, settings).color} />{metaFor(p.name, settings).label}</span>
                </MenuItem>
              ))}
            </>
          )}
        </Popover>
      )}

      {menu?.kind === 'settings' && (
        <Popover anchor={menu.anchor} align="right" width={270} onClose={() => setMenu(null)}>
          <MenuLabel>Tabs</MenuLabel>
          <MenuItem on={vertical} onClick={() => update((s) => ({ ...s, tabBar: 'vertical' }))}>Down the side</MenuItem>
          <MenuItem on={!vertical} onClick={() => update((s) => ({ ...s, tabBar: 'horizontal' }))}>Across the top</MenuItem>
          <MenuSep />
          <MenuLabel>Typing commands</MenuLabel>
          <MenuItem on={inputMode === 'editor'} onClick={() => update((s) => ({ ...s, input: 'editor' }))}>Input box (Warp style)</MenuItem>
          <MenuItem on={inputMode === 'shell'} onClick={() => update((s) => ({ ...s, input: 'shell' }))}>Straight into the shell</MenuItem>
          <MenuSep />
          <MenuItem on={st.notify !== false} onClick={() => update((s) => ({ ...s, notify: s.notify === false }))}>Notify when a long command finishes</MenuItem>
          <MenuItem onClick={() => { setMenu(null); apis.current.get(current?.activePane ?? '')?.clear() }}>Clear this pane's scrollback</MenuItem>
          <MenuSep />
          <MenuItem onClick={() => fontStep(1)} hint="⌘+">Bigger text</MenuItem>
          <MenuItem onClick={() => fontStep(-1)} hint="⌘−">Smaller text</MenuItem>
          <MenuItem onClick={() => { setMenu(null); useStore.getState().set({ settingsOpen: true }) }}>Theme and font…</MenuItem>
          <div className="muted px-3 pb-1 pt-1 text-[10.5px] leading-snug">Blocks and the input box need zsh. Other shells work as a plain terminal.</div>
        </Popover>
      )}
    </div>
  )
}

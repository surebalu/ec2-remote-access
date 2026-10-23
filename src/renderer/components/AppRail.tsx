import { useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { formatCombo, type RailSection } from '@shared/keyCombos'
import { isSession, TOOL_NAMES, useStore, type Tab, type ToolKind } from '../store'
import { hasBrowser } from '../quickConnect'
import { openKeyboardSettings, sectionKeyLabel } from '../shortcuts'
import { Icon } from './icons'
import Popover, { MenuItem, MenuLabel, MenuSep } from './Popover'
import { APP_THEMES, findAppTheme } from '../appThemes'
import { endDockDrag, startDockDrag } from './SplitView'
import { TOOL_GROUPS, TOOL_DESCRIPTIONS } from '../toolCatalog'
import { LOOKS } from '../toolLooks'

/**
 * The app's sections down the left edge: hosts, all sessions, the built-in tools and the chat assistants, with help,
 * theme and settings at the bottom. Remote sessions (SSH, RDP, Files) keep their tabs in the title bar; the tools live
 * here, each with a dot while it is open, so the title bar is only ever the sessions you are working in. Every section
 * can have a keyboard shortcut of its own (Settings → Keyboard, or right-click it).
 */
export default function AppRail(): ReactElement {
  const tabs = useStore((s) => s.tabs)
  const activeTab = useStore((s) => s.activeTab)
  const gridView = useStore((s) => s.gridView)
  const gridHost = useStore((s) => s.gridHost)
  const theme = useStore((s) => s.settings?.theme ?? 'system')
  const colorTheme = useStore((s) => s.settings?.colorTheme ?? '')
  const shortcuts = useStore((s) => s.settings?.shortcuts)
  const launcherKey = useStore((s) => s.settings?.launcherKey ?? '')
  const [themeMenu, setThemeMenu] = useState<HTMLElement | null>(null)
  const [menu, setMenu] = useState<{ kind: RailSection; anchor: HTMLElement } | null>(null)
  const st = useStore.getState
  /** "Notes (⇧⌘N)": the section's own shortcut, when it has one. */
  const withKey = (title: string, section: RailSection, fallback = ''): string => {
    const k = sectionKeyLabel(section, shortcuts) || fallback
    return k ? `${title} (${k})` : title
  }

  const front: Tab | undefined = gridView ? undefined : tabs.find((t) => t.id === activeTab)
  const sessions = tabs.filter((t) => isSession(t) && !t.transient).length
  const toolTab = (kind: ToolKind): Tab | undefined => tabs.find((t) => t.kind === kind)
  const open = (kind: ToolKind): void => st().openTool(kind)
  const isTool = (k: RailSection): k is ToolKind => k !== 'hosts' && k !== 'overview'

  /** Shortcuts are in each item's tooltip (`withKey`), not drawn under it. */
  const item = (o: { label: string; icon: ReactNode; on: boolean; title: string; onClick: () => void; aria?: string; dot?: boolean; badge?: number; disabled?: boolean; onContextMenu?: (el: HTMLElement) => void; dock?: ToolKind; hue?: number; sat?: number }): ReactElement => (
    <button
      key={o.label}
      type="button"
      className={`rail-item no-drag ${o.on ? 'on' : ''} ${o.hue !== undefined ? 'rail-tinted' : ''}`}
      style={o.hue !== undefined ? { '--tool-hue': o.hue, ...(o.sat !== undefined ? { '--tool-sat': `${o.sat}%` } : {}) } as CSSProperties : undefined}
      title={o.title}
      aria-label={o.aria ?? o.label}
      aria-current={o.on ? 'page' : undefined}
      disabled={o.disabled}
      onClick={o.onClick}
      onContextMenu={(e) => { if (o.onContextMenu) { e.preventDefault(); o.onContextMenu(e.currentTarget) } }}
      // A tool dragged onto the session area docks beside the pane it is dropped on.
      draggable={!!o.dock}
      onDragStart={o.dock ? (e) => startDockDrag(e, { tool: o.dock }) : undefined}
      onDragEnd={o.dock ? endDockDrag : undefined}
    >
      <span className="rail-icon">
        {o.icon}
        {!!o.badge && <span className="rail-badge">{o.badge > 99 ? '99+' : o.badge}</span>}
        {o.dot && !o.on && <span className="rail-open" aria-hidden="true" />}
      </span>
      <span className="rail-label">{o.label}</span>
    </button>
  )

  const tool = (kind: ToolKind, icon: ReactNode, title: string): ReactElement => {
    const tab = toolTab(kind)
    return item({
      label: TOOL_NAMES[kind],
      icon,
      hue: LOOKS[kind].hue,
      title: withKey(title, kind),
      on: front?.kind === kind,
      dot: !!tab,
      onClick: () => open(kind),
      onContextMenu: (el) => setMenu({ kind, anchor: el }),
      // A chat opened elsewhere (a browser on the gateway) has no tab to dock.
      dock: hasBrowser() || (kind !== 'claude' && kind !== 'chatgpt') ? kind : undefined
    })
  }

  const colored = findAppTheme(colorTheme)
  const themeIcon = colored ? <Icon.palette /> : theme === 'light' ? <Icon.sun /> : theme === 'dark' ? <Icon.moon /> : <Icon.auto />
  const themeLabel = colored ? 'Theme' : theme === 'system' ? 'Auto' : theme === 'light' ? 'Light' : 'Dark'

  return (
    <nav className="app-rail" aria-label="App sections">
      {item({ label: 'Search', icon: <Icon.search />, hue: 220, sat: 14, on: false, title: 'Find hosts, tools and commands (⌘K)', onClick: () => st().openQuickSwitcher() })}
      {/* One list, in TOOL_GROUPS order, with no group labels or dividers (the user found them cluttered). */}
      <div className="rail-sections">
      {item({ label: 'Hosts', icon: <Icon.server />, hue: LOOKS.hosts.hue, on: !gridView && activeTab === 'hosts', title: withKey('Hosts in every account', 'hosts', '⌘1'), onClick: () => st().setActive('hosts'), onContextMenu: (el) => setMenu({ kind: 'hosts', anchor: el }) })}
      {item({
        label: 'Overview',
        icon: <Icon.grid />,
        hue: LOOKS.overview.hue,
        on: gridView && !gridHost,
        badge: sessions,
        disabled: sessions === 0,
        title: withKey(sessions ? 'All sessions on one page' : 'All sessions on one page: none open yet', 'overview'),
        aria: 'All sessions',
        onClick: () => st().showGrid(!gridView || !!gridHost),
        onContextMenu: (el) => setMenu({ kind: 'overview', anchor: el })
      })}
      {TOOL_GROUPS.flatMap((g) => g.tools).filter((kind) => hasBrowser() || !['local', 'finder'].includes(kind)).map((kind) => tool(kind, LOOKS[kind].icon(), TOOL_DESCRIPTIONS[kind]))}
      </div>
      <div className="rail-utilities">
      {hasBrowser() && item({
        label: 'Launcher',
        icon: <Icon.launcher />,
        on: false,
        title: `Launcher: search apps, files, hosts and notes${launcherKey ? ` (${formatCombo(launcherKey)}, from any app)` : ' (give it a key in Settings → Keyboard)'}`,
        onClick: () => void window.api.invoke('launcher:show')
      })}
      {item({ label: 'Shortcuts', icon: <Icon.keyboard />, on: false, title: 'Keyboard shortcuts (⌘/)', onClick: () => st().set({ shortcutsOpen: true }) })}
      <button
        type="button"
        className="rail-item no-drag"
        title={colored ? `Colour theme: ${colored.name}` : `Appearance: ${theme === 'system' ? 'follows macOS' : theme}`}
        aria-label="Theme"
        aria-haspopup="menu"
        aria-expanded={!!themeMenu}
        onClick={(e) => setThemeMenu(themeMenu ? null : e.currentTarget)}
      >
        <span className="rail-icon">
          {themeIcon}
          {colored && <span className="rail-swatch" style={{ background: colored.accent }} aria-hidden="true" />}
        </span>
        <span className="rail-label">{themeLabel}</span>
      </button>
      {item({ label: 'Settings', icon: <Icon.settings />, on: false, title: 'Settings (⌘,)', onClick: () => st().set({ settingsOpen: true }) })}
      </div>
      {themeMenu && (
        <Popover anchor={themeMenu} width={236} onClose={() => setThemeMenu(null)}>
          <MenuLabel>Appearance</MenuLabel>
          {(['system', 'light', 'dark'] as const).map((t) => (
            <MenuItem key={t} on={!colored && theme === t} onClick={() => { setThemeMenu(null); void st().setTheme(t) }}>
              {t === 'system' ? 'Auto (follows macOS)' : t === 'light' ? 'Light' : 'Dark'}
            </MenuItem>
          ))}
          <MenuSep />
          <MenuLabel>Colour themes</MenuLabel>
          <div className="theme-menu-list">
            {APP_THEMES.map((t) => (
              <MenuItem key={t.id} on={colorTheme === t.id} onClick={() => { setThemeMenu(null); void st().setColorTheme(t.id) }}>
                <span className="theme-menu-item">
                  <span className="theme-dot" style={{ background: `linear-gradient(135deg, ${t.tokens['--bg-elev']} 0 52%, ${t.accent} 52% 100%)`, borderColor: t.tokens['--border'] }} />
                  {t.name}
                </span>
              </MenuItem>
            ))}
          </div>
          <MenuSep />
          <MenuItem onClick={() => { setThemeMenu(null); try { localStorage.setItem('ui.settingsSection', 'general') } catch { /* storage off */ } st().set({ settingsOpen: true }) }}>Preview themes in Settings…</MenuItem>
        </Popover>
      )}
      {menu && (() => {
        const kind = menu.kind
        const tool = isTool(kind) ? kind : null
        const close = (fn: () => void) => (): void => { setMenu(null); fn() }
        const docks = !!tool && (hasBrowser() || (tool !== 'claude' && tool !== 'chatgpt'))
        return (
          <Popover anchor={menu.anchor} width={230} onClose={() => setMenu(null)}>
            {tool && <MenuItem onClick={close(() => open(tool))}>{toolTab(tool) ? 'Show' : 'Open'} {TOOL_NAMES[tool]}</MenuItem>}
            {tool && docks && front && front.kind !== tool && (
              <MenuItem onClick={close(() => st().splitWith(front.id, st().toolTab(tool)))}>Beside {isSession(front) ? front.title : TOOL_NAMES[front.kind as ToolKind]}</MenuItem>
            )}
            {tool && toolTab(tool) && <MenuItem danger onClick={close(() => { const t = toolTab(tool); if (t) void st().closeTab(t.id) })} hint="⌘W">Close {TOOL_NAMES[tool]}</MenuItem>}
            {tool && <MenuSep />}
            <MenuItem onClick={close(openKeyboardSettings)} hint={sectionKeyLabel(kind, shortcuts) || (kind === 'hosts' ? '⌘1' : undefined)}>Keyboard shortcut…</MenuItem>
            {docks && <>
              <MenuSep />
              <div className="muted px-3 pb-1.5 pt-0.5 text-[10.5px] leading-snug">Or drag it onto a session to put it beside that one.</div>
            </>}
          </Popover>
        )
      })()}
    </nav>
  )
}

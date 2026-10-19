import { useState, type ReactElement, type ReactNode } from 'react'
import { isSession, useStore, type Tab } from '../store'
import { hasBrowser } from '../quickConnect'
import { Icon } from './icons'
import Popover, { MenuItem, MenuLabel, MenuSep } from './Popover'
import { APP_THEMES, findAppTheme } from '../appThemes'

type ToolKind = 'local' | 'browser' | 'notes' | 'board'

const TOOL_NAMES: Record<ToolKind, string> = { local: 'Terminal', browser: 'Browser', notes: 'Notes', board: 'Whiteboard' }

/**
 * The app's sections down the left edge: hosts, all sessions, and the built-in tools, with help, theme and settings at
 * the bottom. Remote sessions (SSH, RDP, Files) keep their tabs in the title bar; the tools live here, each with a dot
 * while it is open, so the title bar is only ever the sessions you are working in.
 */
export default function AppRail(): ReactElement {
  const tabs = useStore((s) => s.tabs)
  const activeTab = useStore((s) => s.activeTab)
  const gridView = useStore((s) => s.gridView)
  const gridHost = useStore((s) => s.gridHost)
  const theme = useStore((s) => s.settings?.theme ?? 'system')
  const colorTheme = useStore((s) => s.settings?.colorTheme ?? '')
  const [themeMenu, setThemeMenu] = useState<HTMLElement | null>(null)
  const [menu, setMenu] = useState<{ kind: ToolKind; anchor: HTMLElement } | null>(null)
  const st = useStore.getState

  const front: Tab | undefined = gridView ? undefined : tabs.find((t) => t.id === activeTab)
  const sessions = tabs.filter((t) => isSession(t) && !t.transient).length
  const toolTab = (kind: ToolKind): Tab | undefined => tabs.find((t) => t.kind === kind)
  const open = (kind: ToolKind): void => {
    const s = st()
    if (kind === 'local') s.openTerminal()
    else if (kind === 'browser') s.openBrowser()
    else if (kind === 'notes') s.openNotes()
    else s.openBoard()
  }

  const item = (o: { label: string; icon: ReactNode; on: boolean; title: string; onClick: () => void; aria?: string; dot?: boolean; badge?: number; disabled?: boolean; onContextMenu?: (el: HTMLElement) => void }): ReactElement => (
    <button
      key={o.label}
      type="button"
      className={`rail-item no-drag ${o.on ? 'on' : ''}`}
      title={o.title}
      aria-label={o.aria ?? o.label}
      aria-current={o.on ? 'page' : undefined}
      disabled={o.disabled}
      onClick={o.onClick}
      onContextMenu={(e) => { if (o.onContextMenu) { e.preventDefault(); o.onContextMenu(e.currentTarget) } }}
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
      title,
      on: front?.kind === kind,
      dot: !!tab,
      onClick: () => open(kind),
      onContextMenu: tab ? (el) => setMenu({ kind, anchor: el }) : undefined
    })
  }

  const colored = findAppTheme(colorTheme)
  const themeIcon = colored ? <Icon.palette /> : theme === 'light' ? <Icon.sun /> : theme === 'dark' ? <Icon.moon /> : <Icon.auto />
  const themeLabel = colored ? 'Theme' : theme === 'system' ? 'Auto' : theme === 'light' ? 'Light' : 'Dark'

  return (
    <nav className="app-rail" aria-label="App sections">
      {item({ label: 'Hosts', icon: <Icon.server />, on: !gridView && activeTab === 'hosts', title: 'Hosts in every account (⌘1)', onClick: () => st().setActive('hosts') })}
      {item({
        label: 'Overview',
        icon: <Icon.grid />,
        on: gridView && !gridHost,
        badge: sessions,
        disabled: sessions === 0,
        title: sessions ? 'All sessions on one page (⌘0)' : 'All sessions on one page (⌘0): none open yet',
        aria: 'All sessions',
        onClick: () => st().showGrid(!gridView || !!gridHost)
      })}
      <span className="rail-divider" />
      {hasBrowser() && tool('local', <Icon.console />, 'Terminal: shells on this Mac (⌃`)')}
      {tool('browser', <Icon.globe />, 'Browser: AWS console spaces and web tabs')}
      {tool('notes', <Icon.note />, 'Notes in your Obsidian vault (⌘⇧N)')}
      {tool('board', <Icon.board />, 'Whiteboard: a scratch pad for brainstorming')}
      <span className="rail-spacer" />
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
      {menu && (
        <Popover anchor={menu.anchor} width={190} onClose={() => setMenu(null)}>
          <MenuItem onClick={() => { setMenu(null); open(menu.kind) }}>Show {TOOL_NAMES[menu.kind]}</MenuItem>
          <MenuItem danger onClick={() => { const t = toolTab(menu.kind); setMenu(null); if (t) void st().closeTab(t.id) }} hint="⌘W">Close {TOOL_NAMES[menu.kind]}</MenuItem>
        </Popover>
      )}
    </nav>
  )
}

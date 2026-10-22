import { useEffect, type ReactElement } from 'react'
import { allInstances, useStore, type Tab } from './store'
import Sidebar from './components/Sidebar'
import AppRail from './components/AppRail'
import InstanceTable from './components/InstanceTable'
import TerminalTabs, { HostGridBar, SessionPanes } from './components/TerminalTabs'
import ConnectDialog from './components/ConnectDialog'
import PasswordDialog from './components/PasswordDialog'
import SettingsDialog from './components/SettingsDialog'
import TunnelBar from './components/TunnelBar'
import Toasts from './components/Toasts'
import ManualHostDialog from './components/ManualHostDialog'
import FolderDialog from './components/FolderDialog'
import AddAccountDialog from './components/AddAccountDialog'
import EditAccountDialog from './components/EditAccountDialog'
import Welcome from './components/Welcome'
import AuthBanner from './components/AuthBanner'
import SsoWaitDialog from './components/SsoWaitDialog'
import HostDetails from './components/HostDetails'
import HostPage from './components/hostpage/HostPage'
import QuickSwitcher from './components/QuickSwitcher'
import { Icon } from './components/icons'
import PortForwardDialog from './components/PortForwardDialog'
import SnippetsDialog from './components/SnippetsDialog'
import WorkspaceDialog from './components/WorkspaceDialog'
import ShortcutsDialog from './components/ShortcutsDialog'
import RunCommandDialog from './components/RunCommandDialog'
import { handleAppShortcut } from './shortcuts'
import { isMobile } from './mobile'
import { consoleHomeFor, hasBrowser, openAccountConsole, openDefaultFor, openFilesFor } from './quickConnect'
import { ZoomBadge, zoomSection } from './components/ZoomControls'
import type { ZoomSection } from './sectionZoom'
import MobileApp from './components/mobile/MobileApp'
import VoiceHud from './components/VoiceHud'
import RadialMenu from './components/RadialMenu'
import ServicesDialog from './components/services/ServicesDialog'
import { installToolUsage } from './toolUsage'
import { installVoice } from './voice'

export default function App(): ReactElement {
  const init = useStore((s) => s.init)
  const activeTab = useStore((s) => s.activeTab)
  const gridView = useStore((s) => s.gridView)
  // The tools (Browser, Terminal, Whiteboard, Notes, Finder, the chats) bring their own side lists or fill the page;
  // the hosts sidebar steps aside while one is in front, alone or as a pane of a side-by-side view. A host's note open
  // beside its session keeps it.
  const browserInFront = useStore((s) => {
    if (s.gridView) return false
    const kindOf = (id: string): Tab['kind'] | undefined => s.tabs.find((t) => t.id === id)?.kind
    if (s.splitGroup.includes(s.activeTab)) return s.splitGroup.some((id) => ['browser', 'local', 'board', 'finder', 'claude', 'chatgpt', 'health'].includes(kindOf(id) ?? ''))
    return ['browser', 'local', 'board', 'notes', 'finder', 'claude', 'chatgpt', 'health'].includes(kindOf(s.activeTab) ?? '')
  })
  // The terminals beside a web page (the Browser, Claude, ChatGPT) in a split, for the page's context menu "Paste
  // into …", which main builds.
  const paneTargets = useStore((s) => (s.splitGroup.some((id) => ['browser', 'claude', 'chatgpt'].includes(s.tabs.find((t) => t.id === id)?.kind ?? ''))
    ? s.splitGroup.map((id) => s.tabs.find((t) => t.id === id)).filter((t): t is Tab => t?.kind === 'ssh').map((t) => `${t.id}\t${t.title}${t.shellLabel ? ` (${t.shellLabel})` : ''}`).join('\n')
    : ''))
  const connectFor = useStore((s) => s.connectFor)
  const passwordFor = useStore((s) => s.passwordFor)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const manualHostEditor = useStore((s) => s.manualHostEditor)
  const folderEditor = useStore((s) => s.folderEditor)
  const addAccountOpen = useStore((s) => s.addAccountOpen)
  const editAccount = useStore((s) => s.editAccount)
  const quickSwitcherOpen = useStore((s) => s.quickSwitcherOpen)
  const portForwardFor = useStore((s) => s.portForwardFor)
  const snippetsOpen = useStore((s) => s.snippetsOpen)
  const workspaceSaveOpen = useStore((s) => s.workspaceSaveOpen)
  const shortcutsOpen = useStore((s) => s.shortcutsOpen)
  const runCommandFor = useStore((s) => s.runCommandFor)
  const servicesFor = useStore((s) => s.servicesFor)
  const profiles = useStore((s) => s.profiles)
  const manualCount = useStore((s) => s.settings?.manualHosts.length ?? 0)
  const settingsLoaded = useStore((s) => !!s.settings)
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)
  const hostPageOpen = useStore((s) => !!s.hostPage)
  const showWelcome = settingsLoaded && profiles.length === 0 && manualCount === 0

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    if (!hasBrowser()) return
    const targets = paneTargets ? paneTargets.split('\n').map((line) => { const [id, title] = line.split('\t'); return { id, title } }) : []
    void window.api.invoke('browser:paneTargets', targets).catch(() => undefined)
  }, [paneTargets])

  // Voice dictation: the hold key, mic buttons and the HUD (Mac app only; a no-op elsewhere).
  useEffect(() => installVoice(), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        e.stopPropagation()
        if (e.repeat) return
        const state = useStore.getState()
        if (!state.quickSwitcherOpen && document.querySelector('.modal-backdrop')) return
        if (state.quickSwitcherOpen) state.set({ quickSwitcherOpen: false })
        else state.openQuickSwitcher()
        return
      }
      // ⌘+ / ⌘− with the pointer over the sidebar or the hosts list sizes just that section; elsewhere the View
      // menu zooms the whole window as before. (⌘0 stays the all-sessions grid.)
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.defaultPrevented && ['=', '+', '-', '_'].includes(e.key) && !document.querySelector('.modal-backdrop')) {
        const hovered = [...document.querySelectorAll<HTMLElement>('[data-zoom-section]:hover')].pop()
        if (hovered) {
          e.preventDefault()
          e.stopPropagation()
          zoomSection(hovered.dataset.zoomSection as ZoomSection, e.key === '-' || e.key === '_' ? -1 : 1)
          return
        }
      }
      handleAppShortcut(e)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // Which tools come to the front, for the home page's Tools (most used first).
  useEffect(() => installToolUsage(), [])

  // The menu-bar icon (src/main/tray.ts) and the launcher (src/renderer/launcher) ask the window to connect to a host,
  // find one, rescan, or show something of the app's.
  useEffect(() => window.api.on('app:command', (c) => {
    const st = useStore.getState()
    if (c.kind === 'connect') openDefaultFor(c.key)
    else if (c.kind === 'switcher') { if (!st.quickSwitcherOpen) st.openQuickSwitcher() }
    else if (c.kind === 'scan') void st.scan()
    else if (c.kind === 'section') {
      if (c.section === 'hosts') st.setActive('hosts')
      else if (c.section === 'overview') st.showGrid(true)
      else st.openTool(c.section)
    }
    else if (c.kind === 'reveal') st.revealHost(c.key)
    else if (c.kind === 'finder') st.openFinder(c.path)
    else if (c.kind === 'terminal') st.openTerminal({ cwd: c.cwd, profile: c.profile, newTab: true })
    else if (c.kind === 'workspace') st.openWorkspace(c.id)
    else if (c.kind === 'portForward') {
      const p = st.settings?.portForwards.find((x) => x.id === c.id)
      if (p) void st.openPortForward({ instanceKey: p.instanceKey, remotePort: p.remotePort, localPort: p.localPort, remoteHost: p.remoteHost, name: p.name })
    }
    else if (c.kind === 'browse') st.openBrowser({ url: c.url, space: c.space, tab: c.tab })
    else if (c.kind === 'note') st.openNotes(c.path)
    else if (c.kind === 'files') openFilesFor(c.key)
    else if (c.kind === 'run') st.set({ runCommandFor: { keys: [c.key] } })
    else if (c.kind === 'forward') st.set({ portForwardFor: { key: c.key } })
    else if (c.kind === 'power') {
      const i = allInstances(st).find((x) => x.key === c.key)
      if (i && window.confirm(`${c.action === 'start' ? 'Start' : 'Stop'} ${i.name} (${i.instanceId}) in ${i.profile}?`)) {
        window.api.invoke(c.action === 'start' ? 'ec2:start' : 'ec2:stop', i.key)
          .then(() => st.toast('success', `${c.action === 'start' ? 'Starting' : 'Stopping'} ${i.name}. Rescan in a minute.`), (e: Error) => st.toast('error', e.message))
      }
    }
    else if (c.kind === 'console') openAccountConsole(c.profile, c.url ?? consoleHomeFor(c.profile))
    else if (c.kind === 'ask') st.askAssistant(c.app, c.text)
    else if (c.kind === 'today') void window.api.invoke('notes:daily').then((p) => st.openNotes(p), (e: Error) => st.toast('error', e.message))
  }), [])

  // ⌘B shows or hides the hosts sidebar. Here rather than in the sidebar, which unmounts while hidden; on document so
  // the RDP key guard on window cannot swallow it, and never when an editor used the key (bold in Notes).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.key.toLowerCase() === 'b' && !e.defaultPrevented) {
        e.preventDefault()
        useStore.getState().toggleSidebar()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // The embedded RDP client registers window-level keydown/keyup handlers that swallow keys while it thinks it is
  // capturing input. Registered here first (bubble phase, same target), this guard runs ahead of it and stops the
  // event from reaching the client whenever the key belongs to the UI instead of the remote desktop.
  useEffect(() => {
    const guard = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      const editable = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
      const modalOpen = !!document.querySelector('.modal-backdrop')
      const st = useStore.getState()
      // In the all-sessions grid activeTab is the focused tile, so a desktop tile gets keys once it has been clicked.
      const activeIsRdp = st.tabs.some((tab) => tab.id === st.activeTab && tab.kind === 'rdp')
      if (editable || modalOpen || !activeIsRdp) e.stopImmediatePropagation()
    }
    window.addEventListener('keydown', guard, false)
    window.addEventListener('keyup', guard, false)
    return () => {
      window.removeEventListener('keydown', guard, false)
      window.removeEventListener('keyup', guard, false)
    }
  }, [])

  const dialogs = (
    <>
      {connectFor && <ConnectDialog />}
      {passwordFor && <PasswordDialog />}
      {settingsOpen && <SettingsDialog />}
      {manualHostEditor && <ManualHostDialog />}
      {folderEditor && <FolderDialog key={folderEditor} />}
      {addAccountOpen && <AddAccountDialog />}
      {editAccount && <EditAccountDialog key={editAccount} />}
      <SsoWaitDialog />
      {quickSwitcherOpen && <QuickSwitcher />}
      {portForwardFor && <PortForwardDialog />}
      {snippetsOpen && <SnippetsDialog />}
      {workspaceSaveOpen && <WorkspaceDialog />}
      {shortcutsOpen && <ShortcutsDialog />}
      {runCommandFor && <RunCommandDialog key={runCommandFor.runId ?? runCommandFor.keys.join('|')} />}
      {servicesFor && <ServicesDialog key={servicesFor.targets.map((t) => t.key).join('|')} />}
      <Toasts />
      <VoiceHud />
      <ZoomBadge />
    </>
  )
  if (isMobile()) return <><MobileApp />{dialogs}</>

  return (
    <div className="flex h-full flex-col">
      <header className="titlebar drag">
        <div className="brand">
          <span className="brand-mark">&gt;_</span>
          {/* The name shown in the title bar; the app's internal name (bundle, data folder, Keychain) stays EC2 Remote Access. */}
          <span className="brand-name">Remote Access Tool</span>
          <span className="flex-1" />
          {!browserInFront && (
            <button className="titlebar-btn no-drag" title={sidebarCollapsed ? 'Show sidebar (⌘B)' : 'Collapse sidebar (⌘B)'} aria-label={sidebarCollapsed ? 'Show sidebar' : 'Collapse sidebar'} aria-pressed={!sidebarCollapsed} onClick={() => useStore.getState().toggleSidebar()}>
              <Icon.sidebar />
            </button>
          )}
        </div>
        <TerminalTabs />
        <button className="search-pill no-drag" title="Find a host, session or command (⌘K)" aria-label="Open quick switcher" onClick={() => useStore.getState().openQuickSwitcher()}>
          <Icon.search />
          <span className="search-pill-text">Search hosts, sessions, commands</span>
          <kbd>⌘K</kbd>
        </button>
      </header>
      <div className="flex min-h-0 flex-1">
        <AppRail />
        <div className={browserInFront ? 'hidden' : 'contents'}><Sidebar /></div>
        <main className="flex min-w-0 flex-1 flex-col" style={{ background: 'var(--bg)' }}>
          <AuthBanner />
          <div data-zoom-section="hosts" className={`hosts-workspace relative min-h-0 flex-1 ${activeTab === 'hosts' && !gridView ? 'flex' : 'hidden'}`}>{showWelcome ? <Welcome /> : <>
            {/* The list stays mounted under a host page, so its scroll and selection are there on the way back. */}
            <div className={`min-w-0 flex-1 ${hostPageOpen ? 'hidden' : ''}`}><InstanceTable /></div>
            {hostPageOpen ? <HostPage /> : <HostDetails />}
          </>}</div>
          <HostGridBar />
          <SessionPanes grid={gridView} />
          <TunnelBar />
        </main>
      </div>
      {dialogs}
      <RadialMenu />
    </div>
  )
}

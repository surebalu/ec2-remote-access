import { useEffect, type ReactElement } from 'react'
import { useStore } from './store'
import Sidebar from './components/Sidebar'
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
import QuickSwitcher from './components/QuickSwitcher'
import { Icon } from './components/icons'
import PortForwardDialog from './components/PortForwardDialog'
import SnippetsDialog from './components/SnippetsDialog'
import WorkspaceDialog from './components/WorkspaceDialog'
import ShortcutsDialog from './components/ShortcutsDialog'
import { handleAppShortcut } from './shortcuts'
import { hasBrowser } from './quickConnect'
import { isMobile } from './mobile'
import MobileApp from './components/mobile/MobileApp'

export default function App(): ReactElement {
  const init = useStore((s) => s.init)
  const activeTab = useStore((s) => s.activeTab)
  const gridView = useStore((s) => s.gridView)
  // The browser brings its own sidebar (spaces and tabs); the hosts sidebar steps aside while it is in front.
  const browserInFront = useStore((s) => !s.gridView && s.tabs.some((t) => t.id === s.activeTab && (t.kind === 'browser' || t.kind === 'local' || t.kind === 'board') && !s.splitGroup.includes(t.id)))
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
  const profiles = useStore((s) => s.profiles)
  const manualCount = useStore((s) => s.settings?.manualHosts.length ?? 0)
  const settingsLoaded = useStore((s) => !!s.settings)
  const showWelcome = settingsLoaded && profiles.length === 0 && manualCount === 0

  useEffect(() => {
    void init()
  }, [init])

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
      handleAppShortcut(e)
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
      <Toasts />
    </>
  )
  if (isMobile()) return <><MobileApp />{dialogs}</>

  return (
    <div className="flex h-full flex-col">
      <header className="titlebar drag">
        <div className="brand">
          <span className="brand-mark">&gt;_</span>
          <span>EC2 Remote Access</span>
        </div>
        <TerminalTabs />
        {hasBrowser() && <button className="btn btn-ghost btn-icon no-drag shrink-0" title="Terminal: shells on this Mac (⌃`)" aria-label="Terminal" onClick={() => useStore.getState().openTerminal()}><Icon.console /></button>}
        <button className="btn btn-ghost btn-icon no-drag shrink-0" title="Browser: AWS console spaces and web tabs" aria-label="Browser" onClick={() => useStore.getState().openBrowser()}><Icon.globe /></button>
        <button className="btn btn-ghost btn-icon no-drag shrink-0" title="Whiteboard: a scratch pad for brainstorming" aria-label="Whiteboard" onClick={() => useStore.getState().openBoard()}><Icon.board /></button>
        <button className="btn btn-ghost btn-icon no-drag shrink-0" title="Notes (⌘⇧N)" aria-label="Notes" onClick={() => useStore.getState().openNotes()}><Icon.note /></button>
        <button className="btn btn-ghost no-drag mr-3 shrink-0" title="Find a host or session (⌘K)" aria-label="Open quick switcher" onClick={() => useStore.getState().openQuickSwitcher()}><Icon.search /><kbd>⌘K</kbd></button>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className={browserInFront ? 'hidden' : 'contents'}><Sidebar /></div>
        <main className="flex min-w-0 flex-1 flex-col" style={{ background: 'var(--bg)' }}>
          <AuthBanner />
          <div className={`hosts-workspace relative min-h-0 flex-1 ${activeTab === 'hosts' && !gridView ? 'flex' : 'hidden'}`}>{showWelcome ? <Welcome /> : <><div className="min-w-0 flex-1"><InstanceTable /></div><HostDetails /></>}</div>
          <HostGridBar />
          <SessionPanes grid={gridView} />
          <TunnelBar />
        </main>
      </div>
      {dialogs}
    </div>
  )
}

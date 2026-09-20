import { useEffect, type ReactElement } from 'react'
import { useStore } from './store'
import Sidebar from './components/Sidebar'
import InstanceTable from './components/InstanceTable'
import TerminalTabs, { SessionPanes } from './components/TerminalTabs'
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

export default function App(): ReactElement {
  const init = useStore((s) => s.init)
  const activeTab = useStore((s) => s.activeTab)
  const connectFor = useStore((s) => s.connectFor)
  const passwordFor = useStore((s) => s.passwordFor)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const manualHostEditor = useStore((s) => s.manualHostEditor)
  const folderEditor = useStore((s) => s.folderEditor)
  const addAccountOpen = useStore((s) => s.addAccountOpen)
  const editAccount = useStore((s) => s.editAccount)
  const quickSwitcherOpen = useStore((s) => s.quickSwitcherOpen)
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
        state.set({ quickSwitcherOpen: !state.quickSwitcherOpen })
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

  return (
    <div className="flex h-full flex-col">
      <header className="titlebar drag">
        <div className="brand">
          <span className="brand-mark">&gt;_</span>
          <span>EC2 Remote Access</span>
        </div>
        <TerminalTabs />
        <button className="btn btn-ghost no-drag mr-3 shrink-0" title="Find a host or session (⌘K)" aria-label="Open quick switcher" onClick={() => useStore.getState().set({ quickSwitcherOpen: true })}><Icon.search /><kbd>⌘K</kbd></button>
      </header>
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col" style={{ background: 'var(--bg)' }}>
          <AuthBanner />
          <div className={`hosts-workspace relative min-h-0 flex-1 ${activeTab === 'hosts' ? 'flex' : 'hidden'}`}>{showWelcome ? <Welcome /> : <><div className="min-w-0 flex-1"><InstanceTable /></div><HostDetails /></>}</div>
          <SessionPanes />
          <TunnelBar />
        </main>
      </div>
      {connectFor && <ConnectDialog />}
      {passwordFor && <PasswordDialog />}
      {settingsOpen && <SettingsDialog />}
      {manualHostEditor && <ManualHostDialog />}
      {folderEditor && <FolderDialog key={folderEditor} />}
      {addAccountOpen && <AddAccountDialog />}
      {editAccount && <EditAccountDialog key={editAccount} />}
      <SsoWaitDialog />
      {quickSwitcherOpen && <QuickSwitcher />}
      <Toasts />
    </div>
  )
}

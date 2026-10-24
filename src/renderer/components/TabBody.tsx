import type { ReactElement } from 'react'
import type { Tab } from '../store'
import TerminalTab from './TerminalTab'
import RdpTab from './RdpTab'
import SftpTab from './SftpTab'
import NotesTab from './NotesTab'
import BrowserTab from './browser/BrowserTab'
import TerminalApp from './terminal/TerminalApp'
import BoardTab from './board/BoardTab'
import HealthTab from './health/HealthTab'
import DevToolsTab from './devtools/DevToolsTab'
import ComputersTab from './computers/ComputersTab'
import TasksTab from './plan/TasksTab'
import CalendarTab from './plan/CalendarTab'
import LinksTab from './plan/LinksTab'
import FinderTab from './finder/FinderTab'
import StorageTab from './storage/StorageTab'
import { lazy, Suspense } from 'react'

// The CAD tool brings three.js and OpenCascade's reader: loaded the first time it opens, not with the app.
const CadTab = lazy(() => import('./cad/CadTab'))
// noVNC (screen sharing) likewise loads with the first screen opened.
const VncTab = lazy(() => import('./VncTab'))
import WebAppTab from './webapp/WebAppTab'

/**
 * One tab's page by its kind: a session (SSH terminal, remote desktop, files) or a tool. The main window's panes
 * (TerminalTabs.tsx) and a detached tool's own window (ToolWindow.tsx) both show tabs through it. `active`: it is on
 * screen; `focused`: it has the keyboard (an SSH terminal takes keys only then); `tiled`: in a grid or a split.
 */
export default function TabBody({ tab: t, active, focused, tiled = false }: { tab: Tab; active: boolean; focused: boolean; tiled?: boolean }): ReactElement {
  return t.kind === 'rdp' ? <RdpTab tab={t} active={active} tiled={tiled} /> : t.kind === 'vnc' ? <Suspense fallback={<div className="vnc-wrap" />}><VncTab tab={t} active={active} tiled={tiled} /></Suspense> : t.kind === 'sftp' ? <SftpTab tab={t} active={active} /> : t.kind === 'notes' ? <NotesTab tab={t} active={active} /> : t.kind === 'browser' ? <BrowserTab tab={t} active={active} /> : t.kind === 'local' ? <TerminalApp tab={t} active={active} /> : t.kind === 'board' ? <BoardTab tab={t} active={active} /> : t.kind === 'devtools' ? <DevToolsTab /> : t.kind === 'computers' ? <ComputersTab tab={t} active={active} /> : t.kind === 'tasks' ? <TasksTab tab={t} active={active} /> : t.kind === 'calendar' ? <CalendarTab tab={t} active={active} /> : t.kind === 'links' ? <LinksTab tab={t} active={active} /> : t.kind === 'health' ? <HealthTab tab={t} active={active} /> : t.kind === 'finder' ? <FinderTab tab={t} active={active} /> : t.kind === 'storage' ? <StorageTab tab={t} active={active} /> : t.kind === 'cad' ? <Suspense fallback={<div className="cad-boot">Loading the CAD viewer…</div>}><CadTab tab={t} active={active} /></Suspense> : t.kind === 'claude' || t.kind === 'chatgpt' ? <WebAppTab tab={t} active={active} /> : <TerminalTab tab={t} active={focused} />
}

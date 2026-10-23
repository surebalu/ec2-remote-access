import { useEffect, type ReactElement } from 'react'
import { bytes } from '@shared/storage'
import type { Tab } from '../../store'
import { Icon } from '../icons'
import Modal from '../Modal'
import '../plan/plan.css'
import './storage.css'
import { cancelScan, initStorage, putBack, setRoom, useStorage, type RoomId } from './state'
import { tilde } from './parts'
import Overview from './Overview'
import SpaceMap from './SpaceMap'
import SearchRoom from './SearchRoom'
import LargeFiles from './LargeFiles'
import HiddenFiles from './HiddenFiles'
import RecentlyRemoved from './RecentlyRemoved'
import Duplicates from './Duplicates'
import { AiModels, Installers, JunkFiles, SystemData } from './CleanupRooms'
import { Leftovers, StartupItems, Uninstaller, UnusedApps } from './AppRooms'
import { Monitor, Optimize } from './MacRooms'
import Report from './Report'

/**
 * Storage: a Mac cleaner in the spirit of Strata, as rooms in a sidebar of its own. The Disk rooms look into a scan
 * of the Mac, the home folder or any folder (main/storage: a separate process walks the disk and keeps the tree); the
 * Clean up rooms measure the places caches, models, backups and installers are kept (main/storage/cleanup.ts), the
 * Tools read the installed apps, their Library files and startup items (macApps.ts), and the Insights read the
 * processor, memory, disk, network and battery (monitor.ts) and report on the scan. Nothing is ever deleted: what goes,
 * goes to the Trash, and Recently Removed puts it back. Mac app only.
 */

interface Room { id: RoomId; label: string; icon: () => ReactElement; render: (active: boolean) => ReactElement }

const GROUPS: { label?: string; rooms: Room[] }[] = [
  {
    rooms: [
      { id: 'overview', label: 'Overview', icon: () => <Icon.storage />, render: () => <Overview /> },
      { id: 'map', label: 'Space Map', icon: () => <Icon.treemap />, render: (a) => <SpaceMap active={a} /> },
      { id: 'search', label: 'Search', icon: () => <Icon.search />, render: (a) => <SearchRoom active={a} /> },
      { id: 'large', label: 'Large Files', icon: () => <Icon.note />, render: () => <LargeFiles /> }
    ]
  },
  {
    label: 'Clean up',
    rooms: [
      { id: 'junk', label: 'Junk Files', icon: () => <Icon.sparkles />, render: () => <JunkFiles /> },
      { id: 'ai', label: 'AI Data Sweeper', icon: () => <Icon.brain />, render: () => <AiModels /> },
      { id: 'system', label: 'System Data', icon: () => <Icon.disk />, render: () => <SystemData /> },
      { id: 'leftovers', label: 'Leftovers', icon: () => <Icon.box />, render: () => <Leftovers /> },
      { id: 'duplicates', label: 'Duplicates', icon: () => <Icon.copy />, render: () => <Duplicates /> },
      { id: 'hidden', label: 'Hidden Files', icon: () => <Icon.eyeOff />, render: () => <HiddenFiles /> },
      { id: 'unused', label: 'Unused Apps', icon: () => <Icon.moon />, render: () => <UnusedApps /> }
    ]
  },
  {
    label: 'Tools',
    rooms: [
      { id: 'uninstaller', label: 'Uninstaller', icon: () => <Icon.trash />, render: () => <Uninstaller /> },
      { id: 'startup', label: 'Startup Items', icon: () => <Icon.power />, render: () => <StartupItems /> },
      { id: 'installers', label: 'Installers', icon: () => <Icon.archive />, render: () => <Installers /> },
      { id: 'removed', label: 'Recently Removed', icon: () => <Icon.history />, render: () => <RecentlyRemoved /> }
    ]
  },
  {
    label: 'Insights',
    rooms: [
      { id: 'monitor', label: 'Monitor', icon: () => <Icon.activity />, render: (a) => <Monitor active={a} /> },
      { id: 'report', label: 'Report', icon: () => <Icon.list />, render: () => <Report /> }
    ]
  }
]
/** Optimize opens from the Overview's ring rather than the sidebar, as in Strata. */
const HIDDEN: Room[] = [{ id: 'optimize', label: 'Optimize', icon: () => <Icon.wand />, render: () => <Optimize /> }]
const ROOMS = [...GROUPS.flatMap((g) => g.rooms), ...HIDDEN]

export default function StorageTab({ active }: { tab: Tab; active: boolean }): ReactElement {
  useEffect(() => initStorage(), [])
  const room = useStorage((s) => s.room)
  const undo = useStorage((s) => s.undo)
  const admin = useStorage((s) => s.adminItems)
  const current = ROOMS.find((r) => r.id === room) ?? ROOMS[0]

  // Put Back stays offered for twelve seconds after a move to the Trash.
  useEffect(() => {
    if (!undo) return
    const t = setTimeout(() => useStorage.setState({ undo: null }), 12_000)
    return () => clearTimeout(t)
  }, [undo?.key]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="plan storage" aria-label="Storage">
      <div className="plan-frame">
        <aside className="st-side" aria-label="Storage rooms">
          <div className="st-brand">
            <span className="st-brand-icon"><Icon.storage /></span>
            <div><b>Storage</b><span>Visualize your storage</span></div>
          </div>
          <nav className="st-nav">
            {GROUPS.map((g, i) => (
              <div key={i} className="st-nav-group">
                {g.label && <h4>{g.label}</h4>}
                {g.rooms.map((r) => (
                  <button key={r.id} type="button" className="st-nav-item" aria-current={room === r.id ? 'page' : undefined} onClick={() => setRoom(r.id)}>
                    {r.icon()}<span>{r.label}</span>
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <DiskWidget />
        </aside>
        <div className="st-main">
          {current.render(active)}
          {undo && (
            <div className="plan-undo" role="status">
              <span>{undo.label}</span>
              <button type="button" onClick={() => { const ids = undo.ids; useStorage.setState({ undo: null }); void putBack(ids) }}>Put Back</button>
            </div>
          )}
        </div>
      </div>
      {admin && (
        <Modal title="Only an administrator can move these" onClose={() => useStorage.setState({ adminItems: null })}>
          <div className="st-admin">
            <p>They belong to macOS or another account, and this app never asks for your password. Show each in Finder and press <kbd>⌘⌫</kbd> there: Finder asks for the password or Touch ID.</p>
            <ul>
              {admin.map((a) => (
                <li key={a.path}>
                  <span title={a.path}>{tilde(a.path)}</span>
                  <button type="button" className="st-button" onClick={() => void window.api.invoke('local:reveal', a.path)}><Icon.finder />Show in Finder</button>
                </li>
              ))}
            </ul>
            <div className="cal-edit-foot"><span className="flex-1" /><button type="button" className="st-primary" onClick={() => useStorage.setState({ adminItems: null })}>Done</button></div>
          </div>
        </Modal>
      )}
    </section>
  )
}

/** The foot of the sidebar: the startup disk's use, and the scan while it runs. */
function DiskWidget(): ReactElement {
  const disk = useStorage((s) => s.disk)
  const scan = useStorage((s) => s.scan)
  const used = disk ? disk.total - disk.free : 0
  const pct = disk && disk.total ? (used / disk.total) * 100 : 0
  const level = disk && disk.free / disk.total < 0.05 ? 'crit' : disk && disk.free / disk.total < 0.1 ? 'warn' : 'ok'
  return (
    <div className="st-disk">
      <div className="st-disk-head">
        <Icon.disk />
        <div><b>{disk?.name ?? 'Macintosh HD'}</b><span>{disk ? `${bytes(used)} used` : 'Reading the disk…'}</span></div>
      </div>
      <div className={`st-disk-bar ${level}`}><span style={{ width: `${pct}%` }} /></div>
      <div className="st-disk-free">{disk ? `${bytes(disk.free)} free · ${bytes(disk.total)} total` : ''}</div>
      {scan.status === 'scanning' && (
        <div className="st-disk-scan">
          <span className="st-spinner sm" aria-hidden="true" />
          <span className="flex-1" title={scan.progress?.path}>Scanning · {bytes(scan.progress?.bytes ?? 0)}</span>
          <button type="button" className="st-iconbtn" aria-label="Stop the scan" title="Stop the scan" onClick={() => void cancelScan()}><Icon.x /></button>
        </div>
      )}
    </div>
  )
}

import { useEffect, type ReactElement } from 'react'
import { ago, bytes } from '@shared/storage'
import type { Tab } from '../../store'
import { Icon } from '../icons'
import Modal from '../Modal'
import { NavItem } from '../plan/parts'
import '../plan/plan.css'
import './storage.css'
import { cancelScan, initStorage, putBack, setRoom, startScan, useStorage, type RoomId } from './state'
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

/**
 * Storage: a Mac cleaner in the spirit of Strata, as rooms in a sidebar of its own. The Disk rooms look into a scan
 * of the Mac, the home folder or any folder (main/storage: a separate process walks the disk and keeps the tree); the
 * Clean up rooms measure the places caches, models, backups and installers are kept (main/storage/cleanup.ts); the
 * Apps rooms read the installed apps, their Library files and startup items (macApps.ts), and This Mac reads the
 * processor, memory, disk, network and battery and the open apps (monitor.ts).
 * Nothing is ever deleted: what goes, goes to the Trash, and Recently Removed puts it back. Mac app only.
 */

interface Room { id: RoomId; label: string; icon: () => ReactElement; render: (active: boolean) => ReactElement }

const GROUPS: { label?: string; rooms: Room[] }[] = [
  {
    rooms: [
      { id: 'overview', label: 'Overview', icon: () => <Icon.storage />, render: () => <Overview /> },
      { id: 'map', label: 'Space Map', icon: () => <Icon.treemap />, render: (a) => <SpaceMap active={a} /> },
      { id: 'search', label: 'Search', icon: () => <Icon.search />, render: (a) => <SearchRoom active={a} /> },
      { id: 'large', label: 'Large Files', icon: () => <Icon.note />, render: () => <LargeFiles /> },
      { id: 'hidden', label: 'Hidden Files', icon: () => <Icon.eyeOff />, render: () => <HiddenFiles /> }
    ]
  },
  {
    label: 'Clean up',
    rooms: [
      { id: 'junk', label: 'Junk Files', icon: () => <Icon.sparkles />, render: () => <JunkFiles /> },
      { id: 'ai', label: 'AI Models', icon: () => <Icon.brain />, render: () => <AiModels /> },
      { id: 'system', label: 'System Data', icon: () => <Icon.disk />, render: () => <SystemData /> },
      { id: 'duplicates', label: 'Duplicates', icon: () => <Icon.copy />, render: () => <Duplicates /> },
      { id: 'installers', label: 'Installers', icon: () => <Icon.archive />, render: () => <Installers /> }
    ]
  },
  {
    label: 'Apps',
    rooms: [
      { id: 'unused', label: 'Unused Apps', icon: () => <Icon.moon />, render: () => <UnusedApps /> },
      { id: 'uninstaller', label: 'Uninstaller', icon: () => <Icon.trash />, render: () => <Uninstaller /> },
      { id: 'leftovers', label: 'Leftovers', icon: () => <Icon.box />, render: () => <Leftovers /> },
      { id: 'startup', label: 'Startup Items', icon: () => <Icon.power />, render: () => <StartupItems /> }
    ]
  },
  {
    label: 'This Mac',
    rooms: [
      { id: 'monitor', label: 'Monitor', icon: () => <Icon.gauge />, render: (a) => <Monitor active={a} /> },
      { id: 'optimize', label: 'Optimize', icon: () => <Icon.wand />, render: () => <Optimize /> }
    ]
  },
  { rooms: [{ id: 'removed', label: 'Recently Removed', icon: () => <Icon.history />, render: () => <RecentlyRemoved /> }] }
]
const ROOMS = GROUPS.flatMap((g) => g.rooms)

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
        <aside className="plan-side st-side" aria-label="Storage rooms">
          {GROUPS.map((g, i) => (
            <div key={i} className="st-side-group">
              {g.label && <h4>{g.label}</h4>}
              {g.rooms.map((r) => <NavItem key={r.id} icon={r.icon()} label={r.label} on={room === r.id} onClick={() => setRoom(r.id)} />)}
            </div>
          ))}
          <span className="flex-1" />
          <DiskWidget />
        </aside>
        <div className="plan-main st-main">
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
                  <button type="button" className="btn btn-sm" onClick={() => void window.api.invoke('local:reveal', a.path)}><Icon.finder />Show in Finder</button>
                </li>
              ))}
            </ul>
            <div className="cal-edit-foot"><span className="flex-1" /><button type="button" className="btn btn-sm btn-primary" onClick={() => useStorage.setState({ adminItems: null })}>Done</button></div>
          </div>
        </Modal>
      )}
    </section>
  )
}

/** The foot of the sidebar: the startup disk's free space, and the scan (its progress, or when it last ran). */
function DiskWidget(): ReactElement {
  const disk = useStorage((s) => s.disk)
  const scan = useStorage((s) => s.scan)
  const used = disk ? disk.total - disk.free : 0
  const pct = disk && disk.total ? (used / disk.total) * 100 : 0
  const level = disk && disk.free / disk.total < 0.05 ? 'crit' : disk && disk.free / disk.total < 0.1 ? 'warn' : 'ok'
  return (
    <div className="st-disk">
      <div className="st-disk-name"><Icon.disk />{disk?.name ?? 'Macintosh HD'}</div>
      <div className={`st-disk-bar ${level}`}><span style={{ width: `${pct}%` }} /></div>
      <div className="st-disk-free">{disk ? <><b>{bytes(disk.free)}</b> free of {bytes(disk.total)}</> : 'Reading the disk…'}</div>
      <div className="st-disk-scan">
        {scan.status === 'scanning' ? (
          <>
            <span className="st-spinner sm" aria-hidden="true" />
            <span className="flex-1 st-disk-scan-text" title={scan.progress?.path}>Scanning · {bytes(scan.progress?.bytes ?? 0)}</span>
            <button type="button" className="plan-add" aria-label="Stop the scan" title="Stop the scan" onClick={() => void cancelScan()}><Icon.x /></button>
          </>
        ) : (
          <>
            <span className="flex-1 st-disk-scan-text" title={scan.summary ? `Scanned ${scan.summary.root === '/' ? 'the whole Mac' : tilde(scan.summary.root)}` : undefined}>
              {scan.summary ? `${scan.summary.root === '/' ? 'Mac' : tilde(scan.summary.root)} · ${ago(scan.summary.at)}` : 'Not scanned yet'}
            </span>
            <button type="button" className="plan-add" aria-label="Scan again" title={scan.summary ? 'Scan again' : 'Scan the whole Mac'}
              onClick={() => void startScan(scan.summary?.kind ?? 'mac', scan.summary?.kind === 'path' ? scan.summary.root : undefined)}><Icon.refresh /></button>
          </>
        )}
      </div>
    </div>
  )
}

import type { ReactElement } from 'react'
import { allInstances, routeOf, useStore, type Tab } from '../store'
import { openFilesFor, openRdpFor, openSshFor } from '../quickConnect'
import { Icon } from './icons'

/** Buttons that open another kind of session to the same host from inside a session tab. Shift-click opens the dialog. */
export default function HostActions({ instanceKey, current }: { instanceKey: string; current: Tab['kind'] }): ReactElement | null {
  const s = useStore()
  const i = allInstances(s).find((x) => x.key === instanceKey)
  if (!i) return null
  const reachable = ['direct', 'ssm'].includes(routeOf(i, s.settings).route)
  return (
    <span className="flex items-center gap-1" title={`Open another session to ${i.name}`}>
      {current !== 'ssh' && (i.platform !== 'windows' || i.manual) && (
        <button className="btn btn-sm btn-ssh" disabled={!reachable} title="SSH terminal to this host (shift-click for options)" onClick={(e) => openSshFor(instanceKey, e.shiftKey)}>
          <Icon.terminal /> SSH
        </button>
      )}
      {current !== 'sftp' && (
        <button className="btn btn-sm" disabled={!reachable} title="Browse and transfer files on this host (shift-click for options)" onClick={(e) => openFilesFor(instanceKey, e.shiftKey)}>
          <Icon.folder /> Files
        </button>
      )}
      {current !== 'rdp' && (
        <button className="btn btn-sm btn-rdp" disabled={!reachable} title="Remote desktop to this host (shift-click for options)" onClick={(e) => void openRdpFor(instanceKey, e.shiftKey)}>
          <Icon.monitor /> RDP
        </button>
      )}
    </span>
  )
}

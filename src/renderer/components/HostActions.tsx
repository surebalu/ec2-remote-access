import type { ReactElement } from 'react'
import { allInstances, routeOf, useStore, type Tab } from '../store'
import { hasBrowser, openFilesFor, openInConsole, openRdpFor, openSshFor } from '../quickConnect'
import { Icon } from './icons'

/** Opens (creating on first use) a host's note in the Notes tab, beside `tabId` when given. */
export function openHostNote(instanceKey: string, tabId?: string): void {
  window.api.invoke('notes:hostNote', instanceKey).then(
    (path) => useStore.getState().openNotes(path, { beside: tabId }),
    (e: Error) => useStore.getState().toast('error', e.message)
  )
}

/**
 * Buttons that open another kind of session to the same host from inside a session tab (shift-click opens the
 * dialog), and the host's note beside it.
 */
export default function HostActions({ instanceKey, current, tabId }: { instanceKey: string; current: Tab['kind']; tabId?: string }): ReactElement | null {
  const s = useStore()
  const i = allInstances(s).find((x) => x.key === instanceKey)
  if (!i) return null
  const reachable = ['direct', 'ssm'].includes(routeOf(i, s.settings).route)
  // The Notes tab already beside this session: the button closes it again.
  const notesTab = s.tabs.find((t) => t.kind === 'notes')
  const noteBeside = !!tabId && !!notesTab && s.splitGroup.includes(tabId) && s.splitGroup.includes(notesTab.id)
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
      {/* Linux hosts rarely run an RDP server; RDP stays available from the host's right-click menu. */}
      {current !== 'rdp' && i.platform === 'windows' && (
        <button className="btn btn-sm btn-rdp" disabled={!reachable} title="Remote desktop to this host (shift-click for options)" onClick={(e) => void openRdpFor(instanceKey, e.shiftKey)}>
          <Icon.monitor /> RDP
        </button>
      )}
      <button className={`btn btn-sm ${noteBeside ? 'on' : ''}`} title={noteBeside ? 'Close the note beside this session' : "This host's note, beside this session (kept in your notes folder)"} aria-pressed={noteBeside} onClick={() => (noteBeside ? void s.closeTab(notesTab!.id) : openHostNote(instanceKey, tabId))}>
        <Icon.note /> Note
      </button>
      {!i.manual && hasBrowser() && (
        <button className="btn btn-sm btn-icon" title={`Open ${i.name} in the ${i.profile} AWS console (Browser tab, signed in)`} aria-label="Open in AWS console" onClick={() => openInConsole(i)}>
          <Icon.globe />
        </button>
      )}
    </span>
  )
}

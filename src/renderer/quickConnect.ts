/**
 * One-click session openers shared by the hosts table and the per-tab host actions.
 * Each opens straight away when the needed parameters are already known (an open tab for the same host, saved
 * per-host overrides, account defaults, saved RDP credentials) and falls back to the connect dialog otherwise.
 */
import type { SftpOpenRequest } from '@shared/types'
import { allInstances, useStore } from './store'

/** Double-click behaviour: RDP for Windows hosts, SSH for everything else. */
export function openDefaultFor(key: string): void {
  const i = instanceFor(key)
  if (!i) return
  if (i.platform === 'windows') void openRdpFor(key)
  else openSshFor(key)
}

const newId = (kind: string): string => `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

function instanceFor(key: string): ReturnType<typeof allInstances>[number] | undefined {
  return allInstances(useStore.getState()).find((i) => i.key === key)
}

type SshParams = Omit<SftpOpenRequest, 'sessionId' | 'instanceKey'>

/** SSH parameters derivable without asking: from an open SSH/SFTP tab on the same host, else saved defaults. */
function sshParams(key: string): SshParams | null {
  const s = useStore.getState()
  const i = instanceFor(key)
  if (!i) return null
  const candidates = s.tabs.filter((t) => t.instanceKey === key && ((t.kind === 'ssh' && t.request) || (t.kind === 'sftp' && t.sftpRequest)))
  const fromTab = candidates.find((t) => t.status === 'connected') ?? candidates[0]
  if (fromTab) {
    const r = fromTab.kind === 'ssh' ? fromTab.request! : fromTab.sftpRequest!
    // A connected tab lends its authenticated connection, so no second login (or agent prompt) is needed.
    const reuseSessionId = fromTab.status === 'connected' ? fromTab.id : undefined
    return { user: r.user, port: r.port, identityFile: r.identityFile, useAgent: r.useAgent, forceRoute: r.forceRoute, reuseSessionId }
  }
  const pd = s.settings?.profileDefaults?.[i.profile]
  const ov = s.settings?.overrides[key]
  const ready = i.manual ? !!ov?.sshUser : !!pd && (!!pd.sshUser || !!pd.identityFile)
  if (!ready) return null
  // The main process fills user/identity from overrides and account defaults when these are undefined.
  return { user: ov?.sshUser, port: ov?.sshPort, identityFile: ov?.identityFile, useAgent: ov?.useAgent, forceRoute: ov?.forceRoute }
}

export function openSshFor(key: string, forceDialog = false): void {
  const s = useStore.getState()
  const i = instanceFor(key)
  if (!i) return
  const p = forceDialog ? null : sshParams(key)
  if (!p) {
    s.set({ connectFor: { kind: 'ssh', key } })
    return
  }
  const id = newId('ssh')
  s.addTab({ id, kind: 'ssh', instanceKey: key, title: `${i.name} @ ${i.profile}`, status: 'connecting', request: { instanceKey: key, sessionId: id, ...p } })
}

export function openFilesFor(key: string, forceDialog = false): void {
  const s = useStore.getState()
  const i = instanceFor(key)
  if (!i) return
  const p = forceDialog ? null : sshParams(key)
  if (!p) {
    s.set({ connectFor: { kind: 'sftp', key } })
    return
  }
  s.addTab({ id: newId('sftp'), kind: 'sftp', instanceKey: key, title: `${i.name} @ ${i.profile}`, status: 'connecting', sftpRequest: { instanceKey: key, ...p } })
}

export async function openRdpFor(key: string, forceDialog = false): Promise<void> {
  const s = useStore.getState()
  const i = instanceFor(key)
  if (!i) return
  const cred = forceDialog ? null : await window.api.invoke('creds:get', key).catch(() => null)
  if (!cred) {
    s.set({ connectFor: { kind: 'rdp', key } })
    return
  }
  const ov = s.settings?.overrides[key]
  s.addTab({
    id: newId('rdp'),
    kind: 'rdp',
    instanceKey: key,
    title: `${i.name} @ ${i.profile}`,
    status: 'connecting',
    rdpRequest: { user: cred.user, password: cred.password, port: ov?.rdpPort, forceRoute: ov?.forceRoute }
  })
}

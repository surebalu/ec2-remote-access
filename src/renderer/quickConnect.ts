/**
 * One-click session openers shared by the hosts table and the per-tab host actions.
 * Each opens straight away when the needed parameters are already known (an open tab for the same host, saved
 * per-host overrides, account defaults, saved RDP credentials) and falls back to the connect dialog otherwise.
 */
import type { Instance, SftpOpenRequest } from '@shared/types'
import { consoleHome, ec2InstanceUrl } from '@shared/browser'
import { defaultSessionFor } from '@shared/tailnet'
import { allInstances, useStore, vncCredKey, type Beside } from './store'
import { nativeApp } from './mobile'

/** The built-in browser needs Electron's <webview>; on a phone or the gateway page links open in the device's browser. */
export const hasBrowser = (): boolean => /\bElectron\//.test(navigator.userAgent)

/**
 * Without the Mac app's browser (a phone, a tablet, the gateway page): opens the account's console already signed
 * in, in Safari, through a one-time sign-in link the computer issues. Safari keeps one set of AWS logins, so the
 * last account opened is the one signed in there.
 */
export function openConsoleOnDevice(profile: string, url: string): void {
  const app = nativeApp()
  // A browser opens new windows only straight from a tap, and the link arrives later: open the window first. The
  // iPhone app hands any page off the gateway to Safari, so there the page simply goes to the link.
  const win = app ? null : window.open('about:blank', '_blank')
  window.api.invoke('browser:consoleUrl', profile, url).then(
    (signin) => {
      if (win) win.location.href = signin
      else location.href = signin
    },
    (e: Error) => {
      win?.close()
      useStore.getState().toast('error', e.message)
    }
  )
}

/** An account's console (or one of its pages), signed in: the Browser tab in the Mac app, Safari elsewhere. */
export function openAccountConsole(profile: string, url: string): void {
  if (hasBrowser()) useStore.getState().openBrowser({ profile, url })
  else openConsoleOnDevice(profile, url)
}

export function consoleHomeFor(profile: string): string {
  const p = useStore.getState().profiles.find((x) => x.name === profile)
  return consoleHome(p?.region ?? 'us-east-1')
}

/** Opens an AWS instance's page in its account's console, signed in. */
export function openInConsole(i: Instance): void {
  openAccountConsole(i.profile, ec2InstanceUrl(i.region, i.instanceId))
}

/**
 * Double-click behaviour: RDP for Windows hosts, SSH for everything else, and a Mac on the tailnet shows its screen.
 * `beside` opens it next to another tab.
 */
export function openDefaultFor(key: string, beside?: Beside): void {
  const i = instanceFor(key)
  if (!i) return
  const kind = defaultSessionFor(i)
  if (kind === 'vnc') void openScreenFor(key, beside)
  else if (kind === 'rdp') void openRdpFor(key, false, beside)
  else openSshFor(key, false, beside)
}

/**
 * Shows a computer's screen (VNC / macOS Screen Sharing). Opens straight away: the tab asks for whatever sign-in the
 * computer wants, so there is no dialog first. An open screen of the same host is brought forward instead.
 */
export async function openScreenFor(key: string, beside?: Beside): Promise<void> {
  const s = useStore.getState()
  const i = instanceFor(key)
  if (!i) return
  const open = s.tabs.find((t) => t.kind === 'vnc' && t.instanceKey === key)
  if (open) { s.setActive(open.id); return }
  const cred = await window.api.invoke('creds:get', vncCredKey(key)).catch(() => null)
  const port = s.settings?.overrides[key]?.vncPort
  s.addTab({ id: newId('vnc'), kind: 'vnc', instanceKey: key, title: i.tailnet ? i.name : `${i.name} @ ${i.profile}`, status: 'connecting', vncRequest: { user: cred?.user || undefined, password: cred?.password, port } }, { beside })
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
  const ready = !!ov?.sshUser || !!ov?.identityFile || !!pd?.sshUser || !!pd?.identityFile
  if (!ready) return null
  // The main process fills user/identity from overrides and account defaults when these are undefined.
  return { user: ov?.sshUser, port: ov?.sshPort, identityFile: ov?.identityFile, useAgent: ov?.useAgent, forceRoute: ov?.forceRoute }
}

export function openSshFor(key: string, forceDialog = false, beside?: Beside): void {
  const s = useStore.getState()
  const i = instanceFor(key)
  if (!i) return
  const p = forceDialog ? null : sshParams(key)
  if (!p) {
    s.set({ connectFor: { kind: 'ssh', key, beside } })
    return
  }
  const id = newId('ssh')
  s.addTab({ id, kind: 'ssh', instanceKey: key, title: `${i.name} @ ${i.profile}`, status: 'connecting', request: { instanceKey: key, sessionId: id, ...p } }, { beside })
}

export function openFilesFor(key: string, forceDialog = false, beside?: Beside): void {
  const s = useStore.getState()
  const i = instanceFor(key)
  if (!i) return
  const p = forceDialog ? null : sshParams(key)
  if (!p) {
    s.set({ connectFor: { kind: 'sftp', key, beside } })
    return
  }
  s.addTab({ id: newId('sftp'), kind: 'sftp', instanceKey: key, title: `${i.name} @ ${i.profile}`, status: 'connecting', sftpRequest: { instanceKey: key, ...p } }, { beside })
}

export async function openRdpFor(key: string, forceDialog = false, beside?: Beside): Promise<void> {
  const s = useStore.getState()
  const i = instanceFor(key)
  if (!i) return
  const cred = forceDialog ? null : await window.api.invoke('creds:get', key).catch(() => null)
  if (!cred) {
    s.set({ connectFor: { kind: 'rdp', key, beside } })
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
  }, { beside })
}

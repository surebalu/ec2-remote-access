import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import type { HostOverride } from '@shared/types'
import { allInstances, routeOf, useStore } from '../store'
import Modal from './Modal'

export default function ConnectDialog(): ReactElement | null {
  const s = useStore()
  const target = s.connectFor!
  const inst = allInstances(s).find((i) => i.key === target.key)
  const ov: HostOverride = s.settings?.overrides[target.key] ?? {}
  /** SFTP shares the SSH identity, user and port. */
  const sshLike = target.kind !== 'rdp'
  const [user, setUser] = useState('')
  const [port, setPort] = useState<string>('')
  const [route, setRoute] = useState<'auto' | 'direct' | 'ssm'>(ov.forceRoute ?? 'auto')
  const [identity, setIdentity] = useState(ov.identityFile ?? s.settings?.profileDefaults?.[inst?.profile ?? '']?.identityFile ?? '')
  const [useAgent, setUseAgent] = useState(ov.useAgent ?? true)
  const globalInit = s.settings?.sshInitCommand ?? ''
  const [initCmd, setInitCmd] = useState(ov.initCommand ?? globalInit)
  const [remember, setRemember] = useState(true)
  const [busy, setBusy] = useState(false)
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [savePw, setSavePw] = useState(true)
  const [pwSource, setPwSource] = useState<string>('')

  useEffect(() => {
    if (!inst) return
    const hint = `${inst.osHint} ${inst.platformDetails}`.toLowerCase()
    const guess = /ubuntu/.test(hint) ? 'ubuntu' : /debian/.test(hint) ? 'admin' : /centos/.test(hint) ? 'centos' : 'ec2-user'
    if (sshLike) {
      setUser(ov.sshUser || s.settings?.profileDefaults?.[inst.profile]?.sshUser || s.settings?.defaultLinuxUser || guess)
      setPort(String(ov.sshPort ?? 22))
    } else {
      setUser(ov.rdpUser || s.settings?.defaultWindowsUser || 'Administrator')
      setPort(String(ov.rdpPort ?? 3389))
      void window.api.invoke('creds:get', inst.key).then((c) => {
        if (c) {
          setUser(c.user)
          setPassword(c.password)
          setPwSource('saved')
        }
      })
    }
  }, [inst, target.kind]) // eslint-disable-line react-hooks/exhaustive-deps

  const fetchEc2Password = async (): Promise<void> => {
    if (!inst) return
    setBusy(true)
    try {
      const r = await window.api.invoke('ec2:password', inst.key)
      if (r.password) {
        setPassword(r.password)
        setUser((u) => u || 'Administrator')
        setPwSource('EC2 key pair')
      } else s.toast('error', r.error ?? 'No password data')
    } finally {
      setBusy(false)
    }
  }

  if (!inst) return null
  const decided = routeOf(inst, s.settings)
  const effectiveRoute = route === 'auto' ? decided.route : route
  const close = (): void => s.set({ connectFor: null })

  const persist = async (): Promise<void> => {
    if (!remember) return
    const patch: HostOverride = { ...ov, forceRoute: route === 'auto' ? undefined : route }
    if (sshLike) {
      patch.sshUser = user || undefined
      patch.sshPort = Number(port) || undefined
      patch.identityFile = identity || undefined
      patch.useAgent = useAgent
      // Store only a deviation from the global default; '' is a deliberate "nothing for this host".
      patch.initCommand = initCmd.trim() === globalInit.trim() ? undefined : initCmd
    } else {
      patch.rdpUser = user || undefined
      patch.rdpPort = Number(port) || undefined
    }
    await s.saveSettings({ overrides: { ...(s.settings?.overrides ?? {}), [inst.key]: patch } })
  }

  const connect = async (external = false): Promise<void> => {
    setBusy(true)
    try {
      await persist()
      const force = route === 'auto' ? undefined : route
      if (target.kind === 'rdp') {
        if (external) {
          const t = await window.api.invoke('rdp:open', { instanceKey: inst.key, user, port: Number(port) || 3389, forceRoute: force })
          s.toast('success', t ? `Tunnel ready on localhost:${t.localPort}; Windows App launched.` : 'Windows App launched.')
          close()
          return
        }
        if (!password) throw new Error('Password is required for the embedded RDP client (NLA).')
        if (savePw) await window.api.invoke('creds:set', inst.key, { user, password })
        const id = `rdp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
        s.addTab({
          id,
          kind: 'rdp',
          instanceKey: inst.key,
          title: `${inst.name} @ ${inst.profile}`,
          status: 'connecting',
          rdpRequest: { user, password, port: Number(port) || 3389, forceRoute: force }
        })
        close()
        return
      }
      if (target.kind === 'sftp') {
        const id = `sftp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
        s.addTab({
          id,
          kind: 'sftp',
          instanceKey: inst.key,
          title: `${inst.name} @ ${inst.profile}`,
          status: 'connecting',
          sftpRequest: { instanceKey: inst.key, user, port: Number(port) || 22, identityFile: identity || undefined, useAgent, forceRoute: force }
        })
        close()
        return
      }
      const req = {
        instanceKey: inst.key,
        user,
        port: Number(port) || 22,
        identityFile: identity || undefined,
        useAgent,
        forceRoute: force,
        initCommand: initCmd,
        cols: 120,
        rows: 32
      }
      if (external) {
        await window.api.invoke('ssh:external', req)
        close()
        return
      }
      const id = `ssh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      const { cols: _c, rows: _r, ...request } = req
      s.addTab({ id, kind: 'ssh', instanceKey: inst.key, title: `${inst.name} @ ${inst.profile}`, status: 'connecting', request: { ...request, sessionId: id } })
      close()
    } catch (e) {
      s.noteOperationError((e as Error).message)
      s.toast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`${target.kind.toUpperCase()} → ${inst.name}`} onClose={close}>
      <div className="muted mb-3 truncate font-mono text-[11px]">
        {inst.instanceId} · {inst.profile} · {inst.region} · {inst.publicIp ?? inst.privateIp ?? 'no ip'}
      </div>
      <div className="grid grid-cols-[110px_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
        <label className="muted">Username</label>
        <input className="input" value={user} onChange={(e) => setUser(e.target.value)} />
        <label className="muted">Port</label>
        <input className="input" value={port} onChange={(e) => setPort(e.target.value)} />
        {!inst.manual && <label className="muted">Route</label>}
        {!inst.manual && (
        <select className="input" value={route} onChange={(e) => setRoute(e.target.value as typeof route)}>
          <option value="auto">Auto ({decided.reason})</option>
          <option value="direct" disabled={!inst.publicIp && !inst.privateIp}>
            Direct to {inst.publicIp ?? inst.privateIp}
          </option>
          <option value="ssm" disabled={!inst.ssmOnline}>
            SSM Session Manager{inst.ssmOnline ? '' : ' (agent offline)'}
          </option>
        </select>
        )}
        {target.kind === 'rdp' && (
          <>
            <label className="muted">Password</label>
            <div>
              <div className="flex gap-1">
                <input className="input" type={showPw ? 'text' : 'password'} value={password} onChange={(e) => { setPassword(e.target.value); setPwSource('') }} />
                <button className="btn" onClick={() => setShowPw(!showPw)}>
                  {showPw ? 'Hide' : 'Show'}
                </button>
                {!inst.manual && (
                  <button className="btn whitespace-nowrap" disabled={busy} title="Decrypt EC2 GetPasswordData with your key pair .pem (Settings)" onClick={() => void fetchEc2Password()}>
                    From EC2
                  </button>
                )}
              </div>
              <label className="mt-1 flex items-center gap-2 text-[11px]">
                <input type="checkbox" checked={savePw} onChange={(e) => setSavePw(e.target.checked)} /> Save in Keychain for this instance
                {pwSource && <span className="muted">· loaded from {pwSource}</span>}
              </label>
            </div>
          </>
        )}
        {sshLike && (
          <>
            <label className="muted">SSH agent</label>
            <label className="flex min-w-0 items-center gap-2">
              <input type="checkbox" checked={useAgent} onChange={(e) => setUseAgent(e.target.checked)} />
              <span className="muted min-w-0 truncate text-[11px]" title={s.settings?.sshAgentSock}>{s.settings?.sshAgentSock || 'no agent socket configured'}</span>
            </label>
            <label className="muted">Identity file</label>
            <div className="flex gap-1">
              <input className="input" placeholder="optional, e.g. ~/.ssh/id_ec2" value={identity} onChange={(e) => setIdentity(e.target.value)} />
              <button
                className="btn"
                onClick={async () => {
                  const f = await window.api.invoke('dialog:pickFile', 'Choose private key')
                  if (f) setIdentity(f)
                }}
              >
                …
              </button>
            </div>
            {target.kind === 'ssh' && (
              <>
                <label className="muted">Run after connect</label>
                <div>
                  <textarea className="input mono min-h-[40px] resize-y text-[11px]" rows={1} spellCheck={false} placeholder="none" value={initCmd} onChange={(e) => setInitCmd(e.target.value)} />
                  <div className="muted mt-0.5 text-[10px]">
                    {initCmd.trim() === globalInit.trim() ? 'Using the global setting from Settings.' : initCmd.trim() ? 'Overrides the global setting for this host.' : 'Disabled for this host.'}
                    {globalInit && initCmd.trim() !== globalInit.trim() && <> <button className="underline" onClick={() => setInitCmd(globalInit)}>Reset to global</button></>}
                  </div>
                </div>
              </>
            )}
          </>
        )}
        <span />
        <label className="flex items-center gap-2 text-[11px]">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember these settings for this instance
        </label>
      </div>
      {effectiveRoute === 'unreachable' && <div className="mt-3 text-orange-500">{decided.reason}</div>}
      {target.kind === 'sftp' && (
        <div className="muted mt-3 text-[11px]">
          Opens a file browser tab over SFTP{effectiveRoute === 'ssm' ? ' through SSM' : ''}. Requires an SSH server on the host (on Windows, the OpenSSH Server feature).
        </div>
      )}
      {target.kind === 'rdp' && (
        <div className="muted mt-3 text-[11px]">
          Connect opens the desktop as a tab in this app{effectiveRoute === 'ssm' ? ' through an SSM tunnel' : ''}. "Windows App" hands off to Microsoft's client instead.
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" onClick={close}>
          Cancel
        </button>
        {target.kind !== 'sftp' && (
          <button className="btn" disabled={busy || effectiveRoute === 'unreachable'} onClick={() => void connect(true)}>
            {target.kind === 'ssh' ? `Open in ${s.settings?.externalTerminal ?? 'Terminal'}` : 'Windows App'}
          </button>
        )}
        <button className="btn btn-primary" disabled={busy || effectiveRoute === 'unreachable'} onClick={() => void connect(false)}>
          {busy ? 'Connecting…' : target.kind === 'sftp' ? 'Open files' : 'Connect'}
        </button>
      </div>
    </Modal>
  )
}

import { useState, type ReactElement } from 'react'
import type { ManualHost, HostOverride } from '@shared/types'
import { manualKey } from '@shared/manual'
import { useStore } from '../store'
import Modal from './Modal'

/** Add / edit a server that is not in AWS. */
export default function ManualHostDialog(): ReactElement | null {
  const s = useStore()
  const editing = s.manualHostEditor
  const existing = editing && editing !== 'new' ? s.settings?.manualHosts.find((h) => h.id === editing) : undefined
  const ov: HostOverride = existing ? (s.settings?.overrides[manualKey(existing.id)] ?? {}) : {}
  const groups = s.folders()

  const [name, setName] = useState(existing?.name ?? '')
  const [host, setHost] = useState(existing?.host ?? '')
  const [platform, setPlatform] = useState<'linux' | 'windows'>(existing?.platform ?? 'linux')
  const [group, setGroup] = useState(existing?.group ?? s.manualHostFolder ?? groups[0] ?? 'Other servers')
  const [newFolder, setNewFolder] = useState(groups.length === 0 && !existing)
  const [notes, setNotes] = useState(existing?.notes ?? '')
  const [sshUser, setSshUser] = useState(ov.sshUser ?? '')
  const [sshPort, setSshPort] = useState(String(ov.sshPort ?? 22))
  const [identity, setIdentity] = useState(ov.identityFile ?? '')
  const [useAgent, setUseAgent] = useState(ov.useAgent ?? true)
  const [rdpUser, setRdpUser] = useState(ov.rdpUser ?? '')
  const [rdpPort, setRdpPort] = useState(String(ov.rdpPort ?? 3389))
  const [busy, setBusy] = useState(false)

  if (!editing) return null
  const close = (): void => s.set({ manualHostEditor: null, manualHostFolder: null })
  const valid = name.trim() && host.trim()

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const h: ManualHost = {
        id: existing?.id ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        name: name.trim(),
        host: host.trim(),
        platform,
        group: group.trim() || 'Other servers',
        notes: notes.trim() || undefined
      }
      const override: HostOverride = {
        sshUser: sshUser.trim() || undefined,
        sshPort: Number(sshPort) || undefined,
        identityFile: identity.trim() || undefined,
        useAgent,
        rdpUser: rdpUser.trim() || undefined,
        rdpPort: Number(rdpPort) || undefined,
        forceRoute: 'direct'
      }
      if (!s.folders().includes(h.group)) await s.saveFolder(null, h.group, 'teal')
      await s.saveManualHost(h, override)
      s.toast('success', `${existing ? 'Updated' : 'Added'} ${h.name}`)
      close()
    } catch (e) {
      s.toast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!existing) return
    if (!window.confirm(`Remove "${existing.name}" from your servers?`)) return
    await s.deleteManualHost(existing.id)
    close()
  }

  const row = (label: string, el: ReactElement): ReactElement => (
    <>
      <label className="muted">{label}</label>
      {el}
    </>
  )

  return (
    <Modal title={existing ? `Edit ${existing.name}` : 'Add a server'} onClose={close} width="max-w-xl">
      <div className="muted mb-3 text-[11px]">For machines outside AWS. Connections go directly to the host from this Mac (VPN or network reachability is up to you).</div>
      <div className="grid grid-cols-[110px_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
        {row('Name', <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. lab-db-01" />)}
        {row('Host / IP', <input className="input mono" value={host} onChange={(e) => setHost(e.target.value)} placeholder="10.20.30.40 or server.example.com" />)}
        {row(
          'Platform',
          <div className="seg">
            <button className={platform === 'linux' ? 'on' : ''} onClick={() => setPlatform('linux')}>
              Linux (SSH)
            </button>
            <button className={platform === 'windows' ? 'on' : ''} onClick={() => setPlatform('windows')}>
              Windows (RDP)
            </button>
          </div>
        )}
        {row(
          'Folder',
          newFolder || groups.length === 0 ? (
            <div className="flex gap-1">
              <input className="input" value={group} onChange={(e) => setGroup(e.target.value)} placeholder="New folder name, e.g. Lab" />
              {groups.length > 0 && (
                <button className="btn" onClick={() => { setNewFolder(false); setGroup(groups[0]) }}>
                  Pick existing
                </button>
              )}
            </div>
          ) : (
            <div className="flex gap-1">
              <select className="input" value={group} onChange={(e) => setGroup(e.target.value)}>
                {groups.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
              <button className="btn whitespace-nowrap" onClick={() => { setNewFolder(true); setGroup('') }}>
                + New folder
              </button>
            </div>
          )
        )}
        {row('Notes', <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" />)}

        <div className="section-title col-span-2 mt-2">SSH</div>
        {row(
          'User / port',
          <div className="flex gap-1">
            <input className="input" value={sshUser} onChange={(e) => setSshUser(e.target.value)} placeholder="ec2-user / root / admin" />
            <input className="input mono !w-20" value={sshPort} onChange={(e) => setSshPort(e.target.value)} />
          </div>
        )}
        {row(
          'Key file',
          <div className="flex gap-1">
            <input className="input" value={identity} onChange={(e) => setIdentity(e.target.value)} placeholder="optional; agent is used otherwise" />
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
        )}
        {row(
          'SSH agent',
          <label className="flex items-center gap-2 text-[11px]">
            <input type="checkbox" checked={useAgent} onChange={(e) => setUseAgent(e.target.checked)} /> also try keys from the SSH agent
          </label>
        )}

        <div className="section-title col-span-2 mt-2">RDP</div>
        {row(
          'User / port',
          <div className="flex gap-1">
            <input className="input" value={rdpUser} onChange={(e) => setRdpUser(e.target.value)} placeholder="Administrator or DOMAIN\\user" />
            <input className="input mono !w-20" value={rdpPort} onChange={(e) => setRdpPort(e.target.value)} />
          </div>
        )}
      </div>
      <div className="muted mt-2 text-[11px]">RDP passwords are asked for on connect and can be saved in the Keychain there.</div>
      <div className="mt-4 flex items-center gap-2">
        {existing && (
          <button className="btn" style={{ color: 'var(--err)' }} onClick={() => void remove()}>
            Remove
          </button>
        )}
        <span className="flex-1" />
        <button className="btn" onClick={close}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!valid || busy} onClick={() => void save()}>
          {existing ? 'Save' : 'Add server'}
        </button>
      </div>
    </Modal>
  )
}

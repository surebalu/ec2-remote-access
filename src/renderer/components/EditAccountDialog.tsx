import { useState, type ReactElement } from 'react'
import type { AccentColor } from '@shared/types'
import { ACCENTS, metaFor } from '../colors'
import { useStore } from '../store'
import Modal from './Modal'

/** Rename / relabel / recolor / remove an AWS profile. */
export default function EditAccountDialog(): ReactElement | null {
  const s = useStore()
  const name = s.editAccount!
  const profile = s.profiles.find((p) => p.name === name)
  const m = metaFor(name, s.settings)
  const [label, setLabel] = useState(s.settings?.accountMeta?.[name]?.label ?? '')
  const [color, setColor] = useState<AccentColor>(m.color)
  const [newName, setNewName] = useState(name)
  const [sshUser, setSshUser] = useState(s.settings?.profileDefaults?.[name]?.sshUser ?? '')
  const [identity, setIdentity] = useState(s.settings?.profileDefaults?.[name]?.identityFile ?? '')
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!profile) return null
  const close = (): void => s.set({ editAccount: null })

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const target = newName.trim()
      const st = s.settings!
      const accountMeta = { ...st.accountMeta, [target]: { label: label.trim() || undefined, color } }
      const profileDefaults = { ...st.profileDefaults, [target]: { sshUser: sshUser.trim() || undefined, identityFile: identity.trim() || undefined } }
      if (target !== name) {
        await window.api.invoke('profiles:rename', name, target)
        delete accountMeta[name]
        delete profileDefaults[name]
        // re-key everything that referenced the old profile name
        const remap = (k: string): string => (k.startsWith(`${name}/`) ? `${target}/${k.slice(name.length + 1)}` : k)
        const overrides: typeof st.overrides = {}
        for (const [k, v] of Object.entries(st.overrides)) overrides[remap(k)] = v
        await s.saveSettings({
          accountMeta,
          profileDefaults,
          overrides,
          favorites: st.favorites.map(remap),
          collapsedGroups: st.collapsedGroups.map((k) => (k === name ? target : k)),
          disabledProfiles: st.disabledProfiles.map((k) => (k === name ? target : k))
        })
        s.set({ instances: s.instances.map((i) => (i.profile === name ? { ...i, profile: target, key: remap(i.key) } : i)) })
      } else {
        await s.saveSettings({ accountMeta, profileDefaults })
      }
      await s.refreshProfiles()
      s.toast('success', 'Account updated')
      close()
    } catch (e) {
      s.toast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.api.invoke('profiles:remove', name)
      const st = s.settings!
      const accountMeta = { ...st.accountMeta }
      delete accountMeta[name]
      const profileDefaults = { ...st.profileDefaults }
      delete profileDefaults[name]
      await s.saveSettings({ accountMeta, profileDefaults, favorites: st.favorites.filter((k) => !k.startsWith(`${name}/`)) })
      s.set({ instances: s.instances.filter((i) => i.profile !== name), profileFilter: s.profileFilter === name ? null : s.profileFilter })
      await s.refreshProfiles()
      s.toast('success', `Removed ${name} from ~/.aws`)
      close()
    } catch (e) {
      s.toast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`Account: ${name}`} onClose={close} width="max-w-lg">
      <div className="muted mb-3 text-[11px]">
        {profile.kind === 'sso' ? `SSO · session ${profile.ssoSession ?? '-'} · account ${profile.accountId ?? '?'}` : profile.kind === 'static' ? 'Access keys' : 'Other'} · {profile.region}
      </div>
      <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-x-3 gap-y-3">
        <label className="muted">Profile name</label>
        <input className="input mono" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <label className="muted">Environment</label>
        <input className="input" value={label} placeholder="Dev / QA / Prod" onChange={(e) => setLabel(e.target.value)} />
        <label className="muted">Color</label>
        <div className="flex items-center gap-1.5">
          {ACCENTS.map((c) => (
            <button key={c} data-accent={c} title={c} onClick={() => setColor(c)} className="h-6 w-6 rounded-full border-2 transition-transform hover:scale-110" style={{ background: 'var(--c)', borderColor: color === c ? 'var(--text)' : 'transparent' }} />
          ))}
          <span className="avatar sm ml-2" data-accent={color}>
            {(label.trim() || newName).slice(0, 2).toUpperCase()}
          </span>
        </div>
        <div className="section-title col-span-2 mt-1">SSH defaults (one-click connect)</div>
        <label className="muted">User</label>
        <input className="input" value={sshUser} placeholder="ec2-user" onChange={(e) => setSshUser(e.target.value)} />
        <label className="muted">Key file</label>
        <div className="flex gap-1">
          <input className="input" value={identity} placeholder="~/path/key.pem (optional)" onChange={(e) => setIdentity(e.target.value)} />
          <button
            className="btn"
            onClick={async () => {
              const f = await window.api.invoke('dialog:pickFile', `Key for ${name}`)
              if (f) setIdentity(f)
            }}
          >
            …
          </button>
        </div>
      </div>
      <div className="mt-5 rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
        {!confirm ? (
          <div className="flex items-center justify-between text-[11px]">
            <span className="muted">Removes the profile from ~/.aws/config (and credentials).</span>
            <button className="btn btn-sm" style={{ color: 'var(--err)' }} onClick={() => setConfirm(true)}>
              Remove account…
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between text-[12px]">
            <span>Remove "{name}" from this Mac's AWS config?</span>
            <span className="flex gap-2">
              <button className="btn btn-sm" onClick={() => setConfirm(false)}>
                Keep
              </button>
              <button className="btn btn-sm" style={{ background: 'var(--err)', color: '#fff', borderColor: 'var(--err)' }} disabled={busy} onClick={() => void remove()}>
                Remove
              </button>
            </span>
          </div>
        )}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" onClick={close}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={busy || !newName.trim()} onClick={() => void save()}>
          Save
        </button>
      </div>
    </Modal>
  )
}

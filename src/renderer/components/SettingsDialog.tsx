import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import type { Settings } from '@shared/types'
import { useStore } from '../store'
import Modal from './Modal'
import { ACCENTS, metaFor } from '../colors'
import type { AccentColor } from '@shared/types'

export default function SettingsDialog(): ReactElement | null {
  const s = useStore()
  const [draft, setDraft] = useState<Settings | undefined>(s.settings)
  const [paths, setPaths] = useState<{ sessionManagerPlugin: string | null; awsCli: string | null; windowsApp: boolean } | null>(null)
  useEffect(() => {
    void window.api.invoke('app:paths').then(setPaths)
  }, [])
  if (!draft) return null
  const close = (): void => s.set({ settingsOpen: false })
  const upd = <K extends keyof Settings>(k: K, v: Settings[K]): void => setDraft({ ...draft, [k]: v })
  const pick = async (k: 'sshAgentSock' | 'defaultIdentityFile' | 'pemFile' | 'sessionManagerPluginPath' | 'awsCliPath'): Promise<void> => {
    const f = await window.api.invoke('dialog:pickFile', 'Choose file')
    if (f) upd(k, f)
  }
  const field = (label: string, k: keyof Settings, placeholder = '', pickable = false, hint?: string): ReactElement => (
    <>
      <label className="muted">{label}</label>
      <div>
        <div className="flex gap-1">
          <input className="input" placeholder={placeholder} value={String(draft[k] ?? '')} onChange={(e) => upd(k, e.target.value as never)} />
          {pickable && (
            <button className="btn" onClick={() => void pick(k as never)}>
              …
            </button>
          )}
        </div>
        {hint && <div className="muted mt-0.5 text-[10px]">{hint}</div>}
      </div>
    </>
  )
  const save = async (): Promise<void> => {
    await s.saveSettings(draft)
    await s.refreshProfiles()
    close()
    s.toast('success', 'Settings saved')
  }
  return (
    <Modal title="Settings" onClose={close} width="max-w-2xl">
      <div className="grid grid-cols-[170px_minmax(0,1fr)] items-start gap-x-3 gap-y-2.5">
        <label className="muted">Appearance</label>
        <div className="seg max-w-xs">
          {(['system', 'light', 'dark'] as const).map((t) => (
            <button key={t} className={draft.theme === t ? 'on' : ''} onClick={() => { upd('theme', t); void s.setTheme(t) }}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        <label className="muted">Regions</label>
        <div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={draft.scanAllRegions} onChange={(e) => upd('scanAllRegions', e.target.checked)} /> Scan every enabled region (slower)
          </label>
          <input
            className="input mt-1"
            placeholder="Extra regions, comma separated (e.g. us-east-1, eu-west-1)"
            disabled={draft.scanAllRegions}
            value={draft.extraRegions.join(', ')}
            onChange={(e) => upd('extraRegions', e.target.value.split(',').map((x) => x.trim()).filter(Boolean))}
          />
          <div className="muted mt-0.5 text-[10px]">Each profile's own region is always scanned.</div>
        </div>
        <label className="muted">Auto route</label>
        <div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={draft.preferDirect} onChange={(e) => upd('preferDirect', e.target.checked)} /> Prefer public IP over SSM when both are available
          </label>
          <div className="muted mt-0.5 text-[10px]">Off (default) uses SSM Session Manager whenever the agent is online; public IPs often sit behind security groups that block your IP.</div>
        </div>
        <label className="muted">Environments</label>
        <div className="space-y-1">
          <div className="muted text-[10px]">Label and color for each account; used for folders, avatars, and badges.</div>
          {s.profiles.map((p) => {
            const m = metaFor(p.name, draft)
            const set = (patch: { label?: string; color?: AccentColor }): void =>
              upd('accountMeta', { ...(draft.accountMeta ?? {}), [p.name]: { ...(draft.accountMeta?.[p.name] ?? {}), ...patch } })
            return (
              <div key={p.name} className="grid grid-cols-[70px_1fr_auto] items-center gap-2" data-accent={m.color}>
                <span className="flex items-center gap-1.5 truncate font-medium" title={p.name}>
                  <span className="avatar sm">{m.label.slice(0, 2).toUpperCase()}</span>
                  {p.name}
                </span>
                <input className="input" placeholder={`label, e.g. Dev / QA / Prod`} value={draft.accountMeta?.[p.name]?.label ?? ''} onChange={(e) => set({ label: e.target.value || undefined })} />
                <div className="flex gap-1">
                  {ACCENTS.map((c) => (
                    <button
                      key={c}
                      data-accent={c}
                      title={c}
                      onClick={() => set({ color: c })}
                      className="h-5 w-5 rounded-full border-2 transition-transform hover:scale-110"
                      style={{ background: 'var(--c)', borderColor: m.color === c ? 'var(--text)' : 'transparent' }}
                    />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
        <label className="muted">Per-account SSH defaults</label>
        <div className="space-y-1">
          <div className="muted text-[10px]">Accounts with a user or key here connect immediately when you click SSH (shift-click for the dialog).</div>
          {s.profiles.map((p) => {
            const pd = (draft.profileDefaults ?? {})[p.name] ?? {}
            const set = (patch: Partial<typeof pd>): void => upd('profileDefaults', { ...(draft.profileDefaults ?? {}), [p.name]: { ...pd, ...patch } })
            return (
              <div key={p.name} className="grid grid-cols-[70px_90px_1fr_auto] items-center gap-1">
                <span className="truncate font-medium" title={p.name}>{p.name}</span>
                <input className="input" placeholder="user" value={pd.sshUser ?? ''} onChange={(e) => set({ sshUser: e.target.value || undefined })} />
                <input className="input" placeholder="~/path/to/key.pem" value={pd.identityFile ?? ''} onChange={(e) => set({ identityFile: e.target.value || undefined })} />
                <button
                  className="btn"
                  onClick={async () => {
                    const f = await window.api.invoke('dialog:pickFile', `Key for ${p.name}`)
                    if (f) set({ identityFile: f })
                  }}
                >
                  …
                </button>
              </div>
            )
          })}
        </div>
        {field('Default Linux user', 'defaultLinuxUser', 'auto (ec2-user / ubuntu / admin by OS)')}
        {field('Default Windows user', 'defaultWindowsUser', 'Administrator')}
        {field('SSH agent socket', 'sshAgentSock', '$SSH_AUTH_SOCK', true, 'Default is the 1Password agent if present.')}
        {field('Default identity file', 'defaultIdentityFile', 'optional ~/.ssh/id_xxx', true)}
        {field('Key pair .pem (Windows pwd)', 'pemFile', '~/.ssh/keypair.pem', true, 'Used to decrypt GetPasswordData locally.')}
        <label className="muted">External terminal</label>
        <select className="input" value={draft.externalTerminal} onChange={(e) => upd('externalTerminal', e.target.value as Settings['externalTerminal'])}>
          <option>Warp</option>
          <option>Terminal</option>
          <option>iTerm</option>
        </select>
        {field('session-manager-plugin', 'sessionManagerPluginPath', paths?.sessionManagerPlugin ?? 'not found — brew install --cask session-manager-plugin', true)}
        {field('aws CLI (for SSO login)', 'awsCliPath', paths?.awsCli ?? 'not found — brew install awscli', true)}
        <label className="muted">Connect timeout (s)</label>
        <input className="input w-24" type="number" value={draft.connectTimeoutSec} onChange={(e) => upd('connectTimeoutSec', Number(e.target.value) || 20)} />
        <label className="muted">Windows App</label>
        <div className={paths?.windowsApp ? 'text-emerald-600' : 'text-orange-500'}>{paths ? (paths.windowsApp ? 'Installed' : 'Not found — install from the Mac App Store') : '…'}</div>
        <label className="muted">Hidden profiles</label>
        <div className="flex flex-wrap items-center gap-1">
          {draft.hiddenProfiles.length === 0 && <span className="muted">none</span>}
          {draft.hiddenProfiles.map((h) => (
            <span key={h} className="badge gap-1 border" style={{ borderColor: 'var(--border)' }}>
              {h}
              <button className="muted hover:opacity-70" title="Unhide" onClick={() => upd('hiddenProfiles', draft.hiddenProfiles.filter((x) => x !== h))}>
                ✕
              </button>
            </span>
          ))}
        </div>
        <label className="muted">Per-host overrides</label>
        <div className="flex items-center gap-2">
          <span className="muted">{Object.keys(draft.overrides).length} saved</span>
          <button className="btn" disabled={!Object.keys(draft.overrides).length} onClick={() => upd('overrides', {})}>
            Clear all
          </button>
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" onClick={close}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={() => void save()}>
          Save
        </button>
      </div>
    </Modal>
  )
}

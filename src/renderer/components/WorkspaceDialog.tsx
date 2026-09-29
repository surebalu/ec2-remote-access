import { useState, type ReactElement } from 'react'
import { useStore, workspaceTabOf } from '../store'
import Modal from './Modal'
import { Icon } from './icons'

/** Saves the open session tabs (or a subset) under a name; saving over an existing name replaces it. */
export default function WorkspaceDialog(): ReactElement {
  const s = useStore()
  const [name, setName] = useState('')
  const [picked, setPicked] = useState<Set<string>>(() => new Set(s.tabs.map((t) => t.id)))
  const close = (): void => s.set({ workspaceSaveOpen: false })
  const existing = s.settings?.workspaces.find((w) => w.name.toLowerCase() === name.trim().toLowerCase())
  const submit = async (): Promise<void> => {
    if (!name.trim() || !picked.size) return
    await s.saveWorkspace(name, s.tabs.filter((t) => picked.has(t.id)).map(workspaceTabOf))
    close()
  }
  return (
    <Modal title="Save workspace" onClose={close}>
      <form className="space-y-3 text-xs" onSubmit={(e) => { e.preventDefault(); void submit() }}>
        <p className="muted">A workspace reopens these sessions together from the sidebar or ⌘K. Connection settings are kept; RDP passwords are not (the saved Keychain credential is used).</p>
        <input className="input" autoFocus placeholder="Name, e.g. Prod web tier" value={name} onChange={(e) => setName(e.target.value)} />
        {existing && <p style={{ color: 'var(--warn)' }}>Replaces the workspace “{existing.name}” ({existing.tabs.length} tabs).</p>}
        <div className="max-h-64 space-y-0.5 overflow-y-auto rounded-lg border border-default p-1">
          {s.tabs.map((t) => (
            <label key={t.id} className="nav-row cursor-pointer">
              <input type="checkbox" checked={picked.has(t.id)} onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(t.id); else n.delete(t.id); return n })} />
              {t.kind === 'rdp' ? <Icon.monitor /> : t.kind === 'sftp' ? <Icon.folder /> : <Icon.terminal />}
              <span className="min-w-0 flex-1 truncate">{t.title}</span>
              <span className="muted text-[10px] uppercase">{t.kind}</span>
            </label>
          ))}
          {!s.tabs.length && <p className="muted p-3 text-center">No session tabs are open.</p>}
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={close}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!name.trim() || !picked.size}>{existing ? 'Replace' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  )
}

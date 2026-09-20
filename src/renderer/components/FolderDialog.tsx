import { useState, type ReactElement } from 'react'
import type { AccentColor } from '@shared/types'
import { ACCENTS, metaFor } from '../colors'
import { useStore } from '../store'
import Modal from './Modal'

/** Create / rename / recolor / delete a folder for non-AWS servers. */
export default function FolderDialog(): ReactElement | null {
  const s = useStore()
  const editing = s.folderEditor
  const existing = editing && editing !== 'new' ? editing : null
  const [name, setName] = useState(existing ?? '')
  const [color, setColor] = useState<AccentColor>(existing ? metaFor(`group:${existing}`, s.settings).color : 'teal')
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [moveTo, setMoveTo] = useState<string>('')
  if (!editing) return null
  const close = (): void => s.set({ folderEditor: null })
  const count = existing ? (s.settings?.manualHosts ?? []).filter((h) => h.group === existing).length : 0
  const otherFolders = s.folders().filter((f) => f !== existing)

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      await s.saveFolder(existing, name, color)
      s.toast('success', existing ? 'Folder updated' : `Folder "${name.trim()}" created`)
      close()
    } catch (e) {
      s.toast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const remove = async (): Promise<void> => {
    if (!existing) return
    setBusy(true)
    try {
      await s.deleteFolder(existing, count ? moveTo || null : null)
      s.toast('success', `Folder "${existing}" deleted`)
      close()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={existing ? `Folder: ${existing}` : 'New folder'} onClose={close} width="max-w-md">
      <div className="grid grid-cols-[90px_minmax(0,1fr)] items-center gap-x-3 gap-y-3">
        <label className="muted">Name</label>
        <input className="input" autoFocus value={name} placeholder="e.g. Lab, Office, Datacenter" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && void save()} />
        <label className="muted">Color</label>
        <div className="flex items-center gap-1.5">
          {ACCENTS.map((c) => (
            <button
              key={c}
              data-accent={c}
              title={c}
              onClick={() => setColor(c)}
              className="h-6 w-6 rounded-full border-2 transition-transform hover:scale-110"
              style={{ background: 'var(--c)', borderColor: color === c ? 'var(--text)' : 'transparent' }}
            />
          ))}
          <span className="avatar sm ml-2" data-accent={color}>
            {(name.trim() || 'Ab').slice(0, 2).toUpperCase()}
          </span>
        </div>
      </div>

      {existing && (
        <div className="mt-5 rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
          {!confirmDelete ? (
            <div className="flex items-center justify-between">
              <span className="muted text-[11px]">
                {count} server{count === 1 ? '' : 's'} in this folder
              </span>
              <button className="btn btn-sm" style={{ color: 'var(--err)' }} onClick={() => setConfirmDelete(true)}>
                Delete folder…
              </button>
            </div>
          ) : (
            <div className="space-y-2 text-[12px]">
              {count > 0 ? (
                <>
                  <div>What should happen to the {count} server{count === 1 ? '' : 's'} inside?</div>
                  <select className="input" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
                    <option value="">Delete them too</option>
                    {otherFolders.map((f) => (
                      <option key={f} value={f}>
                        Move to “{f}”
                      </option>
                    ))}
                  </select>
                </>
              ) : (
                <div>This folder is empty. Delete it?</div>
              )}
              <div className="flex justify-end gap-2">
                <button className="btn btn-sm" onClick={() => setConfirmDelete(false)}>
                  Keep
                </button>
                <button className="btn btn-sm" style={{ background: 'var(--err)', color: '#fff', borderColor: 'var(--err)' }} disabled={busy} onClick={() => void remove()}>
                  Delete
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" onClick={close}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!name.trim() || busy} onClick={() => void save()}>
          {existing ? 'Save' : 'Create folder'}
        </button>
      </div>
    </Modal>
  )
}

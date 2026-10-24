import { useState, type ReactElement } from 'react'
import type { SectionStatus } from '@shared/setup'
import { useStore } from '../store'
import Modal from './Modal'

/**
 * Import setup (Settings → Data, or the welcome screen): what the file brings from the other Mac, shown before anything
 * is written (setup:pickImport), then applied (setup:apply). Profiles already here are never overwritten; the merged
 * settings are saved like any other change. Afterwards: sign in (the banner asks), and the data folder the other Mac
 * used, offered here because it needs its own check that the folder can be written.
 */

const STATUS: Record<SectionStatus, { text: string; tone: string }> = {
  add: { text: 'Will be added', tone: 'var(--ok)' },
  same: { text: 'Already here', tone: 'var(--muted)' },
  kept: { text: 'A different one by this name stays', tone: 'var(--warn)' }
}

export default function SetupImportDialog(): ReactElement | null {
  const s = useStore()
  const preview = useStore((st) => st.setupImport)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ profiles: string[]; dataDir?: string } | null>(null)
  const [folder, setFolder] = useState<'idle' | 'set' | string>('idle')
  if (!preview) return null
  const close = (): void => s.set({ setupImport: null })

  const apply = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await window.api.invoke('setup:apply', preview.id)
      await s.saveSettings(r.settings)
      await s.refreshProfiles()
      setDone({ profiles: r.profiles, ...(r.dataDir ? { dataDir: r.dataDir } : {}) })
      void s.checkAuth()
    } catch (e) {
      s.toast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const useFolder = async (dir: string): Promise<void> => {
    try {
      const st = await window.api.invoke('data:setFolder', dir)
      setFolder(st.reachable ? 'set' : (st.lastError ?? 'The folder cannot be reached from this Mac yet.'))
    } catch (e) {
      setFolder((e as Error).message)
    }
  }

  const when = preview.exportedAt ? new Date(preview.exportedAt).toLocaleString() : ''
  return (
    <Modal title={done ? 'Setup imported' : 'Import setup'} onClose={close} width="max-w-xl">
      {!done ? (
        <div className="setup-import">
          <p className="muted text-[12px]">From <b className="text-[var(--text)]">{preview.from.computer}</b>{when && `, exported ${when}`} · <span className="mono">{preview.fileName}</span></p>
          {preview.profiles.length > 0 && (
            <section>
              <h4>AWS accounts ({preview.sessions.map((x) => x.name).join(', ')})</h4>
              <ul>
                {preview.profiles.map((p) => (
                  <li key={p.name}><span className="mono">{p.name}</span><span className="muted mono text-[11px]">{p.accountId}</span><span className="flex-1" /><span style={{ color: STATUS[p.status].tone }}>{STATUS[p.status].text}</span></li>
                ))}
              </ul>
              <p className="muted text-[11.5px]">Only the sign-in details are copied; you sign in once on this Mac. Nothing from ~/.aws/credentials is ever in the file.</p>
            </section>
          )}
          {preview.settings.length > 0 && (
            <section>
              <h4>Settings</h4>
              <p className="text-[12.5px]">{preview.settings.join(' · ')}</p>
              <p className="muted text-[11.5px]">Joined with what this Mac has: nothing here is removed. Phone access stays as it is on this Mac.</p>
            </section>
          )}
          {(preview.left.profiles.length > 0 || preview.left.dataDir) && (
            <section>
              <h4>Not in the file</h4>
              <ul>
                {preview.left.profiles.map((p) => <li key={p.name}><span className="mono">{p.name}</span><span className="muted text-[11.5px]">{p.why}</span></li>)}
                {preview.left.dataDir && <li><span>Data folder</span><span className="muted mono text-[11px]">{preview.left.dataDir}</span></li>}
              </ul>
            </section>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <button className="btn" onClick={close}>Cancel</button>
            <button className="btn btn-primary" disabled={busy} onClick={() => void apply()}>{busy ? 'Importing…' : 'Import'}</button>
          </div>
        </div>
      ) : (
        <div className="setup-import">
          <p className="text-[12.5px]">
            {done.profiles.length ? <>Added {done.profiles.length} AWS profile{done.profiles.length === 1 ? '' : 's'} ({done.profiles.join(', ')}) and the settings.</> : 'The settings are in. The AWS profiles were already here.'}
            {' '}Sign in to AWS when the app asks, and the hosts appear.
          </p>
          {done.dataDir && (
            <section>
              <h4>Data folder</h4>
              <p className="muted text-[11.5px]">{preview.from.computer} keeps Tasks, Calendar, Links, CAD reviews and whiteboards in sync through <span className="mono">{done.dataDir}</span>.</p>
              {folder === 'set'
                ? <p className="text-[12px]" style={{ color: 'var(--ok)' }}>This Mac now syncs with it too.</p>
                : <div className="flex items-center gap-2"><button className="btn btn-sm" onClick={() => void useFolder(done.dataDir!)}>Use it on this Mac</button>{folder !== 'idle' && <span className="text-[11.5px]" style={{ color: 'var(--err)' }}>{folder}</span>}</div>}
            </section>
          )}
          <div className="mt-3 flex justify-end"><button className="btn btn-primary" onClick={close}>Done</button></div>
        </div>
      )}
    </Modal>
  )
}

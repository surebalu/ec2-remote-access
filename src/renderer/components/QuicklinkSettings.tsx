import { useEffect, useState, type ReactElement } from 'react'
import { DEFAULT_SPACE, EXTERNAL, checkQuicklink, cleanQuicklink, type Quicklink } from '@shared/quicklinks'
import { useStore } from '../store'
import { Icon } from './icons'

/**
 * Settings → Launcher: the quicklinks, each saved as soon as it is changed. The list is read fresh from main when the
 * section opens, because the launcher (another window) adds links without this window's store knowing; the dialog's
 * Save leaves `quicklinks` out for the same reason.
 */
export default function QuicklinkSettings(): ReactElement {
  const [links, setLinks] = useState<Quicklink[] | null>(null)
  const [spaces, setSpaces] = useState<{ id: string; name: string }[]>([{ id: DEFAULT_SPACE, name: 'Browser' }])
  const [edit, setEdit] = useState<Quicklink | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.api.invoke('settings:get').then((s) => setLinks(s.quicklinks ?? []), () => setLinks([]))
    void window.api.invoke('browser:load').then((b) => { if (b?.spaces.length) setSpaces(b.spaces.map((x) => ({ id: x.id, name: x.name }))) }, () => undefined)
  }, [])

  const save = async (next: Quicklink[]): Promise<void> => {
    await useStore.getState().saveSettings({ quicklinks: next })
    setLinks(next)
  }
  const commit = (): void => {
    if (!edit || !links) return
    const link = cleanQuicklink(edit)
    const why = checkQuicklink(link, links.filter((l) => l.id !== edit.id))
    if (why) { setError(why); return }
    void save(edit.id ? links.map((l) => (l.id === edit.id ? link : l)) : [...links, link]).then(() => { setEdit(null); setError(null) }, (e: Error) => setError(e.message))
  }
  const where = (space: string): string => (space === EXTERNAL ? 'Your browser' : spaces.find((x) => x.id === space)?.name ?? 'Browser')

  return (
    <section className="set-group">
      <h3 className="set-group-title">Quicklinks</h3>
      <div className="set-card">
        <div className="set-row stack">
          <div className="set-text">
            <div className="set-label">A word that opens a page</div>
            <div className="set-hint">Type the keyword in the launcher and press ↩: “aws” can open your AWS sign-in portal in the app’s Browser. Put <code>{'{query}'}</code> in the address for words typed after the keyword (“jira PLM-42”). The launcher’s <em>Create Quicklink…</em> adds one too.</div>
          </div>
        </div>
        {links?.map((l) => (
          <div key={l.id} className="set-row ql-row">
            <span className="ql-key">{l.keyword ? <kbd className="kbd">{l.keyword}</kbd> : <span className="muted">no keyword</span>}</span>
            <div className="min-w-0 flex-1">
              <div className="set-label truncate">{l.name}</div>
              <div className="set-hint truncate">{l.url} · {where(l.space)}</div>
            </div>
            <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label={`Edit ${l.name}`} onClick={() => { setEdit({ ...l }); setError(null) }}><Icon.edit /></button>
            <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label={`Delete ${l.name}`} onClick={() => void save(links.filter((x) => x.id !== l.id))}><Icon.x /></button>
          </div>
        ))}
        {links && !links.length && !edit && <div className="set-row"><span className="set-hint">No quicklinks yet.</span></div>}
        {edit ? (
          <div className="set-row stack ql-edit" onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); commit() } }}>
            <div className="ql-grid">
              <label><span>Name</span><input className="input" value={edit.name} placeholder="AWS sign-in" autoFocus onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
              <label><span>Keyword</span><input className="input" value={edit.keyword} placeholder="aws" spellCheck={false} onChange={(e) => setEdit({ ...edit, keyword: e.target.value })} /></label>
              <label className="wide"><span>Address</span><input className="input" value={edit.url} placeholder="https://mainspring.awsapps.com/start" spellCheck={false} onChange={(e) => setEdit({ ...edit, url: e.target.value })} /></label>
              <label className="wide"><span>Open in</span>
                <select className="input" value={edit.space} onChange={(e) => setEdit({ ...edit, space: e.target.value })}>
                  {spaces.map((sp) => <option key={sp.id} value={sp.id}>The app’s Browser: {sp.name}</option>)}
                  <option value={EXTERNAL}>Your Mac’s default browser</option>
                </select>
              </label>
            </div>
            {error && <span className="set-key-error">{error}</span>}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn btn-sm" onClick={() => { setEdit(null); setError(null) }}>Cancel</button>
              <button type="button" className="btn btn-sm btn-primary" onClick={commit}>{edit.id ? 'Save' : 'Add quicklink'}</button>
            </div>
          </div>
        ) : (
          <div className="set-row">
            <button type="button" className="btn btn-sm" onClick={() => { setEdit({ id: '', name: '', keyword: '', url: '', space: DEFAULT_SPACE }); setError(null) }}><Icon.plus /> Add a quicklink</button>
          </div>
        )}
      </div>
    </section>
  )
}

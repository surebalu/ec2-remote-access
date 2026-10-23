import { useState, type ReactElement } from 'react'
import { workspaceSummary } from '@shared/workspaces'
import { isSession, TOOL_NAMES, useStore, type ToolKind } from '../store'
import { readWorkspaceContext } from '../workspaceContext'
import { LOOKS } from '../toolLooks'
import Modal from './Modal'
import { Icon } from './icons'

export default function WorkspaceDialog(): ReactElement {
  const s = useStore()
  const [name, setName] = useState('')
  const tabs = s.tabs.filter((t) => !t.transient)
  const [picked, setPicked] = useState(() => new Set(tabs.map((t) => t.id)))
  const [context] = useState(() => ({ terminal: readWorkspaceContext('local'), browser: readWorkspaceContext('browser') }))
  const terminal = context.terminal?.kind === 'local' ? context.terminal.terminal : undefined
  const browser = context.browser?.kind === 'browser' ? context.browser.browser : undefined
  const [terminalTabs, setTerminalTabs] = useState(() => new Set(terminal?.tabs.map((t) => t.id)))
  const [browserTabs, setBrowserTabs] = useState(() => new Set(browser?.tabs.map((t) => t.id)))
  const [layout, setLayout] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const close = (): void => { if (!saving) s.set({ workspaceSaveOpen: false }) }
  const existing = s.settings?.workspaces.find((w) => w.name.toLowerCase() === name.trim().toLowerCase())
  const toggle = (old: Set<string>, id: string): Set<string> => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next }
  const selected = tabs.filter((t) => picked.has(t.id))
  const emptyTerminal = selected.some((t) => t.kind === 'local') && !!terminal && !terminalTabs.size
  const submit = async (): Promise<void> => {
    if (saving || !name.trim() || !selected.length || emptyTerminal) return
    setSaving(true); setError('')
    try {
      await s.saveWorkspace(name, selected.map((t) => t.id), {
        layout, terminalTabs: terminal ? [...terminalTabs] : undefined, browserTabs: browser ? [...browserTabs] : undefined
      })
      s.set({ workspaceSaveOpen: false })
    } catch (e) { setError((e as Error).message) }
    finally { setSaving(false) }
  }
  return <Modal title="Save workspace" onClose={close} width="max-w-xl">
    <form className="workspace-save" onSubmit={(e) => { e.preventDefault(); void submit() }}>
      <p className="muted">Keep a project ready to resume: connections, folders, browser pages, notes, and your pane layout.</p>
      <label className="workspace-name">Workspace name<input className="input" autoFocus placeholder="e.g. Payments · development" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} disabled={saving} /></label>
      {existing && <p className="workspace-replace">Replaces “{existing.name}” · {workspaceSummary(existing)}</p>}
      <div className="workspace-picks" aria-label="Workspace contents">
        {tabs.map((t) => {
          const remote = isSession(t)
          const detail = t.kind === 'local' ? `${terminalTabs.size} terminal ${terminalTabs.size === 1 ? 'tab' : 'tabs'} · directories & splits` : t.kind === 'browser' ? `${browserTabs.size} ${browserTabs.size === 1 ? 'page' : 'pages'} · original browser spaces` : t.kind === 'notes' ? t.notesPath || 'Notes library' : remote ? t.kind.toUpperCase() : 'Open tool'
          return <div key={t.id} className={`workspace-pick ${picked.has(t.id) ? 'selected' : ''}`}>
            <label className="workspace-pick-main">
              <input type="checkbox" checked={picked.has(t.id)} disabled={saving} onChange={() => setPicked((p) => toggle(p, t.id))} />
              <span className="workspace-pick-icon">{remote ? t.kind === 'rdp' ? <Icon.monitor /> : t.kind === 'sftp' ? <Icon.folder /> : <Icon.terminal /> : LOOKS[t.kind as ToolKind].icon()}</span>
              <span><strong>{remote ? t.title : TOOL_NAMES[t.kind as ToolKind]}</strong><small>{detail}</small></span>
            </label>
            {picked.has(t.id) && t.kind === 'local' && terminal && <details className="workspace-subpicks"><summary>Choose terminal tabs</summary>
              {terminal.tabs.map((inner) => <label key={inner.id}><input type="checkbox" disabled={saving} checked={terminalTabs.has(inner.id)} onChange={() => setTerminalTabs((p) => toggle(p, inner.id))} /><span><strong>{inner.title || terminal.cwds[inner.activePane] || 'Terminal'}</strong><small>{[inner.profile, terminal.cwds[inner.activePane]].filter(Boolean).join(' · ') || 'Local shell'}</small></span></label>)}
            </details>}
            {picked.has(t.id) && t.kind === 'browser' && browser && browser.tabs.length > 0 && <details className="workspace-subpicks"><summary>Choose browser pages</summary>
              {browser.tabs.map((inner) => <label key={inner.id}><input type="checkbox" disabled={saving} checked={browserTabs.has(inner.id)} onChange={() => setBrowserTabs((p) => toggle(p, inner.id))} /><span><strong>{inner.name || inner.title || 'New tab'}</strong><small>{inner.spaceId} · {inner.url || 'Start page'}</small></span></label>)}
            </details>}
          </div>
        })}
        {!tabs.length && <p className="muted p-3 text-center">Open a terminal, browser, note or remote session to start a workspace.</p>}
      </div>
      {!!s.splitTree && <label className="workspace-layout"><input type="checkbox" checked={layout} disabled={saving} onChange={(e) => setLayout(e.target.checked)} /><Icon.grid />Restore the selected panes in this layout</label>}
      <p className="muted workspace-save-hint">Reuses matching open terminals and pages. Saves locations and connection settings; passwords, cookies, shell output, and document contents stay in their own tools.</p>
      {emptyTerminal && <p role="status" className="workspace-replace">Choose a terminal tab, or deselect Terminal.</p>}
      {error && <p role="alert" className="workspace-save-error">{error}</p>}
      <div className="flex justify-end gap-2"><button type="button" className="btn" disabled={saving} onClick={close}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving || !name.trim() || !selected.length || emptyTerminal}>{saving ? 'Saving…' : existing ? 'Replace workspace' : 'Save workspace'}</button></div>
    </form>
  </Modal>
}

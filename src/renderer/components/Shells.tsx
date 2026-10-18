import type { ReactElement } from 'react'
import { useState } from 'react'
import type { DetachedShell, HostShell } from '@shared/types'
import { Icon } from './icons'

/**
 * Persistent shells as people tell them apart: by the name they gave one ("debug", "indexing"), otherwise by who and
 * what runs in it (after sudo su: "3dxadmin · tail -f catalina.out") and the last line on its screen, which is
 * usually the prompt with user, host and directory. See main/ssh/persist.ts for where each comes from.
 */

function ago(sec: number): string {
  if (sec < 90) return 'just now'
  if (sec < 5400) return `${Math.round(sec / 60)} min`
  if (sec < 172_800) return `${Math.round(sec / 3600)} h`
  return `${Math.round(sec / 86_400)} days`
}

export function idleText(sec: number | null): string {
  return sec === null ? '' : `idle ${ago(sec)}`
}

/** "3dxadmin · tail -f catalina.out", falling back to tmux's own idea of the program. */
function shellWhat(sh: DetachedShell): string {
  const what = sh.args || sh.command || 'shell'
  return sh.user ? `${sh.user} · ${what}` : what
}

function shellWhen(sh: HostShell): string {
  const started = sh.ageSec !== null ? `started ${ago(sh.ageSec)}${sh.ageSec < 90 ? '' : ' ago'}` : ''
  const idle = !sh.current && !sh.attached ? idleText(sh.idleSec) : ''
  return [idle, started].filter(Boolean).join(' · ')
}

/**
 * Offered once at the top of a tab whose new shell has no name yet, so a one-click connect can still be named as it
 * starts. It never takes focus, so typing goes to the shell until the field is clicked.
 */
export function NameBar({ mobile, onSave, onDismiss }: { mobile: boolean; onSave: (label: string) => void; onDismiss: () => void }): ReactElement {
  const [value, setValue] = useState('')
  return (
    <form className={`name-bar ${mobile ? 'mobile' : 'panel'}`} onSubmit={(e) => { e.preventDefault(); onSave(value) }}>
      <Icon.edit className="muted shrink-0" />
      <span className="name-bar-label">Name this session</span>
      <input
        className="input"
        value={value}
        maxLength={40}
        placeholder="e.g. debug or indexing"
        aria-label="Name this session"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onDismiss() }}
      />
      <button type="submit" className="btn btn-primary btn-sm" disabled={!value.trim()}>Save</button>
      {!mobile && <span className="name-bar-hint muted">Shown on the tab and in Sessions; saved on the host.</span>}
      <span className="flex-1" />
      <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Don't name this session" title="Not now (you can name it later from Sessions)" onClick={onDismiss}><Icon.x /></button>
    </form>
  )
}

/** Persistent shells on the host that no tab shows (the app quit, a phone page was lost, a Detach), offered to resume. */
export function DetachedShells({ shells, mobile, onResume, onEnd, onDismiss }: { shells: DetachedShell[]; mobile: boolean; onResume: (name: string) => void; onEnd: (name: string) => void; onDismiss: () => void }): ReactElement {
  return (
    <div className={mobile ? 'm-shells' : 'shells-bar panel border-b px-2 py-1 text-[11px]'} style={mobile ? undefined : { borderColor: 'var(--border)' }}>
      <div className="flex items-center gap-1.5">
        <Icon.layers className="muted shrink-0" />
        <span className="min-w-0 flex-1">{shells.length === 1 ? 'A session from earlier is still running on this host.' : `${shells.length} sessions from earlier are still running on this host.`} Resume replaces this new one.</span>
        <button className="btn btn-ghost btn-sm btn-icon" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}><Icon.x /></button>
      </div>
      {shells.slice(0, 5).map((d) => (
        <div key={d.name} className="shells-row flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate">
            <b className={d.label ? '' : 'muted font-normal italic'}>{d.label || 'Unnamed'}</b>
            <span className="muted"> · {shellWhat(d)}{d.idleSec !== null ? ` · ${idleText(d.idleSec)}` : ''}</span>
            {d.preview ? <span className="mono muted"> · {d.preview}</span> : d.path && <span className="muted"> · in <span className="mono">{d.path}</span></span>}
          </span>
          <button className="btn btn-primary btn-sm" onClick={() => onResume(d.name)}>Resume</button>
          <button className="btn btn-sm" title="End this session on the host" onClick={() => onEnd(d.name)}>End</button>
        </div>
      ))}
    </div>
  )
}

/**
 * The tab's session list (toolbar popover on the desktop, bottom sheet on a phone): every shell kept on the host with
 * its name, who and what runs in it, and its last screen line. A row switches this tab to that shell; the pencil
 * names it, the tab button opens it in a tab of its own, End stops one nobody is showing. A new session can be named
 * as it starts.
 */
export function ShellList({ shells, variant, onSwitch, onNew, onRename, onOpenInTab, onEnd, onShowAll }: {
  shells: HostShell[] | null
  variant: 'menu' | 'sheet'
  /** Tiles every session of the host on one screen; absent where tiles would not fit (a phone). */
  onShowAll?: () => void
  onSwitch: (sh: HostShell) => void
  onNew: (label: string) => void
  onRename: (sh: HostShell, label: string) => void
  onOpenInTab: (sh: HostShell) => void
  onEnd: (sh: HostShell) => void
}): ReactElement {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const startEdit = (sh: HostShell): void => {
    setEditing(sh.name)
    setDraft(sh.label)
  }
  const saveEdit = (sh: HostShell): void => {
    setEditing(null)
    if (draft.trim() !== sh.label) onRename(sh, draft)
  }
  const stop = (e: { stopPropagation: () => void }): void => e.stopPropagation()

  return (
    <div className={`shell-list ${variant}`}>
      {shells === null && <div className="shell-empty muted">Loading the sessions on this host…</div>}
      {onShowAll && shells && shells.length > 1 && (
        <button className="shell-all-btn" onClick={onShowAll}>
          <Icon.grid /> All {shells.length} sessions on one screen
        </button>
      )}
      {shells?.map((sh, i) => (
        <div
          key={sh.name}
          className={`shell-item ${sh.current ? 'current' : ''}`}
          role="button"
          tabIndex={0}
          aria-label={`${sh.label || `Session ${i + 1}`}${sh.current ? ' (this tab)' : ''}`}
          title={sh.current ? undefined : sh.attached ? 'Open elsewhere: switching shows it here and closes it there' : 'Show this session in this tab'}
          onClick={() => { if (editing !== sh.name) onSwitch(sh) }}
          onKeyDown={(e) => { if (e.key === 'Enter' && editing !== sh.name) onSwitch(sh) }}
        >
          <div className="shell-line1">
            <span className="shell-num">{sh.current ? '✓' : i + 1}</span>
            {editing === sh.name ? (
              <input
                autoFocus
                className="input shell-name-input"
                value={draft}
                maxLength={40}
                placeholder="Name this session, e.g. debug"
                aria-label="Session name"
                onClick={stop}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') saveEdit(sh)
                  if (e.key === 'Escape') setEditing(null)
                }}
                onBlur={() => saveEdit(sh)}
              />
            ) : (
              <span className={`shell-name ${sh.label ? '' : 'unnamed'}`}>{sh.label || 'Unnamed session'}</span>
            )}
            {sh.current && <span className="shell-tag">this tab</span>}
            {!sh.current && sh.attached && <span className="shell-tag elsewhere">open elsewhere</span>}
            <span className="flex-1" />
            {editing !== sh.name && (
              <button className="btn btn-ghost btn-sm btn-icon" title={sh.label ? 'Rename' : 'Name this session'} aria-label={`Rename ${sh.label || `session ${i + 1}`}`} onClick={(e) => { stop(e); startEdit(sh) }}>
                <Icon.edit />
              </button>
            )}
            {!sh.current && (
              <button className="btn btn-ghost btn-sm btn-icon" title="Open in a new tab" aria-label={`Open ${sh.label || `session ${i + 1}`} in a new tab`} onClick={(e) => { stop(e); onOpenInTab(sh) }}>
                <Icon.openTab />
              </button>
            )}
            {!sh.current && !sh.attached && (
              <button className="btn btn-ghost btn-sm" title="End this session on the host" onClick={(e) => { stop(e); onEnd(sh) }}>End</button>
            )}
          </div>
          <div className="shell-line2">
            <span className="mono">{shellWhat(sh)}</span>
            {shellWhen(sh) && <span> · {shellWhen(sh)}</span>}
          </div>
          {/* The last screen line usually carries user, host and directory; tmux's directory is the fallback. */}
          {sh.preview ? <div className="shell-preview mono" title={sh.preview}>{sh.preview}</div> : sh.path && <div className="shell-line2">in <span className="mono">{sh.path}</span></div>}
        </div>
      ))}
      <div className="shell-footer">
        {creating ? (
          <form className="shell-new" onSubmit={(e) => { e.preventDefault(); setCreating(false); onNew(newName) }}>
            <input
              autoFocus
              className="input"
              value={newName}
              maxLength={40}
              placeholder="Name (optional), e.g. indexing"
              aria-label="New session name"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') setCreating(false) }}
            />
            <button type="submit" className="btn btn-primary btn-sm">Start</button>
          </form>
        ) : (
          <button className="shell-new-btn" onClick={() => { setNewName(''); setCreating(true) }}>
            <Icon.plus /> New session in this tab…
          </button>
        )}
        <div className="shell-hint muted">The session you switch away from keeps running. Names are saved on the host.</div>
      </div>
    </div>
  )
}

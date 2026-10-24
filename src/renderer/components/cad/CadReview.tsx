import { useState, type ReactElement, type ReactNode } from 'react'
import {
  approvalWarning, formatLength, ISSUE_CATEGORIES, ISSUE_SEVERITIES, nextPin, reviewSummary, verdictLabel,
  type CadFileRecord, type CadIssueRecord, type CadMeasureRecord, type CadNoteRecord, type CheckItem, type CheckStatus, type IssueCategory, type IssueSeverity, type IssueStatus
} from '@shared/cad'
import { newRecordId, type RecordOp } from '@shared/records'
import { applyRecords } from '../../records'
import { useStore } from '../../store'
import { Icon } from '../icons'

/**
 * The review beside the model, after ReviewBench's sidebar but kept: numbered comments pinned to the model, issues
 * with severity and category, the manufacturing checklist with pass / fail / n.a., the measurements, and the file's
 * facts; on top, where the review stands and the verdict. Everything is a 'reviews' record (src/shared/cad.ts), so
 * it is there next time the same file (by content) is opened, and on the other Mac through the data folder.
 */

export type ReviewTab = 'comments' | 'issues' | 'checklist' | 'measure' | 'info'

const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
const put = (item: CadFileRecord | CadNoteRecord | CadIssueRecord | CadMeasureRecord): RecordOp => ({ op: 'put', item: { ...item, updatedAt: Date.now() } })
const save = (ops: RecordOp[]): void => { void applyRecords('reviews', ops).catch((e: Error) => useStore.getState().toast('error', e.message)) }
/** A coordinate difference without "-0.00" for a rounding crumb below zero. */
const delta = (v: number): string => (Math.abs(v) < 0.005 ? 0 : v).toFixed(2)
const ago = (t: number): string => {
  const s = (Date.now() - t) / 1000
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86_400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString()
}

export default function CadReview({ file, notes, issues, measures, tab, onTab, activePin, onGoTo, info }: {
  file: CadFileRecord
  notes: CadNoteRecord[]
  issues: CadIssueRecord[]
  measures: CadMeasureRecord[]
  tab: ReviewTab
  onTab: (t: ReviewTab) => void
  /** The comment whose pin was clicked on the model. */
  activePin: string | null
  onGoTo: (n: CadNoteRecord) => void
  info: ReactNode
}): ReactElement {
  const s = reviewSummary(file, issues, notes)
  // Electron has no window.prompt, so what needs to change is asked for in place.
  const [asking, setAsking] = useState<string | null>(null)
  const setVerdict = (verdict: CadFileRecord['verdict'], note?: string): void => {
    if (verdict === 'approved') {
      const why = approvalWarning(s)
      if (why && !window.confirm(`Approve anyway? ${why}`)) return
    }
    setAsking(null)
    save([put({ ...file, verdict, verdictAt: verdict === 'open' ? undefined : Date.now(), verdictNote: verdict === 'changes' ? note?.trim() || undefined : undefined })])
  }
  const tabs: { id: ReviewTab; label: string; count?: number; tone: string }[] = [
    { id: 'comments', label: 'Comments', count: s.openComments, tone: 'rose' },
    { id: 'issues', label: 'Issues', count: s.openIssues, tone: 'amber' },
    { id: 'checklist', label: 'Checklist', tone: 'emerald' },
    { id: 'measure', label: 'Measure', count: measures.length, tone: 'blue' },
    { id: 'info', label: 'Info', tone: 'violet' }
  ]
  return (
    <aside className="cad-review" aria-label="Review">
      <div className="cad-verdict" data-verdict={file.verdict}>
        <div className="cad-verdict-row">
          <span className="cad-verdict-chip">{file.verdict === 'approved' ? <Icon.check /> : file.verdict === 'changes' ? <Icon.alert /> : <Icon.activity />}{verdictLabel(file.verdict)}</span>
          <span className="flex-1" />
          {file.verdict === 'open'
            ? <>
              <button type="button" className="cad-btn ok" onClick={() => setVerdict('approved')}>Approve</button>
              <button type="button" className="cad-btn warn" aria-expanded={asking !== null} onClick={() => setAsking(asking === null ? '' : null)}>Request changes</button>
            </>
            : <button type="button" className="cad-btn" onClick={() => setVerdict('open')}>Reopen</button>}
        </div>
        {asking !== null && file.verdict === 'open' && (
          <form className="cad-ask" onSubmit={(e) => { e.preventDefault(); setVerdict('changes', asking) }}>
            <textarea className="input" autoFocus rows={2} value={asking} placeholder="What needs to change? (optional)" aria-label="What needs to change"
              onChange={(e) => setAsking(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setAsking(null) }
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); setVerdict('changes', asking) }
              }} />
            <div className="cad-ask-row">
              <span className="flex-1" />
              <button type="button" className="btn btn-sm" onClick={() => setAsking(null)}>Cancel</button>
              <button type="submit" className="btn btn-sm btn-primary">Request changes</button>
            </div>
          </form>
        )}
        <div className="cad-progress" title={`${s.checked} of ${s.total} checks done`}><i style={{ width: `${s.total ? (s.checked / s.total) * 100 : 0}%` }} /></div>
        <p className="cad-verdict-sub">
          {s.checked}/{s.total} checks{s.failed ? ` · ${s.failed} failed` : ''} · {s.openIssues} open issue{s.openIssues === 1 ? '' : 's'}{s.blocking ? ` (${s.blocking} blocking)` : ''} · {s.openComments} open comment{s.openComments === 1 ? '' : 's'}
          {file.verdictNote && <><br /><i>“{file.verdictNote}”</i></>}
        </p>
      </div>
      <nav className="cad-tabs" role="tablist" aria-label="Review">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} data-tone={t.tone} className={tab === t.id ? 'on' : ''} onClick={() => onTab(t.id)}>
            {t.label}{t.count ? <span className="cad-tab-count">{t.count}</span> : null}
          </button>
        ))}
      </nav>
      <div className="cad-tab-body">
        {tab === 'comments' && <Comments file={file} notes={notes} activePin={activePin} onGoTo={onGoTo} />}
        {tab === 'issues' && <Issues file={file} issues={issues} />}
        {tab === 'checklist' && <Checklist file={file} />}
        {tab === 'measure' && <Measures measures={measures} />}
        {tab === 'info' && info}
      </div>
    </aside>
  )
}

// ----- comments -----

function Comments({ file, notes, activePin, onGoTo }: { file: CadFileRecord; notes: CadNoteRecord[]; activePin: string | null; onGoTo: (n: CadNoteRecord) => void }): ReactElement {
  const [draft, setDraft] = useState('')
  const [showResolved, setShowResolved] = useState(true)
  const list = [...notes].sort((a, b) => a.pin - b.pin).filter((n) => showResolved || !n.resolvedAt)
  const addGlobal = (): void => {
    const body = draft.trim()
    if (!body) return
    save([put({ id: newRecordId(), type: 'cadnote', fileId: file.id, pin: nextPin(notes), body, anchor: { kind: 'global' }, createdAt: Date.now(), updatedAt: Date.now() })])
    setDraft('')
  }
  return (
    <div className="cad-list-wrap">
      <div className="cad-list-head">
        <span>{notes.length ? `${notes.length} comment${notes.length === 1 ? '' : 's'}` : 'No comments yet'}</span>
        <span className="flex-1" />
        {notes.some((n) => n.resolvedAt) && <label className="cad-check"><input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />Resolved</label>}
      </div>
      {!notes.length && <p className="cad-hint">{COARSE ? 'Tap the comment tool, then the model, to pin a numbered comment there.' : <>Press <kbd className="kbd">C</kbd> (or the comment tool) and click the model to pin a numbered comment there.</>} The view you see is kept with it.</p>}
      <ul className="cad-list">
        {list.map((n) => (
          <li key={n.id} className={`cad-note ${n.resolvedAt ? 'resolved' : ''} ${activePin === n.id ? 'on' : ''}`} data-note={n.pin}>
            <button type="button" className="cad-pin-badge" title={n.anchor.kind === 'point' ? 'Show it on the model' : 'About the whole file'} onClick={() => onGoTo(n)}>{n.anchor.kind === 'point' ? n.pin : <Icon.comment />}</button>
            <div className="cad-note-body">
              <p>{n.body}</p>
              <span className="cad-note-meta">{n.anchor.kind === 'point' && n.anchor.part ? `${n.anchor.part} · ` : ''}{ago(n.createdAt)}{n.resolvedAt ? ' · resolved' : ''}</span>
              <div className="cad-note-actions">
                <button type="button" onClick={() => save([put({ ...n, resolvedAt: n.resolvedAt ? undefined : Date.now() })])}>{n.resolvedAt ? 'Reopen' : 'Resolve'}</button>
                <button type="button" onClick={() => save([put({ id: newRecordId(), type: 'cadissue', fileId: file.id, title: n.body.slice(0, 140), severity: 'med', category: 'DFM', status: 'open', pin: n.anchor.kind === 'point' ? n.pin : undefined, createdAt: Date.now(), updatedAt: Date.now() })])}>Raise as issue</button>
                <button type="button" className="danger" onClick={() => { if (window.confirm(`Delete comment ${n.pin}?`)) save([{ op: 'delete', id: n.id }]) }}>Delete</button>
              </div>
            </div>
          </li>
        ))}
      </ul>
      <form className="cad-compose" onSubmit={(e) => { e.preventDefault(); addGlobal() }}>
        <textarea className="input" rows={2} value={draft} placeholder="A comment about the whole file…" aria-label="Comment on the file" onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addGlobal() } }} />
        <button type="submit" className="btn btn-sm btn-primary" disabled={!draft.trim()}>Add</button>
      </form>
    </div>
  )
}

// ----- issues -----

const STATUS_NEXT: Record<IssueStatus, IssueStatus> = { open: 'in_progress', in_progress: 'resolved', resolved: 'open' }
const STATUS_WORD: Record<IssueStatus, string> = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved' }

function Issues({ file, issues }: { file: CadFileRecord; issues: CadIssueRecord[] }): ReactElement {
  const [title, setTitle] = useState('')
  const [severity, setSeverity] = useState<IssueSeverity>('med')
  const [category, setCategory] = useState<IssueCategory>('DFM')
  const list = [...issues].sort((a, b) => Number(a.status === 'resolved') - Number(b.status === 'resolved') || ISSUE_SEVERITIES.indexOf(b.severity) - ISSUE_SEVERITIES.indexOf(a.severity) || a.createdAt - b.createdAt)
  const add = (): void => {
    if (!title.trim()) return
    save([put({ id: newRecordId(), type: 'cadissue', fileId: file.id, title: title.trim(), severity, category, status: 'open', createdAt: Date.now(), updatedAt: Date.now() })])
    setTitle('')
  }
  return (
    <div className="cad-list-wrap">
      <div className="cad-list-head"><span>{issues.length} issue{issues.length === 1 ? '' : 's'} · {issues.filter((i) => i.status !== 'resolved').length} open</span></div>
      <ul className="cad-list">
        {list.map((i) => (
          <li key={i.id} className={`cad-issue ${i.status}`} data-severity={i.severity}>
            <i className="cad-sev-dot" />
            <div className="cad-note-body">
              <p>{i.title}</p>
              <span className="cad-note-meta">
                <span className="cad-tag">{i.category}</span>
                <span className="cad-tag sev">{i.severity}</span>
                {i.pin ? <span className="cad-tag">pin {i.pin}</span> : null}
              </span>
              <div className="cad-note-actions">
                <button type="button" title="Open → In progress → Resolved" onClick={() => save([put({ ...i, status: STATUS_NEXT[i.status] })])}>{STATUS_WORD[i.status]} ›</button>
                <select aria-label="Severity" value={i.severity} onChange={(e) => save([put({ ...i, severity: e.target.value as IssueSeverity })])}>{ISSUE_SEVERITIES.map((x) => <option key={x}>{x}</option>)}</select>
                <button type="button" className="danger" onClick={() => { if (window.confirm('Delete this issue?')) save([{ op: 'delete', id: i.id }]) }}>Delete</button>
              </div>
            </div>
          </li>
        ))}
      </ul>
      <form className="cad-compose col" onSubmit={(e) => { e.preventDefault(); add() }}>
        <input className="input" value={title} placeholder="Issue: wall below 1.5 mm at the flange root…" aria-label="New issue" onChange={(e) => setTitle(e.target.value)} />
        <div className="cad-compose-row">
          <select className="input" aria-label="New issue's severity" value={severity} onChange={(e) => setSeverity(e.target.value as IssueSeverity)}>{ISSUE_SEVERITIES.map((x) => <option key={x}>{x}</option>)}</select>
          <select className="input" aria-label="New issue's category" value={category} onChange={(e) => setCategory(e.target.value as IssueCategory)}>{ISSUE_CATEGORIES.map((x) => <option key={x}>{x}</option>)}</select>
          <button type="submit" className="btn btn-sm btn-primary" disabled={!title.trim()}>Add issue</button>
        </div>
      </form>
    </div>
  )
}

// ----- checklist -----

const CHECKS: { id: CheckStatus; label: string }[] = [{ id: 'pass', label: 'Pass' }, { id: 'fail', label: 'Fail' }, { id: 'na', label: 'N/A' }]

function Checklist({ file }: { file: CadFileRecord }): ReactElement {
  const [text, setText] = useState('')
  const set = (next: CheckItem[]): void => save([put({ ...file, checklist: next })])
  const mark = (c: CheckItem, status: CheckStatus): void => {
    set(file.checklist.map((x) => (x.id === c.id ? { ...x, status: x.status === status ? 'pending' : status } : x)))
  }
  const noteOn = (c: CheckItem, note: string): void => {
    if ((c.note ?? '') !== note.trim()) set(file.checklist.map((x) => (x.id === c.id ? { ...x, note: note.trim() || undefined } : x)))
  }
  let cat = ''
  return (
    <div className="cad-list-wrap">
      <ul className="cad-checks">
        {file.checklist.map((c) => {
          const head = c.category !== cat ? (cat = c.category) : ''
          return (
            <li key={c.id} className={`cad-checkrow ${c.status}`}>
              {head && <h4>{head}</h4>}
              <div className="cad-checkline">
                <span className="cad-check-text">{c.text}{c.note && c.status !== 'fail' && <em> — {c.note}</em>}</span>
                <span className="cad-seg" role="radiogroup" aria-label={c.text}>
                  {CHECKS.map((x) => <button key={x.id} type="button" role="radio" aria-checked={c.status === x.id} data-s={x.id} className={c.status === x.id ? 'on' : ''} onClick={() => mark(c, x.id)}>{x.label}</button>)}
                </span>
              </div>
              {c.status === 'fail' && (
                <input key={c.note ?? ''} className="input cad-check-note" defaultValue={c.note ?? ''} placeholder="What fails?" aria-label={`What fails: ${c.text}`}
                  onBlur={(e) => noteOn(c, e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } }} />
              )}
            </li>
          )
        })}
      </ul>
      <form className="cad-compose" onSubmit={(e) => {
        e.preventDefault()
        if (!text.trim()) return
        set([...file.checklist, { id: `c${Date.now().toString(36)}`, text: text.trim(), category: 'Custom', status: 'pending' }])
        setText('')
      }}>
        <input className="input" value={text} placeholder="Add a check…" aria-label="Add a check" onChange={(e) => setText(e.target.value)} />
        <button type="submit" className="btn btn-sm" disabled={!text.trim()}>Add</button>
      </form>
    </div>
  )
}

// ----- measurements -----

function Measures({ measures }: { measures: CadMeasureRecord[] }): ReactElement {
  const [naming, setNaming] = useState<string | null>(null)
  const name = (m: CadMeasureRecord, label: string): void => {
    setNaming(null)
    if ((m.label ?? '') !== label.trim()) save([put({ ...m, label: label.trim() || undefined })])
  }
  return (
    <div className="cad-list-wrap">
      {!measures.length && <p className="cad-hint">{COARSE ? 'Tap the ruler, then two points on the model. A tap near a corner snaps to it;' : <>Press <kbd className="kbd">M</kbd> (or the ruler) and click two points on the model. A click near a corner snaps to it;</>} lengths are in millimetres.</p>}
      <ul className="cad-list">
        {measures.map((m, n) => (
          <li key={m.id} className="cad-measure">
            <span className="cad-measure-n">{n + 1}</span>
            <div className="cad-note-body">
              {naming === m.id
                ? <input className="input cad-check-note" autoFocus defaultValue={m.label ?? ''} placeholder="Name this measurement" aria-label="Measurement name"
                  onBlur={(e) => name(m, e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setNaming(null) } }} />
                : <p><b>{formatLength(m.length)}</b>{m.label ? ` · ${m.label}` : ''}</p>}
              <span className="cad-note-meta">Δ {delta(m.b[0] - m.a[0])}, {delta(m.b[1] - m.a[1])}, {delta(m.b[2] - m.a[2])} mm</span>
              <div className="cad-note-actions">
                <button type="button" onClick={() => setNaming(m.id)}>Name…</button>
                <button type="button" onClick={() => void window.api.invoke('clipboard:write', formatLength(m.length))}>Copy</button>
                <button type="button" className="danger" onClick={() => save([{ op: 'delete', id: m.id }])}>Delete</button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

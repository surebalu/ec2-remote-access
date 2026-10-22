import { useEffect, useRef, useState, type ReactElement } from 'react'
import { cannotKill, type DbAudit, type DbSession, type DbTarget, type LockChain, type LockReport } from '@shared/dbLocks'
import { formatDuration } from '@shared/plmHealth'
import { useStore } from '../../store'
import { Icon } from '../icons'
import Modal from '../Modal'

/**
 * Database locks: on one of the platform's Oracle databases, which sessions block others, what they hold and run, and
 * who waits behind them, read every 15 seconds while open. A blocker can be ended (RDS's kill: its uncommitted work
 * rolls back); production asks for PROD typed, and every attempt goes into History.
 */

const EVERY_MS = 15_000
const ENV_WORD: Record<string, string> = { prod: 'Production', qa: 'QA', dev: 'Development' }
const KEY = 'ui.dblocks.db'
let lastList: DbTarget[] | null = null

const ago = (sec: number | null): string => (sec === null ? '–' : sec < 60 ? `${Math.round(sec)} s` : formatDuration(sec))

export default function DbLocksDialog(): ReactElement | null {
  const req = useStore((s) => s.dbLocksFor)
  const set = useStore((s) => s.set)
  const [list, setList] = useState<DbTarget[] | null>(lastList)
  const [id, setId] = useState<string | null>(null)
  const [report, setReport] = useState<LockReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [live, setLive] = useState(true)
  const [pending, setPending] = useState<{ s: DbSession; waiting: number } | null>(null)
  const [typed, setTyped] = useState('')
  const [killing, setKilling] = useState(false)
  const [history, setHistory] = useState<DbAudit[] | null>(null)
  const busy = useRef(false)

  useEffect(() => {
    void window.api.invoke('db:list').then((l) => {
      lastList = l
      setList(l)
      let saved: string | null = null
      try { saved = localStorage.getItem(KEY) } catch { /* storage unavailable */ }
      const want = req?.id ?? l.find((d) => req?.env && d.env === req.env)?.id ?? saved
      setId((l.find((d) => d.id === want) ?? l.find((d) => !d.problem) ?? l[0])?.id ?? null)
    }, (e: Error) => setError(e.message))
  }, [])

  const target = list?.find((d) => d.id === id) ?? null
  const load = async (): Promise<void> => {
    if (!target || target.problem || busy.current) return
    busy.current = true
    setLoading(true)
    try {
      const r = await window.api.invoke('db:locks', target.id)
      if (useStore.getState().dbLocksFor) { setReport(r); setError(null) }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      busy.current = false
      setLoading(false)
    }
  }
  useEffect(() => {
    setReport(null)
    setError(null)
    setPending(null)
    if (!target) return
    try { localStorage.setItem(KEY, target.id) } catch { /* storage unavailable */ }
    void load()
  }, [id, list])
  useEffect(() => {
    if (!live || !target || pending) return
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') void load() }, EVERY_MS)
    return () => window.clearInterval(t)
  }, [live, id, list, pending])

  if (!req) return null
  const close = (): void => set({ dbLocksFor: null })
  const production = target?.env === 'prod'
  const waiting = report ? report.chains.reduce((n, c) => n + c.waiters.length, 0) : 0
  const kill = async (): Promise<void> => {
    if (!pending || !target) return
    setKilling(true)
    try {
      const r = await window.api.invoke('db:kill', { id: target.id, inst: pending.s.inst, sid: pending.s.sid, serial: pending.s.serial, confirm: production ? typed : undefined })
      useStore.getState().toast('success', r.message)
      setPending(null)
      setTyped('')
      await load()
    } catch (e) {
      useStore.getState().toast('error', (e as Error).message)
    } finally {
      setKilling(false)
    }
  }
  const openHistory = (): void => {
    setHistory([])
    void window.api.invoke('db:history').then(setHistory, () => setHistory([]))
  }

  return (
    <Modal title="Database locks" onClose={close} width="max-w-[1040px]" bare>
      <div className="svc dbl">
        <header className="svc-head">
          <span className="svc-head-icon"><Icon.database /></span>
          <div className="min-w-0 flex-1">
            <h2>Database locks {target && <span className="muted">· {target.id}</span>}{production && <span className="svc-prod">Production</span>}</h2>
            <p className="muted">
              {report
                ? `${report.chains.length ? `${report.chains.length} ${report.chains.length === 1 ? 'session is' : 'sessions are'} blocking ${waiting} ${waiting === 1 ? 'other' : 'others'}` : 'Nothing is blocked'} · ${report.sessions.total} sessions, ${report.sessions.active} active · read ${new Date(report.at).toLocaleTimeString()} through ${report.via}`
                : target?.problem ?? (target ? `Signing in to ${target.id} through ${target.via?.name ?? 'SSM'}…` : 'Finding the databases…')}
            </p>
          </div>
          {history === null
            ? <button type="button" className="btn btn-sm" onClick={openHistory} title="Sessions ended from here, by whom"><Icon.history /> History</button>
            : <button type="button" className="btn btn-sm" onClick={() => setHistory(null)}><Icon.back /> Locks</button>}
          <button type="button" className={`btn btn-sm ${live ? 'btn-on' : ''}`} aria-pressed={live} title={live ? 'Reading every 15 seconds; click to pause' : 'Paused; click to read every 15 seconds'} onClick={() => setLive(!live)}>
            <i className={`dbl-live ${live ? 'on' : ''}`} />{live ? 'Live' : 'Paused'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Read again" title="Read again" onClick={() => void load()} disabled={loading || !target || !!target.problem}><Icon.refresh className={loading ? 'animate-spin' : ''} /></button>
          <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Close dialog" onClick={close}><Icon.x /></button>
        </header>
        {list && list.length > 1 && (
          <div className="dbl-dbs" role="tablist" aria-label="Database">
            {list.map((d) => (
              <button key={d.id} type="button" role="tab" aria-selected={d.id === id} className={d.id === id ? 'on' : ''} onClick={() => setId(d.id)} title={d.problem ?? `${d.engine} · ${d.profile}`}>
                <strong>{d.env ? ENV_WORD[d.env] : d.id}</strong><span className="muted">{d.id}</span>{d.problem && <Icon.alert />}
              </button>
            ))}
          </div>
        )}

        <div className="svc-body">
          {error && <div className="svc-error">{error}</div>}
          {target?.problem && <div className="svc-error">{target.problem}</div>}
          {history !== null ? (
            <History items={history} />
          ) : report && !report.chains.length ? (
            <div className="dbl-clear"><Icon.check /><div><strong>No session is waiting on a lock.</strong><p className="muted">Blocking sessions show here with what they hold and who waits behind them.</p></div></div>
          ) : report ? (
            report.chains.map((c) => <Chain key={`${c.root.inst}:${c.root.sid}`} c={c} onKill={(s) => { setPending({ s, waiting: c.waiters.length }); setTyped('') }} />)
          ) : !error && !target?.problem ? (
            <div className="svc-skel">{[0, 1].map((i) => <div key={i} className="skeleton h-16 rounded-lg" />)}</div>
          ) : null}
        </div>

        {pending && target && (
          <div className="svc-confirm danger" role="alertdialog" aria-label="Confirm">
            <div className="min-w-0 flex-1">
              <strong>End session {pending.s.sid},{pending.s.serial} ({pending.s.user}{pending.s.machine ? ` on ${pending.s.machine}` : ''})?</strong>
              <p className="muted">Its uncommitted work is rolled back and its program loses the connection; the {pending.waiting} {pending.waiting === 1 ? 'session' : 'sessions'} waiting behind it can go on. RDS ends it with rdsadmin_util.kill.</p>
            </div>
            {production && (
              <input className="input svc-type" placeholder="Type PROD" aria-label="Type PROD to confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter' && typed === 'PROD') void kill() }} />
            )}
            <button type="button" className="btn btn-sm" onClick={() => setPending(null)} disabled={killing}>Cancel</button>
            <button type="button" className="btn btn-sm btn-danger" disabled={killing || (production && typed !== 'PROD')} onClick={() => void kill()}>{killing ? 'Ending…' : 'End session'}</button>
          </div>
        )}
      </div>
    </Modal>
  )
}

function Who({ s }: { s: DbSession }): ReactElement {
  return (
    <div className="dbl-who min-w-0">
      <strong className="truncate">{s.user ?? '(no user)'}</strong>
      <span className="muted truncate" title={[s.osUser, s.machine, s.program, s.module].filter(Boolean).join(' · ')}>
        {[s.machine, s.program].filter(Boolean).join(' · ')} · sid {s.sid},{s.serial}{s.inst > 1 ? ` · instance ${s.inst}` : ''}
      </span>
    </div>
  )
}

function Chain({ c, onKill }: { c: LockChain; onKill: (s: DbSession) => void }): ReactElement {
  const r = c.root
  // An idle session holding a transaction open is the classic forgotten commit.
  const idle = r.status === 'INACTIVE' && r.txSince !== null
  const why = cannotKill(r, '')
  const sql = r.sqlText ?? r.prevSqlText
  return (
    <section className="dbl-chain" aria-label={`Blocked by ${r.user ?? r.sid}`}>
      <div className="dbl-root">
        <span className="dbl-badge">Blocking {c.waiters.length}</span>
        <Who s={r} />
        <span className="dbl-state">
          {idle ? <>Idle for {ago(r.lastCallSec)} with a transaction open {r.txSince ? `since ${new Date(r.txSince).toLocaleTimeString()}` : ''}</> : <>{r.status === 'ACTIVE' ? 'Running' : r.status.toLowerCase()} for {ago(r.lastCallSec)}</>}
        </span>
        <button type="button" className="btn btn-sm btn-danger" disabled={!!why} title={why ?? 'End this session so the others can go on'} onClick={() => onKill(r)}>End session…</button>
      </div>
      {r.locked.length > 0 && (
        <div className="dbl-locks">{r.locked.map((l) => <span key={`${l.object}${l.mode}`} className="hp-port" title={l.type}>{l.object} · {l.mode}</span>)}</div>
      )}
      {sql && <pre className="dbl-sql" title={r.sqlText ? 'Running now' : 'Its last statement'}><span className="muted">{r.sqlText ? 'Running' : 'Last statement'}</span>{'\n'}{sql}</pre>}
      <div className="dbl-waiters">
        {c.waiters.map(({ s, depth }) => (
          <div key={`${s.inst}:${s.sid}`} className="dbl-waiter" style={{ paddingLeft: 10 + (depth - 1) * 18 }}>
            <Icon.chevron />
            <Who s={s} />
            <span className="dbl-wait"><b>waiting {ago(s.waitSec)}</b>{s.event ? ` · ${s.event}` : ''}{s.waitObject ? ` on ${s.waitObject}` : ''}</span>
            {s.sqlText && <span className="dbl-wsql mono truncate" title={s.sqlText}>{s.sqlText}</span>}
          </div>
        ))}
      </div>
    </section>
  )
}

function History({ items }: { items: DbAudit[] }): ReactElement {
  if (!items.length) return <p className="muted svc-note">No session has been ended from here.</p>
  return (
    <div className="dbl-hist">
      {items.map((h, i) => (
        <div key={i} className={`svc-row lvl-${h.result === 'done' ? 'ok' : 'crit'}`}>
          <i className="svc-dot" />
          <div className="svc-who min-w-0"><strong className="truncate">{h.db} · sid {h.sid},{h.serial}</strong><span className="muted truncate">{[h.user, h.machine, h.program].filter(Boolean).join(' · ')}</span></div>
          <span className="svc-meta muted">{h.message}</span>
          <span className="svc-meta muted">{h.by} · {new Date(h.at).toLocaleString()}</span>
        </div>
      ))}
    </div>
  )
}

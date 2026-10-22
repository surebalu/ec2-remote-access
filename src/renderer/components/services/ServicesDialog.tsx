import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import {
  catalogOf, unitWord,
  type HostServices, type ServiceAction, type ServiceAudit, type ServiceDef, type ServiceJob, type ServiceStep, type UnitStatus
} from '@shared/services'
import { formatBytes, formatDuration } from '@shared/plmHealth'
import { allInstances, useStore } from '../../store'
import { metaFor } from '../../colors'
import Modal from '../Modal'
import Popover, { MenuItem, MenuSep } from '../Popover'
import { Icon } from '../icons'

/**
 * Service control: the 3DEXPERIENCE services' systemd units on the chosen servers, grouped by service, read live
 * through SSM (main/services.ts). Restart is the main action; Start, Stop and the log are in each row's menu; a service
 * on several servers can be restarted one server at a time, each waiting for its health check before the next.
 * Production asks for PROD to be typed. Jobs run in main, so closing this and coming back shows them still going.
 */

interface Row { def: ServiceDef; host: HostServices; unit: UnitStatus; label: string }
interface Pending { action: ServiceAction; rows: Row[]; rolling: boolean }

/** "42s", "3m", "2d 4h": seconds count while a restart runs. */
const took = (sec: number): string => (sec < 60 ? `${Math.max(0, Math.round(sec))}s` : formatDuration(sec))

const ACTION_WORD: Record<ServiceAction, [string, string]> = { start: ['Start', 'Starting'], stop: ['Stop', 'Stopping'], restart: ['Restart', 'Restarting'] }
const PHASE_WORD: Record<ServiceStep['phase'], string> = {
  waiting: 'Waiting its turn', running: 'Running systemctl…', verifying: 'Waiting for it to be active…', checking: 'Waiting for the health check…',
  done: 'Done', failed: 'Failed', skipped: 'Not started', cancelled: 'Cancelled'
}

export default function ServicesDialog(): ReactElement | null {
  const req = useStore((s) => s.servicesFor)
  const set = useStore((s) => s.set)
  const toast = useStore((s) => s.toast)
  const saved = useStore((s) => s.settings?.serviceCatalog)
  const settings = useStore((s) => s.settings)
  const catalog = useMemo(() => catalogOf(saved), [saved])
  const [hosts, setHosts] = useState<HostServices[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [jobs, setJobs] = useState<ServiceJob[]>([])
  const [pending, setPending] = useState<Pending | null>(null)
  const [verify, setVerify] = useState(true)
  const [typed, setTyped] = useState('')
  const [view, setView] = useState<{ kind: 'list' } | { kind: 'logs'; row: Row; text: string | null; error?: string } | { kind: 'history'; items: ServiceAudit[] | null }>({ kind: 'list' })
  const [menu, setMenu] = useState<{ row: Row; anchor: HTMLElement } | null>(null)
  // Bumped when a job starts, so its progress is polled at once rather than at the idle pace.
  const [kick, setKick] = useState(0)
  const keys = useMemo(() => req?.targets.map((t) => t.key) ?? [], [req])
  const labels = useMemo(() => new Map(req?.targets.map((t) => [t.key, t.label]) ?? []), [req])
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const load = (): void => {
    if (!keys.length) return
    setLoading(true)
    window.api.invoke('services:status', keys).then(
      (h) => { if (alive.current) { setHosts(h); setError(null) } },
      (e: Error) => { if (alive.current) setError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')) }
    ).finally(() => { if (alive.current) setLoading(false) })
  }
  useEffect(load, [keys]) // eslint-disable-line react-hooks/exhaustive-deps

  // Jobs on these servers, this run of the app: polled while one is going, then the states are read again.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined
    const tick = (): void => {
      void window.api.invoke('services:jobs').then((all) => {
        if (!alive.current) return
        const mine = all.filter((j) => j.steps.some((s) => keys.includes(s.key))).slice(0, 3)
        setJobs((prev) => {
          if (prev.some((p) => !p.finishedAt && mine.find((m) => m.id === p.id)?.finishedAt)) load()
          return mine
        })
        t = setTimeout(tick, mine.some((j) => !j.finishedAt) ? 1500 : 6000)
      }, () => { t = setTimeout(tick, 6000) })
    }
    tick()
    return () => { if (t) clearTimeout(t) }
  }, [keys, kick]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!req) return null
  const instances = allInstances(useStore.getState())
  const instOf = (key: string) => instances.find((i) => i.key === key)
  const production = req.env === 'prod' || keys.some((k) => { const i = instOf(k); return !!i && (/prod/i.test(i.profile) || /prod/i.test(metaFor(i.profile, settings).label)) })
  const busy = new Set(jobs.filter((j) => !j.finishedAt).flatMap((j) => j.steps.filter((s) => !['done', 'failed', 'skipped', 'cancelled'].includes(s.phase)).map((s) => `${s.key}|${s.unit}`)))

  const groups: { def: ServiceDef; rows: Row[] }[] = catalog.map((def) => ({
    def,
    rows: (hosts ?? []).flatMap((h) => h.units.filter((u) => def.units.includes(u.unit)).map((u) => ({ def, host: h, unit: u, label: labels.get(h.key) || h.name })))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }) || a.unit.unit.localeCompare(b.unit.unit))
  })).filter((g) => g.rows.length)
  const failed = (hosts ?? []).filter((h) => h.error)
  const empty = (hosts ?? []).filter((h) => !h.error && !h.units.some((u) => catalog.some((d) => d.units.includes(u.unit))))
  const attention = groups.flatMap((g) => g.rows).filter((r) => unitWord(r.unit).level !== 'ok').length

  const ask = (action: ServiceAction, rows: Row[], rolling = false): void => {
    setMenu(null)
    setVerify(action !== 'stop')
    setTyped('')
    setPending({ action, rows, rolling })
  }
  const go = (): void => {
    if (!pending) return
    const p = pending
    setPending(null)
    window.api.invoke('services:run', {
      action: p.action, rolling: p.rolling, verify: verify && p.action !== 'stop',
      targets: p.rows.map((r) => ({ key: r.host.key, unit: r.unit.unit, serviceId: r.def.id, label: r.label }))
    }).then((job) => { setJobs((j) => [job, ...j.filter((x) => x.id !== job.id)]); setKick((k) => k + 1) }, (e: Error) => toast('error', e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')))
  }
  const openLogs = (row: Row): void => {
    setMenu(null)
    setView({ kind: 'logs', row, text: null })
    window.api.invoke('services:logs', row.host.key, row.unit.unit, 300).then(
      (text) => setView((v) => (v.kind === 'logs' && v.row === row ? { ...v, text } : v)),
      (e: Error) => setView((v) => (v.kind === 'logs' && v.row === row ? { ...v, text: '', error: e.message } : v))
    )
  }
  const openHistory = (): void => {
    setView({ kind: 'history', items: null })
    void window.api.invoke('services:history').then((items) => setView((v) => (v.kind === 'history' ? { kind: 'history', items } : v)), () => setView({ kind: 'history', items: [] }))
  }
  const close = (): void => set({ servicesFor: null })
  const now = Date.now()

  return (
    <Modal title="Services" onClose={close} width="max-w-[1040px]" bare>
      <div className="svc">
        <header className="svc-head">
          <span className="svc-head-icon"><Icon.layers /></span>
          <div className="min-w-0 flex-1">
            <h2>Services <span className="muted">· {req.title}</span>{production && <span className="svc-prod">Production</span>}</h2>
            <p className="muted">
              {hosts ? `${hosts.length} ${hosts.length === 1 ? 'server' : 'servers'} · ${groups.reduce((n, g) => n + g.rows.length, 0)} units from systemd, through SSM${attention ? ` · ${attention} not running` : ''}` : 'Reading each server’s systemd units through SSM…'}
            </p>
          </div>
          {view.kind !== 'list' && <button type="button" className="btn btn-sm" onClick={() => setView({ kind: 'list' })}><Icon.back /> Services</button>}
          {view.kind === 'list' && <button type="button" className="btn btn-sm" onClick={openHistory} title="Who did what, and how it went"><Icon.history /> History</button>}
          <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Read again" title="Read the states again" onClick={load} disabled={loading}><Icon.refresh className={loading ? 'animate-spin' : ''} /></button>
          <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Close dialog" onClick={close}><Icon.x /></button>
        </header>

        <div className="svc-body">
          {view.kind === 'logs' && (
            <div className="svc-logs">
              <div className="svc-logs-head">
                <strong>{view.row.unit.unit}</strong><span className="muted">on {view.row.label} · last 300 lines</span><span className="flex-1" />
                <button type="button" className="btn btn-sm" onClick={() => openLogs(view.row)}><Icon.refresh /> Again</button>
                <button type="button" className="btn btn-sm" disabled={!view.text} onClick={() => void window.api.invoke('clipboard:write', view.text ?? '').then(() => toast('success', 'Log copied'))}><Icon.copy /> Copy</button>
              </div>
              {view.error ? <p className="svc-error">{view.error}</p> : <pre className="svc-log">{view.text ?? 'Reading the log…'}</pre>}
            </div>
          )}

          {view.kind === 'history' && (
            <div className="svc-history">
              {view.items === null && <p className="muted">Reading…</p>}
              {view.items?.length === 0 && <p className="muted">Nothing done from this Mac yet.</p>}
              {view.items?.map((h, i) => (
                <div key={i} className={`svc-hist ${h.result}`}>
                  <span className="svc-hist-when" title={new Date(h.at).toLocaleString()}>{new Date(h.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                  <span className="svc-hist-what"><strong>{ACTION_WORD[h.action][0]}</strong> {h.unit} <span className="muted">on {h.name}</span></span>
                  <span className={`svc-pill ${h.result === 'done' ? 'lvl-ok' : h.result === 'failed' ? 'lvl-crit' : 'lvl-off'}`}>{h.result === 'done' ? 'Done' : h.result === 'failed' ? 'Failed' : 'Cancelled'}</span>
                  <span className="muted svc-hist-by" title={h.message}>{h.by} · {took(h.seconds)}</span>
                </div>
              ))}
            </div>
          )}

          {view.kind === 'list' && (
            <>
              {error && <p className="svc-error">{error}</p>}
              {!hosts && !error && <div className="svc-skel">{[0, 1, 2].map((i) => <div key={i} className="hl-skel" />)}</div>}
              {groups.map((g) => (
                <section key={g.def.id} className="svc-group" aria-label={g.def.name}>
                  <div className="svc-group-head">
                    <h3>{g.def.name}</h3>
                    <span className="muted">{g.rows.length} {g.rows.length === 1 ? 'unit' : 'units'}</span>
                    <span className="flex-1" />
                    {g.rows.length > 1 && (
                      <button type="button" className="btn btn-sm" disabled={g.rows.some((r) => busy.has(`${r.host.key}|${r.unit.unit}`))} onClick={() => ask('restart', g.rows, true)}
                        title="Restart each in turn, waiting for its health check before the next: the service stays up behind the load balancer">
                        <Icon.refresh /> Restart all, one at a time
                      </button>
                    )}
                  </div>
                  {g.rows.map((r) => {
                    const w = unitWord(r.unit)
                    const isBusy = busy.has(`${r.host.key}|${r.unit.unit}`)
                    return (
                      <div key={`${r.host.key}|${r.unit.unit}`} className={`svc-row lvl-${w.level}`} data-unit={r.unit.unit} data-host={r.host.key}>
                        <i className="svc-dot" />
                        <div className="svc-who min-w-0">
                          <strong className="truncate">{r.label}</strong>
                          <span className="muted truncate">{r.host.name}{r.host.ip ? ` · ${r.host.ip}` : ''}</span>
                        </div>
                        <code className="svc-unit truncate" title={r.unit.description || r.unit.unit}>{r.unit.unit}</code>
                        <span className={`svc-pill lvl-${w.level}`}>{w.word}</span>
                        <span className="svc-meta muted">
                          {r.unit.since ? `${w.level === 'ok' ? 'up' : 'since'} ${formatDuration((now - r.unit.since) / 1000)}` : ''}
                          {r.unit.memBytes ? ` · ${formatBytes(r.unit.memBytes, 1)}` : ''}
                          {r.unit.enabled && r.unit.enabled !== 'enabled' ? ` · ${r.unit.enabled} at boot` : ''}
                        </span>
                        <div className="svc-acts">
                          {isBusy
                            ? <span className="svc-busy"><Icon.refresh className="animate-spin" /> Working…</span>
                            : (
                              <>
                                <button type="button" className="btn btn-sm" onClick={() => ask(r.unit.active === 'active' ? 'restart' : 'start', [r])}>{r.unit.active === 'active' ? <><Icon.refresh /> Restart</> : <><Icon.play /> Start</>}</button>
                                <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label={`More for ${r.unit.unit} on ${r.label}`} onClick={(e) => setMenu({ row: r, anchor: e.currentTarget })}><Icon.more /></button>
                              </>
                            )}
                        </div>
                      </div>
                    )
                  })}
                </section>
              ))}
              {hosts && !groups.length && !failed.length && <p className="muted svc-note">None of these servers runs a service from Settings → Services.</p>}
              {failed.length > 0 && (
                <section className="svc-group">
                  <div className="svc-group-head"><h3>Could not read</h3><span className="muted">{failed.length}</span></div>
                  {failed.map((h) => <div key={h.key} className="svc-row lvl-off"><i className="svc-dot" /><div className="svc-who min-w-0"><strong className="truncate">{labels.get(h.key) || h.name}</strong><span className="muted truncate">{h.error}</span></div></div>)}
                </section>
              )}
              {empty.length > 0 && <p className="muted svc-note">No service from the list on {empty.map((h) => labels.get(h.key) || h.name).join(', ')}.</p>}
            </>
          )}
        </div>

        {pending && (
          <div className={`svc-confirm ${pending.action === 'stop' ? 'danger' : ''}`} role="alertdialog" aria-label="Confirm">
            <div className="min-w-0 flex-1">
              <strong>
                {ACTION_WORD[pending.action][0]} {pending.rows.length === 1 ? `${pending.rows[0].unit.unit} on ${pending.rows[0].label}` : `${pending.rows[0].def.name} on ${pending.rows.length} servers${pending.rolling ? ', one at a time' : ''}`}?
              </strong>
              <p className="muted">
                {pending.action === 'stop'
                  ? 'Users on this server lose it until it is started again.'
                  : pending.rolling
                    ? 'Each server waits for the one before to be back and passing its health check; the rest stay up behind the load balancer.'
                    : 'Users signed in to this server are disconnected while it restarts.'}
              </p>
              {pending.action !== 'stop' && (
                <label className="svc-check"><input type="checkbox" checked={verify || pending.rolling} disabled={pending.rolling} onChange={(e) => setVerify(e.target.checked)} /> Wait until it is active and its health check passes</label>
              )}
            </div>
            {production && (
              <input className="input svc-type" placeholder="Type PROD" aria-label="Type PROD to confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter' && typed.trim() === 'PROD') go() }} />
            )}
            <button type="button" className="btn" onClick={() => setPending(null)}>Cancel</button>
            <button type="button" className={`btn ${pending.action === 'stop' ? 'btn-danger' : 'btn-primary'}`} disabled={production && typed.trim() !== 'PROD'} onClick={go}>
              {ACTION_WORD[pending.action][0]}{pending.rows.length > 1 ? ` ${pending.rows.length}` : ''}
            </button>
          </div>
        )}

        {jobs.length > 0 && !pending && <Jobs jobs={jobs} now={now} />}
      </div>
      {menu && (
        <Popover anchor={menu.anchor} width={210} onClose={() => setMenu(null)}>
          {menu.row.unit.active === 'active' && <MenuItem onClick={() => ask('restart', [menu.row])}>Restart</MenuItem>}
          {menu.row.unit.active !== 'active' && <MenuItem onClick={() => ask('start', [menu.row])}>Start</MenuItem>}
          {menu.row.unit.active === 'active' && <MenuItem danger onClick={() => ask('stop', [menu.row])}>Stop…</MenuItem>}
          <MenuSep />
          <MenuItem onClick={() => openLogs(menu.row)}>Show the log</MenuItem>
        </Popover>
      )}
    </Modal>
  )
}

function Jobs({ jobs, now }: { jobs: ServiceJob[]; now: number }): ReactElement {
  return (
    <div className="svc-jobs">
      {jobs.map((j) => {
        const done = j.steps.filter((s) => s.phase === 'done').length
        const running = !j.finishedAt
        return (
          <section key={j.id} className={`svc-job ${running ? 'running' : ''}`}>
            <div className="svc-job-head">
              {running ? <Icon.refresh className="animate-spin" /> : j.steps.every((s) => s.phase === 'done') ? <Icon.check /> : <Icon.alert />}
              <strong>{ACTION_WORD[j.action][running ? 1 : 0]}{j.rolling ? ' one at a time' : ''}</strong>
              <span className="muted">{done} of {j.steps.length} done · {took(((j.finishedAt ?? now) - j.startedAt) / 1000)}</span>
              <span className="flex-1" />
              {running && j.steps.length > 1 && <button type="button" className="btn btn-sm" onClick={() => void window.api.invoke('services:cancel', j.id)}>Stop after this one</button>}
            </div>
            {j.steps.map((s) => (
              <div key={`${s.key}|${s.unit}`} className={`svc-step ${s.phase}`}>
                <i className="svc-step-dot" />
                <strong className="truncate">{s.label}</strong>
                <code className="truncate">{s.unit}</code>
                <span className="svc-step-msg" title={s.message}>{s.phase === 'done' || s.phase === 'failed' || s.phase === 'cancelled' || s.phase === 'skipped' ? s.message ?? PHASE_WORD[s.phase] : s.message ?? PHASE_WORD[s.phase]}</span>
                <span className="muted svc-step-time">{s.startedAt ? took(((s.endedAt ?? now) - s.startedAt) / 1000) : ''}</span>
              </div>
            ))}
          </section>
        )
      })}
    </div>
  )
}

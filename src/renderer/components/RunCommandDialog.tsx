import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { Instance, RunState, RunStatus, RunTarget } from '@shared/types'
import { allInstances, useStore } from '../store'
import { groupKeyOf, metaFor } from '../colors'
import { matchesHost } from '@shared/hostSearch'
import { openDefaultFor } from '../quickConnect'
import Modal from './Modal'
import Popover, { MenuItem, MenuLabel } from './Popover'
import { Icon } from './icons'

const LAST_COMMAND = 'ui.runCommand.last'
const TIMEOUTS: [number, string][] = [[60, '1 minute'], [300, '5 minutes'], [600, '10 minutes'], [1800, '30 minutes'], [3600, '1 hour']]
const FINISHED: RunStatus[] = ['success', 'failed', 'timed-out', 'cancelled', 'skipped', 'error']

const canRun = (i: Instance): boolean => !i.manual && i.state === 'running' && i.ssmOnline
const whyNot = (i: Instance): string => (i.manual ? 'Not an AWS instance' : i.state !== 'running' ? `Instance is ${i.state}` : !i.ssmOnline ? 'SSM agent offline' : '')
const readLast = (): string => { try { return localStorage.getItem(LAST_COMMAND) ?? '' } catch { return '' } }

function StatusIcon({ status }: { status: RunStatus }): ReactElement {
  if (status === 'pending' || status === 'running') return <span className="rc-spin" aria-label={status} />
  const cls = status === 'success' ? 'ok' : status === 'skipped' || status === 'cancelled' ? 'muted' : 'err'
  return (
    <span className={`rc-status ${cls}`} aria-label={status}>
      {status === 'success' ? <Icon.check /> : status === 'skipped' || status === 'cancelled' ? <Icon.minus /> : status === 'timed-out' ? <Icon.activity /> : <Icon.x />}
    </span>
  )
}

const statusWord: Record<RunStatus, string> = { pending: 'Sending', running: 'Running', success: 'Succeeded', failed: 'Failed', 'timed-out': 'Timed out', cancelled: 'Cancelled', skipped: 'Skipped', error: 'Not sent' }
const duration = (t: RunTarget): string => (t.startedAt && t.endedAt ? `${Math.max(0.1, (t.endedAt - t.startedAt) / 1000).toFixed(1)} s` : '')

/**
 * Run Command: one command on many hosts through SSM (bash on Linux, PowerShell on Windows). Compose (hosts, command,
 * timeout), then follow each host's result live; finished runs stay under Recent until the app quits.
 */
export default function RunCommandDialog(): ReactElement | null {
  const s = useStore()
  const req = s.runCommandFor
  const instances = allInstances(s)
  const [keys, setKeys] = useState<string[]>(() => req?.keys ?? [])
  const [command, setCommand] = useState(readLast)
  const [timeoutSec, setTimeoutSec] = useState(600)
  const [run, setRun] = useState<RunState | null>(null)
  const [picking, setPicking] = useState(() => (req?.keys.length ?? 0) === 0)
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [view, setView] = useState<'all' | 'failed' | 'success'>('all')
  const [menu, setMenu] = useState<{ kind: 'recent' | 'snippets'; anchor: HTMLElement } | null>(null)
  const [recent, setRecent] = useState<RunState[]>([])
  const [busy, setBusy] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (req?.runId) void window.api.invoke('run:status', req.runId).then((r) => { if (r) setRun(r) })
  }, [req?.runId])
  // Results are asked for, not pushed: a phone that slept through the run still gets them.
  const finished = !!run?.finishedAt
  useEffect(() => {
    if (!run || finished) return
    const t = setInterval(() => void window.api.invoke('run:status', run.id).then((r) => { if (r) setRun(r) }), 1500)
    return () => clearInterval(t)
  }, [run?.id, finished]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (finished && run) {
      const bad = run.targets.filter((t) => t.status === 'failed' || t.status === 'timed-out' || t.status === 'error').length
      const good = run.targets.filter((t) => t.status === 'success').length
      s.toast(bad ? 'error' : 'success', bad ? `Run finished: ${good} succeeded, ${bad} failed` : `Run finished on ${good} host${good === 1 ? '' : 's'}`)
    }
  }, [finished]) // eslint-disable-line react-hooks/exhaustive-deps

  const byKey = useMemo(() => new Map(instances.map((i) => [i.key, i])), [instances])
  const chosen = keys.map((k) => byKey.get(k)).filter((i): i is Instance => !!i)
  const ready = chosen.filter(canRun)
  const blocked = chosen.filter((i) => !canRun(i))
  const linux = ready.filter((i) => i.platform !== 'windows').length
  const windows = ready.length - linux
  const accounts = [...new Set(ready.map(groupKeyOf))]
  const prodLike = accounts.some((a) => /prod/i.test(a) || /prod/i.test(metaFor(a, s.settings).label))

  if (!req) return null
  const close = (): void => s.set({ runCommandFor: null })

  const start = async (targetKeys = ready.map((i) => i.key), cmd = command): Promise<void> => {
    if (!cmd.trim() || !targetKeys.length || busy) return
    const n = targetKeys.length
    if ((n > 10 || prodLike) && !window.confirm(`Run this on ${n} host${n === 1 ? '' : 's'}${prodLike ? ', including production' : ''}?\n\n${cmd.split('\n').slice(0, 4).join('\n')}`)) return
    setBusy(true)
    try {
      try { localStorage.setItem(LAST_COMMAND, cmd) } catch { /* storage off */ }
      const r = await window.api.invoke('run:start', { keys: targetKeys, command: cmd, timeoutSec })
      setRun(r)
      setExpanded(new Set(r.targets.length === 1 ? [r.targets[0].key] : []))
      setView('all')
    } catch (e) {
      s.toast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const compose = (k = keys, cmd = command): void => {
    setRun(null)
    setKeys(k)
    setCommand(cmd)
    setTimeout(() => area.current?.focus(), 0)
  }

  const copyAll = (r: RunState): void => {
    const text = r.targets.map((t) => [`### ${t.name} (${t.instanceId || t.key}): ${statusWord[t.status]}${t.exitCode !== undefined ? `, exit ${t.exitCode}` : ''}`, t.message, t.stdout?.trimEnd(), t.stderr ? `[stderr]\n${t.stderr.trimEnd()}` : ''].filter(Boolean).join('\n')).join('\n\n')
    void window.api.invoke('clipboard:write', text).then(() => s.toast('success', 'Output copied'))
  }

  const head = (title: string, sub: string): ReactElement => (
    <header className="rc-head">
      <span className="rc-head-icon"><Icon.broadcast /></span>
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-[15px] font-semibold tracking-tight">{title}</h3>
        <p className="muted truncate text-[12px]">{sub}</p>
      </div>
      <button className="btn btn-ghost btn-sm" title="Runs from this session" onClick={async (e) => { const a = e.currentTarget; setRecent(await window.api.invoke('run:list')); setMenu({ kind: 'recent', anchor: a }) }}>
        <Icon.activity /> Recent
      </button>
      <button className="btn btn-ghost btn-sm btn-icon" aria-label="Close dialog" onClick={close}><Icon.x /></button>
    </header>
  )

  const recentMenu = menu?.kind === 'recent' && (
    <Popover anchor={menu.anchor} align="right" width={320} onClose={() => setMenu(null)}>
      <MenuLabel>Runs since the app started</MenuLabel>
      {recent.length === 0 && <div className="muted px-3 py-2 text-[12px]">Nothing run yet.</div>}
      {recent.map((r) => {
        const ok = r.targets.filter((t) => t.status === 'success').length
        const bad = r.targets.filter((t) => t.status === 'failed' || t.status === 'timed-out' || t.status === 'error').length
        return (
          <MenuItem key={r.id} onClick={() => { setMenu(null); setRun(r); setExpanded(new Set()) }} hint={new Date(r.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}>
            <span className="mono truncate">{r.command.split('\n')[0]}</span>
            <span className="muted ml-2 text-[11px]">{r.finishedAt ? `${ok}✓${bad ? ` ${bad}✗` : ''}` : 'running'}</span>
          </MenuItem>
        )
      })}
    </Popover>
  )

  // ---------- results ----------
  if (run) {
    const count = (st: RunStatus[]): number => run.targets.filter((t) => st.includes(t.status)).length
    const ok = count(['success'])
    const bad = count(['failed', 'timed-out', 'error'])
    const going = count(['pending', 'running'])
    const skipped = count(['skipped', 'cancelled'])
    const total = run.targets.length
    const shown = run.targets.filter((t) => (view === 'failed' ? ['failed', 'timed-out', 'error'].includes(t.status) : view === 'success' ? t.status === 'success' : true))
    const failedKeys = run.targets.filter((t) => ['failed', 'timed-out', 'error'].includes(t.status)).map((t) => t.key)
    return (
      <Modal title="Run command" onClose={close} width="max-w-[900px]" bare>
        <div className="rc">
          {head(run.command.split('\n')[0], `${total} host${total === 1 ? '' : 's'} · started ${new Date(run.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}${run.finishedAt ? ` · took ${Math.round((run.finishedAt - run.startedAt) / 1000)} s` : ''}`)}
          <div className="rc-summary">
            <div className="rc-bar" aria-hidden="true">
              <span className="ok" style={{ width: `${(ok / total) * 100}%` }} />
              <span className="err" style={{ width: `${(bad / total) * 100}%` }} />
              <span className="muted" style={{ width: `${(skipped / total) * 100}%` }} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rc-chip ok"><Icon.check /> {ok} succeeded</span>
              {bad > 0 && <span className="rc-chip err"><Icon.x /> {bad} failed</span>}
              {going > 0 && <span className="rc-chip run"><span className="rc-spin" /> {going} running</span>}
              {skipped > 0 && <span className="rc-chip muted"><Icon.minus /> {skipped} skipped</span>}
              <span className="flex-1" />
              <div className="seg">
                {(['all', 'failed', 'success'] as const).map((v) => <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>{v === 'all' ? 'All' : v === 'failed' ? 'Failed' : 'Succeeded'}</button>)}
              </div>
            </div>
          </div>
          <div className="rc-results">
            {shown.length === 0 && <div className="muted px-4 py-10 text-center text-[12px]">{view === 'failed' ? 'Nothing failed.' : 'No hosts here yet.'}</div>}
            {shown.map((t) => {
              const open = expanded.has(t.key)
              const m = metaFor(t.profile || 'servers', s.settings)
              const out = [t.stdout?.trimEnd(), t.stderr?.trimEnd()].filter(Boolean).length > 0
              return (
                <div key={t.key} className={`rc-result ${open ? 'open' : ''}`}>
                  <button className="rc-result-head" aria-expanded={open} onClick={() => setExpanded((x) => { const n = new Set(x); if (n.has(t.key)) n.delete(t.key); else n.add(t.key); return n })}>
                    <StatusIcon status={t.status} />
                    <span className="min-w-0 flex-1 text-left">
                      <span className="block truncate font-medium">{t.name}</span>
                      <span className="muted block truncate text-[11px]">{t.message ?? `${statusWord[t.status]}${t.platform === 'windows' ? ' · PowerShell' : ''}`}</span>
                    </span>
                    {t.profile && <span className="rc-acct" data-accent={m.color}><span className="avatar sm">{m.label.slice(0, 2).toUpperCase()}</span>{t.region}</span>}
                    {t.exitCode !== undefined && <span className={`rc-exit ${t.exitCode === 0 ? 'ok' : 'err'}`}>exit {t.exitCode}</span>}
                    <span className="muted w-14 text-right text-[11px] tabular-nums">{duration(t)}</span>
                    <Icon.chevron open={open} />
                  </button>
                  {open && (
                    <div className="rc-output">
                      {!out && !FINISHED.includes(t.status) && <div className="muted text-[11.5px]">Waiting for output…</div>}
                      {!out && FINISHED.includes(t.status) && <div className="muted text-[11.5px]">{t.message ?? 'No output.'}</div>}
                      {t.stdout?.trim() && <pre className="rc-pre">{t.stdout.trimEnd()}</pre>}
                      {t.stderr?.trim() && <pre className="rc-pre err">{t.stderr.trimEnd()}</pre>}
                      <div className="mt-2 flex gap-1.5">
                        {out && <button className="btn btn-sm" onClick={() => void window.api.invoke('clipboard:write', [t.stdout, t.stderr].filter(Boolean).join('\n')).then(() => s.toast('success', 'Output copied'))}><Icon.copy /> Copy</button>}
                        {byKey.get(t.key) && <button className="btn btn-sm" onClick={() => { close(); openDefaultFor(t.key) }}><Icon.terminal /> Connect</button>}
                        {(t.stdout?.length ?? 0) >= 24000 && <span className="muted self-center text-[11px]">SSM keeps the first 24,000 characters of output.</span>}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <footer className="rc-foot">
            {!run.finishedAt ? (
              <button className="btn" onClick={() => void window.api.invoke('run:cancel', run.id)}>Stop the run</button>
            ) : (
              <button className="btn" onClick={() => copyAll(run)}><Icon.copy /> Copy all output</button>
            )}
            <span className="flex-1" />
            {run.finishedAt && failedKeys.length > 0 && <button className="btn" disabled={busy} onClick={() => void start(failedKeys, run.command)}>Retry failed ({failedKeys.length})</button>}
            {run.finishedAt && <button className="btn" onClick={() => compose(run.targets.map((t) => t.key), run.command)}>Edit and run again</button>}
            <button className="btn btn-primary" onClick={close}>Done</button>
          </footer>
        </div>
        {recentMenu}
      </Modal>
    )
  }

  // ---------- compose ----------
  const q = filter.trim()
  const pickable = instances.filter((i) => !i.manual).filter((i) => !q || matchesHost(i, q)).sort((a, b) => groupKeyOf(a).localeCompare(groupKeyOf(b)) || a.name.localeCompare(b.name))
  const toggle = (k: string): void => setKeys((x) => (x.includes(k) ? x.filter((y) => y !== k) : [...x, k]))
  const snippets = s.settings?.snippets ?? []
  return (
    <Modal title="Run command" onClose={close} width="max-w-[820px]" bare>
      <div className="rc">
        {head('Run command', 'Runs on each host through SSM Run Command: bash on Linux, PowerShell on Windows.')}
        <div className="rc-body">
          <div className="rc-label">Hosts</div>
          <div className="rc-targets">
            <div className="rc-targets-line">
              <span className="rc-count">{ready.length}</span>
              <span className="min-w-0 flex-1">
                <span className="font-medium">host{ready.length === 1 ? '' : 's'} will run it</span>
                <span className="muted text-[12px]">
                  {ready.length > 0 && ` · ${[linux && `${linux} Linux`, windows && `${windows} Windows`].filter(Boolean).join(', ')}`}
                  {blocked.length > 0 && ` · ${blocked.length} can’t (stopped, offline or not AWS)`}
                </span>
              </span>
              <span className="flex -space-x-1.5">
                {accounts.slice(0, 5).map((a) => { const m = metaFor(a, s.settings); return <span key={a} data-accent={m.color} title={m.label}><span className="avatar sm ring-2 ring-[var(--panel)]">{m.label.slice(0, 2).toUpperCase()}</span></span> })}
              </span>
              <button className="btn btn-sm" onClick={() => setPicking(!picking)}>{picking ? 'Done' : 'Choose…'}</button>
            </div>
            {picking && (
              <div className="rc-picker">
                <div className="flex items-center gap-1.5 p-2">
                  <div className="relative flex-1">
                    <span className="muted pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2"><Icon.search /></span>
                    <input className="input !pl-8" autoFocus={!keys.length} placeholder="Filter by name, IP, account, tag…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter hosts" />
                  </div>
                  <button className="btn btn-sm" onClick={() => setKeys((x) => [...new Set([...x, ...pickable.filter(canRun).map((i) => i.key)])])}>Select shown</button>
                  <button className="btn btn-sm" onClick={() => setKeys((x) => x.filter((k) => !pickable.some((i) => i.key === k)))}>Clear shown</button>
                </div>
                <div className="rc-picker-list">
                  {pickable.map((i) => {
                    const m = metaFor(groupKeyOf(i), s.settings)
                    const ok = canRun(i)
                    return (
                      <label key={i.key} className={`rc-pick ${ok ? '' : 'off'}`} title={ok ? '' : whyNot(i)}>
                        <input type="checkbox" disabled={!ok && !keys.includes(i.key)} checked={keys.includes(i.key)} onChange={() => toggle(i.key)} />
                        <span data-accent={m.color}><span className="avatar sm">{m.label.slice(0, 2).toUpperCase()}</span></span>
                        <span className="min-w-0 flex-1 truncate">{i.name}</span>
                        <span className="muted text-[11px]">{ok ? (i.platform === 'windows' ? 'Windows' : i.osHint || 'Linux') : whyNot(i)}</span>
                      </label>
                    )
                  })}
                  {pickable.length === 0 && <div className="muted px-3 py-6 text-center text-[12px]">No hosts match.</div>}
                </div>
              </div>
            )}
          </div>
          <div className="rc-label mt-4">Command</div>
          <textarea
            ref={area}
            className="input mono rc-command"
            autoFocus={!!keys.length}
            spellCheck={false}
            placeholder={windows && !linux ? 'Get-Service | Where-Object Status -eq Running' : 'uptime && df -h /'}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void start() } }}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button className="btn btn-sm" disabled={!snippets.length} title={snippets.length ? 'Insert a saved snippet' : 'No snippets saved yet (Settings → Terminal)'} onClick={(e) => setMenu({ kind: 'snippets', anchor: e.currentTarget })}><Icon.snippet /> Snippets</button>
            <label className="muted flex items-center gap-1.5 text-[12px]">
              Stop after
              <select className="input !h-7 w-32" value={timeoutSec} onChange={(e) => setTimeoutSec(Number(e.target.value))}>
                {TIMEOUTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <span className="flex-1" />
            <span className="muted text-[11px]">Runs as root (SYSTEM on Windows). ⌘↵ to run.</span>
          </div>
        </div>
        <footer className="rc-foot">
          <span className="muted text-[11px]">Needs ssm:SendCommand in each account.</span>
          <span className="flex-1" />
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !command.trim() || !ready.length} onClick={() => void start()}>
            <Icon.play /> {busy ? 'Sending…' : `Run on ${ready.length} host${ready.length === 1 ? '' : 's'}`}
          </button>
        </footer>
      </div>
      {recentMenu}
      {menu?.kind === 'snippets' && (
        <Popover anchor={menu.anchor} width={300} onClose={() => setMenu(null)}>
          <MenuLabel>Insert a snippet</MenuLabel>
          {snippets.map((sn) => (
            <MenuItem key={sn.id} onClick={() => { setMenu(null); setCommand((c) => (c.trim() ? `${c.trimEnd()}\n${sn.command}` : sn.command)); area.current?.focus() }}>
              <span className="truncate">{sn.name}</span>
            </MenuItem>
          ))}
        </Popover>
      )}
    </Modal>
  )
}

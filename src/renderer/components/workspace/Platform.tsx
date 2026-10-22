import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { ago, ENV_NAMES, type PlmEnvId, type PlmHealthSnapshot } from '@shared/plmHealth'
import { healthIsStale } from '@shared/workspaceSummary'
import { useStore } from '../../store'
import { mayPoll } from '../health/poll'
import { Icon } from '../icons'

type Reading = { snap: PlmHealthSnapshot | null; error: string | null }
let cached: Reading = { snap: null, error: null }

/** Poll only while this module is visible. Keep the last reading, but explicitly mark failures and aging data. */
export default function Platform({ now, active }: { now: number; active: boolean }): ReactElement {
  const [reading, setReading] = useState(cached)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const mounted = useRef(false)
  const load = useCallback(async (): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    try { cached = { snap: await window.api.invoke('health:snapshot'), error: null } }
    catch (e) { cached = { snap: cached.snap, error: (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') } }
    finally {
      pending.current = false
      if (mounted.current) { setReading(cached); setBusy(false) }
    }
  }, [])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (!active) return
    if (!cached.snap || cached.error || Date.now() - cached.snap.at > 60_000) void load()
    const timer = setInterval(() => { if (mayPoll()) void load() }, 120_000)
    return () => clearInterval(timer)
  }, [active, load])
  const open = (env?: PlmEnvId): void => {
    if (env) {
      try { localStorage.setItem('ui.health.env', env) } catch { /* storage unavailable */ }
      window.dispatchEvent(new CustomEvent('ec2ra:health-env', { detail: env }))
    }
    useStore.getState().openTool('health')
  }
  const stale = healthIsStale(reading.snap?.at, reading.error, now)
  return <section className="hd-card ws-platform" aria-label="Platform health">
    <div className="hd-card-head"><span><Icon.health />Platform health</span><span className="ws-platform-controls">
      <span>{reading.snap ? `${stale ? 'Last known · ' : 'Updated '}${ago(reading.snap.at, now)}` : '3DEXPERIENCE'}</span>
      <button className="btn btn-sm" disabled={busy} onClick={() => void load()}>{busy ? 'Refreshing…' : 'Refresh health'}</button>
    </span></div>
    {(reading.error || (reading.snap && stale)) && <p className="ws-stale" role="status"><Icon.alert />{reading.error ? `Refresh failed: ${reading.error}.${reading.snap ? ' Showing the last known reading.' : ''}` : 'This reading is more than 3 minutes old. Refresh before relying on its status.'}</p>}
    {reading.snap?.envs.length ? <div className="ws-environments">
      {reading.snap.envs.map((e) => <button key={e.id} className={`ws-environment lvl-${stale ? 'unknown' : e.level}`} onClick={() => open(e.id)}>
        <span className="ws-env-label"><i />{ENV_NAMES[e.id] ?? e.name}<b>{stale ? 'Stale' : e.level === 'ok' ? 'Healthy' : e.level === 'crit' ? 'Critical' : e.level === 'warn' ? 'Warning' : 'Unknown'}</b></span>
        <strong>{e.headline}</strong><small>{stale ? 'Last known status · ' : ''}{e.issues.filter((i) => i.level === 'crit' || i.level === 'warn').length} issues · Open health details →</small>
      </button>)}
    </div> : <p className="ws-empty">{busy ? 'Reading service health…' : reading.error ? 'No health reading is available yet.' : 'No environments reported.'}</p>}
    <div className="ws-platform-footer"><span>Service health is separate from host connection routes.</span><button className="ws-text-action" onClick={() => open()}>Open full Health view →</button></div>
  </section>
}

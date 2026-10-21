import { useEffect, useMemo, useState, type ReactElement } from 'react'
import {
  GC_RANGES, ago, formatBytes, formatDuration, formatPct, levelOf, memoryChange, signedInPeople,
  type KernelHealth, type KernelMemoryHistory, type KernelMemorySeries, type KernelServer, type PlmEnvId
} from '@shared/plmHealth'
import { Icon } from '../icons'
import { Bar, Dot, Empty, Pill, SectionHead, Spark, lvl } from './parts'
import KernelChart, { type KernelLine } from './KernelChart'

/**
 * Each 3DSpace server's ENOVIA kernel, read live from its MBeans (Jolokia): who is signed in, the C++ kernel's own
 * memory, contexts, database connections and exceptions; the kernel's memory over time where its enovia_kernel_*
 * metrics are recorded in Prometheus; plus the day's sign-ins from the servers' own log in Loki, and the license
 * server check.
 */

const seen = new Map<PlmEnvId, KernelHealth>()
const seenMem = new Map<string, KernelMemoryHistory>()
const HOURS_KEY = 'ui.health.kernelHours'
const readHours = (): number => { try { const n = Number(localStorage.getItem(HOURS_KEY)); return GC_RANGES.some((r) => r.hours === n) ? n : 24 } catch { return 24 } }

/** The kernel's memory over the chosen window, every minute while on screen (15 s for the last hour). */
function useKernelMemory(env: PlmEnvId, hours: number, active: boolean): KernelMemoryHistory | null {
  const key = `${env}|${hours}`
  const [d, setD] = useState<KernelMemoryHistory | null>(seenMem.get(key) ?? null)
  useEffect(() => {
    setD(seenMem.get(key) ?? null)
    let gone = false
    const load = (): void => {
      window.api.invoke('health:kernelMemory', env, hours).then((x) => { seenMem.set(key, x); if (!gone) setD(x) }, () => undefined)
    }
    if (active) load()
    const t = setInterval(() => { if (active && document.visibilityState === 'visible') load() }, hours <= 1 ? 15_000 : 60_000)
    return () => { gone = true; clearInterval(t) }
  }, [key, active]) // eslint-disable-line react-hooks/exhaustive-deps
  return d
}

/** The kernel reading for an environment, every 30 s while on screen; shared by the banner and the panel. */
export function useKernel(env: PlmEnvId, active: boolean): { d: KernelHealth | null; error: string | null } {
  const [d, setD] = useState<KernelHealth | null>(seen.get(env) ?? null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setD(seen.get(env) ?? null)
    let gone = false
    const load = (): void => {
      window.api.invoke('health:kernel', env).then(
        (x) => { seen.set(env, x); if (!gone) { setD(x); setError(null) } },
        (e: Error) => { if (!gone) setError(e.message) }
      )
    }
    if (active) load()
    const t = setInterval(() => { if (active && document.visibilityState === 'visible') load() }, 30_000)
    return () => { gone = true; clearInterval(t) }
  }, [env, active])
  return { d, error }
}

export default function KernelPanel({ env, active, d, error }: { env: PlmEnvId; active: boolean; d: KernelHealth | null; error: string | null }): ReactElement {
  const [hours, setHours] = useState(readHours)
  const mem = useKernelMemory(env, hours, active)
  const pick = (h: number): void => { setHours(h); try { localStorage.setItem(HOURS_KEY, String(h)) } catch { /* storage off */ } }
  const { people, onMany } = signedInPeople(d?.servers ?? [])
  const n = people.length
  return (
    <>
      <SectionHead id="hl-kernel" icon={<Icon.layers />} title="3DSpace kernel and sign-ins"
        sub={d ? `${n} ${n === 1 ? 'person' : 'people'} signed in now${onMany ? ` (${onMany} on more than one server, counted once)` : ''} · read live from each server's kernel` : 'Read live from each server\'s kernel'} />
      {!d && !error && <div className="hl-kernel-grid">{[0, 1].map((i) => <div key={i} className="hl-card hl-skel" style={{ height: 260 }} />)}</div>}
      {!d && error && <Empty>{error}</Empty>}
      {d && (
        <div className="hl-kernel-grid">
          {d.servers.map((s) => <KernelCard key={s.ip} s={s} start={d.start} step={d.step} mem={mem} hours={hours} onHours={pick} />)}
          {d.license && <LicenseCard l={d.license} />}
          {d.gaps.map((g) => <Empty key={g}>{g}</Empty>)}
        </div>
      )}
    </>
  )
}

function KernelCard({ s, start, step, mem, hours, onHours }: { s: KernelServer; start: number; step: number; mem: KernelMemoryHistory | null; hours: number; onHours: (h: number) => void }): ReactElement {
  if (!s.reachable) {
    return (
      <article className={`hl-card hl-kernel ${lvl(s.level)}`}>
        <div className="hl-card-head"><h4>3DSpace {s.label}</h4><span className="hl-card-sub">{s.name}</span><span className="flex-1" /><Pill level={s.level}>No answer</Pill></div>
        <p className="hl-card-note">{s.error}</p>
      </article>
    )
  }
  const peakAt = s.usersSpark && s.usersPeak !== null && s.usersPeak !== undefined ? s.usersSpark.lastIndexOf(s.usersPeak) : -1
  const kernelPct = s.allocatedBytes !== null && s.highwaterBytes ? (s.allocatedBytes / s.highwaterBytes) * 100 : null
  const others = [...s.service.map((u) => ({ u, kind: 'service' })), ...s.system.map((u) => ({ u, kind: 'system' }))]
  return (
    <article className={`hl-card hl-kernel ${lvl(s.level)}`}>
      <div className="hl-card-head">
        <h4>3DSpace {s.label}</h4>
        <span className="hl-card-sub">{s.name}</span>
        {s.version && <span className="hl-chip" title="3DEXPERIENCE release">{s.version}</span>}
        <span className="flex-1" />
        <Pill level={s.level}>{s.level === 'ok' ? 'Healthy' : undefined}</Pill>
      </div>
      <div className="hl-signed">
        <div className="hl-signed-now">
          <span className="hl-big">{s.people.length}</span>
          <span className="hl-unit">{s.people.length === 1 ? 'person' : 'people'} signed in</span>
          {others.length > 0 && <span className="hl-unit">+ {[s.service.length && `${s.service.length} service`, s.system.length && `${s.system.length} system`].filter(Boolean).join(' · ')}</span>}
        </div>
        <div className="hl-signed-chart">
          <span className="hl-mini-label">Sessions over the last 24 h{s.usersPeak !== null && s.usersPeak !== undefined ? ` · peak ${s.usersPeak}${peakAt >= 0 ? ` at ${new Date(start + peakAt * step * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : ''}` : ''}</span>
          <Spark values={s.usersSpark} min={0} height={44} />
        </div>
      </div>
      <div className="hl-users">
        {s.people.map((u) => <span key={u} className="hl-user"><i />{u}</span>)}
        {others.map(({ u, kind }) => <span key={u} className={`hl-user ${kind}`} title={kind === 'system' ? "The kernel's own session" : 'A service account'}>{u}<em>{kind}</em></span>)}
        {!s.people.length && !others.length && <span className="muted">Nobody signed in.</span>}
      </div>
      <KernelMemory s={s} series={mem?.servers.find((x) => x.ip === s.ip) ?? null} mem={mem} hours={hours} onHours={onHours} kernelPct={kernelPct} />
      <div className="hl-gc-kpis">
        <div className="hl-stat"><span className="hl-stat-label">Contexts</span><span className="hl-stat-value">{s.contexts ?? '–'}</span></div>
        <div className={`hl-stat ${s.dbExceeded ? 'lvl-warn' : ''}`}><span className="hl-stat-label">DB connections</span><span className="hl-stat-value">{s.dbConnections ?? '–'}{s.dbExceeded ? ` · ${s.dbExceeded} over` : ''}</span></div>
        <div className="hl-stat"><span className="hl-stat-label">Exceptions</span><span className="hl-stat-value">{s.exceptions?.toLocaleString() ?? '–'}</span></div>
        <div className="hl-stat"><span className="hl-stat-label">Kernel up for</span><span className="hl-stat-value">{formatDuration(s.uptimeSec)}</span></div>
      </div>
    </article>
  )
}

/** The kernel's memory now, and over the chosen window where Prometheus records it. */
function KernelMemory({ s, series, mem, hours, onHours, kernelPct }: {
  s: KernelServer; series: KernelMemorySeries | null; mem: KernelMemoryHistory | null; hours: number; onHours: (h: number) => void; kernelPct: number | null
}): ReactElement {
  const lines = useMemo<KernelLine[]>(() => (series ? [
    { key: 'allocated', label: 'In use', values: series.allocated },
    { key: 'reserved', label: 'Held', values: series.reserved },
    { key: 'highwater', label: 'Peak since start', values: series.highwater }
  ] : []), [series])
  const stepMs = (mem?.step ?? 60) * 1000
  const lastRestart = series?.restarts.at(-1) ?? null
  const change = series && mem ? memoryChange(series.allocated, mem.start, stepMs, lastRestart) : null
  const when = (t: number): string => {
    const d = new Date(t)
    return d.toDateString() === new Date().toDateString()
      ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }
  let story = ''
  if (change) {
    const pct = change.from ? ((change.to - change.from) / change.from) * 100 : 0
    const since = lastRestart !== null && change.at >= lastRestart ? `since the restart at ${when(change.at)}` : `since ${when(change.at)}`
    story = Math.abs(pct) < 2
      ? `In use held steady around ${formatBytes(change.to)} ${since} (${formatBytes(change.min)} to ${formatBytes(change.max)}).`
      : `In use went from ${formatBytes(change.from)} to ${formatBytes(change.to)} (${pct > 0 ? '+' : ''}${pct.toFixed(0)}%) ${since}; lowest ${formatBytes(change.min)}, highest ${formatBytes(change.max)}.`
  }
  return (
    <div className="hl-kernel-mem">
      <div className="hl-kernel-mem-top">
        <div className="hl-kernel-mem-head">
          <span className="hl-stat-label">Kernel memory (C++)</span>
          <span className="hl-stat-value">{formatBytes(s.allocatedBytes)} <span className="muted">in use · {formatBytes(s.reservedBytes)} held · peak {formatBytes(s.highwaterBytes)}</span></span>
        </div>
        {series && (
          <div className="hl-seg sm" role="group" aria-label="Kernel memory time range">
            {GC_RANGES.map((r) => <button key={r.hours} type="button" className={r.hours === hours ? 'on' : ''} aria-pressed={r.hours === hours} onClick={() => onHours(r.hours)}>{r.label}</button>)}
          </div>
        )}
      </div>
      {series && mem ? (
        <>
          <div className="hl-legend tight">
            <span><i className="sw k-allocated" />In use</span>
            <span><i className="sw k-reserved" />Held</span>
            <span><i className="sw k-highwater" />Peak since start</span>
            {series.restarts.length > 0 && <span><i className="sw restart" />Restart</span>}
          </div>
          <KernelChart start={mem.start} step={mem.step} hours={mem.hours} lines={lines} restarts={series.restarts} height={180}
            extra={(i) => [
              ...(series.contexts[i] !== null ? [{ label: 'Contexts', value: String(Math.round(series.contexts[i]!)) }] : []),
              ...(series.users[i] !== null ? [{ label: 'Active users', value: String(Math.round(series.users[i]!)) }] : [])
            ]} />
          <span className="hl-metric-note">{story || 'Not enough readings in this window yet.'}{s.limitBytes ? ` Limit ${formatBytes(s.limitBytes, 0)}.` : ''}</span>
        </>
      ) : (
        <>
          <Bar pct={kernelPct} level="ok" />
          <span className="hl-metric-note">{formatPct(kernelPct)} of its peak since start{s.limitBytes ? ` · limit ${formatBytes(s.limitBytes, 0)}` : ''}. {mem ? 'No history for this server: Prometheus has no enovia_kernel_* metrics for it.' : 'Reading its history…'}</span>
        </>
      )}
    </div>
  )
}

function LicenseCard({ l }: { l: NonNullable<KernelHealth['license']> }): ReactElement {
  return (
    <article className={`hl-card hl-license ${lvl(l.level)}`}>
      <div className="hl-card-head">
        <h4>License server</h4>
        <span className="hl-card-sub">DSLS {l.version}</span>
        <span className="flex-1" />
        <Pill level={l.level}>{l.status.toLowerCase().replace(/^./, (c) => c.toUpperCase())}</Pill>
      </div>
      <p className="hl-card-note">{[l.type && l.type.toLowerCase(), l.offline && `offline licenses ${l.offline.toLowerCase()}`].filter(Boolean).join(' · ')}. Checked {ago(l.at, Date.now())}; the same servers serve every environment.</p>
      <div className="hl-license-nodes">
        {l.nodes.map((n) => (
          <div key={n.host} className="hl-row">
            <Dot level={n.rttMs !== null ? levelOf(n.rttMs, [200, 1000]) : 'unknown'} />
            <span className="min-w-0 flex-1 truncate" title={`${n.host} · ${n.ip}:${n.port}`}>{n.host.split('.')[0]}</span>
            <span className="hl-chk-num">{n.rttMs === null ? '–' : `${n.rttMs} ms`}</span>
          </div>
        ))}
      </div>
    </article>
  )
}

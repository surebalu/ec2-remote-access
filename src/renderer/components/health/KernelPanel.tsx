import { useEffect, useState, type ReactElement } from 'react'
import { ago, formatBytes, formatDuration, formatPct, levelOf, type KernelHealth, type KernelServer, type PlmEnvId } from '@shared/plmHealth'
import { Icon } from '../icons'
import { Bar, Dot, Empty, Pill, SectionHead, Spark, lvl } from './parts'

/**
 * Each 3DSpace server's ENOVIA kernel, read live from its MBeans (Jolokia): who is signed in, the C++ kernel's own
 * memory (Prometheus does not record it), contexts, database connections and exceptions; plus the day's sign-ins from
 * the servers' own log in Loki, and the license server check.
 */

const seen = new Map<PlmEnvId, KernelHealth>()

export default function KernelPanel({ env, active }: { env: PlmEnvId; active: boolean }): ReactElement {
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

  const people = d?.servers.reduce((n, s) => n + s.people.length, 0) ?? 0
  return (
    <>
      <SectionHead id="hl-kernel" icon={<Icon.layers />} title="3DSpace kernel and sign-ins" sub={d ? `${people} ${people === 1 ? 'person' : 'people'} signed in now · read live from each server's kernel` : 'Read live from each server\'s kernel'} />
      {!d && !error && <div className="hl-kernel-grid">{[0, 1].map((i) => <div key={i} className="hl-card hl-skel" style={{ height: 260 }} />)}</div>}
      {!d && error && <Empty>{error}</Empty>}
      {d && (
        <div className="hl-kernel-grid">
          {d.servers.map((s) => <KernelCard key={s.ip} s={s} start={d.start} step={d.step} />)}
          {d.license && <LicenseCard l={d.license} />}
          {d.gaps.map((g) => <Empty key={g}>{g}</Empty>)}
        </div>
      )}
    </>
  )
}

function KernelCard({ s, start, step }: { s: KernelServer; start: number; step: number }): ReactElement {
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
      <div className="hl-kernel-mem">
        <div className="hl-kernel-mem-head">
          <span className="hl-stat-label">Kernel memory (C++)</span>
          <span className="hl-stat-value">{formatBytes(s.allocatedBytes)} <span className="muted">in use · {formatBytes(s.reservedBytes)} held · peak {formatBytes(s.highwaterBytes)}</span></span>
        </div>
        <Bar pct={kernelPct} level="ok" />
        <span className="hl-metric-note">{formatPct(kernelPct)} of its peak since start{s.limitBytes ? ` · limit ${formatBytes(s.limitBytes, 0)}` : ''}. Not recorded by Prometheus, so there is no history yet.</span>
      </div>
      <div className="hl-gc-kpis">
        <div className="hl-stat"><span className="hl-stat-label">Contexts</span><span className="hl-stat-value">{s.contexts ?? '–'}</span></div>
        <div className={`hl-stat ${s.dbExceeded ? 'lvl-warn' : ''}`}><span className="hl-stat-label">DB connections</span><span className="hl-stat-value">{s.dbConnections ?? '–'}{s.dbExceeded ? ` · ${s.dbExceeded} over` : ''}</span></div>
        <div className="hl-stat"><span className="hl-stat-label">Exceptions</span><span className="hl-stat-value">{s.exceptions?.toLocaleString() ?? '–'}</span></div>
        <div className="hl-stat"><span className="hl-stat-label">Kernel up for</span><span className="hl-stat-value">{formatDuration(s.uptimeSec)}</span></div>
      </div>
    </article>
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

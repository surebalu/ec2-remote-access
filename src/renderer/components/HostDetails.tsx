import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { HostHealth, Instance } from '@shared/types'
import { allInstances, routeOf, useStore } from '../store'
import { groupKeyOf, metaFor } from '../colors'
import { openDefaultFor, openFilesFor } from '../quickConnect'
import { Icon } from './icons'

function ago(iso?: string): string | undefined {
  if (!iso) return undefined
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 90) return `${Math.max(s, 0)} s ago`
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  if (s < 172_800) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86_400)} days ago`
}

const checkBadge = (v?: string): string => (v === 'ok' ? 'badge-ok' : v === 'impaired' ? 'badge-err' : v ? 'badge-warn' : 'badge-neutral')

/** 5-minute CPU averages as a small line chart; the y axis is fixed at 0–100% so hosts compare at a glance. */
function Sparkline({ points }: { points: { t: number; v: number }[] }): ReactElement {
  const w = 280
  const h = 44
  if (points.length < 2) return <p className="muted text-[11px]">Not enough CPU data yet.</p>
  const t0 = points[0].t
  const span = points.at(-1)!.t - t0 || 1
  const xy = points.map((p) => [((p.t - t0) / span) * w, h - (Math.min(100, p.v) / 100) * (h - 2) - 1] as const)
  const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const peak = Math.max(...points.map((p) => p.v))
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="spark" role="img" aria-label={`CPU over the last 3 hours, peak ${peak.toFixed(0)}%`} preserveAspectRatio="none">
      <line x1="0" x2={w} y1={h / 2} y2={h / 2} className="spark-grid" />
      <polygon points={`0,${h} ${line} ${w},${h}`} className="spark-fill" />
      <polyline points={line} className="spark-line" />
    </svg>
  )
}

function HealthSection({ i }: { i: Instance }): ReactElement | null {
  const [health, setHealth] = useState<HostHealth | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    window.api.invoke('ec2:health', i.key).then(setHealth, (e: Error) => setError(e.message)).finally(() => setLoading(false))
  }, [i.key])
  useEffect(() => {
    setHealth(null)
    if (!i.manual && !i.staleReason) load()
  }, [i.key]) // eslint-disable-line react-hooks/exhaustive-deps
  if (i.manual) return null
  const cpuNow = health?.cpu.at(-1)?.v
  const ping = ago(health?.ssmLastPing ?? i.ssmLastPing)
  return (
    <div className="panel-2 mb-4 rounded-lg border border-default p-3 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 font-semibold"><Icon.activity /> Health</span>
        <button className="btn btn-ghost btn-sm btn-icon" title="Refresh" disabled={loading} onClick={load}><Icon.refresh className={loading ? 'animate-spin' : ''} /></button>
      </div>
      {error && <p className="break-words" style={{ color: 'var(--err)' }}>{error}</p>}
      {!health && !error && <p className="muted">{loading ? 'Loading status checks and CPU…' : 'Health is fetched live from AWS; refresh to load.'}</p>}
      {health && (
        <>
          <div className="flex flex-wrap gap-1.5">
            <span className={`badge ${checkBadge(health.instanceStatus)}`} title="EC2 instance status check">Instance: {health.instanceStatus ?? 'n/a'}</span>
            <span className={`badge ${checkBadge(health.systemStatus)}`} title="EC2 system status check (AWS hardware and network)">System: {health.systemStatus ?? 'n/a'}</span>
            {i.ssmPingStatus && <span className={`badge ${i.ssmOnline ? 'badge-info' : 'badge-warn'}`} title="SSM agent status at the last scan">SSM {i.ssmPingStatus}{ping ? ` · ${ping}` : ''}</span>}
          </div>
          {health.events.map((e) => (
            <p key={e.code + e.notBefore} className="mt-2 break-words" style={{ color: 'var(--warn)' }}>
              <Icon.alert className="inline" /> Scheduled {e.code}{e.notBefore ? ` from ${new Date(e.notBefore).toLocaleString()}` : ''}: {e.description}
            </p>
          ))}
          {i.state === 'running' && (
            <div className="mt-3">
              <div className="mb-1 flex items-baseline justify-between">
                <span className="muted">CPU, last 3 h</span>
                {cpuNow !== undefined && <span className="mono font-semibold">{cpuNow.toFixed(1)}%</span>}
              </div>
              <Sparkline points={health.cpu} />
            </div>
          )}
          {health.errors.map((e) => <p key={e} className="muted mt-2 break-words text-[10px]">{e}</p>)}
        </>
      )}
    </div>
  )
}

export default function HostDetails(): ReactElement | null {
  const s = useStore()
  const i = allInstances(s).find((host) => host.key === s.detailsFor)
  if (!i) return null
  const route = routeOf(i, s.settings)
  const meta = metaFor(groupKeyOf(i), s.settings)
  const available = route.route === 'ssm' || route.route === 'direct'
  const copy = async (value: string): Promise<void> => {
    try { await window.api.invoke('clipboard:write', value); s.toast('success', 'Copied') }
    catch (e) { s.toast('error', (e as Error).message) }
  }
  const fields: [string, string | undefined][] = [
    ['Instance ID', i.instanceId], ['Account', i.accountId], ['Profile', i.profile], ['Region / folder', i.region],
    ['OS', i.osHint], ['Instance type', i.instanceType || undefined], ['Public IP', i.publicIp], ['Private IP', i.privateIp],
    ['Public DNS', i.publicDns], ['Availability zone', i.az], ['VPC', i.vpcId], ['Subnet', i.subnetId],
    ['AMI', i.imageId], ['Key pair', i.keyName], ['SSM agent', i.ssmAgentVersion], ['SSM last check-in', i.ssmLastPing ? `${new Date(i.ssmLastPing).toLocaleString()} (${ago(i.ssmLastPing)})` : undefined],
    ['Launched', i.launchTime ? new Date(i.launchTime).toLocaleString() : undefined],
    ['Last verified', i.lastSeenAt ? new Date(i.lastSeenAt).toLocaleString() : undefined]
  ]
  return <aside className="host-details panel flex min-h-0 flex-col border-l" aria-label={`Details for ${i.name}`} data-accent={meta.color}>
    <div className="flex items-start gap-2 border-b p-4 border-default">
      <div className="min-w-0 flex-1"><span className="env-chip mb-2">{meta.label}</span><h2 className="break-words text-base font-semibold">{i.name}</h2><p className="muted mt-1 text-xs">{i.state} · {i.osHint}</p></div>
      <button className="btn btn-ghost btn-icon" aria-label="Close host details" onClick={() => s.set({ detailsFor: null })}><Icon.x /></button>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      {i.staleReason && <div className="scan-notice mb-4 rounded-lg border p-3 text-xs"><strong>Cached inventory</strong><p className="mt-1 break-words">{i.staleReason}</p><p className="mt-1">State and addresses may have changed.</p></div>}
      <div className="panel-2 rounded-lg border border-default p-3 text-xs">
        <div className="flex items-center justify-between"><span className="font-semibold">Connection route</span><span className="badge badge-neutral">{route.route === 'ssm' ? 'SSM' : route.route === 'direct' ? 'Direct' : route.route === 'not-running' ? i.state : 'Unavailable'}</span></div>
        <p className="text-2 mt-2 break-words">{route.reason}</p>
        {available && <p className="muted mt-1">Connection is verified when you connect.</p>}
        {i.ssmError && <p className="mt-2 break-words">SSM lookup failed: {i.ssmError}</p>}
      </div>
      <div className="my-4 flex flex-wrap gap-2">
        <button className="btn btn-primary" disabled={!available} onClick={() => openDefaultFor(i.key)}>{i.platform === 'windows' ? <Icon.monitor /> : <Icon.terminal />} Connect</button>
        <button className="btn" disabled={!available} onClick={() => openFilesFor(i.key)}><Icon.folder /> Files</button>
        <button className="btn" disabled={i.state !== 'running'} onClick={() => s.set({ connectFor: { kind: i.platform === 'windows' ? 'rdp' : 'ssh', key: i.key } })}>Connection options</button>
        {!i.manual && <button className="btn" disabled={!i.ssmOnline || i.state !== 'running'} title={i.ssmOnline ? 'Forward a local port through SSM' : 'Needs an online SSM agent'} onClick={() => s.set({ portForwardFor: { key: i.key } })}><Icon.plug /> Forward port</button>}
        <button className="btn" onClick={() => void s.toggleFavorite(i.key)}><Icon.star filled={s.isFavorite(i.key)} />{s.isFavorite(i.key) ? 'Unfavorite' : 'Favorite'}</button>
      </div>
      <HealthSection i={i} />
      <dl className="space-y-3 text-xs">{fields.filter(([, value]) => value).map(([label, value]) => <div key={label}>
        <dt className="muted mb-0.5">{label}</dt><dd><button className="detail-value mono w-full text-left break-all select-text" title={`Copy ${label.toLowerCase()}`} onClick={() => void copy(value!)}>{value}</button></dd>
      </div>)}</dl>
      {Object.keys(i.tags).length > 0 && <div className="mt-5 border-t border-default pt-4"><h3 className="section-title mb-3">Tags</h3><dl className="space-y-3 text-xs select-text">{Object.entries(i.tags).map(([key, value]) => <div key={key}><dt className="muted break-all">{key}</dt><dd className="break-words">{value || '—'}</dd></div>)}</dl></div>}
    </div>
  </aside>
}

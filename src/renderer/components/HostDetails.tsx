import type { ReactElement } from 'react'
import { allInstances, routeOf, useStore } from '../store'
import { groupKeyOf, metaFor } from '../colors'
import { openDefaultFor, openFilesFor } from '../quickConnect'
import { Icon } from './icons'

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
    ['AMI', i.imageId], ['Key pair', i.keyName], ['SSM agent', i.ssmAgentVersion],
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
        <button className="btn" onClick={() => void s.toggleFavorite(i.key)}><Icon.star filled={s.isFavorite(i.key)} />{s.isFavorite(i.key) ? 'Unfavorite' : 'Favorite'}</button>
      </div>
      <dl className="space-y-3 text-xs">{fields.filter(([, value]) => value).map(([label, value]) => <div key={label}>
        <dt className="muted mb-0.5">{label}</dt><dd><button className="detail-value mono w-full text-left break-all select-text" title={`Copy ${label.toLowerCase()}`} onClick={() => void copy(value!)}>{value}</button></dd>
      </div>)}</dl>
      {Object.keys(i.tags).length > 0 && <div className="mt-5 border-t border-default pt-4"><h3 className="section-title mb-3">Tags</h3><dl className="space-y-3 text-xs select-text">{Object.entries(i.tags).map(([key, value]) => <div key={key}><dt className="muted break-all">{key}</dt><dd className="break-words">{value || '—'}</dd></div>)}</dl></div>}
    </div>
  </aside>
}

import type { ReactElement } from 'react'
import type { Instance } from '@shared/types'
import { isSession, routeOf, useStore, visibleInstances } from '../store'
import { openDefaultFor } from '../quickConnect'
import { metaFor } from '../colors'
import { Icon } from './icons'

export default function HostWorkspaceHeader(): ReactElement {
  const s = useStore()
  const hosts = visibleInstances(s)
  const byKey = new Map(hosts.map((h) => [h.key, h]))
  const quickHosts = [...new Set([...s.recentHosts, ...(s.settings?.favorites ?? [])])]
    .map((key) => byKey.get(key)).filter((h): h is Instance => !!h && h.state !== 'terminated').slice(0, 4)
  const sessions = s.tabs.filter(isSession)
  const live = sessions.filter((t) => t.status === 'connected').length
  const hasRecent = quickHosts.some((h) => s.recentHosts.includes(h.key))

  return <div className="host-workspace-header">
    <div className="host-page-heading">
      <div className="min-w-0">
        <div className="workspace-eyebrow"><span className="workspace-eyebrow-line" /> Your workspace</div>
        <h1>Hosts<span className="host-total">{hosts.length}</span></h1>
        <p>All your infrastructure. One place to get to work.</p>
      </div>
      <div className="host-page-actions">
        {sessions.length > 0 && <button className="workspace-sessions" onClick={() => s.showGrid(true)}><span className="dot" style={{ background: live ? 'var(--ok)' : 'var(--muted)' }} />{live} connected <Icon.grid /></button>}
        <button className="btn" disabled={s.scanning} onClick={() => void s.scan()}><Icon.refresh className={s.scanning ? 'animate-spin' : ''} />{s.scanning ? 'Refreshing…' : 'Refresh hosts'}</button>
        <button className="btn btn-primary" onClick={() => s.set({ manualHostEditor: 'new' })}><Icon.plus /> Add server</button>
      </div>
    </div>
    {quickHosts.length > 0 && <section className="host-quick-access" aria-label="Quick access hosts">
      <div className="quick-access-heading"><span><Icon.history />{hasRecent ? 'Jump back in' : 'Quick access'}</span><span className="muted">Recent connections & favorites</span></div>
      <div className="quick-host-grid">
        {quickHosts.map((h) => {
          // Prefer an existing live session; a recent-host shortcut must not silently open duplicates.
          const tab = sessions.find((t) => t.instanceKey === h.key && t.status === 'connected')
            ?? sessions.find((t) => t.instanceKey === h.key && t.status === 'connecting')
          const canConnect = ['ssm', 'direct'].includes(routeOf(h, s.settings).route)
          const action = tab ? `Return to ${tab.kind.toUpperCase()}` : canConnect ? `Connect ${h.platform === 'windows' ? 'RDP' : 'SSH'}` : 'View details'
          const account = metaFor(h.manual ? `group:${h.region}` : h.profile, s.settings)
          return <button key={h.key} className="quick-host-card" data-accent={account.color} aria-label={`${action}: ${h.name}`} title={`${h.name} · ${account.label} · ${h.region}`} onClick={() => tab ? s.setActive(tab.id) : canConnect ? openDefaultFor(h.key) : s.revealHost(h.key)}>
            <span className="quick-host-icon">{h.platform === 'windows' ? <Icon.monitor /> : <Icon.terminal />}</span>
            <span className="quick-host-text"><strong>{h.name}</strong><span>{account.label} · {h.region}</span><span className="quick-host-action">{action}{h.staleReason ? ' · Cached' : ''}</span></span>
            <Icon.chevron />
          </button>
        })}
      </div>
    </section>}
  </div>
}

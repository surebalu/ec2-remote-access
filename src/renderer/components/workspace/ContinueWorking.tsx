import type { ReactElement } from 'react'
import type { Instance } from '@shared/types'
import { isSession, routeOf, useStore, visibleInstances } from '../../store'
import { openDefaultFor } from '../../quickConnect'
import { metaFor } from '../../colors'
import { Icon } from '../icons'

/** Recent connections and favorites; a card returns to a live session rather than opening another. */
export default function JumpBackIn(): ReactElement {
  const s = useStore()
  const hosts = visibleInstances(s)
  const byKey = new Map(hosts.map((h) => [h.key, h]))
  const quick = [...new Set([...s.recentHosts, ...(s.settings?.favorites ?? [])])]
    .map((key) => byKey.get(key)).filter((h): h is Instance => !!h && h.state !== 'terminated').slice(0, 4)
  const sessions = s.tabs.filter((t) => isSession(t) && !t.transient)
  const hasRecent = quick.some((h) => s.recentHosts.includes(h.key))
  return (
    <section className="hd-card hd-jump host-quick-access" aria-label="Quick access hosts">
      <div className="hd-card-head"><span><Icon.history />{hasRecent ? 'Continue working' : 'Quick access'}</span><button className="ws-text-action" onClick={() => s.openQuickSwitcher()}>Find a host <kbd>⌘K</kbd></button></div>
      {quick.length ? (
        <div className="hd-jump-grid">
          {quick.map((h) => {
            const tab = sessions.find((t) => t.instanceKey === h.key && t.status === 'connected') ?? sessions.find((t) => t.instanceKey === h.key && t.status === 'connecting')
            const canConnect = ['ssm', 'direct'].includes(routeOf(h, s.settings).route)
            const act = tab ? `Return to ${tab.kind.toUpperCase()}` : canConnect ? `Connect ${h.platform === 'windows' ? 'RDP' : 'SSH'}` : 'View details'
            const account = metaFor(h.manual ? `group:${h.region}` : h.profile, s.settings)
            return (
              <button key={h.key} type="button" className="quick-host-card hd-host" data-accent={account.color} aria-label={`${act}: ${h.name}`} title={`${h.name} · ${account.label} · ${h.region}`}
                onClick={() => (tab ? s.setActive(tab.id) : canConnect ? openDefaultFor(h.key) : s.revealHost(h.key))}>
                <span className="hd-host-icon">{h.platform === 'windows' ? <Icon.monitor /> : <Icon.terminal />}{tab && <i className="hd-live" />}</span>
                <span className="hd-host-text">
                  <strong>{h.name}</strong>
                  <span>{account.label} · {h.publicIp ?? h.privateIp ?? h.region}{h.staleReason ? ' · Cached' : ''}</span>
                </span>
                <span className="hd-host-go">{act}</span>
              </button>
            )
          })}
        </div>
      ) : <p className="hd-empty">Connect to a host, or star one, and it waits here.</p>}
    </section>
  )
}


import type { ReactElement } from 'react'
import type { PortForwardPreset, Tunnel } from '@shared/types'
import { useStore } from '../store'
import { Icon } from './icons'

/** Ports that usually speak HTTP(S), for the Open button. */
const WEB_PORTS: Record<number, 'http' | 'https'> = { 80: 'http', 443: 'https', 3000: 'http', 5000: 'http', 5601: 'http', 8000: 'http', 8080: 'http', 8443: 'https', 8888: 'http', 9000: 'http', 9090: 'http', 9443: 'https' }

const NO_PRESETS: PortForwardPreset[] = []

const statusColor = (t: Tunnel): string => (t.status === 'ready' ? 'var(--ok)' : t.status === 'starting' ? 'var(--warn)' : 'var(--err)')

/** Live SSM tunnels (RDP and user port forwards) plus saved port-forward presets that are not currently open. */
export default function TunnelBar(): ReactElement | null {
  const tunnels = useStore((s) => s.tunnels)
  // A stable fallback: a fresh [] from a selector makes zustand re-render forever.
  const presets = useStore((s) => s.settings?.portForwards ?? NO_PRESETS)
  const toast = useStore((s) => s.toast)
  const set = useStore((s) => s.set)
  const openPortForward = useStore((s) => s.openPortForward)
  const live = (p: (typeof presets)[number]): boolean =>
    tunnels.some((t) => t.kind === 'port' && t.instanceKey === p.instanceKey && t.remotePort === p.remotePort && (t.remoteHost ?? '') === (p.remoteHost ?? '') && t.status !== 'closed' && t.status !== 'error')
  const idle = presets.filter((p) => !live(p))
  if (tunnels.length === 0 && idle.length === 0) return null
  return (
    <div className="tunnel-bar panel flex flex-wrap items-center gap-1.5 border-t px-3 py-1.5 text-[11px]" style={{ borderColor: 'var(--border)' }}>
      <span className="section-title mr-1 flex items-center gap-1"><Icon.plug /> Tunnels</span>
      {tunnels.map((t) => {
        const scheme = t.kind === 'port' ? WEB_PORTS[t.remotePort] : undefined
        return (
          <span key={t.id} className="tunnel-chip" title={t.message}>
            <span className="dot" style={{ background: statusColor(t), animation: t.status === 'starting' ? 'pulse 1.2s infinite' : undefined }} />
            <span className="muted uppercase">{t.kind === 'port' ? 'port' : t.kind}</span>
            <span className="max-w-56 truncate">{t.title}</span>
            {t.status === 'ready' && (
              <button
                className="mono hover:underline"
                title="Copy address"
                onClick={async () => {
                  await window.api.invoke('clipboard:write', `localhost:${t.localPort}`)
                  toast('success', `Copied localhost:${t.localPort}`)
                }}
              >
                localhost:{t.localPort}
              </button>
            )}
            {t.status === 'ready' && scheme && (
              <button className="hover:underline" title="Open in the browser" onClick={() => void window.api.invoke('shell:open', `${scheme}://localhost:${t.localPort}`)}>
                open
              </button>
            )}
            {(t.status === 'closed' || t.status === 'error') && t.kind === 'port' && (
              <button className="hover:underline" title="Start this forward again" onClick={() => {
                void window.api.invoke('tunnels:close', t.id).then(() => openPortForward({ instanceKey: t.instanceKey, remotePort: t.remotePort, localPort: t.localPort, remoteHost: t.remoteHost, name: t.title }))
              }}>
                restart
              </button>
            )}
            <button className="muted hover:opacity-70" title={t.status === 'ready' ? 'Stop tunnel' : 'Remove'} aria-label="Close tunnel" onClick={() => void window.api.invoke('tunnels:close', t.id)}>
              <Icon.x />
            </button>
          </span>
        )
      })}
      {idle.map((p) => (
        <button key={p.id} className="tunnel-chip idle" title={`Start: localhost:${p.localPort ?? 'any'} → ${p.remoteHost ?? 'instance'}:${p.remotePort} (right-click to edit)`}
          onClick={() => void openPortForward({ instanceKey: p.instanceKey, remotePort: p.remotePort, localPort: p.localPort, remoteHost: p.remoteHost, name: p.name })}
          onContextMenu={(e) => { e.preventDefault(); set({ portForwardFor: { presetId: p.id } }) }}>
          <Icon.play /> {p.name}
        </button>
      ))}
      <button className="btn btn-ghost btn-sm ml-auto" onClick={() => set({ portForwardFor: {} })}>
        <Icon.plus /> Forward a port
      </button>
    </div>
  )
}

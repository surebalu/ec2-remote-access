import type { ReactElement } from 'react'
import { useStore } from '../store'

export default function TunnelBar(): ReactElement | null {
  const tunnels = useStore((s) => s.tunnels)
  const toast = useStore((s) => s.toast)
  if (tunnels.length === 0) return null
  return (
    <div className="panel flex flex-wrap items-center gap-2 border-t px-3 py-1.5 text-[11px]" style={{ borderColor: 'var(--border)' }}>
      <span className="section-title">Tunnels</span>
      {tunnels.map((t) => (
        <span key={t.id} className="badge gap-2 border" style={{ borderColor: 'var(--border)' }} title={t.message}>
          <span className="dot" style={{ background: t.status === 'ready' ? 'var(--ok)' : t.status === 'starting' ? 'var(--warn)' : 'var(--err)' }} />
          {t.kind.toUpperCase()} {t.title} → localhost:{t.localPort}
          {t.status === 'ready' && (
            <button
              className="hover:underline"
              onClick={async () => {
                await window.api.invoke('clipboard:write', `localhost:${t.localPort}`)
                toast('success', 'Copied')
              }}
            >
              copy
            </button>
          )}
          <button className="muted hover:opacity-70" title="Close tunnel" onClick={() => void window.api.invoke('tunnels:close', t.id)}>
            ✕
          </button>
        </span>
      ))}
    </div>
  )
}

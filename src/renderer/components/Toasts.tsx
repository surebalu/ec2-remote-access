import type { ReactElement } from 'react'
import { useStore } from '../store'

export default function Toasts(): ReactElement {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  // Keep clear of the terminal appearance pane (232px) and the tunnel bar, which both sit at the right/bottom.
  const paneShown = useStore((s) => s.terminalPaneOpen && s.tabs.some((t) => t.id === s.activeTab && t.kind === 'ssh'))
  const tunnelBar = useStore((s) => s.tunnels.length > 0 || (s.settings?.portForwards.length ?? 0) > 0)
  return (
    <div className="toasts pointer-events-none fixed z-50 flex w-96 max-w-[calc(100vw-32px)] flex-col gap-2" style={{ right: paneShown ? 248 : 16, bottom: tunnelBar ? 48 : 16 }}>
      {toasts.map((t) => (
        <div
          key={t.id}
          className="panel modal pointer-events-auto select-text border px-3 py-2 text-xs"
          style={{
            borderRadius: 10,
            borderLeft: `3px solid ${t.kind === 'error' ? 'var(--err)' : t.kind === 'success' ? 'var(--ok)' : 'var(--accent)'}`
          }}
          onClick={() => dismiss(t.id)}
          role={t.kind === 'error' ? 'alert' : 'status'}
        >
          {t.text}
        </div>
      ))}
    </div>
  )
}

import type { ReactElement } from 'react'
import { useStore } from '../store'

export default function Toasts(): ReactElement {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-96 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="panel modal pointer-events-auto select-text border px-3 py-2 text-xs"
          style={{
            borderRadius: 10,
            borderLeft: `3px solid ${t.kind === 'error' ? 'var(--err)' : t.kind === 'success' ? 'var(--ok)' : 'var(--accent)'}`
          }}
          onClick={() => dismiss(t.id)}
        >
          {t.text}
        </div>
      ))}
    </div>
  )
}

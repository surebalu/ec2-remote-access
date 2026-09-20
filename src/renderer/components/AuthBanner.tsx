import type { ReactElement } from 'react'
import { useStore } from '../store'
import { Icon } from './icons'

/** Top-of-content banner for expired / expiring AWS SSO sessions. */
export default function AuthBanner(): ReactElement | null {
  const s = useStore()
  const info = s.authState()
  if (info.kind === 'ok' || s.authBannerDismissedFor === info.key) return null
  const expired = info.kind === 'expired'
  return (
    <div
      className="flex items-center gap-3 border-b px-4 py-2 text-[12.5px]"
      style={{
        borderColor: 'var(--border)',
        background: expired ? 'var(--err-soft)' : 'var(--warn-soft)',
        color: 'var(--text)'
      }}
    >
      <span style={{ color: expired ? 'var(--err)' : 'var(--warn)' }}>
        <Icon.key />
      </span>
      <div className="flex-1">
        <span className="font-semibold">{expired ? 'AWS session expired.' : `AWS session expires in ${info.minutesLeft} min.`}</span>{' '}
        <span className="text-2">
          {expired
            ? `Sign in again to keep scanning and connecting${info.profiles.length ? ` (${info.profiles.join(', ')})` : ''}. Open SSH and RDP sessions keep working.`
            : 'Refresh now to avoid an interruption when you next connect.'}
        </span>
      </div>
      <button className="btn btn-primary btn-sm" disabled={s.loggingIn} onClick={() => void s.refreshToken()}>
        <Icon.key /> {s.loggingIn ? 'Waiting…' : 'Sign in'}
      </button>
      <button className="btn btn-ghost btn-sm btn-icon" title="Dismiss" onClick={() => s.set({ authBannerDismissedFor: info.key })}>
        <Icon.x />
      </button>
    </div>
  )
}

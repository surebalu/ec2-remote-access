import { useEffect, useState, type ReactElement } from 'react'
import { useStore } from '../store'
import { Icon } from './icons'

/** Shown instead of the hosts table when no AWS profiles and no manual servers exist yet. */
export default function Welcome(): ReactElement {
  const s = useStore()
  const [paths, setPaths] = useState<{ sessionManagerPlugin: string | null; awsCli: string | null; windowsApp: boolean } | null>(null)
  useEffect(() => {
    void window.api.invoke('app:paths').then(setPaths)
  }, [])
  const row = (ok: boolean | null, label: string, detail: string, link?: string): ReactElement => (
    <div className="flex items-center gap-3 py-2">
      <span className="dot" style={{ background: ok === null ? 'var(--muted)' : ok ? 'var(--ok)' : 'var(--warn)' }} />
      <div className="flex-1">
        <div className="text-[12.5px] font-medium">{label}</div>
        <div className="muted text-[11px]">{detail}</div>
      </div>
      {ok === false && link && (
        <button className="btn btn-sm" onClick={() => void window.api.invoke('shell:open', link)}>
          Install
        </button>
      )}
    </div>
  )
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="panel w-full max-w-xl rounded-2xl border p-8" style={{ borderColor: 'var(--border)', boxShadow: 'var(--shadow-lg)' }}>
        <div className="mb-1 flex items-center gap-3">
          <span className="brand-mark" style={{ width: 36, height: 36, fontSize: 15, lineHeight: '36px', borderRadius: 10 }}>
            &gt;_
          </span>
          <div>
            <div className="text-lg font-semibold tracking-tight">Welcome to EC2 Remote Access</div>
            <div className="muted text-[12px]">One place for SSH and RDP to every server you manage.</div>
          </div>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-3">
          <button className="rounded-xl border p-4 text-left transition-colors hover:border-[var(--accent)]" style={{ borderColor: 'var(--border)', background: 'var(--accent-soft)' }} onClick={() => s.set({ addAccountOpen: true })}>
            <div className="mb-1 flex items-center gap-2 font-semibold">
              <Icon.cloud /> Add AWS account
            </div>
            <div className="muted text-[11.5px]">Sign in with IAM Identity Center or access keys. EC2 instances appear automatically.</div>
          </button>
          <button className="panel-2 rounded-xl border p-4 text-left transition-colors hover:border-[var(--accent)]" style={{ borderColor: 'var(--border)' }} onClick={() => s.set({ manualHostEditor: 'new' })}>
            <div className="mb-1 flex items-center gap-2 font-semibold">
              <Icon.server /> Add a server
            </div>
            <div className="muted text-[11.5px]">Any Linux or Windows machine reachable from this Mac.</div>
          </button>
        </div>
        <div className="mt-6">
          <div className="section-title mb-1">Prerequisites</div>
          <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {row(paths ? !!paths.sessionManagerPlugin : null, 'AWS Session Manager plugin', paths?.sessionManagerPlugin ?? 'Needed for private instances without a public IP. brew install --cask session-manager-plugin', 'https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html')}
            {row(paths ? paths.windowsApp : null, 'Windows App', paths?.windowsApp ? 'Installed' : 'Optional. Only for handing RDP off to Microsoft\'s client; the built-in RDP works without it.', 'https://apps.apple.com/app/windows-app/id1295203466')}
            {row(true, 'AWS CLI', paths?.awsCli ? paths.awsCli : 'Optional. Not required; SSO login is built in.')}
          </div>
        </div>
      </div>
    </div>
  )
}

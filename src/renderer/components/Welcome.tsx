import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import type { CompanySetup } from '@shared/setup'
import { hasBrowser } from '../quickConnect'
import { useStore } from '../store'
import { useBox } from '../box'
import BoxSetups from './BoxSetups'
import { Icon } from './icons'

type Paths = { sessionManagerPlugin: string | null; sessionManagerPluginBundled: boolean; awsCli: string | null; windowsApp: boolean }

const FEATURES: { icon: ReactNode; title: string; text: string }[] = [
  { icon: <Icon.cloud />, title: 'Every account at once', text: 'Finds the instances in all your AWS profiles and regions, and keeps them in one list.' },
  { icon: <Icon.terminal />, title: 'SSH, RDP and files built in', text: 'Terminal tabs, remote desktops and drag-and-drop transfers, with no bastion or VPN.' },
  { icon: <Icon.broadcast />, title: 'Made for fleets', text: 'Run a command on many hosts, forward ports, keep notes per host, and see it all at once.' }
]

/** Shown instead of the hosts table until there is an AWS account or a server to show. */
export default function Welcome(): ReactElement {
  const set = useStore((s) => s.set)
  const box = useBox()
  const [paths, setPaths] = useState<Paths | null>(null)
  // The organization's sign-in when this build carries one (build/company.json): one button sets up its accounts.
  const [company, setCompany] = useState<CompanySetup | null>(null)
  useEffect(() => {
    void window.api.invoke('app:paths').then(setPaths)
    void window.api.invoke('app:company').then(setCompany, () => undefined)
  }, [])
  const req = (ok: boolean | null, label: string, detail: string, link?: string, optional = false): ReactElement => (
    <div className="welcome-req">
      <span className={`welcome-req-dot ${ok === null ? '' : ok ? 'ok' : optional ? 'opt' : 'warn'}`}>{ok ? <Icon.check /> : null}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium">{label}{optional && <span className="muted font-normal"> · optional</span>}</div>
        <div className="muted truncate text-[11.5px]">{detail}</div>
      </div>
      {ok === false && link && <button className="btn btn-sm" onClick={() => void window.api.invoke('shell:open', link)}>How to install</button>}
    </div>
  )
  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="welcome-hero">
          <span className="brand-mark welcome-mark">&gt;_</span>
          <h1 className="welcome-title">Welcome to EC2 Remote Access</h1>
          <p className="welcome-lede">SSH, remote desktop and files for every EC2 instance in every AWS account, from one Mac app. Private instances connect through SSM Session Manager.</p>
        </div>
        <div className="welcome-features">
          {FEATURES.map((f) => (
            <div key={f.title} className="welcome-feature">
              <span className="welcome-feature-icon">{f.icon}</span>
              <div className="text-[12.5px] font-semibold">{f.title}</div>
              <div className="muted text-[11.5px] leading-snug">{f.text}</div>
            </div>
          ))}
        </div>
        <div className="welcome-actions">
          {company && (
            <button className="welcome-action primary wide" onClick={() => set({ addAccountOpen: 'company' })}>
              <span className="welcome-action-icon"><Icon.key /></span>
              <span className="min-w-0 flex-1 text-left">
                <span className="block text-[13.5px] font-semibold">Sign in to {company.name} AWS</span>
                <span className="block truncate text-[11.5px] opacity-85">Sets up {company.aws.profiles.map((p) => p.name).join(', ')} through IAM Identity Center</span>
              </span>
              <Icon.chevron />
            </button>
          )}
          <button className={`welcome-action ${company ? '' : 'primary'}`} onClick={() => set({ addAccountOpen: true })}>
            <span className="welcome-action-icon"><Icon.cloud /></span>
            <span className="min-w-0 flex-1 text-left">
              <span className="block text-[13.5px] font-semibold">Add an AWS account</span>
              <span className={`block text-[11.5px] ${company ? 'muted' : 'opacity-85'}`}>{company ? 'Another start URL, or access keys' : 'Sign in with IAM Identity Center (SSO) or access keys'}</span>
            </span>
            <Icon.chevron />
          </button>
          <button className="welcome-action" onClick={() => set({ manualHostEditor: 'new' })}>
            <span className="welcome-action-icon"><Icon.server /></span>
            <span className="min-w-0 flex-1 text-left">
              <span className="block text-[13.5px] font-semibold">Add a server</span>
              <span className="muted block text-[11.5px]">Any Linux or Windows machine this Mac can reach</span>
            </span>
            <Icon.chevron />
          </button>
        </div>
        {hasBrowser() && (box.st?.signedIn ? (
          <div className="welcome-box"><BoxSetups signedIn /></div>
        ) : (
          <p className="welcome-import">
            Moving from another Mac? <button type="button" onClick={() => void useStore.getState().importSetup()}>Import a setup file</button> exported there
            {box.st?.available && <>, or <button type="button" onClick={box.signIn}>{box.waiting ? 'waiting for Box…' : 'sign in to Box'}</button> to bring it from there</>}.
          </p>
        ))}
        <div className="welcome-reqs">
          <div className="welcome-reqs-title">Before you connect</div>
          {req(paths ? !!paths.sessionManagerPlugin : null, 'AWS Session Manager plugin', paths?.sessionManagerPluginBundled ? 'Included with the app' : paths?.sessionManagerPlugin ?? 'For private instances: brew install --cask session-manager-plugin', 'https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html')}
          {req(paths ? !!paths.awsCli : null, 'AWS CLI', paths?.awsCli ?? 'Not required: sign-in is built in', undefined, true)}
          {req(paths ? paths.windowsApp : null, 'Windows App', paths?.windowsApp ? 'Installed' : 'Only for handing desktops to Microsoft’s client; the built-in RDP works without it', 'https://apps.apple.com/app/windows-app/id1295203466', true)}
        </div>
        <p className="welcome-privacy"><Icon.lock /> Your AWS credentials stay in <span className="mono">~/.aws</span> on this Mac. No analytics, no telemetry.</p>
      </div>
    </div>
  )
}

import { useEffect, useMemo, useState, type ReactElement } from 'react'
import type { SsoAccount, SsoDeviceFlow, AccentColor } from '@shared/types'
import { ACCENTS } from '../colors'
import { useStore } from '../store'
import Modal from './Modal'
import { Icon } from './icons'

type Step = 'choose' | 'sso-form' | 'sso-wait' | 'sso-pick' | 'keys' | 'done'

const REGIONS = ['us-west-1', 'us-west-2', 'us-east-1', 'us-east-2', 'eu-west-1', 'eu-west-2', 'eu-central-1', 'ap-south-1', 'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1', 'ca-central-1', 'sa-east-1']

/** Onboarding for AWS accounts: Identity Center (SSO) device login with account/role discovery, or access keys. */
export default function AddAccountDialog(): ReactElement {
  const s = useStore()
  const [step, setStep] = useState<Step>('choose')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sessions, setSessions] = useState<{ name: string; startUrl?: string; region?: string }[]>([])

  // SSO form
  const [startUrl, setStartUrl] = useState('')
  const [ssoRegion, setSsoRegion] = useState('us-west-1')
  const [sessionName, setSessionName] = useState('')
  const [flow, setFlow] = useState<SsoDeviceFlow | null>(null)
  const [accounts, setAccounts] = useState<SsoAccount[]>([])
  const [picks, setPicks] = useState<Record<string, { on: boolean; role: string; profile: string; label: string; color: AccentColor }>>({})
  const [defaultRegion, setDefaultRegion] = useState('us-west-1')
  const [written, setWritten] = useState<string[]>([])

  // Keys form
  const [kName, setKName] = useState('')
  const [kId, setKId] = useState('')
  const [kSecret, setKSecret] = useState('')
  const [kToken, setKToken] = useState('')
  const [kRegion, setKRegion] = useState('us-west-1')

  useEffect(() => {
    void window.api.invoke('sso:sessions').then((list) => {
      setSessions(list)
      const first = list[0]
      if (first?.startUrl) {
        setStartUrl(first.startUrl)
        setSsoRegion(first.region ?? 'us-west-1')
        setSessionName(first.name)
      }
    })
  }, [])

  const close = (): void => {
    if (flow && step === 'sso-wait') void window.api.invoke('sso:cancel', flow.flowId)
    s.set({ addAccountOpen: false })
  }

  const startSso = async (): Promise<void> => {
    setErr(null)
    if (!/^https:\/\/.+/.test(startUrl.trim())) {
      setErr('Enter the Identity Center start URL, e.g. https://your-org.awsapps.com/start')
      return
    }
    setBusy(true)
    try {
      const f = await window.api.invoke('sso:start', { startUrl: startUrl.trim(), region: ssoRegion })
      setFlow(f)
      setStep('sso-wait')
      const found = await window.api.invoke('sso:wait', f.flowId)
      setAccounts(found)
      const initial: typeof picks = {}
      for (const a of found) {
        const guess = a.accountName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24)
        const already = s.profiles.some((p) => p.accountId === a.accountId)
        initial[a.accountId] = { on: !already, role: a.roles[0] ?? '', profile: guess || a.accountId, label: a.accountName, color: ACCENTS[Object.keys(initial).length % (ACCENTS.length - 1)] }
      }
      setPicks(initial)
      setStep('sso-pick')
    } catch (e) {
      setErr((e as Error).message)
      setStep('sso-form')
    } finally {
      setBusy(false)
    }
  }

  const saveSso = async (): Promise<void> => {
    if (!flow) return
    setBusy(true)
    setErr(null)
    try {
      const selections = accounts
        .filter((a) => picks[a.accountId]?.on && picks[a.accountId]?.role)
        .map((a) => ({ accountId: a.accountId, roleName: picks[a.accountId].role, profileName: picks[a.accountId].profile, region: defaultRegion }))
      if (!selections.length) throw new Error('Pick at least one account')
      const names = new Set(selections.map((x) => x.profileName))
      if (names.size !== selections.length) throw new Error('Profile names must be unique')
      const result = await window.api.invoke('sso:save', { flowId: flow.flowId, sessionName: sessionName || 'default', defaultRegion, selections })
      // environment labels/colors for the new profiles
      const accountMeta = { ...(s.settings?.accountMeta ?? {}) }
      for (const a of accounts) {
        const p = picks[a.accountId]
        if (p?.on) accountMeta[p.profile] = { label: p.label || undefined, color: p.color }
      }
      await s.saveSettings({ accountMeta })
      setWritten(result)
      setStep('done')
      await s.refreshProfiles()
      await s.checkAuth()
      void s.scan(result)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const saveKeys = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      if (!kName.trim() || !kId.trim() || !kSecret.trim()) throw new Error('Name, access key ID and secret are required')
      await window.api.invoke('profiles:addStatic', { profileName: kName, accessKeyId: kId, secretAccessKey: kSecret, sessionToken: kToken || undefined, region: kRegion })
      setWritten([kName.trim()])
      setStep('done')
      await s.refreshProfiles()
      await s.checkAuth(kName.trim())
      void s.scan([kName.trim()])
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const selectedCount = useMemo(() => Object.values(picks).filter((p) => p.on).length, [picks])

  return (
    <Modal title="Add AWS account" onClose={close} width="max-w-2xl">
      {step === 'choose' && (
        <div className="grid grid-cols-2 gap-3">
          <button className="panel-2 rounded-xl border p-4 text-left transition-colors hover:border-[var(--accent)]" style={{ borderColor: 'var(--border)' }} onClick={() => setStep('sso-form')}>
            <div className="mb-1 flex items-center gap-2 font-semibold">
              <span className="avatar" data-accent="violet">
                <Icon.key />
              </span>
              IAM Identity Center (SSO)
            </div>
            <div className="muted text-[12px]">Sign in once through your organization's start URL. The app finds every account and role you can access and sets them up for you. Recommended.</div>
          </button>
          <button className="panel-2 rounded-xl border p-4 text-left transition-colors hover:border-[var(--accent)]" style={{ borderColor: 'var(--border)' }} onClick={() => setStep('keys')}>
            <div className="mb-1 flex items-center gap-2 font-semibold">
              <span className="avatar" data-accent="slate">
                <Icon.shield />
              </span>
              Access keys
            </div>
            <div className="muted text-[12px]">For an IAM user with an access key ID and secret. Stored in ~/.aws/credentials, the same place the AWS CLI uses.</div>
          </button>
          <div className="muted col-span-2 text-[11px]">Accounts are written to your standard AWS config files, so the AWS CLI and other tools see them too.</div>
        </div>
      )}

      {step === 'sso-form' && (
        <div className="grid grid-cols-[130px_minmax(0,1fr)] items-center gap-x-3 gap-y-3">
          <label className="muted">Start URL</label>
          <div>
            <input className="input mono" autoFocus value={startUrl} placeholder="https://your-org.awsapps.com/start" onChange={(e) => setStartUrl(e.target.value)} />
            {sessions.length > 0 && <div className="muted mt-1 text-[10px]">Prefilled from your existing session "{sessions[0].name}".</div>}
          </div>
          <label className="muted">SSO region</label>
          <select className="input" value={ssoRegion} onChange={(e) => setSsoRegion(e.target.value)}>
            {REGIONS.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
          <label className="muted">Session name</label>
          <div>
            <input className="input" value={sessionName} placeholder="e.g. mycompany" onChange={(e) => setSessionName(e.target.value)} />
            <div className="muted mt-1 text-[10px]">Groups the profiles under one login. Reuse an existing name to add accounts to it.</div>
          </div>
          {err && <div className="col-span-2 text-[12px]" style={{ color: 'var(--err)' }}>{err}</div>}
          <div className="col-span-2 mt-2 flex justify-between">
            <button className="btn" onClick={() => setStep('choose')}>
              Back
            </button>
            <button className="btn btn-primary" disabled={busy} onClick={() => void startSso()}>
              {busy ? 'Starting…' : 'Sign in with browser'}
            </button>
          </div>
        </div>
      )}

      {step === 'sso-wait' && flow && (
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <div className="text-sm">Finish signing in in your browser</div>
          <div className="muted text-[12px]">If the page didn't open, go to <span className="mono">{flow.verificationUri}</span> and enter this code:</div>
          <div className="mono rounded-lg border px-4 py-2 text-2xl font-semibold tracking-[.3em]" style={{ borderColor: 'var(--border)' }}>
            {flow.userCode}
          </div>
          <div className="flex gap-2">
            <button className="btn" onClick={() => void window.api.invoke('shell:open', flow.verificationUriComplete)}>
              Open browser again
            </button>
            <button className="btn" onClick={() => void window.api.invoke('clipboard:write', flow.userCode).then(() => s.toast('success', 'Code copied'))}>
              Copy code
            </button>
          </div>
          <div className="muted flex items-center gap-2 text-[11px]">
            <span className="dot" style={{ background: 'var(--warn)', animation: 'pulse 1.2s infinite' }} /> Waiting for approval…
          </div>
          <button className="btn btn-ghost btn-sm" onClick={close}>
            Cancel
          </button>
        </div>
      )}

      {step === 'sso-pick' && (
        <div>
          <div className="muted mb-2 text-[12px]">
            Found {accounts.length} account{accounts.length === 1 ? '' : 's'}. Choose which to add, the role to use, and how to name them.
          </div>
          <div className="max-h-80 overflow-auto rounded-lg border" style={{ borderColor: 'var(--border)' }}>
            <table className="w-full text-xs">
              <thead>
                <tr>
                  <th className="w-8"></th>
                  <th>Account</th>
                  <th>Role</th>
                  <th>Profile name</th>
                  <th>Environment</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => {
                  const p = picks[a.accountId]
                  const upd = (patch: Partial<typeof p>): void => setPicks({ ...picks, [a.accountId]: { ...p, ...patch } })
                  const exists = s.profiles.find((x) => x.accountId === a.accountId)
                  return (
                    <tr key={a.accountId} className={p.on ? '' : 'opacity-60'}>
                      <td>
                        <input type="checkbox" checked={p.on} onChange={(e) => upd({ on: e.target.checked })} />
                      </td>
                      <td>
                        <div className="font-medium">{a.accountName}</div>
                        <div className="mono muted text-[10px]">
                          {a.accountId}
                          {exists && <span className="ml-1">· already added as {exists.name}</span>}
                        </div>
                      </td>
                      <td>
                        <select className="input !h-7" value={p.role} onChange={(e) => upd({ role: e.target.value })}>
                          {a.roles.map((r) => (
                            <option key={r}>{r}</option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input className="input mono !h-7" value={p.profile} onChange={(e) => upd({ profile: e.target.value })} />
                      </td>
                      <td>
                        <div className="flex items-center gap-1">
                          <input className="input !h-7 !w-24" value={p.label} placeholder="Dev / QA / Prod" onChange={(e) => upd({ label: e.target.value })} />
                          <select className="input !h-7 !w-24" value={p.color} onChange={(e) => upd({ color: e.target.value as AccentColor })} data-accent={p.color} style={{ borderLeft: '4px solid var(--c)' }}>
                            {ACCENTS.map((c) => (
                              <option key={c}>{c}</option>
                            ))}
                          </select>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <label className="muted text-[12px]">Default region for these profiles</label>
            <select className="input !w-40" value={defaultRegion} onChange={(e) => setDefaultRegion(e.target.value)}>
              {REGIONS.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </div>
          {err && <div className="mt-2 text-[12px]" style={{ color: 'var(--err)' }}>{err}</div>}
          <div className="mt-4 flex justify-end gap-2">
            <button className="btn" onClick={close}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={busy || selectedCount === 0} onClick={() => void saveSso()}>
              {busy ? 'Saving…' : `Add ${selectedCount} account${selectedCount === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      )}

      {step === 'keys' && (
        <div className="grid grid-cols-[130px_minmax(0,1fr)] items-center gap-x-3 gap-y-3">
          <label className="muted">Profile name</label>
          <input className="input" autoFocus value={kName} placeholder="e.g. personal" onChange={(e) => setKName(e.target.value)} />
          <label className="muted">Access key ID</label>
          <input className="input mono" value={kId} onChange={(e) => setKId(e.target.value)} />
          <label className="muted">Secret access key</label>
          <input className="input mono" type="password" value={kSecret} onChange={(e) => setKSecret(e.target.value)} />
          <label className="muted">Session token</label>
          <input className="input mono" value={kToken} placeholder="optional, for temporary credentials" onChange={(e) => setKToken(e.target.value)} />
          <label className="muted">Region</label>
          <select className="input" value={kRegion} onChange={(e) => setKRegion(e.target.value)}>
            {REGIONS.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
          {err && <div className="col-span-2 text-[12px]" style={{ color: 'var(--err)' }}>{err}</div>}
          <div className="col-span-2 mt-2 flex justify-between">
            <button className="btn" onClick={() => setStep('choose')}>
              Back
            </button>
            <button className="btn btn-primary" disabled={busy} onClick={() => void saveKeys()}>
              {busy ? 'Saving…' : 'Add account'}
            </button>
          </div>
        </div>
      )}

      {step === 'done' && (
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <span className="avatar" data-accent="emerald" style={{ width: 40, height: 40, borderRadius: 12 }}>
            ✓
          </span>
          <div className="text-sm font-semibold">
            Added {written.length} profile{written.length === 1 ? '' : 's'}
          </div>
          <div className="mono muted text-[12px]">{written.join(', ')}</div>
          <div className="muted text-[12px]">Scanning them now. You can set per-account SSH defaults in Settings.</div>
          <button className="btn btn-primary" onClick={close}>
            Done
          </button>
        </div>
      )}
    </Modal>
  )
}

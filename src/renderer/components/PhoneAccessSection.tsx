import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import type { PhoneAccessBind, PhoneAccessStatus, Settings } from '@shared/types'
import { useStore } from '../store'

type Patch = Partial<Pick<Settings, 'phoneAccessEnabled' | 'phoneAccessPort' | 'phoneAccessBind'>>

/**
 * Settings → Phone access: switch the in-app gateway on, pick port / bind mode, and show the pairing QR code.
 * Changes apply immediately (the server restarts); `onPatch` mirrors them into the dialog's draft so Save does not
 * write stale values back.
 */
export default function PhoneAccessSection({ onPatch }: { onPatch: (p: Patch) => void }): ReactElement {
  const toast = useStore((s) => s.toast)
  const [st, setSt] = useState<PhoneAccessStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [which, setWhich] = useState(0)
  const [qr, setQr] = useState<string>('')
  const [port, setPort] = useState('')

  useEffect(() => {
    void window.api.invoke('phone:status').then((s) => { setSt(s); setPort(String(s.port)) })
    return window.api.on('phone:changed', setSt)
  }, [])

  const url = st?.urls[Math.min(which, Math.max(0, (st?.urls.length ?? 1) - 1))]
  useEffect(() => {
    if (!url) { setQr(''); return }
    void QRCode.toDataURL(url, { margin: 1, width: 176, errorCorrectionLevel: 'M' }).then(setQr)
  }, [url])

  const configure = async (patch: Patch): Promise<void> => {
    setBusy(true)
    try {
      const s = await window.api.invoke('phone:configure', patch)
      setSt(s)
      onPatch(patch)
      if (s.error) toast('error', `Phone access: ${s.error}`)
    } finally { setBusy(false) }
  }
  const copy = (text: string, what: string): void => void window.api.invoke('clipboard:write', text).then(() => toast('success', `${what} copied`))

  if (!st) return <div className="muted text-[11px]">Loading…</div>
  const label = (u: string): string => (u.startsWith('https://') ? 'HTTPS' : /\/\/100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(u) ? 'Tailscale' : 'Wi-Fi / LAN')
  const ago = (t: number): string => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago` }

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={st.enabled} disabled={busy} onChange={(e) => void configure({ phoneAccessEnabled: e.target.checked })} />
        <span>Let my phone use this app while it is running</span>
        <span className="ml-auto flex items-center gap-1.5 text-[11px]">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: st.running ? '#22c55e' : st.error ? '#ef4444' : 'var(--border-strong, var(--border))' }} />
          <span className="muted">{st.running ? `Running on :${st.port} · ${st.clients.length} connected` : st.error ? 'Failed' : 'Off'}</span>
        </span>
      </label>
      {st.error && <div className="text-[11px] text-red-500">{st.error}{st.bind === 'https' && st.running ? ' Plain HTTP on 127.0.0.1 is up meanwhile; phones cannot reach it until HTTPS is enabled.' : ''}</div>}

      <div className="grid grid-cols-[auto_90px_auto_minmax(0,1fr)] items-center gap-2 text-[11px]">
        <span className="muted">Port</span>
        <input className="input" type="number" min={1024} max={65535} value={port} disabled={busy} onChange={(e) => setPort(e.target.value)}
          onBlur={() => { const n = Number(port); if (n >= 1024 && n <= 65535 && n !== st.port) void configure({ phoneAccessPort: n }); else setPort(String(st.port)) }} />
        <span className="muted">Reachable from</span>
        <select className="input" value={st.bind} disabled={busy} onChange={(e) => void configure({ phoneAccessBind: e.target.value as PhoneAccessBind })}>
          <option value="https">HTTPS via Tailscale (recommended){st.tailscaleHostname ? ` · ${st.tailscaleHostname}` : ''}</option>
          <option value="tailscale">Tailscale IP, plain HTTP{st.tailscaleAvailable ? '' : ' (Tailscale not detected; falls back to all)'}</option>
          <option value="all">Any network this Mac is on, plain HTTP</option>
        </select>
      </div>

      {st.running && url && (
        <div className="flex gap-3 rounded-md border p-2.5" style={{ borderColor: 'var(--border)', background: 'var(--panel-2)' }}>
          {qr ? <img src={qr} alt="QR code for the phone link" width={176} height={176} className="shrink-0 rounded bg-white p-1" /> : <div className="h-[176px] w-[176px] shrink-0" />}
          <div className="min-w-0 flex-1 space-y-1.5 text-[11px]">
            <div className="font-medium">Scan with the iPhone camera, then add the page to the Home Screen.</div>
            {st.urls.length > 1 && (
              <div className="seg max-w-xs">
                {st.urls.map((u, i) => <button key={u} className={i === which ? 'on' : ''} onClick={() => setWhich(i)}>{label(u)}</button>)}
              </div>
            )}
            <div className="mono break-all rounded border px-2 py-1" style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}>{url.replace(/#token=.*/, '#token=••••••••')}</div>
            <div className="flex flex-wrap gap-1.5">
              <button className="btn btn-sm" onClick={() => copy(url, 'Phone link')}>Copy link</button>
              <button className="btn btn-sm" onClick={() => copy(st.token, 'Token')}>Copy token</button>
              <button className="btn btn-sm" disabled={busy} title="Invalidates the link on every paired phone" onClick={async () => { setBusy(true); try { setSt(await window.api.invoke('phone:rotateToken')); toast('success', 'New token issued; scan again on your phone') } finally { setBusy(false) } }}>Rotate token</button>
            </div>
            {st.clients.length > 0 && (
              <div className="muted">Connected: {st.clients.map((c) => `${c.address} (${ago(c.since)})`).join(', ')}</div>
            )}
            <div className="muted">The link carries the access token; the phone stores it and hides it from the address bar. Install <a className="underline" href="https://tailscale.com/download" onClick={(e) => { e.preventDefault(); void window.api.invoke('shell:open', 'https://tailscale.com/download') }}>Tailscale</a> on this Mac and the phone to connect from anywhere. This Mac must stay awake.</div>
          </div>
        </div>
      )}
      {!st.running && !st.error && (
        <div className="muted text-[10px]">Serves the same UI to a browser on your phone through this app. AWS credentials never leave this Mac; the phone only holds a gateway token. Bound to your Tailscale address by default; never expose the port to the internet.</div>
      )}
    </div>
  )
}

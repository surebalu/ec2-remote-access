import type { ReactElement } from 'react'
import { useStore } from '../store'
import Modal from './Modal'

/** Shown while a Refresh-token / sign-in device flow waits for the browser. */
export default function SsoWaitDialog(): ReactElement | null {
  const s = useStore()
  const w = s.ssoWait
  if (!w) return null
  // On a phone the page opened on the phone (or was blocked as a pop-up); the wording and buttons follow that.
  const remote = !/\bElectron\//.test(navigator.userAgent)
  const close = (): void => {
    void window.api.invoke('sso:cancel', w.flow.flowId)
    s.set({ ssoWait: null, loggingIn: false })
  }
  return (
    <Modal title={`Sign in to AWS · ${w.session}`} onClose={close} width="max-w-md">
      <div className="flex flex-col items-center gap-3 py-2 text-center">
        <div className="muted text-[12px]">
          {remote ? 'Sign in on the AWS page and approve this code. If the page did not open, tap Open sign-in page.' : 'Approve the request in your browser. If it didn\'t open, visit'}{' '}
          {!remote && <><span className="mono">{w.flow.verificationUri}</span> and enter:</>}
        </div>
        <div className="mono rounded-lg border px-4 py-2 text-2xl font-semibold tracking-[.3em]" style={{ borderColor: 'var(--border)' }}>
          {w.flow.userCode}
        </div>
        <div className="flex gap-2">
          <button className={`btn ${remote ? 'btn-primary' : ''}`} onClick={() => void window.api.invoke('shell:open', w.flow.verificationUriComplete)}>
            {remote ? 'Open sign-in page' : 'Open browser again'}
          </button>
          <button className="btn" onClick={() => void window.api.invoke('clipboard:write', w.flow.userCode).then(() => s.toast('success', 'Code copied'))}>
            Copy code
          </button>
        </div>
        {w.error ? (
          <div className="text-[12px]" style={{ color: 'var(--err)' }}>
            {w.error}
          </div>
        ) : (
          <div className="muted flex items-center gap-2 text-[11px]">
            <span className="dot" style={{ background: 'var(--warn)', animation: 'pulse 1.2s infinite' }} /> Waiting for approval…
          </div>
        )}
        <button className="btn btn-ghost btn-sm" onClick={close}>
          {w.error ? 'Close' : 'Cancel'}
        </button>
      </div>
    </Modal>
  )
}

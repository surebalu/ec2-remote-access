import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import { allInstances, useStore } from '../store'
import Modal from './Modal'

export default function PasswordDialog(): ReactElement | null {
  const s = useStore()
  const key = s.passwordFor!
  const inst = allInstances(s).find((i) => i.key === key)
  const [pem, setPem] = useState(s.settings?.pemFile ?? '')
  const [result, setResult] = useState<{ password?: string; error?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [show, setShow] = useState(false)
  const close = (): void => s.set({ passwordFor: null })

  const fetch = async (): Promise<void> => {
    setBusy(true)
    setResult(null)
    try {
      const r = await window.api.invoke('ec2:password', key, pem || undefined)
      setResult(r)
      if (r.password && pem && pem !== s.settings?.pemFile) await s.saveSettings({ pemFile: pem })
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    if (pem) void fetch()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (!inst) return null
  return (
    <Modal title={`Windows password → ${inst.name}`} onClose={close}>
      <div className="muted mb-3 text-[11px]">
        Decrypts EC2 GetPasswordData locally with the key pair private key. Instance key pair: <b>{inst.keyName ?? 'unknown'}</b>
      </div>
      <div className="flex gap-1">
        <input className="input" placeholder="/path/to/keypair.pem" value={pem} onChange={(e) => setPem(e.target.value)} />
        <button
          className="btn"
          onClick={async () => {
            const f = await window.api.invoke('dialog:pickFile', 'Choose key pair .pem')
            if (f) setPem(f)
          }}
        >
          …
        </button>
        <button className="btn btn-primary" disabled={busy || !pem} onClick={() => void fetch()}>
          {busy ? '…' : 'Fetch'}
        </button>
      </div>
      {result?.error && <div className="mt-3 text-red-500">{result.error}</div>}
      {result?.password && (
        <div className="mt-3 flex items-center gap-2">
          <code className="panel flex-1 select-text rounded border px-2 py-1 font-mono">{show ? result.password : '•'.repeat(Math.min(result.password.length, 24))}</code>
          <button className="btn" onClick={() => setShow(!show)}>
            {show ? 'Hide' : 'Show'}
          </button>
          <button
            className="btn btn-primary"
            onClick={async () => {
              await window.api.invoke('clipboard:write', result.password!)
              s.toast('success', 'Password copied')
            }}
          >
            Copy
          </button>
        </div>
      )}
    </Modal>
  )
}

import { useEffect, useState, type ReactElement } from 'react'
import type { BoxSetup } from '@shared/setup'
import { useStore } from '../store'

/**
 * The setups other Macs keep in Box (setup:boxList; boxSync.ts writes each Mac's own), as buttons that open Import
 * setup's preview for one (setup:fromBox). Shown on the welcome screen and in Settings → Data once Box is signed in.
 */
export default function BoxSetups({ signedIn }: { signedIn: boolean }): ReactElement | null {
  const [list, setList] = useState<BoxSetup[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!signedIn) { setList(null); return }
    let gone = false
    void window.api.invoke('setup:boxList').then((l) => { if (!gone) { setList(l); setError(null) } }, (e: Error) => { if (!gone) setError(e.message) })
    return () => { gone = true }
  }, [signedIn])
  if (!signedIn) return null
  if (error) return <span className="set-key-error text-[12px]">{error}</span>
  if (!list) return <span className="muted text-[12px]">Looking in Box…</span>
  const others = list.filter((x) => !x.mine)
  if (!others.length) return <span className="muted text-[12px]">No other Mac has put its setup in Box yet: it does once it signs in to Box (Settings → Data).</span>
  return (
    <div className="box-setups">
      {others.map((x) => (
        <button key={x.id} type="button" className="btn" onClick={() => void useStore.getState().importSetupFromBox(x.id)}>
          Bring the setup from <b>{x.computer}</b>{x.exportedAt ? <span className="muted"> · {new Date(x.exportedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span> : null}
        </button>
      ))}
    </div>
  )
}

import { useEffect, useState } from 'react'
import type { BoxStatus } from '@shared/box'
import { hasBrowser } from './quickConnect'
import { useStore } from './store'

/**
 * Box sync for the page (Settings → Data, the phone's More sheet): the status main pushes (box:status), and signing
 * in. The Mac app opens the browser itself. Anywhere else the page opens Box from a tap, and a browser blocks a window
 * opened after the tap has waited on the network, so the sign-in address is asked for ahead and shown as a link.
 */
export function useBox(): { st: BoxStatus | null; link: string | null; note: string | null; waiting: boolean; signIn: () => void; signOut: () => void; sync: () => void } {
  const [st, setSt] = useState<BoxStatus | null>(null)
  const [link, setLink] = useState<string | null>(null)
  /** Why there is no sign-in link here (a page paired with the Mac, which signs in on its own screen; plain http). */
  const [note, setNote] = useState<string | null>(null)
  const [waiting, setWaiting] = useState(false)
  const onMac = hasBrowser()
  useEffect(() => {
    void window.api.invoke('box:status').then(setSt, () => undefined)
    return window.api.on('box:status', (s) => { setSt(s); if (s.signedIn) setWaiting(false) })
  }, [])
  useEffect(() => {
    if (onMac || !st?.available || st.signedIn) return
    let gone = false
    // A sign-in waits ten minutes for Box's answer; a fresh address before then.
    const get = (): void => void window.api.invoke('box:signIn', location.origin).then((r) => { if (!gone) { setLink(r.url); setNote(null) } }, (e: Error) => { if (!gone) { setLink(null); setNote(e.message) } })
    get()
    const t = setInterval(get, 8 * 60_000)
    return () => { gone = true; clearInterval(t) }
  }, [onMac, st?.available, st?.signedIn])
  const toast = (e: Error): void => useStore.getState().toast('error', e.message)
  return {
    st, link, note, waiting,
    signIn: () => { setWaiting(true); void window.api.invoke('box:signIn').catch((e: Error) => { setWaiting(false); toast(e) }) },
    signOut: () => { if (window.confirm('Sign this computer out of Box? Its own copy stays; nothing in Box is deleted.')) void window.api.invoke('box:signOut').then(setSt, toast) },
    sync: () => void window.api.invoke('box:sync').then(setSt, toast)
  }
}

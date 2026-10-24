import { useEffect, useState } from 'react'

/**
 * A page served by a gateway (phone, iPad, another browser) outlives updates: the iOS app keeps it in memory and
 * reconnects its socket when the gateway restarts, but the files it loads on demand (a screen-sharing tab, the CAD
 * viewer) belong to the build it started with, and an update removes them. So:
 *
 *   - the gateway names its build in its hello (`assets/index-<hash>.js`); a page whose own entry script differs is
 *     stale: it reloads by itself when no remote session is open (nothing to lose), otherwise it offers a reload;
 *   - a part that fails to load (Vite's `vite:preloadError`) reloads the page, at most once a minute so a real outage
 *     cannot loop it.
 *
 * The Mac app's own window is never stale (an update restarts it), so none of this runs there.
 */

const RELOADED_AT = 'ui.updateReloadAt'
let stale = false
const listeners = new Set<(on: boolean) => void>()

/** This page's build: the file name of its entry script. */
export function pageBuild(): string {
  const src = document.querySelector<HTMLScriptElement>('script[type="module"][src*="assets/index-"]')?.src ?? ''
  return /assets\/(index-[\w-]+\.js)/.exec(src)?.[1] ?? ''
}

/** Reloads unless this page already did so in the last minute (then the problem is not staleness). */
export function reloadOnce(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOADED_AT) ?? 0)
    if (Date.now() - last < 60_000) return false
    sessionStorage.setItem(RELOADED_AT, String(Date.now()))
  } catch { /* storage unavailable: reload anyway */ }
  location.reload()
  return true
}

/**
 * Called with the gateway's build on every (re)connect. `hasSessions` says whether a reload would cost the user
 * anything (open terminals and screens are dropped by a reload).
 */
export function noteServerBuild(server: string | undefined, hasSessions: () => boolean): void {
  const mine = pageBuild()
  if (!server || !mine || server === mine) return
  if (!hasSessions() && reloadOnce()) return
  stale = true
  for (const cb of listeners) cb(true)
}

export function watchChunkFailures(): void {
  window.addEventListener('vite:preloadError', (e) => {
    // Without a reload the import's own error surfaces as a broken part of the page.
    if (reloadOnce()) e.preventDefault()
  })
}

/** Whether a newer version is waiting for a reload (for UpdateBanner). */
export function useUpdateReady(): boolean {
  const [on, setOn] = useState(stale)
  useEffect(() => {
    listeners.add(setOn)
    return () => { listeners.delete(setOn) }
  }, [])
  return on
}

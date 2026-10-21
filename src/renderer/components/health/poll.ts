import { hasBrowser } from '../../quickConnect'

/**
 * Whether a Health reading may run now. The Mac app keeps reading while its window is behind others, minimised or on
 * another screen: macOS reports such a window as hidden, and a dashboard left on a second display went stale until
 * Refresh. A phone or tablet page still waits until it is on screen (battery, and iOS suspends it anyway).
 */
export const mayPoll = (): boolean => hasBrowser() || document.visibilityState === 'visible'

/** Runs `fn` when the window comes back to the front (focus, or the page showing again). */
export function onReturn(fn: () => void): () => void {
  const go = (): void => { if (document.visibilityState === 'visible') fn() }
  window.addEventListener('focus', go)
  document.addEventListener('visibilitychange', go)
  return () => {
    window.removeEventListener('focus', go)
    document.removeEventListener('visibilitychange', go)
  }
}

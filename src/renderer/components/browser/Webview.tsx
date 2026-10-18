import type { ReactElement } from 'react'
import { useEffect, useRef } from 'react'

/** The parts of Electron's <webview> element the browser uses. */
export interface WebviewEl extends HTMLElement {
  loadURL(url: string): Promise<void>
  getURL(): string
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  reloadIgnoringCache(): void
  getWebContentsId(): number
  findInPage(text: string, options?: { forward?: boolean; findNext?: boolean }): number
  stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void
  setZoomFactor(factor: number): void
}

export interface WebviewEvents {
  onNavigate: (tabId: string, url: string, inPage: boolean) => void
  onTitle: (tabId: string, title: string) => void
  onFavicon: (tabId: string, url: string) => void
  onLoading: (tabId: string, loading: boolean) => void
  onFail: (tabId: string, error: { code: number; description: string; url: string }) => void
  onFound: (tabId: string, active: number, matches: number) => void
  onReady: (tabId: string, el: WebviewEl) => void
}

/**
 * One page. The <webview> is created imperatively and never re-rendered by React: setting `src` again would reload it,
 * so later navigation goes through `loadURL`. Its partition (the space's cookie container) cannot change once
 * attached, which is why the host keys this component on the space. Hidden tabs stay laid out (visibility, not
 * display) so they keep their size and state.
 */
export default function Webview({ tabId, partition, src, visible, events, register }: {
  tabId: string
  partition: string
  src: string
  visible: boolean
  events: WebviewEvents
  register: (tabId: string, el: WebviewEl | null) => void
}): ReactElement {
  const host = useRef<HTMLDivElement>(null)
  const ev = useRef(events)
  ev.current = events

  useEffect(() => {
    const el = document.createElement('webview') as WebviewEl
    el.setAttribute('partition', partition)
    el.setAttribute('allowpopups', '')
    el.setAttribute('src', src || 'about:blank')
    el.className = 'web-view'
    type Detail = { url: string; isMainFrame: boolean; title: string; favicons: string[]; errorCode: number; errorDescription: string; validatedURL: string; result: { activeMatchOrdinal: number; matches: number } }
    const on = (name: string, fn: (d: Detail) => void): void => el.addEventListener(name, (e) => fn(e as unknown as Detail))
    on('did-navigate', (d) => ev.current.onNavigate(tabId, d.url, false))
    on('did-navigate-in-page', (d) => { if (d.isMainFrame) ev.current.onNavigate(tabId, d.url, true) })
    on('page-title-updated', (d) => ev.current.onTitle(tabId, d.title))
    on('page-favicon-updated', (d) => { if (d.favicons?.[0]) ev.current.onFavicon(tabId, d.favicons[0]) })
    on('did-start-loading', () => ev.current.onLoading(tabId, true))
    on('did-stop-loading', () => ev.current.onLoading(tabId, false))
    // -3 is an aborted load (a redirect or a newer navigation), not a failure.
    on('did-fail-load', (d) => { if (d.isMainFrame && d.errorCode !== -3) ev.current.onFail(tabId, { code: d.errorCode, description: d.errorDescription, url: d.validatedURL }) })
    on('found-in-page', (d) => ev.current.onFound(tabId, d.result.activeMatchOrdinal, d.result.matches))
    on('did-attach', () => ev.current.onReady(tabId, el))
    on('dom-ready', () => ev.current.onReady(tabId, el))
    host.current!.appendChild(el)
    register(tabId, el)
    return () => {
      register(tabId, null)
      el.remove()
    }
  }, [partition]) // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={host} className={`web-host ${visible ? 'on' : ''}`} />
}

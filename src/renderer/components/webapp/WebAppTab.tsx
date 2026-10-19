import type { CSSProperties, ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useStore, type Tab } from '../../store'
import { replayPageKey, setTabKeys, terminalAction, type TabKey } from '../../shortcuts'
import { findInAllPanes } from '../../paneFind'
import { ownPage, plainChromeAgent, staysInApp, WEB_APPS, type WebAppKind } from '../../webApps'
import Webview, { type WebviewEl, type WebviewEvents } from '../browser/Webview'
import OnePassword from '../browser/OnePassword'
import Popover, { MenuItem, MenuSep } from '../Popover'
import { Icon } from '../icons'

/** Webview methods throw before the page's first dom-ready and while it is being torn down. */
function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

const lastUrlKey = (kind: WebAppKind): string => `webapp.${kind}.url`

/** The chat it was showing last time (a page of the app's own site), else a new chat. */
function startUrl(kind: WebAppKind): string {
  const app = WEB_APPS[kind]
  try {
    const u = localStorage.getItem(lastUrlKey(kind)) ?? ''
    return u && ownPage(app, u) ? u : app.home
  } catch {
    return app.home
  }
}

const AGENT = plainChromeAgent(navigator.userAgent)

interface PageState {
  url: string
  title: string
  loading: boolean
  back: boolean
  fwd: boolean
  error?: string
}

/**
 * Claude or ChatGPT on the app rail: the site in one page of its own (its own partition, so it stays signed in apart
 * from the Browser's spaces), with back, forward, reload and New chat. Links that leave the site open in the Browser;
 * the site's own pages and its sign-in pages stay here. Beside a terminal, a selection's context menu pastes into it.
 */
export default function WebAppTab({ tab, active }: { tab: Tab; active: boolean }): ReactElement {
  const kind = tab.kind as WebAppKind
  const app = WEB_APPS[kind]
  const [src] = useState(() => startUrl(kind))
  const [page, setPage] = useState<PageState>({ url: src, title: '', loading: true, back: false, fwd: false })
  const [menu, setMenu] = useState<{ kind: 'more' | 'fill'; anchor: HTMLElement } | null>(null)
  const view = useRef<WebviewEl | null>(null)
  const moreBtn = useRef<HTMLButtonElement>(null)
  const inFront = useStore((s) => !s.gridView && s.activeTab === tab.id)
  const toast = useStore((s) => s.toast)

  const act = (fn: (v: WebviewEl) => void): void => {
    const v = view.current
    if (v) safely(() => fn(v), undefined)
  }
  const navigate = (url: string): void => act((v) => {
    try {
      v.loadURL(url).catch(() => undefined)
    } catch {
      v.setAttribute('src', url)
    }
  })
  const history = (): Pick<PageState, 'back' | 'fwd'> => {
    const v = view.current
    return { back: !!v && safely(() => v.canGoBack(), false), fwd: !!v && safely(() => v.canGoForward(), false) }
  }
  const wcId = (): number => safely(() => view.current?.getWebContentsId() ?? -1, -1)

  const events: WebviewEvents = {
    onNavigate: (_id, url) => {
      setPage((p) => ({ ...p, url, error: undefined, ...history() }))
      if (ownPage(app, url)) {
        try { localStorage.setItem(lastUrlKey(kind), url) } catch { /* storage off: next time starts a new chat */ }
      }
    },
    onTitle: (_id, title) => setPage((p) => ({ ...p, title })),
    onFavicon: () => undefined,
    onLoading: (_id, loading) => setPage((p) => ({ ...p, loading, ...(loading ? {} : history()) })),
    onFail: (_id, error) => setPage((p) => ({ ...p, loading: false, error: error.description || `Error ${error.code}` })),
    onFound: () => undefined,
    onReady: () => setPage((p) => ({ ...p, ...history() }))
  }

  const newChat = (): void => navigate(app.home)
  const openFill = (anchor?: HTMLElement | null): void => {
    const a = anchor ?? moreBtn.current
    if (a) setMenu({ kind: 'fill', anchor: a })
  }
  const addToNote = (url: string, title: string): void => {
    const label = (title || app.name).replace(/[[\]]/g, '')
    window.api.invoke('notes:daily').then(async (path) => {
      await window.api.invoke('notes:append', path, `- [${label}](${url})`)
      toast('success', 'Added to today’s note')
    }).catch((e: Error) => toast('error', e.message))
  }

  // ----- keyboard (while this tab is in front; keys from inside the page arrive through web:shortcut) -----
  const onKey = (k: TabKey): boolean => {
    if (k.ctrl || k.alt) return false
    switch (k.key) {
      case 'r':
        act((v) => (k.shift ? v.reloadIgnoringCache() : v.reload()))
        return true
      case '[':
      case ']':
        if (k.shift) return false
        act((v) => (k.key === '[' ? v.goBack() : v.goForward()))
        return true
      case 'n':
        if (k.shift) return false
        newChat()
        return true
    }
    return false
  }
  const keyRef = useRef(onKey)
  keyRef.current = onKey
  useEffect(() => {
    if (!active) return
    setTabKeys(kind, (k) => keyRef.current(k))
    return () => setTabKeys(kind, null)
  }, [active, kind])

  // Brought to the front (its rail button or shortcut), the page takes the keyboard so you can type straight away.
  useEffect(() => {
    if (!inFront) return
    const t = setTimeout(() => act((v) => v.focus()), 0)
    return () => clearTimeout(t)
  }, [inFront]) // eslint-disable-line react-hooks/exhaustive-deps

  // The tile head of a split names the chat.
  const shownTitle = page.title.replace(new RegExp(`\\s*[-|–—]\\s*${app.name}$`), '').replace(new RegExp(`^${app.name}$`), '')
  useEffect(() => {
    if ((tab.message ?? '') !== shownTitle) useStore.getState().updateTab(tab.id, { message: shownTitle || undefined })
  }, [shownTitle]) // eslint-disable-line react-hooks/exhaustive-deps

  // ----- events from the page (main/webviews.ts) -----
  useEffect(() => {
    const offs = [
      window.api.on('web:shortcut', (d) => { if (d.webContentsId === wcId()) replayPageKey(d) }),
      window.api.on('web:window', (d) => {
        if (d.webContentsId !== wcId()) return
        if (staysInApp(app, d.url)) navigate(d.url)
        else useStore.getState().openBrowser({ url: d.url })
      }),
      window.api.on('web:pointer', (d) => {
        if (d.webContentsId !== wcId()) return
        setMenu(null)
        const s = useStore.getState()
        if (s.splitGroup.includes(tab.id)) s.focusPane(tab.id)
      }),
      window.api.on('web:menu', (d) => {
        if (d.webContentsId !== wcId()) return
        if (d.action === 'note') addToNote(d.url, d.title)
        else if (d.action === 'fill') openFill()
        else if (d.action === 'paste' && d.text && d.target) terminalAction(d.target, 'paste', d.text)
        else if (d.action === 'find' && d.text) findInAllPanes(d.text)
      })
    ]
    return () => offs.forEach((off) => off())
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const AppIcon = kind === 'claude' ? Icon.claude : Icon.chatgpt
  return (
    <div className="webapp" data-webapp={kind}>
      <div className="webapp-bar">
        <span className="fi-nav">
          <button type="button" className="fi-btn" aria-label="Back" title="Back (⌘[)" disabled={!page.back} onClick={() => act((v) => v.goBack())}><Icon.back /></button>
          <button type="button" className="fi-btn" aria-label="Forward" title="Forward (⌘])" disabled={!page.fwd} onClick={() => act((v) => v.goForward())}><Icon.forward /></button>
        </span>
        <button type="button" className="fi-btn" aria-label="Reload" title="Reload (⌘R)" onClick={() => act((v) => v.reload())}>
          {page.loading ? <span className="web-spinner" style={{ '--c': 'var(--accent)' } as CSSProperties} /> : <Icon.refresh />}
        </button>
        <span className="webapp-title">
          <AppIcon className="webapp-logo" />
          <b>{app.name}</b>
          {shownTitle && <span className="muted truncate">{shownTitle}</span>}
        </span>
        <button type="button" className="btn btn-sm webapp-new" title="Start a new chat (⌘N)" onClick={newChat}><Icon.plus /><span className="webapp-new-label">New chat</span></button>
        <button ref={moreBtn} type="button" className="fi-btn" aria-label={`${app.name} options`} onClick={(e) => setMenu(menu ? null : { kind: 'more', anchor: e.currentTarget })}><Icon.more /></button>
      </div>
      <div className="webapp-page">
        <Webview tabId={tab.id} partition={app.partition} src={src} visible events={events} userAgent={AGENT} register={(_id, el) => { view.current = el }} />
        {page.error && (
          <div className="webapp-error">
            <AppIcon className="webapp-error-logo" />
            <div className="font-semibold">{app.name} did not load</div>
            <div className="muted text-[12px]">{page.error}</div>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => { setPage((p) => ({ ...p, error: undefined })); navigate(page.url || app.home) }}>Try again</button>
          </div>
        )}
      </div>
      {menu?.kind === 'more' && (
        <Popover anchor={menu.anchor} align="right" width={240} onClose={() => setMenu(null)}>
          <MenuItem onClick={() => { setMenu(null); newChat() }} hint="⌘N">New chat</MenuItem>
          <MenuItem onClick={() => { setMenu(null); act((v) => v.reload()) }} hint="⌘R">Reload</MenuItem>
          <MenuSep />
          <MenuItem onClick={() => { setMenu(null); void window.api.invoke('clipboard:write', page.url).then(() => toast('success', 'Link copied')) }}>Copy link</MenuItem>
          <MenuItem onClick={() => { setMenu(null); addToNote(page.url, shownTitle) }}>Add to today’s note</MenuItem>
          <MenuItem onClick={() => { setMenu(null); void window.api.invoke('shell:open', page.url) }}>Open in your browser</MenuItem>
          <MenuItem onClick={() => openFill(moreBtn.current)}>Fill a login from 1Password…</MenuItem>
          <MenuSep />
          <div className="muted px-3 pb-1.5 pt-0.5 text-[10.5px] leading-snug">{app.name} keeps its own sign-in, apart from the Browser’s spaces. Links to other sites open in the Browser.</div>
        </Popover>
      )}
      {menu?.kind === 'fill' && (
        <Popover anchor={menu.anchor} align="right" width={320} onClose={() => setMenu(null)}>
          <OnePassword pageUrl={page.url} webContentsId={wcId()} onDone={() => { setMenu(null); act((v) => v.focus()) }} />
        </Popover>
      )}
    </div>
  )
}

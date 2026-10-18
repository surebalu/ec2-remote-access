import type { DragEvent, ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AccentColor, BrowserState, WebSpace, WebTab } from '@shared/types'
import {
  consoleHome, frequentSites, hostOf, isAwsConsoleUrl, isAwsSignInPage, isFederationUrl, matchesWords, normalizeInput,
  partitionFor, restorableUrl, searchHistory, signInDestination, spaceIdForProfile
} from '@shared/browser'
import { useStore, type Tab } from '../../store'
import { ACCENTS, metaFor } from '../../colors'
import { setBrowserKeys, type BrowserKey } from '../../shortcuts'
import { Icon } from '../icons'
import Popover, { MenuItem, MenuLabel, MenuSep } from '../Popover'
import Webview, { type WebviewEl, type WebviewEvents } from './Webview'
import CommandBar, { type Suggestion } from './CommandBar'
import StartPage from './StartPage'
import { Favicon, ServiceBadge, SPACE_SERVICES, SpaceAvatar, type Space } from './parts'

/**
 * The built-in browser, laid out like Arc: a sidebar tinted with the space's colour (address, pinned favorites, the
 * space's tabs, the space switcher) beside the page. A space is a cookie container (partition); every AWS account
 * gets one that signs itself in to that account's console with the profile's SSO credentials (main/browser.ts), so
 * several accounts stay signed in side by side. Pages are Electron <webview>s, locked down in main/webviews.ts.
 */

const GENERAL: WebSpace = { id: 'general', name: 'General', color: 'sky' }
/** Pages kept loaded at once; older tabs are put to sleep and reload when shown again. */
const MAX_LIVE = 12
const ZOOMS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]
const MAX_HISTORY = 1500
const inElectron = /\bElectron\//.test(navigator.userAgent)

const newId = (): string => `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/**
 * A <webview>'s methods throw until its first dom-ready and after its page is gone (events can still arrive while a
 * closed tab's page is torn down), so every call goes through here.
 */
function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

/** Navigates a page; one that is not ready for loadURL yet takes the address as its src. */
function navigate(v: WebviewEl, url: string): void {
  try {
    v.loadURL(url).catch(() => undefined)
  } catch {
    v.setAttribute('src', url)
  }
}

interface Runtime {
  loading?: boolean
  error?: { code: number; description: string; url: string }
  /** Why the AWS console sign-in failed, and the page it was for (to retry). */
  auth?: string
  authDest?: string
  /** Between a console sign-in starting and its page arriving: hides AWS's sign-in page flashing by. */
  signingIn?: boolean
  back?: boolean
  fwd?: boolean
  zoom?: number
}

type MenuState =
  | { kind: 'tab'; id: string; anchor: HTMLElement }
  | { kind: 'space'; id: string; anchor: HTMLElement }
  | { kind: 'page'; anchor: HTMLElement }
  | { kind: 'newSpace'; anchor: HTMLElement; edit?: string }

function initialState(saved: BrowserState | null): BrowserState {
  const s = saved ?? { spaces: [GENERAL], tabs: [], activeSpace: GENERAL.id, activeTab: {}, history: [] }
  return {
    ...s,
    spaces: s.spaces?.length ? s.spaces : [GENERAL],
    tabs: (s.tabs ?? []).map((t) => ({ ...t, url: restorableUrl(t.url) })),
    activeTab: s.activeTab ?? {},
    history: s.history ?? [],
    favicons: s.favicons ?? {}
  }
}

export default function BrowserTab({ tab, active }: { tab: Tab; active: boolean }): ReactElement {
  if (!inElectron) {
    return (
      <div className="browser-unavailable">
        <Icon.globe />
        <div className="text-[15px] font-semibold">The browser lives in the Mac app</div>
        <p className="muted">Web pages and AWS console spaces open in EC2 Remote Access on your Mac. Here, links open in your own browser.</p>
      </div>
    )
  }
  return <Browser tab={tab} active={active} />
}

function Browser({ active }: { tab: Tab; active: boolean }): ReactElement {
  const profiles = useStore((s) => s.profiles)
  const settings = useStore((s) => s.settings)
  const statuses = useStore((s) => s.statuses)
  const request = useStore((s) => s.browserRequest)
  const toast = useStore((s) => s.toast)

  const [st, setSt] = useState<BrowserState | null>(null)
  const [rt, setRt] = useState<Record<string, Runtime>>({})
  const [live, setLive] = useState<string[]>([])
  const [cmd, setCmd] = useState<{ mode: 'new' | 'edit'; query: string; nonce: number } | null>(null)
  const [find, setFind] = useState<{ text: string; active: number; matches: number } | null>(null)
  const [peek, setPeek] = useState(false)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [drop, setDrop] = useState<{ target: string; where: 'before' | 'after' | 'on' } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [spaceDraft, setSpaceDraft] = useState<{ name: string; color: AccentColor }>({ name: '', color: 'violet' })
  /** Bumped to focus the start page's command bar (⌘T / ⌘L while it shows). */
  const [startFocus, setStartFocus] = useState(0)

  const views = useRef(new Map<string, WebviewEl>())
  const wcTab = useRef(new Map<number, string>())
  /** The address a not-yet-mounted page starts on (a console sign-in link is never kept as the tab's address). */
  const pending = useRef(new Map<string, string>())
  const federated = useRef(new Set<string>())
  const lastAutoSignIn = useRef(new Map<string, number>())
  const closed = useRef<{ tab: WebTab; index: number }[]>([])
  const dragId = useRef<string | null>(null)
  const findInput = useRef<HTMLInputElement>(null)
  const handledRequest = useRef<number | null>(null)
  /** Mount order of the pages. React moves keyed nodes when a list reorders, and moving a <webview> reloads it. */
  const mountOrder = useRef<string[]>([])

  // ----- state, spaces, persistence -----

  useEffect(() => {
    window.api.invoke('browser:load').then((s) => setSt(initialState(s)), () => setSt(initialState(null)))
  }, [])
  useEffect(() => {
    if (!st) return
    const t = setTimeout(() => void window.api.invoke('browser:save', st).catch(() => undefined), 600)
    return () => clearTimeout(t)
  }, [st])

  const awsSpaces = useMemo<Space[]>(() => profiles
    .filter((p) => p.enabled && p.kind !== 'static')
    .map((p) => {
      const m = metaFor(p.name, settings)
      return { id: spaceIdForProfile(p.name), name: m.label, color: m.color, profile: p.name, region: p.region, accountId: statuses[p.name]?.accountId ?? p.accountId }
    }), [profiles, settings, statuses])
  const spaces = useMemo<Space[]>(() => [...(st?.spaces ?? [GENERAL]), ...awsSpaces], [st?.spaces, awsSpaces])
  const space = spaces.find((x) => x.id === st?.activeSpace) ?? spaces[0]
  const spaceTabs = st ? st.tabs.filter((t) => t.spaceId === space.id) : []
  const pinned = spaceTabs.filter((t) => t.pinned)
  const today = spaceTabs.filter((t) => !t.pinned)
  const current = spaceTabs.find((t) => t.id === st?.activeTab[space.id])
  const cur = current ? rt[current.id] ?? {} : {}
  const showStart = !current || (!current.url && !cur.signingIn && !cur.auth)

  const stRef = useRef(st)
  stRef.current = st
  const spacesRef = useRef(spaces)
  spacesRef.current = spaces
  const currentRef = useRef(current)
  currentRef.current = current

  const update = useCallback((fn: (s: BrowserState) => BrowserState) => setSt((s) => (s ? fn(s) : s)), [])
  const patchTab = (id: string, patch: Partial<WebTab>): void => update((s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))
  const patchRt = (id: string, patch: Partial<Runtime>): void => setRt((r) => ({ ...r, [id]: { ...r[id], ...patch } }))
  const touchLive = (id: string): void => setLive((l) => (l[0] === id ? l : [id, ...l.filter((x) => x !== id)].slice(0, MAX_LIVE)))
  const spaceOf = (id: string): Space | undefined => spacesRef.current.find((x) => x.id === id)
  const findTab = (id: string): WebTab | undefined => stRef.current?.tabs.find((t) => t.id === id)
  /** The tab showing a page (by its webContents id, as main reports it); asks the pages when it is not known yet. */
  const tabForWc = (wcId: number): string | undefined => {
    const known = wcTab.current.get(wcId)
    if (known) return known
    for (const [id, v] of views.current) {
      try {
        if (v.getWebContentsId() === wcId) {
          wcTab.current.set(wcId, id)
          return id
        }
      } catch { /* not attached yet */ }
    }
    return undefined
  }

  useEffect(() => {
    if (current?.url) touchLive(current.id)
  }, [current?.id, !!current?.url]) // eslint-disable-line react-hooks/exhaustive-deps

  // Give the page the keyboard when its tab comes forward.
  useEffect(() => {
    if (!active || !current || cmd) return
    const t = setTimeout(() => views.current.get(current.id)?.focus(), 30)
    return () => clearTimeout(t)
  }, [active, current?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // ----- navigation -----

  const signIn = async (sp: Space, destination: string, tabId: string): Promise<string | null> => {
    try {
      const url = await window.api.invoke('browser:consoleUrl', sp.profile!, destination)
      federated.current.add(sp.id)
      patchRt(tabId, { auth: undefined, authDest: undefined })
      return url
    } catch (e) {
      patchRt(tabId, { auth: (e as Error).message, authDest: destination, loading: false, signingIn: false })
      return null
    }
  }

  /** Loads `raw` in a tab; an AWS space's first console page of the run goes through a fresh console sign-in. */
  const loadInto = async (id: string, spaceId: string, raw: string): Promise<void> => {
    const sp = spaceOf(spaceId)
    let url = raw
    patchRt(id, { error: undefined, auth: undefined })
    if (sp?.profile && isAwsConsoleUrl(raw) && !federated.current.has(sp.id)) {
      patchRt(id, { signingIn: true, loading: true })
      const signed = await signIn(sp, raw, id)
      if (!signed) return
      url = signed
    }
    const v = views.current.get(id)
    if (v) navigate(v, url)
    else {
      pending.current.set(id, url)
      patchTab(id, { url: raw, ...(findTab(id)?.url ? {} : { title: hostOf(raw) }) })
    }
    touchLive(id)
  }

  const reSignIn = async (id: string, sp: Space, url: string): Promise<void> => {
    const dest = signInDestination(url) ?? consoleHome(sp.region ?? 'us-east-1')
    const now = Date.now()
    // A console that asks again right after a sign-in will keep asking: stop and say so instead of looping.
    if (now - (lastAutoSignIn.current.get(id) ?? 0) < 30_000) {
      patchRt(id, { auth: `The ${sp.name} console asked to sign in again straight after signing in. Your AWS role may not allow console access.`, authDest: dest, signingIn: false, loading: false })
      return
    }
    lastAutoSignIn.current.set(id, now)
    federated.current.delete(sp.id)
    patchRt(id, { signingIn: true })
    const signed = await signIn(sp, dest, id)
    const v = views.current.get(id)
    if (signed && v) navigate(v, signed)
  }

  const newTab = (spaceId: string, opts: { background?: boolean; after?: string } = {}): string => {
    const id = newId()
    const t: WebTab = { id, spaceId, url: '', title: 'New Tab', lastActive: Date.now() }
    update((s) => {
      const tabs = s.tabs.slice()
      // Like Arc, new tabs go to the top of the space's list; tabs a page opens go right below it.
      let at = opts.after ? tabs.findIndex((x) => x.id === opts.after) + 1 : tabs.findIndex((x) => x.spaceId === spaceId && !x.pinned)
      if (at <= 0 && !opts.after) at = tabs.findIndex((x) => x.spaceId === spaceId && !x.pinned)
      tabs.splice(at < 0 ? tabs.length : at, 0, t)
      return { ...s, tabs, ...(opts.background ? {} : { activeSpace: spaceId, activeTab: { ...s.activeTab, [spaceId]: id } }) }
    })
    return id
  }
  const openInNewTab = (spaceId: string, url: string, opts: { background?: boolean; after?: string } = {}): void => {
    const id = newTab(spaceId, opts)
    void loadInto(id, spaceId, url)
  }
  /** Opens `url` from the command bar or start page: in the current tab, or a new one (reusing an empty new tab). */
  const go = (url: string, toNew: boolean, spaceId = stRef.current?.activeSpace ?? GENERAL.id): void => {
    const c = currentRef.current
    if (c && c.spaceId === spaceId && (!toNew || !c.url)) {
      void loadInto(c.id, c.spaceId, url)
      setTimeout(() => views.current.get(c.id)?.focus(), 50)
    } else openInNewTab(spaceId, url)
  }

  const activate = (id: string): void => {
    const t = findTab(id)
    if (!t) return
    update((s) => ({ ...s, activeSpace: t.spaceId, activeTab: { ...s.activeTab, [t.spaceId]: id }, tabs: s.tabs.map((x) => (x.id === id ? { ...x, lastActive: Date.now() } : x)) }))
    setFind(null)
  }
  const switchSpace = (id: string): void => {
    update((s) => ({ ...s, activeSpace: id }))
    setFind(null)
  }
  const cycleSpace = (step: number): void => {
    const list = spacesRef.current
    const at = list.findIndex((x) => x.id === stRef.current?.activeSpace)
    switchSpace(list[(at + step + list.length) % list.length].id)
  }
  const cycleTab = (step: number): void => {
    const s = stRef.current
    if (!s) return
    const list = [...s.tabs.filter((t) => t.spaceId === s.activeSpace && t.pinned), ...s.tabs.filter((t) => t.spaceId === s.activeSpace && !t.pinned)]
    if (!list.length) return
    const at = list.findIndex((t) => t.id === s.activeTab[s.activeSpace])
    activate(list[(at + step + list.length) % list.length].id)
  }

  const closeWebTab = (id: string): void => {
    const s = stRef.current
    const t = findTab(id)
    if (!s || !t) return
    const list = s.tabs.filter((x) => x.spaceId === t.spaceId && !x.pinned)
    const idx = list.findIndex((x) => x.id === id)
    let next = s.activeTab[t.spaceId]
    if (next === id) next = (list[idx + 1] ?? list[idx - 1])?.id ?? ''
    if (next === id) next = ''
    closed.current = [...closed.current, { tab: t, index: s.tabs.indexOf(t) }].slice(-25)
    setLive((l) => l.filter((x) => x !== id))
    setRt((r) => {
      const { [id]: _gone, ...rest } = r
      return rest
    })
    update((x) => ({ ...x, tabs: x.tabs.filter((y) => y.id !== id), activeTab: { ...x.activeTab, [t.spaceId]: next } }))
  }
  const reopenClosed = (): void => {
    const last = closed.current.pop()
    if (!last) return
    update((s) => {
      const tabs = s.tabs.slice()
      tabs.splice(Math.min(last.index, tabs.length), 0, last.tab)
      return { ...s, tabs, activeSpace: last.tab.spaceId, activeTab: { ...s.activeTab, [last.tab.spaceId]: last.tab.id } }
    })
  }
  const closeOthers = (id: string): void => {
    const t = findTab(id)
    if (!t) return
    for (const x of stRef.current!.tabs) if (x.spaceId === t.spaceId && !x.pinned && x.id !== id) closeWebTab(x.id)
    activate(id)
  }
  const duplicate = (id: string): void => {
    const t = findTab(id)
    if (t?.url) openInNewTab(t.spaceId, t.url, { after: id })
  }
  const moveToSpace = (id: string, spaceId: string): void => {
    const t = findTab(id)
    if (!t || t.spaceId === spaceId) return
    update((s) => ({
      ...s,
      tabs: s.tabs.map((x) => (x.id === id ? { ...x, spaceId, pinned: false } : x)),
      activeTab: { ...s.activeTab, ...(s.activeTab[t.spaceId] === id ? { [t.spaceId]: '' } : {}) }
    }))
    toast('info', `Moved to ${spaceOf(spaceId)?.name ?? 'the space'}; it uses that space's logins.`)
  }
  /** Drag and drop: put `id` before or after `targetId` (or at the end of the list when null), pinned or not. */
  const placeTab = (id: string, targetId: string | null, where: 'before' | 'after', pin: boolean): void => {
    if (id === targetId) return
    update((s) => {
      const t = s.tabs.find((x) => x.id === id)
      if (!t) return s
      const moved = { ...t, pinned: pin }
      const tabs = s.tabs.filter((x) => x.id !== id)
      let at = targetId ? tabs.findIndex((x) => x.id === targetId) : -1
      if (at < 0) at = tabs.length
      else if (where === 'after') at++
      tabs.splice(at, 0, moved)
      return { ...s, tabs }
    })
  }

  const el = (): WebviewEl | undefined => (currentRef.current ? views.current.get(currentRef.current.id) : undefined)
  /** Runs `fn` on a tab's page (the current tab's by default), ignoring a page that cannot take it right now. */
  const act = (fn: (v: WebviewEl) => unknown, id = currentRef.current?.id): void => {
    const v = id ? views.current.get(id) : undefined
    if (v) safely(() => fn(v), undefined)
  }
  const setZoom = (z: number): void => {
    const c = currentRef.current
    const v = el()
    if (!c || !v) return
    safely(() => v.setZoomFactor(z), undefined)
    patchRt(c.id, { zoom: z })
  }
  const zoomStep = (step: number): void => {
    const z = (currentRef.current && rt[currentRef.current.id]?.zoom) || 1
    const i = ZOOMS.findIndex((x) => x >= z - 0.001)
    setZoom(ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? ZOOMS.indexOf(1) : i) + step))])
  }
  const copyLink = (): void => {
    const c = currentRef.current
    if (!c?.url) return
    void window.api.invoke('clipboard:write', c.url).then(() => toast('success', 'Link copied'))
  }
  const addToNote = (url?: string, title?: string): void => {
    const c = currentRef.current
    const u = url ?? c?.url
    if (!u) return
    const label = (title ?? c?.title ?? hostOf(u)).replace(/[[\]]/g, '')
    window.api.invoke('notes:daily').then(async (path) => {
      await window.api.invoke('notes:append', path, `- [${label}](${u})`)
      toast('success', `Added to today's note`)
    }).catch((e: Error) => toast('error', e.message))
  }
  const openExternal = (): void => {
    const c = currentRef.current
    if (c?.url) void window.api.invoke('shell:open', c.url)
  }
  const openFind = (): void => {
    setFind((f) => f ?? { text: '', active: 0, matches: 0 })
    setTimeout(() => { findInput.current?.focus(); findInput.current?.select() }, 0)
  }
  const closeFind = (): void => {
    act((v) => v.stopFindInPage('keepSelection'))
    setFind(null)
    el()?.focus()
  }
  const toggleSidebar = (): void => {
    update((s) => ({ ...s, sidebarHidden: !s.sidebarHidden }))
    setPeek(false)
  }
  const togglePin = (id: string): void => {
    const t = findTab(id)
    if (t) patchTab(id, { pinned: !t.pinned })
  }

  // ----- keyboard -----

  const onKey = (k: BrowserKey): boolean => {
    const c = currentRef.current
    if (k.ctrl) {
      if (k.key !== 'tab') return false
      cycleTab(k.shift ? -1 : 1)
      return true
    }
    switch (k.key) {
      case 't':
        if (k.shift) reopenClosed()
        else if (showStart) setStartFocus((n) => n + 1)
        else setCmd({ mode: 'new', query: '', nonce: Date.now() })
        return true
      case 'l':
        if (showStart) setStartFocus((n) => n + 1)
        else setCmd(c?.url ? { mode: 'edit', query: c.url, nonce: Date.now() } : { mode: 'new', query: '', nonce: Date.now() })
        return true
      case 'w':
        if (!c || k.shift) return false
        closeWebTab(c.id)
        return true
      case 'r':
        if (k.alt) return false
        act((v) => (k.shift ? v.reloadIgnoringCache() : v.reload()))
        return true
      case '[':
      case ']':
        if (k.shift || k.alt) return false
        act((v) => (k.key === '[' ? v.goBack() : v.goForward()))
        return true
      case 'f':
        if (k.shift || !c?.url) return false
        openFind()
        return true
      case 's':
        if (k.shift) return false
        toggleSidebar()
        return true
      case 'd':
        if (k.shift || !c) return !!c
        togglePin(c.id)
        return true
      case '=':
      case '+':
        zoomStep(1)
        return true
      case '-':
        zoomStep(-1)
        return true
      case '0':
        if (k.shift) return false
        setZoom(1)
        return true
      case 'c':
        if (!k.shift) return false
        copyLink()
        return true
      case 'arrowup':
      case 'arrowdown':
        if (!k.alt) return false
        cycleSpace(k.key === 'arrowdown' ? 1 : -1)
        return true
    }
    return false
  }
  const keyRef = useRef(onKey)
  keyRef.current = onKey
  useEffect(() => {
    if (!active) return
    setBrowserKeys((k) => keyRef.current(k))
    return () => setBrowserKeys(null)
  }, [active])

  // ----- events from the pages (main/webviews.ts) -----

  useEffect(() => {
    const offs = [
      window.api.on('web:shortcut', (d) => {
        if (!tabForWc(d.webContentsId)) return
        const ctrl = d.key === 'tab'
        if (keyRef.current({ key: d.key, shift: d.shift, alt: d.alt, ctrl })) return
        // Not a browser key: hand it to the app's shortcuts as if the page had not swallowed it.
        if (!ctrl) document.dispatchEvent(new KeyboardEvent('keydown', { key: d.key, metaKey: true, shiftKey: d.shift, altKey: d.alt, bubbles: true, cancelable: true }))
      }),
      window.api.on('web:window', (d) => {
        const id = tabForWc(d.webContentsId)
        const t = id ? findTab(id) : undefined
        if (t) openInNewTab(t.spaceId, d.url, { background: d.background, after: t.id })
      }),
      window.api.on('web:menu', (d) => {
        if (tabForWc(d.webContentsId) && d.action === 'note') addToNote(d.url, d.title)
      }),
      window.api.on('web:download', (d) => {
        if (d.state === 'completed') toast('success', `Downloaded ${d.name}`)
        else if (d.state === 'interrupted') toast('error', `Download of ${d.name} failed`)
      })
    ]
    return () => offs.forEach((off) => off())
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const events: WebviewEvents = {
    onNavigate: (id, url) => {
      const t = findTab(id)
      if (!t) return
      const sp = spaceOf(t.spaceId)
      const v = views.current.get(id)
      patchRt(id, { back: !!v && safely(() => v.canGoBack(), false), fwd: !!v && safely(() => v.canGoForward(), false), error: undefined })
      if (sp?.profile && isAwsSignInPage(url)) {
        void reSignIn(id, sp, url)
        return
      }
      if (isFederationUrl(url) || url === 'about:blank') return
      if (rt[id]?.signingIn && !isAwsSignInPage(url)) patchRt(id, { signingIn: false })
      update((s) => {
        const last = s.history.at(-1)
        const history = last?.url === url && last.spaceId === t.spaceId ? s.history : [...s.history, { url, title: t.title, spaceId: t.spaceId, at: Date.now() }].slice(-MAX_HISTORY)
        return { ...s, history, tabs: s.tabs.map((x) => (x.id === id ? { ...x, url } : x)) }
      })
    },
    onTitle: (id, title) => update((s) => {
      const t = s.tabs.find((x) => x.id === id)
      if (!t || !title) return s
      const history = s.history.slice()
      for (let i = history.length - 1; i >= Math.max(0, history.length - 30); i--) {
        if (history[i].url === t.url && history[i].spaceId === t.spaceId) {
          history[i] = { ...history[i], title }
          break
        }
      }
      return { ...s, history, tabs: s.tabs.map((x) => (x.id === id ? { ...x, title } : x)) }
    }),
    onFavicon: (id, favicon) => update((s) => {
      const t = s.tabs.find((x) => x.id === id)
      if (!t) return s
      const favicons = { ...s.favicons }
      // Inline (data:) icons can be large; only short addresses are remembered for the start page.
      if (favicon.length < 2048 && t.url) {
        delete favicons[hostOf(t.url)]
        favicons[hostOf(t.url)] = favicon
        const keys = Object.keys(favicons)
        for (const k of keys.slice(0, Math.max(0, keys.length - 300))) delete favicons[k]
      }
      return { ...s, favicons, tabs: s.tabs.map((x) => (x.id === id ? { ...x, favicon } : x)) }
    }),
    onLoading: (id, loading) => {
      const v = views.current.get(id)
      if (loading) patchRt(id, { loading })
      else {
        const url = v ? safely(() => v.getURL(), '') : ''
        patchRt(id, { loading, back: !!v && safely(() => v.canGoBack(), false), fwd: !!v && safely(() => v.canGoForward(), false), ...(isFederationUrl(url) || isAwsSignInPage(url) ? {} : { signingIn: false }) })
      }
    },
    onFail: (id, error) => patchRt(id, { error, loading: false, signingIn: false }),
    onFound: (id, act, matches) => {
      if (id === currentRef.current?.id) setFind((f) => (f ? { ...f, active: act, matches } : f))
    },
    onReady: (id, v) => {
      const wc = safely(() => v.getWebContentsId(), 0)
      if (wc) wcTab.current.set(wc, id)
      const z = rt[id]?.zoom
      if (z && z !== 1) safely(() => v.setZoomFactor(z), undefined)
    }
  }
  const register = useCallback((id: string, v: WebviewEl | null) => {
    if (v) {
      views.current.set(id, v)
      pending.current.delete(id)
      return
    }
    views.current.delete(id)
    for (const [wc, t] of wcTab.current) if (t === id) wcTab.current.delete(wc)
  }, [])

  // Requests from elsewhere in the app: the title bar, the quick switcher, a host's Console button.
  useEffect(() => {
    if (!request || !st || handledRequest.current === request.nonce) return
    handledRequest.current = request.nonce
    let spaceId = request.profile ? spaceIdForProfile(request.profile) : st.activeSpace
    if (!spacesRef.current.some((x) => x.id === spaceId)) {
      if (request.profile) toast('info', `${request.profile} has no AWS space (only SSO accounts sign in to the console); opened in ${spaces[0].name}.`)
      spaceId = spacesRef.current[0].id
    }
    if (!request.url) {
      switchSpace(spaceId)
      return
    }
    const open = st.tabs.find((t) => t.spaceId === spaceId && t.url === request.url)
    if (open) activate(open.id)
    else openInNewTab(spaceId, request.url)
  }, [request, !!st]) // eslint-disable-line react-hooks/exhaustive-deps

  // ----- command bar suggestions -----

  // The command bar keeps one function identity; the ref always runs this render's version.
  const suggestRef = useRef<(q: string) => Suggestion[]>(() => [])
  const suggest = useCallback((q: string) => suggestRef.current(q), [])
  suggestRef.current = (q: string): Suggestion[] => {
    const s = stRef.current
    if (!s) return []
    const query = q.trim()
    const c = currentRef.current
    const here = spacesRef.current.find((x) => x.id === s.activeSpace)
    const out: Suggestion[] = []
    if (query) {
      const url = normalizeInput(query)
      const search = url.startsWith('https://www.google.com/search?') && !/^https?:\/\//i.test(query)
      out.push({ id: 'go', group: '', title: search ? query : url, subtitle: search ? 'Search Google' : 'Open this address', icon: search ? <Icon.search /> : <Icon.globe />, hint: search ? 'Search' : 'Open', run: (toNew) => go(url, toNew) })
      const tabs = s.tabs.filter((t) => t.id !== c?.id && t.url && matchesWords(query, t.title, t.url)).slice(0, 4)
      for (const t of tabs) {
        out.push({ id: `tab-${t.id}`, group: 'Open tabs', title: t.title || hostOf(t.url), subtitle: `${spaceOf(t.spaceId)?.name ?? ''} · ${hostOf(t.url)}`, icon: <Favicon src={t.favicon} url={t.url} />, hint: 'Switch', run: () => activate(t.id) })
      }
    }
    const aws: Suggestion[] = []
    for (const sp of spacesRef.current) {
      if (!sp.profile) continue
      for (const svc of SPACE_SERVICES) {
        const match = query ? matchesWords(query, sp.name, sp.profile, sp.accountId, svc.name, svc.keywords, 'aws console') : sp.id === here?.id
        if (match) aws.push({ id: `aws-${sp.id}-${svc.id}`, group: 'AWS console', title: svc.name, subtitle: `${sp.name}${sp.accountId ? ` · ${sp.accountId}` : ''} · ${sp.region ?? ''}`, icon: <ServiceBadge id={svc.id} size={18} />, run: (toNew) => go(svc.url(sp.region ?? 'us-east-1'), toNew || sp.id !== s.activeSpace, sp.id) })
      }
    }
    out.push(...aws.slice(0, query ? 6 : 7))
    for (const h of searchHistory(s.history, query, query ? 6 : 5, query ? undefined : s.activeSpace)) {
      if (h.url === c?.url) continue
      out.push({ id: `hist-${h.url}-${h.at}`, group: 'History', title: h.title || hostOf(h.url), subtitle: `${hostOf(h.url)}${h.spaceId !== s.activeSpace ? ` · ${spaceOf(h.spaceId)?.name ?? ''}` : ''}`, icon: <Favicon src={s.favicons?.[hostOf(h.url)]} url={h.url} />, run: (toNew) => go(h.url, toNew) })
    }
    if (query) {
      for (const sp of spacesRef.current.filter((x) => x.id !== s.activeSpace && matchesWords(query, x.name, x.profile, 'space')).slice(0, 3)) {
        out.push({ id: `space-${sp.id}`, group: 'Spaces', title: sp.name, subtitle: sp.profile ? 'AWS account space' : 'Space', icon: <SpaceAvatar space={sp} size={18} />, hint: 'Switch', run: () => switchSpace(sp.id) })
      }
      const actions: { title: string; words: string; when: boolean; run: () => void }[] = [
        { title: 'Reopen closed tab', words: 'reopen undo closed tab', when: closed.current.length > 0, run: reopenClosed },
        { title: "Add page to today's note", words: 'note notes obsidian daily journal', when: !!c?.url, run: () => addToNote() },
        { title: 'Copy link', words: 'copy link url address', when: !!c?.url, run: copyLink },
        { title: 'Open in your browser', words: 'external safari chrome default browser open', when: !!c?.url, run: openExternal },
        { title: 'Find in page', words: 'find search page text', when: !!c?.url, run: openFind },
        { title: 'Show or hide the sidebar', words: 'sidebar hide show toggle', when: true, run: toggleSidebar },
        { title: 'New space', words: 'new space container profile add', when: true, run: () => setTimeout(() => setMenu({ kind: 'newSpace', anchor: document.querySelector('.space-add') as HTMLElement }), 0) },
        { title: 'Clear browsing history', words: 'clear delete history forget', when: s.history.length > 0, run: () => update((x) => ({ ...x, history: [] })) }
      ]
      for (const a of actions.filter((x) => x.when && matchesWords(query, x.title, x.words)).slice(0, 3)) {
        out.push({ id: `act-${a.title}`, group: 'Actions', title: a.title, icon: <Icon.play />, hint: 'Run', run: a.run })
      }
    }
    return out.slice(0, 16)
  }

  // Menus close when a page takes the focus (clicks inside a page never reach this document).
  useEffect(() => {
    const blur = (): void => {
      if (document.activeElement?.tagName === 'WEBVIEW') setMenu(null)
    }
    window.addEventListener('blur', blur)
    return () => window.removeEventListener('blur', blur)
  }, [])

  // ----- rendering -----

  if (!st) return <div className="browser" data-accent={space.color} />

  const hidden = !!st.sidebarHidden
  const liveIds = st.tabs.filter((t) => live.includes(t.id) && (t.url || pending.current.has(t.id))).map((t) => t.id)
  mountOrder.current = [...mountOrder.current.filter((id) => liveIds.includes(id)), ...liveIds.filter((id) => !mountOrder.current.includes(id))]
  const liveTabs = mountOrder.current.map((id) => st.tabs.find((t) => t.id === id)!)
  const auth = space.profile ? statuses[space.profile]?.state : undefined
  const signInProfile = (profile: string, retry?: () => void): void => {
    void useStore.getState().login(profile).then(() => {
      if (useStore.getState().statuses[profile]?.state === 'ok') retry?.()
    })
  }

  const dragProps = (t: WebTab, pin: boolean) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      dragId.current = t.id
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/uri-list', t.url)
      setTimeout(() => setDragging(true), 0)
    },
    onDragEnd: () => { dragId.current = null; setDrop(null); setDragging(false) },
    onDragOver: (e: DragEvent) => {
      if (!dragId.current || dragId.current === t.id) return
      e.preventDefault()
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const where = pin ? (e.clientX < r.left + r.width / 2 ? 'before' : 'after') : e.clientY < r.top + r.height / 2 ? 'before' : 'after'
      if (drop?.target !== t.id || drop.where !== where) setDrop({ target: t.id, where })
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      if (dragId.current && drop) placeTab(dragId.current, t.id, drop.where === 'on' ? 'after' : drop.where, pin)
      setDrop(null)
    }
  })
  const zoneProps = (zone: string, onDropIt: (id: string) => void) => ({
    onDragOver: (e: DragEvent) => {
      if (!dragId.current) return
      e.preventDefault()
      if (drop?.target !== zone) setDrop({ target: zone, where: 'on' })
    },
    onDragLeave: (e: DragEvent) => {
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node) && drop?.target === zone) setDrop(null)
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      if (dragId.current) onDropIt(dragId.current)
      setDrop(null)
    }
  })
  const dropCls = (id: string): string => (drop?.target === id ? `drop-${drop.where}` : '')

  const tabRow = (t: WebTab): ReactElement => {
    const r = rt[t.id] ?? {}
    return (
      <div
        key={t.id}
        role="tab"
        aria-selected={t.id === current?.id}
        className={`web-tab ${t.id === current?.id ? 'on' : ''} ${live.includes(t.id) ? '' : 'asleep'} ${dropCls(t.id)}`}
        title={t.url ? `${t.title}\n${t.url}` : t.title}
        onClick={() => activate(t.id)}
        onAuxClick={(e) => { if (e.button === 1) closeWebTab(t.id) }}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ kind: 'tab', id: t.id, anchor: e.currentTarget }) }}
        {...dragProps(t, false)}
      >
        <span className="web-tab-icon">{r.loading ? <span className="web-spinner" /> : <Favicon src={t.favicon} url={t.url} />}</span>
        <span className="web-tab-title">{t.title || hostOf(t.url) || 'New Tab'}</span>
        <button type="button" className="web-tab-x" aria-label={`Close ${t.title}`} onClick={(e) => { e.stopPropagation(); closeWebTab(t.id) }}><Icon.x /></button>
      </div>
    )
  }

  const sidebar = (
    <aside
      className={`web-side ${hidden ? (peek ? 'peek' : 'gone') : ''}`}
      onMouseLeave={() => { if (peek && !menu) setPeek(false) }}
    >
      <div className="web-side-top">
        <button type="button" className="web-ico" title="Hide sidebar (⌘S)" aria-label="Toggle sidebar" onClick={toggleSidebar}><Icon.sidebar /></button>
        <span className="flex-1" />
        <button type="button" className="web-ico" title="Back (⌘[)" aria-label="Back" disabled={!cur.back} onClick={() => act((v) => v.goBack())}><Icon.back /></button>
        <button type="button" className="web-ico" title="Forward (⌘])" aria-label="Forward" disabled={!cur.fwd} onClick={() => act((v) => v.goForward())}><Icon.forward /></button>
        <button type="button" className="web-ico" title="Reload (⌘R)" aria-label="Reload" disabled={!current?.url} onClick={() => act((v) => v.reload())}><Icon.refresh /></button>
      </div>

      <div className="web-url" role="button" tabIndex={0} title={current?.url || 'Search or enter address (⌘L)'} onClick={() => onKey({ key: 'l', shift: false, alt: false, ctrl: false })} onKeyDown={(e) => { if (e.key === 'Enter') onKey({ key: 'l', shift: false, alt: false, ctrl: false }) }}>
        {current?.url ? (
          <>
            {current.url.startsWith('https://') ? <Icon.lock className="web-url-lock" /> : <Icon.alert className="web-url-lock warn" />}
            <span className="web-url-host">{hostOf(current.url)}</span>
            {cur.zoom && cur.zoom !== 1 && <button type="button" className="web-zoom" title="Reset zoom (⌘0)" onClick={(e) => { e.stopPropagation(); setZoom(1) }}>{Math.round(cur.zoom * 100)}%</button>}
            <button type="button" className="web-url-more" aria-label="Page actions" onClick={(e) => { e.stopPropagation(); setMenu({ kind: 'page', anchor: e.currentTarget }) }}><Icon.more /></button>
          </>
        ) : (
          <><Icon.search className="web-url-lock" /><span className="web-url-host muted">Search or enter address</span><kbd className="web-kbd">⌘L</kbd></>
        )}
      </div>

      <div className="web-space-head" onContextMenu={(e) => { e.preventDefault(); setMenu({ kind: 'space', id: space.id, anchor: e.currentTarget }) }}>
        <SpaceAvatar space={space} size={20} />
        <div className="min-w-0 flex-1">
          <div className="web-space-name">{space.name}</div>
          {space.profile && <div className="web-space-sub">{space.accountId ? `${space.accountId} · ` : ''}{space.region}</div>}
        </div>
        <button type="button" className="web-ico sm" aria-label="Space options" onClick={(e) => setMenu({ kind: 'space', id: space.id, anchor: e.currentTarget })}><Icon.more /></button>
      </div>

      {space.profile && (
        <div className="web-services">
          {SPACE_SERVICES.map((svc) => (
            <button key={svc.id} type="button" className="web-service" title={`${svc.name} (${space.name})`} onClick={() => go(svc.url(space.region ?? 'us-east-1'), true)}>
              <ServiceBadge id={svc.id} size={24} />
            </button>
          ))}
        </div>
      )}

      <div className={`web-pins ${pinned.length ? '' : 'empty'} ${dropCls('pins')}`} {...zoneProps('pins', (id) => placeTab(id, null, 'after', true))}>
        {pinned.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`web-pin ${t.id === current?.id ? 'on' : ''} ${dropCls(t.id)}`}
            title={`${t.title}\n${t.url}`}
            onClick={() => activate(t.id)}
            onContextMenu={(e) => { e.preventDefault(); setMenu({ kind: 'tab', id: t.id, anchor: e.currentTarget }) }}
            {...dragProps(t, true)}
          >
            {rt[t.id]?.loading ? <span className="web-spinner" /> : <Favicon src={t.favicon} url={t.url} size={18} />}
          </button>
        ))}
        {!pinned.length && dragging && <span className="web-pins-hint">Drop to pin to {space.name}</span>}
      </div>

      <button type="button" className="web-newtab" onClick={() => onKey({ key: 't', shift: false, alt: false, ctrl: false })}>
        <Icon.plus /> New Tab <kbd className="web-kbd">⌘T</kbd>
      </button>

      <div key={space.id} className={`web-tabs ${dropCls('list')}`} role="tablist" {...zoneProps('list', (id) => placeTab(id, null, 'after', false))}>
        {today.map(tabRow)}
        {today.length > 1 && (
          <button type="button" className="web-clear" onClick={() => { for (const t of today) if (t.id !== current?.id) closeWebTab(t.id) }}>Clear other tabs</button>
        )}
      </div>

      <div className="web-spaces">
        {spaces.map((sp) => (
          <button
            key={sp.id}
            type="button"
            className={`web-space-dot ${sp.id === space.id ? 'on' : ''} ${dropCls(`space-${sp.id}`)}`}
            data-accent={sp.color}
            title={`${sp.name}${sp.profile ? ' (AWS)' : ''}`}
            aria-label={`Space ${sp.name}`}
            onClick={() => switchSpace(sp.id)}
            onContextMenu={(e) => { e.preventDefault(); setMenu({ kind: 'space', id: sp.id, anchor: e.currentTarget }) }}
            {...zoneProps(`space-${sp.id}`, (id) => moveToSpace(id, sp.id))}
          >
            <SpaceAvatar space={sp} size={sp.id === space.id ? 24 : 20} />
          </button>
        ))}
        <button type="button" className="web-ico space-add" title="New space" aria-label="New space" onClick={(e) => { setSpaceDraft({ name: '', color: ACCENTS[(st.spaces.length + 3) % ACCENTS.length] }); setMenu({ kind: 'newSpace', anchor: e.currentTarget }) }}><Icon.plus /></button>
      </div>
    </aside>
  )

  const overlayCard = (children: ReactElement): ReactElement => <div className="web-overlay">{children}</div>
  const commandBarFor = (inline: boolean): ReactElement => (
    <CommandBar
      key={inline ? 'inline' : `float-${cmd?.nonce}`}
      initial={inline ? '' : cmd?.query ?? ''}
      newTab={inline ? false : cmd?.mode === 'new'}
      suggest={suggest}
      inline={inline}
      focusKey={inline && active ? startFocus : undefined}
      onClose={() => setCmd(null)}
    />
  )

  const tabMenuFor = menu?.kind === 'tab' ? findTab(menu.id) : undefined
  const menuSpace = menu?.kind === 'space' ? spaces.find((x) => x.id === menu.id) : undefined

  return (
    <div className={`browser ${hidden ? 'side-hidden' : ''}`} data-accent={space.color}>
      {sidebar}
      {hidden && !peek && <div className="web-peek-zone" onMouseEnter={() => setPeek(true)} />}

      <div className="web-main">
        <div className="web-card">
          {cur.loading && !showStart && <div className="web-progress" />}
          {liveTabs.map((t) => (
            <Webview
              key={t.id}
              tabId={t.id}
              partition={partitionFor(t.spaceId)}
              src={pending.current.get(t.id) ?? t.url}
              visible={t.id === current?.id && !showStart}
              events={events}
              register={register}
            />
          ))}

          {showStart && (
            <StartPage
              space={space}
              auth={auth}
              frequent={frequentSites(st.history, space.id, 8)}
              favicons={st.favicons ?? {}}
              commandBar={commandBarFor(true)}
              onOpen={(url) => go(url, false)}
              onSignIn={() => space.profile && signInProfile(space.profile)}
            />
          )}

          {current && cur.signingIn && !cur.auth && overlayCard(
            <div className="web-veil">
              <SpaceAvatar space={space} size={44} />
              <div className="web-veil-title">Signing in to {space.name}…</div>
              <div className="muted text-[12px]">Using the account's AWS SSO access</div>
              <span className="web-spinner lg" />
            </div>
          )}

          {current && cur.auth && overlayCard(
            <div className="web-problem">
              <SpaceAvatar space={space} size={40} />
              <div className="web-problem-title">Couldn't open the {space.name} console</div>
              <p className="muted">{cur.auth}</p>
              <div className="flex gap-2">
                {space.profile && <button type="button" className="btn btn-primary" onClick={() => signInProfile(space.profile!, () => void loadInto(current.id, current.spaceId, cur.authDest ?? consoleHome(space.region ?? 'us-east-1')))}>Sign in to AWS</button>}
                <button type="button" className="btn" onClick={() => { lastAutoSignIn.current.delete(current.id); federated.current.delete(space.id); void loadInto(current.id, current.spaceId, cur.authDest ?? consoleHome(space.region ?? 'us-east-1')) }}>Try again</button>
              </div>
            </div>
          )}

          {current && cur.error && !cur.auth && overlayCard(
            <div className="web-problem">
              <Icon.alert className="web-problem-icon" />
              <div className="web-problem-title">This page didn't load</div>
              <p className="muted">{hostOf(cur.error.url)} · {cur.error.description || `error ${cur.error.code}`}</p>
              <div className="flex gap-2">
                <button type="button" className="btn btn-primary" onClick={() => { patchRt(current.id, { error: undefined }); act((v) => v.reload()) }}>Try again</button>
                <button type="button" className="btn" onClick={() => patchRt(current.id, { error: undefined })}>Dismiss</button>
              </div>
            </div>
          )}

          {find && current?.url && (
            <div className="web-find" onMouseDown={(e) => e.stopPropagation()}>
              <Icon.search />
              <input
                ref={findInput}
                value={find.text}
                placeholder="Find in page"
                aria-label="Find in page"
                onChange={(e) => {
                  const text = e.target.value
                  setFind({ text, active: 0, matches: 0 })
                  act((v) => (text ? v.findInPage(text, { findNext: true }) : v.stopFindInPage('clearSelection')))
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && find.text) { e.preventDefault(); act((v) => v.findInPage(find.text, { forward: !e.shiftKey, findNext: false })) }
                  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind() }
                }}
              />
              <span className="web-find-count">{find.text ? `${find.active}/${find.matches}` : ''}</span>
              <button type="button" className="web-ico sm" aria-label="Previous match" onClick={() => find.text && act((v) => v.findInPage(find.text, { forward: false, findNext: false }))}><Icon.arrowUp /></button>
              <button type="button" className="web-ico sm" aria-label="Next match" onClick={() => find.text && act((v) => v.findInPage(find.text, { forward: true, findNext: false }))}><Icon.arrowDown /></button>
              <button type="button" className="web-ico sm" aria-label="Close find" onClick={closeFind}><Icon.x /></button>
            </div>
          )}

          {cmd && !showStart && commandBarFor(false)}
        </div>
      </div>

      {menu?.kind === 'tab' && tabMenuFor && (
        <Popover anchor={menu.anchor} width={220} onClose={() => setMenu(null)}>
          <MenuItem onClick={() => { setMenu(null); togglePin(tabMenuFor.id) }} hint="⌘D">{tabMenuFor.pinned ? 'Unpin' : 'Pin to the space'}</MenuItem>
          <MenuItem disabled={!tabMenuFor.url} onClick={() => { setMenu(null); duplicate(tabMenuFor.id) }}>Duplicate</MenuItem>
          <MenuItem disabled={!tabMenuFor.url} onClick={() => { setMenu(null); void window.api.invoke('clipboard:write', tabMenuFor.url).then(() => toast('success', 'Link copied')) }}>Copy link</MenuItem>
          <MenuItem disabled={!tabMenuFor.url} onClick={() => { setMenu(null); addToNote(tabMenuFor.url, tabMenuFor.title) }}>Add to today's note</MenuItem>
          <MenuItem disabled={!views.current.has(tabMenuFor.id)} onClick={() => { setMenu(null); act((v) => v.reload(), tabMenuFor.id) }}>Reload</MenuItem>
          <MenuSep />
          <MenuLabel>Move to space</MenuLabel>
          {spaces.filter((x) => x.id !== tabMenuFor.spaceId).map((x) => (
            <MenuItem key={x.id} onClick={() => { setMenu(null); moveToSpace(tabMenuFor.id, x.id) }}>
              <span className="inline-flex items-center gap-2"><SpaceAvatar space={x} size={14} />{x.name}</span>
            </MenuItem>
          ))}
          <MenuSep />
          {!tabMenuFor.pinned && <MenuItem onClick={() => { setMenu(null); closeOthers(tabMenuFor.id) }}>Close other tabs</MenuItem>}
          <MenuItem danger onClick={() => { setMenu(null); closeWebTab(tabMenuFor.id) }} hint="⌘W">Close tab</MenuItem>
        </Popover>
      )}

      {menu?.kind === 'page' && current?.url && (
        <Popover anchor={menu.anchor} align="right" width={230} onClose={() => setMenu(null)}>
          <MenuItem onClick={() => { setMenu(null); copyLink() }} hint="⌘⇧C">Copy link</MenuItem>
          <MenuItem onClick={() => { setMenu(null); addToNote() }}>Add to today's note</MenuItem>
          <MenuItem onClick={() => { setMenu(null); openFind() }} hint="⌘F">Find in page</MenuItem>
          <MenuItem onClick={() => { setMenu(null); togglePin(current.id) }} hint="⌘D">{current.pinned ? 'Unpin tab' : 'Pin tab'}</MenuItem>
          <MenuSep />
          <MenuItem onClick={() => zoomStep(-1)} hint="⌘−">Zoom out</MenuItem>
          <MenuItem onClick={() => setZoom(1)} hint="⌘0">Actual size ({Math.round((cur.zoom ?? 1) * 100)}%)</MenuItem>
          <MenuItem onClick={() => zoomStep(1)} hint="⌘+">Zoom in</MenuItem>
          <MenuSep />
          <MenuItem onClick={() => { setMenu(null); act((v) => v.reloadIgnoringCache()) }} hint="⌘⇧R">Reload without cache</MenuItem>
          <MenuItem onClick={() => { setMenu(null); openExternal() }}>Open in your browser</MenuItem>
        </Popover>
      )}

      {menu?.kind === 'space' && menuSpace && (
        <Popover anchor={menu.anchor} width={230} onClose={() => setMenu(null)}>
          <MenuLabel>{menuSpace.name}</MenuLabel>
          {menuSpace.id !== space.id && <MenuItem onClick={() => { setMenu(null); switchSpace(menuSpace.id) }}>Switch to this space</MenuItem>}
          {menuSpace.profile && (
            <>
              <MenuItem onClick={() => { setMenu(null); go(consoleHome(menuSpace.region ?? 'us-east-1'), true, menuSpace.id) }}>Open the console</MenuItem>
              <MenuItem onClick={() => { setMenu(null); federated.current.delete(menuSpace.id); toast('info', `${menuSpace.name} signs in again on its next console page.`) }}>Sign in again on next page</MenuItem>
              <MenuItem onClick={() => { setMenu(null); signInProfile(menuSpace.profile!) }}>Renew the AWS SSO login</MenuItem>
              <div className="muted px-3 pb-1 pt-1 text-[10.5px]">Name and colour follow the account's settings in the hosts sidebar.</div>
            </>
          )}
          {!menuSpace.profile && (
            <>
              <MenuItem onClick={() => { setSpaceDraft({ name: menuSpace.name, color: menuSpace.color }); setMenu({ kind: 'newSpace', anchor: menu.anchor, edit: menuSpace.id }) }}>Rename or recolour…</MenuItem>
              {menuSpace.id !== GENERAL.id && (
                <MenuItem danger onClick={() => {
                  setMenu(null)
                  const n = st.tabs.filter((t) => t.spaceId === menuSpace.id).length
                  if (n && !window.confirm(`Delete the space "${menuSpace.name}" and close its ${n} tab${n === 1 ? '' : 's'}?`)) return
                  update((s) => ({ ...s, spaces: s.spaces.filter((x) => x.id !== menuSpace.id), tabs: s.tabs.filter((t) => t.spaceId !== menuSpace.id), activeSpace: s.activeSpace === menuSpace.id ? GENERAL.id : s.activeSpace }))
                }}>Delete space</MenuItem>
              )}
            </>
          )}
        </Popover>
      )}

      {menu?.kind === 'newSpace' && (
        <Popover anchor={menu.anchor} width={250} onClose={() => setMenu(null)}>
          <form
            className="space-form"
            onSubmit={(e) => {
              e.preventDefault()
              const name = spaceDraft.name.trim()
              if (!name) return
              if (menu.edit) update((s) => ({ ...s, spaces: s.spaces.map((x) => (x.id === menu.edit ? { ...x, name, color: spaceDraft.color } : x)) }))
              else {
                const id = `s-${newId()}`
                update((s) => ({ ...s, spaces: [...s.spaces, { id, name, color: spaceDraft.color }], activeSpace: id }))
              }
              setMenu(null)
            }}
          >
            <div className="section-title">{menu.edit ? 'Edit space' : 'New space'}</div>
            <input className="input" autoFocus placeholder="Name (Work, Jira, Personal…)" value={spaceDraft.name} onChange={(e) => setSpaceDraft({ ...spaceDraft, name: e.target.value })} />
            <div className="space-swatches">
              {ACCENTS.map((c) => (
                <button key={c} type="button" data-accent={c} className={`space-swatch ${spaceDraft.color === c ? 'on' : ''}`} aria-label={c} onClick={() => setSpaceDraft({ ...spaceDraft, color: c })} />
              ))}
            </div>
            <p className="muted text-[10.5px]">A space has its own cookies and logins, so the same site can be signed in differently in each.</p>
            <button type="submit" className="btn btn-primary btn-sm" disabled={!spaceDraft.name.trim()}>{menu.edit ? 'Save' : 'Create space'}</button>
          </form>
        </Popover>
      )}
    </div>
  )
}

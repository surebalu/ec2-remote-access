import type { CSSProperties, DragEvent, ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AccentColor, BrowserState, WebSpace, WebTab } from '@shared/types'
import {
  consoleHome, frequentSites, hostOf, isAwsConsoleUrl, isAwsSignInPage, isFederationUrl, isWebUrl, lastGrapheme, matchesWords, normalizeInput,
  partitionFor, restorableUrl, searchHistory, signInDestination, spaceIdForProfile
} from '@shared/browser'
import { captureBrowser, restoreBrowser } from '@shared/workspaces'
import { registerWorkspaceContext } from '../../workspaceContext'
import { hostsInText, type PageHost } from '@shared/pageHosts'
import { allInstances, isSession, routeOf, useStore, type Beside, type Tab } from '../../store'
import { ACCENTS, metaFor } from '../../colors'
import { isSectionKeyFor, replayPageKey, setBrowserKeys, terminalAction, type TabKey as BrowserKey } from '../../shortcuts'
import { openDefaultFor } from '../../quickConnect'
import { findInAllPanes, onFindAll, reportFindCount } from '../../paneFind'
import { Icon } from '../icons'
import Popover, { MenuItem, MenuLabel, MenuSep } from '../Popover'
import Webview, { type WebviewEl, type WebviewEvents } from './Webview'
import CommandBar, { type Suggestion } from './CommandBar'
import StartPage from './StartPage'
import Downloads from './Downloads'
import Extensions from './Extensions'
import OnePassword from './OnePassword'
import { ACCENT_HEX, Favicon, ServiceBadge, SPACE_EMOJI, SPACE_GRADIENTS, SPACE_SERVICES, SpaceAvatar, spaceVars, type Space } from './parts'

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

/** What the New space / Edit space form holds: a name, a named colour or one of its own (a gradient with `to`), an emoji. */
type SpaceDraft = Pick<WebSpace, 'name' | 'color' | 'custom' | 'icon'>

const SIDEBAR_WIDTH = { default: 208, min: 200, max: 380 }
/** The browser's own chrome follows the page zoom, within limits that keep it usable. */
const CHROME_ZOOM = { min: 0.5, max: 1.75 }

/** What the sidebar calls a tab: the name the user gave it, else the page title, else its site. */
const tabLabel = (t: WebTab): string => t.name || t.title || hostOf(t.url || t.homeUrl || '') || 'New Tab'

/** The sidebar's order, which ⌃Tab follows: the space's Favorites, then its Pinned, then its Today. */
function sidebarOrder(s: BrowserState): WebTab[] {
  const mine = s.tabs.filter((t) => t.spaceId === s.activeSpace)
  return [...mine.filter((t) => t.favorite), ...mine.filter((t) => t.pinned && !t.favorite), ...mine.filter((t) => !t.pinned && !t.favorite)]
}

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
}

type Zone = 'favorite' | 'pinned' | 'today'

type MenuState =
  | { kind: 'tab'; id: string; anchor: HTMLElement }
  | { kind: 'space'; id: string; anchor: HTMLElement }
  | { kind: 'page'; anchor: HTMLElement }
  | { kind: 'newSpace'; anchor: HTMLElement; edit?: string }
  | { kind: 'editTab'; id: string; anchor: HTMLElement }
  | { kind: 'downloads'; anchor: HTMLElement }
  | { kind: 'extensions'; anchor: HTMLElement; open?: { id: string; url: string } }
  | { kind: 'fill'; anchor: HTMLElement; tabId: string }
  | { kind: 'hosts'; anchor: HTMLElement }

/** The page's visible text, for spotting the hosts it mentions (capped: a long ticket is still a few hundred KB). */
const PAGE_TEXT = `(() => { try { return (document.body ? document.body.innerText : '').slice(0, 400000) } catch { return '' } })()`

const NO_HOSTS: PageHost[] = []
const sameHosts = (a: PageHost[], b: PageHost[]): boolean => a.length === b.length && a.every((h, i) => h.key === b[i].key && h.match === b[i].match)

function initialState(saved: BrowserState | null): BrowserState {
  const s = saved ?? { spaces: [GENERAL], tabs: [], activeSpace: GENERAL.id, activeTab: {}, history: [] }
  const tabs = (s.tabs ?? []).map((t) => ({ ...t, url: restorableUrl(t.url) }))
  // Favorites used to show in every space, so a space may still have another space's favorite selected; it gets its
  // own most recent tab instead.
  const recent = (sid: string): string => tabs.filter((t) => t.spaceId === sid).sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))[0]?.id ?? ''
  const activeTab = Object.fromEntries(Object.entries(s.activeTab ?? {}).map(([sid, id]) => [sid, tabs.some((t) => t.id === id && t.spaceId === sid) ? id : recent(sid)]))
  return {
    ...s,
    spaces: s.spaces?.length ? s.spaces : [GENERAL],
    tabs,
    activeTab,
    history: s.history ?? [],
    // A download cannot outlive the app run that started it.
    downloads: (s.downloads ?? []).map((d) => (d.state === 'progressing' ? { ...d, state: 'interrupted' as const } : d)),
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

function Browser({ tab, active }: { tab: Tab; active: boolean }): ReactElement {
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
  const [spaceDraft, setSpaceDraft] = useState<SpaceDraft>({ name: '', color: 'violet' })
  const emojiInput = useRef<HTMLInputElement>(null)
  /** A download finished since the Downloads popover was last opened (a dot on its button). */
  const [unseenDownloads, setUnseenDownloads] = useState(false)
  /** The Extensions popover's width while it shows an extension's popup or options page (null: the list's). */
  const [extWidth, setExtWidth] = useState<number | null>(null)
  const [tabDraft, setTabDraft] = useState<{ name: string; url: string; error?: string }>({ name: '', url: '' })
  /** Dragging the sidebar's edge: where the drag started. */
  const [resizing, setResizing] = useState<{ x: number; width: number } | null>(null)
  /** Bumped to focus the start page's command bar (⌘T / ⌘L while it shows). */
  const [startFocus, setStartFocus] = useState(0)
  /** Hosts the page on screen mentions (a ticket's servers), for opening them beside it. */
  const [pageHosts, setPageHosts] = useState<{ tabId: string; url: string; hosts: PageHost[] } | null>(null)
  /** The page whose hosts pill was closed. */
  const [hostsHidden, setHostsHidden] = useState<string | null>(null)
  const scanTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const scanSeq = useRef(0)
  /** What the split bar is looking for in every pane ('' when nothing): this page reports its count for it. */
  const findAllRef = useRef('')

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
  /** Two-finger horizontal swipe on the sidebar (like Arc): distance so far, and the gesture that already switched. */
  const swipe = useRef({ dx: 0, at: 0, done: false })
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
      const id = spaceIdForProfile(p.name)
      return { id, name: m.label, color: m.color, profile: p.name, region: p.region, accountId: statuses[p.name]?.accountId ?? p.accountId, ...st?.spaceLooks?.[id] }
    }), [profiles, settings, statuses, st?.spaceLooks])
  const spaces = useMemo<Space[]>(() => [...(st?.spaces ?? [GENERAL]), ...awsSpaces], [st?.spaces, awsSpaces])
  const space = spaces.find((x) => x.id === st?.activeSpace) ?? spaces[0]
  // Each space has its own favorites, as Arc gives each profile its own: they use the space's logins, so one space's
  // Gmail favorite never shows (signed in as that account) in another.
  const favorites = st ? st.tabs.filter((t) => t.favorite && t.spaceId === space.id) : []
  const spaceTabs = st ? st.tabs.filter((t) => t.spaceId === space.id && !t.favorite) : []
  const pinned = spaceTabs.filter((t) => t.pinned)
  const today = spaceTabs.filter((t) => !t.pinned)
  // The tab on screen: one of this space's, its favorites included.
  const current = st ? [...spaceTabs, ...favorites].find((t) => t.id === st.activeTab[space.id]) : undefined
  const cur = current ? rt[current.id] ?? {} : {}
  // The save-to-Links key pressed with this app in front saves the page shown here (main/linksPanel.ts).
  useEffect(() => {
    if (!active || !current?.url) return
    void window.api.invoke('browser:frontPage', { url: current.url, title: current.title }).catch(() => undefined)
    return () => void window.api.invoke('browser:frontPage', null).catch(() => undefined)
  }, [active, current?.url, current?.title])
  const showStart = !current || (!current.url && !cur.signingIn && !cur.auth)
  // The quick switcher lists these tabs as sites to switch to (store.webTabs), a moment after they change.
  useEffect(() => {
    if (!st) return
    const names = new Map(spaces.map((x) => [x.id, x.name]))
    const t = setTimeout(() => useStore.getState().set({
      webTabs: st.tabs.filter((x) => x.url || x.homeUrl).map((x) => ({
        id: x.id, title: x.name || x.title, url: x.url || x.homeUrl || '', favicon: x.favicon, space: x.spaceId, spaceName: names.get(x.spaceId) ?? 'Browser',
        pinned: x.pinned, favorite: x.favorite, current: st.activeTab[x.spaceId] === x.id
      }))
    }), 300)
    return () => clearTimeout(t)
  }, [st?.tabs, st?.activeTab, spaces]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => useStore.getState().set({ webTabs: null }), [])

  const stRef = useRef(st)
  stRef.current = st
  useEffect(() => registerWorkspaceContext('browser', () => stRef.current ? { id: tab.id, kind: 'browser', browser: captureBrowser(stRef.current) } : null), [tab.id])
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
      const firstToday = tabs.findIndex((x) => x.spaceId === spaceId && !x.pinned && !x.favorite)
      let at = opts.after ? tabs.findIndex((x) => x.id === opts.after) + 1 : firstToday
      if (at <= 0 && !opts.after) at = firstToday
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
    // A tab (favorites too) takes you to its space.
    const sid = t.spaceId
    update((s) => ({ ...s, activeSpace: sid, activeTab: { ...s.activeTab, [sid]: id }, tabs: s.tabs.map((x) => (x.id === id ? { ...x, lastActive: Date.now() } : x)) }))
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
  /**
   * A sideways two-finger swipe on the sidebar switches space, once per gesture: the trackpad's momentum keeps
   * sending events, so a new switch needs a pause between events (a new gesture) first.
   */
  const onSidebarWheel = (e: { deltaX: number; deltaY: number }): void => {
    const w = swipe.current
    const now = Date.now()
    if (now - w.at > 180) Object.assign(w, { dx: 0, done: false })
    w.at = now
    if (w.done || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
    w.dx += e.deltaX
    if (Math.abs(w.dx) < 70) return
    w.done = true
    cycleSpace(w.dx > 0 ? 1 : -1)
  }
  const cycleTab = (step: number): void => {
    const s = stRef.current
    if (!s) return
    const list = sidebarOrder(s)
    if (!list.length) return
    const at = list.findIndex((t) => t.id === s.activeTab[s.activeSpace])
    activate(list[(at + step + list.length) % list.length].id)
  }

  /** What the showing space selects once `id` goes away: the tab below it in Today, else the one above, else none. */
  const nextAfter = (s: BrowserState, id: string): string => {
    const list = s.tabs.filter((x) => x.spaceId === s.activeSpace && !x.pinned && !x.favorite && x.id !== id)
    const all = s.tabs.filter((x) => x.spaceId === s.activeSpace && !x.pinned && !x.favorite)
    const idx = all.findIndex((x) => x.id === id)
    return (idx >= 0 ? all[idx + 1] ?? all[idx - 1] : list[0])?.id ?? ''
  }
  /** The selection with `id` gone: the showing space moves to `next`, other spaces that showed it go back to their start. */
  const deselect = (activeTab: Record<string, string>, id: string, sid: string, next: string): Record<string, string> =>
    Object.fromEntries(Object.entries(activeTab).map(([k, v]) => [k, v === id ? (k === sid ? next : '') : v]))
  const forget = (id: string): void => {
    setLive((l) => l.filter((x) => x !== id))
    setRt((r) => {
      const { [id]: _gone, ...rest } = r
      return rest
    })
  }
  const closeWebTab = (id: string): void => {
    const s = stRef.current
    const t = findTab(id)
    if (!s || !t) return
    const next = s.activeTab[s.activeSpace] === id ? nextAfter(s, id) : s.activeTab[s.activeSpace]
    closed.current = [...closed.current, { tab: t, index: s.tabs.indexOf(t) }].slice(-25)
    forget(id)
    update((x) => ({ ...x, tabs: x.tabs.filter((y) => y.id !== id), activeTab: deselect(x.activeTab, id, x.activeSpace, next) }))
  }
  /** ⌘W on a favorite or pinned tab, as in Arc: it stays in the sidebar, unloaded and back on its saved page. */
  const unloadTab = (id: string): void => {
    const s = stRef.current
    const t = findTab(id)
    if (!s || !t) return
    const next = s.activeTab[s.activeSpace] === id ? nextAfter(s, id) : s.activeTab[s.activeSpace]
    forget(id)
    update((x) => ({ ...x, tabs: x.tabs.map((y) => (y.id === id ? { ...y, url: y.homeUrl || y.url } : y)), activeTab: { ...x.activeTab, [x.activeSpace]: next } }))
  }
  const closeOrUnload = (id: string): void => {
    const t = findTab(id)
    if (t?.pinned || t?.favorite) unloadTab(id)
    else closeWebTab(id)
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
    for (const x of stRef.current!.tabs) if (x.spaceId === t.spaceId && !x.pinned && !x.favorite && x.id !== id) closeWebTab(x.id)
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
      // A favorite stays a favorite, now among the other space's; any other tab joins its Today.
      tabs: s.tabs.map((x) => (x.id === id ? { ...x, spaceId, pinned: false, favorite: !!x.favorite, homeUrl: x.favorite ? x.homeUrl : undefined } : x)),
      activeTab: { ...s.activeTab, ...(s.activeTab[t.spaceId] === id ? { [t.spaceId]: '' } : {}) }
    }))
    toast('info', `Moved to ${spaceOf(spaceId)?.name ?? 'the space'}; it uses that space's logins.`)
  }
  /**
   * Drag and drop: put `id` before or after `targetId` (at the end of the section when null) in Favorites, this
   * space's Pinned, or its Today. A tab dropped into another space's list takes that space's logins.
   */
  const placeTab = (id: string, targetId: string | null, where: 'before' | 'after', zone: Zone): void => {
    const t = findTab(id)
    const sid = stRef.current?.activeSpace
    if (id === targetId || !t || !sid) return
    const spaceId = sid
    if (spaceId !== t.spaceId) toast('info', `Moved to ${spaceOf(spaceId)?.name ?? 'this space'}; it uses this space's logins.`)
    const keeps = zone !== 'today'
    const moved: WebTab = { ...t, spaceId, favorite: zone === 'favorite', pinned: zone === 'pinned', homeUrl: keeps ? (t.pinned || t.favorite ? t.homeUrl : undefined) ?? t.url : undefined }
    update((s) => {
      const tabs = s.tabs.filter((x) => x.id !== id)
      let at = targetId ? tabs.findIndex((x) => x.id === targetId) : -1
      if (at < 0) at = tabs.length
      else if (where === 'after') at++
      tabs.splice(at, 0, moved)
      return { ...s, tabs, activeTab: spaceId === t.spaceId ? s.activeTab : deselect(s.activeTab, id, sid, s.activeTab[sid] === id ? id : s.activeTab[sid]) }
    })
  }

  const el = (): WebviewEl | undefined => (currentRef.current ? views.current.get(currentRef.current.id) : undefined)
  /** Runs `fn` on a tab's page (the current tab's by default), ignoring a page that cannot take it right now. */
  const act = (fn: (v: WebviewEl) => unknown, id = currentRef.current?.id): void => {
    const v = id ? views.current.get(id) : undefined
    if (v) safely(() => fn(v), undefined)
  }
  /**
   * One zoom for the whole browser, applied to every page. Chromium keeps zoom per site, so each page gets it again
   * whenever it attaches or loads a document (onReady).
   */
  const setZoom = (z: number): void => {
    update((s) => ({ ...s, zoom: z === 1 ? undefined : z }))
    for (const v of views.current.values()) safely(() => v.setZoomFactor(z), undefined)
  }
  const zoomStep = (step: number): void => {
    const z = stRef.current?.zoom ?? 1
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
    if (!t) return
    if (t.pinned) patchTab(id, { pinned: false, homeUrl: undefined })
    else {
      patchTab(id, { pinned: true, favorite: false, homeUrl: t.favorite ? t.homeUrl : t.url })
    }
  }
  const toggleFavorite = (id: string): void => {
    const t = findTab(id)
    if (!t) return
    if (t.favorite) {
      patchTab(id, { favorite: false, homeUrl: undefined })
      toast('info', `Removed from Favorites; it is back in ${spaceOf(t.spaceId)?.name ?? 'its space'}'s tabs.`)
      return
    }
    // New favorites go to the end of the grid.
    update((s) => ({ ...s, tabs: [...s.tabs.filter((x) => x.id !== id), { ...t, favorite: true, pinned: false, homeUrl: t.pinned ? t.homeUrl : t.url }] }))
  }
  /** Saves the Edit form of a pinned tab or favorite; returns an error to show, or null. */
  const saveTabEdit = (id: string, name: string, address: string): string | null => {
    const t = findTab(id)
    if (!t) return null
    const typed = address.trim()
    const url = typed ? normalizeInput(typed) : ''
    if (typed && (!isWebUrl(url) || (url.startsWith('https://www.google.com/search?') && !/^https?:\/\//i.test(typed)))) return 'Enter a web address, like jira.example.com or https://…'
    const moved = !!url && url !== (t.homeUrl ?? t.url)
    patchTab(id, { name: name.trim() || undefined, ...(moved ? { homeUrl: url } : {}) })
    if (moved) {
      if (live.includes(id)) void loadInto(id, t.spaceId, url)
      else patchTab(id, { url })
    }
    return null
  }
  const resetToHome = (id: string): void => {
    const t = findTab(id)
    if (t?.homeUrl) void loadInto(id, t.spaceId, t.homeUrl)
  }
  /** Opens Fill from 1Password for the page on screen, under the key button in the address pill. */
  const openFill = (): void => {
    const c = currentRef.current
    if (!c?.url || !views.current.has(c.id)) {
      toast('info', 'Open the login page first, then fill it from 1Password.')
      return
    }
    // The key button lives in the sidebar: show it (peek) when the sidebar is hidden.
    if (stRef.current?.sidebarHidden) setPeek(true)
    setTimeout(() => {
      const anchor = document.querySelector<HTMLElement>('.web-url-key')
      if (anchor) setMenu({ kind: 'fill', anchor, tabId: c.id })
    }, 0)
  }
  /** Opens the Extensions panel, on one extension's popup when `open` says (it asked for it: action.openPopup). */
  const openExtensions = (open?: { id: string; url: string }): void => {
    // The button lives in the sidebar: show it (peek) when the sidebar is hidden.
    if (stRef.current?.sidebarHidden) setPeek(true)
    setTimeout(() => {
      const anchor = document.querySelector<HTMLElement>('.web-side-top [aria-label="Extensions"]')
      if (anchor) setMenu({ kind: 'extensions', anchor, open })
    }, 0)
  }
  const sharePage = (url?: string): void => {
    const u = url ?? currentRef.current?.url
    if (u) void window.api.invoke('browser:share', u).then((shown) => { if (!shown) toast('info', 'Sharing needs the Mac app.') })
  }

  // ----- keyboard -----

  const onKey = (k: BrowserKey): boolean => {
    const c = currentRef.current
    if (k.ctrl) {
      if (k.key !== 'tab') return false
      cycleTab(k.shift ? -1 : 1)
      return true
    }
    // ⌘1…⌘8: the space at that place along the bottom of the sidebar, ⌘9: the last one (the app's tabs keep ⌘⇧[ / ⌘⇧]).
    if (/^[1-9]$/.test(k.key) && !k.shift && !k.alt) {
      const list = spacesRef.current
      const sp = k.key === '9' ? list.at(-1) : list[Number(k.key) - 1]
      if (sp) switchSpace(sp.id)
      return true
    }
    switch (k.key) {
      case 't':
        if (k.shift) reopenClosed()
        else if (showStart) setStartFocus((n) => n + 1)
        else setCmd({ mode: 'new', query: '', nonce: Date.now() })
        return true
      case 'l':
        if (k.shift) {
          openFill()
          return true
        }
        if (showStart) setStartFocus((n) => n + 1)
        else setCmd(c?.url ? { mode: 'edit', query: c.url, nonce: Date.now() } : { mode: 'new', query: '', nonce: Date.now() })
        return true
      case 'w':
        if (!c || k.shift) return false
        closeOrUnload(c.id)
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
        if (!c) return false
        if (k.shift) toggleFavorite(c.id)
        else togglePin(c.id)
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
        // A rail section's own shortcut goes to the app first, unless it is one of the browser's keys.
        if (!isSectionKeyFor('browser', d) && keyRef.current({ key: d.key, shift: d.shift, alt: d.alt, ctrl: d.ctrl })) return
        // Not a browser key: hand it to the app's shortcuts as if the page had not swallowed it.
        if (!(d.ctrl && d.key === 'tab')) replayPageKey(d)
      }),
      window.api.on('web:window', (d) => {
        const id = tabForWc(d.webContentsId)
        const t = id ? findTab(id) : undefined
        if (t) openInNewTab(t.spaceId, d.url, { background: d.background, after: t.id })
      }),
      // A click inside a page never reaches this document; main reports it so open menus close as they would, and so
      // the browser takes the keyboard when it is one pane of a split.
      window.api.on('ext:openPopup', (d) => {
        const st0 = stRef.current
        if (st0 && partitionFor(st0.activeSpace) === d.partition) openExtensions({ id: d.id, url: d.url })
      }),
      window.api.on('web:pointer', (d) => {
        if (!tabForWc(d.webContentsId)) return
        setMenu(null)
        const s = useStore.getState()
        if (s.splitGroup.includes(tab.id)) s.focusPane(tab.id)
      }),
      window.api.on('web:menu', (d) => {
        if (!tabForWc(d.webContentsId)) return
        if (d.action === 'note') addToNote(d.url, d.title)
        else if (d.action === 'fill') openFill()
        else if (d.action === 'paste' && d.text && d.target) terminalAction(d.target, 'paste', d.text)
        else if (d.action === 'find' && d.text) findInAllPanes(d.text)
      }),
      window.api.on('web:download', (d) => {
        update((s) => {
          const list = s.downloads ?? []
          const known = list.some((x) => x.id === d.id)
          return { ...s, downloads: (known ? list.map((x) => (x.id === d.id ? d : x)) : [d, ...list]).slice(0, 40) }
        })
        if (d.state === 'completed') setUnseenDownloads(true)
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
        if (id === currentRef.current?.id) scanPage(700)
        const url = v ? safely(() => v.getURL(), '') : ''
        patchRt(id, { loading, back: !!v && safely(() => v.canGoBack(), false), fwd: !!v && safely(() => v.canGoForward(), false), ...(isFederationUrl(url) || isAwsSignInPage(url) ? {} : { signingIn: false }) })
      }
    },
    onFail: (id, error) => patchRt(id, { error, loading: false, signingIn: false }),
    onFound: (id, act, matches) => {
      if (id !== currentRef.current?.id) return
      setFind((f) => (f ? { ...f, active: act, matches } : f))
      if (findAllRef.current) reportFindCount(tab.id, matches)
    },
    onReady: (id, v) => {
      const wc = safely(() => v.getWebContentsId(), 0)
      if (wc) wcTab.current.set(wc, id)
      safely(() => v.setZoomFactor(stRef.current?.zoom ?? 1), undefined)
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
    useStore.getState().set({ browserRequest: null })
    if (request.workspace) {
      const restored = restoreBrowser(st, request.workspace, spacesRef.current.map((sp) => sp.id), newId)
      setSt(restored.state)
      if (restored.skipped) toast('info', `${restored.skipped} workspace browser ${restored.skipped === 1 ? 'page was' : 'pages were'} skipped because their space is missing or disabled.`)
      return
    }
    // A tab by id (a favorite from the launcher) opens in its own space, with that space's logins.
    if (request.tab && findTab(request.tab)) {
      activate(request.tab)
      return
    }
    if (request.partition) {
      const sp = spacesRef.current.find((x) => partitionFor(x.id) === request.partition)
      if (!sp || !request.url) return
      openInNewTab(sp.id, request.url, { background: request.background })
      // Chrome closes an extension's popup when the page it opens takes the focus.
      if (!request.background) setMenu(null)
      return
    }
    let spaceId = request.profile ? spaceIdForProfile(request.profile) : request.space && spacesRef.current.some((x) => x.id === request.space) ? request.space : st.activeSpace
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

  // ----- side by side: the hosts a page mentions, finding across panes, text for the terminals beside -----

  /** Reads the page on screen for hosts it mentions, `delay` ms from now (pages such as Jira render after loading). */
  const scanPage = (delay = 0): void => {
    clearTimeout(scanTimer.current)
    scanTimer.current = setTimeout(() => {
      const c = currentRef.current
      const v = c ? views.current.get(c.id) : undefined
      if (!c?.url || !v) { setPageHosts(null); return }
      const seq = ++scanSeq.current
      const url = c.url
      Promise.resolve(safely(() => v.executeJavaScript(PAGE_TEXT), Promise.resolve(''))).then((text) => {
        if (seq !== scanSeq.current) return
        const hosts = typeof text === 'string' && text ? hostsInText(text, allInstances(useStore.getState())) : []
        setPageHosts((p) => (p && p.tabId === c.id && p.url === url && sameHosts(p.hosts, hosts) ? p : { tabId: c.id, url, hosts }))
      }, () => undefined)
    }, delay)
  }
  useEffect(() => {
    scanPage(900)
    // Another page of the split's find: look for the same text on this one.
    if (findAllRef.current) act((v) => v.findInPage(findAllRef.current, { findNext: true }))
  }, [current?.id, current?.url]) // eslint-disable-line react-hooks/exhaustive-deps
  // Tickets fill in comments and fields after loading; a slow look now and then keeps the list current.
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => { if (document.visibilityState === 'visible') scanPage() }, 8000)
    return () => { clearInterval(t); clearTimeout(scanTimer.current) }
  }, [active]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Opens a host the page mentions beside it: the first on its right, more stacked under the last session there. */
  const openHostBeside = (key: string): void => {
    const s = useStore.getState()
    const sessions = s.splitGroup.includes(tab.id) ? s.splitGroup.filter((id) => { const t = s.tabs.find((x) => x.id === id); return !!t && isSession(t) }) : []
    const beside: Beside = sessions.length ? { tab: sessions[sessions.length - 1], side: 'down' } : { tab: tab.id, side: 'right' }
    const open = s.tabs.find((t) => t.instanceKey === key && (t.kind === 'ssh' || t.kind === 'rdp') && !t.transient)
    if (open && s.splitGroup.includes(open.id) && s.splitGroup.includes(tab.id)) s.focusPane(open.id)
    else if (open) s.splitWith(beside.tab, open.id, beside.side)
    else openDefaultFor(key, beside)
  }

  useEffect(() => onFindAll((req) => {
    if (!req.ids.includes(tab.id)) return
    if (req.step) {
      const back = !!req.step.back
      if (req.step.tabId === tab.id && req.text) act((v) => v.findInPage(req.text, { forward: !back, findNext: false }))
      return
    }
    findAllRef.current = req.text
    if (!req.text || !currentRef.current?.url) {
      act((v) => v.stopFindInPage('clearSelection'))
      reportFindCount(tab.id, null)
      return
    }
    act((v) => v.findInPage(req.text, { findNext: true }))
  }), [tab.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // The page on screen names the Browser's pane in a split ("jira.example.com · INC-123 …").
  const pageLabel = current?.url ? `${hostOf(current.url)}${current.title ? ` · ${current.title}` : ''}` : ''
  useEffect(() => {
    if ((tab.message ?? '') !== pageLabel) useStore.getState().updateTab(tab.id, { message: pageLabel || undefined })
  }, [pageLabel]) // eslint-disable-line react-hooks/exhaustive-deps

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
      const tabs = s.tabs.filter((t) => t.id !== c?.id && t.url && matchesWords(query, t.name, t.title, t.url)).slice(0, 4)
      for (const t of tabs) {
        out.push({ id: `tab-${t.id}`, group: t.favorite ? 'Favorites' : 'Open tabs', title: tabLabel(t), subtitle: `${spaceOf(t.spaceId)?.name ?? ''} · ${hostOf(t.url)}`, icon: <Favicon src={t.favicon} url={t.url} />, hint: 'Switch', run: () => activate(t.id) })
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
        { title: c?.favorite ? 'Remove from Favorites' : 'Add page to Favorites', words: 'favorite favourite star bookmark', when: !!c?.url, run: () => c && toggleFavorite(c.id) },
        { title: 'Share page', words: 'share anybox airdrop messages send', when: !!c?.url, run: () => sharePage() },
        { title: 'Fill from 1Password', words: '1password password login autofill fill sign in', when: !!c?.url, run: openFill },
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


  // ----- rendering -----

  if (!st) return <div className="browser" data-accent={space.color} style={spaceVars(space)} />

  const hidden = !!st.sidebarHidden
  // Overall progress of running downloads for the ring on the Downloads button (null when none run).
  const runningDl = (st.downloads ?? []).filter((d) => d.state === 'progressing')
  const dlTotal = runningDl.reduce((n, d) => n + d.total, 0)
  const dlProgress = runningDl.length ? (dlTotal > 0 ? Math.round((runningDl.reduce((n, d) => n + d.received, 0) / dlTotal) * 100) : 15) : null
  const sideWidth = st.sidebarWidth ?? SIDEBAR_WIDTH.default
  // The sidebar, start page, find bar and command bar scale with the pages (CSS zoom through --web-zoom), so the two
  // halves stay in proportion; widths are kept unzoomed and dragging the edge divides by it.
  const chromeZoom = Math.min(CHROME_ZOOM.max, Math.max(CHROME_ZOOM.min, st.zoom ?? 1))
  /** "  ⌘3" for the space ⌘3 shows (⌘9 is the last space). */
  const keyFor = (i: number): string => (i < 8 ? `  ⌘${i + 1}` : i === spaces.length - 1 ? '  ⌘9' : '')
  const liveIds = st.tabs.filter((t) => live.includes(t.id) && (t.url || pending.current.has(t.id))).map((t) => t.id)
  mountOrder.current = [...mountOrder.current.filter((id) => liveIds.includes(id)), ...liveIds.filter((id) => !mountOrder.current.includes(id))]
  const liveTabs = mountOrder.current.map((id) => st.tabs.find((t) => t.id === id)!)
  const auth = space.profile ? statuses[space.profile]?.state : undefined
  const signInProfile = (profile: string, retry?: () => void): void => {
    void useStore.getState().login(profile).then(() => {
      if (useStore.getState().statuses[profile]?.state === 'ok') retry?.()
    })
  }

  const dragProps = (t: WebTab, zone: Zone) => ({
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
      const where = zone === 'favorite' ? (e.clientX < r.left + r.width / 2 ? 'before' : 'after') : e.clientY < r.top + r.height / 2 ? 'before' : 'after'
      if (drop?.target !== t.id || drop.where !== where) setDrop({ target: t.id, where })
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      if (dragId.current && drop) placeTab(dragId.current, t.id, drop.where === 'on' ? 'after' : drop.where, zone)
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

  const tabRow = (t: WebTab, zone: Zone): ReactElement => {
    const r = rt[t.id] ?? {}
    const loaded = live.includes(t.id)
    const drifted = zone === 'pinned' && !!t.homeUrl && !!t.url && t.url !== t.homeUrl
    return (
      <div
        key={t.id}
        role="tab"
        aria-selected={t.id === current?.id}
        className={`web-tab ${t.id === current?.id ? 'on' : ''} ${loaded ? '' : 'asleep'} ${dropCls(t.id)}`}
        title={`${tabLabel(t)}${t.url ? `\n${t.url}` : ''}`}
        onClick={() => activate(t.id)}
        onAuxClick={(e) => { if (e.button === 1) closeOrUnload(t.id) }}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ kind: 'tab', id: t.id, anchor: e.currentTarget }) }}
        {...dragProps(t, zone)}
      >
        <span className="web-tab-icon">{r.loading ? <span className="web-spinner" /> : <Favicon src={t.favicon} url={t.url || t.homeUrl || ''} />}</span>
        <span className="web-tab-title">{tabLabel(t)}</span>
        {drifted && <button type="button" className="web-tab-x" title={`Back to ${hostOf(t.homeUrl!)}`} aria-label={`Back to the pinned page of ${t.title}`} onClick={(e) => { e.stopPropagation(); resetToHome(t.id) }}><Icon.undo /></button>}
        {zone === 'pinned'
          ? loaded && <button type="button" className="web-tab-x" title="Unload (stays pinned)" aria-label={`Unload ${t.title}`} onClick={(e) => { e.stopPropagation(); unloadTab(t.id) }}><Icon.minus /></button>
          : <button type="button" className="web-tab-x" aria-label={`Close ${t.title}`} onClick={(e) => { e.stopPropagation(); closeWebTab(t.id) }}><Icon.x /></button>}
      </div>
    )
  }

  const sidebar = (
    <aside
      className={`web-side ${hidden ? (peek ? 'peek' : 'gone') : ''}`}
      style={{ width: sideWidth }}
      onMouseLeave={() => { if (peek && !menu) setPeek(false) }}
      onWheel={onSidebarWheel}
    >
      {!hidden && (
        <div
          className="web-side-resize"
          title="Drag to resize · double-click for the default width"
          onMouseDown={(e) => { e.preventDefault(); setResizing({ x: e.clientX, width: sideWidth }) }}
          onDoubleClick={() => update((x) => ({ ...x, sidebarWidth: undefined }))}
        />
      )}
      <div className="web-side-top">
        <button type="button" className="web-ico" title="Hide sidebar (⌘S)" aria-label="Toggle sidebar" onClick={toggleSidebar}><Icon.sidebar /></button>
        <button
          type="button"
          className={`web-ico web-dl ${unseenDownloads ? 'unseen' : ''} ${dlProgress !== null ? 'busy' : ''}`}
          title="Downloads"
          aria-label="Downloads"
          style={dlProgress !== null ? ({ '--p': `${dlProgress}%` } as CSSProperties) : undefined}
          onClick={(e) => { setUnseenDownloads(false); setMenu({ kind: 'downloads', anchor: e.currentTarget }) }}
        >
          <Icon.download />
        </button>
        <button type="button" className="web-ico" title="Extensions" aria-label="Extensions" onClick={(e) => setMenu({ kind: 'extensions', anchor: e.currentTarget })}><Icon.puzzle /></button>
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
            {st.zoom && st.zoom !== 1 && <button type="button" className="web-zoom" title="Zoom for every page; click to reset (⌘0)" onClick={(e) => { e.stopPropagation(); setZoom(1) }}>{Math.round(st.zoom * 100)}%</button>}
            <button type="button" className="web-url-more web-url-key" title="Fill from 1Password (⌘⇧L)" aria-label="Fill from 1Password" onClick={(e) => { e.stopPropagation(); openFill() }}><Icon.key /></button>
            <button type="button" className="web-url-more" aria-label="Page actions" onClick={(e) => { e.stopPropagation(); setMenu({ kind: 'page', anchor: e.currentTarget }) }}><Icon.more /></button>
          </>
        ) : (
          <><Icon.search className="web-url-lock" /><span className="web-url-host muted">Search or enter address</span><kbd className="web-kbd">⌘L</kbd></>
        )}
      </div>

      <div className={`web-favs ${favorites.length ? '' : 'empty'} ${dropCls('favs')}`} aria-label="Favorites" {...zoneProps('favs', (id) => placeTab(id, null, 'after', 'favorite'))}>
        {favorites.map((t) => {
          return (
            <button
              key={t.id}
              type="button"
              className={`web-fav ${t.id === current?.id ? 'on' : ''} ${live.includes(t.id) ? '' : 'asleep'} ${dropCls(t.id)}`}
              title={`${tabLabel(t)}\n${t.url || t.homeUrl}`}
              aria-label={`Favorite ${tabLabel(t)}`}
              onClick={() => activate(t.id)}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ kind: 'tab', id: t.id, anchor: e.currentTarget }) }}
              {...dragProps(t, 'favorite')}
            >
              {rt[t.id]?.loading ? <span className="web-spinner" /> : <Favicon src={t.favicon} url={t.url || t.homeUrl || ''} size={18} />}
            </button>
          )
        })}
        {!favorites.length && <span className="web-favs-hint">{dragging ? 'Drop to add to Favorites' : <>Drag tabs here for Favorites, or <kbd className="web-kbd">⌘⇧D</kbd></>}</span>}
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
              <ServiceBadge id={svc.id} size={22} />
            </button>
          ))}
        </div>
      )}

      <div className={`web-pinned ${dropCls('pins')}`} {...zoneProps('pins', (id) => placeTab(id, null, 'after', 'pinned'))}>
        {pinned.map((t) => tabRow(t, 'pinned'))}
        {!pinned.length && dragging && <span className="web-pins-hint">Drop to pin to {space.name}</span>}
      </div>
      {(pinned.length > 0 || today.length > 1) && (
        <div className="web-divider">
          <span />
          {today.length > 1 && <button type="button" className="web-clear" title="Close this space's unpinned tabs except the one you are on" onClick={() => { for (const t of today) if (t.id !== current?.id) closeWebTab(t.id) }}>Clear</button>}
        </div>
      )}

      <button type="button" className="web-newtab" onClick={() => onKey({ key: 't', shift: false, alt: false, ctrl: false })}>
        <Icon.plus /> New Tab <kbd className="web-kbd">⌘T</kbd>
      </button>

      <div key={space.id} className={`web-tabs ${dropCls('list')}`} role="tablist" {...zoneProps('list', (id) => placeTab(id, null, 'after', 'today'))}>
        {today.map((t) => tabRow(t, 'today'))}
      </div>

      <div className="web-spaces">
        {spaces.map((sp, i) => (
          <button
            key={sp.id}
            type="button"
            className={`web-space-dot ${sp.id === space.id ? 'on' : ''} ${dropCls(`space-${sp.id}`)}`}
            data-accent={sp.color}
            style={spaceVars(sp)}
            title={`${sp.name}${sp.profile ? ' (AWS)' : ''}${keyFor(i)}`}
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
  const hostsHere = pageHosts && pageHosts.tabId === current?.id && pageHosts.url === current?.url ? pageHosts.hosts : NO_HOSTS
  const known = new Map(hostsHere.length ? allInstances(useStore.getState()).map((i) => [i.key, i]) : [])
  // The space form edits an AWS account space: colour of its own and icon only.
  const editingAccount = menu?.kind === 'newSpace' && menu.edit ? spaces.find((x) => x.id === menu.edit && x.profile) : undefined

  return (
    <div className={`browser ${hidden ? 'side-hidden' : ''}`} data-accent={space.color} style={{ '--web-zoom': chromeZoom, ...spaceVars(space) } as CSSProperties}>
      {sidebar}
      {hidden && !peek && <div className="web-peek-zone" onMouseEnter={() => setPeek(true)} />}
      {/* Pages swallow mouse events, so a drag across them is tracked on a shield over the whole browser. */}
      {resizing && (
        <div
          className="web-resize-shield"
          onMouseMove={(e) => {
            const w = Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, resizing.width + (e.clientX - resizing.x) / chromeZoom)))
            if (w !== sideWidth) update((x) => ({ ...x, sidebarWidth: w }))
          }}
          onMouseUp={() => setResizing(null)}
          onMouseLeave={() => setResizing(null)}
        />
      )}

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

          {hostsHere.length > 0 && !showStart && hostsHidden !== current?.url && (
            <div className="web-hosts-pill">
              <button type="button" title="Hosts this page mentions: open one beside it" aria-haspopup="menu" onClick={(e) => setMenu(menu?.kind === 'hosts' ? null : { kind: 'hosts', anchor: e.currentTarget })}>
                <Icon.server />
                {hostsHere.length === 1 ? (known.get(hostsHere[0].key)?.name ?? '1 host') : `${hostsHere.length} hosts`} on this page
              </button>
              <button type="button" className="web-hosts-x" title="Hide for this page" aria-label="Hide the hosts on this page" onClick={() => { setHostsHidden(current?.url ?? null); if (menu?.kind === 'hosts') setMenu(null) }}><Icon.x /></button>
            </div>
          )}
        </div>
      </div>

      {menu?.kind === 'tab' && tabMenuFor && (
        <Popover anchor={menu.anchor} width={236} onClose={() => setMenu(null)}>
          {(tabMenuFor.favorite || tabMenuFor.pinned) && (
            <MenuItem onClick={() => { setTabDraft({ name: tabMenuFor.name ?? '', url: tabMenuFor.homeUrl ?? tabMenuFor.url }); setMenu({ kind: 'editTab', id: tabMenuFor.id, anchor: menu.anchor }) }}>Edit name and address…</MenuItem>
          )}
          <MenuItem onClick={() => { setMenu(null); toggleFavorite(tabMenuFor.id) }} hint="⌘⇧D">{tabMenuFor.favorite ? 'Remove from Favorites' : 'Add to Favorites'}</MenuItem>
          {!tabMenuFor.favorite && <MenuItem onClick={() => { setMenu(null); togglePin(tabMenuFor.id) }} hint="⌘D">{tabMenuFor.pinned ? 'Unpin' : `Pin to ${spaceOf(tabMenuFor.spaceId)?.name ?? 'the space'}`}</MenuItem>}
          {(tabMenuFor.pinned || tabMenuFor.favorite) && tabMenuFor.homeUrl && tabMenuFor.url && tabMenuFor.url !== tabMenuFor.homeUrl && (
            <>
              <MenuItem onClick={() => { setMenu(null); resetToHome(tabMenuFor.id) }}>Back to {hostOf(tabMenuFor.homeUrl)}</MenuItem>
              <MenuItem onClick={() => { setMenu(null); patchTab(tabMenuFor.id, { homeUrl: tabMenuFor.url }) }}>Keep this page as its address</MenuItem>
            </>
          )}
          {(tabMenuFor.pinned || tabMenuFor.favorite) && live.includes(tabMenuFor.id) && <MenuItem onClick={() => { setMenu(null); unloadTab(tabMenuFor.id) }} hint="⌘W">Unload</MenuItem>}
          <MenuSep />
          <MenuItem disabled={!tabMenuFor.url} onClick={() => { setMenu(null); duplicate(tabMenuFor.id) }}>Duplicate</MenuItem>
          <MenuItem disabled={!tabMenuFor.url} onClick={() => { setMenu(null); void window.api.invoke('clipboard:write', tabMenuFor.url).then(() => toast('success', 'Link copied')) }}>Copy link</MenuItem>
          <MenuItem disabled={!tabMenuFor.url} onClick={() => { setMenu(null); sharePage(tabMenuFor.url) }}>Share…</MenuItem>
          <MenuItem disabled={!tabMenuFor.url} onClick={() => { setMenu(null); addToNote(tabMenuFor.url, tabMenuFor.title) }}>Add to today's note</MenuItem>
          <MenuItem disabled={!views.current.has(tabMenuFor.id)} onClick={() => { setMenu(null); act((v) => v.reload(), tabMenuFor.id) }}>Reload</MenuItem>
          <MenuSep />
          {/* The tab moves to that space and uses its logins; a favorite stays a favorite there. */}
          <MenuLabel>Move to space</MenuLabel>
          {spaces.filter((x) => x.id !== tabMenuFor.spaceId).map((x) => (
            <MenuItem key={x.id} onClick={() => { setMenu(null); moveToSpace(tabMenuFor.id, x.id) }}>
              <span className="inline-flex items-center gap-2"><SpaceAvatar space={x} size={14} />{x.name}</span>
            </MenuItem>
          ))}
          <MenuSep />
          {!tabMenuFor.pinned && !tabMenuFor.favorite && <MenuItem onClick={() => { setMenu(null); closeOthers(tabMenuFor.id) }}>Close other tabs</MenuItem>}
          <MenuItem danger onClick={() => { setMenu(null); closeWebTab(tabMenuFor.id) }} hint={tabMenuFor.pinned || tabMenuFor.favorite ? undefined : '⌘W'}>{tabMenuFor.favorite ? 'Remove and close' : tabMenuFor.pinned ? 'Unpin and close' : 'Close tab'}</MenuItem>
        </Popover>
      )}

      {menu?.kind === 'page' && current?.url && (
        <Popover anchor={menu.anchor} align="right" width={230} onClose={() => setMenu(null)}>
          <MenuItem onClick={() => { setMenu(null); copyLink() }} hint="⌘⇧C">Copy link</MenuItem>
          <MenuItem onClick={() => { setMenu(null); addToNote() }}>Add to today's note</MenuItem>
          <MenuItem onClick={() => { setMenu(null); openFind() }} hint="⌘F">Find in page</MenuItem>
          <MenuItem onClick={() => { setMenu(null); toggleFavorite(current.id) }} hint="⌘⇧D">{current.favorite ? 'Remove from Favorites' : 'Add to Favorites'}</MenuItem>
          {!current.favorite && <MenuItem onClick={() => { setMenu(null); togglePin(current.id) }} hint="⌘D">{current.pinned ? 'Unpin tab' : 'Pin tab'}</MenuItem>}
          <MenuItem onClick={() => { setMenu(null); sharePage() }}>Share…</MenuItem>
          <MenuItem onClick={() => { setMenu(null); useStore.getState().openQuickSwitcher('', { beside: tab.id }) }} hint={'⌘\\'}>Open a host beside this page…</MenuItem>
          <MenuSep />
          <MenuItem onClick={() => zoomStep(-1)} hint="⌘−">Zoom out</MenuItem>
          <MenuItem onClick={() => setZoom(1)} hint="⌘0">Actual size ({Math.round((st.zoom ?? 1) * 100)}%, all pages)</MenuItem>
          <MenuItem onClick={() => zoomStep(1)} hint="⌘+">Zoom in</MenuItem>
          <MenuSep />
          <MenuItem onClick={() => { setMenu(null); act((v) => v.reloadIgnoringCache()) }} hint="⌘⇧R">Reload without cache</MenuItem>
          <MenuItem onClick={() => { setMenu(null); openExternal() }}>Open in your browser</MenuItem>
        </Popover>
      )}

      {menu?.kind === 'hosts' && hostsHere.length > 0 && (
        <Popover anchor={menu.anchor} align="right" width={340} onClose={() => setMenu(null)}>
          <MenuLabel>Hosts this page mentions</MenuLabel>
          {hostsHere.map((h) => {
            const i = known.get(h.key)
            if (!i) return null
            const route = routeOf(i, settings).route
            const reachable = route === 'ssm' || route === 'direct'
            const open = useStore.getState().tabs.some((t) => t.instanceKey === h.key && (t.kind === 'ssh' || t.kind === 'rdp') && !t.transient)
            return (
              <MenuItem
                key={h.key}
                disabled={!open && !reachable}
                title={`${i.name} (${i.instanceId}) in ${i.profile} · ${i.region}. Found by ${h.via}: ${h.match}`}
                hint={open ? 'Show beside' : reachable ? `${i.platform === 'windows' ? 'Desktop' : 'SSH'} beside` : i.state === 'running' ? 'Unreachable' : i.state}
                onClick={() => { setMenu(null); openHostBeside(h.key) }}
              >
                <span className="web-page-host">
                  {i.platform === 'windows' ? <Icon.windows /> : <Icon.linux />}
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{i.name}</span>
                    <span className="muted block truncate text-[10.5px]">{i.profile} · {h.via === 'instance ID' ? i.privateIp ?? i.region : `${h.via} ${h.match}`}{h.via === 'instance ID' ? ` · ${i.instanceId}` : ''}</span>
                  </span>
                </span>
              </MenuItem>
            )
          })}
          <MenuSep />
          <div className="muted px-3 pb-1.5 pt-0.5 text-[10.5px] leading-snug">Found by instance ID, IP address, EC2 host name or Name tag. The first opens beside this page, the next ones under it.</div>
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
              <MenuItem onClick={() => { setSpaceDraft({ name: menuSpace.name, color: menuSpace.color, custom: menuSpace.custom, icon: menuSpace.icon }); setMenu({ kind: 'newSpace', anchor: menu.anchor, edit: menuSpace.id }) }}>Colour and icon…</MenuItem>
              <div className="muted px-3 pb-1 pt-1 text-[10.5px]">The name follows the account in the hosts sidebar.</div>
            </>
          )}
          {!menuSpace.profile && (
            <>
              <MenuItem onClick={() => { setSpaceDraft({ name: menuSpace.name, color: menuSpace.color, custom: menuSpace.custom, icon: menuSpace.icon }); setMenu({ kind: 'newSpace', anchor: menu.anchor, edit: menuSpace.id }) }}>Rename or recolour…</MenuItem>
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

      {menu?.kind === 'fill' && (
        <Popover anchor={menu.anchor} width={320} onClose={() => setMenu(null)}>
          <OnePassword
            pageUrl={findTab(menu.tabId)?.url ?? ''}
            webContentsId={safely(() => views.current.get(menu.tabId)?.getWebContentsId() ?? 0, 0)}
            onDone={() => { setMenu(null); act((v) => v.focus(), menu.tabId) }}
          />
        </Popover>
      )}

      {menu?.kind === 'extensions' && (
        <Popover anchor={menu.anchor} width={extWidth ?? 360} onClose={() => { setMenu(null); setExtWidth(null) }}>
          <Extensions partition={partitionFor(space.id)} pageUrl={current?.url ?? ''} onWidth={setExtWidth} open={menu.open}
            tabId={current ? safely(() => views.current.get(current.id)?.getWebContentsId() ?? null, null) : null}
            onClose={() => { setMenu(null); setExtWidth(null) }}
            onBrowseStore={() => { setMenu(null); go('https://chromewebstore.google.com/category/extensions', true) }} />
        </Popover>
      )}

      {menu?.kind === 'downloads' && (
        <Popover anchor={menu.anchor} width={300} onClose={() => setMenu(null)}>
          <Downloads
            items={st.downloads ?? []}
            onClear={() => update((s) => ({ ...s, downloads: (s.downloads ?? []).filter((d) => d.state === 'progressing') }))}
            onDone={() => setMenu(null)}
          />
        </Popover>
      )}

      {menu?.kind === 'editTab' && findTab(menu.id) && (
        <Popover anchor={menu.anchor} width={270} onClose={() => setMenu(null)}>
          <form
            className="space-form"
            onSubmit={(e) => {
              e.preventDefault()
              const error = saveTabEdit(menu.id, tabDraft.name, tabDraft.url)
              if (error) setTabDraft({ ...tabDraft, error })
              else setMenu(null)
            }}
          >
            <div className="section-title">{findTab(menu.id)!.favorite ? 'Edit favorite' : 'Edit pinned tab'}</div>
            <label className="space-field">
              <span>Name</span>
              <input className="input" autoFocus placeholder={findTab(menu.id)!.title || 'Page title'} value={tabDraft.name} onChange={(e) => setTabDraft({ ...tabDraft, name: e.target.value })} />
            </label>
            <label className="space-field">
              <span>Address</span>
              <input className="input" spellCheck={false} placeholder="https://…" value={tabDraft.url} onChange={(e) => setTabDraft({ ...tabDraft, url: e.target.value, error: undefined })} />
            </label>
            {tabDraft.error && <p className="text-[11px]" style={{ color: 'var(--err)' }}>{tabDraft.error}</p>}
            <p className="muted text-[10.5px]">The address is where it opens and where ⌘W brings it back. Leave the name empty to use the page's title.</p>
            <button type="submit" className="btn btn-primary btn-sm">Save</button>
          </form>
        </Popover>
      )}

      {menu?.kind === 'newSpace' && (
        <Popover anchor={menu.anchor} width={300} onClose={() => setMenu(null)}>
          <form
            className="space-form"
            onSubmit={(e) => {
              e.preventDefault()
              const name = spaceDraft.name.trim()
              if (!name) return
              const look = { color: spaceDraft.color, custom: spaceDraft.custom, icon: spaceDraft.icon || undefined }
              if (editingAccount) {
                // An account space keeps the account's name and colour; only a colour of its own and an icon are stored.
                const id = editingAccount.id
                update((s) => {
                  const looks = { ...(s.spaceLooks ?? {}) }
                  if (look.custom || look.icon) looks[id] = { custom: look.custom, icon: look.icon }
                  else delete looks[id]
                  return { ...s, spaceLooks: looks }
                })
              } else if (menu.edit) update((s) => ({ ...s, spaces: s.spaces.map((x) => (x.id === menu.edit ? { ...x, name, ...look } : x)) }))
              else {
                const id = `s-${newId()}`
                update((s) => ({ ...s, spaces: [...s.spaces, { id, name, ...look }], activeSpace: id }))
              }
              setMenu(null)
            }}
          >
            <div className="section-title">{editingAccount ? 'Colour and icon' : menu.edit ? 'Edit space' : 'New space'}</div>
            {editingAccount
              ? <div className="muted text-[11px] leading-snug">{editingAccount.name} is an AWS account: its name follows the hosts sidebar. Pick a colour of its own and an icon here.</div>
              : <input className="input" autoFocus placeholder="Name (Work, Jira, Personal…)" value={spaceDraft.name} onChange={(e) => setSpaceDraft({ ...spaceDraft, name: e.target.value })} />}
            <div className="space-preview" data-accent={spaceDraft.color} style={spaceVars(spaceDraft)}>
              <SpaceAvatar space={{ id: 'draft', ...spaceDraft, name: spaceDraft.name || '?' }} size={30} />
              <span className="truncate">{spaceDraft.name || 'New space'}</span>
            </div>
            <div className="space-swatches">
              {(editingAccount ? [editingAccount.color] : ACCENTS).map((c) => (
                <button key={c} type="button" data-accent={c} className={`space-swatch ${!spaceDraft.custom && spaceDraft.color === c ? 'on' : ''}`} aria-label={editingAccount ? `The account's colour (${c})` : c} title={editingAccount ? "The account's colour" : undefined} onClick={() => setSpaceDraft({ ...spaceDraft, color: c, custom: undefined })} />
              ))}
              <button
                type="button"
                className={`space-swatch custom ${spaceDraft.custom ? 'on' : ''}`}
                aria-label="Custom colour or gradient"
                title="Any colour, or a gradient"
                style={spaceDraft.custom ? { background: `linear-gradient(135deg, ${spaceDraft.custom.from}, ${spaceDraft.custom.to ?? spaceDraft.custom.from})`, ...spaceVars(spaceDraft) } : undefined}
                onClick={() => setSpaceDraft({ ...spaceDraft, custom: spaceDraft.custom ?? { from: ACCENT_HEX[spaceDraft.color] } })}
              />
            </div>
            {spaceDraft.custom && (() => {
              const c = spaceDraft.custom
              const setC = (patch: Partial<NonNullable<SpaceDraft['custom']>>): void => setSpaceDraft({ ...spaceDraft, custom: { ...c, ...patch } })
              return (
                <div className="space-custom">
                  <div className="space-colors">
                    <label className="space-color" title="Pick a colour">
                      <input type="color" aria-label={c.to ? 'First colour' : 'Colour'} value={c.from} onChange={(e) => setC({ from: e.target.value })} />
                      <span className="mono">{c.from}</span>
                    </label>
                    {c.to && (
                      <>
                        <button type="button" className="space-swap" title="Swap the two colours" aria-label="Swap colours" onClick={() => setC({ from: c.to!, to: c.from })}>⇄</button>
                        <label className="space-color" title="Pick the second colour">
                          <input type="color" aria-label="Second colour" value={c.to} onChange={(e) => setC({ to: e.target.value })} />
                          <span className="mono">{c.to}</span>
                        </label>
                      </>
                    )}
                  </div>
                  <label className="space-gradient">
                    <input type="checkbox" checked={!!c.to} onChange={(e) => setC({ to: e.target.checked ? SPACE_GRADIENTS.find(([f]) => f !== c.from)?.[1] ?? '#a855f7' : undefined })} /> Gradient
                  </label>
                  <div className="space-presets" role="group" aria-label="Ready-made gradients">
                    {SPACE_GRADIENTS.map(([from, to, label]) => (
                      <button key={label} type="button" title={label} aria-label={label} className={c.from === from && c.to === to ? 'on' : ''} style={{ background: `linear-gradient(135deg, ${from}, ${to})` }} onClick={() => setSpaceDraft({ ...spaceDraft, custom: { from, to } })} />
                    ))}
                  </div>
                </div>
              )
            })()}
            <div className="space-icon">
              <div className="space-icon-head">
                <span className="section-title">Icon</span>
                <span className="flex-1" />
                {spaceDraft.icon && <button type="button" className="space-link" onClick={() => setSpaceDraft({ ...spaceDraft, icon: undefined })}>Use initials</button>}
              </div>
              <div className="space-emojis" role="group" aria-label="Emoji">
                {SPACE_EMOJI.map((e) => (
                  <button key={e} type="button" className={`space-emoji ${spaceDraft.icon === e ? 'on' : ''}`} aria-label={`Icon ${e}`} onClick={() => setSpaceDraft({ ...spaceDraft, icon: e })}>{e}</button>
                ))}
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  ref={emojiInput}
                  className="input space-emoji-input"
                  aria-label="Any emoji"
                  placeholder="Any emoji"
                  value={spaceDraft.icon ?? ''}
                  onChange={(e) => setSpaceDraft({ ...spaceDraft, icon: lastGrapheme(e.target.value) || undefined })}
                />
                {inElectron && (
                  <button type="button" className="btn btn-sm" title="The macOS emoji picker (also ⌃⌘Space)" onClick={() => { emojiInput.current?.focus(); void window.api.invoke('app:emojiPanel') }}>More…</button>
                )}
              </div>
            </div>
            <p className="muted text-[10.5px]">A space has its own cookies and logins, so the same site can be signed in differently in each.</p>
            <button type="submit" className="btn btn-primary btn-sm" disabled={!spaceDraft.name.trim()}>{menu.edit ? 'Save' : 'Create space'}</button>
          </form>
        </Popover>
      )}
    </div>
  )
}

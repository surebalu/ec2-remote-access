import { useEffect, useRef, useState, type ReactElement } from 'react'
import '@devolutions/iron-remote-desktop'
import { displayControl, enableCredssp, init as initWasm } from '@devolutions/iron-remote-desktop-rdp'
import type { UserInteraction, NewSessionInfo } from '@devolutions/iron-remote-desktop'
import { useStore, type Tab } from '../store'
import HostActions from './HostActions'
import { Icon } from './icons'
import { isMobile, isKeyboardOpen, useKeyboardOpen } from '../mobile'
import { attachTouchGestures, captureSessions, NAMED_KEYS, RdpInput, type NamedKey } from '../rdpInput'
import KeyBar from './mobile/KeyBar'
import type { StickyMods } from '../terminalKeys'
import Sheet, { SheetItem } from './mobile/Sheet'

type IronElement = HTMLElement & { module?: unknown }

/** The RDP backend is a wasm-bindgen module; instantiate it once before the component touches it. */
let wasmReady: Promise<unknown> | null = null
function ensureWasm(): Promise<unknown> {
  if (!wasmReady) wasmReady = initWasm('WARN')
  return wasmReady
}

/** Back-off between automatic reconnect attempts. After the last one we stop and offer a manual button. */
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 15_000, 30_000]
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length

/** IronErrorKind values that a retry can never fix. */
const FATAL_KINDS: Record<number, string> = {
  1: 'Wrong password.',
  2: 'Logon failure: the server rejected the username/password. Check the account, domain, and whether RDP is allowed for it.',
  3: 'Access denied for this account.'
}
const OTHER_KINDS: Record<number, string> = {
  5: 'Could not reach the host through the local proxy.',
  6: 'RDP security negotiation failed (the server may require a different security layer).'
}

/** Session end reasons that mean a person chose to end it; those are not fought with a reconnect. */
const INTENTIONAL_END = /logoff|logged off|by (the )?user|user[- ]initiated|terminated by the client|disconnect(ed)? by (the )?(user|admin|client)/i
/** Another RDP client (another tab, Windows App, the console) took this user's session. Retrying would only fight it. */
const TAKEN_OVER = /another user connected|forcing the disconnection/i
const TAKEN_OVER_MSG = 'Another connection took over this Windows session (another tab or RDP client signed in as the same user). Click Reconnect to take it back.'

type Phase = 'connecting' | 'connected' | 'waiting' | 'signin' | 'closed' | 'failed'

/**
 * HiDPI: request the desktop at the display's native pixel density and ask Windows for the matching DPI scale, so
 * text is crisp on Retina screens instead of one remote pixel being stretched over four. Costs ~4x the bandwidth.
 */
const HIDPI_KEY = 'ui.rdpHiDpi'
function readHiDpiPref(): boolean {
  try {
    const v = localStorage.getItem(HIDPI_KEY)
    if (v !== null) return v === '1'
  } catch {
    /* storage unavailable */
  }
  // Off by default on phones: see sessionScale in RdpTab for why a scale change mid-session is avoided.
  return (window.devicePixelRatio || 1) > 1 && !isMobile()
}
/** Remote desktop size (even, within RDP limits) and Windows scale factor (percent) for a pane rectangle. */
function remoteSize(rect: { width: number; height: number }, hiDpi: boolean): { width: number; height: number; scale: number } {
  const dpr = hiDpi ? Math.min(window.devicePixelRatio || 1, 3) : 1
  // RDP wants even dimensions; the Display Control channel allows 200..8192.
  const even = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, Math.floor((n * dpr) / 4) * 4))
  return { width: even(rect.width, 800, 8192), height: even(rect.height, 600, 8192), scale: Math.round(dpr * 100) }
}

/** Fixed desktop sizes for apps that misbehave with live resizing; 'auto' follows the pane (Display Control). */
const RESOLUTIONS = ['auto', '1280x720', '1440x900', '1600x900', '1920x1080', '1920x1200', '2560x1440'] as const
type Resolution = (typeof RESOLUTIONS)[number]
const RES_KEY = 'ui.rdpResolution'
function readResolution(): Resolution {
  try {
    const v = localStorage.getItem(RES_KEY) as Resolution | null
    if (v && RESOLUTIONS.includes(v)) return v
  } catch {
    /* storage unavailable */
  }
  return 'auto'
}
function desktopSizeFor(res: Resolution, rect: { width: number; height: number }, hiDpi: boolean): { width: number; height: number; scale: number } {
  if (res === 'auto') return remoteSize(rect, hiDpi)
  const [width, height] = res.split('x').map(Number)
  return { width, height, scale: 100 }
}

/**
 * The component sizes its canvas from the window, assuming it reaches the window's bottom-right corner. On a phone
 * the key bar and the iOS keyboard sit below it, so the canvas is made to letterbox inside the pane instead.
 */
const CONTAIN_CSS = `
:host > div { width: 100%; height: 100%; }
.screen-wrapper, .screen-viewer { width: 100% !important; height: 100% !important; max-width: none !important; max-height: none !important; min-width: 0 !important; min-height: 0 !important; overflow: hidden !important; }
canvas { width: 100% !important; height: 100% !important; object-fit: contain; touch-action: none; }
`

const RDP_KEYS = ['Esc', 'Tab', 'Win', 'Up', 'Down', 'Left', 'Right', 'Del', 'Home', 'End', 'PgUp', 'PgDn', 'F4', 'F5'] as const
const RDP_KEY_NAMES: Record<string, NamedKey> = { Esc: 'Escape', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', Del: 'Delete', PgUp: 'PageUp', PgDn: 'PageDown' }
const NO_MODS: StickyMods = { ctrl: false, alt: false }

interface Failure {
  message: string
  detail: string
  fatal: boolean
  /** The AWS SSO token expired: the fix is to sign in, not to retry, so it does not count as a lost attempt. */
  authExpired?: boolean
}

/** Turns an IronRDP error into a user-facing message, preferring the proxy's account of what the server did. */
async function describeFailure(e: unknown, sessionId: string): Promise<Failure> {
  const err = e as { backtrace?: () => string; kind?: () => number; message?: string }
  const detail = typeof err.backtrace === 'function' ? err.backtrace() : (err.message ?? String(e))
  const kind = typeof err.kind === 'function' ? err.kind() : -1
  if (kind in FATAL_KINDS) return { message: FATAL_KINDS[kind], detail, fatal: true }
  if (TAKEN_OVER.test(detail)) return { message: TAKEN_OVER_MSG, detail, fatal: true }
  let message = OTHER_KINDS[kind] ?? detail.split('\n')[0]
  // "read frame: not enough bytes" is IronRDP's way of saying the stream ended mid-PDU: the host (or the path
  // to it) dropped the TCP connection. The proxy usually knows more about when that happened.
  if (/not enough bytes|read frame|UnexpectedEof|connection (reset|closed)/i.test(detail)) {
    message = 'The server dropped the connection before the session was established.'
  }
  if (/token is expired|sso session|ExpiredToken|credentials|not authorized to perform|InvalidClientTokenId|UnrecognizedClient/i.test(detail)) {
    return { message: 'Your AWS session expired. Sign in and this desktop will reconnect automatically.', detail, fatal: false, authExpired: true }
  }
  const proxyDetail = await window.api.invoke('rdp:lastError', sessionId).catch(() => undefined)
  if (proxyDetail) message = /tunnel stopped carrying data/.test(proxyDetail) ? 'The SSM tunnel stopped carrying data (network change or dropped AWS connection). Reconnecting through a new tunnel.' : proxyDetail
  return { message, detail, fatal: false }
}

/**
 * The component registers its clipboard callbacks asynchronously after it dispatches 'ready' (it awaits a
 * clipboard-read permission query first). The engine attaches the clipboard channel only if those callbacks exist
 * when connect() is called, so a connect issued straight from 'ready' can race it and the session silently gets no
 * clipboard. Issuing the same permission query ourselves queues our continuation behind the component's.
 */
async function waitForClipboardInit(): Promise<void> {
  try {
    await navigator.permissions.query({ name: 'clipboard-read' as PermissionName })
  } catch {
    /* unsupported: nothing to wait for */
  }
  await new Promise((r) => setTimeout(r, 50))
}

interface Controller {
  disposed: boolean
  /** Incremented on every effect run/cleanup; a run whose generation is stale must stop touching anything. */
  gen: number
  attempt: number
  timer?: ReturnType<typeof setTimeout>
  ticker?: ReturnType<typeof setInterval>
  /** Skip the remaining back-off and retry immediately. */
  retryNow?: () => void
  /** Fresh attempt series after the automatic ones gave up or the user cancelled. */
  reconnect?: () => void
  /** Stop the pending automatic retry. */
  cancel?: () => void
}

export default function RdpTab({ tab, active }: { tab: Tab; active: boolean }): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const uiRef = useRef<UserInteraction | null>(null)
  const ctl = useRef<Controller>({ disposed: false, gen: 0, attempt: 0 })
  const updateTab = useStore((s) => s.updateTab)
  const toast = useStore((s) => s.toast)
  const [scale, setScale] = useState<'fit' | 'real' | 'full'>('fit')
  const [log, setLog] = useState<string[]>([])
  const [phase, setPhase] = useState<Phase>('connecting')
  const [countdown, setCountdown] = useState(0)
  const [hiDpi, setHiDpi] = useState(readHiDpiPref)
  const hiDpiRef = useRef(hiDpi)
  const [resolution, setResolution] = useState<Resolution>(readResolution)
  const resRef = useRef(resolution)
  const [fullscreen, setFullscreen] = useState(false)
  const rdp = tab.rdpRequest!
  const mobile = isMobile()
  const touch = mobile
  const keyboardOpen = useKeyboardOpen()
  const input = useRef(new RdpInput())
  const touchRef = useRef<HTMLDivElement>(null)
  const kbRef = useRef<HTMLTextAreaElement>(null)
  const [mods, setModsState] = useState<StickyMods>(NO_MODS)
  const modsRef = useRef<StickyMods>(NO_MODS)
  const setMods = (m: StickyMods): void => { modsRef.current = m; setModsState(m) }
  const [rightClick, setRightClickState] = useState(false)
  const rightClickRef = useRef(false)
  const setRightClick = (on: boolean): void => { rightClickRef.current = on; setRightClickState(on) }
  const [mobileMenu, setMobileMenu] = useState(false)

  /**
   * The Windows display scale for this session, fixed when it connects. A resize that also changes the scale makes
   * Windows switch DPI live, and apps already open (SolidWorks, most non-per-monitor-aware apps) then draw at the
   * wrong size until the user signs out. Folding, rotating or hiding the host list must only change the size, so the
   * scale changes only when the user flips Retina.
   */
  const sessionScale = useRef<number | null>(null)

  const pushSize = (): void => {
    const host = hostRef.current
    if (!host || host.offsetParent === null) return
    const { width, height, scale } = desktopSizeFor(resRef.current, host.getBoundingClientRect(), hiDpiRef.current)
    try {
      uiRef.current?.resize(width, height, sessionScale.current ?? scale)
    } catch {
      /* not connected yet */
    }
  }

  useEffect(() => {
    const host = hostRef.current!
    const c = ctl.current
    // StrictMode (dev) runs this effect, its cleanup, then the effect again on the same ref. Each run gets its own
    // generation so a superseded run stops without a second connection racing the new one.
    c.gen += 1
    const gen = c.gen
    c.disposed = false
    c.attempt = 0
    const dead = (): boolean => c.gen !== gen || c.disposed
    let el: IronElement | null = null
    const id = tab.id
    const say = (m: string): void => setLog((l) => [...l.slice(-30), m])
    const clearTimers = (): void => {
      clearTimeout(c.timer)
      clearInterval(c.ticker)
      c.timer = c.ticker = undefined
    }

    const scheduleRetry = (ui: UserInteraction, why: string): void => {
      if (c.attempt >= MAX_ATTEMPTS) {
        setPhase('failed')
        say(`Gave up after ${MAX_ATTEMPTS} reconnect attempts.`)
        updateTab(id, { status: 'error', message: `${why} Gave up after ${MAX_ATTEMPTS} attempts.` })
        toast('error', `RDP ${tab.title}: ${why} Gave up after ${MAX_ATTEMPTS} reconnect attempts.`)
        return
      }
      const delay = RETRY_DELAYS_MS[c.attempt]
      c.attempt += 1
      const attempt = c.attempt
      let left = Math.round(delay / 1000)
      setPhase('waiting')
      setCountdown(left)
      say(`Reconnecting in ${left}s (attempt ${attempt}/${MAX_ATTEMPTS})…`)
      updateTab(id, { status: 'connecting', message: `${why} Reconnecting in ${left}s (${attempt}/${MAX_ATTEMPTS})…` })
      if (attempt === 1) toast('info', `RDP ${tab.title}: ${why} Reconnecting…`)
      c.ticker = setInterval(() => {
        left = Math.max(0, left - 1)
        setCountdown(left)
        updateTab(id, { message: `${why} Reconnecting in ${left}s (${attempt}/${MAX_ATTEMPTS})…` })
      }, 1000)
      c.timer = setTimeout(() => {
        clearTimers()
        void connectOnce(ui)
      }, delay)
    }

    /**
     * The SSO token expired mid-session. Don't burn reconnect attempts on it: show the sign-in prompt (noteOperationError
     * already raised the banner) and poll the store's auth state; the moment a fresh token lands, reconnect for free.
     */
    const waitForSignIn = (ui: UserInteraction): void => {
      clearTimers()
      c.attempt = 0
      setPhase('signin')
      const msg = 'AWS session expired. Sign in and this desktop reconnects automatically.'
      say(msg)
      updateTab(id, { status: 'connecting', message: msg })
      c.ticker = setInterval(() => {
        if (dead()) { clearTimers(); return }
        if (useStore.getState().authState().kind === 'ok') {
          clearTimers()
          say('Signed in; reconnecting…')
          void connectOnce(ui)
        }
      }, 1500)
    }

    /** One full connection cycle: resolve the path, connect, then run until the session ends. */
    const connectOnce = async (ui: UserInteraction): Promise<void> => {
      const attempt = c.attempt
      setPhase('connecting')
      try {
        say(attempt ? `Reconnect attempt ${attempt}/${MAX_ATTEMPTS}: resolving network path…` : 'Resolving network path…')
        updateTab(id, { status: 'connecting', message: attempt ? `Reconnecting (${attempt}/${MAX_ATTEMPTS})…` : 'Connecting…' })
        const prep = await window.api.invoke('rdp:prepare', {
          sessionId: id,
          instanceKey: tab.instanceKey,
          user: rdp.user,
          port: rdp.port,
          forceRoute: rdp.forceRoute
        })
        if (dead()) return
        say(`Connecting to ${prep.destination} via ${prep.route === 'ssm' ? 'SSM tunnel' : 'direct'} as ${rdp.user}`)
        // Ask for a desktop matching the pane (at native density when HiDPI is on) so "1:1" is crisp.
        const initial = desktopSizeFor(resRef.current, host.getBoundingClientRect(), hiDpiRef.current)
        const desktopSize = { width: initial.width, height: initial.height }
        const config = ui
          .configBuilder()
          .withDesktopSize(desktopSize)
          .withDestination(prep.destination)
          .withProxyAddress(prep.proxyUrl)
          .withAuthToken(prep.token)
          .withUsername(rdp.user)
          .withPassword(rdp.password)
          .withServerDomain(rdp.domain ?? '')
          .withExtension(enableCredssp(true))
          // Registers the Display Control virtual channel; without it the server ignores every resize request.
          .withExtension(displayControl(true))
          .build()
        const session: NewSessionInfo = await ui.connect(config)
        if (dead()) return
        // The component keeps its screen wrapper hidden until told otherwise (and hides it again when a session ends).
        ui.setVisibility(true)
        c.attempt = 0
        setPhase('connected')
        // The initial size carries no DPI. Send size and scale once the Display Control channel is up; it comes up a
        // little after connect and drops earlier requests silently, so ask again a few seconds later.
        sessionScale.current = initial.scale
        for (const ms of [1500, 4000]) setTimeout(() => { if (!dead()) pushSize() }, ms)
        if (attempt) toast('success', `RDP ${tab.title}: reconnected.`)
        updateTab(id, {
          status: 'connected',
          route: prep.route,
          message: `${rdp.user}@${prep.destination} · ${session.initialDesktopSize.width}×${session.initialDesktopSize.height}`
        })
        const term = await session.run()
        if (dead()) return
        const reason = term.reason()
        say(`Session ended: ${reason}`)
        if (INTENTIONAL_END.test(reason)) {
          setPhase('closed')
          updateTab(id, { status: 'closed', message: reason })
          return
        }
        if (TAKEN_OVER.test(reason)) {
          setPhase('failed')
          say(`Error: ${TAKEN_OVER_MSG}`)
          updateTab(id, { status: 'error', message: TAKEN_OVER_MSG })
          toast('error', `RDP ${tab.title}: ${TAKEN_OVER_MSG}`)
          return
        }
        scheduleRetry(ui, `Connection lost (${reason}).`)
      } catch (e) {
        if (dead()) return
        const f = await describeFailure(e, id)
        if (dead()) return
        useStore.getState().noteOperationError(f.detail)
        say(`Error: ${f.message}`)
        if (f.message !== f.detail) say(f.detail)
        if (f.fatal) {
          setPhase('failed')
          updateTab(id, { status: 'error', message: f.message })
          toast('error', `RDP: ${f.message}`)
          return
        }
        if (f.authExpired) { waitForSignIn(ui); return }
        scheduleRetry(ui, f.message)
      }
    }

    const start = async (): Promise<void> => {
      setLog([])
      say('Loading RDP engine…')
      try {
        await ensureWasm()
      } catch (e) {
        say(`Error: WASM init failed: ${(e as Error).message}`)
        updateTab(id, { status: 'error', message: `WASM init failed: ${(e as Error).message}` })
        return
      }
      if (dead()) return
      el = document.createElement('iron-remote-desktop') as IronElement
      el.setAttribute('scale', 'fit')
      el.setAttribute('verbose', 'false')
      el.setAttribute('flexcentre', 'true')
      el.style.width = '100%'
      el.style.height = '100%'
      el.style.display = 'block'
      // A backend copy that hands us each connected Session, for touch and on-screen keyboard input.
      el.module = captureSessions((session) => { input.current.session = session })
      host.appendChild(el)
      if (mobile && el.shadowRoot) {
        const style = document.createElement('style')
        style.textContent = CONTAIN_CSS
        el.shadowRoot.appendChild(style)
      }

      el.addEventListener('ready', (ev: Event) => {
        const detail = (ev as CustomEvent).detail as UserInteraction & { irgUserInteraction?: UserInteraction }
        const ui = detail.irgUserInteraction ?? detail
        uiRef.current = ui
        ui.onWarningCallback((w) => say(`warning: ${w}`))
        ui.setEnableClipboard(true)
        ui.setEnableAutoClipboard(true)
        c.retryNow = () => {
          clearTimers()
          void connectOnce(ui)
        }
        c.reconnect = () => {
          clearTimers()
          c.attempt = 0
          void connectOnce(ui)
        }
        c.cancel = () => {
          clearTimers()
          setPhase('closed')
          say('Reconnect cancelled.')
          updateTab(id, { status: 'closed', message: 'Disconnected (reconnect cancelled)' })
        }
        void waitForClipboardInit().then(() => {
          if (!dead()) void connectOnce(ui)
        })
      })
    }
    void start()

    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    const ro = new ResizeObserver(() => {
      // The pane shrinks while the phone keyboard is up; resizing Windows for that would re-lay out the desktop
      // twice per keystroke session, so the canvas just letterboxes until the keyboard goes away.
      if (host.offsetParent === null || resRef.current !== 'auto' || (mobile && isKeyboardOpen())) return
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(pushSize, 300)
    })
    ro.observe(host)

    return () => {
      c.disposed = true
      c.gen += 1
      clearTimers()
      ro.disconnect()
      clearTimeout(resizeTimer)
      try {
        uiRef.current?.shutdown()
      } catch {
        /* ignore */
      }
      el?.remove()
      void window.api.invoke('rdp:release', id)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (active) pushSize()
  }, [active]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggleHiDpi = (on: boolean): void => {
    setHiDpi(on)
    hiDpiRef.current = on
    // The one deliberate scale change: follow the new setting.
    sessionScale.current = on ? Math.round(Math.min(window.devicePixelRatio || 1, 3) * 100) : 100
    try {
      localStorage.setItem(HIDPI_KEY, on ? '1' : '0')
    } catch {
      /* storage unavailable */
    }
    pushSize()
  }

  const changeResolution = (r: Resolution): void => {
    setResolution(r)
    resRef.current = r
    try {
      localStorage.setItem(RES_KEY, r)
    } catch {
      /* storage unavailable */
    }
    pushSize()
  }

  // Full screen puts only the desktop on screen. Keyboard Lock lets Esc, ⌘Tab and friends reach Windows; holding Esc
  // exits, which is Chromium's rule for locked full screen.
  const toggleFullscreen = async (): Promise<void> => {
    const host = hostRef.current
    if (!host) return
    if (document.fullscreenElement) { await document.exitFullscreen().catch(() => undefined); return }
    await host.requestFullscreen().catch((e: Error) => toast('error', `Full screen failed: ${e.message}`))
    const kb = (navigator as Navigator & { keyboard?: { lock?: () => Promise<void> } }).keyboard
    await kb?.lock?.().catch(() => undefined)
  }
  useEffect(() => {
    const onChange = (): void => {
      const on = document.fullscreenElement === hostRef.current
      setFullscreen(on)
      if (!on) (navigator as Navigator & { keyboard?: { unlock?: () => void } }).keyboard?.unlock?.()
      setTimeout(pushSize, 300)
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (mobile && !keyboardOpen) setTimeout(pushSize, 300)
  }, [keyboardOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const layer = touchRef.current
    if (!touch || !layer) return
    const toDesktop = (cx: number, cy: number): { x: number; y: number } | null => {
      const canvas = hostRef.current?.querySelector('iron-remote-desktop')?.shadowRoot?.querySelector('canvas')
      if (!canvas || !canvas.width) return null
      const r = canvas.getBoundingClientRect()
      if (!r.width || !r.height) return null
      // With object-fit: contain (phones) the bitmap is centred inside the element; otherwise it fills it exactly.
      const k = mobile ? Math.min(r.width / canvas.width, r.height / canvas.height) : r.width / canvas.width
      const ky = mobile ? k : r.height / canvas.height
      const left = r.left + (r.width - canvas.width * k) / 2
      const top = r.top + (r.height - canvas.height * ky) / 2
      const clamp = (v: number, max: number): number => Math.max(0, Math.min(max - 1, v))
      return { x: clamp((cx - left) / k, canvas.width), y: clamp((cy - top) / ky, canvas.height) }
    }
    return attachTouchGestures(layer, {
      toDesktop,
      input: input.current,
      takeRightClick: () => {
        const on = rightClickRef.current
        if (on) setRightClick(false)
        return on
      }
    })
  }, [touch]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Consumes the key bar's one-shot modifiers. */
  const takeMods = (): { ctrl: boolean; alt: boolean; meta: boolean } => {
    const m = modsRef.current
    if (m.ctrl || m.alt) setMods(NO_MODS)
    return { ctrl: m.ctrl, alt: m.alt, meta: false }
  }
  const sendBarKey = (k: string): void => {
    if (k === 'Win') { uiRef.current?.metaKey(); return }
    input.current.key(RDP_KEY_NAMES[k] ?? (k as NamedKey), takeMods())
  }
  // The hidden textarea is only there to raise the iOS keyboard; everything typed is forwarded and it stays empty.
  const onKbKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    const hw = { ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey }
    if (NAMED_KEYS.has(e.key)) {
      e.preventDefault()
      const m = takeMods()
      input.current.key(e.key as NamedKey, { ctrl: m.ctrl || hw.ctrl, alt: m.alt || hw.alt, meta: hw.meta })
    } else if (e.key.length === 1 && (hw.ctrl || hw.alt || hw.meta)) {
      e.preventDefault()
      input.current.text(e.key, hw)
    }
  }
  const onKbBeforeInput = (e: React.FormEvent<HTMLTextAreaElement>): void => {
    const ev = e.nativeEvent as InputEvent
    if (ev.inputType === 'insertText' || ev.inputType === 'insertReplacementText' || ev.inputType === 'insertFromPaste') {
      if (ev.data) input.current.text(ev.data, takeMods())
      e.preventDefault()
    } else if (ev.inputType === 'insertLineBreak' || ev.inputType === 'insertParagraph') {
      input.current.key('Enter', takeMods())
      e.preventDefault()
    } else if (ev.inputType === 'deleteContentBackward') {
      input.current.key('Backspace', takeMods())
      e.preventDefault()
    }
  }
  const onKbInput = (e: React.FormEvent<HTMLTextAreaElement>): void => {
    // Fallback for input the browser would not let us cancel (dictation, some predictive-text commits).
    const t = e.currentTarget
    if (t.value) { input.current.text(t.value, takeMods()); t.value = '' }
  }
  const toggleKeyboard = (): void => {
    const kb = kbRef.current
    if (!kb) return
    if (keyboardOpen || document.activeElement === kb) kb.blur()
    else kb.focus()
  }

  const copyDiagnostics = async (): Promise<void> => {
    const main = await window.api.invoke('diag:log', { lines: 300, filter: 'rdp|ssm|tunnel|phone-access|\\[app\\]' })
    const head = [
      `EC2 Remote Access RDP diagnostics (${new Date().toISOString()})`,
      `Host: ${tab.title}  key=${tab.instanceKey}  status=${tab.status}  phase=${phase}`,
      `Message: ${tab.message ?? ''}`,
      `Request: user=${rdp.user} port=${rdp.port} forceRoute=${rdp.forceRoute ?? 'auto'}`,
      `Log file: ${main.path ?? 'n/a'}`,
      '', '--- Session events ---', ...log, '', '--- App log (rdp/ssm/tunnel) ---', main.text
    ]
    await window.api.invoke('clipboard:write', head.join('\n'))
    toast('success', 'Diagnostics copied to the clipboard')
  }
  const syncClipboard = (): void =>
    void uiRef.current
      ?.sendClipboardData()
      .then(() => toast('success', 'Clipboard sent to the remote desktop.'))
      .catch((e: unknown) => toast('error', `Clipboard sync failed: ${(e as Error).message ?? String(e)}`))

  const setScaleMode = (m: 'fit' | 'real' | 'full'): void => {
    setScale(m)
    const map = { fit: 1, full: 2, real: 3 } as const
    try {
      uiRef.current?.setScale(map[m] as never)
    } catch {
      /* ignore */
    }
  }

  const desktopArea = (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-black">
      <div ref={hostRef} className="absolute inset-0" />
      {/* Touch layer: gestures become RDP mouse input (tap = click, hold = right click, two fingers = scroll). */}
      {touch && <div ref={touchRef} className="rdp-touch absolute inset-0" />}
      {touch && (
        <textarea
          ref={kbRef}
          className="rdp-kb"
          aria-label="Type on the remote desktop"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="enter"
          onKeyDown={onKbKeyDown}
          onBeforeInput={onKbBeforeInput}
          onInput={onKbInput}
          onBlur={() => input.current.releaseAll()}
        />
      )}
    </div>
  )
  const logPanel = tab.status !== 'connected' && log.length > 0 && (
    <div className="panel border-t px-3 py-1 font-mono text-[10px]" style={{ borderColor: 'var(--border)', maxHeight: 96, overflow: 'auto' }}>
      {log.map((l, i) => (
        <div key={i} className={l.startsWith('Error') ? 'text-red-500' : 'muted'}>
          {l}
        </div>
      ))}
    </div>
  )

  if (mobile) {
    const res = (r: Resolution): string => (r === 'auto' ? 'Fit this screen' : r.replace('x', '×'))
    return (
      <div className="flex h-full flex-col">
        {phase !== 'connected' && (
          <div className="m-status-strip">
            <span className="min-w-0 flex-1 truncate">{tab.message ?? 'Connecting…'}</span>
            {phase === 'waiting' && <button className="btn btn-sm" onClick={() => ctl.current.retryNow?.()}>Retry{countdown > 0 ? ` (${countdown}s)` : ''}</button>}
            {phase === 'waiting' && <button className="btn btn-sm" onClick={() => ctl.current.cancel?.()}>Cancel</button>}
            {phase === 'signin' && <button className="btn btn-primary btn-sm" disabled={useStore.getState().loggingIn} onClick={() => void useStore.getState().refreshToken()}>Sign in</button>}
            {(phase === 'failed' || phase === 'closed') && <button className="btn btn-primary btn-sm" onClick={() => ctl.current.reconnect?.()}>Reconnect</button>}
          </div>
        )}
        {desktopArea}
        {logPanel}
        <KeyBar
          mods={mods}
          onMods={setMods}
          onKey={sendBarKey}
          keys={RDP_KEYS}
          keyboardOpen={keyboardOpen}
          onKeyboard={toggleKeyboard}
          onMore={() => setMobileMenu(true)}
          leading={
            <button type="button" className={`m-key wide ${rightClick ? 'on' : ''}`} aria-pressed={rightClick} aria-label="Right-click on next tap" onPointerDown={(e) => e.preventDefault()} onClick={() => setRightClick(!rightClick)}>
              R-click
            </button>
          }
        />
        {mobileMenu && (
          <Sheet title={tab.title} subtitle={<>{tab.message}<br />Tap to click · hold to right-click · drag to select · two fingers to scroll</>} onClose={() => setMobileMenu(false)}>
            <SheetItem icon={<Icon.keyboard />} disabled={tab.status !== 'connected'} onClick={() => { setMobileMenu(false); uiRef.current?.ctrlAltDel() }}>Send Ctrl+Alt+Del</SheetItem>
            <SheetItem icon={<Icon.windows />} disabled={tab.status !== 'connected'} onClick={() => { setMobileMenu(false); uiRef.current?.metaKey() }}>Send Windows key</SheetItem>
            <SheetItem icon={<Icon.snippet />} disabled={tab.status !== 'connected'} onClick={() => { setMobileMenu(false); syncClipboard() }}>Send this phone's clipboard</SheetItem>
            <SheetItem icon={<Icon.monitor />} hint={hiDpi ? 'On' : 'Off'} onClick={() => toggleHiDpi(!hiDpi)}>
              Sharp text (Retina)
              <span className="muted block whitespace-normal text-[12px]">Changes Windows display scaling; apps already open may draw wrong until you sign out.</span>
            </SheetItem>
            <SheetItem icon={<Icon.grid />} hint={res(resolution)} onClick={() => changeResolution(RESOLUTIONS[(RESOLUTIONS.indexOf(resolution) + 1) % RESOLUTIONS.length])}>Desktop size</SheetItem>
            {(phase === 'failed' || phase === 'closed') && <SheetItem icon={<Icon.refresh />} onClick={() => { setMobileMenu(false); ctl.current.reconnect?.() }}>Reconnect</SheetItem>}
            <SheetItem icon={<Icon.activity />} onClick={() => { setMobileMenu(false); void copyDiagnostics() }}>Copy diagnostics</SheetItem>
            <SheetItem icon={<Icon.x />} danger onClick={() => { setMobileMenu(false); void useStore.getState().closeTab(tab.id) }}>Disconnect</SheetItem>
          </Sheet>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="panel flex items-center gap-2 border-b px-2 py-1 text-[11px]" style={{ borderColor: 'var(--border)' }}>
        <span className="muted">{tab.message ?? 'Connecting…'}</span>
        <span className="flex-1" />
        {phase === 'waiting' && (
          <>
            <button className="btn !py-0.5" onClick={() => ctl.current.retryNow?.()}>
              Reconnect now{countdown > 0 ? ` (${countdown}s)` : ''}
            </button>
            <button className="btn !py-0.5" onClick={() => ctl.current.cancel?.()}>
              Cancel
            </button>
          </>
        )}
        {phase === 'signin' && (
          <button className="btn btn-primary !py-0.5" disabled={useStore.getState().loggingIn} onClick={() => void useStore.getState().refreshToken()}>
            Sign in
          </button>
        )}
        {(phase === 'failed' || phase === 'closed') && (
          <button className="btn !py-0.5" onClick={() => ctl.current.reconnect?.()}>
            Reconnect
          </button>
        )}
        <label
          className="muted flex items-center gap-1"
          title={`Render the remote desktop at this display's native pixel density (sharper text, more bandwidth). Windows applies the matching DPI scale; some apps need a sign-out to pick it up. This display: ${Math.round((window.devicePixelRatio || 1) * 100)}%`}
        >
          <input type="checkbox" checked={hiDpi} onChange={(e) => toggleHiDpi(e.target.checked)} />
          Retina
        </label>
        <select className="input !w-auto !py-0.5" title="Remote desktop size. Auto follows this pane; a fixed size is scaled to fit." value={resolution} onChange={(e) => changeResolution(e.target.value as Resolution)}>
          {RESOLUTIONS.map((r) => <option key={r} value={r}>{r === 'auto' ? 'Auto size' : r.replace('x', '×')}</option>)}
        </select>
        <select className="input !w-auto !py-0.5" value={scale} onChange={(e) => setScaleMode(e.target.value as typeof scale)}>
          <option value="fit">Fit</option>
          <option value="full">Fill</option>
          <option value="real">1:1</option>
        </select>
        <button
          className="btn !py-0.5"
          title="Send the Mac clipboard to the remote desktop now (normally automatic whenever this window has focus)"
          disabled={tab.status !== 'connected'}
          onClick={syncClipboard}
        >
          Sync clipboard
        </button>
        <button className="btn !py-0.5" title="Send Ctrl+Alt+Del" onClick={() => uiRef.current?.ctrlAltDel()}>
          Ctrl+Alt+Del
        </button>
        <button className="btn !py-0.5" title="Send Windows key" onClick={() => uiRef.current?.metaKey()}>
          ⊞
        </button>
        <button
          className="btn !py-0.5"
          title="Copy this session's event log plus the matching lines from the app log, for troubleshooting"
          onClick={() => void copyDiagnostics()}
        >
          Copy diagnostics
        </button>
        <button className={`btn btn-ghost btn-sm btn-icon ${fullscreen ? 'on' : ''}`} title="Full screen (hold Esc to leave)" disabled={tab.status !== 'connected'} onClick={() => void toggleFullscreen()}>
          <Icon.maximize />
        </button>
        <span className="mx-1 h-4 border-l" style={{ borderColor: 'var(--border)' }} />
        <HostActions instanceKey={tab.instanceKey} current="rdp" />
        <button className="btn !py-0.5" onClick={() => void useStore.getState().closeTab(tab.id)}>
          Disconnect
        </button>
      </div>
      {desktopArea}
      {logPanel}
    </div>
  )
}

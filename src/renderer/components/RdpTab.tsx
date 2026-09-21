import { useEffect, useRef, useState, type ReactElement } from 'react'
import '@devolutions/iron-remote-desktop'
import { Backend, displayControl, enableCredssp, init as initWasm } from '@devolutions/iron-remote-desktop-rdp'
import type { UserInteraction, NewSessionInfo } from '@devolutions/iron-remote-desktop'
import { useStore, type Tab } from '../store'
import HostActions from './HostActions'

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
  return (window.devicePixelRatio || 1) > 1
}
/** Remote desktop size (even, within RDP limits) and Windows scale factor (percent) for a pane rectangle. */
function remoteSize(rect: { width: number; height: number }, hiDpi: boolean): { width: number; height: number; scale: number } {
  const dpr = hiDpi ? Math.min(window.devicePixelRatio || 1, 3) : 1
  // RDP wants even dimensions; the Display Control channel allows 200..8192.
  const even = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, Math.floor((n * dpr) / 4) * 4))
  return { width: even(rect.width, 800, 8192), height: even(rect.height, 600, 8192), scale: Math.round(dpr * 100) }
}

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
  if (proxyDetail) message = proxyDetail
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
  const rdp = tab.rdpRequest!

  const pushSize = (): void => {
    const host = hostRef.current
    if (!host || host.offsetParent === null) return
    const { width, height, scale } = remoteSize(host.getBoundingClientRect(), hiDpiRef.current)
    try {
      uiRef.current?.resize(width, height, scale)
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
        const initial = remoteSize(host.getBoundingClientRect(), hiDpiRef.current)
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
        // The initial size carries no DPI; send the scale factor once the Display Control channel is up.
        if (initial.scale !== 100) setTimeout(pushSize, 1500)
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
      el.module = Backend
      host.appendChild(el)

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
      if (host.offsetParent === null) return
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
    try {
      localStorage.setItem(HIDPI_KEY, on ? '1' : '0')
    } catch {
      /* storage unavailable */
    }
    pushSize()
  }

  const setScaleMode = (m: 'fit' | 'real' | 'full'): void => {
    setScale(m)
    const map = { fit: 1, full: 2, real: 3 } as const
    try {
      uiRef.current?.setScale(map[m] as never)
    } catch {
      /* ignore */
    }
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
        <select className="input !w-auto !py-0.5" value={scale} onChange={(e) => setScaleMode(e.target.value as typeof scale)}>
          <option value="fit">Fit</option>
          <option value="full">Fill</option>
          <option value="real">1:1</option>
        </select>
        <button
          className="btn !py-0.5"
          title="Send the Mac clipboard to the remote desktop now (normally automatic whenever this window has focus)"
          disabled={tab.status !== 'connected'}
          onClick={() =>
            void uiRef.current
              ?.sendClipboardData()
              .then(() => toast('success', 'Clipboard sent to the remote desktop.'))
              .catch((e: unknown) => toast('error', `Clipboard sync failed: ${(e as Error).message ?? String(e)}`))
          }
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
          onClick={async () => {
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
          }}
        >
          Copy diagnostics
        </button>
        <span className="mx-1 h-4 border-l" style={{ borderColor: 'var(--border)' }} />
        <HostActions instanceKey={tab.instanceKey} current="rdp" />
        <button className="btn !py-0.5" onClick={() => void useStore.getState().closeTab(tab.id)}>
          Disconnect
        </button>
      </div>
      <div ref={hostRef} className="relative min-h-0 flex-1 overflow-hidden bg-black" />
      {tab.status !== 'connected' && log.length > 0 && (
        <div className="panel border-t px-3 py-1 font-mono text-[10px]" style={{ borderColor: 'var(--border)', maxHeight: 96, overflow: 'auto' }}>
          {log.map((l, i) => (
            <div key={i} className={l.startsWith('Error') ? 'text-red-500' : 'muted'}>
              {l}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react'
import RFB from '@novnc/novnc'
import { allInstances, useStore, vncCredKey, type Tab } from '../store'
import HostActions, { openHostNote } from './HostActions'
import { Icon } from './icons'
import { isMobile, pasteFromClipboard, useKeyboardOpen } from '../mobile'
import KeyBar from './mobile/KeyBar'
import Sheet, { SheetItem } from './mobile/Sheet'
import { PasteSheet } from './mobile/ClipboardSheets'
import type { StickyMods } from '../terminalKeys'
import { charKeysym, forAppleServer, modifierKeysym, NAMED_KEYSYMS, type VncModifier } from '@shared/vncKeys'
import { registerDictationTarget } from '../voice'

/**
 * Another computer's screen (VNC / RFB), the way Screens shows one: macOS Screen Sharing over Tailscale above all, but
 * any VNC server works. The page runs noVNC; main relays its WebSocket to the host's port (main/vnc). A Mac signs in
 * with a user name and password of an account on it (Apple's Diffie-Hellman scheme, type 30), other servers with a
 * VNC password or nothing; noVNC asks only for what the server wants, and so does this tab.
 */

/** Back-off between automatic reconnects after a connection drops. After the last one the tab offers Reconnect. */
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 15_000, 30_000]

type Phase = 'connecting' | 'signin' | 'verify' | 'connected' | 'waiting' | 'closed' | 'failed'
type Scale = 'fit' | 'real'
type Quality = 'balanced' | 'sharp' | 'fast'
/** JPEG quality and zlib effort per preset (noVNC's 0–9 scales); "fast" is for a phone on a weak signal. */
const QUALITY: Record<Quality, { quality: number; compression: number; label: string }> = {
  balanced: { quality: 6, compression: 2, label: 'Balanced' },
  sharp: { quality: 9, compression: 0, label: 'Sharp' },
  fast: { quality: 2, compression: 9, label: 'Low bandwidth' }
}

const VNC_KEYS = ['Esc', 'Tab', 'Up', 'Down', 'Left', 'Right', 'Del', 'Home', 'End', 'PgUp', 'PgDn', 'F1', 'F2', 'F3', 'F4', 'F5'] as const
const KEY_NAMES: Record<string, string> = { Esc: 'Escape', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', Del: 'Delete', PgUp: 'PageUp', PgDn: 'PageDown' }
const NO_MODS: StickyMods = { ctrl: false, alt: false }
/** Characters typed with Shift on a US layout; sent with Shift held so a server that maps by key code gets them right. */
const SHIFTED = /^[A-Z~!@#$%^&*()_+{}|:"<>?]$/

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null
    if (v && allowed.includes(v)) return v
  } catch { /* storage unavailable */ }
  return fallback
}
function writePref(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* storage unavailable */ }
}

/** The SHA-256 of a server's public key as grouped hex, the way people compare fingerprints. */
async function fingerprint(key: Uint8Array): Promise<string> {
  let bytes = key
  try {
    bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', key as BufferSource))
  } catch { /* no WebCrypto (plain http): show the key's own first bytes */ }
  const hex = Array.from(bytes.slice(0, 32), (b) => b.toString(16).padStart(2, '0')).join('')
  return hex.match(/.{1,4}/g)!.join(' ')
}

interface SignIn {
  /** What the server asked for: ['password'] or ['username', 'password']. */
  types: string[]
  error?: string
}

export default function VncTab({ tab, active, tiled = false }: { tab: Tab; active: boolean; tiled?: boolean }): ReactElement {
  const screenRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const rfbRef = useRef<RFB | null>(null)
  const updateTab = useStore((s) => s.updateTab)
  const toast = useStore((s) => s.toast)
  const inst = useStore((s) => allInstances(s).find((i) => i.key === tab.instanceKey))
  const hostName = inst?.name ?? tab.title
  /** A Mac on the far end: ⌥ and the key bar's ⌘ are sent the way macOS reads them (@shared/vncKeys). */
  const macHost = inst?.tailnet?.os === 'macOS' || /mac ?os|os ?x/i.test(inst?.osHint ?? '')
  const req = tab.vncRequest ?? {}
  const mobile = isMobile()
  const keyboardOpen = useKeyboardOpen()

  const [phase, setPhaseState] = useState<Phase>('connecting')
  // Key presses, dictation and the clipboard read the phase from handlers made once, so they need it current.
  const phaseRef = useRef<Phase>('connecting')
  const setPhase = (p: Phase): void => { phaseRef.current = p; setPhaseState(p) }
  const [message, setMessage] = useState('Connecting…')
  const [signIn, setSignIn] = useState<SignIn | null>(null)
  const [verify, setVerify] = useState<{ print: string; changed: boolean } | null>(null)
  const [countdown, setCountdown] = useState(0)
  const [scale, setScale] = useState<Scale>(() => readPref('ui.vncScale', ['fit', 'real'] as const, 'fit'))
  const [quality, setQuality] = useState<Quality>(() => readPref('ui.vncQuality', ['balanced', 'sharp', 'fast'] as const, 'balanced'))
  const [viewOnly, setViewOnly] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [mods, setModsState] = useState<StickyMods>(NO_MODS)
  const modsRef = useRef<StickyMods>(NO_MODS)
  const setMods = (m: StickyMods): void => { modsRef.current = m; setModsState(m) }
  const [cmdArmed, setCmdArmedState] = useState(false)
  const cmdRef = useRef(false)
  const setCmdArmed = (on: boolean): void => { cmdRef.current = on; setCmdArmedState(on) }
  const [mobileMenu, setMobileMenu] = useState(false)
  const [pasteBox, setPasteBox] = useState<string | null>(null)
  /** Text the remote computer copied, waiting for a tap to reach the phone's clipboard (WebKit writes only from a tap). */
  const [remoteClip, setRemoteClip] = useState<string | null>(null)
  const kbRef = useRef<HTMLTextAreaElement>(null)
  const userRef = useRef<HTMLInputElement>(null)
  const passRef = useRef<HTMLInputElement>(null)
  const [remember, setRemember] = useState(true)

  /** Everything the connection cycle needs that outlives a render. */
  const ctl = useRef({
    disposed: false,
    attempt: 0,
    everConnected: false,
    authFailed: false,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    ticker: undefined as ReturnType<typeof setInterval> | undefined,
    /** Credentials for the next connection: saved ones, or what the user typed. */
    creds: { username: req.user, password: req.password } as { username?: string; password?: string },
    /** Whether `creds` came from the saved sign-in (a rejection then clears it rather than asking forever). */
    saved: !!req.password,
    /** The user asked to remember what they typed; saved once the computer accepts it. */
    rememberTyped: false,
    /** Until when the remote clipboard is not copied here: a server may announce what it already holds on connect. */
    clipQuietUntil: 0,
    connect: (() => undefined) as () => void
  })
  const activeRef = useRef(active)
  activeRef.current = active
  const scaleRef = useRef(scale)
  scaleRef.current = scale
  const qualityRef = useRef(quality)
  qualityRef.current = quality

  const appleServer = (): boolean => macHost || (rfbRef.current as unknown as { _rfbAuthScheme?: number } | null)?._rfbAuthScheme === 30

  const applyView = (rfb: RFB): void => {
    // Fit scales the remote screen into the pane; 1:1 shows it pixel for pixel and the pane scrolls by dragging.
    rfb.scaleViewport = scaleRef.current === 'fit'
    rfb.clipViewport = scaleRef.current === 'real'
    rfb.dragViewport = false
    rfb.resizeSession = false
    rfb.qualityLevel = QUALITY[qualityRef.current].quality
    rfb.compressionLevel = QUALITY[qualityRef.current].compression
  }

  useEffect(() => {
    const c = ctl.current
    const id = tab.id
    const clearTimers = (): void => {
      if (c.timer) clearTimeout(c.timer)
      if (c.ticker) clearInterval(c.ticker)
      c.timer = undefined
      c.ticker = undefined
    }
    const say = (status: Tab['status'], text: string): void => {
      setMessage(text)
      updateTab(id, { status, message: text })
    }

    const scheduleRetry = (why: string): void => {
      if (c.attempt >= RETRY_DELAYS_MS.length) {
        setPhase('failed')
        say('error', `${why} Gave up after ${RETRY_DELAYS_MS.length} attempts.`)
        return
      }
      const delay = RETRY_DELAYS_MS[c.attempt]
      c.attempt++
      setPhase('waiting')
      let left = Math.round(delay / 1000)
      setCountdown(left)
      say('connecting', `${why} Reconnecting in ${left}s…`)
      c.ticker = setInterval(() => { left = Math.max(0, left - 1); setCountdown(left) }, 1000)
      c.timer = setTimeout(() => { clearTimers(); connect() }, delay)
    }

    const connect = (): void => {
      if (c.disposed) return
      clearTimers()
      c.authFailed = false
      setSignIn(null)
      setVerify(null)
      setPhase('connecting')
      say('connecting', c.attempt ? `Reconnecting to ${hostName}…` : `Connecting to ${hostName}…`)
      void (async () => {
        let prep
        try {
          prep = await window.api.invoke('vnc:prepare', { sessionId: id, instanceKey: tab.instanceKey, port: req.port, forceRoute: req.forceRoute })
        } catch (e) {
          if (c.disposed) return
          setPhase('failed')
          say('error', (e as Error).message)
          return
        }
        if (c.disposed || !screenRef.current) return
        rfbRef.current?.disconnect()
        screenRef.current.replaceChildren()
        const credentials = c.creds.password !== undefined ? { username: c.creds.username, password: c.creds.password } : undefined
        const rfb = new RFB(screenRef.current, prep.url, { shared: true, credentials })
        rfbRef.current = rfb
        applyView(rfb)
        rfb.background = '#000'
        rfb.focusOnClick = !mobile
        rfb.showDotCursor = true
        rfb.viewOnly = viewOnlyRef.current
        // noVNC sends ⌥ as Mode_switch, which macOS's key table does not have; a Mac reads Meta as ⌥ (@shared/vncKeys).
        // `_keyboard` is noVNC's own key listener (1.7.0, pinned); without it keys still work, ⌥ just goes missing.
        const kb = (rfb as unknown as { _keyboard?: { onkeyevent: (keysym: number, ...rest: unknown[]) => void } })._keyboard
        if (kb) {
          const send = kb.onkeyevent
          kb.onkeyevent = (keysym, ...rest) => send(appleServer() ? forAppleServer(keysym) : keysym, ...rest)
        }

        rfb.addEventListener('connect', () => {
          if (c.disposed) return
          const was = c.attempt
          c.attempt = 0
          c.everConnected = true
          c.clipQuietUntil = Date.now() + 3000
          setPhase('connected')
          setSignIn(null)
          say('connected', `${prep.destination}${prep.route === 'ssm' ? ' via SSM' : ''}`)
          updateTab(id, { connectedAt: Date.now(), route: prep.route })
          if (c.rememberTyped && c.creds.password !== undefined) {
            c.rememberTyped = false
            c.saved = true
            void window.api.invoke('creds:set', vncCredKey(tab.instanceKey), { user: c.creds.username ?? '', password: c.creds.password }).catch(() => toast('error', 'The password could not be saved on this computer.'))
          }
          if (was) toast('success', `${hostName}: reconnected.`)
          if (activeRef.current && !mobile) rfb.focus()
        })
        rfb.addEventListener('credentialsrequired', (e) => {
          const types = ((e as CustomEvent<{ types: string[] }>).detail?.types ?? ['password'])
          setPhase('signin')
          // A Mac's sign-in encrypts with WebCrypto, which a browser offers only to HTTPS pages (and the Mac app).
          setSignIn({ types, error: types.includes('username') && !window.isSecureContext ? 'Signing in to a Mac needs this page on HTTPS: on the computer running the app, set Phone access to HTTPS via Tailscale.' : undefined })
          say('connecting', `${hostName} wants ${types.includes('username') ? 'a user name and password' : 'a password'}.`)
        })
        rfb.addEventListener('serververification', (e) => {
          const detail = (e as CustomEvent<{ type: string; publickey?: Uint8Array }>).detail
          if (!detail.publickey) { rfb.approveServer(); return }
          void fingerprint(detail.publickey).then((print) => {
            const known = (() => { try { return localStorage.getItem(`vnc.key.${tab.instanceKey}`) } catch { return null } })()
            if (known === print) { rfb.approveServer(); return }
            setPhase('verify')
            setVerify({ print, changed: !!known })
            say('connecting', `Check ${hostName}'s key before connecting.`)
          })
        })
        rfb.addEventListener('securityfailure', (e) => {
          const reason = (e as CustomEvent<{ status: number; reason?: string }>).detail?.reason
          c.authFailed = true
          // A saved sign-in that stopped working is forgotten, so the tab asks instead of failing again on every connect.
          if (c.saved) void window.api.invoke('creds:delete', vncCredKey(tab.instanceKey)).catch(() => undefined)
          c.saved = false
          c.creds = { username: c.creds.username }
          setPhase('signin')
          setSignIn({ types: appleServer() ? ['username', 'password'] : ['password'], error: reason ? `${hostName} said: ${reason}` : `${hostName} turned down that ${appleServer() ? 'user name or password' : 'password'}.` })
          say('connecting', 'Sign-in failed.')
        })
        rfb.addEventListener('clipboard', (e) => {
          const text = (e as CustomEvent<{ text: string }>).detail?.text
          if (!text || Date.now() < c.clipQuietUntil) return
          // The Mac app writes it straight to this Mac's clipboard (a shared clipboard, as in Screens); a phone needs a tap.
          if (mobile || !/\bElectron\//.test(navigator.userAgent)) setRemoteClip(text)
          else if (activeRef.current) void window.api.invoke('clipboard:write', text)
        })
        rfb.addEventListener('disconnect', (e) => {
          if (rfbRef.current === rfb) rfbRef.current = null
          if (c.disposed) return
          const clean = (e as CustomEvent<{ clean: boolean }>).detail?.clean
          if (c.authFailed) return
          void window.api.invoke('vnc:lastError', id).catch(() => undefined).then((why) => {
            if (c.disposed) return
            if (!c.everConnected) {
              setPhase('failed')
              say('error', why ?? `Could not connect to ${prep.destination}.`)
            } else if (clean && !why) {
              setPhase('closed')
              say('closed', `${hostName} ended the session.`)
            } else {
              scheduleRetry(why ?? 'The connection dropped.')
            }
          })
        })
      })()
    }
    c.connect = connect
    connect()
    return () => {
      c.disposed = true
      clearTimers()
      rfbRef.current?.disconnect()
      rfbRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const viewOnlyRef = useRef(viewOnly)
  viewOnlyRef.current = viewOnly
  useEffect(() => { if (rfbRef.current) rfbRef.current.viewOnly = viewOnly }, [viewOnly])
  useEffect(() => { if (rfbRef.current) applyView(rfbRef.current) }, [scale, quality]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (active && phase === 'connected' && !mobile) setTimeout(() => rfbRef.current?.focus(), 0)
  }, [active, phase]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (signIn) setTimeout(() => (signIn.types.includes('username') && !userRef.current?.value ? userRef.current : passRef.current)?.focus(), 0)
  }, [signIn])

  useEffect(() => {
    const onChange = (): void => setFullscreen(document.fullscreenElement === wrapRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  /** Presses a key on the remote computer, with the key bar's armed modifiers held around it. */
  const press = (keysym: number, extra: VncModifier[] = []): void => {
    const rfb = rfbRef.current
    if (!rfb || phaseRef.current !== 'connected') return
    const m = modsRef.current
    const held: VncModifier[] = [...extra]
    if (m.ctrl) held.push('ctrl')
    if (m.alt) held.push('option')
    if (cmdRef.current) held.push('cmd')
    const apple = appleServer()
    for (const mod of held) rfb.sendKey(modifierKeysym(mod, apple), null, true)
    rfb.sendKey(keysym, null, true)
    rfb.sendKey(keysym, null, false)
    for (const mod of held.reverse()) rfb.sendKey(modifierKeysym(mod, apple), null, false)
    if (m.ctrl || m.alt) setMods(NO_MODS)
    if (cmdRef.current) setCmdArmed(false)
  }
  const typeText = (text: string): void => {
    for (const ch of text.replace(/\r\n?/g, '\n')) press(charKeysym(ch), SHIFTED.test(ch) ? ['shift'] : [])
  }
  useEffect(() => registerDictationTarget(wrapRef.current!, { label: 'Screen sharing', insert: (text) => typeText(text) }), []) // eslint-disable-line react-hooks/exhaustive-deps

  const sendBarKey = (k: string): void => {
    const keysym = NAMED_KEYSYMS[KEY_NAMES[k] ?? k]
    if (keysym) press(keysym)
  }
  const onKbKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    const keysym = NAMED_KEYSYMS[e.key]
    const hw: VncModifier[] = [...(e.ctrlKey ? ['ctrl' as const] : []), ...(e.altKey ? ['option' as const] : []), ...(e.metaKey ? ['cmd' as const] : [])]
    if (keysym) {
      e.preventDefault()
      press(keysym, [...hw, ...(e.shiftKey ? ['shift' as const] : [])])
    } else if (e.key.length === 1 && hw.length) {
      e.preventDefault()
      press(charKeysym(e.key.toLowerCase()), [...hw, ...(e.shiftKey ? ['shift' as const] : [])])
    }
  }
  const onKbBeforeInput = (e: FormEvent<HTMLTextAreaElement>): void => {
    const ev = e.nativeEvent as InputEvent
    if (ev.inputType === 'insertText' || ev.inputType === 'insertReplacementText' || ev.inputType === 'insertFromPaste') {
      if (ev.data) typeText(ev.data)
      e.preventDefault()
    } else if (ev.inputType === 'insertLineBreak' || ev.inputType === 'insertParagraph') {
      press(NAMED_KEYSYMS.Enter)
      e.preventDefault()
    } else if (ev.inputType === 'deleteContentBackward') {
      press(NAMED_KEYSYMS.Backspace)
      e.preventDefault()
    }
  }
  const onKbInput = (e: FormEvent<HTMLTextAreaElement>): void => {
    // Input the browser would not let us cancel (dictation, some predictive-text commits).
    const t = e.currentTarget
    if (t.value) { typeText(t.value); t.value = '' }
  }
  const toggleKeyboard = (): void => {
    const kb = kbRef.current
    if (!kb) return
    if (keyboardOpen || document.activeElement === kb) kb.blur()
    else kb.focus()
  }

  const submitSignIn = (e: FormEvent): void => {
    e.preventDefault()
    const username = userRef.current?.value.trim()
    const password = passRef.current?.value ?? ''
    const c = ctl.current
    c.creds = { username, password }
    c.rememberTyped = remember
    c.saved = false
    const rfb = rfbRef.current
    setSignIn(null)
    // Still mid-handshake: answer the server's question. After a rejection the server hung up, so start over.
    if (rfb && !c.authFailed) rfb.sendCredentials({ username, password })
    else { c.attempt = 0; c.connect() }
  }
  const trustKey = (): void => {
    if (!verify) return
    try { localStorage.setItem(`vnc.key.${tab.instanceKey}`, verify.print) } catch { /* storage unavailable */ }
    setVerify(null)
    rfbRef.current?.approveServer()
  }
  const reconnect = (): void => { ctl.current.attempt = 0; ctl.current.connect() }
  const sendClipboard = async (): Promise<void> => {
    try {
      const text = await navigator.clipboard.readText()
      if (!text) { toast('info', 'The clipboard has no text to send.'); return }
      rfbRef.current?.clipboardPasteFrom(text)
      toast('success', `Clipboard sent to ${hostName}. Paste there as usual.`)
    } catch (e) {
      toast('error', `Could not read the clipboard: ${(e as Error).message}`)
    }
  }
  const pasteOnPhone = (): void => pasteFromClipboard((text) => { rfbRef.current?.clipboardPasteFrom(text); typeText(text) }, setPasteBox)
  const copyRemoteClip = (): void => {
    const text = remoteClip
    setRemoteClip(null)
    if (!text) return
    navigator.clipboard.writeText(text).then(() => toast('success', 'Copied to this device.'), (e: Error) => toast('error', `Copy failed: ${e.message}`))
  }
  const toggleFullscreen = async (): Promise<void> => {
    if (document.fullscreenElement) { await document.exitFullscreen().catch(() => undefined); return }
    await wrapRef.current?.requestFullscreen().catch((e: Error) => toast('error', `Full screen failed: ${e.message}`))
  }
  const changeScale = (v: Scale): void => { setScale(v); writePref('ui.vncScale', v) }
  const changeQuality = (v: Quality): void => { setQuality(v); writePref('ui.vncQuality', v) }
  const disconnect = (): void => void useStore.getState().closeTab(tab.id)

  const needsUser = !!signIn?.types.includes('username')
  const overlay = signIn ? (
    <form className="vnc-card" onSubmit={submitSignIn}>
      <div className="vnc-card-icon"><Icon.screenShare /></div>
      <h2>Sign in to {hostName}</h2>
      <p className="muted">{needsUser ? (macHost ? 'A user name and password of an account on that Mac. Screen Sharing must be on there (System Settings → General → Sharing).' : 'A user name and password on that computer.') : 'The screen sharing password set on that computer.'}</p>
      {signIn.error && <p className="vnc-card-error" role="alert">{signIn.error}</p>}
      {needsUser && <input ref={userRef} className="input" placeholder="User name" autoComplete="username" autoCapitalize="off" autoCorrect="off" spellCheck={false} defaultValue={ctl.current.creds.username ?? ''} />}
      <input ref={passRef} className="input" type="password" placeholder="Password" autoComplete="current-password" />
      <label className="muted flex items-center gap-2 text-[12px]"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember on {/\bElectron\//.test(navigator.userAgent) ? 'this Mac' : 'the paired computer'}</label>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={disconnect}>Cancel</button>
        <button type="submit" className="btn btn-primary">Connect</button>
      </div>
    </form>
  ) : verify ? (
    <div className="vnc-card">
      <div className="vnc-card-icon"><Icon.fingerprint /></div>
      <h2>{verify.changed ? `${hostName}'s key changed` : `Is this ${hostName}?`}</h2>
      <p className={verify.changed ? 'vnc-card-error' : 'muted'}>{verify.changed ? 'It is not the key it showed last time. Connect only if you know why it changed (a reinstall, a new VNC server).' : 'The computer showed this key. Compare it with the one its VNC server shows, then trust it; it is remembered for next time.'}</p>
      <code className="vnc-print">{verify.print}</code>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={disconnect}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={trustKey}>Trust and connect</button>
      </div>
    </div>
  ) : phase === 'failed' || phase === 'closed' ? (
    <div className="vnc-card">
      <div className="vnc-card-icon"><Icon.screenShare /></div>
      <h2>{phase === 'closed' ? 'Session ended' : `Could not show ${hostName}`}</h2>
      <p className="muted">{message}</p>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={disconnect}>Close</button>
        <button type="button" className="btn btn-primary" onClick={reconnect}>Reconnect</button>
      </div>
    </div>
  ) : phase === 'connecting' || phase === 'waiting' ? (
    <div className="vnc-wait"><span className="vnc-spinner" />{message}{phase === 'waiting' && <button className="btn btn-sm" onClick={reconnect}>Now{countdown > 0 ? ` (${countdown}s)` : ''}</button>}</div>
  ) : null

  const screen = (
    <div ref={wrapRef} className="vnc-wrap" data-scale={scale} data-tiled={tiled || undefined}>
      <div ref={screenRef} className="vnc-screen" />
      {overlay && <div className="vnc-overlay">{overlay}</div>}
      {mobile && (
        <textarea
          ref={kbRef}
          className="rdp-kb"
          aria-label={`Type on ${hostName}`}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="enter"
          onKeyDown={onKbKeyDown}
          onBeforeInput={onKbBeforeInput}
          onInput={onKbInput}
        />
      )}
      {remoteClip !== null && (
        <div className="m-clip-pill" role="status">
          <button type="button" onClick={copyRemoteClip}><Icon.copy /> Copy {hostName}'s clipboard here</button>
          <button type="button" aria-label="Dismiss" onClick={() => setRemoteClip(null)}><Icon.x /></button>
        </div>
      )}
    </div>
  )

  if (mobile) {
    return (
      <div className="flex h-full flex-col">
        {screen}
        <KeyBar
          mods={mods}
          onMods={setMods}
          onKey={sendBarKey}
          keys={VNC_KEYS}
          keyboardOpen={keyboardOpen}
          onKeyboard={toggleKeyboard}
          onPaste={pasteOnPhone}
          onMore={() => setMobileMenu(true)}
          leading={
            <button type="button" className={`m-key ${cmdArmed ? 'on' : ''}`} aria-pressed={cmdArmed} aria-label={appleServer() ? 'Command (applies to the next key)' : 'Windows key (applies to the next key)'} onPointerDown={(e) => e.preventDefault()} onClick={() => setCmdArmed(!cmdArmed)}>
              {appleServer() ? '⌘' : 'win'}
            </button>
          }
        />
        {pasteBox !== null && <PasteSheet initial={pasteBox} action="Type" onSend={(t) => { setPasteBox(null); typeText(t) }} onClose={() => setPasteBox(null)} />}
        {mobileMenu && (
          <Sheet title={hostName} subtitle={<>{message}<br />Tap to click · two fingers to right-click or scroll · pinch to zoom · drag to select</>} onClose={() => setMobileMenu(false)}>
            <SheetItem icon={<Icon.fit />} hint={scale === 'fit' ? 'Fit' : '1:1'} onClick={() => changeScale(scale === 'fit' ? 'real' : 'fit')}>Screen size</SheetItem>
            <SheetItem icon={<Icon.gauge />} hint={QUALITY[quality].label} onClick={() => changeQuality(quality === 'balanced' ? 'fast' : quality === 'fast' ? 'sharp' : 'balanced')}>Picture quality</SheetItem>
            <SheetItem icon={<Icon.eye />} hint={viewOnly ? 'On' : 'Off'} onClick={() => setViewOnly(!viewOnly)}>View only</SheetItem>
            <SheetItem icon={<Icon.clipboard />} disabled={phase !== 'connected'} onClick={() => { setMobileMenu(false); pasteOnPhone() }}>Paste (types the text)</SheetItem>
            {!appleServer() && <SheetItem icon={<Icon.keyboard />} disabled={phase !== 'connected'} onClick={() => { setMobileMenu(false); rfbRef.current?.sendCtrlAltDel() }}>Send Ctrl+Alt+Del</SheetItem>}
            {(phase === 'failed' || phase === 'closed') && <SheetItem icon={<Icon.refresh />} onClick={() => { setMobileMenu(false); reconnect() }}>Reconnect</SheetItem>}
            <SheetItem icon={<Icon.note />} onClick={() => { setMobileMenu(false); openHostNote(tab.instanceKey) }}>Host note</SheetItem>
            <SheetItem icon={<Icon.x />} danger onClick={() => { setMobileMenu(false); disconnect() }}>Disconnect</SheetItem>
          </Sheet>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="rdp-toolbar panel flex items-center gap-2 border-b px-2 py-1 text-[11px]" style={{ borderColor: 'var(--border)' }}>
        <Icon.screenShare className="muted" />
        <span className="muted min-w-0 truncate">{message}</span>
        <span className="flex-1" />
        {(phase === 'failed' || phase === 'closed') && <button className="btn !py-0.5" onClick={reconnect}>Reconnect</button>}
        <select className="input !w-auto !py-0.5" title="Fit scales the screen into this pane; 1:1 shows it pixel for pixel" value={scale} onChange={(e) => changeScale(e.target.value as Scale)}>
          <option value="fit">Fit</option>
          <option value="real">1:1</option>
        </select>
        <select className="input !w-auto !py-0.5" title="Picture quality: lower uses less bandwidth on a slow connection" value={quality} onChange={(e) => changeQuality(e.target.value as Quality)}>
          {(Object.keys(QUALITY) as Quality[]).map((q) => <option key={q} value={q}>{QUALITY[q].label}</option>)}
        </select>
        <label className="muted flex items-center gap-1" title="Watch without moving the mouse or typing there">
          <input type="checkbox" checked={viewOnly} onChange={(e) => setViewOnly(e.target.checked)} />
          View only
        </label>
        <button className="btn !py-0.5" title={`Put this Mac's clipboard on ${hostName}, then paste there as usual (what ${hostName} copies comes here by itself)`} disabled={phase !== 'connected'} onClick={() => void sendClipboard()}>
          Send clipboard
        </button>
        {!appleServer() && <button className="btn !py-0.5" title="Send Ctrl+Alt+Del" disabled={phase !== 'connected'} onClick={() => rfbRef.current?.sendCtrlAltDel()}>Ctrl+Alt+Del</button>}
        <button className={`btn btn-ghost btn-sm btn-icon ${fullscreen ? 'on' : ''}`} title="Full screen (Esc leaves)" disabled={phase !== 'connected'} onClick={() => void toggleFullscreen()}>
          <Icon.maximize />
        </button>
        <span className="mx-1 h-4 border-l" style={{ borderColor: 'var(--border)' }} />
        <HostActions instanceKey={tab.instanceKey} current="vnc" tabId={tab.id} />
        <button className="btn !py-0.5" onClick={disconnect}>Disconnect</button>
      </div>
      {screen}
    </div>
  )
}

/**
 * Phone layout switch. The renderer bundle is the same for the Mac app and the gateway, so the choice is made from
 * the viewport rather than from how the page was loaded: narrow windows and every touch-first device (phones, an
 * unfolded foldable, tablets) get the touch shell, which lays itself out for the width (see MobileApp).
 *
 * It is decided once per page load. The two shells mount session components in different places, so switching live
 * (a desktop window dragged narrow) would remount every terminal and desktop and drop them. Folding or unfolding a
 * phone stays inside the touch shell, which only re-lays itself out.
 * The Electron window always keeps the desktop layout. `?layout=mobile|desktop` or the saved preference overrides.
 */
import { useSyncExternalStore } from 'react'

// Any touch-first screen (phones, foldables, tablets) plus narrow windows; the shell adapts to width by itself.
const QUERY = '(max-width: 820px), (pointer: coarse) and (hover: none)'
const LAYOUT_KEY = 'ui.layout'

function decideLayout(): boolean {
  if (typeof window === 'undefined') return false
  let forced: string | null = new URLSearchParams(location.search).get('layout')
  try { forced ??= localStorage.getItem(LAYOUT_KEY) } catch { /* storage unavailable */ }
  if (forced === 'mobile') return true
  if (forced === 'desktop') return false
  if (/\bElectron\//.test(navigator.userAgent)) return false
  return window.matchMedia(QUERY).matches
}

const MOBILE = decideLayout()
if (MOBILE) document.documentElement.setAttribute('data-mobile', '')

export function isMobile(): boolean {
  return MOBILE
}

/** Saves a layout choice ('auto' clears it) and reloads, since the layout is fixed for the life of the page. */
export function setLayoutPreference(layout: 'mobile' | 'desktop' | 'auto'): void {
  try {
    if (layout === 'auto') localStorage.removeItem(LAYOUT_KEY)
    else localStorage.setItem(LAYOUT_KEY, layout)
  } catch { /* storage unavailable */ }
  location.reload()
}

const KEYBOARD_EVENT = 'ec2ra:keyboard'

export function isKeyboardOpen(): boolean {
  return document.documentElement.hasAttribute('data-keyboard')
}

/** Whether the on-screen keyboard is covering part of the page (see trackVisualViewport). */
export function useKeyboardOpen(): boolean {
  return useSyncExternalStore((cb) => {
    window.addEventListener(KEYBOARD_EVENT, cb)
    return () => window.removeEventListener(KEYBOARD_EVENT, cb)
  }, isKeyboardOpen)
}

/**
 * iOS does not shrink the layout viewport when the on-screen keyboard opens; it overlays it. The mobile shell sizes
 * itself from the visual viewport instead (`--vv-top` / `--vv-h`), so a terminal's last line and the key bar stay
 * above the keyboard. `data-keyboard` lets views that must not resize with the keyboard (the RDP desktop) tell.
 */
export function trackVisualViewport(): () => void {
  const vv = window.visualViewport
  const root = document.documentElement
  const apply = (): void => {
    const h = vv?.height ?? window.innerHeight
    root.style.setProperty('--vv-h', `${Math.round(h)}px`)
    root.style.setProperty('--vv-top', `${Math.round(vv?.offsetTop ?? 0)}px`)
    const open = window.innerHeight - h > 120
    if (open !== root.hasAttribute('data-keyboard')) {
      root.toggleAttribute('data-keyboard', open)
      window.dispatchEvent(new Event(KEYBOARD_EVENT))
    }
  }
  apply()
  vv?.addEventListener('resize', apply)
  vv?.addEventListener('scroll', apply)
  window.addEventListener('resize', apply)
  return () => {
    vv?.removeEventListener('resize', apply)
    vv?.removeEventListener('scroll', apply)
    window.removeEventListener('resize', apply)
  }
}

type NativeMessage = { type: 'settings' } | { type: 'sessions'; count: number }
type NativeBridge = { messageHandlers?: { ec2ra?: { postMessage: (m: NativeMessage) => void } } }

/** True inside the EC2 Remote iPhone/iPad app (ios/), which injects a WKScriptMessageHandler named `ec2ra`. */
export function nativeApp(): boolean {
  return !!(window as unknown as { webkit?: NativeBridge }).webkit?.messageHandlers?.ec2ra
}

/** Tells the iOS app something only it can act on (its own settings screen, keeping the screen awake). */
export function postNative(m: NativeMessage): void {
  ;(window as unknown as { webkit?: NativeBridge }).webkit?.messageHandlers?.ec2ra?.postMessage(m)
}

/** A fold on a foldable's screen, in CSS pixels of the page (sent by the iPhone app; see ios/EC2Remote/WebView.swift). */
export interface Fold { x: number; y: number; width: number; height: number }

/**
 * Applies the fold the iPhone app reports: `data-fold="vertical"` (book pose, the fold runs top to bottom) or
 * "horizontal" (tabletop pose), plus `--fold-x/-y/-w/-h`. With a vertical fold the wide layout puts the list on one
 * side of it and the session on the other, so no terminal line or desktop runs under the hinge.
 */
export function applyFold(fold: Fold | null): void {
  const root = document.documentElement
  if (!fold || fold.width <= 0 || fold.height <= 0) {
    root.removeAttribute('data-fold')
    return
  }
  root.setAttribute('data-fold', fold.height > fold.width ? 'vertical' : 'horizontal')
  root.style.setProperty('--fold-x', `${fold.x}px`)
  root.style.setProperty('--fold-y', `${fold.y}px`)
  root.style.setProperty('--fold-w', `${fold.width}px`)
  root.style.setProperty('--fold-h', `${fold.height}px`)
}

if (typeof window !== 'undefined') {
  window.addEventListener('ec2ra:fold', (e) => applyFold((e as CustomEvent<Fold | null>).detail))
}

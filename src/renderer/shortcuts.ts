/**
 * App-wide keyboard shortcuts. Handled on `document` (not window) so they run before the embedded RDP client's
 * window-level key capture, and so a focused terminal still sees them bubble up; TerminalTab tells xterm to ignore
 * the same combinations through isAppShortcut.
 */
import { isSession, useStore } from './store'

export interface ShortcutInfo {
  keys: string
  label: string
}

export const SHORTCUTS: ShortcutInfo[] = [
  { keys: '⌘K', label: 'Quick switcher (hosts, sessions, commands)' },
  { keys: '⌘T', label: 'New session (pick a host)' },
  { keys: '⌘⇧P', label: 'Command list' },
  { keys: '⌘0', label: 'All sessions on one page' },
  { keys: '⌘1', label: 'Hosts' },
  { keys: '⌘⇧N', label: 'Notes' },
  { keys: '⌘2 … ⌘8', label: 'Session tab 1 … 7' },
  { keys: '⌘9', label: 'Last session tab' },
  { keys: '⌘⇧] / ⌘⇧[', label: 'Next / previous tab' },
  { keys: '⌘W', label: 'Close the current tab' },
  { keys: '⌘D', label: 'Split: open the same session beside this one' },
  { keys: '⌘⇧D', label: 'Duplicate the current session in a new tab' },
  { keys: '⌘⇧I', label: 'Broadcast typing to every pane in the split' },
  { keys: '⌘F', label: 'Find in terminal' },
  { keys: '⌘B', label: 'Show / hide the sidebar' },
  { keys: '⌘/', label: 'Keyboard shortcuts' }
]

/** Shortcuts of the Browser tab while it is the active tab (they take over ⌘T, ⌘W, ⌘F, ⌘D and ⌘0 there). */
export const BROWSER_SHORTCUTS: ShortcutInfo[] = [
  { keys: '⌘T', label: 'New tab (command bar)' },
  { keys: '⌘L', label: 'Edit the address' },
  { keys: '⌘W / ⌘⇧T', label: 'Close tab (unloads a pinned tab or favorite) / reopen the last closed tab' },
  { keys: '⌘[ / ⌘]', label: 'Back / forward' },
  { keys: '⌘R / ⌘⇧R', label: 'Reload / reload without cache' },
  { keys: '⌃Tab / ⌃⇧Tab', label: 'Next / previous tab in the space' },
  { keys: '⌥⌘↓ / ⌥⌘↑', label: 'Next / previous space' },
  { keys: '⌘D', label: 'Pin or unpin the tab in its space' },
  { keys: '⌘⇧D', label: 'Add to or remove from Favorites (shown in every space)' },
  { keys: '⌘S', label: 'Show / hide the browser sidebar' },
  { keys: '⌘F', label: 'Find in page' },
  { keys: '⌘⇧C', label: 'Copy the page address' },
  { keys: '⌘+ / ⌘− / ⌘0', label: 'Zoom in / out / reset' }
]

export interface BrowserKey {
  /** Lower-cased KeyboardEvent.key ('t', '[', 'arrowdown', 'tab'). */
  key: string
  shift: boolean
  alt: boolean
  /** ⌃ instead of ⌘ (only ⌃Tab is used). */
  ctrl: boolean
}

let browserKeys: ((k: BrowserKey) => boolean) | null = null

/** The Browser tab claims its keys while it is the active tab; the handler returns whether it used the key. */
export function setBrowserKeys(fn: ((k: BrowserKey) => boolean) | null): void {
  browserKeys = fn
}

type TerminalAction = 'find' | 'snippets'

/** Asks a terminal tab to open one of its own panels (find bar, snippet menu). */
export function terminalAction(tabId: string, action: TerminalAction): void {
  window.dispatchEvent(new CustomEvent('ec2ra:terminal', { detail: { tabId, action } }))
}

export function onTerminalAction(tabId: string, fn: (action: TerminalAction) => void): () => void {
  const h = (e: Event): void => {
    const d = (e as CustomEvent<{ tabId: string; action: TerminalAction }>).detail
    if (d.tabId === tabId) fn(d.action)
  }
  window.addEventListener('ec2ra:terminal', h)
  return () => window.removeEventListener('ec2ra:terminal', h)
}

const modalOpen = (): boolean => !!document.querySelector('.modal-backdrop')

/** Combinations the app owns while a terminal has focus (Cmd on macOS; Ctrl+K kept for the switcher). */
export function isAppShortcut(e: KeyboardEvent): boolean {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') return true
  if (!e.metaKey || e.altKey || e.ctrlKey) return false
  const k = e.key.toLowerCase()
  return /^[0-9]$/.test(k) || ['n', 'w', 't', 'd', 'f', 'b', '/', '[', ']', '{', '}', 'p', 'i'].includes(k)
}

/** Returns true when the event was a shortcut and has been handled. */
export function handleAppShortcut(e: KeyboardEvent): boolean {
  const st = useStore.getState()
  const browserActive = !!browserKeys && !st.gridView && st.tabs.some((t) => t.id === st.activeTab && t.kind === 'browser')
  const browserCombo = (e.metaKey && !e.ctrlKey) || (e.ctrlKey && !e.metaKey && e.key === 'Tab')
  if (browserActive && browserCombo && !e.repeat && !modalOpen() && browserKeys!({ key: e.key.toLowerCase(), shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey })) {
    e.preventDefault()
    e.stopPropagation()
    return true
  }
  if (!e.metaKey || e.altKey || e.ctrlKey || e.repeat) return false
  const k = e.key.toLowerCase()
  const active = st.tabs.find((t) => t.id === st.activeTab)
  const go = (fn: () => void): true => {
    e.preventDefault()
    e.stopPropagation()
    fn()
    return true
  }
  if (modalOpen()) return false
  const order = ['hosts', ...st.tabs.filter((t) => !t.transient).map((t) => t.id)]
  if (k === '0' && !e.shiftKey) return go(() => st.showGrid(!st.gridView))
  if (k === 'n' && e.shiftKey) return go(() => st.openNotes())
  if (/^[1-9]$/.test(k) && !e.shiftKey) {
    const n = Number(k)
    const target = n === 9 ? order.at(-1) : order[n - 1]
    return target ? go(() => st.setActive(target)) : go(() => undefined)
  }
  if (e.shiftKey && (k === ']' || k === '}' || k === '[' || k === '{')) {
    const step = k === ']' || k === '}' ? 1 : -1
    const at = order.indexOf(st.activeTab)
    return go(() => st.setActive(order[(at + step + order.length) % order.length]))
  }
  if (k === 'w' && !e.shiftKey) return go(() => { if (active) void st.closeTab(active.id) })
  if (k === 't' && !e.shiftKey) return go(() => st.openQuickSwitcher())
  if (k === 'p' && e.shiftKey) return go(() => st.openQuickSwitcher('>'))
  if (k === '/') return go(() => st.set({ shortcutsOpen: true }))
  // A second RDP login as the same user would take over the first desktop, so RDP tabs are not duplicated.
  if (k === 'd' && active && active.kind !== 'rdp' && isSession(active)) return go(() => st.duplicateTab(active.id, !e.shiftKey))
  if (k === 'i' && e.shiftKey && st.splitGroup.includes(st.activeTab)) return go(() => st.set({ broadcastInput: !st.broadcastInput }))
  if (k === 'f' && !e.shiftKey && active?.kind === 'ssh') return go(() => terminalAction(active.id, 'find'))
  if (k === 'f' && !e.shiftKey && st.activeTab === 'hosts') return go(() => document.querySelector<HTMLInputElement>('[aria-label="Search hosts"]')?.focus())
  return false
}

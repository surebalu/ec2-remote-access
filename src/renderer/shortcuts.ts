/**
 * App-wide keyboard shortcuts. Handled on `document` (not window) so they run before the embedded RDP client's
 * window-level key capture, and so a focused terminal still sees them bubble up; TerminalTab tells xterm to ignore
 * the same combinations through isAppShortcut.
 */
import { useStore } from './store'

export interface ShortcutInfo {
  keys: string
  label: string
}

export const SHORTCUTS: ShortcutInfo[] = [
  { keys: '⌘K', label: 'Quick switcher (hosts, sessions, commands)' },
  { keys: '⌘T', label: 'New session (pick a host)' },
  { keys: '⌘⇧P', label: 'Command list' },
  { keys: '⌘1', label: 'Hosts' },
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
  return /^[1-9]$/.test(k) || ['w', 't', 'd', 'f', 'b', '/', '[', ']', '{', '}', 'p', 'i'].includes(k)
}

/** Returns true when the event was a shortcut and has been handled. */
export function handleAppShortcut(e: KeyboardEvent): boolean {
  if (!e.metaKey || e.altKey || e.ctrlKey || e.repeat) return false
  const st = useStore.getState()
  const k = e.key.toLowerCase()
  const active = st.tabs.find((t) => t.id === st.activeTab)
  const go = (fn: () => void): true => {
    e.preventDefault()
    e.stopPropagation()
    fn()
    return true
  }
  if (modalOpen()) return false
  const order = ['hosts', ...st.tabs.map((t) => t.id)]
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
  if (k === 'd' && active && active.kind !== 'rdp') return go(() => st.duplicateTab(active.id, !e.shiftKey))
  if (k === 'i' && e.shiftKey && st.splitGroup.includes(st.activeTab)) return go(() => st.set({ broadcastInput: !st.broadcastInput }))
  if (k === 'f' && !e.shiftKey && active?.kind === 'ssh') return go(() => terminalAction(active.id, 'find'))
  if (k === 'f' && !e.shiftKey && st.activeTab === 'hosts') return go(() => document.querySelector<HTMLInputElement>('[aria-label="Search hosts"]')?.focus())
  return false
}

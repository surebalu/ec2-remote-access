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
  { keys: '⌘,', label: 'Settings' },
  { keys: '⌘/', label: 'Keyboard shortcuts' }
]

/** Formatting in the Notes editor (the toolbar has the rest: colour, link, table, divider, clear formatting). */
export const NOTES_SHORTCUTS: ShortcutInfo[] = [
  { keys: '⌘B / ⌘I / ⌘⇧X', label: 'Bold / italic / strikethrough' },
  { keys: '⌘⇧H / ⌘E', label: 'Highlight / inline code' },
  { keys: '⌥⌘1 … ⌥⌘3 / ⌥⌘0', label: 'Heading 1 … 3 / body text' },
  { keys: '⌘⇧8 / ⌘⇧7 / ⌘⇧9', label: 'Bulleted / numbered list / checklist' },
  { keys: '⌘⇧.', label: 'Quote' },
  { keys: '⌘-click', label: 'Open a link or [[note]]' }
]

/** Shortcuts of the Terminal tab (local shells) while it is the active tab; ⌃` opens it from anywhere. */
export const TERMINAL_SHORTCUTS: ShortcutInfo[] = [
  { keys: '⌃`', label: 'Open the Terminal tab (from anywhere)' },
  { keys: '⌘T / ⌘⇧T', label: 'New terminal tab (same folder) / reopen the last closed one' },
  { keys: '⌘1 … ⌘8 / ⌘9', label: 'Terminal tab 1 … 8 / the last one (top to bottom in the side list)' },
  { keys: '⌃Tab / ⌃⇧Tab', label: 'Next / previous terminal tab' },
  { keys: '⌘D / ⌘⇧D', label: 'Split the pane right / down' },
  { keys: '⌥⌘← → ↑ ↓ / ⌘[ ⌘]', label: 'Move to the pane in that direction / previous or next pane' },
  { keys: '⌘⇧↵', label: 'Show the pane alone, or the whole layout again' },
  { keys: '⌘W', label: 'Close the pane (the tab with its last pane)' },
  { keys: '⌘↑ / ⌘↓', label: 'Previous / next command block' },
  { keys: '⌘F', label: 'Find in the pane' },
  { keys: '⌃R', label: 'Search command history (in the input box)' },
  { keys: 'Tab / →', label: 'Hand the line to the shell for completion / accept the suggestion' },
  { keys: '⌘+ / ⌘− / ⌘0', label: 'Text size' }
]

/** Shortcuts of the Browser tab while it is the active tab (they take over ⌘T, ⌘W, ⌘F, ⌘D and ⌘0 there). */
export const BROWSER_SHORTCUTS: ShortcutInfo[] = [
  { keys: '⌘T', label: 'New tab (command bar)' },
  { keys: '⌘L', label: 'Edit the address' },
  { keys: '⌘W / ⌘⇧T', label: 'Close tab (unloads a pinned tab or favorite) / reopen the last closed tab' },
  { keys: '⌘[ / ⌘]', label: 'Back / forward' },
  { keys: '⌘R / ⌘⇧R', label: 'Reload / reload without cache' },
  { keys: '⌃Tab / ⌃⇧Tab', label: 'Next / previous tab in the space' },
  { keys: '⌥⌘↓ / ⌥⌘↑', label: 'Next / previous space (or swipe sideways on the sidebar)' },
  { keys: '⌘⇧[ / ⌘⇧]', label: 'Leave the browser for the previous / next app tab' },
  { keys: '⌘D', label: 'Pin or unpin the tab in its space' },
  { keys: '⌘⇧D', label: 'Add to or remove from Favorites (shown in every space)' },
  { keys: '⌘S', label: 'Show / hide the browser sidebar' },
  { keys: '⌘F', label: 'Find in page' },
  { keys: '⌘⇧C', label: 'Copy the page address' },
  { keys: '⌘⇧L', label: 'Fill the login from 1Password' },
  { keys: '⌘1 … ⌘8 / ⌘9', label: 'Space 1 … 8 (the avatars along the bottom of the sidebar) / the last space' },
  { keys: '⌘+ / ⌘− / ⌘0', label: 'Zoom in / out / reset (one zoom for every page)' }
]

/** The Whiteboard tab: single keys pick tools, as in Presentify, while nothing is being typed. */
export const WHITEBOARD_SHORTCUTS: ShortcutInfo[] = [
  { keys: 'V / H (or hold Space)', label: 'Select / pan' },
  { keys: 'P / M / E / K', label: 'Pen / highlighter / eraser / laser pointer' },
  { keys: 'L / A / R / O / D', label: 'Line / arrow / rectangle / ellipse / diamond (⇧ keeps 45° or a square)' },
  { keys: 'T / N', label: 'Text / sticky note (double-click to edit)' },
  { keys: '1 … 5 / 6', label: 'Colours of the palette (right-click a swatch to change it) / gradient' },
  { keys: '[ / ]', label: 'Thinner / thicker (spotlight smaller / larger while it is on)' },
  { keys: 'F', label: 'Spotlight around the pointer' },
  { keys: '⌘Z / ⌘⇧Z', label: 'Undo / redo' },
  { keys: '⌘C / ⌘X / ⌘V / ⌘D', label: 'Copy / cut / paste (also screenshots) / duplicate' },
  { keys: '⌘A / ⌫ / arrows', label: 'Select all / delete / nudge (⇧ for 10)' },
  { keys: '⌘] / ⌘[', label: 'Bring to front / send to back' },
  { keys: '⌘+ / ⌘− / ⌘0', label: 'Zoom in / out / fit everything (or pinch and scroll)' }
]

export interface TabKey {
  /** Lower-cased KeyboardEvent.key ('t', '[', 'arrowdown', 'tab'). */
  key: string
  shift: boolean
  alt: boolean
  /** ⌃ instead of ⌘ (only ⌃Tab is used). */
  ctrl: boolean
}

export type BrowserKey = TabKey

/** The Browser, Terminal and Whiteboard tabs claim their keys (⌘T, ⌘W, ⌘D, ⌘1…) while they are the active tab. */
type KeyedKind = 'browser' | 'local' | 'board'
const tabKeys: Partial<Record<KeyedKind, (k: TabKey) => boolean>> = {}

/** Registers (or with null removes) the key handler of an app tab kind; it returns whether it used the key. */
export function setTabKeys(kind: KeyedKind, fn: ((k: TabKey) => boolean) | null): void {
  if (fn) tabKeys[kind] = fn
  else delete tabKeys[kind]
}

export function setBrowserKeys(fn: ((k: TabKey) => boolean) | null): void {
  setTabKeys('browser', fn)
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
  if (e.ctrlKey && !e.metaKey && (e.key === '`' || e.code === 'Backquote')) return true
  if (!e.metaKey || e.altKey || e.ctrlKey) return false
  const k = e.key.toLowerCase()
  return /^[0-9]$/.test(k) || ['n', 'w', 't', 'd', 'f', 'b', '/', ',', '[', ']', '{', '}', 'p', 'i'].includes(k)
}

/** Returns true when the event was a shortcut and has been handled. */
export function handleAppShortcut(e: KeyboardEvent): boolean {
  // A focused editor that used the key (formatting in Notes) keeps it.
  if (e.defaultPrevented) return false
  const st = useStore.getState()
  // ⌃` anywhere: the Terminal tab (local shells), as in editors.
  if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === '`' || e.code === 'Backquote') && !modalOpen()) {
    e.preventDefault()
    e.stopPropagation()
    st.openTerminal()
    return true
  }
  const inFront = st.gridView ? undefined : st.tabs.find((t) => t.id === st.activeTab)
  const tabHandler = inFront && (inFront.kind === 'browser' || inFront.kind === 'local' || inFront.kind === 'board') ? tabKeys[inFront.kind] : undefined
  const tabCombo = (e.metaKey && !e.ctrlKey) || (e.ctrlKey && !e.metaKey && e.key === 'Tab')
  if (tabHandler && tabCombo && !e.repeat && !modalOpen() && tabHandler({ key: e.key.toLowerCase(), shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey })) {
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
  if (k === ',') return go(() => st.set({ settingsOpen: true }))
  // A second RDP login as the same user would take over the first desktop, so RDP tabs are not duplicated.
  if (k === 'd' && active && active.kind !== 'rdp' && isSession(active)) return go(() => st.duplicateTab(active.id, !e.shiftKey))
  if (k === 'i' && e.shiftKey && st.splitGroup.includes(st.activeTab)) return go(() => st.set({ broadcastInput: !st.broadcastInput }))
  if (k === 'f' && !e.shiftKey && active?.kind === 'ssh') return go(() => terminalAction(active.id, 'find'))
  if (k === 'f' && !e.shiftKey && st.activeTab === 'hosts') return go(() => document.querySelector<HTMLInputElement>('[aria-label="Search hosts"]')?.focus())
  return false
}

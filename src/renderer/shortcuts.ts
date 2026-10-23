/**
 * App-wide keyboard shortcuts. Handled on `document` (not window) so they run before the embedded RDP client's
 * window-level key capture, and so a focused terminal still sees them bubble up; TerminalTab tells xterm to ignore
 * the same combinations through isAppShortcut.
 */
import { comboOf, formatCombo, sectionFor, sectionKeys, toolOwns, type RailSection, type ShortcutTarget } from '@shared/keyCombos'
import { isSession, useStore } from './store'
import { neighbor, type Direction } from './termLayout'

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
  { keys: '⌘\\', label: 'Side by side: open a host, a tab or a tool beside this one' },
  { keys: '⌥⌘← → ↑ ↓', label: 'Side by side: move to the pane in that direction (the Browser keeps ⌥⌘↑ ↓ for spaces)' },
  { keys: '⌘⇧↩', label: 'Side by side: show the focused pane alone, or every pane again' },
  { keys: '⌘D', label: 'Split: open the same session beside this one' },
  { keys: '⌘⇧D', label: 'Duplicate the current session in a new tab' },
  { keys: '⌘⇧I', label: 'Broadcast typing to every pane in the split' },
  { keys: '⌘F', label: 'Find in terminal' },
  { keys: '⌘[', label: 'Host page: back (a process to its host, then where the page was opened from)' },
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

/** Shortcuts of the Terminal tab (local shells) while it is the active tab (its own key to open it is under App sections). */
export const TERMINAL_SHORTCUTS: ShortcutInfo[] = [
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
  { keys: '⌘⇧D', label: 'Add to or remove from the space’s Favorites' },
  { keys: '⌘S', label: 'Show / hide the browser sidebar' },
  { keys: '⌘F', label: 'Find in page' },
  { keys: '⌘⇧C', label: 'Copy the page address' },
  { keys: '⌘⇧L', label: 'Fill the login from 1Password' },
  { keys: '⌘1 … ⌘8 / ⌘9', label: 'Space 1 … 8 (the avatars along the bottom of the sidebar) / the last space' },
  { keys: '⌘+ / ⌘− / ⌘0', label: 'Zoom in / out / reset (one zoom for every page)' }
]

/** The Finder tab (files on this Mac), with Finder's own keys. */
export const FINDER_SHORTCUTS: ShortcutInfo[] = [
  { keys: '↑ / ↓ (⇧ to extend)', label: 'Select the previous / next item; type a name to jump to it' },
  { keys: 'Double-click / ⌘O / ⌘↓', label: 'Open: go into a folder, or open a file in its app' },
  { keys: '⌘↑ / ⌘[ / ⌘]', label: 'Enclosing folder / back / forward' },
  { keys: 'Space', label: 'Quick Look' },
  { keys: '↩', label: 'Rename' },
  { keys: '⌘⇧N / ⌘⌫', label: 'New folder / move to the Trash' },
  { keys: '⌘C / ⌘V / ⌘D', label: 'Copy the files / paste here (from this tab or Finder) / duplicate' },
  { keys: '⌥⌘C', label: 'Copy the path' },
  { keys: '⌘F / ⌘A', label: 'Search this folder (Spotlight) / select all' },
  { keys: '⌘⇧.', label: 'Show or hide hidden files' }
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

/** Voice dictation (voice.ts), anywhere you type; `keyLabel` is the hold key from Settings → Voice ('' when it is off). */
export function dictationShortcuts(keyLabel: string): ShortcutInfo[] {
  return [
    ...(keyLabel ? [{ keys: `Hold ${keyLabel}`, label: 'Dictate: speak, then let go to type it where the cursor is' }] : []),
    { keys: 'Esc', label: 'Cancel the dictation; nothing is typed' },
    { keys: 'Mic button', label: 'Talk without holding a key: click again, or Done, to insert (Notes, Run Command, SSH and Terminal toolbars)' }
  ]
}

export interface TabKey {
  /** Lower-cased KeyboardEvent.key ('t', '[', 'arrowdown', 'tab'). */
  key: string
  shift: boolean
  alt: boolean
  /** ⌃ instead of ⌘ (only ⌃Tab is used). */
  ctrl: boolean
}

export type BrowserKey = TabKey

/** The Browser, Terminal, Whiteboard, Finder and chat tabs claim their keys (⌘T, ⌘W, ⌘D, ⌘1…) while they are the active tab. */
type KeyedKind = 'browser' | 'local' | 'board' | 'finder' | 'claude' | 'chatgpt' | 'health' | 'tasks' | 'calendar' | 'links'
const tabKeys: Partial<Record<KeyedKind, (k: TabKey) => boolean>> = {}

/** Registers (or with null removes) the key handler of an app tab kind; it returns whether it used the key. */
export function setTabKeys(kind: KeyedKind, fn: ((k: TabKey) => boolean) | null): void {
  if (fn) tabKeys[kind] = fn
  else delete tabKeys[kind]
}

export function setBrowserKeys(fn: ((k: TabKey) => boolean) | null): void {
  setTabKeys('browser', fn)
}

type TerminalAction = 'find' | 'snippets' | 'paste'

/**
 * Asks a terminal tab to open one of its own panels (find bar, snippet menu), or to take `text`: pasted at the prompt
 * (never run: no Enter is added), or looked for in its scrollback.
 */
export function terminalAction(tabId: string, action: TerminalAction, text?: string): void {
  window.dispatchEvent(new CustomEvent('ec2ra:terminal', { detail: { tabId, action, text } }))
}

export function onTerminalAction(tabId: string, fn: (action: TerminalAction, text?: string) => void): () => void {
  const h = (e: Event): void => {
    const d = (e as CustomEvent<{ tabId: string; action: TerminalAction; text?: string }>).detail
    if (d.tabId === tabId) fn(d.action, d.text)
  }
  window.addEventListener('ec2ra:terminal', h)
  return () => window.removeEventListener('ec2ra:terminal', h)
}

const modalOpen = (): boolean => !!document.querySelector('.modal-backdrop')

const inSplit = (): boolean => {
  const st = useStore.getState()
  return !st.gridView && st.splitGroup.includes(st.activeTab)
}

const comboOfEvent = (e: KeyboardEvent): string | null => comboOf({ code: e.code, key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey })

/** The rail section (or the radial menu) whose shortcut (Settings → Keyboard) this key press is, if any. */
export function sectionOfKey(e: KeyboardEvent): ShortcutTarget | null {
  return sectionFor(useStore.getState().settings?.shortcuts, comboOfEvent(e))
}

/** A key a web page passed on (web:shortcut). */
interface PageKey { key: string; code: string; meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }

/** Whether a key a page passed on is a section's shortcut the tool `kind` does not use itself: the app's, first. */
export function isSectionKeyFor(kind: string, d: PageKey): boolean {
  const combo = comboOf(d)
  return !!sectionFor(useStore.getState().settings?.shortcuts, combo) && !toolOwns(kind, combo)
}

/** Hands a key a page swallowed to the app's shortcuts, as the keydown the app would have seen. */
export function replayPageKey(d: PageKey): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: d.key, code: d.code, metaKey: d.meta, ctrlKey: d.ctrl, shiftKey: d.shift, altKey: d.alt, bubbles: true, cancelable: true }))
}

/** A section's shortcut as menus show it ('⌃⌘C'), or '' when it has none. */
export function sectionKeyLabel(section: ShortcutTarget, saved: Partial<Record<string, string>> | undefined): string {
  return formatCombo(sectionKeys(saved)[section])
}

/** Opens Settings on Keyboard, where the sections' shortcuts are recorded. */
export function openKeyboardSettings(): void {
  try { localStorage.setItem('ui.settingsSection', 'keyboard') } catch { /* storage off: Settings opens where it was */ }
  useStore.getState().set({ settingsOpen: true, shortcutsOpen: false })
}

/** Where a section's shortcut took you from, so pressing it again goes back there (null tab: the all-sessions page). */
let cameFrom: { section: RailSection; tab: string | null } | null = null

/**
 * Opens the radial menu (RadialMenu.tsx), which listens for this. `held`: opened by a shortcut whose modifiers are
 * still down, so letting go of them picks the highlighted section, as ⌘Tab does.
 */
export function openRadial(held = false): void {
  window.dispatchEvent(new CustomEvent('ec2ra:radial', { detail: { held } }))
}

/**
 * Shows a section, as its rail button does. Pressed again while that section is in front it goes back to the tab
 * the shortcut came from, so a key can flip between, say, a session and Claude.
 */
export function runSection(section: ShortcutTarget, held = false): void {
  if (section === 'radial') return openRadial(held)
  const st = useStore.getState()
  if (section === 'overview') {
    st.showGrid(!st.gridView)
    return
  }
  const front = st.gridView ? null : st.activeTab
  const showing = section === 'hosts' ? front === 'hosts' : st.tabs.find((t) => t.id === front)?.kind === section
  if (showing) {
    const back = cameFrom?.section === section ? cameFrom : null
    cameFrom = null
    if (back?.tab === null) st.showGrid(true)
    else if (back && (back.tab === 'hosts' || st.tabs.some((t) => t.id === back.tab))) st.setActive(back.tab)
    return
  }
  cameFrom = { section, tab: front }
  if (section === 'hosts') st.setActive('hosts')
  else st.openTool(section)
}

/** Combinations the app owns while a terminal has focus (Cmd on macOS; Ctrl+K kept for the switcher). */
export function isAppShortcut(e: KeyboardEvent): boolean {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') return true
  if (sectionOfKey(e)) return true
  // In a split, ⌥⌘ arrows and ⌘⇧↩ move between and zoom panes; elsewhere they stay the shell's.
  if (e.metaKey && !e.ctrlKey && ((e.altKey && e.key.startsWith('Arrow')) || (e.shiftKey && e.key === 'Enter')) && inSplit()) return true
  if (!e.metaKey || e.altKey || e.ctrlKey) return false
  const k = e.key.toLowerCase()
  return /^[0-9]$/.test(k) || ['n', 'w', 't', 'd', 'f', 'b', '/', ',', '[', ']', '{', '}', 'p', 'i', '\\'].includes(k)
}

/** Returns true when the event was a shortcut and has been handled. */
export function handleAppShortcut(e: KeyboardEvent): boolean {
  // A focused editor that used the key (formatting in Notes) keeps it.
  if (e.defaultPrevented) return false
  const st = useStore.getState()
  const inFront = st.gridView ? undefined : st.tabs.find((t) => t.id === st.activeTab)
  // A section's own shortcut (Settings → Keyboard; ⌃` for the Terminal…) from anywhere, except a key the tool in
  // front uses itself (⌘0 is the Browser's zoom while it is in front).
  const section = e.repeat || modalOpen() ? null : sectionOfKey(e)
  if (section && !toolOwns(inFront?.kind, comboOfEvent(e))) {
    e.preventDefault()
    e.stopPropagation()
    runSection(section, e.metaKey || e.ctrlKey || e.altKey || e.shiftKey)
    return true
  }
  const tabHandler = inFront && !isSession(inFront) ? tabKeys[inFront.kind as KeyedKind] : undefined
  const tabCombo = (e.metaKey && !e.ctrlKey) || (e.ctrlKey && !e.metaKey && e.key === 'Tab')
  if (tabHandler && tabCombo && !e.repeat && !modalOpen() && tabHandler({ key: e.key.toLowerCase(), shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey })) {
    e.preventDefault()
    e.stopPropagation()
    return true
  }
  // ⌥⌘ arrows: the pane of the split in that direction (keys come lower-cased when a web page forwarded them).
  const key = e.key.toLowerCase()
  if (e.metaKey && e.altKey && !e.ctrlKey && !e.shiftKey && key.startsWith('arrow') && inSplit() && !modalOpen()) {
    const next = st.splitTree && !st.splitZoom ? neighbor(st.splitTree, st.activeTab, key.slice(5) as Direction) : null
    if (!next) return false
    e.preventDefault()
    e.stopPropagation()
    st.focusPane(next)
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
  if (k === 'enter' && e.shiftKey && inSplit()) return go(() => st.set({ splitZoom: st.splitZoom ? null : st.activeTab }))
  if (k === '\\' && !e.shiftKey && active && !st.gridView) return go(() => st.openQuickSwitcher('', { beside: active.id }))
  if (k === 'w' && !e.shiftKey) return go(() => { if (active) void st.closeTab(active.id) })
  if (k === 't' && !e.shiftKey) return go(() => st.openQuickSwitcher())
  if (k === 'p' && e.shiftKey) return go(() => st.openQuickSwitcher('>'))
  if (k === '/') return go(() => st.set({ shortcutsOpen: true }))
  if (k === ',') return go(() => st.set({ settingsOpen: true }))
  // A second RDP login as the same user would take over the first desktop, so RDP tabs are not duplicated.
  if (k === 'd' && active && active.kind !== 'rdp' && isSession(active)) return go(() => st.duplicateTab(active.id, !e.shiftKey))
  if (k === 'i' && e.shiftKey && st.splitGroup.includes(st.activeTab)) return go(() => st.set({ broadcastInput: !st.broadcastInput }))
  if (k === 'f' && !e.shiftKey && active?.kind === 'ssh') return go(() => terminalAction(active.id, 'find'))
  if (k === '[' && !e.shiftKey && st.activeTab === 'hosts' && !st.gridView && st.hostPage) return go(() => st.hostBack())
  if (k === 'f' && !e.shiftKey && st.activeTab === 'hosts' && !st.hostPage) return go(() => document.querySelector<HTMLInputElement>('[aria-label="Search hosts"]')?.focus())
  return false
}

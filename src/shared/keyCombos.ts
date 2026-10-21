/**
 * Keyboard shortcuts the user records for the sections of the app rail (Settings → Keyboard). A combination is kept
 * as text, the modifiers in macOS's order and then the key: 'ctrl+alt+shift+cmd+c'. The key comes from
 * KeyboardEvent.code, the physical key, so ⌥ and ⇧ never change it (⌥⌘C stays 'alt+cmd+c' although the page sees
 * 'ç'). Pure, so main can pass these keys out of web pages, the renderer can run them, and tests/keyCombos.test.ts
 * covers it.
 */

export type RailSection = 'hosts' | 'overview' | 'health' | 'local' | 'finder' | 'browser' | 'notes' | 'board' | 'claude' | 'chatgpt'

/** Top to bottom, as the rail shows them. */
export const RAIL_SECTIONS: RailSection[] = ['hosts', 'overview', 'health', 'local', 'finder', 'browser', 'notes', 'board', 'claude', 'chatgpt']

export const SECTION_NAMES: Record<RailSection, string> = {
  hosts: 'Hosts', overview: 'Overview', health: 'Health', local: 'Terminal', finder: 'Finder', browser: 'Browser', notes: 'Notes', board: 'Whiteboard', claude: 'Claude', chatgpt: 'ChatGPT'
}

/** What a recorded shortcut can do: show a rail section, or open the radial menu of every section. */
export type ShortcutTarget = RailSection | 'radial'

export const SHORTCUT_TARGETS: ShortcutTarget[] = [...RAIL_SECTIONS, 'radial']

export const TARGET_NAMES: Record<ShortcutTarget, string> = { ...SECTION_NAMES, radial: 'Radial menu' }

/**
 * The keys these always had. Hosts needs none: ⌘1 is the first tab, which is always Hosts. ⇧⌘Space for the radial menu
 * is free in macOS and the app, and holding ⇧⌘ while tapping Space steps round it the way ⌘Tab steps through apps.
 */
export const DEFAULT_SHORTCUTS: Partial<Record<ShortcutTarget, string>> = { overview: 'cmd+0', local: 'ctrl+`', notes: 'shift+cmd+n', radial: 'shift+cmd+space' }

/** A key press, from a DOM KeyboardEvent or Electron's before-input-event Input. */
export interface KeyInput {
  code?: string
  key: string
  meta: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
}

const BY_CODE: Record<string, string> = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  Enter: 'enter', NumpadEnter: 'enter', Space: 'space', Tab: 'tab', Backspace: 'backspace', Delete: 'delete', Escape: 'escape',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown'
}
const BY_KEY: Record<string, string> = {
  arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right', ' ': 'space', enter: 'enter', tab: 'tab', backspace: 'backspace',
  delete: 'delete', escape: 'escape', home: 'home', end: 'end', pageup: 'pageup', pagedown: 'pagedown'
}
const MODS = ['ctrl', 'alt', 'shift', 'cmd'] as const

/** The key's name in a combination, or null for a modifier on its own (or a key no shortcut can use). */
function keyName(code: string | undefined, key: string): string | null {
  if (code) {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
    if (/^Digit[0-9]$/.test(code)) return code.slice(5)
    if (/^F([1-9]|1[0-9]|20)$/.test(code)) return code.toLowerCase()
    if (BY_CODE[code]) return BY_CODE[code]
  }
  // Events without a code (made up by a page or a test) fall back to the character.
  const k = key.toLowerCase()
  if (/^[a-z0-9`\-=[\]\\;',./]$/.test(k) || /^f([1-9]|1[0-9]|20)$/.test(k)) return k
  return BY_KEY[k] ?? null
}

export function comboOf(e: KeyInput): string | null {
  const k = keyName(e.code, e.key)
  if (!k) return null
  return [e.ctrl && 'ctrl', e.alt && 'alt', e.shift && 'shift', e.meta && 'cmd', k].filter(Boolean).join('+')
}

function parts(combo: string): { mods: Set<string>; key: string } {
  const p = combo.toLowerCase().split('+')
  // A trailing '+' only comes from hand-editing; the '=' key is how ⌘+ is stored.
  const key = p.pop() || ''
  return { mods: new Set(p), key }
}

/** The same combination in the stored order (a hand-edited 'Cmd+Shift+N' becomes 'shift+cmd+n'). */
export function normalizeCombo(combo: string): string {
  if (!combo) return ''
  const { mods, key } = parts(combo)
  if (mods.has('meta') || mods.has('command')) mods.add('cmd')
  if (mods.has('control')) mods.add('ctrl')
  if (mods.has('option')) mods.add('alt')
  return key ? [...MODS.filter((m) => mods.has(m)), key].join('+') : ''
}

const GLYPHS: Record<string, string> = {
  up: '↑', down: '↓', left: '←', right: '→', enter: '↩', tab: '⇥', backspace: '⌫', delete: '⌦', escape: '⎋', space: 'Space', home: '↖', end: '↘', pageup: '⇞', pagedown: '⇟'
}

/** As macOS menus show it, modifiers in the order ⌃⌥⇧⌘: '⌥⌘C', '⌃`', '⇧⌘N'. */
export function formatCombo(combo: string): string {
  if (!combo) return ''
  const { mods, key } = parts(combo)
  return `${mods.has('ctrl') ? '⌃' : ''}${mods.has('alt') ? '⌥' : ''}${mods.has('shift') ? '⇧' : ''}${mods.has('cmd') ? '⌘' : ''}${GLYPHS[key] ?? key.toUpperCase()}`
}

/** Every target's combination ('' for none): the saved ones, the defaults for the rest. */
export function sectionKeys(saved: Partial<Record<string, string>> | undefined): Record<ShortcutTarget, string> {
  const out = {} as Record<ShortcutTarget, string>
  for (const s of SHORTCUT_TARGETS) out[s] = normalizeCombo(saved?.[s] ?? DEFAULT_SHORTCUTS[s] ?? '')
  return out
}

export function sectionFor(saved: Partial<Record<string, string>> | undefined, combo: string | null): ShortcutTarget | null {
  if (!combo) return null
  const keys = sectionKeys(saved)
  return SHORTCUT_TARGETS.find((s) => keys[s] === combo) ?? null
}

/** Taken by macOS or the app's menu: a shortcut there would never arrive, or would cost copy, paste, undo or quit. */
const SYSTEM: Record<string, string> = {
  'cmd+q': 'Quit', 'cmd+h': 'Hide', 'alt+cmd+h': 'Hide Others', 'cmd+m': 'Minimize', 'shift+cmd+w': 'Close Window', 'cmd+c': 'Copy', 'cmd+v': 'Paste',
  'cmd+x': 'Cut', 'cmd+a': 'Select All', 'cmd+z': 'Undo', 'shift+cmd+z': 'Redo', 'alt+shift+cmd+v': 'Paste and Match Style', 'cmd+r': 'Reload',
  'alt+cmd+i': 'the developer tools', 'ctrl+cmd+f': 'full screen', 'cmd+tab': 'switching apps', 'shift+cmd+tab': 'switching apps', 'cmd+`': 'switching windows',
  'shift+cmd+`': 'switching windows', 'cmd+space': 'Spotlight', 'alt+cmd+space': 'searching in Finder', 'ctrl+space': 'switching input sources',
  'ctrl+alt+space': 'switching input sources', 'ctrl+cmd+space': 'Emoji & Symbols', 'shift+cmd+3': 'screenshots', 'shift+cmd+4': 'screenshots',
  'shift+cmd+5': 'screenshots', 'ctrl+shift+cmd+3': 'screenshots', 'ctrl+shift+cmd+4': 'screenshots', 'ctrl+cmd+q': 'Lock Screen',
  'alt+cmd+escape': 'Force Quit', 'alt+cmd+d': 'showing the Dock', 'shift+cmd+/': 'the Help menu', 'ctrl+up': 'Mission Control',
  'ctrl+down': 'the app’s windows', 'ctrl+left': 'switching desktops', 'ctrl+right': 'switching desktops',
  // Moving and selecting in any text field.
  'cmd+left': 'moving to the start of a line', 'cmd+right': 'moving to the end of a line', 'cmd+up': 'moving to the top of a text',
  'cmd+down': 'moving to the end of a text', 'shift+cmd+left': 'selecting text', 'shift+cmd+right': 'selecting text', 'shift+cmd+up': 'selecting text',
  'shift+cmd+down': 'selecting text', 'cmd+backspace': 'deleting to the start of a line'
}

/** The app's own shortcuts, everywhere (src/renderer/shortcuts.ts and App.tsx). */
const APP: Record<string, string> = {
  'cmd+k': 'the quick switcher', 'ctrl+k': 'the quick switcher', 'cmd+t': 'New session', 'shift+cmd+p': 'the command list', 'cmd+1': 'Hosts (the first tab)',
  'cmd+2': 'tab 2', 'cmd+3': 'tab 3', 'cmd+4': 'tab 4', 'cmd+5': 'tab 5', 'cmd+6': 'tab 6', 'cmd+7': 'tab 7', 'cmd+8': 'tab 8', 'cmd+9': 'the last tab',
  'shift+cmd+]': 'Next tab', 'shift+cmd+[': 'Previous tab', 'cmd+w': 'Close tab', 'cmd+\\': 'Open beside', 'shift+cmd+enter': 'Show one pane alone',
  'alt+cmd+left': 'Move between panes', 'alt+cmd+right': 'Move between panes', 'alt+cmd+up': 'Move between panes', 'alt+cmd+down': 'Move between panes',
  'cmd+d': 'Split', 'shift+cmd+d': 'Duplicate', 'shift+cmd+i': 'Broadcast typing', 'cmd+f': 'Find', 'cmd+b': 'Show or hide the sidebar',
  'cmd+,': 'Settings', 'cmd+/': 'Keyboard shortcuts', 'cmd+=': 'Text size', 'shift+cmd+=': 'Text size', 'cmd+-': 'Text size'
}

const WEB_APP_KEYS: Record<string, string> = { 'shift+cmd+r': 'Reload', 'cmd+[': 'Back', 'cmd+]': 'Forward', 'cmd+n': 'New chat' }

/**
 * Keys a tool uses while it is in front (beyond the app's own above). There the tool keeps them, so a section's
 * shortcut on one of them works everywhere else. Notes' keys belong to its editor, which takes them first anyway.
 */
export const TOOL_KEYS: Partial<Record<RailSection, Record<string, string>>> = {
  browser: {
    'cmd+l': 'Edit the address', 'shift+cmd+l': 'Fill from 1Password', 'shift+cmd+t': 'Reopen the closed tab', 'shift+cmd+r': 'Reload without cache', 'cmd+[': 'Back',
    'cmd+]': 'Forward', 'cmd+s': 'its sidebar', 'cmd+0': 'Actual size', 'shift+cmd+c': 'Copy the address', 'ctrl+tab': 'Next tab', 'ctrl+shift+tab': 'Previous tab'
  },
  local: {
    'shift+cmd+t': 'Reopen the closed tab', 'cmd+[': 'Previous pane', 'cmd+]': 'Next pane', 'cmd+0': 'Text size', 'ctrl+tab': 'Next tab',
    'ctrl+shift+tab': 'Previous tab'
  },
  finder: {
    'cmd+o': 'Open', 'cmd+[': 'Back', 'cmd+]': 'Forward', 'shift+cmd+n': 'New folder', 'shift+cmd+.': 'Show hidden files', 'cmd+y': 'Quick Look',
    'cmd+d': 'Duplicate', 'alt+cmd+c': 'Copy the path'
  },
  health: { 'cmd+r': 'Refresh' },
  board: { 'cmd+y': 'Redo', 'cmd+[': 'Send to back', 'cmd+]': 'Bring to front', 'cmd+0': 'Fit everything' },
  notes: {
    'cmd+i': 'Italic', 'shift+cmd+x': 'Strikethrough', 'shift+cmd+h': 'Highlight', 'cmd+e': 'Inline code', 'alt+cmd+1': 'Heading 1', 'alt+cmd+2': 'Heading 2',
    'alt+cmd+3': 'Heading 3', 'alt+cmd+0': 'Body text', 'shift+cmd+8': 'Bulleted list', 'shift+cmd+7': 'Numbered list', 'shift+cmd+9': 'Checklist', 'shift+cmd+.': 'Quote'
  },
  claude: WEB_APP_KEYS,
  chatgpt: WEB_APP_KEYS
}

/** Whether the tool showing (a tab kind) uses this combination itself. */
export function toolOwns(kind: string | undefined, combo: string | null): boolean {
  return !!combo && !!kind && !!TOOL_KEYS[kind as RailSection]?.[combo]
}

export type ComboCheck =
  | { ok: false; reason: string }
  /** `from`: the section that had this combination and loses it. `notes`: where a tool keeps it. */
  | { ok: true; from?: ShortcutTarget; notes: string[] }

/** Whether `combo` can be the shortcut of `section`; `launcherKey` is the launcher's, which works in every app. */
export function checkCombo(combo: string, section: ShortcutTarget, saved: Partial<Record<string, string>> | undefined, launcherKey = ''): ComboCheck {
  const { mods, key } = parts(combo)
  const shown = formatCombo(combo)
  if (launcherKey && normalizeCombo(launcherKey) === combo) return { ok: false, reason: `${shown} opens the launcher, from any app.` }
  if (!mods.has('cmd') && !mods.has('ctrl') && !/^f\d+$/.test(key)) return { ok: false, reason: 'Hold ⌘ or ⌃ with the key (or use an F-key), so typing never sets it off.' }
  if (SYSTEM[combo]) return { ok: false, reason: `macOS keeps ${shown} for ${SYSTEM[combo]}.` }
  if (APP[combo]) return { ok: false, reason: `${shown} is already ${APP[combo]}.` }
  if (mods.has('ctrl') && !mods.has('cmd') && !mods.has('alt') && /^[a-z[\]\\]$/.test(key)) {
    return { ok: false, reason: `${shown} is a terminal control key (⌃C stops a command, ⌃R searches history). Add ⌘ or ⌥.` }
  }
  const keys = sectionKeys(saved)
  const from = SHORTCUT_TARGETS.find((s) => s !== section && keys[s] === combo)
  const notes = Object.entries(TOOL_KEYS).filter(([, m]) => m[combo]).map(([tool, m]) => `In ${SECTION_NAMES[tool as RailSection]}, ${shown} stays ${m[combo]}.`)
  return { ok: true, from, notes }
}

/**
 * Whether `combo` can open the launcher from any app (a global shortcut takes the key from every app, this one
 * included). ⌥Space is allowed, as launchers use it; ⌥ with a letter types a character everywhere.
 */
export function checkGlobalCombo(combo: string, saved: Partial<Record<string, string>> | undefined): ComboCheck {
  const { mods, key } = parts(combo)
  const shown = formatCombo(combo)
  const fkey = /^f\d+$/.test(key)
  if (!mods.has('cmd') && !mods.has('ctrl') && !mods.has('alt') && !fkey) return { ok: false, reason: 'Hold ⌘, ⌃ or ⌥ with the key (or use an F-key), so typing in other apps never sets it off.' }
  if (mods.has('alt') && !mods.has('cmd') && !mods.has('ctrl') && key !== 'space' && !fkey) return { ok: false, reason: `${shown} types a character in every app (⌥E is an accent). Add ⌘ or ⌃, or use ⌥Space.` }
  if (SYSTEM[combo]) return { ok: false, reason: `macOS keeps ${shown} for ${SYSTEM[combo]}.` }
  if (APP[combo]) return { ok: false, reason: `${shown} is already ${APP[combo]} in this app.` }
  if (mods.has('ctrl') && !mods.has('cmd') && !mods.has('alt') && /^[a-z[\]\\]$/.test(key)) {
    return { ok: false, reason: `${shown} is a terminal control key in every terminal. Add ⌘ or ⌥.` }
  }
  const section = sectionFor(saved, combo)
  if (section) return { ok: false, reason: `${shown} opens ${section === 'radial' ? 'the radial menu' : SECTION_NAMES[section]} in this app; give one of them another key.` }
  return { ok: true, notes: combo === 'alt+space' ? ['Raycast and Alfred use ⌥Space too: if one of them is on it, only one app gets the key.'] : [] }
}

const ACCELERATOR_KEYS: Record<string, string> = {
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', enter: 'Return', space: 'Space', tab: 'Tab', backspace: 'Backspace', delete: 'Delete',
  escape: 'Escape', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown'
}

/** The combination as an Electron accelerator ('alt+space' → 'Alt+Space'), for globalShortcut; '' when there is none. */
export function toAccelerator(combo: string): string {
  if (!combo) return ''
  const { mods, key } = parts(normalizeCombo(combo))
  const k = ACCELERATOR_KEYS[key] ?? (/^f\d+$/.test(key) || key.length === 1 ? key.toUpperCase() : '')
  if (!k) return ''
  return [mods.has('ctrl') && 'Control', mods.has('alt') && 'Alt', mods.has('shift') && 'Shift', mods.has('cmd') && 'Command', k].filter(Boolean).join('+')
}

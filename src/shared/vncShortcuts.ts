import { KEYSYM, type VncModifier } from './vncKeys.ts'

/**
 * The screen tab's shortcut menu (Desktop, App, System) and toolbar rows as key presses: a key and the modifiers held
 * around it. Mac shortcuts for a Mac, the Windows equivalents for anything else. Pure, tested in tests/vncShortcuts.test.ts.
 */
export interface Combo {
  /** A keysym (KEYSYM.*) or a single character. */
  key: number | string
  mods: VncModifier[]
}

export interface ShortcutItem {
  id: string
  label: string
  combo: Combo
}

export interface ShortcutGroup {
  id: string
  label: string
  items: ShortcutItem[]
}

const c = (key: number | string, ...mods: VncModifier[]): Combo => ({ key, mods })

/** The grouped shortcuts for the menu, for a Mac or another computer. */
export function shortcutGroups(mac: boolean): ShortcutGroup[] {
  if (mac) {
    return [
      { id: 'desktop', label: 'Desktop', items: [
        { id: 'mission', label: 'Mission Control', combo: c(KEYSYM.Up, 'ctrl') },
        { id: 'appwindows', label: 'Application windows', combo: c(KEYSYM.Down, 'ctrl') },
        { id: 'spaceLeft', label: 'Space to the left', combo: c(KEYSYM.Left, 'ctrl') },
        { id: 'spaceRight', label: 'Space to the right', combo: c(KEYSYM.Right, 'ctrl') }
      ] },
      { id: 'app', label: 'App', items: [
        { id: 'minimize', label: 'Minimize', combo: c('m', 'cmd') },
        { id: 'hide', label: 'Hide', combo: c('h', 'cmd') },
        { id: 'hideOthers', label: 'Hide others', combo: c('h', 'cmd', 'option') },
        { id: 'close', label: 'Close window', combo: c('w', 'cmd') },
        { id: 'quit', label: 'Quit', combo: c('q', 'cmd') },
        { id: 'switch', label: 'Switch app', combo: c(KEYSYM.Tab, 'cmd') }
      ] },
      { id: 'system', label: 'System', items: [
        { id: 'forceQuit', label: 'Force Quit…', combo: c(KEYSYM.Escape, 'cmd', 'option') },
        { id: 'lock', label: 'Lock screen', combo: c('q', 'cmd', 'ctrl') },
        { id: 'screenshot', label: 'Screenshot options', combo: c('5', 'cmd', 'shift') }
      ] },
      { id: 'more', label: '', items: [
        { id: 'spotlight', label: 'Spotlight', combo: c(' ', 'cmd') },
        { id: 'backslash', label: 'Backslash', combo: c('\\') }
      ] }
    ]
  }
  return [
    { id: 'desktop', label: 'Desktop', items: [
      { id: 'taskview', label: 'Task view', combo: c(KEYSYM.Tab, 'cmd') },
      { id: 'desktop', label: 'Show desktop', combo: c('d', 'cmd') },
      { id: 'spaceLeft', label: 'Desktop to the left', combo: c(KEYSYM.Left, 'cmd', 'ctrl') },
      { id: 'spaceRight', label: 'Desktop to the right', combo: c(KEYSYM.Right, 'cmd', 'ctrl') }
    ] },
    { id: 'app', label: 'App', items: [
      { id: 'minimize', label: 'Minimize', combo: c(KEYSYM.Down, 'cmd') },
      { id: 'close', label: 'Close window', combo: c('w', 'ctrl') },
      { id: 'quit', label: 'Close app', combo: c(KEYSYM.F1 + 3, 'option') },
      { id: 'switch', label: 'Switch app', combo: c(KEYSYM.Tab, 'option') }
    ] },
    { id: 'system', label: 'System', items: [
      { id: 'taskmgr', label: 'Task Manager', combo: c(KEYSYM.Escape, 'ctrl', 'shift') },
      { id: 'lock', label: 'Lock screen', combo: c('l', 'cmd') },
      { id: 'screenshot', label: 'Snipping tool', combo: c('s', 'cmd', 'shift') }
    ] },
    { id: 'more', label: '', items: [
      { id: 'start', label: 'Start menu', combo: c(KEYSYM.Super_L) },
      { id: 'backslash', label: 'Backslash', combo: c('\\') }
    ] }
  ]
}

/** The edit row: undo, redo, cut, copy, paste, with ⌘ on a Mac and Ctrl elsewhere. */
export function editCombos(mac: boolean): Record<'undo' | 'redo' | 'cut' | 'copy' | 'paste', Combo> {
  const m: VncModifier = mac ? 'cmd' : 'ctrl'
  return {
    undo: c('z', m),
    redo: mac ? c('z', 'cmd', 'shift') : c('y', 'ctrl'),
    cut: c('x', m),
    copy: c('c', m),
    paste: c('v', m)
  }
}

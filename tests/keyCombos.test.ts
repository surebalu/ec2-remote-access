import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkCombo, checkGlobalCombo, comboOf, DEFAULT_SHORTCUTS, formatCombo, normalizeCombo, sectionFor, sectionKeys, toAccelerator, toolOwns } from '../src/shared/keyCombos.ts'

const press = (code: string, key: string, mods: Partial<{ meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }> = {}) =>
  comboOf({ code, key, meta: false, ctrl: false, alt: false, shift: false, ...mods })

test('a key press becomes a combination named after the physical key', () => {
  assert.equal(press('KeyC', 'c', { meta: true }), 'cmd+c')
  // ⌥ and ⇧ change the character, not the combination.
  assert.equal(press('KeyC', 'ç', { meta: true, alt: true }), 'alt+cmd+c')
  assert.equal(press('BracketLeft', '{', { meta: true, shift: true }), 'shift+cmd+[')
  assert.equal(press('Digit1', '¡', { alt: true, meta: true }), 'alt+cmd+1')
  assert.equal(press('Backquote', '`', { ctrl: true }), 'ctrl+`')
  assert.equal(press('ArrowUp', 'ArrowUp', { ctrl: true, meta: true }), 'ctrl+cmd+up')
  assert.equal(press('F5', 'F5'), 'f5')
  assert.equal(press('Equal', '+', { meta: true, shift: true }), 'shift+cmd+=')
  assert.equal(press('Space', ' ', { ctrl: true, alt: true, shift: true, meta: true }), 'ctrl+alt+shift+cmd+space')
})

test('modifiers on their own are not a combination yet', () => {
  for (const [code, key] of [['MetaLeft', 'Meta'], ['ControlLeft', 'Control'], ['AltRight', 'Alt'], ['ShiftLeft', 'Shift'], ['CapsLock', 'CapsLock']]) {
    assert.equal(press(code, key, { meta: true }), null, code)
  }
})

test('events without a code fall back to the character', () => {
  assert.equal(comboOf({ key: 'n', meta: true, ctrl: false, alt: false, shift: true }), 'shift+cmd+n')
  assert.equal(comboOf({ key: 'ArrowLeft', meta: false, ctrl: true, alt: true, shift: false }), 'ctrl+alt+left')
  assert.equal(comboOf({ key: 'Unidentified', meta: true, ctrl: false, alt: false, shift: false }), null)
})

test('combinations read as macOS writes them', () => {
  assert.equal(formatCombo('alt+cmd+c'), '⌥⌘C')
  assert.equal(formatCombo('shift+cmd+n'), '⇧⌘N')
  assert.equal(formatCombo('ctrl+`'), '⌃`')
  assert.equal(formatCombo('ctrl+alt+shift+cmd+space'), '⌃⌥⇧⌘Space')
  assert.equal(formatCombo('ctrl+cmd+up'), '⌃⌘↑')
  assert.equal(formatCombo('f12'), 'F12')
  assert.equal(formatCombo('cmd+-'), '⌘-')
  assert.equal(formatCombo(''), '')
})

test('hand-edited combinations are put in the stored order', () => {
  assert.equal(normalizeCombo('Cmd+Shift+N'), 'shift+cmd+n')
  assert.equal(normalizeCombo('command+option+c'), 'alt+cmd+c')
  assert.equal(normalizeCombo('control+`'), 'ctrl+`')
  assert.equal(normalizeCombo('cmd+-'), 'cmd+-')
  assert.equal(normalizeCombo(''), '')
  assert.equal(normalizeCombo('cmd+'), '')
})

test('saved shortcuts override the defaults, and an empty one turns a default off', () => {
  const keys = sectionKeys({ claude: 'ctrl+cmd+c', notes: '' })
  assert.equal(keys.claude, 'ctrl+cmd+c')
  assert.equal(keys.notes, '')
  assert.equal(keys.overview, DEFAULT_SHORTCUTS.overview)
  assert.equal(keys.hosts, '')
  assert.equal(sectionFor({ claude: 'ctrl+cmd+c' }, 'ctrl+cmd+c'), 'claude')
  assert.equal(sectionFor({ claude: 'Cmd+Ctrl+C' }, 'ctrl+cmd+c'), 'claude')
  assert.equal(sectionFor(undefined, 'shift+cmd+n'), 'notes')
  assert.equal(sectionFor({ notes: '' }, 'shift+cmd+n'), null)
  assert.equal(sectionFor(undefined, 'ctrl+`'), 'local')
  assert.equal(sectionFor(undefined, null), null)
})

test('keys that would break typing, the system or the app are refused', () => {
  const refused = (combo: string): string => {
    const r = checkCombo(combo, 'claude', undefined)
    assert.equal(r.ok, false, combo)
    return r.ok ? '' : r.reason
  }
  assert.match(refused('c'), /⌘ or ⌃/)
  assert.match(refused('shift+c'), /⌘ or ⌃/)
  assert.match(refused('alt+c'), /⌘ or ⌃/)
  assert.match(refused('cmd+c'), /Copy/)
  assert.match(refused('cmd+q'), /Quit/)
  assert.match(refused('cmd+space'), /Spotlight/)
  assert.match(refused('cmd+left'), /start of a line/)
  assert.match(refused('cmd+k'), /quick switcher/)
  assert.match(refused('cmd+1'), /Hosts/)
  assert.match(refused('cmd+t'), /New session/)
  assert.match(refused('ctrl+c'), /terminal control key/)
  assert.match(refused('ctrl+shift+r'), /terminal control key/)
  for (const ok of ['ctrl+cmd+c', 'alt+cmd+c', 'ctrl+alt+c', 'f5', 'shift+f5', 'ctrl+1', 'ctrl+`', 'shift+cmd+o']) assert.equal(checkCombo(ok, 'claude', undefined).ok, true, ok)
})

test('a combination another section had moves, and a tool in front keeps its own', () => {
  const moved = checkCombo('shift+cmd+n', 'claude', undefined)
  assert.equal(moved.ok, true)
  if (moved.ok) {
    assert.equal(moved.from, 'notes')
    assert.deepEqual(moved.notes, ['In Finder, ⇧⌘N stays New folder.'])
  }
  const own = checkCombo('shift+cmd+n', 'notes', undefined)
  assert.equal(own.ok && own.from, undefined)
  const l = checkCombo('cmd+l', 'chatgpt', undefined)
  assert.deepEqual(l.ok && l.notes, ['In Browser, ⌘L stays Edit the address.'])
  assert.equal(toolOwns('browser', 'cmd+l'), true)
  assert.equal(toolOwns('browser', 'cmd+0'), true)
  assert.equal(toolOwns('finder', 'cmd+0'), false)
  assert.equal(toolOwns('ssh', 'cmd+l'), false)
  assert.equal(toolOwns(undefined, 'cmd+l'), false)
  assert.equal(toolOwns('claude', null), false)
})

test('the launcher key works in every app, so it is checked against typing everywhere', () => {
  const reason = (combo: string, saved?: Record<string, string>): string => { const r = checkGlobalCombo(combo, saved); return r.ok ? '' : r.reason }
  const ok = checkGlobalCombo('alt+space', undefined)
  assert.equal(ok.ok, true)
  assert.match(ok.ok ? ok.notes[0] : '', /Raycast/)
  for (const combo of ['ctrl+alt+cmd+space', 'shift+cmd+space', 'alt+cmd+l', 'f13', 'ctrl+alt+k']) assert.equal(checkGlobalCombo(combo, undefined).ok, true, combo)
  assert.match(reason('space'), /⌘, ⌃ or ⌥/)
  assert.match(reason('alt+e'), /types a character/)
  assert.match(reason('shift+alt+e'), /types a character/)
  assert.match(reason('cmd+space'), /Spotlight/)
  assert.match(reason('cmd+k'), /quick switcher/)
  assert.match(reason('ctrl+r'), /terminal control key/)
  assert.match(reason('ctrl+cmd+c', { claude: 'ctrl+cmd+c' }), /opens Claude/)
  assert.match(reason('shift+cmd+n'), /opens Notes/)
  // And a section cannot take the launcher's key.
  const taken = checkCombo('alt+cmd+l', 'claude', undefined, 'alt+cmd+l')
  assert.match(taken.ok ? '' : taken.reason, /launcher/)
})

test('combinations become Electron accelerators', () => {
  assert.equal(toAccelerator('alt+space'), 'Alt+Space')
  assert.equal(toAccelerator('ctrl+alt+shift+cmd+k'), 'Control+Alt+Shift+Command+K')
  assert.equal(toAccelerator('cmd+`'), 'Command+`')
  assert.equal(toAccelerator('f13'), 'F13')
  assert.equal(toAccelerator('ctrl+cmd+up'), 'Control+Command+Up')
  assert.equal(toAccelerator('Cmd+Shift+Enter'), 'Shift+Command+Return')
  assert.equal(toAccelerator(''), '')
})

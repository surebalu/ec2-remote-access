import { test } from 'node:test'
import assert from 'node:assert/strict'
import { editCombos, shortcutGroups } from '../src/shared/vncShortcuts.ts'
import { KEYSYM } from '../src/shared/vncKeys.ts'

test('a Mac gets Mac shortcuts, other computers their own', () => {
  const mac = shortcutGroups(true)
  assert.deepEqual(mac.map((g) => g.id), ['desktop', 'app', 'system', 'more'])
  const find = (groups: ReturnType<typeof shortcutGroups>, id: string) => groups.flatMap((g) => g.items).find((i) => i.id === id)!
  assert.deepEqual(find(mac, 'mission').combo, { key: KEYSYM.Up, mods: ['ctrl'] })
  assert.deepEqual(find(mac, 'quit').combo, { key: 'q', mods: ['cmd'] })
  assert.deepEqual(find(mac, 'spotlight').combo, { key: ' ', mods: ['cmd'] })
  const win = shortcutGroups(false)
  assert.deepEqual(find(win, 'lock').combo, { key: 'l', mods: ['cmd'] }, 'the Windows key is sent as ⌘ to a non-Mac (modifierKeysym maps it to Super)')
  assert.deepEqual(find(win, 'quit').combo, { key: KEYSYM.F1 + 3, mods: ['option'] }, 'Alt+F4')
  for (const g of [...mac, ...win]) for (const i of g.items) assert.ok(i.label && i.id, 'every item is named')
})

test('the edit row uses ⌘ on a Mac and Ctrl elsewhere; redo is ⇧⌘Z or Ctrl+Y', () => {
  assert.deepEqual(editCombos(true).copy, { key: 'c', mods: ['cmd'] })
  assert.deepEqual(editCombos(true).redo, { key: 'z', mods: ['cmd', 'shift'] })
  assert.deepEqual(editCombos(false).paste, { key: 'v', mods: ['ctrl'] })
  assert.deepEqual(editCombos(false).redo, { key: 'y', mods: ['ctrl'] })
})

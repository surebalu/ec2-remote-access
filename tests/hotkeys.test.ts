import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanAppHotkey, globalKeysOf, otherGlobalKeys } from '../src/shared/hotkeys.ts'
import { checkGlobalCombo } from '../src/shared/keyCombos.ts'

const settings = {
  launcherKey: 'alt+space', linkSaveKey: 'ctrl+s', linkFindKey: '',
  windowKeys: { 'left-half': 'ctrl+alt+left', 'no-such-layout': 'ctrl+alt+z' },
  appHotkeys: [{ id: 'a1', path: '/Applications/Slack.app', name: 'Slack', combo: 'ctrl+alt+shift+s' }, { id: 'a2', path: '/Applications/Warp.app', name: 'Warp', combo: '' }]
}

test('every global key, with what it does; unknown layouts and empty keys left out', () => {
  const keys = globalKeysOf(settings)
  assert.deepEqual(keys.map((k) => k.id), ['launcher', 'linkSave', 'window:left-half', 'app:a1'])
  assert.equal(keys.find((k) => k.id === 'window:left-half')?.does, 'moves the window in front to Left Half')
  assert.equal(globalKeysOf(undefined).map((k) => k.combo).join(), 'ctrl+s,ctrl+f', 'the Links panels keep Anybox’s keys by default')
})

test('a new key may not repeat another global key', () => {
  const others = otherGlobalKeys(settings, 'window:right-half')
  const check = checkGlobalCombo('ctrl+alt+left', {}, { others })
  assert.equal(check.ok, false)
  assert.match(check.ok ? '' : check.reason, /Left Half/)
  assert.equal(checkGlobalCombo('ctrl+alt+left', {}, { others: otherGlobalKeys(settings, 'window:left-half') }).ok, true, 'its own key is no clash')
  assert.equal(checkGlobalCombo('ctrl+alt+u', {}, { others }).ok, true)
})

test('an app hotkey is stored with a name and the combination in order', () => {
  assert.deepEqual(cleanAppHotkey({ id: 'x', path: '/Applications/Visual Studio Code.app', name: ' ', combo: 'Cmd+Ctrl+V' }), { id: 'x', path: '/Applications/Visual Studio Code.app', name: 'Visual Studio Code', combo: 'ctrl+cmd+v' })
})

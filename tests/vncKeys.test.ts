import { test } from 'node:test'
import assert from 'node:assert/strict'
import { charKeysym, forAppleServer, KEYSYM, modifierKeysym, NAMED_KEYSYMS } from '../src/shared/vncKeys.ts'

test('characters: Latin-1 is its own keysym, the rest the Unicode range', () => {
  assert.equal(charKeysym('a'), 0x61)
  assert.equal(charKeysym('~'), 0x7e)
  assert.equal(charKeysym('é'), 0xe9)
  assert.equal(charKeysym('€'), 0x010020ac)
  assert.equal(charKeysym('😀'), 0x0101f600, 'astral characters by code point, not by UTF-16 half')
  assert.equal(charKeysym('\n'), KEYSYM.Return)
  assert.equal(charKeysym('\t'), KEYSYM.Tab)
})

test('a Mac reads Meta as ⌥, so noVNC’s ⌥ (Mode_switch, which macOS drops) is sent as Meta', () => {
  assert.equal(forAppleServer(KEYSYM.Mode_switch), KEYSYM.Meta_L)
  assert.equal(forAppleServer(KEYSYM.ISO_Level3_Shift), KEYSYM.Meta_R)
  assert.equal(forAppleServer(KEYSYM.Alt_L), KEYSYM.Alt_L, '⌘ arrives as Alt_L, which a Mac already reads as ⌘')
  assert.equal(forAppleServer(0x61), 0x61)
})

test('key bar modifiers mean Command and Option on a Mac, the Windows key and Alt elsewhere', () => {
  assert.equal(modifierKeysym('cmd', true), KEYSYM.Alt_L)
  assert.equal(modifierKeysym('option', true), KEYSYM.Meta_L)
  assert.equal(modifierKeysym('cmd', false), KEYSYM.Super_L)
  assert.equal(modifierKeysym('option', false), KEYSYM.Alt_L)
  assert.equal(modifierKeysym('ctrl', true), KEYSYM.Control_L)
  assert.equal(NAMED_KEYSYMS.F12, 0xffc9)
  assert.equal(NAMED_KEYSYMS.ArrowLeft, 0xff51)
})

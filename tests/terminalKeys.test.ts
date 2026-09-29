import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyStickyMods, keySequence } from '../src/renderer/terminalKeys.ts'

const none = { ctrl: false, alt: false }

test('Ctrl maps letters and punctuation to C0 control codes', () => {
  assert.equal(applyStickyMods('c', { ctrl: true, alt: false }), '\x03')
  assert.equal(applyStickyMods('C', { ctrl: true, alt: false }), '\x03')
  assert.equal(applyStickyMods('d', { ctrl: true, alt: false }), '\x04')
  assert.equal(applyStickyMods('[', { ctrl: true, alt: false }), '\x1b')
  assert.equal(applyStickyMods(' ', { ctrl: true, alt: false }), '\x00')
  assert.equal(applyStickyMods('?', { ctrl: true, alt: false }), '\x7f')
})

test('Ctrl leaves multi-character input alone; Alt prefixes ESC', () => {
  assert.equal(applyStickyMods('ls', { ctrl: true, alt: false }), 'ls')
  assert.equal(applyStickyMods('b', { ctrl: false, alt: true }), '\x1bb')
  assert.equal(applyStickyMods('x', { ctrl: true, alt: true }), '\x1b\x18')
  assert.equal(applyStickyMods('q', none), 'q')
})

test('arrow keys follow application cursor mode', () => {
  assert.equal(keySequence('Up', false), '\x1b[A')
  assert.equal(keySequence('Up', true), '\x1bOA')
  assert.equal(keySequence('Left', true), '\x1bOD')
  assert.equal(keySequence('Esc', true), '\x1b')
  assert.equal(keySequence('Tab', false), '\t')
  assert.equal(keySequence('PgDn', false), '\x1b[6~')
  assert.equal(keySequence('|', false), '|')
})

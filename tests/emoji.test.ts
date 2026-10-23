import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildEmojiList, emojiTitle, noteRecentEmoji, searchEmoji } from '../src/shared/emoji.ts'

// The same data the launcher loads.
const byEmoji = JSON.parse(readFileSync(new URL('../node_modules/unicode-emoji-json/data-by-emoji.json', import.meta.url), 'utf8'))
const keywords = JSON.parse(readFileSync(new URL('../node_modules/emojilib/dist/emoji-en-US.json', import.meta.url), 'utf8'))
const list = buildEmojiList(byEmoji, keywords)

test('every emoji, with its name and keywords', () => {
  assert.ok(list.length > 1800)
  const rocket = list.find((e) => e.char === '🚀')!
  assert.equal(emojiTitle(rocket), 'Rocket')
  assert.ok(rocket.words.includes('launch'))
})

test('found by the start of any word, the name first', () => {
  assert.equal(searchEmoji(list, 'rocket')[0].char, '🚀')
  assert.equal(searchEmoji(list, 'thumbs up')[0].char, '👍')
  assert.ok(searchEmoji(list, 'happ').some((e) => e.char === '😀'), 'a keyword prefix')
  assert.ok(searchEmoji(list, 'tada').some((e) => e.char === '🎉'))
  assert.deepEqual(searchEmoji(list, 'zzzqqq'), [])
})

test('recently used come first', () => {
  const recent = noteRecentEmoji(noteRecentEmoji([], '🎉'), '🚀')
  assert.deepEqual(recent, ['🚀', '🎉'])
  assert.deepEqual(searchEmoji(list, '', recent).slice(0, 2).map((e) => e.char), ['🚀', '🎉'])
  assert.deepEqual(noteRecentEmoji(['a', 'b', 'c'], 'b', 2), ['b', 'a'])
})

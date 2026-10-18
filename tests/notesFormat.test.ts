import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activeFormats, applyEdits, clearFormatting, insertBlock, insertLink, setColor, setHeading, toggleInline, toggleLinePrefix, type Result, type Sel } from '../src/renderer/notesFormat.ts'

/** Runs a command and returns the new document with the selection marked as [ and ]. */
function run(doc: string, sel: Sel, fn: (doc: string, sel: Sel) => Result): string {
  const r = fn(doc, sel)
  const out = applyEdits(doc, r.edits)
  return `${out.slice(0, r.selection.from)}[${out.slice(r.selection.from, r.selection.to)}]${out.slice(r.selection.to)}`
}
const at = (doc: string, word: string): Sel => ({ from: doc.indexOf(word), to: doc.indexOf(word) + word.length })

test('bold, italic, strikethrough, code and highlight wrap and unwrap', () => {
  const doc = 'make this bold now'
  assert.equal(run(doc, at(doc, 'this bold'), (d, s) => toggleInline(d, s, '**')), 'make **[this bold]** now')
  assert.equal(run('make **this** now', at('make **this** now', 'this'), (d, s) => toggleInline(d, s, '**')), 'make [this] now')
  assert.equal(run('make **this** now', at('make **this** now', '**this**'), (d, s) => toggleInline(d, s, '**')), 'make [this] now')
  // Italic inside bold is not mistaken for bold, and bold is not taken for italic.
  assert.equal(run('**this**', at('**this**', 'this'), (d, s) => toggleInline(d, s, '*')), '***[this]***')
  assert.equal(run('*this*', at('*this*', 'this'), (d, s) => toggleInline(d, s, '*')), '[this]')
  assert.equal(run('a ~~gone~~ b', at('a ~~gone~~ b', 'gone'), (d, s) => toggleInline(d, s, '~~')), 'a [gone] b')
  assert.equal(run('run ls now', at('run ls now', 'ls'), (d, s) => toggleInline(d, s, '`')), 'run `[ls]` now')
  assert.equal(run('key fact', at('key fact', 'key'), (d, s) => toggleInline(d, s, '==')), '==[key]== fact')
})

test('without a selection: the word at the cursor, or an empty pair to type into', () => {
  assert.equal(run('one two', { from: 5, to: 5 }, (d, s) => toggleInline(d, s, '**')), 'one **[two]**')
  assert.equal(run('one ', { from: 4, to: 4 }, (d, s) => toggleInline(d, s, '*')), 'one *[]*')
})

test('spaces stay outside the marks, and several lines are done line by line', () => {
  assert.equal(run('a  word  b', { from: 1, to: 9 }, (d, s) => toggleInline(d, s, '**')), 'a  **[word]**  b')
  assert.equal(applyEdits('one\n\ntwo', toggleInline('one\n\ntwo', { from: 0, to: 8 }, '~~').edits), '~~one~~\n\n~~two~~')
})

test('headings replace one another and go back to body text', () => {
  assert.equal(applyEdits('Title', setHeading('Title', { from: 2, to: 2 }, 1).edits), '# Title')
  assert.equal(applyEdits('## Title', setHeading('## Title', { from: 4, to: 4 }, 3).edits), '### Title')
  assert.equal(applyEdits('## Title', setHeading('## Title', { from: 4, to: 4 }, 0).edits), 'Title')
})

test('bullets, numbers, tasks and quotes toggle, switch kinds, renumber and keep indentation', () => {
  const doc = 'apples\npears\n  figs'
  assert.equal(applyEdits(doc, toggleLinePrefix(doc, { from: 0, to: doc.length }, 'bullet').edits), '- apples\n- pears\n  - figs')
  const bullets = '- apples\n- pears'
  assert.equal(applyEdits(bullets, toggleLinePrefix(bullets, { from: 0, to: bullets.length }, 'bullet').edits), 'apples\npears')
  assert.equal(applyEdits(bullets, toggleLinePrefix(bullets, { from: 0, to: bullets.length }, 'number').edits), '1. apples\n2. pears')
  assert.equal(applyEdits(bullets, toggleLinePrefix(bullets, { from: 0, to: bullets.length }, 'task').edits), '- [ ] apples\n- [ ] pears')
  assert.equal(applyEdits('- [x] done', toggleLinePrefix('- [x] done', { from: 3, to: 3 }, 'task').edits), 'done')
  assert.equal(applyEdits('wise words', toggleLinePrefix('wise words', { from: 0, to: 0 }, 'quote').edits), '> wise words')
  // The cursor stays on its word after a mark is added in front.
  assert.equal(run('apples', { from: 3, to: 3 }, (d, s) => toggleLinePrefix(d, s, 'bullet')), '- app[]les')
})

test('colour wraps in a span, changes it in place, and removes it', () => {
  const doc = 'this is important'
  const red = run(doc, at(doc, 'important'), (d, s) => setColor(d, s, '#e5484d'))
  assert.equal(red, 'this is <span style="color:#e5484d">[important]</span>')
  const coloured = 'this is <span style="color:#e5484d">important</span>'
  assert.equal(run(coloured, at(coloured, 'important'), (d, s) => setColor(d, s, '#0090ff')), 'this is <span style="color:#0090ff">[important]</span>')
  assert.equal(run(coloured, at(coloured, 'important'), (d, s) => setColor(d, s, null)), 'this is [important]')
  assert.equal(activeFormats(coloured, coloured.indexOf('port')).color, '#e5484d')
})

test('links, blocks and clearing formatting', () => {
  assert.equal(run('see docs', at('see docs', 'docs'), insertLink), 'see [docs]([url])')
  assert.equal(run('https://x.io', { from: 0, to: 12 }, insertLink), '[[]](https://x.io)')
  assert.equal(applyEdits('ls -la\npwd', insertBlock('ls -la\npwd', { from: 0, to: 10 }, 'code').edits), '```\nls -la\npwd\n```')
  assert.equal(applyEdits('above', insertBlock('above', { from: 5, to: 5 }, 'hr').edits), 'above\n\n---\n')
  const messy = '## **Big** ~~old~~ <span style="color:#e5484d">red</span> `x`'
  assert.equal(applyEdits(messy, clearFormatting(messy, { from: 5, to: 5 }).edits), 'Big old red x')
  assert.equal(applyEdits('- [ ] *task*', clearFormatting('- [ ] *task*', { from: 8, to: 8 }).edits), 'task')
})

test('the toolbar knows what the cursor is in', () => {
  const doc = '# **bold *both* end**'
  const f = activeFormats(doc, doc.indexOf('both') + 1)
  assert.deepEqual(f.marks.sort(), ['*', '**'].sort())
  assert.equal(f.heading, 1)
  assert.equal(activeFormats('- [ ] x', 6).line, 'task')
  assert.equal(activeFormats('3. x', 3).line, 'number')
})

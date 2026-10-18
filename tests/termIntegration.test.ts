import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeBase64, folderName, parseHistory, parseMark, parseOsc7, suggestFromHistory, tildify } from '../src/shared/termIntegration.ts'

test('shell integration marks: prompt, output, exit status, command line and properties', () => {
  assert.deepEqual(parseMark(133, 'A'), { kind: 'prompt' })
  assert.deepEqual(parseMark(133, 'C'), { kind: 'output' })
  assert.deepEqual(parseMark(133, 'D;130'), { kind: 'done', exit: 130 })
  assert.deepEqual(parseMark(133, 'D'), { kind: 'done', exit: 0 })
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode('echo "héllo" | wc -c')))
  assert.deepEqual(parseMark(633, `E;${b64}`), { kind: 'command', text: 'echo "héllo" | wc -c' })
  assert.deepEqual(parseMark(633, 'P;Git=main'), { kind: 'prop', key: 'Git', value: 'main' })
  assert.equal(parseMark(633, 'P;novalue'), null)
  assert.equal(decodeBase64('%%%'), '')
})

test('working directory from OSC 7, shown relative to home', () => {
  assert.equal(parseOsc7('file://mac.local/Users/me/my%20dir'), '/Users/me/my dir')
  assert.equal(parseOsc7('file:///tmp'), '/tmp')
  assert.equal(parseOsc7('nonsense'), null)
  assert.equal(tildify('/Users/me/code/app', '/Users/me'), '~/code/app')
  assert.equal(tildify('/Users/meow', '/Users/me'), '/Users/meow')
  assert.equal(folderName('/Users/me', '/Users/me'), '~')
  assert.equal(folderName('/Users/me/code/app', '/Users/me'), 'app')
  assert.equal(folderName('/', '/Users/me'), '/')
})

test('zsh and bash history files: multi-line commands, newest use wins, limit', () => {
  const zsh = [': 1700000000:0;ls -la', ': 1700000001:0;for f in *; do\\', '  echo $f\\', 'done', ': 1700000002:0;git status', ': 1700000003:0;ls -la', ''].join('\n')
  assert.deepEqual(parseHistory(zsh, 10), ['for f in *; do\n  echo $f\ndone', 'git status', 'ls -la'])
  assert.deepEqual(parseHistory(zsh, 2), ['git status', 'ls -la'])
  assert.deepEqual(parseHistory('cd /tmp\n#1700000000\nmake\n\ncd /tmp\n', 10), ['make', 'cd /tmp'])
})

test('the input box suggests the latest matching single-line command', () => {
  const h = ['git status', 'git commit -m "x"', 'git checkout main', 'ls']
  assert.equal(suggestFromHistory(h, 'git c'), 'git checkout main')
  assert.equal(suggestFromHistory(h, 'git status'), null)
  assert.equal(suggestFromHistory(h, '  '), null)
  assert.equal(suggestFromHistory(['for x\ndo'], 'for'), null)
})

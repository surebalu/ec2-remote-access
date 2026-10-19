import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dictationKeyLabel, fitCase, fitDictation, HoldToTalk, isDictationKey, leadingSpace, parseHelperLine, parseStatusOutput, transcriptTail } from '../src/shared/dictation.ts'

test('helper lines become events; anything else is ignored', () => {
  assert.deepEqual(parseHelperLine('{"type":"ready","onDevice":true}'), { kind: 'ready', onDevice: true })
  assert.deepEqual(parseHelperLine('{"type":"ready"}'), { kind: 'ready', onDevice: false })
  assert.deepEqual(parseHelperLine('{"type":"partial","text":"connect to web"}'), { kind: 'partial', text: 'connect to web' })
  assert.deepEqual(parseHelperLine('{"type":"final","text":"Connect to web prod one."}'), { kind: 'final', text: 'Connect to web prod one.' })
  assert.deepEqual(parseHelperLine('{"type":"level","level":0.42}'), { kind: 'level', level: 0.42 })
  assert.deepEqual(parseHelperLine('{"type":"level","level":7}'), { kind: 'level', level: 1 }, 'levels are clamped')
  assert.deepEqual(parseHelperLine('{"type":"level","level":-1}'), { kind: 'level', level: 0 })
  assert.deepEqual(parseHelperLine('{"type":"error","message":"Microphone access is off"}'), { kind: 'error', message: 'Microphone access is off' })
  assert.deepEqual(parseHelperLine('{"type":"error"}'), { kind: 'error', message: 'Dictation stopped.' })
  for (const junk of ['', 'not json', '[1,2]', 'null', '{"type":"partial"}', '{"type":"level","level":"x"}', '{"type":"status"}', '{"type":"other","text":"x"}']) {
    assert.equal(parseHelperLine(junk), null, junk)
  }
})

test('the --status report is read without trusting its shape', () => {
  const out = '{"type":"status","speech":"notDetermined","mic":"authorized","supported":true,"available":true,"onDevice":true,"locale":"en-US","locales":["en-GB","en-US",3]}\n'
  assert.deepEqual(parseStatusOutput(out), { mic: 'authorized', speech: 'notDetermined', onDevice: true, locale: 'en-US', supported: true, recognizerAvailable: true, locales: ['en-GB', 'en-US'] })
  assert.equal(parseStatusOutput('{"type":"status","speech":"weird"}')?.speech, 'unknown')
  assert.equal(parseStatusOutput('{"type":"status","supported":false,"available":false}')?.supported, false)
  assert.equal(parseStatusOutput(''), null)
  assert.equal(parseStatusOutput('{"type":"ready"}'), null)
})

test('a space goes between earlier text and the dictated words only where one is missing', () => {
  assert.equal(leadingSpace('', 'hello'), '')
  assert.equal(leadingSpace('web', 'prod'), ' ')
  assert.equal(leadingSpace('web ', 'prod'), '')
  assert.equal(leadingSpace('line\n', 'next'), '')
  assert.equal(leadingSpace('call(', 'arg'), '')
  assert.equal(leadingSpace('see “', 'quote'), '')
  assert.equal(leadingSpace('say "', 'hello'), '', 'inside an opened straight quote')
  assert.equal(leadingSpace('said "hi"', 'then'), ' ', 'after a closed quote')
  assert.equal(leadingSpace('done', ', and more'), '', 'no space before punctuation')
  assert.equal(leadingSpace('done', '.'), '')
})

test('case follows the sentence: capital at the start, lower case mid-sentence, untouched otherwise', () => {
  assert.equal(fitCase('', 'connect to web'), 'Connect to web')
  assert.equal(fitCase('It works. ', 'next step'), 'Next step')
  assert.equal(fitCase('Really?', 'yes'), 'Yes')
  assert.equal(fitCase('first line\n', 'second'), 'Second')
  assert.equal(fitCase('restart the', 'Web server'), 'web server')
  assert.equal(fitCase('one, ', 'Two'), 'two')
  assert.equal(fitCase('restart the', 'AWS agent'), 'AWS agent', 'acronyms stay')
  assert.equal(fitCase('then', 'I think so'), 'I think so', '"I" stays')
  assert.equal(fitCase('then', 'I’m sure'), 'I’m sure')
  assert.equal(fitCase('open the', 'iPhone app'), 'iPhone app')
  assert.equal(fitCase('│ > ', 'Fix the login bug'), 'Fix the login bug', 'after a prompt the words are as heard')
  assert.equal(fitCase('Note: ', 'Check disk'), 'Check disk')
})

test('fitDictation trims, spaces and cases the words for where they land', () => {
  assert.equal(fitDictation('', '  connect to web prod one  '), 'Connect to web prod one')
  assert.equal(fitDictation('ssh', 'Web prod'), ' web prod')
  assert.equal(fitDictation('Done. ', 'next'), 'Next')
  assert.equal(fitDictation('hello ', 'There', 'world'), 'there ', 'a word right after gets a space')
  assert.equal(fitDictation('hello ', 'there', '.'), 'there')
  assert.equal(fitDictation('anything', '   '), '')
})

test('a long transcript shows its end, from a word boundary', () => {
  assert.equal(transcriptTail('short'), 'short')
  const long = 'alpha beta gamma delta '.repeat(10) + 'the very end'
  const tail = transcriptTail(long, 40)
  assert.ok(tail.startsWith('…'))
  assert.ok(tail.endsWith('the very end'))
  assert.ok(tail.length <= 41)
  assert.ok(long.endsWith(tail.slice(1)))
  assert.equal(long.at(-tail.length), ' ', 'it starts at a whole word')
})

test('the dictation key setting', () => {
  assert.equal(isDictationKey({ code: 'AltRight', key: 'Alt' }, undefined), true, 'Right Option by default')
  assert.equal(isDictationKey({ code: 'AltLeft', key: 'Alt' }, 'AltRight'), false)
  assert.equal(isDictationKey({ code: 'MetaRight', key: 'Meta' }, 'MetaRight'), true)
  assert.equal(isDictationKey({ code: '', key: 'Fn' }, 'Fn'), true)
  assert.equal(isDictationKey({ code: 'AltRight', key: 'Alt' }, 'off'), false)
  assert.equal(dictationKeyLabel('AltRight'), 'Right ⌥')
  assert.equal(dictationKeyLabel(undefined), 'Right ⌥')
  assert.equal(dictationKeyLabel('off'), '')
})

function fakeTimers() {
  let pending: { fn: () => void; id: number } | null = null
  let n = 0
  return {
    timers: { set: (fn: () => void) => { pending = { fn, id: ++n }; return n }, clear: (h: unknown) => { if (pending?.id === h) pending = null } },
    fire: () => { const p = pending; pending = null; p?.fn() },
    get pending() { return !!pending }
  }
}

test('hold to talk: a held key starts, release stops; a quick tap or a combination does nothing', () => {
  const t = fakeTimers()
  const log: string[] = []
  const hold = new HoldToTalk({ delayMs: 200, start: () => log.push('start'), stop: () => log.push('stop'), timers: t.timers })

  hold.keyDown()
  assert.equal(t.pending, true)
  t.fire()
  assert.deepEqual(log, ['start'])
  hold.keyDown(true) // auto-repeat while held
  hold.otherKey() // typing while talking does not stop it
  hold.keyUp()
  assert.deepEqual(log, ['start', 'stop'])

  log.length = 0
  hold.keyDown()
  hold.keyUp() // released before the delay: a tap
  t.fire()
  assert.deepEqual(log, [], 'a tap never starts')

  hold.keyDown()
  hold.otherKey() // ⌥ + a key: a modifier, not a hold
  t.fire()
  hold.keyUp()
  assert.deepEqual(log, [], 'a combination never starts')

  hold.keyDown()
  t.fire()
  hold.reset() // Escape cancelled while the key was down
  hold.keyUp()
  assert.deepEqual(log, ['start'], 'after a reset the release does not stop again')
})

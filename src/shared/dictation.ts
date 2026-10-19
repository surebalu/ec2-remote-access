/**
 * Pure parts of voice dictation, shared by main (reading the helper's output) and the renderer (fitting the words
 * into the text around the cursor, the hold-to-talk key). No DOM or Node imports, so tests/dictation.test.ts runs it
 * directly.
 */
import type { DictationKey, VoiceEvent, VoicePermission, VoiceStatus } from './types'

/* ---------- the helper's output (native/dictation/main.swift) ---------- */

const PERMISSIONS: VoicePermission[] = ['authorized', 'denied', 'restricted', 'notDetermined', 'unknown']
const permission = (v: unknown): VoicePermission => (PERMISSIONS.includes(v as VoicePermission) ? (v as VoicePermission) : 'unknown')

/** One JSON line of a dictation as an event (without the id main adds); null for anything else or garbage. */
export function parseHelperLine(line: string): Omit<VoiceEvent, 'id'> | null {
  let m: Record<string, unknown>
  try {
    const v: unknown = JSON.parse(line)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    m = v as Record<string, unknown>
  } catch {
    return null
  }
  switch (m.type) {
    case 'ready': return { kind: 'ready', onDevice: m.onDevice === true }
    case 'partial':
    case 'final': return typeof m.text === 'string' ? { kind: m.type, text: m.text } : null
    case 'level': {
      const n = Number(m.level)
      return Number.isFinite(n) ? { kind: 'level', level: Math.min(1, Math.max(0, n)) } : null
    }
    case 'error': return { kind: 'error', message: typeof m.message === 'string' && m.message ? m.message : 'Dictation stopped.' }
    default: return null
  }
}

/** The `--status` report among the helper's output lines (macOS logs noise on stderr, never on stdout, but be lenient). */
export function parseStatusOutput(stdout: string): Pick<VoiceStatus, 'mic' | 'speech' | 'onDevice' | 'locale' | 'supported' | 'locales'> & { recognizerAvailable: boolean } | null {
  for (const line of stdout.split('\n').reverse()) {
    let m: Record<string, unknown>
    try { m = JSON.parse(line) as Record<string, unknown> } catch { continue }
    if (!m || m.type !== 'status') continue
    return {
      mic: permission(m.mic),
      speech: permission(m.speech),
      onDevice: m.onDevice === true,
      locale: typeof m.locale === 'string' ? m.locale : '',
      supported: m.supported !== false,
      recognizerAvailable: m.available !== false,
      locales: Array.isArray(m.locales) ? m.locales.filter((x): x is string => typeof x === 'string') : []
    }
  }
  return null
}

/* ---------- fitting dictated text into what is already there ---------- */

/** Straight double quotes before the cursor: an odd count means one is open, so the words go right after it. */
const insideQuote = (before: string): boolean => (before.match(/"/g)?.length ?? 0) % 2 === 1

/** A space between the text before the cursor and the dictated words, unless one is there or punctuation opens. */
export function leadingSpace(before: string, text: string): string {
  if (!before || !text) return ''
  if (/\s$/.test(before) || /[([{“‘«¿¡/]$/.test(before)) return ''
  if (before.endsWith('"') && insideQuote(before)) return ''
  if (/^[\s.,;:!?…)\]}”’»%]/.test(text)) return ''
  return ' '
}

/** "I", "I'm", "I've"… stay capitalised wherever they land. */
const ALWAYS_CAPITAL = /^I(?:['’](?:m|ve|ll|d))?$/

/**
 * The recognizer capitalises the start of everything it hears. Starting a sentence (an empty field, after . ? ! or a
 * new line) keeps or adds the capital; continuing one (after a letter, digit or comma) lowers a plainly capitalised
 * first word ("Restart" → "restart", but not "AWS", "iPhone" or "I"). After anything else (a prompt's ">", a colon)
 * the words are left as heard.
 */
export function fitCase(before: string, text: string): string {
  if (!text) return text
  const prev = before.replace(/[ \t]+$/, '')
  if (!prev || /\n$/.test(prev) || /[.?!…]["'”’)\]]*$/.test(prev)) return text.charAt(0).toLocaleUpperCase() + text.slice(1)
  if (/[\p{Ll}\p{N},;]$/u.test(prev)) {
    const word = text.match(/^\p{L}[\p{L}'’]*/u)?.[0] ?? ''
    if (word.length > 1 && /^\p{Lu}[\p{Ll}'’]+$/u.test(word) && !ALWAYS_CAPITAL.test(word)) return word.charAt(0).toLocaleLowerCase() + text.slice(1)
  }
  return text
}

/**
 * What to insert for dictated `text` between `before` and `after` (the text around the cursor): a leading space when
 * needed, the case fitted to the sentence, and a trailing space when a word follows straight after.
 */
export function fitDictation(before: string, text: string, after = ''): string {
  const t = text.trim()
  if (!t) return ''
  const tail = /^[\p{L}\p{N}]/u.test(after) ? ' ' : ''
  return leadingSpace(before, t) + fitCase(before, t) + tail
}

/** The end of a long transcript for the HUD: the last `max` characters, starting at a word, after an ellipsis. */
export function transcriptTail(text: string, max = 120): string {
  if (text.length <= max) return text
  const cut = text.slice(-max)
  const space = cut.indexOf(' ')
  return `…${space > 0 && space < 24 ? cut.slice(space + 1) : cut}`
}

/* ---------- the hold-to-talk key ---------- */

/** Whether a key event is the configured dictation key ('Fn' only shows up when Chromium reports it). */
export function isDictationKey(e: { code?: string; key?: string }, setting: DictationKey | undefined): boolean {
  const k = setting ?? 'AltRight'
  if (k === 'off') return false
  if (k === 'Fn') return e.key === 'Fn' || e.code === 'Fn'
  return e.code === k
}

/** Human name of a dictation key for hints ("Hold Right ⌥ to talk"). */
export function dictationKeyLabel(setting: DictationKey | undefined): string {
  switch (setting ?? 'AltRight') {
    case 'AltRight': return 'Right ⌥'
    case 'MetaRight': return 'Right ⌘'
    case 'Fn': return 'Fn'
    default: return ''
  }
}

export interface HoldTimers {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

/**
 * Push-to-talk on a modifier held by itself: holding it for `delayMs` starts dictation and releasing it stops; any
 * other key pressed while it is down (an ⌥ combination, typing) cancels the hold before it starts, so the key keeps
 * working as a modifier. Feed it key events; it calls back `start` and `stop`.
 */
export class HoldToTalk {
  timer: unknown = null
  holding = false
  /** The key is down and dictation started from it. */
  talking = false
  // A plain field rather than a parameter property: tests run this file with Node's type stripping.
  opts: { delayMs: number; start: () => void; stop: () => void; timers: HoldTimers }

  constructor(opts: { delayMs: number; start: () => void; stop: () => void; timers: HoldTimers }) {
    this.opts = opts
  }

  /** The dictation key went down (auto-repeats are ignored). */
  keyDown(repeat = false): void {
    if (repeat || this.holding) return
    this.holding = true
    this.timer = this.opts.timers.set(() => {
      this.timer = null
      if (!this.holding) return
      this.talking = true
      this.opts.start()
    }, this.opts.delayMs)
  }

  /** The dictation key came up (or the window lost the keyboard while it was down). */
  keyUp(): void {
    this.holding = false
    this.clearTimer()
    if (this.talking) {
      this.talking = false
      this.opts.stop()
    }
  }

  /** Another key went down. Before dictation starts that makes the key a modifier again; while talking it is ignored. */
  otherKey(): void {
    if (!this.holding || this.talking) return
    this.holding = false
    this.clearTimer()
  }

  /** Dictation ended some other way (Escape, an error) while the key was still down: wait for it to come up. */
  reset(): void {
    this.talking = false
    this.clearTimer()
  }

  clearTimer(): void {
    if (this.timer !== null) this.opts.timers.clear(this.timer)
    this.timer = null
  }
}

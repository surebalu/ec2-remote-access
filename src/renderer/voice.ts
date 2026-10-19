/**
 * Voice dictation in the renderer: talk wherever you would type. Hold the dictation key (Right Option by default) or
 * press a mic button; what you say goes into the field that has the keyboard, as you say it where the field can show
 * that (text fields, the Notes editor) and as one piece at the end where it cannot (terminals, remote desktops, web
 * pages). Recognition runs in the main process (voice.ts, the native helper); this module picks the target, writes
 * the words, and keeps the HUD's state.
 *
 * Contract with mic buttons anywhere in the app (the Terminal's bottom bar has one):
 *   window 'ec2ra:dictate'   detail { action: 'toggle' | 'start' | 'stop' | 'cancel', target?: Element }
 *   window 'ec2ra:dictation' detail { active: boolean }   whenever a dictation starts or ends
 * A button must not take the focus (onMouseDown preventDefault): without `target` the words go to the editable that
 * last had it. With `target` they go to that element, its registered ancestor, or the text field or registered
 * target inside it.
 */
import { useSyncExternalStore } from 'react'
import type { Terminal } from '@xterm/xterm'
import type { EditorView } from '@codemirror/view'
import { Transaction } from '@codemirror/state'
import { fitDictation, HoldToTalk, isDictationKey } from '@shared/dictation'
import { useStore } from './store'
import { isMobile } from './mobile'

/** Only the Mac app dictates: a phone or tablet has its keyboard's own dictation key, and the gateway refuses voice:*. */
export const CAN_DICTATE = /\bElectron\//.test(navigator.userAgent) && !isMobile()

/* ---------- where the words go ---------- */

/** One dictation into a live target: each `update` replaces the previous one's words; `finish` keeps the last. */
export interface DictationWriter {
  update(text: string): void
  finish(text: string): void
  cancel(): void
}

/**
 * Something other than a text field that takes dictation. `insert` targets get the final text once (terminals,
 * desktops, pages); `before` lets the words be spaced and cased against what precedes the cursor. Live targets (an
 * editor) write as the words come.
 */
export type DictationTarget =
  | { label?: string; live?: false; insert(text: string): void; before?(): string }
  | { label?: string; live: true; begin(): DictationWriter }

const registry = new WeakMap<Element, DictationTarget>()
const MARK = 'data-dictation-target'

/** Makes `el` (and what is inside it) a dictation target. Returns an unregister function; a removed element just drops out. */
export function registerDictationTarget(el: Element, target: DictationTarget): () => void {
  registry.set(el, target)
  el.setAttribute(MARK, '')
  return () => {
    if (registry.get(el) !== target) return
    registry.delete(el)
    el.removeAttribute(MARK)
  }
}

/** An xterm.js terminal: the words go in as one paste (bracketed when the program asked for it), never with Enter. */
export function xtermTarget(term: Terminal, label = 'Terminal'): DictationTarget {
  return {
    label,
    insert: (text) => { if (text) term.paste(text) },
    // The cursor's line up to the cursor: "$ " or "> fix the" decides the space and the case.
    before: () => {
      const b = term.buffer.active
      return b.getLine(b.baseY + b.cursorY)?.translateToString(false, 0, b.cursorX) ?? ''
    }
  }
}

const NO_WRITER: DictationWriter = { update: () => undefined, finish: () => undefined, cancel: () => undefined }

/** A CodeMirror editor (Notes): the words appear as they are recognised and the finished text is one undo step. */
export function codeMirrorTarget(getView: () => EditorView | null, label = 'Note'): DictationTarget {
  return {
    label,
    live: true,
    begin() {
      const view = getView()
      if (!view) return NO_WRITER
      const sel = view.state.selection.main
      let from = sel.from
      // The selection the words replace (put back on cancel), and what occupies [from, from + shown.length) now.
      let original = view.state.sliceDoc(sel.from, sel.to)
      let shown = original
      const put = (insert: string, history: boolean): void => {
        // Typing elsewhere moved the text; if what is there is no longer ours, carry on at the cursor.
        if (view.state.sliceDoc(from, from + shown.length) !== shown) { from = view.state.selection.main.head; original = ''; shown = '' }
        view.dispatch({
          changes: { from, to: from + shown.length, insert },
          selection: { anchor: from + insert.length },
          scrollIntoView: true,
          userEvent: 'input.dictation',
          // Partial transcripts stay out of the undo history; the final text goes in as one step.
          annotations: Transaction.addToHistory.of(history)
        })
        shown = insert
      }
      const fitted = (text: string): string => fitDictation(view.state.sliceDoc(Math.max(0, from - 200), from), text, view.state.sliceDoc(from + shown.length, from + shown.length + 1))
      return {
        update: (text) => put(text.trim() ? fitted(text) : original, false),
        finish: (text) => {
          put(original, false)
          if (text.trim()) put(fitted(text), true)
        },
        cancel: () => put(original, false)
      }
    }
  }
}

const TEXT_INPUTS = new Set(['', 'text', 'search', 'url', 'tel', 'email'])

function isTextField(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled
  if (el instanceof HTMLInputElement) return TEXT_INPUTS.has(el.type) && !el.readOnly && !el.disabled
  return false
}

function registeredFrom(el: Element | null): { el: Element; target: DictationTarget } | null {
  for (let e = el; e; e = e.parentElement ?? ((e.getRootNode() as ShadowRoot).host ?? null)) {
    const t = registry.get(e)
    if (t) return { el: e, target: t }
  }
  return null
}

const shown = (el: Element): boolean => el.getClientRects().length > 0

/**
 * The text field, or registered target, a dictation should write into, starting from an element the user pointed at.
 * A registered target wins over a text field inside it: xterm's own hidden textarea has the focus in a terminal, and
 * the words must go to the shell as a paste, not through that textarea.
 */
function findTarget(start: Element | null, searchInside: boolean): Element | null {
  if (!start || !start.isConnected) return null
  if (registeredFrom(start) || isTextField(start)) return start
  if (!searchInside) return null
  const field = [...start.querySelectorAll('textarea, input')].find((x) => isTextField(x) && shown(x) && !registeredFrom(x))
  if (field) return field
  return [...start.querySelectorAll(`[${MARK}]`)].find(shown) ?? null
}

/** How the HUD names a field ("into Search hosts"). */
const fieldLabel = (el: HTMLInputElement | HTMLTextAreaElement): string => el.getAttribute('aria-label') || el.placeholder || el.title || 'text field'

/** A live writer for <input>/<textarea>: partials replace each other; the final text is one undoable insertText. */
function fieldWriter(el: HTMLInputElement | HTMLTextAreaElement): DictationWriter {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setValue = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  const caret = (): [number, number] => {
    try { return [el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length] } catch { return [el.value.length, el.value.length] }
  }
  const [selFrom, selTo] = caret()
  let from = selFrom
  // The selection the words replace (put back on cancel), and what occupies [from, from + shownText.length) now.
  let original = el.value.slice(selFrom, selTo)
  let shownText = original
  const select = (a: number, b: number): void => { try { el.setSelectionRange(a, b) } catch { /* email fields have no selection API */ } }
  /** Sets the value directly (React sees it through the input event); used for partials so undo skips them. */
  const replaceQuietly = (insert: string): void => {
    if (insert === shownText) return
    const v = el.value
    setValue.call(el, v.slice(0, from) + insert + v.slice(from + shownText.length))
    el.dispatchEvent(new Event('input', { bubbles: true }))
    shownText = insert
    select(from + insert.length, from + insert.length)
  }
  // Typing while talking moves the text; if what is there is no longer ours, carry on at the cursor.
  const rebase = (): void => {
    if (el.value.slice(from, from + shownText.length) === shownText) return
    from = caret()[0]
    original = ''
    shownText = ''
  }
  const fitted = (text: string): string => fitDictation(el.value.slice(Math.max(0, from - 200), from), text, el.value.slice(from + shownText.length, from + shownText.length + 1))
  return {
    update(text) {
      rebase()
      replaceQuietly(text.trim() ? fitted(text) : original)
    },
    finish(text) {
      rebase()
      replaceQuietly(original)
      if (!text.trim()) return
      const insert = fitted(text)
      // As if typed: one undo step, and the input events every framework listens to.
      if (document.activeElement === el) {
        select(from, from + original.length)
        if (document.execCommand('insertText', false, insert)) return
      }
      replaceQuietly(insert)
    },
    cancel() {
      rebase()
      replaceQuietly(original)
    }
  }
}

interface Resolved {
  /** For the HUD: where the words go. */
  label: string
  writer: DictationWriter
}

function resolve(el: Element | null): Resolved | null {
  if (!el) return null
  const reg = registeredFrom(el)
  if (!reg) return isTextField(el) ? { label: fieldLabel(el), writer: fieldWriter(el) } : null
  const t = reg.target
  if (t.live) return { label: t.label ?? 'editor', writer: t.begin() }
  // Final text only: the HUD shows the words meanwhile.
  let done = false
  return {
    label: t.label ?? 'focused item',
    writer: {
      update: () => undefined,
      finish: (text) => {
        if (done || !text.trim()) return
        done = true
        t.insert(fitDictation(t.before?.() ?? '', text))
      },
      cancel: () => { done = true }
    }
  }
}

/* ---------- the controller ---------- */

export type VoicePhase = 'starting' | 'listening' | 'finishing' | 'error'

export interface VoiceState {
  phase: VoicePhase
  /** How it was started: held key (release to insert) or a mic button / toggle (press again to insert). */
  via: 'hold' | 'toggle'
  text: string
  /** Recent microphone levels, oldest first, for the waveform. */
  levels: number[]
  onDevice?: boolean
  /** What the words go into ("Search hosts", "Terminal"), or null when nothing can take them (they are copied). */
  into: string | null
  error?: string
  /** The error is a permission that System Settings can turn on: the HUD offers to open that pane. */
  privacy?: 'microphone' | 'speech'
}

const LEVEL_BARS = 20
let state: VoiceState | null = null
const listeners = new Set<() => void>()
/** Listening (or about to); an error still on screen is not. What `ec2ra:dictation` reports to mic buttons. */
const isActive = (s: VoiceState | null): boolean => !!s && s.phase !== 'error'
const publish = (next: VoiceState | null): void => {
  const was = isActive(state)
  state = next
  for (const l of listeners) l()
  if (was !== isActive(next)) window.dispatchEvent(new CustomEvent('ec2ra:dictation', { detail: { active: isActive(next) } }))
}

/** The dictation in progress, for the HUD and mic buttons. */
export function useVoice(): VoiceState | null {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => state, () => null)
}

let session: { id: string; target: Resolved | null; started: boolean; stopWanted: boolean; finished: boolean; heard: boolean } | null = null
/** The last editable (or registered target) that had the focus: a mic button click must not lose it. */
let lastFocused: Element | null = null
let closeTimer: ReturnType<typeof setTimeout> | undefined

const newId = (): string => `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

async function start(via: 'hold' | 'toggle', hint?: Element | null): Promise<void> {
  if (!CAN_DICTATE || session) return
  clearTimeout(closeTimer)
  const active = document.activeElement
  const el = hint ? findTarget(hint, true) : findTarget(active, false) ?? (lastFocused?.isConnected ? findTarget(lastFocused, false) : null)
  const target = resolve(el)
  const id = newId()
  session = { id, target, started: false, stopWanted: false, finished: false, heard: false }
  publish({ phase: 'starting', via, text: '', levels: [], into: target?.label ?? null })
  const locale = useStore.getState().settings?.dictationLocale || undefined
  try {
    await window.api.invoke('voice:start', { id, locale })
  } catch (e) {
    if (session?.id === id) fail((e as Error).message)
    return
  }
  // Cancelled (Escape) while the helper was starting: it is running now, so end it.
  if (session?.id !== id) { void window.api.invoke('voice:cancel', id).catch(() => undefined); return }
  session.started = true
  if (session.stopWanted) void stop()
}

function fail(raw: string): void {
  session?.target?.writer.cancel()
  session = null
  hold.reset()
  // Electron's wrapper text, should a caller's preload not have removed it.
  const message = raw.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '')
  const privacy = /Privacy & Security → Microphone/.test(message) ? 'microphone' : /Privacy & Security → Speech Recognition/.test(message) ? 'speech' : undefined
  publish(state ? { ...state, phase: 'error', error: message, privacy } : null)
  clearTimeout(closeTimer)
  closeTimer = setTimeout(() => publish(null), privacy ? 10_000 : 6000)
}

async function stop(): Promise<void> {
  const s = session
  if (!s) return
  if (!s.started) { s.stopWanted = true; return }
  if (state) publish({ ...state, phase: 'finishing' })
  await window.api.invoke('voice:stop', s.id).catch(() => undefined)
}

function cancel(): void {
  const s = session
  if (!s) { if (state?.phase === 'error') publish(null); return }
  session = null
  hold.reset()
  s.target?.writer.cancel()
  // Not started yet: start() ends the helper once voice:start returns.
  if (s.started) void window.api.invoke('voice:cancel', s.id).catch(() => undefined)
  publish(null)
}

function onFinal(text: string): void {
  const s = session
  if (!s || s.finished) return
  s.finished = true
  if (s.target) s.target.writer.finish(text)
  else if (text.trim()) {
    // Nothing could take the words (no field had the keyboard): keep them on the clipboard instead of losing them.
    void window.api.invoke('clipboard:write', text.trim()).then(() => useStore.getState().toast('info', 'Nothing to type into, so the dictation was copied to the clipboard.'), () => undefined)
  }
}

function onEvent(ev: { id: string; kind: string; text?: string; level?: number; message?: string; onDevice?: boolean }): void {
  const s = session
  if (!s || ev.id !== s.id || !state) return
  switch (ev.kind) {
    case 'ready':
      publish({ ...state, phase: state.phase === 'finishing' ? 'finishing' : 'listening', onDevice: ev.onDevice })
      break
    case 'level':
      publish({ ...state, levels: [...state.levels, ev.level ?? 0].slice(-LEVEL_BARS) })
      break
    case 'partial':
      s.heard = true
      if (!s.finished) s.target?.writer.update(ev.text ?? '')
      publish({ ...state, text: ev.text ?? '' })
      break
    case 'final':
      publish({ ...state, text: ev.text ?? '' })
      onFinal(ev.text ?? '')
      break
    case 'error':
      if (!s.finished) fail(ev.message ?? 'Dictation stopped.')
      break
    case 'end':
      if (!s.finished) s.target?.writer.cancel()
      session = null
      hold.reset()
      publish(null)
      break
  }
}

const hold = new HoldToTalk({
  delayMs: 200,
  start: () => void start('hold'),
  stop: () => void stop(),
  timers: { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }
})

/** Handled for the HUD's buttons and the mic buttons' event. */
export const voice = {
  toggle: (target?: Element | null): void => { if (session) void stop(); else void start('toggle', target) },
  stop: (): void => void stop(),
  cancel
}

const dictationKey = () => useStore.getState().settings?.dictationKey ?? 'AltRight'
const inRemoteDesktop = (t: EventTarget | null): boolean => t instanceof Element && !!t.closest('iron-remote-desktop')

let installed = false

/** Wires up the key, the mic-button events and the main-process events. Once, from App. */
export function installVoice(): void {
  if (installed || !CAN_DICTATE) return
  installed = true

  document.addEventListener('focusin', (e) => {
    const t = e.target as Element | null
    if (t && (registeredFrom(t) || isTextField(t))) lastFocused = t
  })

  // Window capture runs before every other key handler (Modal and Popover listen on document, the remote desktop on
  // window), so Escape cancels a dictation instead of closing the dialog under it.
  window.addEventListener('keydown', (e) => {
    if ((session || state?.phase === 'error') && e.key === 'Escape') {
      e.preventDefault()
      e.stopImmediatePropagation()
      cancel()
      return
    }
    const key = dictationKey()
    if (!isDictationKey(e, key)) { hold.otherKey(); return }
    const otherMods = e.shiftKey || e.ctrlKey || (key === 'AltRight' ? e.metaKey : key === 'MetaRight' ? e.altKey : e.metaKey || e.altKey)
    if (otherMods) { hold.otherKey(); return }
    hold.keyDown(e.repeat)
    // A remote desktop would see a lone Alt tap and open the Windows menu bar; the key is dictation's there.
    if (inRemoteDesktop(e.target)) e.stopImmediatePropagation()
  }, true)
  window.addEventListener('keyup', (e) => {
    if (!isDictationKey(e, dictationKey())) return
    hold.keyUp()
    if (inRemoteDesktop(e.target)) e.stopImmediatePropagation()
  }, true)
  // ⌥-click (a column selection, say) is not a hold to talk; a click once talking with nothing heard yet calls it off.
  window.addEventListener('pointerdown', (e) => {
    if ((e.target as Element | null)?.closest?.('.voice-hud')) return
    hold.otherKey()
    if (hold.talking && session && !session.heard) cancel()
  }, true)
  window.addEventListener('blur', () => hold.keyUp())

  window.addEventListener('ec2ra:dictate', (e) => {
    const d = ((e as CustomEvent).detail ?? {}) as { action?: string; target?: unknown }
    const target = d.target instanceof Element ? d.target : null
    if (d.action === 'toggle') voice.toggle(target)
    else if (d.action === 'start') void start('toggle', target)
    else if (d.action === 'stop') void stop()
    else if (d.action === 'cancel') cancel()
  })

  window.api.on('voice:event', onEvent)
  // A browser page has the keyboard: main forwards the dictation key, since the page would swallow it.
  window.api.on('voice:key', (k) => {
    if (k.key === 'dictation') { if (k.down) hold.keyDown(false); else hold.keyUp() }
    else if (k.key === 'other') hold.otherKey()
    else if (k.key === 'escape') cancel()
  })
}

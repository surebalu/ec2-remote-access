import type { ReactElement } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { suggestFromHistory } from '@shared/termIntegration'
import { matchesWords } from '@shared/browser'
import { Icon } from '../icons'
import { history } from './history'

/** Asked of the input box from outside (the ribbon): search history, or put a workflow's command in it. */
export type DockRequest = { n: number } & ({ kind: 'search' } | { kind: 'insert'; text: string })

const elapsed = (ms: number): string => {
  const s = Math.floor(ms / 1000)
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

/**
 * Above a pane's ribbon, as in Warp: while the shell waits at its prompt, an input box (multi-line editing, history
 * on ↑/↓, a suggestion from history to accept with →, ⌃R to search history) whose Enter sends the line to the
 * shell; Tab hands the line to the shell for its own completion, ⌃G switches to typing straight into the shell.
 * While a command runs, a bar with its name and time, and the keyboard goes to the program.
 */
export default function InputDock({ mode, running, onRun, onHandoff, onKey, onToggleInput, request, onRequestDone, focusKey, fontFamily }: {
  mode: 'editor' | 'running'
  running: { command: string; startedAt: number } | null
  onRun: (text: string) => void
  onHandoff: (text: string) => void
  /** A control key for the shell (⌃C, ⌃D, ⌃L) pressed in the empty input box. */
  onKey: (data: string) => void
  /** ⌃G: type straight into the shell instead. */
  onToggleInput: () => void
  request: DockRequest | null
  /** The request was carried out (so the box does not repeat it when it comes back after a command). */
  onRequestDone: () => void
  /** Changing it puts the keyboard in the input box. */
  focusKey: number
  fontFamily: string
}): ReactElement {
  const [text, setText] = useState('')
  const [histAt, setHistAt] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [search, setSearch] = useState<string | null>(null)
  const [searchSel, setSearchSel] = useState(0)
  const [, tick] = useState(0)
  const area = useRef<HTMLTextAreaElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (mode === 'editor') area.current?.focus()
  }, [mode, focusKey])
  useEffect(() => {
    if (!request || mode !== 'editor') return
    onRequestDone()
    if (request.kind === 'search') setSearch('')
    else {
      setText(request.text)
      setHistAt(null)
      setTimeout(() => { const a = area.current; if (a) { a.focus(); a.setSelectionRange(a.value.length, a.value.length) } }, 0)
    }
  }, [request]) // eslint-disable-line react-hooks/exhaustive-deps
  // The running bar's clock.
  useEffect(() => {
    if (mode !== 'running') return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [mode])

  const suggestion = useMemo(() => {
    const caretAtEnd = !area.current || area.current.selectionStart === text.length
    return caretAtEnd ? suggestFromHistory(history(), text) : null
  }, [text])
  const lines = Math.min(8, text.split('\n').length)

  const run = (value: string): void => {
    setText('')
    setHistAt(null)
    onRun(value)
  }
  const recall = (step: number): boolean => {
    const h = history()
    if (!h.length) return false
    const at = histAt === null ? h.length : histAt
    const next = Math.max(0, Math.min(h.length, at + step))
    if (next === at) return false
    if (histAt === null) setDraft(text)
    setHistAt(next === h.length ? null : next)
    setText(next === h.length ? draft : h[next])
    return true
  }

  const found = useMemo(() => {
    if (search === null) return []
    const out: string[] = []
    const h = history()
    for (let i = h.length - 1; i >= 0 && out.length < 60; i--) if (matchesWords(search, h[i])) out.push(h[i])
    return out
  }, [search])
  useEffect(() => setSearchSel(0), [search])

  if (mode === 'running' && running) {
    return (
      <div className="tdock running">
        <span className="tdock-spin" />
        <span className="tdock-run-cmd">{running.command || 'Running'}</span>
        <span className="tdock-time">{elapsed(Date.now() - running.startedAt)}</span>
        <span className="flex-1" />
        <span className="tdock-hint">Typing goes to the program</span>
        <button type="button" className="tdock-btn" title="Interrupt (⌃C)" onClick={() => onKey('\x03')}>⌃C Stop</button>
      </div>
    )
  }

  return (
    <div className="tdock" style={{ fontFamily }}>
      {search !== null && (
        <div className="tdock-pop">
          <div className="tdock-pop-head">
            <Icon.search />
            <input
              ref={searchInput}
              autoFocus
              value={search}
              placeholder="Search command history"
              aria-label="Search command history"
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setSearchSel((i) => Math.min(i + 1, found.length - 1)) }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setSearchSel((i) => Math.max(i - 1, 0)) }
                else if (e.key === 'Enter') {
                  e.preventDefault()
                  const pick = found[searchSel]
                  setSearch(null)
                  if (pick && e.metaKey) run(pick)
                  else if (pick) { setText(pick); setTimeout(() => area.current?.focus(), 0) }
                } else if (e.key === 'Escape') { e.preventDefault(); setSearch(null); area.current?.focus() }
              }}
            />
            <span className="tdock-hint">↩ insert · ⌘↩ run</span>
          </div>
          <div className="tdock-pop-list">
            {found.map((c, i) => (
              <button key={c} type="button" className={`tdock-pop-item ${i === searchSel ? 'on' : ''}`} onMouseMove={() => setSearchSel(i)} onClick={() => { setSearch(null); setText(c); setTimeout(() => area.current?.focus(), 0) }}>
                {c}
              </button>
            ))}
            {!found.length && <div className="tdock-pop-empty">No command matches.</div>}
          </div>
        </div>
      )}
      <div className="tdock-edit">
        <span className="tdock-caret">❯</span>
        <div className="tdock-field" style={{ height: `${lines * 1.5}em` }}>
          {/* The suggestion is drawn behind the text: the typed part invisible, the rest dimmed. */}
          <div className="tdock-ghost" aria-hidden>
            <span className="tdock-ghost-typed">{text}</span>
            {suggestion && <span className="tdock-ghost-rest">{suggestion.slice(text.length)}</span>}
          </div>
          <textarea
            ref={area}
            value={text}
            rows={1}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder={text ? '' : 'Type a command · ⇧↩ new line · ⌃R history · Tab: shell completion'}
            aria-label="Command input"
            onChange={(e) => { setText(e.target.value); setHistAt(null) }}
            onKeyDown={(e) => {
              const el = e.currentTarget
              const before = el.value.slice(0, el.selectionStart)
              const after = el.value.slice(el.selectionEnd)
              if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey) { e.preventDefault(); run(el.value) }
              else if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); onHandoff(el.value); setText('') }
              else if (e.key === 'ArrowUp' && !e.metaKey && !before.includes('\n')) { if (recall(-1)) e.preventDefault() }
              else if (e.key === 'ArrowDown' && !e.metaKey && !after.includes('\n')) { if (recall(1)) e.preventDefault() }
              else if ((e.key === 'ArrowRight' || e.key === 'End') && suggestion && !after) { e.preventDefault(); setText(suggestion) }
              else if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'r') { e.preventDefault(); setSearch('') }
              else if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'c') { e.preventDefault(); if (el.value) setText(''); else onKey('\x03') }
              else if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'd' && !el.value) { e.preventDefault(); onKey('\x04') }
              else if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'l') { e.preventDefault(); onKey('\x0c') }
              else if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'g') { e.preventDefault(); onToggleInput() }
            }}
          />
        </div>
      </div>
    </div>
  )
}

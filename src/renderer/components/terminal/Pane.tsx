import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import { useEffect, useReducer, useRef, useState } from 'react'
import { Terminal, type IMarker } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { parseMark, parseOsc7, type ShellMark } from '@shared/termIntegration'
import { isDarkMode, useStore } from '../../store'
import { resolveTerminalTheme, terminalBackdrop, terminalFontFamily, DEFAULT_TERMINAL_FONT_SIZE } from '../../terminalThemes'
import { effectiveScheme } from '../../appThemes'
import { Icon } from '../icons'
import type { Snippet } from '@shared/types'
import InputDock, { type DockRequest } from './InputDock'
import Ribbon from './Ribbon'
import { useGitStatus } from './useGitStatus'
import KeyBar from '../mobile/KeyBar'
import { isMobile, pasteFromClipboard, useKeyboardOpen } from '../../mobile'
import { registerDictationTarget, xtermTarget } from '../../voice'
import { applyStickyMods, keySequence, type StickyMods } from '../../terminalKeys'
import { addHistory, loadHistory } from './history'
import { sectionOfKey } from '../../shortcuts'

/** What a pane tells the Terminal tab: for titles, new tabs in the same folder, and the layout it saves. */
export interface PaneInfo {
  cwd?: string
  /** The command running in the pane, or null at the prompt. */
  running?: string | null
  /** The title the shell or program set (OSC 0/2). */
  title?: string
  /** The Git branch of the shell's folder (from the zsh integration's prompt marks); null outside a repository. */
  branch?: string | null
}

/** What the shell's prompt reported (folder, Git branch, AWS_PROFILE), for the pane's ribbon. */
interface Chips {
  cwd?: string
  git?: string
  aws?: string
}

/** What the Terminal tab can ask of a pane (shortcuts act on the focused one). */
export interface PaneApi {
  focus: () => void
  find: () => void
  jump: (step: 1 | -1) => void
  clear: () => void
}

/** A command and its output, between the shell's markers (see src/shared/termIntegration.ts). */
interface Block {
  id: number
  prompt: IMarker
  output?: IMarker
  end?: IMarker
  command: string
  exit?: number
  startedAt?: number
  endedAt?: number
}

const NO_MODS: StickyMods = { ctrl: false, alt: false }
const MAX_BLOCKS = 400
const NOTIFY_AFTER_MS = 10_000
const RUNNING_BAR_AFTER_MS = 300

const duration = (ms: number): string => (ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`)

let blockSeq = 0

export default function Pane({ id, cwd, env, visible, focused, multi, inputMode, notify, home, onFocus, onInfo, onExit, onReveal, onNewTab, onToggleInput, registerApi }: {
  id: string
  cwd?: string
  env?: Record<string, string>
  visible: boolean
  focused: boolean
  multi: boolean
  inputMode: 'editor' | 'shell'
  notify: boolean
  home?: string
  onFocus: () => void
  onInfo: (id: string, info: PaneInfo) => void
  onExit: (id: string) => void
  /** Brings this pane to the front (a notification was clicked). */
  onReveal: () => void
  /** A new Terminal tab, in this pane's folder (the ribbon's +). */
  onNewTab: (cwd?: string) => void
  /** Input box or straight into the shell, for every pane (the ribbon's Rich input, ⌃G at the prompt). */
  onToggleInput: () => void
  registerApi: (id: string, api: PaneApi | null) => void
}): ReactElement {
  const settings = useStore((s) => s.settings)
  const toast = useStore((s) => s.toast)
  const host = useRef<HTMLDivElement>(null)
  const area = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const blocks = useRef<Block[]>([])
  const pendingCommand = useRef<string | null>(null)
  const opened = useRef(false)

  const [integration, setIntegration] = useState<boolean | null>(null)
  const [phase, setPhase] = useState<'starting' | 'idle' | 'running'>('starting')
  const [alt, setAlt] = useState(false)
  const [handoff, setHandoff] = useState(false)
  const [chips, setChips] = useState<Chips>({ cwd })
  const [running, setRunning] = useState<{ command: string; startedAt: number } | null>(null)
  const [showRunning, setShowRunning] = useState(false)
  const [hover, setHover] = useState<number | null>(null)
  const [findText, setFindText] = useState<string | null>(null)
  const [focusKey, setFocusKey] = useState(0)
  const [dockRequest, setDockRequest] = useState<DockRequest | null>(null)
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  // On a phone: the key bar (Esc, Ctrl, arrows…) for typing into a running program; Ctrl/Alt shape the next key.
  const mobile = isMobile()
  const keyboardOpen = useKeyboardOpen()
  const [mods, setModsState] = useState<StickyMods>(NO_MODS)
  const modsRef = useRef<StickyMods>(NO_MODS)
  const setMods = (m: StickyMods): void => { modsRef.current = m; setModsState(m) }

  const props = useRef({ visible, notify, onInfo, onExit, onReveal, inputMode, onToggleInput })
  props.current = { visible, notify, onInfo, onExit, onReveal, inputMode, onToggleInput }
  // On a phone the ribbon steps aside while the keyboard is up, so the key bar sits right on top of it.
  const ribbon = !(mobile && keyboardOpen)

  const editorActive = inputMode === 'editor' && integration === true && phase === 'idle' && !alt && !handoff
  const dockMode: 'editor' | 'running' | null = alt ? null : editorActive ? 'editor' : integration && phase === 'running' && showRunning && !handoff ? 'running' : null
  // ⌃G switches between the input box and the shell only while the shell waits at its prompt; otherwise it is the
  // program's key (BEL, or an editor's command).
  const atPrompt = integration === true && phase === 'idle' && !alt
  const git = useGitStatus(chips.cwd, chips.git, visible, phase === 'idle')

  // "Match app" follows the app's colour theme when one is chosen.
  const scheme = effectiveScheme(settings?.terminalTheme, settings?.colorTheme)
  const theme = resolveTerminalTheme(scheme, isDarkMode())
  const fontFamily = terminalFontFamily(settings?.terminalFont)

  // ----- the terminal and its shell -----
  useEffect(() => {
    const el = host.current!
    const term = new Terminal({
      cursorBlink: true,
      fontFamily,
      fontSize: settings?.terminalFontSize ?? DEFAULT_TERMINAL_FONT_SIZE,
      scrollback: 20_000,
      allowProposedApi: true,
      theme
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    // Links open in the app's own browser.
    term.loadAddon(new WebLinksAddon((_e, uri) => useStore.getState().openBrowser({ url: uri })))
    term.open(el)
    registerDictationTarget(el, xtermTarget(term))
    // ⌘ combinations are the app's (tabs, panes, blocks), as are ⌃Tab and the rail sections' shortcuts (⌃` for this
    // tab); none of them are for the shell.
    term.attachCustomKeyEventHandler((e) => !(e.metaKey || (e.ctrlKey && e.key === 'Tab') || sectionOfKey(e)))
    termRef.current = term
    fitRef.current = fit
    searchRef.current = search

    const mark = (m: ShellMark): void => {
      if (!m) return
      const list = blocks.current
      const cur = list.at(-1)
      if (m.kind === 'prompt') {
        setIntegration(true)
        if (cur?.output && !cur.end) cur.end = term.registerMarker(0)
        const marker = term.registerMarker(0)
        if (marker) list.push({ id: ++blockSeq, prompt: marker, command: '' })
        while (list.length > MAX_BLOCKS) {
          const old = list.shift()!
          old.prompt.dispose()
          old.output?.dispose()
          old.end?.dispose()
        }
        setPhase('idle')
        setHandoff(false)
        setRunning(null)
        props.current.onInfo(id, { running: null })
      } else if (m.kind === 'command') {
        pendingCommand.current = m.text
      } else if (m.kind === 'output') {
        if (!cur) return
        cur.output = term.registerMarker(0)
        cur.command = pendingCommand.current ?? cur.command
        pendingCommand.current = null
        cur.startedAt = Date.now()
        setPhase('running')
        setRunning({ command: cur.command, startedAt: cur.startedAt })
        props.current.onInfo(id, { running: cur.command })
      } else if (m.kind === 'done') {
        if (!cur?.output) return
        cur.end = term.registerMarker(0)
        cur.exit = m.exit
        cur.endedAt = Date.now()
        const took = cur.endedAt - (cur.startedAt ?? cur.endedAt)
        const away = document.hidden || !document.hasFocus() || !props.current.visible
        if (props.current.notify && took >= NOTIFY_AFTER_MS && away && 'Notification' in window) {
          const n = new Notification(m.exit === 0 ? 'Command finished' : `Command failed (exit ${m.exit})`, { body: `${cur.command}\n${duration(took)}` })
          n.onclick = () => { window.focus(); props.current.onReveal() }
        }
      } else if (m.kind === 'prop') {
        if (m.key === 'Git') {
          setChips((c) => ({ ...c, git: m.value || undefined }))
          props.current.onInfo(id, { branch: m.value || null })
        }
        else if (m.key === 'Aws') setChips((c) => ({ ...c, aws: m.value || undefined }))
      }
      redraw()
    }
    term.parser.registerOscHandler(133, (data) => { mark(parseMark(133, data)); return true })
    term.parser.registerOscHandler(633, (data) => { mark(parseMark(633, data)); return true })
    term.parser.registerOscHandler(7, (data) => {
      const dir = parseOsc7(data)
      if (dir) {
        setChips((c) => ({ ...c, cwd: dir }))
        props.current.onInfo(id, { cwd: dir })
      }
      return true
    })
    const titled = (data: string): boolean => {
      props.current.onInfo(id, { title: data })
      return false
    }
    term.parser.registerOscHandler(0, titled)
    term.parser.registerOscHandler(2, titled)

    const off = window.api.on('term:event', (ev) => {
      if (ev.id !== id) return
      if (ev.type === 'data') term.write(ev.data)
      else props.current.onExit(id)
    })
    term.onData((d) => {
      const m = modsRef.current
      if (m.ctrl || m.alt) { d = applyStickyMods(d, m); setMods(NO_MODS) }
      void window.api.invoke('term:write', id, d)
    })
    term.onResize(({ cols, rows }) => { if (opened.current) void window.api.invoke('term:resize', id, cols, rows) })
    term.buffer.onBufferChange((b) => setAlt(b.type === 'alternate'))

    // Block outlines follow the text as it scrolls; redraw at most once a frame.
    let frame = 0
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; redraw() })
    }
    const offRender = term.onRender(schedule)
    const offScroll = term.onScroll(schedule)

    const start = (): void => {
      if (opened.current || !el.offsetWidth) return
      fit.fit()
      opened.current = true
      window.api.invoke('term:open', { id, cols: term.cols, rows: term.rows, cwd, env }).then(
        (info) => {
          // Without zsh's integration (another shell, or a .zshrc that starts a different one) it is a plain terminal.
          if (!info.integration) setIntegration(false)
          setTimeout(() => setIntegration((v) => (v === null ? false : v)), 6000)
          void loadHistory()
        },
        (e: Error) => {
          term.write(`\x1b[31mCould not start a shell: ${e.message}\x1b[0m\r\n`)
          setIntegration(false)
        }
      )
    }
    const ro = new ResizeObserver(() => {
      if (!el.offsetWidth || !el.offsetHeight) return
      if (!opened.current) start()
      else {
        try { fit.fit() } catch { /* not laid out */ }
      }
      schedule()
    })
    ro.observe(el)
    start()

    return () => {
      ro.disconnect()
      off()
      offRender.dispose()
      offScroll.dispose()
      if (frame) cancelAnimationFrame(frame)
      void window.api.invoke('term:close', id)
      term.dispose()
      termRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Appearance follows Settings → Terminal, like the SSH tabs.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = theme
    term.options.fontFamily = fontFamily
    term.options.fontSize = settings?.terminalFontSize ?? DEFAULT_TERMINAL_FONT_SIZE
    try { fitRef.current?.fit() } catch { /* hidden */ }
  }, [scheme, settings?.terminalFont, settings?.terminalFontSize, isDarkMode()]) // eslint-disable-line react-hooks/exhaustive-deps

  // The input box owns typing at the prompt; while a command runs (or without the box) the terminal does.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.disableStdin = editorActive
    if (!focused) return
    if (editorActive) setFocusKey((n) => n + 1)
    else term.focus()
  }, [editorActive, focused])

  // A quick command (ls) finishes before the running bar would show; only longer ones get it.
  useEffect(() => {
    if (phase !== 'running') { setShowRunning(false); return }
    const t = setTimeout(() => setShowRunning(true), RUNNING_BAR_AFTER_MS)
    return () => clearTimeout(t)
  }, [phase, running?.startedAt])
  useEffect(() => {
    if (showRunning && focused) termRef.current?.focus()
  }, [showRunning, focused])

  useEffect(() => {
    if (visible) requestAnimationFrame(() => { try { fitRef.current?.fit() } catch { /* hidden */ } })
  }, [visible])

  // ----- blocks -----
  const lineOf = (m: IMarker | undefined): number | null => (m && !m.isDisposed && m.line >= 0 ? m.line : null)
  /** Command blocks with their first and past-the-last lines (a running one ends at the cursor). */
  const spans = (): { b: Block; start: number; out: number; end: number }[] => {
    const term = termRef.current
    if (!term) return []
    const buf = term.buffer.active
    const list = blocks.current
    const out: { b: Block; start: number; out: number; end: number }[] = []
    list.forEach((b, i) => {
      const start = lineOf(b.prompt)
      const o = lineOf(b.output)
      if (start === null || o === null) return
      const next = list[i + 1] ? lineOf(list[i + 1].prompt) : null
      const end = lineOf(b.end) ?? next ?? buf.baseY + buf.cursorY + 1
      out.push({ b, start, out: o, end: Math.max(end, o) })
    })
    return out
  }
  const text = (from: number, to: number): string => {
    const buf = termRef.current!.buffer.active
    let s = ''
    for (let i = from; i < to; i++) {
      const line = buf.getLine(i)
      if (!line) break
      s += (i > from && !line.isWrapped ? '\n' : '') + line.translateToString(true)
    }
    return s.replace(/\s+$/, '')
  }
  const copy = (value: string, what: string): void => {
    void window.api.invoke('clipboard:write', value).then(() => toast('success', `${what} copied`))
  }
  const rerun = (cmd: string): void => {
    if (phase !== 'idle') { toast('info', 'Wait for the running command to finish (or stop it with ⌃C).'); return }
    runCommand(cmd)
  }
  const toNote = (cmd: string, output: string, exit?: number): void => {
    const body = `\`\`\`text\n$ ${cmd}\n${output}\n\`\`\`${exit ? `\nexit ${exit}` : ''}`
    window.api.invoke('notes:daily').then(async (path) => {
      await window.api.invoke('notes:append', path, body)
      toast('success', "Command and output added to today's note")
    }).catch((e: Error) => toast('error', e.message))
  }

  const runCommand = (value: string): void => {
    const term = termRef.current
    if (!term) return
    addHistory(value)
    pendingCommand.current = value
    if (!value.trim()) { void window.api.invoke('term:write', id, '\r'); return }
    // Bracketed paste keeps a multi-line command one edit for the shell; the shell turns it on when it supports it.
    const data = term.modes.bracketedPasteMode ? `\x1b[200~${value}\x1b[201~\r` : `${value.replace(/\n/g, '\r')}\r`
    void window.api.invoke('term:write', id, data)
  }
  const applyWorkflow = (s: Snippet): void => {
    if (editorActive) {
      if (s.run) runCommand(s.command)
      else setDockRequest({ n: Date.now(), kind: 'insert', text: s.command })
      return
    }
    const term = termRef.current
    if (!term) return
    // paste() brackets it when the shell or program asked for that, so a multi-line command stays one edit.
    term.paste(s.command)
    if (s.run) void window.api.invoke('term:write', id, '\r')
    term.focus()
  }
  const handoffToShell = (value: string): void => {
    setHandoff(true)
    void window.api.invoke('term:write', id, `${value}\t`)
  }

  // ----- what the Terminal tab can ask -----
  useEffect(() => {
    registerApi(id, {
      focus: () => {
        if (editorActive) setFocusKey((n) => n + 1)
        else termRef.current?.focus()
      },
      find: () => setFindText((t) => t ?? ''),
      jump: (step) => {
        const term = termRef.current
        if (!term) return
        const top = term.buffer.active.viewportY
        const list = spans()
        const target = step < 0 ? [...list].reverse().find((s) => s.start < top) : list.find((s) => s.start > top)
        if (target) term.scrollToLine(target.start)
        else if (step > 0) term.scrollToBottom()
      },
      clear: () => {
        termRef.current?.clear()
        redraw()
      }
    })
    return () => registerApi(id, null)
  })

  // ----- overlay geometry -----
  const term = termRef.current
  const screen = host.current?.querySelector<HTMLElement>('.xterm-screen')
  const cellH = term && screen ? screen.offsetHeight / term.rows : 0
  // Where the text grid starts inside the pane's terminal area (the overlay's coordinates).
  const top0 = screen && area.current ? screen.getBoundingClientRect().top - area.current.getBoundingClientRect().top : 0
  const viewportY = term?.buffer.active.viewportY ?? 0
  const rows = term?.rows ?? 0
  const visibleSpans = cellH ? spans().filter((s) => s.end > viewportY && s.start < viewportY + rows) : []
  const rowY = (line: number): number => top0 + (line - viewportY) * cellH
  const sticky = visibleSpans.find((s) => s.start < viewportY && s.end > viewportY + 1)
  const hovered = visibleSpans.find((s) => s.b.id === hover)

  const onMove = (e: ReactMouseEvent): void => {
    if (!term || !cellH || !area.current) return
    const r = area.current.getBoundingClientRect()
    const line = viewportY + Math.floor((e.clientY - r.top - top0) / cellH)
    const s = visibleSpans.find((x) => line >= x.start && line < x.end)
    const next = s?.b.id ?? null
    if (next !== hover) setHover(next)
  }

  return (
    <div
      className={`tpane ${focused && multi ? 'focused' : ''} ${multi && !focused ? 'dim' : ''}`}
      style={{ '--term-bg': theme.background ?? '#0d1117', '--term-backdrop': terminalBackdrop(scheme, isDarkMode()), '--term-fg': theme.foreground ?? '#e6edf3' } as CSSProperties}
      onMouseDown={onFocus}
    >
      <div
        ref={area}
        className={`tpane-term ${dockMode ? 'with-dock' : mobile ? 'with-keys' : ''} ${ribbon ? 'with-ribbon' : ''}`}
        onKeyDownCapture={(e) => {
          if (atPrompt && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'g') {
            e.preventDefault()
            e.stopPropagation()
            props.current.onToggleInput()
          }
        }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        onMouseUp={() => {
          // A click (not a selection) at the prompt goes back to the input box.
          if (editorActive && !termRef.current?.hasSelection()) setFocusKey((n) => n + 1)
        }}
      >
        <div ref={host} className="tpane-xterm" />
        <div className="tblocks" aria-hidden>
          {visibleSpans.map((s) => {
            const y = Math.max(rowY(s.start), top0)
            const h = Math.min(rowY(s.end), top0 + rows * cellH) - y
            const state = s.b.exit === undefined ? 'run' : s.b.exit === 0 ? 'ok' : 'err'
            return (
              <div key={s.b.id}>
                {s.start >= viewportY && <div className="tblock-sep" style={{ top: rowY(s.start) }} />}
                <div className={`tblock-gutter ${state}`} style={{ top: y, height: Math.max(0, h) }} />
                {s.b.id === hover && <div className="tblock-hover" style={{ top: y, height: Math.max(0, h) }} />}
              </div>
            )
          })}
        </div>
        {hovered && hovered.b.exit !== undefined && (
          <div className="tblock-bar" style={{ top: Math.max(rowY(hovered.start), top0) + 2 }} onMouseDown={(e) => e.stopPropagation()}>
            <span className={`tblock-status ${hovered.b.exit === 0 ? 'ok' : 'err'}`}>{hovered.b.exit === 0 ? '✓' : `exit ${hovered.b.exit}`} · {duration((hovered.b.endedAt ?? 0) - (hovered.b.startedAt ?? 0))}</span>
            <button type="button" title="Copy the command" onClick={() => copy(hovered.b.command, 'Command')}><Icon.terminal /></button>
            <button type="button" title="Copy the output" onClick={() => copy(text(hovered.out, hovered.end), 'Output')}><Icon.copy /></button>
            <button type="button" title="Run it again" onClick={() => rerun(hovered.b.command)}><Icon.refresh /></button>
            <button type="button" title="Add the command and output to today's note" onClick={() => toNote(hovered.b.command, text(hovered.out, hovered.end), hovered.b.exit)}><Icon.noteAdd /></button>
          </div>
        )}
        {sticky && (
          <button type="button" className="tsticky" title="Scroll to where this command started" onClick={() => termRef.current?.scrollToLine(sticky.start)}>
            <span className="tsticky-caret">❯</span>
            <span className="truncate">{sticky.b.command}</span>
            {sticky.b.exit !== undefined && <span className={`tblock-status ${sticky.b.exit === 0 ? 'ok' : 'err'}`}>{sticky.b.exit === 0 ? '✓' : `exit ${sticky.b.exit}`}</span>}
          </button>
        )}
        {findText !== null && (
          <div className="tfind" onMouseDown={(e) => e.stopPropagation()}>
            <Icon.search />
            <input
              autoFocus
              value={findText}
              placeholder="Find"
              aria-label="Find in terminal"
              onChange={(e) => { setFindText(e.target.value); if (e.target.value) searchRef.current?.findNext(e.target.value, { incremental: true }) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) searchRef.current?.findPrevious(findText); else searchRef.current?.findNext(findText) }
                else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setFindText(null); searchRef.current?.clearDecorations(); termRef.current?.focus() }
              }}
            />
            <button type="button" aria-label="Previous match" onClick={() => searchRef.current?.findPrevious(findText)}><Icon.arrowUp /></button>
            <button type="button" aria-label="Next match" onClick={() => searchRef.current?.findNext(findText)}><Icon.arrowDown /></button>
            <button type="button" aria-label="Close find" onClick={() => { setFindText(null); searchRef.current?.clearDecorations() }}><Icon.x /></button>
          </div>
        )}
      </div>
      <div className="tpane-foot">
        {mobile && !dockMode && (
          <div className="tpane-keys">
            <KeyBar
              mods={mods}
              onMods={(m) => { setMods(m); termRef.current?.focus() }}
              onKey={(k) => {
                const t = termRef.current
                if (!t) return
                const m = modsRef.current
                setMods(NO_MODS)
                void window.api.invoke('term:write', id, applyStickyMods(keySequence(k, t.modes.applicationCursorKeysMode), m))
              }}
              keyboardOpen={keyboardOpen}
              onKeyboard={() => { if (keyboardOpen) termRef.current?.blur(); else termRef.current?.focus() }}
              onPaste={() => pasteFromClipboard((text) => termRef.current?.paste(text), (text) => { if (text) termRef.current?.paste(text) })}
            />
          </div>
        )}
        {dockMode && (
          <InputDock
            mode={dockMode}
            running={running}
            fontFamily={fontFamily}
            focusKey={focusKey}
            request={dockRequest}
            onRequestDone={() => setDockRequest(null)}
            onRun={runCommand}
            onHandoff={handoffToShell}
            onKey={(d) => void window.api.invoke('term:write', id, d)}
            onToggleInput={onToggleInput}
          />
        )}
        {ribbon && (
          <Ribbon
            cwd={chips.cwd}
            home={home}
            branch={chips.git}
            aws={chips.aws}
            git={git}
            inputMode={inputMode}
            editorShowing={dockMode === 'editor'}
            onNewTab={onNewTab}
            onToggleInput={onToggleInput}
            onHistory={() => setDockRequest({ n: Date.now(), kind: 'search' })}
            onWorkflow={applyWorkflow}
            onRun={runCommand}
          />
        )}
      </div>
    </div>
  )
}

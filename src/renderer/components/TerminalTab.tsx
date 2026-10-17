import type { ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import type { DetachedShell, HostShell, Snippet } from '@shared/types'
import { isDarkMode, useStore, type Tab } from '../store'
import { resolveTerminalTheme, terminalFontFamily, DEFAULT_TERMINAL_FONT_SIZE } from '../terminalThemes'
import { isAppShortcut, onTerminalAction } from '../shortcuts'
import HostActions from './HostActions'
import TerminalAppearancePane from './TerminalAppearancePane'
import Popover, { MenuItem, MenuLabel, MenuSep } from './Popover'
import { Icon } from './icons'
import { isMobile, pasteFromClipboard, useKeyboardOpen } from '../mobile'
import KeyBar from './mobile/KeyBar'
import { applyStickyMods, keySequence, type StickyMods } from '../terminalKeys'
import Sheet, { SheetItem } from './mobile/Sheet'
import { CopySheet, PasteSheet } from './mobile/ClipboardSheets'

/** Sends keystrokes to this session, or to every connected SSH pane of the split while broadcasting. */
function writeInput(fromId: string, data: string): void {
  const st = useStore.getState()
  const targets = st.broadcastInput && st.splitGroup.includes(fromId) ? st.splitGroup : [fromId]
  for (const id of targets) {
    const t = st.tabs.find((x) => x.id === id)
    if (t?.kind === 'ssh' && t.status === 'connected') void window.api.invoke('ssh:write', id, data)
  }
}

export function snippetsFor(instanceKey: string, all: Snippet[] | undefined): Snippet[] {
  return (all ?? []).filter((x) => !x.hostKey || x.hostKey === instanceKey).sort((a, b) => Number(!!b.hostKey) - Number(!!a.hostKey) || a.name.localeCompare(b.name))
}

/** Types a snippet into a session (and every broadcast pane), each line ending in Enter as if typed. */
export function runSnippet(tabId: string, sn: Snippet): void {
  const text = sn.command.replace(/\r?\n/g, '\r')
  writeInput(tabId, sn.run ? `${text}\r` : text)
}

/** Phones get their own terminal font size, so a size that suits the Mac does not make the phone unreadable. */
const MOBILE_FONT_KEY = 'ui.mobileTerminalFontSize'
function readMobileFontSize(): number {
  try {
    const n = Number(localStorage.getItem(MOBILE_FONT_KEY))
    if (n >= 8 && n <= 24) return n
  } catch { /* storage unavailable */ }
  return 12
}
const NO_MODS: StickyMods = { ctrl: false, alt: false }

/** The buffer as plain text, with soft-wrapped rows joined back into the lines the program printed. */
function bufferText(term: Terminal): string {
  const buf = term.buffer.active
  const lines: string[] = []
  for (let n = 0; n < buf.length; n++) {
    const line = buf.getLine(n)
    if (!line) continue
    // A row that continues on the next one keeps its trailing blanks: they are part of the line.
    const text = line.translateToString(!buf.getLine(n + 1)?.isWrapped)
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text
    else lines.push(text)
  }
  while (lines.length && !lines.at(-1)) lines.pop()
  return lines.join('\n')
}

function ago(sec: number): string {
  if (sec < 90) return 'just now'
  if (sec < 5400) return `${Math.round(sec / 60)} min`
  if (sec < 172_800) return `${Math.round(sec / 3600)} h`
  return `${Math.round(sec / 86_400)} days`
}

function idleText(sec: number | null): string {
  return sec === null ? '' : `idle ${ago(sec)}`
}

/** One line about a shell in the session list: where it is shown and how long it has run. */
function shellStatus(sh: HostShell): string {
  const age = sh.ageSec !== null ? ` · started ${ago(sh.ageSec)}${sh.ageSec < 90 ? '' : ' ago'}` : ''
  if (sh.current) return `This tab${age}`
  if (sh.attached) return `Open in another tab or device${age}`
  return `Running in the background${sh.idleSec !== null ? ` · ${idleText(sh.idleSec)}` : ''}${age}`
}

/** Persistent shells on the host that no tab shows (the app quit, a phone page was lost, a Detach), offered to resume. */
function DetachedShells({ shells, mobile, onResume, onEnd, onDismiss }: { shells: DetachedShell[]; mobile: boolean; onResume: (name: string) => void; onEnd: (name: string) => void; onDismiss: () => void }): ReactElement {
  return (
    <div className={mobile ? 'm-shells' : 'shells-bar panel border-b px-2 py-1 text-[11px]'} style={mobile ? undefined : { borderColor: 'var(--border)' }}>
      <div className="flex items-center gap-1.5">
        <Icon.layers className="muted shrink-0" />
        <span className="min-w-0 flex-1">{shells.length === 1 ? 'A shell from an earlier session is still running on this host.' : `${shells.length} shells from earlier sessions are still running on this host.`} Resume replaces this new one.</span>
        <button className="btn btn-ghost btn-sm btn-icon" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}><Icon.x /></button>
      </div>
      {shells.slice(0, 5).map((d) => (
        <div key={d.name} className="shells-row flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate">
            <span className="mono">{d.command || 'shell'}</span>
            {d.path && <span className="muted"> in <span className="mono">{d.path}</span></span>}
            {d.idleSec !== null && <span className="muted"> · {idleText(d.idleSec)}</span>}
          </span>
          <button className="btn btn-primary btn-sm" onClick={() => onResume(d.name)}>Resume</button>
          <button className="btn btn-sm" title="End this shell on the host" onClick={() => onEnd(d.name)}>End</button>
        </div>
      ))}
    </div>
  )
}

const SEARCH_DECOR = { matchBackground: '#f5a62366', activeMatchBackground: '#f5a623', matchOverviewRuler: '#f5a623', activeMatchColorOverviewRuler: '#f5a623' }

export default function TerminalTab({ tab, active }: { tab: Tab; active: boolean }): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const findInput = useRef<HTMLInputElement>(null)
  const snippetBtn = useRef<HTMLButtonElement>(null)
  const splitBtn = useRef<HTMLButtonElement>(null)
  const reconnectRef = useRef<() => void>(() => undefined)
  /**
   * The tmux shell this tab shows (undefined = its own, named after the tab) and whether it has shown it yet, so a
   * reconnect resumes that shell and can say when it has ended.
   */
  const shellRef = useRef<{ name?: string; shown: boolean }>({ shown: false })
  const [detached, setDetached] = useState<DetachedShell[]>([])
  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [hits, setHits] = useState<{ index: number; count: number } | null>(null)
  const [menu, setMenu] = useState<'snippets' | 'split' | 'shells' | null>(null)
  const shellsBtn = useRef<HTMLButtonElement>(null)
  /** The host's persistent shells for the session list (null while loading). */
  const [shells, setShells] = useState<HostShell[] | null>(null)
  const [shellSheet, setShellSheet] = useState(false)
  const updateTab = useStore((s) => s.updateTab)
  const toast = useStore((s) => s.toast)
  const themeId = useStore((s) => s.settings?.terminalTheme)
  const font = useStore((s) => s.settings?.terminalFont)
  const mobile = isMobile()
  const keyboardOpen = useKeyboardOpen()
  const [mobileFontSize, setMobileFontSize] = useState(readMobileFontSize)
  const desktopFontSize = useStore((s) => s.settings?.terminalFontSize) ?? DEFAULT_TERMINAL_FONT_SIZE
  const fontSize = mobile ? mobileFontSize : desktopFontSize
  const [mods, setModsState] = useState<StickyMods>(NO_MODS)
  const modsRef = useRef<StickyMods>(NO_MODS)
  const setMods = (m: StickyMods): void => { modsRef.current = m; setModsState(m) }
  const [mobileMenu, setMobileMenu] = useState(false)
  /** Paste box contents while it is open (null = closed). */
  const [pasteBox, setPasteBox] = useState<string | null>(null)
  /** Terminal text shown for selecting and copying (null = closed). */
  const [copyText, setCopyText] = useState<string | null>(null)
  const appTheme = useStore((s) => s.settings?.theme)
  const paneOpen = useStore((s) => s.terminalPaneOpen)
  const togglePane = useStore((s) => s.toggleTerminalPane)
  const allSnippets = useStore((s) => s.settings?.snippets)
  const splitGroup = useStore((s) => s.splitGroup)
  const broadcast = useStore((s) => s.broadcastInput)
  const otherTabs = useStore((s) => s.tabs).filter((t) => t.id !== tab.id && t.kind !== 'rdp')
  const inSplit = splitGroup.includes(tab.id)
  const theme = resolveTerminalTheme(themeId, isDarkMode())
  const background = theme.background ?? (isDarkMode() ? '#0f1115' : '#ffffff')
  const snippets = snippetsFor(tab.instanceKey, allSnippets)

  useEffect(() => {
    const el = ref.current!
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: terminalFontFamily(font),
      fontSize,
      scrollback: 10_000,
      allowProposedApi: true,
      theme
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.loadAddon(new WebLinksAddon())
    term.open(el)
    // App shortcuts (⌘K, ⌘W, ⌘1…) belong to the UI, not the remote shell.
    term.attachCustomKeyEventHandler((e) => !isAppShortcut(e))
    fit.fit()
    termRef.current = term
    fitRef.current = fit
    searchRef.current = search
    const onHits = search.onDidChangeResults((r) => setHits(r.resultCount ? { index: r.resultIndex, count: r.resultCount } : { index: -1, count: 0 }))

    const id = tab.id
    let opened = false
    let disposed = false
    let opening = false
    let closingForRetry = false
    const off = window.api.on('ssh:event', (ev) => {
      if (ev.sessionId !== id) return
      if (ev.type === 'data' && ev.data) term.write(ev.data)
      else if (ev.type === 'status') term.writeln(`\x1b[90m[${ev.message}]\x1b[0m`)
      else if (ev.type === 'error') {
        term.writeln(`\r\n\x1b[31m[error] ${ev.message}\x1b[0m`)
        updateTab(id, { status: 'error', message: ev.message })
      } else if (ev.type === 'closed') {
        if (closingForRetry) return
        term.writeln(`\r\n\x1b[90m[${ev.message ?? 'closed'}] — Reconnect to continue. Output is preserved.\x1b[0m`)
        if (useStore.getState().tabs.find((t) => t.id === id)?.status !== 'error') updateTab(id, { status: 'closed', message: ev.message })
      }
    })

    const onData = term.onData((d) => {
      // Key-bar Ctrl/Alt are one-shot: they shape the next keystroke from the phone keyboard, then release.
      const m = modsRef.current
      if (m.ctrl || m.alt) { d = applyStickyMods(d, m); setMods(NO_MODS) }
      writeInput(id, d)
    })
    const onResize = term.onResize(({ cols, rows }) => {
      if (opened) void window.api.invoke('ssh:resize', id, cols, rows)
    })
    const ro = new ResizeObserver(() => {
      if (el.offsetParent !== null) fit.fit()
    })
    ro.observe(el)

    /** `retry` reconnects, to the same shell when it is persistent. */
    const connect = async (retry = false): Promise<void> => {
      if (opening || disposed) return
      opening = true
      opened = false
      updateTab(id, { status: 'connecting', message: retry ? 'Reconnecting…' : 'Connecting…' })
      try {
        if (retry) {
          closingForRetry = true
          await window.api.invoke('ssh:close', id)
          closingForRetry = false
          if (disposed) return
          term.writeln('\r\n\x1b[90m──── Reconnecting ────\x1b[0m')
        }
        // A reused connection belongs to the tab that lent it; a reconnect logs in on its own.
        const request = retry ? { ...tab.request!, reuseSessionId: undefined } : tab.request!
        const sh = shellRef.current
        const info = await window.api.invoke('ssh:open', { ...request, sessionId: id, cols: term.cols, rows: term.rows, shellName: sh.name, shellResume: sh.shown })
        if (disposed) return
        opened = true
        if (info.persistent) shellRef.current = { name: sh.name, shown: true }
        setDetached(info.detached ?? [])
        updateTab(id, { status: 'connected', route: info.route, message: `${info.user}@${info.host} via ${info.route}`, logFile: info.logFile, persistent: !!info.persistent })
        if (useStore.getState().activeTab === id) term.focus()
      } catch (error) {
        const e = error as Error
        if (disposed || /cancelled/.test(e.message)) return
        useStore.getState().noteOperationError(e.message)
        updateTab(id, { status: 'error', message: e.message })
        term.writeln(`\r\n\x1b[31m[connect failed] ${e.message}\x1b[0m`)
        toast('error', e.message)
      } finally { opening = false; closingForRetry = false }
    }
    reconnectRef.current = () => void connect(true)
    void connect()

    return () => {
      disposed = true
      void window.api.invoke('ssh:close', id).catch(() => undefined)
      off()
      onData.dispose()
      onResize.dispose()
      onHits.dispose()
      ro.disconnect()
      term.dispose()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (active) {
      requestAnimationFrame(() => {
        fitRef.current?.fit()
        if (!findOpen) termRef.current?.focus()
      })
    }
  }, [active]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => onTerminalAction(tab.id, (action) => {
    if (action === 'find') {
      setFindOpen(true)
      const sel = termRef.current?.getSelection()
      if (sel && !sel.includes('\n')) setQuery(sel)
      requestAnimationFrame(() => findInput.current?.select())
    } else if (action === 'snippets') setMenu('snippets')
  }), [tab.id])

  const find = (dir: 'next' | 'prev', q = query): void => {
    const s = searchRef.current
    if (!s) return
    if (!q) { s.clearDecorations(); setHits(null); return }
    const opts = { caseSensitive, decorations: SEARCH_DECOR }
    if (dir === 'next') s.findNext(q, opts)
    else s.findPrevious(q, opts)
  }
  const closeFind = (): void => {
    setFindOpen(false)
    searchRef.current?.clearDecorations()
    setHits(null)
    termRef.current?.focus()
  }

  // Live-apply appearance changes to the running terminal (Settings dialog, or the OS switching light/dark
  // while the app follows the system and the terminal theme is 'auto').
  useEffect(() => {
    const apply = (): void => {
      const term = termRef.current
      if (!term) return
      term.options.theme = resolveTerminalTheme(themeId, isDarkMode())
      term.options.fontFamily = terminalFontFamily(font)
      term.options.fontSize = fontSize
      fitRef.current?.fit()
    }
    apply()
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [themeId, font, fontSize, appTheme])

  // Picking a scheme or size from the pane hands the keyboard straight back to the terminal. Font-family changes are
  // excluded because they arrive per keystroke while typing in the pane's font field.
  useEffect(() => {
    if (active && !findOpen) termRef.current?.focus()
  }, [themeId, fontSize, active]) // eslint-disable-line react-hooks/exhaustive-deps

  // xterm.js has no touch selection or context menu, so a long press on a phone opens the session menu (Paste,
  // Select text). The touchend is cancelled so the tap iOS would synthesize cannot land on the sheet's backdrop.
  useEffect(() => {
    const el = ref.current
    if (!mobile || !el) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let start: { x: number; y: number } | null = null
    let fired = false
    const cancel = (): void => { clearTimeout(timer); start = null }
    const down = (e: TouchEvent): void => {
      cancel()
      fired = false
      if (e.touches.length !== 1) return
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY }
      timer = setTimeout(() => { start = null; fired = true; setMobileMenu(true) }, 550)
    }
    const move = (e: TouchEvent): void => {
      if (start && Math.hypot(e.touches[0].clientX - start.x, e.touches[0].clientY - start.y) > 10) cancel()
    }
    const up = (e: TouchEvent): void => {
      cancel()
      if (fired) { fired = false; e.preventDefault() }
    }
    el.addEventListener('touchstart', down, { passive: true })
    el.addEventListener('touchmove', move, { passive: true })
    el.addEventListener('touchend', up, { passive: false })
    el.addEventListener('touchcancel', cancel)
    return () => {
      cancel()
      el.removeEventListener('touchstart', down)
      el.removeEventListener('touchmove', move)
      el.removeEventListener('touchend', up)
      el.removeEventListener('touchcancel', cancel)
    }
  }, [mobile])

  /** Whole scrollback as plain text, downloaded as a file (a Save dialog in the desktop app). */
  const saveOutput = (): void => {
    const term = termRef.current
    if (!term) return
    const url = URL.createObjectURL(new Blob([bufferText(term) + '\n'], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${tab.title.replace(/[^\w.@-]+/g, '_')}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  const disconnected = tab.status === 'closed' || tab.status === 'error'
  const sendKey = (k: string): void => {
    const term = termRef.current
    if (!term || tab.status !== 'connected') return
    const m = modsRef.current
    setMods(NO_MODS)
    writeInput(tab.id, applyStickyMods(keySequence(k, term.modes.applicationCursorKeysMode), m))
  }
  const setPhoneFont = (n: number): void => {
    const v = Math.min(24, Math.max(8, n))
    setMobileFontSize(v)
    try { localStorage.setItem(MOBILE_FONT_KEY, String(v)) } catch { /* storage unavailable */ }
  }
  // term.paste rather than a raw write: it honours bracketed paste, so a shell that asks for it won't run pasted lines.
  const paste = (): void => pasteFromClipboard((text) => termRef.current?.paste(text), setPasteBox)
  const sendPasteBox = (text: string): void => {
    setPasteBox(null)
    termRef.current?.paste(text)
    termRef.current?.focus()
  }

  const endShell = (name: string): void => {
    window.api.invoke('ssh:endShell', tab.id, name).then(
      () => setDetached((d) => d.filter((x) => x.name !== name)),
      (e: Error) => toast('error', e.message)
    )
  }
  /** The banner's Resume: switch to the shell left running, in place, and end the new one this tab had just started. */
  const resumeShell = (name: string): void => {
    setDetached([])
    window.api.invoke('ssh:switchShell', tab.id, name, { endPrevious: true }).then(
      (r) => {
        shellRef.current = { name: r.name, shown: true }
        termRef.current?.focus()
      },
      (e: Error) => toast('error', e.message)
    )
  }
  const shellsBar = detached.length > 0 && (
    <DetachedShells shells={detached} mobile={mobile} onResume={resumeShell} onEnd={endShell} onDismiss={() => setDetached([])} />
  )
  // Only once connected: while a reconnect is under way the host's shells cannot be reached yet.
  const canDetach = !!tab.persistent && tab.status === 'connected'
  const loadShells = (): void => {
    setShells(null)
    window.api.invoke('ssh:listShells', tab.id).then(setShells, (e: Error) => {
      toast('error', e.message)
      setMenu(null)
      setShellSheet(false)
    })
  }
  /** Shows another shell in this tab (null = a new one); the shell it leaves keeps running on the host. */
  const switchShell = (sh: HostShell | null): void => {
    if (sh?.current) return
    if (sh?.attached && !window.confirm('That session is open in another tab or device. Show it here instead? It will close there.')) return
    setMenu(null)
    setShellSheet(false)
    window.api.invoke('ssh:switchShell', tab.id, sh?.name ?? null).then(
      (r) => {
        shellRef.current = { name: r.name, shown: true }
        setDetached([])
        termRef.current?.focus()
      },
      (e: Error) => toast('error', e.message)
    )
  }
  const endOtherShell = (name: string): void => {
    window.api.invoke('ssh:endShell', tab.id, name).then(
      () => setShells((list) => list?.filter((x) => x.name !== name) ?? null),
      (e: Error) => toast('error', e.message)
    )
  }
  const detach = (): void => void useStore.getState().closeTab(tab.id, { detach: true })

  if (mobile) {
    return (
      <div className="flex h-full min-w-0 flex-col">
        {disconnected && (
          <div className="m-status-strip">
            <span className="min-w-0 flex-1 truncate">{tab.message ?? 'Disconnected'}</span>
            <button className="btn btn-primary btn-sm" onClick={() => reconnectRef.current()}>Reconnect</button>
          </div>
        )}
        {shellsBar}
        <div ref={ref} className="m-term min-h-0 min-w-0 flex-1" style={{ background }} />
        <KeyBar
          mods={mods}
          onMods={(m) => { setMods(m); termRef.current?.focus() }}
          onKey={sendKey}
          keyboardOpen={keyboardOpen}
          onKeyboard={() => { if (keyboardOpen) termRef.current?.blur(); else termRef.current?.focus() }}
          onPaste={paste}
          onMore={() => setMobileMenu(true)}
        />
        {pasteBox !== null && <PasteSheet initial={pasteBox} action="Paste" onSend={sendPasteBox} onClose={() => setPasteBox(null)} />}
        {copyText !== null && <CopySheet text={copyText} onClose={() => setCopyText(null)} />}
        {shellSheet && (
          <Sheet title="Sessions on this host" subtitle="Switch this tab to another session; the one you leave keeps running." onClose={() => setShellSheet(false)}>
            {shells === null && <div className="m-sheet-item muted">Loading…</div>}
            {shells?.map((sh, i) => (
              <div key={sh.name} className="m-sheet-item as-row">
                <button className="flex min-w-0 flex-1 items-center gap-3 text-left" disabled={sh.current} onClick={() => switchShell(sh)}>
                  <span className="m-sheet-icon">{sh.current ? '✓' : <Icon.terminal />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{i + 1} · <span className="mono">{sh.command || 'shell'}</span>{sh.path && <span className="muted"> in <span className="mono">{sh.path}</span></span>}</span>
                    <span className="muted block truncate text-[12px]">{shellStatus(sh)}</span>
                  </span>
                </button>
                {!sh.current && !sh.attached && <button className="btn" onClick={() => endOtherShell(sh.name)}>End</button>}
              </div>
            ))}
            <SheetItem icon={<Icon.plus />} onClick={() => switchShell(null)}>New session in this tab</SheetItem>
          </Sheet>
        )}
        {mobileMenu && (
          <Sheet title={tab.title} subtitle={tab.message} onClose={() => setMobileMenu(false)}>
            <SheetItem icon={<Icon.clipboard />} onClick={() => { setMobileMenu(false); paste() }}>Paste</SheetItem>
            <SheetItem icon={<Icon.copy />} onClick={() => { setMobileMenu(false); setCopyText(termRef.current ? bufferText(termRef.current) : '') }}>Select text to copy</SheetItem>
            {snippets.map((sn) => (
              <SheetItem key={sn.id} icon={<Icon.play />} disabled={tab.status !== 'connected'} hint={sn.run ? '↵' : undefined} onClick={() => { setMobileMenu(false); runSnippet(tab.id, sn) }}>
                {sn.name} <span className="mono muted text-[12px]">{sn.command.split('\n')[0]}</span>
              </SheetItem>
            ))}
            <div className="m-sheet-item as-row">
              <span className="m-sheet-icon"><Icon.terminal /></span>
              <span className="flex-1">Text size <span className="mono muted">{fontSize}</span></span>
              <button className="btn" aria-label="Smaller text" onClick={() => setPhoneFont(fontSize - 1)}>A−</button>
              <button className="btn" aria-label="Larger text" onClick={() => setPhoneFont(fontSize + 1)}>A+</button>
            </div>
            {disconnected && <SheetItem icon={<Icon.refresh />} onClick={() => { setMobileMenu(false); reconnectRef.current() }}>Reconnect</SheetItem>}
            <SheetItem icon={<Icon.download />} onClick={() => { setMobileMenu(false); saveOutput() }}>Save output as text</SheetItem>
            {canDetach && <SheetItem icon={<Icon.layers />} onClick={() => { setMobileMenu(false); setShellSheet(true); loadShells() }}>Sessions on this host…</SheetItem>}
            {canDetach && <SheetItem icon={<Icon.layers />} onClick={() => { setMobileMenu(false); detach() }}>Detach (leave the shell running)</SheetItem>}
            <SheetItem icon={<Icon.x />} danger onClick={() => { setMobileMenu(false); void useStore.getState().closeTab(tab.id) }}>{disconnected ? 'Close' : canDetach ? 'Disconnect and end the shell' : 'Disconnect'}</SheetItem>
          </Sheet>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="term-toolbar panel flex flex-wrap items-center gap-1.5 border-b px-2 py-1 text-[11px]" style={{ borderColor: 'var(--border)' }}>
        <span className="muted min-w-0 truncate">{tab.message ?? 'Connecting…'}</span>
        {tab.logFile && (
          <button className="rec-chip" title={`Recording to ${tab.logFile}. Click to show in Finder.`} onClick={() => void window.api.invoke('local:reveal', tab.logFile!)}>
            <span className="dot" /> REC
          </button>
        )}
        {inSplit && broadcast && <span className="badge badge-err" title="Typing goes to every connected pane in this split (⌘⇧I to stop)"><Icon.broadcast /> Broadcasting</span>}
        <span className="flex-1" />
        {disconnected && <>
          <button className="btn btn-primary btn-sm" onClick={() => reconnectRef.current()}>Reconnect</button>
          <button className="btn btn-sm" title="Open a new session with different connection settings" onClick={() => useStore.getState().set({ connectFor: { kind: 'ssh', key: tab.instanceKey } })}>Edit connection</button>
          <button className="btn btn-sm" onClick={() => void window.api.invoke('clipboard:write', tab.message ?? 'Disconnected').then(() => toast('success', 'Connection message copied'))}>Copy message</button>
        </>}
        <HostActions instanceKey={tab.instanceKey} current="ssh" />
        <span className="tool-sep" />
        <button className={`btn btn-ghost btn-sm btn-icon ${findOpen ? 'on' : ''}`} title="Find in terminal (⌘F)" onClick={() => (findOpen ? closeFind() : onFindShortcut())}>
          <Icon.search />
        </button>
        <button ref={snippetBtn} className={`btn btn-ghost btn-sm btn-icon ${menu === 'snippets' ? 'on' : ''}`} title="Snippets" onMouseDown={(e) => e.preventDefault()} onClick={() => setMenu(menu === 'snippets' ? null : 'snippets')}>
          <Icon.snippet />
        </button>
        <button ref={splitBtn} className={`btn btn-ghost btn-sm btn-icon ${inSplit ? 'on' : ''}`} title="Split view (⌘D opens this session again beside it)" onMouseDown={(e) => e.preventDefault()} onClick={() => setMenu(menu === 'split' ? null : 'split')}>
          <Icon.split />
        </button>
        {inSplit && (
          <button className={`btn btn-ghost btn-sm btn-icon ${broadcast ? 'on' : ''}`} title={broadcast ? 'Stop broadcasting input (⌘⇧I)' : 'Broadcast typing to every pane in this split (⌘⇧I)'} aria-pressed={broadcast} onClick={() => useStore.getState().set({ broadcastInput: !broadcast })}>
            <Icon.broadcast />
          </button>
        )}
        <button className="btn btn-ghost btn-sm btn-icon" title="Save the output (whole scrollback) as a text file" onClick={saveOutput}>
          <Icon.download />
        </button>
        <button onMouseDown={(e) => e.preventDefault()} className={`btn btn-ghost btn-sm btn-icon${paneOpen ? ' on' : ''}`} title={paneOpen ? 'Hide appearance pane' : 'Themes and font'} aria-pressed={paneOpen} onClick={() => togglePane()}>
          <Icon.panelRight filled={paneOpen} />
        </button>
        {canDetach && (
          <button ref={shellsBtn} className={`btn btn-sm ${menu === 'shells' ? 'on' : ''}`} title="Sessions kept running on this host (tmux): switch this tab between them; the others keep running" onMouseDown={(e) => e.preventDefault()} onClick={() => { if (menu === 'shells') setMenu(null); else { setMenu('shells'); loadShells() } }}>
            <Icon.layers /> Sessions
          </button>
        )}
        {canDetach && (
          <button className="btn btn-sm" title="Close this tab but leave the shell running on the host; opening the host again offers to resume it" onClick={detach}>
            Detach
          </button>
        )}
        <button className="btn btn-sm" title={canDetach ? 'Close this tab and end its shell on the host' : undefined} onClick={() => void useStore.getState().closeTab(tab.id)}>
          {disconnected ? 'Close tab' : 'Disconnect'}
        </button>
      </div>
      {menu === 'snippets' && (
        <Popover anchor={snippetBtn.current} align="right" width={300} onClose={() => { setMenu(null); termRef.current?.focus() }}>
          <MenuLabel>Snippets</MenuLabel>
          {snippets.map((sn) => (
            <MenuItem key={sn.id} disabled={tab.status !== 'connected'} title={sn.command} hint={sn.hostKey ? 'this host' : sn.run ? '↵' : 'paste'}
              onClick={() => { setMenu(null); runSnippet(tab.id, sn); termRef.current?.focus() }}>
              <span className="block truncate">{sn.name}</span>
              <span className="mono muted block truncate text-[10px]">{sn.command.split('\n')[0]}</span>
            </MenuItem>
          ))}
          {!snippets.length && <div className="muted px-3 py-2">No snippets yet.</div>}
          <MenuSep />
          <MenuItem onClick={() => { setMenu(null); useStore.getState().set({ snippetsOpen: { hostKey: tab.instanceKey } }) }}>Edit snippets…</MenuItem>
        </Popover>
      )}
      {menu === 'shells' && (
        <Popover anchor={shellsBtn.current} align="right" width={360} onClose={() => { setMenu(null); termRef.current?.focus() }}>
          <MenuLabel>Sessions on this host</MenuLabel>
          {shells === null && <div className="muted px-3 py-2">Loading…</div>}
          {shells?.map((sh, i) => (
            <div key={sh.name} className="shell-row flex items-center">
              <button className={`menu-item min-w-0 flex-1 ${sh.current ? 'on' : ''}`} disabled={sh.current} title={sh.attached && !sh.current ? 'Open elsewhere: switching shows it here and closes it there' : undefined} onClick={() => switchShell(sh)}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{i + 1} · <span className="mono">{sh.command || 'shell'}</span>{sh.path && <span className="muted"> in <span className="mono">{sh.path}</span></span>}</span>
                  <span className="muted block truncate text-[10px]">{shellStatus(sh)}</span>
                </span>
              </button>
              {!sh.current && !sh.attached && <button className="btn btn-ghost btn-sm mr-1" title="End this session on the host" onClick={() => endOtherShell(sh.name)}>End</button>}
            </div>
          ))}
          <MenuSep />
          <MenuItem onClick={() => switchShell(null)}>New session in this tab</MenuItem>
          <div className="muted px-3 pb-1 pt-0.5 text-[10px]">The session you switch away from keeps running.</div>
        </Popover>
      )}
      {menu === 'split' && (
        <Popover anchor={splitBtn.current} align="right" width={280} onClose={() => setMenu(null)}>
          <MenuItem hint="⌘D" onClick={() => { setMenu(null); useStore.getState().duplicateTab(tab.id, true) }}>New session to this host, beside this one</MenuItem>
          {otherTabs.filter((t) => !splitGroup.includes(t.id)).length > 0 && <MenuLabel>Show beside</MenuLabel>}
          {otherTabs.filter((t) => !splitGroup.includes(t.id)).map((t) => (
            <MenuItem key={t.id} onClick={() => { setMenu(null); useStore.getState().splitWith(tab.id, t.id) }}>
              {t.kind === 'sftp' ? 'Files: ' : ''}{t.title}
            </MenuItem>
          ))}
          {inSplit && <><MenuSep /><MenuItem onClick={() => { setMenu(null); useStore.getState().unsplit(tab.id) }}>Move this pane to its own tab</MenuItem></>}
        </Popover>
      )}
      {shellsBar}
      {findOpen && (
        <div className="find-bar panel flex items-center gap-1.5 border-b px-2 py-1 text-[11px]" style={{ borderColor: 'var(--border)' }}>
          <Icon.search className="muted" />
          <input
            ref={findInput}
            className="input !h-6 !w-64"
            placeholder="Find in scrollback"
            aria-label="Find in terminal"
            value={query}
            onChange={(e) => { setQuery(e.target.value); find('next', e.target.value) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); find(e.shiftKey ? 'prev' : 'next') }
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind() }
            }}
          />
          <span className="muted mono w-16">{hits ? (hits.count ? `${hits.index + 1}/${hits.count}` : 'no match') : ''}</span>
          <button className="btn btn-ghost btn-sm btn-icon" title="Previous (⇧↵)" onClick={() => find('prev')}><Icon.arrowUp /></button>
          <button className="btn btn-ghost btn-sm btn-icon" title="Next (↵)" onClick={() => find('next')}><Icon.arrowDown /></button>
          <button className={`btn btn-ghost btn-sm ${caseSensitive ? 'on' : ''}`} title="Match case" aria-pressed={caseSensitive} onClick={() => setCaseSensitive(!caseSensitive)}>Aa</button>
          <span className="flex-1" />
          <button className="btn btn-ghost btn-sm btn-icon" title="Close (Esc)" onClick={closeFind}><Icon.x /></button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div ref={ref} className="min-h-0 min-w-0 flex-1" style={{ background }} />
        {paneOpen && active && <TerminalAppearancePane />}
      </div>
    </div>
  )

  function onFindShortcut(): void {
    setFindOpen(true)
    requestAnimationFrame(() => findInput.current?.select())
  }
}

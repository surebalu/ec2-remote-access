import type { ReactElement } from 'react'
import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { isDarkMode, useStore, type Tab } from '../store'
import { resolveTerminalTheme, terminalFontFamily, DEFAULT_TERMINAL_FONT_SIZE } from '../terminalThemes'
import HostActions from './HostActions'
import TerminalAppearancePane from './TerminalAppearancePane'
import { Icon } from './icons'

export default function TerminalTab({ tab, active }: { tab: Tab; active: boolean }): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const reconnectRef = useRef<() => void>(() => undefined)
  const updateTab = useStore((s) => s.updateTab)
  const toast = useStore((s) => s.toast)
  const themeId = useStore((s) => s.settings?.terminalTheme)
  const font = useStore((s) => s.settings?.terminalFont)
  const fontSize = useStore((s) => s.settings?.terminalFontSize) ?? DEFAULT_TERMINAL_FONT_SIZE
  const appTheme = useStore((s) => s.settings?.theme)
  const paneOpen = useStore((s) => s.terminalPaneOpen)
  const togglePane = useStore((s) => s.toggleTerminalPane)
  const theme = resolveTerminalTheme(themeId, isDarkMode())
  const background = theme.background ?? (isDarkMode() ? '#0f1115' : '#ffffff')

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
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(el)
    term.attachCustomKeyEventHandler((e) => !((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k'))
    fit.fit()
    termRef.current = term
    fitRef.current = fit

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
      const st = useStore.getState().tabs.find((t) => t.id === id)?.status
      if (st === 'connected') void window.api.invoke('ssh:write', id, d)
    })
    const onResize = term.onResize(({ cols, rows }) => {
      if (opened) void window.api.invoke('ssh:resize', id, cols, rows)
    })
    const ro = new ResizeObserver(() => {
      if (el.offsetParent !== null) fit.fit()
    })
    ro.observe(el)

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
        const info = await window.api.invoke('ssh:open', { ...tab.request!, sessionId: id, cols: term.cols, rows: term.rows })
        if (disposed) return
        opened = true
        updateTab(id, { status: 'connected', route: info.route, message: `${info.user}@${info.host} via ${info.route}` })
        term.focus()
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
      ro.disconnect()
      term.dispose()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (active) {
      requestAnimationFrame(() => {
        fitRef.current?.fit()
        termRef.current?.focus()
      })
    }
  }, [active])

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
    if (active) termRef.current?.focus()
  }, [themeId, fontSize, active])

  return (
    <div className="flex h-full flex-col">
      <div className="panel flex flex-wrap items-center gap-2 border-b px-2 py-1 text-[11px]" style={{ borderColor: 'var(--border)' }}>
        <span className="muted truncate">{tab.message ?? 'Connecting…'}</span>
        <span className="flex-1" />
        <HostActions instanceKey={tab.instanceKey} current="ssh" />
        {(tab.status === 'closed' || tab.status === 'error') && <>
          <button className="btn btn-primary" onClick={() => reconnectRef.current()}>Reconnect</button>
          <button className="btn" title="Open a new session with different connection settings" onClick={() => useStore.getState().set({ connectFor: { kind: 'ssh', key: tab.instanceKey } })}>Edit connection</button>
          <button className="btn" onClick={() => void window.api.invoke('clipboard:write', tab.message ?? 'Disconnected').then(() => toast('success', 'Connection message copied'))}>Copy message</button>
        </>}
        <button className="btn !py-0.5" onClick={() => void useStore.getState().closeTab(tab.id)}>
          {tab.status === 'closed' || tab.status === 'error' ? 'Close tab' : 'Disconnect'}
        </button>
        <button onMouseDown={(e) => e.preventDefault()} className={`btn btn-icon !py-0.5${paneOpen ? ' on' : ''}`} title={paneOpen ? 'Hide appearance pane' : 'Themes and font'} aria-pressed={paneOpen} onClick={() => togglePane()}>
          <Icon.panelRight filled={paneOpen} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div ref={ref} className="min-h-0 min-w-0 flex-1" style={{ background }} />
        {paneOpen && <TerminalAppearancePane />}
      </div>
    </div>
  )
}

import type { ReactElement } from 'react'
import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { isDarkMode, useStore, type Tab } from '../store'
import HostActions from './HostActions'

export default function TerminalTab({ tab, active }: { tab: Tab; active: boolean }): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const reconnectRef = useRef<() => void>(() => undefined)
  const updateTab = useStore((s) => s.updateTab)
  const toast = useStore((s) => s.toast)

  useEffect(() => {
    const el = ref.current!
    const dark = isDarkMode()
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'JetBrains Mono, SF Mono, Menlo, monospace',
      fontSize: 13,
      scrollback: 10_000,
      allowProposedApi: true,
      theme: dark ? { background: '#0f1115' } : { background: '#ffffff', foreground: '#1c2128', cursor: '#1c2128' }
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
      </div>
      <div ref={ref} className="min-h-0 w-full flex-1" style={{ background: isDarkMode() ? '#0f1115' : '#ffffff' }} />
    </div>
  )
}

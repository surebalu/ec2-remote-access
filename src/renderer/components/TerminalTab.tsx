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
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    const id = tab.id
    let opened = false
    let disposed = false
    const off = window.api.on('ssh:event', (ev) => {
      if (ev.sessionId !== id) return
      if (ev.type === 'data' && ev.data) term.write(ev.data)
      else if (ev.type === 'status') term.writeln(`\x1b[90m[${ev.message}]\x1b[0m`)
      else if (ev.type === 'error') {
        term.writeln(`\r\n\x1b[31m[error] ${ev.message}\x1b[0m`)
        updateTab(id, { status: 'error', message: ev.message })
      } else if (ev.type === 'closed') {
        term.writeln(`\r\n\x1b[90m[${ev.message ?? 'closed'}]  — press any key to close tab\x1b[0m`)
        updateTab(id, { status: 'closed', message: ev.message })
      }
    })

    const onData = term.onData((d) => {
      const st = useStore.getState().tabs.find((t) => t.id === id)?.status
      if (st === 'closed' || st === 'error') {
        void useStore.getState().closeTab(id)
        return
      }
      void window.api.invoke('ssh:write', id, d)
    })
    const onResize = term.onResize(({ cols, rows }) => {
      if (opened) void window.api.invoke('ssh:resize', id, cols, rows)
    })
    const ro = new ResizeObserver(() => {
      if (el.offsetParent !== null) fit.fit()
    })
    ro.observe(el)

    window.api
      .invoke('ssh:open', { ...tab.request!, sessionId: id, cols: term.cols, rows: term.rows })
      .then((info) => {
        if (disposed) return
        opened = true
        updateTab(id, { status: 'connected', route: info.route, message: `${info.user}@${info.host} via ${info.route}` })
        term.focus()
      })
      .catch((e: Error) => {
        if (disposed || /cancelled/.test(e.message)) return
        useStore.getState().noteOperationError(e.message)
        updateTab(id, { status: 'error', message: e.message })
        term.writeln(`\r\n\x1b[31m[connect failed] ${e.message}\x1b[0m`)
        toast('error', e.message)
      })

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
      <div className="panel flex items-center gap-2 border-b px-2 py-1 text-[11px]" style={{ borderColor: 'var(--border)' }}>
        <span className="muted truncate">{tab.message ?? 'Connecting…'}</span>
        <span className="flex-1" />
        <HostActions instanceKey={tab.instanceKey} current="ssh" />
        <button className="btn !py-0.5" onClick={() => void useStore.getState().closeTab(tab.id)}>
          Disconnect
        </button>
      </div>
      <div ref={ref} className="min-h-0 w-full flex-1" style={{ background: isDarkMode() ? '#0f1115' : '#ffffff' }} />
    </div>
  )
}

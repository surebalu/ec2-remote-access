import { useEffect, useId, useRef, useState, type ReactElement } from 'react'
import { matchesHost } from '@shared/hostSearch'
import { routeOf, useStore, visibleInstances } from '../store'
import { openDefaultFor } from '../quickConnect'
import Modal from './Modal'
import { Icon } from './icons'

export default function QuickSwitcher(): ReactElement {
  const s = useStore()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const listId = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const close = (): void => s.set({ quickSwitcherOpen: false })
  const recentRank = (key: string): number => { const n = s.recentHosts.indexOf(key); return n < 0 ? 100 : n }
  const hosts = visibleInstances(s).filter((i) => matchesHost(i, query)).sort((a, b) =>
    recentRank(a.key) - recentRank(b.key) || Number(s.isFavorite(b.key)) - Number(s.isFavorite(a.key)) || a.name.localeCompare(b.name)
  )
  const tabs = s.tabs.filter((t) => `${t.title} ${t.kind} ${t.status}`.toLowerCase().includes(query.trim().toLowerCase()))
  const results = [
    ...tabs.map((t) => ({ id: `tab:${t.id}`, title: t.title, subtitle: `Open ${t.kind.toUpperCase()} session · ${t.status}`, key: t.instanceKey, icon: t.kind === 'rdp' ? Icon.monitor : t.kind === 'sftp' ? Icon.folder : Icon.terminal, action: () => s.setActive(t.id), hint: 'Switch' })),
    ...hosts.map((i) => {
      const available = ['ssm', 'direct'].includes(routeOf(i, s.settings).route)
      return { id: i.key, title: i.name, subtitle: `${i.profile} · ${i.region} · ${i.instanceId}${i.staleReason ? ' · cached' : ''}`, key: i.key,
        icon: i.platform === 'windows' ? Icon.monitor : Icon.terminal, hint: available ? 'Connect' : 'Details',
        action: () => available ? openDefaultFor(i.key) : s.revealHost(i.key) }
    })
  ].slice(0, 60)
  const index = Math.min(selected, Math.max(0, results.length - 1))
  useEffect(() => { setSelected(0) }, [query])
  useEffect(() => { listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [index, query])
  const activate = (n: number, details = false): void => {
    const item = results[n]
    if (!item) return
    close()
    if (details) s.revealHost(item.key)
    else item.action()
  }
  return <Modal title="Quick switcher" onClose={close} width="max-w-2xl">
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-3 muted"><Icon.search /></span>
      <input autoFocus className="input !h-10 !pl-9 !text-sm" aria-label="Find a host or open session" role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list" aria-activedescendant={results.length ? `${listId}-${index}` : undefined}
        placeholder="Find a host, IP, account, region, tag, or open session…" value={query} onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setSelected((index + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % (results.length || 1)) }
          if (e.key === 'Enter') { e.preventDefault(); activate(index, e.shiftKey) }
        }} />
    </div>
    <p className="muted my-3 text-xs">{query ? `${results.length}${results.length === 60 ? '+' : ''} result${results.length === 1 ? '' : 's'}` : 'Open sessions, recent connections, and favorites first'}</p>
    <div ref={listRef} id={listId} role="listbox" aria-label="Hosts and sessions" className="max-h-[50vh] overflow-y-auto space-y-1">
      {results.map((item, n) => <button key={item.id} id={`${listId}-${n}`} type="button" role="option" aria-selected={n === index} tabIndex={-1}
        className={`switcher-result ${n === index ? 'on' : ''}`} onMouseMove={() => setSelected(n)} onClick={() => activate(n)}>
        <item.icon /><span className="min-w-0 flex-1 text-left"><span className="block truncate font-medium">{item.title}</span><span className="muted block truncate text-[11px]">{item.subtitle}</span></span>
        <span className="muted text-[11px]">{item.hint}</span>
      </button>)}
      {!results.length && <p className="muted py-10 text-center">No matching hosts or sessions. Try a name, IP, or account.</p>}
    </div>
    <div className="muted mt-3 flex gap-4 border-t border-default pt-3 text-[11px]"><span>↑ ↓ Navigate</span><span>↵ Connect / switch</span><span>⇧ ↵ Host details</span><span>Esc Close</span></div>
  </Modal>
}

import { useState, type ReactElement } from 'react'
import type { Snippet } from '@shared/types'
import { allInstances, useStore } from '../store'
import Modal from './Modal'
import { Icon } from './icons'

const blank = (hostKey?: string): Snippet => ({ id: `sn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`, name: '', command: '', hostKey, run: true })

/** Add, edit and delete saved commands. Each change is saved as soon as a row loses focus. */
export default function SnippetsDialog(): ReactElement {
  const s = useStore()
  const scopeKey = s.snippetsOpen?.hostKey
  const host = scopeKey ? allInstances(s).find((i) => i.key === scopeKey) : undefined
  const [list, setList] = useState<Snippet[]>(() => {
    const cur = s.settings?.snippets ?? []
    return cur.length ? cur : [blank(scopeKey)]
  })
  const close = (): void => {
    void persist(list)
    s.set({ snippetsOpen: null })
  }
  const persist = async (next: Snippet[]): Promise<void> => {
    await s.saveSettings({ snippets: next.filter((x) => x.command.trim()).map((x) => ({ ...x, name: x.name.trim() || x.command.trim().split('\n')[0].slice(0, 40) })) })
  }
  const upd = (id: string, patch: Partial<Snippet>): void => setList((l) => l.map((x) => (x.id === id ? { ...x, ...patch } : x)))
  const hostName = (key?: string): string => (key ? (allInstances(s).find((i) => i.key === key)?.name ?? 'removed host') : 'All hosts')

  return (
    <Modal title="Snippets" onClose={close} width="max-w-2xl">
      <p className="muted mb-3 text-xs">
        Saved commands for SSH tabs: the <Icon.snippet className="inline" /> button in a terminal, or type <span className="mono">&gt;</span> in ⌘K. With <b>Run</b> on, Enter is pressed for you; off pastes the command so you can edit it first.
      </p>
      <div className="max-h-[55vh] space-y-2 overflow-y-auto pr-1">
        {list.map((x) => (
          <div key={x.id} className="panel-2 rounded-lg border border-default p-2" onBlur={() => void persist(list)}>
            <div className="mb-1.5 flex items-center gap-2">
              <input className="input !w-48" placeholder="Name" value={x.name} onChange={(e) => upd(x.id, { name: e.target.value })} />
              <select className="input !w-auto" value={x.hostKey ?? ''} onChange={(e) => upd(x.id, { hostKey: e.target.value || undefined })} title="Which hosts offer this snippet">
                <option value="">All hosts</option>
                {host && x.hostKey !== host.key && <option value={host.key}>Only {host.name}</option>}
                {x.hostKey && <option value={x.hostKey}>Only {hostName(x.hostKey)}</option>}
              </select>
              <label className="flex items-center gap-1 text-xs" title="Press Enter after typing the command">
                <input type="checkbox" checked={x.run} onChange={(e) => upd(x.id, { run: e.target.checked })} /> Run
              </label>
              <span className="flex-1" />
              <button className="btn btn-ghost btn-sm btn-icon" title="Delete snippet" onClick={() => { const next = list.filter((y) => y.id !== x.id); setList(next); void persist(next) }}>
                <Icon.x />
              </button>
            </div>
            <textarea className="input mono min-h-[44px] resize-y py-1.5 text-[11px]" rows={2} spellCheck={false} placeholder="sudo systemctl status nginx" value={x.command} onChange={(e) => upd(x.id, { command: e.target.value })} />
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button className="btn" onClick={() => setList((l) => [...l, blank(scopeKey)])}><Icon.plus /> Add snippet</button>
        <span className="flex-1" />
        <button className="btn btn-primary" onClick={close}>Done</button>
      </div>
    </Modal>
  )
}

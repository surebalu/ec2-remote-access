import { useState, type ReactElement } from 'react'
import { clearHostFilters } from '@shared/hostSearch'
import type { AttentionItem } from '@shared/workspaceSummary'
import { useStore } from '../../store'
import { Icon } from '../icons'

export default function Attention({ items }: { items: AttentionItem[] }): ReactElement {
  const s = useStore()
  const [expanded, setExpanded] = useState(false)
  const act = (item: AttentionItem): void => {
    if (item.kind === 'scan') void s.retryFailedScans()
    else if (item.kind === 'cached') void s.scan()
    else if (item.kind === 'session' && item.target) s.setActive(item.target)
    else if (item.kind === 'account' && item.target) {
      if (s.statuses[item.target]?.state === 'login-required') void s.login(item.target)
      else void s.checkAuth(item.target).catch((e: Error) => s.toast('error', e.message))
    }
    else if (item.kind === 'route') s.applyHostView({ ...clearHostFilters, stateFilter: 'running', reachFilter: 'unreachable' })
  }
  const actionLabel = (item: AttentionItem): string => item.kind === 'scan' ? 'Retry scans' : item.kind === 'cached' ? 'Refresh' : item.kind === 'account' ? s.statuses[item.target ?? '']?.state === 'login-required' ? 'Sign in' : 'Check access' : item.kind === 'session' ? 'Open session' : 'Show hosts'
  return <section className="hd-card ws-attention" aria-label="Needs attention">
    <div className="hd-card-head"><span><Icon.alert />Needs attention <b className="ws-count">{items.length}</b></span>
      {items.length > 2 && <button className="ws-text-action" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : 'Show all'}</button>}
    </div>
    {items.length ? <div className="ws-attention-list">
      {(expanded ? items : items.slice(0, 2)).map((item) => <div key={item.id} className="ws-attention-row">
        <div><strong>{item.title}</strong><p>{item.detail}</p></div>
        <button className="btn btn-sm" disabled={(s.scanning && (item.kind === 'scan' || item.kind === 'cached')) || (item.kind === 'account' && s.loggingIn)} onClick={() => act(item)}>{actionLabel(item)}</button>
      </div>)}
    </div> : <p className="ws-clear"><Icon.check /><span>No known connection or inventory issues.<small>Platform health is checked separately.</small></span></p>}
  </section>
}

import { useEffect, useState, type ReactElement } from 'react'
import type { HostViewFilters } from '@shared/hostViews'
import { clearHostFilters } from '@shared/hostSearch'
import { ago } from '@shared/plmHealth'
import { workspaceSummary } from '@shared/workspaceSummary'
import { routeOf, useStore, visibleInstances } from '../store'
import { Icon } from './icons'
import ContinueWorking from './workspace/ContinueWorking'
import Attention from './workspace/Attention'
import ToolDirectory from './workspace/ToolDirectory'
import SavedWork from './workspace/SavedWork'
import Platform from './workspace/Platform'
import './workspace/workspace.css'

const MODULES = ['Overview', 'Tools', 'Saved work', 'Platform'] as const
type Module = typeof MODULES[number]
const FOLD_KEY = 'ui.home.folded'
const readFolded = (): boolean => { try { return localStorage.getItem(FOLD_KEY) === '1' } catch { return false } }

/** A small workspace shell. Each module owns its content; the inventory and sessions keep their existing state. */
export default function HomeDeck(): ReactElement {
  const s = useStore()
  const [folded, setFolded] = useState(readFolded)
  const [module, setModule] = useState<Module>('Overview')
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer) }, [])
  const fold = (): void => { setFolded(!folded); try { localStorage.setItem(FOLD_KEY, folded ? '0' : '1') } catch { /* storage unavailable */ } }
  const summary = workspaceSummary({ hosts: visibleInstances(s), profiles: s.profiles, statuses: s.statuses, errors: s.scanErrors, sessions: s.tabs, route: (host) => routeOf(host, s.settings).route })
  const auth = s.authState()
  const accountLabel = auth.kind !== 'ok' ? auth.kind === 'expired' ? 'Sign in to AWS' : `Sign-in ends in ${auth.minutesLeft} min`
    : summary.accountState === 'none' ? 'No AWS accounts' : summary.accountState === 'attention' ? 'Review AWS access'
      : summary.accountState === 'verified' ? `${summary.verifiedAccounts} ${summary.verifiedAccounts === 1 ? 'account' : 'accounts'} verified` : 'AWS access unverified'
  const filter = (patch: Partial<HostViewFilters>): void => s.applyHostView({ ...clearHostFilters, ...patch })
  const moduleId = (name: Module): string => name.toLowerCase().replace(' ', '-')
  const accountAction = (): void => {
    if (auth.kind !== 'ok') void s.refreshToken()
    else if (!summary.accounts) s.set({ addAccountOpen: true })
    else void s.checkAuth().catch((e: Error) => s.toast('error', e.message))
  }
  return <section className={`home-deck workspace-deck ${folded ? 'folded' : ''}`} aria-label="Home">
    <header className="ws-header">
      <div><span className="ws-eyebrow">REMOTE ACCESS / WORKSPACE</span><h1>Your workspace</h1><p>{new Date(now).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })} <span>·</span> Across every enabled account</p></div>
      <div className="ws-header-actions">
        <button className="btn ws-find" onClick={() => s.openQuickSwitcher()}><Icon.search />Find anything <kbd>⌘K</kbd></button>
        <button className="btn btn-primary" onClick={() => s.set({ manualHostEditor: 'new' })}><Icon.plus />Add server</button>
        <button className="hd-fold" aria-expanded={!folded} aria-label={folded ? 'Show the home panel' : 'Fold the home panel'} title={folded ? 'Show workspace' : 'Focus on inventory'} onClick={fold}><Icon.caret /></button>
      </div>
    </header>
    {!folded && <>
      <div className="ws-metrics" aria-label="Workspace summary">
        <button className="ws-metric" onClick={() => filter({ stateFilter: 'running' })}><Icon.server /><span><strong>{summary.running}<small> / {summary.total}</small></strong><span>Hosts running</span></span></button>
        <button className="ws-metric" title="An available SSM or direct route. A connection has not been tested; cached hosts use their last known route." onClick={() => filter({ reachFilter: 'reachable' })}><Icon.shield /><span><strong>{summary.routes}</strong><span>Routes available</span></span></button>
        <button className="ws-metric" disabled={!summary.sessions} onClick={() => s.showGrid(true)}><Icon.grid /><span><strong>{summary.live}<small> / {summary.sessions}</small></strong><span>Sessions connected</span></span></button>
        <button className={`ws-metric ws-freshness ${summary.stale ? 'has-warning' : ''}`} disabled={s.scanning} onClick={() => void s.scan()} title="Refresh inventory across enabled accounts"><Icon.refresh className={s.scanning ? 'animate-spin' : ''} /><span><strong>{s.scanning ? 'Refreshing…' : s.scannedAt ? ago(s.scannedAt, now) : 'Not scanned'}</strong><span>{summary.stale ? `${summary.stale} cached · Refresh inventory` : 'Last scan · Refresh'}</span></span></button>
      </div>
      <div className="ws-module-bar">
        <div className="ws-tabs" role="tablist" aria-label="Workspace modules">
          {MODULES.map((name, index) => <button key={name} id={`workspace-tab-${moduleId(name)}`} role="tab" aria-selected={module === name} aria-controls={`workspace-panel-${moduleId(name)}`} tabIndex={module === name ? 0 : -1} onClick={() => setModule(name)} onKeyDown={(e) => {
            const next = e.key === 'ArrowRight' ? (index + 1) % MODULES.length : e.key === 'ArrowLeft' ? (index + MODULES.length - 1) % MODULES.length : e.key === 'Home' ? 0 : e.key === 'End' ? MODULES.length - 1 : -1
            if (next < 0) return
            e.preventDefault(); e.stopPropagation(); setModule(MODULES[next]); document.getElementById(`workspace-tab-${moduleId(MODULES[next])}`)?.focus()
          }}>{name}{name === 'Overview' && summary.issues.length > 0 && <span className="ws-tab-count">{summary.issues.length}</span>}</button>)}
        </div>
        <button className={`ws-account ${auth.kind !== 'ok' || summary.accountState === 'attention' ? 'attention' : ''}`} onClick={accountAction} title={auth.kind !== 'ok' ? 'Renew AWS sign-in' : 'Check enabled AWS accounts'}><i className={summary.accountState === 'verified' && auth.kind === 'ok' ? 'verified' : ''} />{accountLabel}</button>
      </div>
      {MODULES.map((name) => <div key={name} className="ws-module-content" id={`workspace-panel-${moduleId(name)}`} role="tabpanel" aria-labelledby={`workspace-tab-${moduleId(name)}`} tabIndex={0} hidden={module !== name}>
        {module === name && name === 'Overview' && <div className="ws-overview"><ContinueWorking /><Attention items={summary.issues} /></div>}
        {module === name && name === 'Tools' && <ToolDirectory />}
        {module === name && name === 'Saved work' && <SavedWork />}
        {module === name && name === 'Platform' && <Platform now={now} active={s.activeTab === 'hosts' && !s.gridView && !s.hostPage} />}
      </div>)}
      <footer className="ws-footer"><span><Icon.keyboard />A shortcut to every host, session and command</span><div>
        <button className="ws-text-action" onClick={() => void window.api.invoke('notes:daily').then((path) => s.openNotes(path), (e: Error) => s.toast('error', e.message))}><Icon.note />Today's note</button>
        <button className="ws-text-action" onClick={() => s.set({ portForwardFor: {} })}><Icon.plug />Forward a port</button>
      </div></footer>
    </>}
  </section>
}

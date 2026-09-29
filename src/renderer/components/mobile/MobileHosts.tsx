import { useMemo, useState, type ReactElement } from 'react'
import type { Instance } from '@shared/types'
import { filteredInstances, routeOf, useStore, visibleInstances } from '../../store'
import { groupKeyOf, metaFor } from '../../colors'
import { openFilesFor, openRdpFor, openSshFor } from '../../quickConnect'
import { Icon } from '../icons'
import Sheet, { SheetItem } from './Sheet'

function RouteChip({ i }: { i: Instance }): ReactElement {
  const settings = useStore((s) => s.settings)
  const r = routeOf(i, settings)
  const cls = r.route === 'direct' ? 'badge-ok' : r.route === 'ssm' ? 'badge-info' : r.route === 'not-running' ? 'badge-neutral' : 'badge-warn'
  const label = r.route === 'direct' ? 'Direct' : r.route === 'ssm' ? 'SSM' : r.route === 'not-running' ? i.state : 'Unreachable'
  return <span className={`badge ${cls}`}>{label}</span>
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }): ReactElement {
  return <button className={`filter-chip ${on ? 'active' : ''}`} aria-pressed={on} onClick={onClick}>{children}</button>
}

/** Host list for phones: search, filter chips, hosts grouped by account, tap for actions. */
export default function MobileHosts(): ReactElement {
  const s = useStore()
  const [actionsFor, setActionsFor] = useState<string | null>(null)
  const favs = new Set(s.settings?.favorites ?? [])
  const total = visibleInstances(s).length

  const groups = useMemo(() => {
    const rows = filteredInstances(s).sort((a, b) => Number(favs.has(b.key)) - Number(favs.has(a.key)) || a.name.localeCompare(b.name, undefined, { numeric: true }))
    const byKey = new Map<string, Instance[]>()
    for (const i of rows) {
      const k = groupKeyOf(i)
      byKey.set(k, [...(byKey.get(k) ?? []), i])
    }
    return [...byKey].map(([key, list]) => ({ key, ...metaFor(key, s.settings), list }))
      .sort((a, b) => Number(a.key.startsWith('group:')) - Number(b.key.startsWith('group:')) || a.label.localeCompare(b.label))
  }, [s.instances, s.profiles, s.search, s.profileFilter, s.favoritesOnly, s.osFilter, s.stateFilter, s.reachFilter, s.settings]) // eslint-disable-line react-hooks/exhaustive-deps

  const accounts = useMemo(() => [...new Set(visibleInstances(s).map(groupKeyOf))].map((k) => ({ key: k, ...metaFor(k, s.settings) })).sort((a, b) => a.label.localeCompare(b.label)),
    [s.instances, s.profiles, s.settings]) // eslint-disable-line react-hooks/exhaustive-deps
  const shown = groups.reduce((n, g) => n + g.list.length, 0)
  const target = actionsFor ? visibleInstances(s).find((i) => i.key === actionsFor) : undefined

  return (
    <div className="m-hosts">
      <div className="m-search">
        <Icon.search className="muted" />
        <input
          type="search"
          inputMode="search"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Search name, IP, tag…"
          aria-label="Search hosts"
          value={s.search}
          onChange={(e) => s.set({ search: e.target.value })}
        />
        {s.search && <button className="muted" aria-label="Clear search" onClick={() => s.set({ search: '' })}><Icon.x /></button>}
      </div>
      <div className="m-chips">
        <Chip on={s.stateFilter === 'running'} onClick={() => s.set({ stateFilter: s.stateFilter === 'running' ? 'all' : 'running' })}>Running</Chip>
        <Chip on={s.favoritesOnly} onClick={() => s.set({ favoritesOnly: !s.favoritesOnly })}><Icon.star /> Favorites</Chip>
        <Chip on={s.osFilter === 'linux'} onClick={() => s.set({ osFilter: s.osFilter === 'linux' ? 'all' : 'linux' })}><Icon.linux /> Linux</Chip>
        <Chip on={s.osFilter === 'windows'} onClick={() => s.set({ osFilter: s.osFilter === 'windows' ? 'all' : 'windows' })}><Icon.windows /> Windows</Chip>
        {accounts.length > 1 && accounts.map((a) => (
          <span key={a.key} data-accent={a.color} className="contents">
            <Chip on={s.profileFilter === a.key} onClick={() => s.set({ profileFilter: s.profileFilter === a.key ? null : a.key })}>
              <span className="m-dot" style={{ background: 'var(--c)' }} /> {a.label}
            </Chip>
          </span>
        ))}
      </div>
      <div className="m-count muted">
        {s.scanning ? 'Scanning…' : `${shown} of ${total} hosts`}
        {s.scannedAt && !s.scanning && <> · updated {new Date(s.scannedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</>}
      </div>
      {groups.map((g) => (
        <section key={g.key} className="m-group" data-accent={g.color}>
          <h3 className="m-group-title"><span className="m-dot" style={{ background: 'var(--c)' }} />{g.label}<span className="muted mono">{g.list.length}</span></h3>
          <div className="m-card-list">
            {g.list.map((i) => (
              <button key={i.key} className="m-host" data-host-key={i.key} onClick={() => setActionsFor(i.key)}>
                <span className={`m-host-os ${i.state === 'running' ? '' : 'off'}`}>{i.platform === 'windows' ? <Icon.windows /> : <Icon.linux />}</span>
                <span className="min-w-0 flex-1 text-left">
                  <span className="m-host-name">{favs.has(i.key) && <Icon.star filled className="m-fav" />}{i.name}</span>
                  <span className="m-host-meta mono">{i.publicIp ?? i.privateIp ?? i.instanceId}{i.staleReason ? ' · cached' : ''}</span>
                </span>
                <RouteChip i={i} />
                <Icon.chevron className="muted" />
              </button>
            ))}
          </div>
        </section>
      ))}
      {!groups.length && (
        <div className="m-empty">
          <p>{total ? 'No hosts match these filters.' : s.scanning ? 'Scanning your AWS accounts…' : 'No hosts yet. Scan to load your EC2 instances.'}</p>
          {total > 0 ? <button className="btn" onClick={() => s.clearFilters()}>Clear filters</button> : !s.scanning && <button className="btn btn-primary" onClick={() => void s.scan()}>Scan now</button>}
        </div>
      )}
      {target && <HostActionsSheet i={target} onClose={() => setActionsFor(null)} />}
    </div>
  )
}

function HostActionsSheet({ i, onClose }: { i: Instance; onClose: () => void }): ReactElement {
  const s = useStore()
  const r = routeOf(i, s.settings)
  const reachable = r.route === 'ssm' || r.route === 'direct'
  const fav = s.isFavorite(i.key)
  const run = (fn: () => void): void => { onClose(); fn() }
  const open = s.tabs.filter((t) => t.instanceKey === i.key)
  return (
    <Sheet
      title={<>{i.platform === 'windows' ? <Icon.windows /> : <Icon.linux />} {i.name}</>}
      subtitle={<span className="mono">{[i.instanceId, i.instanceType, i.region, i.publicIp ?? i.privateIp].filter(Boolean).join(' · ')}<br /><span className="not-mono">{r.reason}</span></span>}
      onClose={onClose}
    >
      {open.map((t) => (
        <SheetItem key={t.id} icon={t.kind === 'rdp' ? <Icon.monitor /> : t.kind === 'sftp' ? <Icon.folder /> : <Icon.terminal />} hint="open" onClick={() => run(() => s.setActive(t.id))}>
          Switch to {t.kind === 'rdp' ? 'desktop' : t.kind === 'sftp' ? 'files' : 'terminal'}
        </SheetItem>
      ))}
      {i.platform === 'windows' && <SheetItem icon={<Icon.monitor />} disabled={!reachable} onClick={() => run(() => void openRdpFor(i.key))}>Remote desktop</SheetItem>}
      <SheetItem icon={<Icon.terminal />} disabled={!reachable} onClick={() => run(() => openSshFor(i.key))}>SSH terminal</SheetItem>
      <SheetItem icon={<Icon.folder />} disabled={!reachable} onClick={() => run(() => openFilesFor(i.key))}>Files (SFTP)</SheetItem>
      <SheetItem icon={<Icon.settings />} onClick={() => run(() => s.set({ connectFor: { kind: i.platform === 'windows' ? 'rdp' : 'ssh', key: i.key } }))}>Connect with options…</SheetItem>
      <SheetItem icon={<Icon.star />} onClick={() => run(() => void s.toggleFavorite(i.key))}>{fav ? 'Remove from favorites' : 'Add to favorites'}</SheetItem>
    </Sheet>
  )
}

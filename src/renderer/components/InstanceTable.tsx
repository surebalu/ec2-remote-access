import type { ReactElement } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { matchesHost } from '@shared/hostSearch'
import type { Instance } from '@shared/types'
import { allInstances, routeOf, useStore, visibleInstances } from '../store'
import { openDefaultFor, openFilesFor, openRdpFor, openSshFor } from '../quickConnect'
import { Icon } from './icons'
import { groupKeyOf, metaFor } from '../colors'
import type { GroupBy, Instance as Inst } from '@shared/types'
import HostFilters, { ScanNotice } from './HostFilters'

type SortKey = 'name' | 'profile' | 'state' | 'osHint' | 'publicIp' | 'privateIp' | 'instanceType'

function RouteBadge({ i }: { i: Instance }): ReactElement {
  const settings = useStore((s) => s.settings)
  const r = routeOf(i, settings)
  const cls = r.route === 'direct' ? 'badge-ok' : r.route === 'ssm' ? 'badge-info' : r.route === 'not-running' ? 'badge-neutral' : 'badge-warn'
  const label = r.route === 'direct' ? 'Direct' : r.route === 'ssm' ? 'SSM' : r.route === 'not-running' ? i.state : 'Unreachable'
  return (
    <span className={`badge ${cls}`} title={r.reason}>
      {r.route === 'ssm' && <Icon.shield />}
      {label}
    </span>
  )
}

function OsBadge({ i }: { i: Instance }): ReactElement {
  return (
    <span className="inline-flex items-center gap-1.5" title={i.platformDetails}>
      <span className="text-2">{i.platform === 'windows' ? <Icon.windows /> : <Icon.linux />}</span>
      {i.osHint}
    </span>
  )
}

export default function InstanceTable(): ReactElement {
  const s = useStore()
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 })
  const [menu, setMenu] = useState<{ x: number; y: number; key: string } | null>(null)
  const tableRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const row = [...(tableRef.current?.querySelectorAll<HTMLElement>('[data-host-key]') ?? [])].find((el) => el.dataset.hostKey === s.selectedKey)
    row?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [s.selectedKey, s.profileFilter, s.search, s.osFilter, s.stateFilter, s.reachFilter, s.settings?.collapsedGroups])

  const rows = useMemo(() => {
    const q = s.search.trim().toLowerCase()
    const favs = new Set(s.settings?.favorites ?? [])
    return visibleInstances(s)
      .filter((i) => (s.favoritesOnly ? favs.has(i.key) : true))
      .filter((i) => {
        if (!s.profileFilter) return true
        if (s.profileFilter.startsWith('group:')) return !!i.manual && i.region === s.profileFilter.slice(6)
        return i.profile === s.profileFilter
      })
      .filter((i) => (s.osFilter === 'all' ? true : i.platform === s.osFilter))
      .filter((i) => (s.stateFilter === 'all' ? true : i.state === 'running'))
      .filter((i) => {
        if (s.reachFilter === 'all') return true
        const r = routeOf(i, s.settings).route
        return s.reachFilter === 'reachable' ? r === 'direct' || r === 'ssm' : r === 'unreachable'
      })
      .filter((i) => {
        if (!q) return true
        return matchesHost(i, q)
      })
      .sort((a, b) => {
        if ((s.settings?.groupBy ?? 'account') === 'none') {
          const fa = favs.has(a.key) ? 0 : 1
          const fb = favs.has(b.key) ? 0 : 1
          if (fa !== fb) return fa - fb
        }
        const av = String(a[sort.key] ?? '')
        const bv = String(b[sort.key] ?? '')
        return av.localeCompare(bv, undefined, { numeric: true }) * sort.dir || a.name.localeCompare(b.name)
      })
  }, [s.instances, s.profiles, s.search, s.profileFilter, s.favoritesOnly, s.osFilter, s.stateFilter, s.reachFilter, s.settings, sort]) // eslint-disable-line react-hooks/exhaustive-deps

  const groupBy: GroupBy = s.settings?.groupBy ?? 'account'
  const favs = new Set(s.settings?.favorites ?? [])
  const collapsed = new Set(s.settings?.collapsedGroups ?? [])
  const q = s.search.trim()
  const groups = useMemo(() => {
    const out: { key: string; label: string; color: string; rows: Inst[]; kind: 'fav' | 'group' }[] = []
    const byKey = new Map<string, Inst[]>()
    const favRows: Inst[] = []
    for (const i of rows) {
      if (favs.has(i.key) && groupBy !== 'none') favRows.push(i)
      const k = groupBy === 'account' ? groupKeyOf(i) : groupBy === 'os' ? `os:${i.platform}` : 'all'
      if (!byKey.has(k)) byKey.set(k, [])
      byKey.get(k)!.push(i)
    }
    if (favRows.length) out.push({ key: 'fav', label: 'Favorites', color: 'amber', rows: favRows, kind: 'fav' })
    // The Favorites view is a single flat list; repeating the same hosts under their account groups only confuses.
    if (s.favoritesOnly && groupBy !== 'none') return out
    if (groupBy === 'account' && !q) {
      for (const f of s.settings?.manualFolders ?? []) {
        const k = `group:${f}`
        if (!byKey.has(k) && (!s.profileFilter || s.profileFilter === k || s.profileFilter === 'servers') && s.osFilter === 'all' && !s.favoritesOnly) byKey.set(k, [])
      }
    }
    for (const [k, list] of byKey) {
      if (groupBy === 'none') out.push({ key: 'all', label: 'All hosts', color: 'slate', rows: list, kind: 'group' })
      else if (groupBy === 'os') out.push({ key: k, label: k === 'os:windows' ? 'Windows' : k === 'os:linux' ? 'Linux' : 'Other', color: k === 'os:windows' ? 'sky' : 'emerald', rows: list, kind: 'group' })
      else {
        const m = metaFor(k, s.settings)
        out.push({ key: k, label: m.label, color: m.color, rows: list, kind: 'group' })
      }
    }
    // Favorites first, then groups by label; manual-host groups after AWS accounts.
    out.sort((a, b) => (a.kind === 'fav' ? -1 : b.kind === 'fav' ? 1 : Number(a.key.startsWith('group:')) - Number(b.key.startsWith('group:')) || a.label.localeCompare(b.label)))
    return out
  }, [rows, groupBy, s.settings]) // eslint-disable-line react-hooks/exhaustive-deps
  const groupKeys = groups.map((g) => g.key)

  const th = (key: SortKey, label: string, cls = ''): ReactElement => (
    <th className={`sortable select-none ${cls}`} aria-sort={sort.key === key ? sort.dir === 1 ? 'ascending' : 'descending' : 'none'}>
      <button onClick={() => setSort((p) => ({ key, dir: p.key === key ? ((p.dir * -1) as 1 | -1) : 1 }))}>{label} <span className="opacity-70">{sort.key === key ? (sort.dir === 1 ? '↑' : '↓') : ''}</span></button>
    </th>
  )

  const copy = async (text: string | undefined, what: string): Promise<void> => {
    if (!text) return
    await window.api.invoke('clipboard:write', text)
    s.toast('success', `${what} copied`)
  }

  /** Account-level SSH defaults make the SSH button connect immediately; shift-click always opens the dialog. */
  const quickSsh = (i: Instance, ev?: { shiftKey?: boolean }): void => openSshFor(i.key, !!ev?.shiftKey)

  const canConnect = (i: Instance): boolean => {
    const r = routeOf(i, s.settings).route
    return r === 'direct' || r === 'ssm'
  }

  const power = async (i: Instance, action: 'start' | 'stop'): Promise<void> => {
    if (!window.confirm(`${action === 'start' ? 'Start' : 'Stop'} ${i.name} (${i.instanceId}) in ${i.profile}?`)) return
    try {
      await window.api.invoke(action === 'start' ? 'ec2:start' : 'ec2:stop', i.key)
      s.toast('success', `${action === 'start' ? 'Starting' : 'Stopping'} ${i.name}. Rescan in a minute.`)
    } catch (e) {
      s.toast('error', (e as Error).message)
    }
  }

  return (
    <div className="flex h-full flex-col" onClick={() => setMenu(null)}>
      <div className="flex flex-wrap items-center gap-3 px-4 py-2.5">
        <div className="relative min-w-52 flex-1 max-w-md">
          <span className="muted pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2">
            <Icon.search />
          </span>
          <input
            className="input !pl-8"
            aria-label="Search hosts"
            placeholder="Search name, IP, region, tag…"
            value={s.search}
            onChange={(e) => s.set({ search: e.target.value })}
          />
        </div>
        <span className="muted text-[11px]">
          <span className="mono text-2 font-semibold">{rows.length}</span> of {visibleInstances(s).length} hosts
          {s.profileFilter && <span> · {s.profileFilter}</span>}
        </span>
        <span className="flex-1" />
        <div className="flex flex-wrap items-center gap-1">
          <span className="muted text-[11px]">Group by</span>
          <div className="seg">
            {(
              [
                ['account', 'Environment'],
                ['os', 'OS'],
                ['none', 'None']
              ] as [GroupBy, string][]
            ).map(([v, l]) => (
              <button key={v} className={groupBy === v ? 'on' : ''} onClick={() => void s.saveSettings({ groupBy: v })}>
                {l}
              </button>
            ))}
          </div>
          <button className="btn btn-ghost btn-sm" title="Collapse all" disabled={groupBy === 'none'} onClick={() => void s.setAllGroups(groupKeys, true)}>
            <Icon.chevron /> Collapse
          </button>
          <button className="btn btn-ghost btn-sm" title="Expand all" disabled={groupBy === 'none'} onClick={() => void s.setAllGroups(groupKeys, false)}>
            <Icon.chevron open /> Expand
          </button>
        </div>
      </div>
      <HostFilters />
      <ScanNotice />
      <div ref={tableRef} className="panel mx-4 mb-3 min-h-0 flex-1 overflow-auto rounded-lg border" style={{ borderColor: 'var(--border)' }}>
        <table className="w-full text-xs">
          <thead>
            <tr>
              {th('name', 'Name')}
              {th('profile', 'Account')}
              {th('osHint', 'OS')}
              {th('state', 'State')}
              {th('publicIp', 'Public IP')}
              {th('privateIp', 'Private IP')}
              {th('instanceType', 'Type', 'col-type')}
              <th>Route</th>
              <th className="!text-right">Actions</th>
            </tr>
          </thead>
          {groups.map((g) => {
            const isCollapsed = groupBy !== 'none' && collapsed.has(g.key)
            return (
          <tbody key={g.key} data-accent={g.color}>
            {groupBy !== 'none' && (
              <tr className="group-row">
                <td colSpan={9}>
                  <div className="group-head" onClick={() => void s.toggleGroup(g.key)}>
                    <span className="chev">
                      <Icon.chevron open={!isCollapsed} />
                    </span>
                    {g.kind === 'fav' ? <Icon.star filled className="text-[var(--c)]" /> : <span className="avatar sm">{g.label.slice(0, 2).toUpperCase()}</span>}
                    <span className="group-title">{g.label}</span>
                    {g.kind === 'group' && groupBy === 'account' && !g.key.startsWith('group:') && g.key.toLowerCase() !== g.label.toLowerCase() && <span className="env-chip">{g.key}</span>}
                    {g.key.startsWith('group:') && (
                      <button
                        className="btn btn-ghost btn-sm"
                        title="Add a server to this folder"
                        onClick={(e) => {
                          e.stopPropagation()
                          s.set({ manualHostEditor: 'new', manualHostFolder: g.key.slice(6) })
                        }}
                      >
                        <Icon.plus /> Add server
                      </button>
                    )}
                    <span className="group-count">{g.rows.length} host{g.rows.length === 1 ? '' : 's'}</span>
                    <span className="flex-1" />
                    <span className="mono muted text-[10px]">
                      {g.rows.filter((r) => routeOf(r, s.settings).route !== 'unreachable' && routeOf(r, s.settings).route !== 'not-running').length} with route
                    </span>
                  </div>
                </td>
              </tr>
            )}
            {!isCollapsed && g.rows.length === 0 && (
              <tr>
                <td colSpan={9} className="muted px-12 py-3 text-[11px]">
                  Empty folder.{' '}
                  <button className="underline" onClick={() => s.set({ manualHostEditor: 'new', manualHostFolder: g.key.slice(6) })}>
                    Add a server
                  </button>
                </td>
              </tr>
            )}
            {!isCollapsed && g.rows.map((i) => (
              <tr
                key={i.key}
                data-host-key={i.key}
                className={`row in-group ${s.selectedKey === i.key ? 'selected' : ''}`}
                onClick={(e) => { if (!(e.target as HTMLElement).closest('button')) s.set({ selectedKey: i.key, detailsFor: i.key }) }}
                onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest('button')) canConnect(i) && openDefaultFor(i.key) }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  s.set({ selectedKey: i.key })
                  setMenu({ x: e.clientX, y: e.clientY, key: i.key })
                }}
              >
                <td>
                  <div className="flex items-center gap-2">
                    <button
                      className={`star ${s.isFavorite(i.key) ? 'on' : ''}`}
                      title={s.isFavorite(i.key) ? 'Remove from favorites' : 'Add to favorites'}
                      onClick={(e) => {
                        e.stopPropagation()
                        void s.toggleFavorite(i.key)
                      }}
                    >
                      <Icon.star filled={s.isFavorite(i.key)} />
                    </button>
                    <div className="min-w-0 max-w-[230px]">
                      <button className="block max-w-full truncate text-left font-medium leading-4 hover:underline" title={`View details for ${i.name}; double-click to connect`} onClick={() => s.set({ selectedKey: i.key, detailsFor: i.key })} onDoubleClick={() => canConnect(i) && openDefaultFor(i.key)}>
                        {i.name}
                      </button>
                      <div className="mono muted truncate text-[10px] leading-4">{i.instanceId}</div>
                      {i.staleReason && <span className="badge badge-warn !px-1.5 !py-0" title={`Last verified ${i.lastSeenAt ? new Date(i.lastSeenAt).toLocaleString() : 'on a previous scan'}: ${i.staleReason}`}>Cached</span>}
                    </div>
                  </div>
                </td>
                <td>
                  {(() => {
                    const m = metaFor(groupKeyOf(i), s.settings)
                    return (
                      <div className="flex items-center gap-2" data-accent={m.color}>
                        <span className="avatar sm">{m.label.slice(0, 2).toUpperCase()}</span>
                        <div>
                          <div className="leading-4">{i.manual ? i.region : i.profile}</div>
                          <div className="muted text-[10px] leading-4">{i.manual ? 'manual' : i.region}</div>
                        </div>
                      </div>
                    )
                  })()}
                </td>
                <td>
                  <OsBadge i={i} />
                </td>
                <td>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="dot" style={{ background: i.state === 'running' ? 'var(--ok)' : i.state === 'stopped' ? 'var(--muted)' : 'var(--warn)' }} />
                    <span className={i.state === 'running' ? '' : 'muted'}>{i.state}</span>
                  </span>
                </td>
                <td className="mono">
                  {i.publicIp ? (
                    <button className="hover:underline" title="Copy" onClick={() => void copy(i.publicIp, 'Public IP')}>
                      {i.publicIp}
                    </button>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="mono">
                  <button className="hover:underline" title="Copy" onClick={() => void copy(i.privateIp, 'Private IP')}>
                    {i.privateIp ?? '—'}
                  </button>
                </td>
                <td className="mono text-2 col-type">{i.manual ? <span className="muted font-sans">{i.tags.Notes ?? ''}</span> : i.instanceType}</td>
                <td>
                  <RouteBadge i={i} />
                </td>
                <td className="row-actions text-right whitespace-nowrap">
                  {(i.platform !== 'windows' || i.manual) && (
                    <button
                      className="btn btn-sm btn-ssh mr-1"
                      disabled={!canConnect(i)}
                      title={s.settings?.profileDefaults?.[i.profile]?.identityFile ? 'Connect now (shift-click for options)' : 'Connect…'}
                      onClick={(e) => quickSsh(i, e)}
                    >
                      <Icon.terminal /> SSH
                    </button>
                  )}
                  <button className="btn btn-sm btn-rdp mr-1" disabled={!canConnect(i)} title="Remote desktop (connects with saved credentials; shift-click for options)" onClick={(e) => void openRdpFor(i.key, e.shiftKey)}>
                    <Icon.monitor /> RDP
                  </button>
                  {(i.platform !== 'windows' || i.manual) && (
                    <button className="btn btn-sm mr-1" disabled={!canConnect(i)} title="Browse and transfer files over SFTP (shift-click for options)" onClick={(e) => openFilesFor(i.key, e.shiftKey)}>
                      <Icon.folder /> Files
                    </button>
                  )}
                  {i.platform === 'windows' && !i.manual && (
                    <button className="btn btn-sm btn-icon mr-1" title="Retrieve Windows administrator password" onClick={() => s.set({ passwordFor: i.key })}>
                      <Icon.key />
                    </button>
                  )}
                  {i.manual && (
                    <button className="btn btn-sm btn-icon" title="Edit server" onClick={() => s.set({ manualHostEditor: i.key.replace('manual/', '') })}>
                      <Icon.edit />
                    </button>
                  )}
                  {i.state === 'stopped' && (
                    <button className="btn btn-sm btn-icon" title="Start instance" onClick={() => void power(i, 'start')}>
                      <Icon.play />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
            )
          })}
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="muted px-4 py-16 text-center">
                  {allInstances(s).length === 0
                    ? s.scanning
                      ? 'Scanning your AWS accounts…'
                      : 'No instances yet. Click Rescan.'
                    : s.favoritesOnly && !(s.settings?.favorites ?? []).length
                      ? 'No favorites yet. Click the ☆ next to a machine name to pin it to the top.'
                      : 'No instances match the current filters.'}
                  {allInstances(s).length > 0 && <div className="mt-3"><button className="btn" onClick={s.clearFilters}>Clear filters</button></div>}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {menu && allInstances(s).some((i) => i.key === menu.key) && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          instance={allInstances(s).find((i) => i.key === menu.key)!}
          onClose={() => setMenu(null)}
          onPower={power}
          copy={copy}
        />
      )}
    </div>
  )
}

function ContextMenu({
  x,
  y,
  instance: i,
  onClose,
  onPower,
  copy
}: {
  x: number
  y: number
  instance: Instance
  onClose: () => void
  onPower: (i: Instance, a: 'start' | 'stop') => Promise<void>
  copy: (t: string | undefined, w: string) => Promise<void>
}): ReactElement {
  const s = useStore()
  const reachable = ['direct', 'ssm'].includes(routeOf(i, s.settings).route)
  const item = (label: string, fn: () => void, disabled = false): ReactElement => (
    <button
      disabled={disabled}
      className="block w-full px-3 py-1.5 text-left hover:bg-[var(--accent)] hover:text-white disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-inherit"
      onClick={() => {
        onClose()
        fn()
      }}
    >
      {label}
    </button>
  )
  return (
    <div className="panel modal fixed z-50 min-w-56 border py-1 text-xs" style={{ left: x, top: y, borderRadius: 10 }} onClick={(e) => e.stopPropagation()}>
      <div className="section-title px-3 py-1.5">{i.name}</div>
      {item('Host details', () => s.revealHost(i.key))}
      {(i.platform !== 'windows' || i.manual) && item('SSH with options…', () => s.set({ connectFor: { kind: 'ssh', key: i.key } }), i.state !== 'running')}
      {(i.platform !== 'windows' || i.manual) &&
        item(`SSH in ${s.settings?.externalTerminal ?? 'Terminal'}`, async () => {
          try {
            await window.api.invoke('ssh:external', { instanceKey: i.key, cols: 80, rows: 24 })
          } catch (e) {
            s.toast('error', (e as Error).message)
          }
        }, !reachable)}
      {item('RDP with options…', () => s.set({ connectFor: { kind: 'rdp', key: i.key } }), i.state !== 'running')}
      {item('Files (SFTP)…', () => s.set({ connectFor: { kind: 'sftp', key: i.key } }), i.state !== 'running')}
      {i.platform === 'windows' && !i.manual && item('Get Windows password', () => s.set({ passwordFor: i.key }))}
      {i.manual && item('Edit server…', () => s.set({ manualHostEditor: i.key.replace('manual/', '') }))}
      {i.manual &&
        item('Remove server', async () => {
          if (window.confirm(`Remove "${i.name}" from your servers?`)) await s.deleteManualHost(i.key.replace('manual/', ''))
        })}
      <div className="my-1 border-t" style={{ borderColor: 'var(--border)' }} />
      {item(s.isFavorite(i.key) ? '★ Remove from favorites' : '☆ Add to favorites', () => void s.toggleFavorite(i.key))}
      {item('Copy instance ID', () => void copy(i.instanceId, 'Instance ID'))}
      {item('Copy public IP', () => void copy(i.publicIp, 'Public IP'), !i.publicIp)}
      {item('Copy private IP', () => void copy(i.privateIp, 'Private IP'), !i.privateIp)}
      {!i.manual &&
        item('Copy SSM CLI command', () =>
          void copy(`aws ssm start-session --target ${i.instanceId} --profile ${i.profile} --region ${i.region}`, 'Command')
        )}
      {!i.manual && <div className="my-1 border-t" style={{ borderColor: 'var(--border)' }} />}
      {!i.manual && i.state === 'stopped' && item('Start instance', () => void onPower(i, 'start'))}
      {!i.manual && i.state === 'running' && item('Stop instance…', () => void onPower(i, 'stop'))}
    </div>
  )
}

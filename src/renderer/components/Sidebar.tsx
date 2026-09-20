import { useEffect, useState, type ReactElement } from 'react'
import { routeOf, useStore, visibleInstances, type OsFilter, type ReachFilter, type StateFilter } from '../store'
import { MANUAL_PROFILE, manualKey } from '@shared/manual'
import { openDefaultFor } from '../quickConnect'
import { metaFor } from '../colors'
import { Icon } from './icons'

function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }): ReactElement {
  return (
    <div className="seg">
      {options.map(([v, label]) => (
        <button key={v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  )
}

const authColor: Record<string, string> = {
  ok: 'var(--ok)',
  checking: 'var(--warn)',
  'login-required': 'var(--warn)',
  error: 'var(--err)',
  unknown: 'var(--muted)'
}

export default function Sidebar(): ReactElement {
  const s = useStore()
  const counts = new Map<string, number>()
  let running = 0
  let reachable = 0
  const instances = visibleInstances(s)
  const manualCount = s.settings?.manualHosts.length ?? 0
  for (const i of instances) {
    counts.set(i.profile, (counts.get(i.profile) ?? 0) + 1)
    if (i.state === 'running') running++
    const r = routeOf(i, s.settings).route
    if (r === 'direct' || r === 'ssm') reachable++
  }
  const errorsFor = (p: string): string[] => s.scanErrors.filter((e) => e.profile === p).map((e) => `${e.region}: ${e.message}`)
  const scanned = Object.values(s.progress)
  const done = scanned.filter((p) => p.status !== 'running').length

  // Cmd+B toggles the sidebar. Listened on document so the RDP key guard on window cannot swallow it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        useStore.getState().toggleSidebar()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  /** Filter clicks always land on the Hosts view, even while a session tab is in front. */
  const nav = (patch: Parameters<typeof s.set>[0]): void => s.set({ ...patch, activeTab: 'hosts' })

  // Folders in "Other servers" can expand to list their servers; remembered per machine.
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('ui.expandedFolders') ?? '[]') as string[])
    } catch {
      return new Set()
    }
  })
  const toggleFolder = (f: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(f)) next.delete(f)
      else next.add(f)
      try {
        localStorage.setItem('ui.expandedFolders', JSON.stringify(Array.from(next)))
      } catch {
        /* storage unavailable */
      }
      return next
    })
  }
  /** Starred hosts (AWS and own servers): click selects in the Favorites view, double-click connects. */
  const favoriteHosts = (): ReactElement | null => {
    const favs = new Set(s.settings?.favorites ?? [])
    const hosts = instances.filter((i) => favs.has(i.key)).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    if (!hosts.length) return <div className="muted mb-1 ml-6 text-[11px]">No starred hosts yet. Use the ★ in the table.</div>
    return (
      <ul className="mb-1 ml-6 space-y-px">
        {hosts.map((i) => (
          <li key={i.key}>
            <button
              className={`nav-row w-full py-1 text-left text-[11px] ${s.selectedKey === i.key && s.favoritesOnly ? 'on' : ''} ${i.state === 'running' ? '' : 'opacity-60'}`}
              title={`${i.manual ? i.instanceId : `${i.instanceId} · ${i.profile}`} · ${i.state}\nDouble-click to open ${i.platform === 'windows' ? 'RDP' : 'SSH'}`}
              onClick={() => nav({ favoritesOnly: true, profileFilter: null, selectedKey: i.key })}
              onDoubleClick={() => i.state === 'running' && openDefaultFor(i.key)}
            >
              <span className="dot" style={{ background: i.state === 'running' ? 'var(--ok)' : 'var(--muted)' }} />
              {i.platform === 'windows' ? <Icon.windows className="muted" /> : <Icon.linux className="muted" />}
              <span className="min-w-0 flex-1 truncate">{i.name || i.instanceId}</span>
            </button>
          </li>
        ))}
      </ul>
    )
  }

  /** Instances of an AWS account as rows (running first): click selects in the table, double-click connects. */
  const accountHosts = (profile: string): ReactElement | null => {
    const hosts = s.instances
      .filter((i) => i.profile === profile && i.state !== 'terminated')
      .sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running') || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    if (!hosts.length) return <div className="muted mb-1 ml-6 text-[11px]">No instances scanned yet.</div>
    return (
      <ul className="mb-1 ml-6 space-y-px">
        {hosts.map((i) => (
          <li key={i.key}>
            <button
              className={`nav-row w-full py-1 text-left text-[11px] ${s.selectedKey === i.key && s.profileFilter === profile ? 'on' : ''} ${i.state === 'running' ? '' : 'opacity-60'}`}
              title={`${i.instanceId} · ${i.state}${i.privateIp ? ` · ${i.privateIp}` : ''}${i.publicIp ? ` · ${i.publicIp}` : ''}\nDouble-click to open ${i.platform === 'windows' ? 'RDP' : 'SSH'}`}
              onClick={() => nav({ profileFilter: profile, favoritesOnly: false, selectedKey: i.key })}
              onDoubleClick={() => i.state === 'running' && openDefaultFor(i.key)}
            >
              <span className="dot" style={{ background: i.state === 'running' ? 'var(--ok)' : 'var(--muted)' }} />
              {i.platform === 'windows' ? <Icon.windows className="muted" /> : <Icon.linux className="muted" />}
              <span className="min-w-0 flex-1 truncate">{i.name || i.instanceId}</span>
            </button>
          </li>
        ))}
      </ul>
    )
  }

  /** Servers of a folder as rows: click selects it in the table, double-click connects (SSH for Linux, RDP for Windows). */
  const folderHosts = (f: string, filterKey: string): ReactElement | null => {
    const hosts = (s.settings?.manualHosts ?? []).filter((h) => h.group === f)
    if (!hosts.length) return null
    return (
      <ul className="mb-1 ml-7 space-y-px">
        {hosts.map((h) => {
          const key = manualKey(h.id)
          return (
            <li key={h.id}>
              <button
                className={`nav-row w-full py-1 text-left text-[11px] ${s.selectedKey === key && s.profileFilter === filterKey ? 'on' : ''}`}
                title={`${h.host}\nDouble-click to open ${h.platform === 'windows' ? 'RDP' : 'SSH'}`}
                onClick={() => nav({ profileFilter: filterKey, favoritesOnly: false, selectedKey: key })}
                onDoubleClick={() => openDefaultFor(key)}
              >
                {h.platform === 'windows' ? <Icon.windows className="muted" /> : <Icon.linux className="muted" />}
                <span className="min-w-0 flex-1 truncate">{h.name}</span>
                <span className="mono muted max-w-24 truncate text-[10px]">{h.host}</span>
              </button>
            </li>
          )
        })}
      </ul>
    )
  }

  const themeIcon = s.settings?.theme === 'light' ? <Icon.sun /> : s.settings?.theme === 'dark' ? <Icon.moon /> : <Icon.auto />
  const cycleTheme = (): void => {
    const order = ['system', 'light', 'dark'] as const
    const cur = s.settings?.theme ?? 'system'
    void s.setTheme(order[(order.indexOf(cur) + 1) % order.length])
  }

  if (s.sidebarCollapsed) {
    const favCount = (s.settings?.favorites ?? []).filter((k) => instances.some((i) => i.key === k)).length
    return (
      <aside className="sidebar panel flex shrink-0 flex-col overflow-y-auto border-r py-2" style={{ borderColor: 'var(--border)' }}>
        <button className="rail-btn no-drag" title="Expand sidebar (⌘B)" onClick={() => s.toggleSidebar(false)}>
          <Icon.chevron />
        </button>
        <div className="rail-sep" />
        <button className={`rail-btn ${s.profileFilter === null && !s.favoritesOnly ? 'on' : ''}`} title={`All accounts · ${instances.length} hosts`} onClick={() => nav({ profileFilter: null, favoritesOnly: false })}>
          <Icon.cloud />
          {instances.length > 0 && <span className="count">{instances.length}</span>}
        </button>
        <button className={`rail-btn ${s.favoritesOnly ? 'on' : ''}`} title={`Favorites · ${favCount}`} onClick={() => nav({ favoritesOnly: !s.favoritesOnly })}>
          <Icon.star filled={s.favoritesOnly} />
          {favCount > 0 && <span className="count">{favCount}</span>}
        </button>
        {s.profiles.map((p) => {
          const st = s.statuses[p.name]
          const state = st?.state ?? 'unknown'
          const m = metaFor(p.name, s.settings)
          return (
            <button
              key={p.name}
              className={`rail-btn ${s.profileFilter === p.name ? 'on' : ''} ${p.enabled ? '' : 'opacity-50'}`}
              data-accent={m.color}
              title={`${m.label}${m.label.toLowerCase() !== p.name.toLowerCase() ? ` (${p.name})` : ''} · ${st?.accountId ?? p.accountId ?? p.kind} · ${p.region}\nCredentials: ${state}${counts.get(p.name) ? ` · ${counts.get(p.name)} hosts` : ''}`}
              onClick={() => nav({ profileFilter: p.name, favoritesOnly: false })}
            >
              <span className="relative">
                <span className="avatar">{m.label.slice(0, 2).toUpperCase()}</span>
                <span
                  className="dot absolute -right-0.5 -bottom-0.5 ring-2"
                  style={{ background: authColor[state], animation: state === 'checking' ? 'pulse 1.2s infinite' : undefined, ['--tw-ring-color' as string]: 'var(--panel)' }}
                />
              </span>
            </button>
          )
        })}
        {(manualCount > 0 || s.folders().length > 0) && <div className="rail-sep" />}
        {manualCount > 0 && (
          <button className={`rail-btn ${s.profileFilter === MANUAL_PROFILE ? 'on' : ''}`} title={`Other servers · ${manualCount}`} onClick={() => nav({ profileFilter: MANUAL_PROFILE, favoritesOnly: false })}>
            <Icon.server />
            <span className="count">{manualCount}</span>
          </button>
        )}
        {s.folders().map((f) => {
          const m = metaFor(`group:${f}`, s.settings)
          const key = `group:${f}`
          const n = (s.settings?.manualHosts ?? []).filter((h) => h.group === f).length
          return (
            <button key={f} className={`rail-btn ${s.profileFilter === key ? 'on' : ''}`} data-accent={m.color} title={`${f} · ${n} server(s)`} onClick={() => nav({ profileFilter: key, favoritesOnly: false })}>
              <span className="avatar sm">{f.slice(0, 2).toUpperCase()}</span>
            </button>
          )
        })}
        <div className="mt-auto">
          <div className="rail-sep" />
          <button className="rail-btn" disabled={s.scanning} title={s.scanning ? `Scanning… ${done}/${scanned.length} regions` : 'Rescan'} onClick={() => void s.scan()}>
            <Icon.refresh className={s.scanning ? 'animate-spin' : ''} />
          </button>
          <button className="rail-btn" disabled={s.loggingIn} title={s.loggingIn ? 'Waiting for SSO login…' : 'Refresh token (aws sso login)'} onClick={() => void s.refreshToken()}>
            <Icon.key />
          </button>
          <button className="rail-btn" title={`Theme: ${s.settings?.theme ?? 'system'} (click to switch)`} onClick={cycleTheme}>
            {themeIcon}
          </button>
          <button className="rail-btn" title="Settings" onClick={() => s.set({ settingsOpen: true })}>
            <Icon.settings />
          </button>
        </div>
      </aside>
    )
  }

  return (
    <aside className="sidebar panel flex shrink-0 flex-col overflow-y-auto border-r" style={{ borderColor: 'var(--border)' }}>
      {/* Summary */}
      <div className="grid grid-cols-3 gap-2 px-3 pt-3">
        {(
          [
            ['Hosts', instances.length, 'violet'],
            ['Running', running, 'emerald'],
            ['Reachable', reachable, 'sky']
          ] as [string, number, string][]
        ).map(([label, n, color]) => (
          <div key={label} className="stat" data-accent={color}>
            <div className="n">{n}</div>
            <div className="l">{label}</div>
          </div>
        ))}
      </div>

      {/* Accounts */}
      <div className="mt-4 flex items-center justify-between px-3">
        <span className="section-title">Accounts</span>
        <span className="flex items-center">
          <button className="btn btn-ghost btn-sm btn-icon" title="Re-check credentials" onClick={() => void s.checkAuth()}>
            <Icon.refresh />
          </button>
          <button className="btn btn-ghost btn-sm btn-icon" title="Add AWS account" onClick={() => s.set({ addAccountOpen: true })}>
            <Icon.plus />
          </button>
        </span>
      </div>
      <ul className="mt-1 space-y-0.5 px-2">
        <li>
          <button className={`nav-row w-full text-left ${s.profileFilter === null && !s.favoritesOnly ? 'on' : ''}`} onClick={() => nav({ profileFilter: null, favoritesOnly: false })}>
            <Icon.cloud className="muted" />
            <span className="flex-1">All accounts</span>
            <span className="mono muted text-[11px]">{instances.length}</span>
          </button>
        </li>
        <li>
          <div className={`nav-row !pl-1 ${s.favoritesOnly ? 'on' : ''}`}>
            <button className="muted flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-[var(--accent-soft-2)]" title={expanded.has('favorites') ? 'Collapse' : 'Show starred hosts'} onClick={() => toggleFolder('favorites')}>
              <Icon.chevron open={expanded.has('favorites')} />
            </button>
            <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => nav({ favoritesOnly: !s.favoritesOnly })} onDoubleClick={() => toggleFolder('favorites')}>
              <Icon.star className={s.favoritesOnly ? '' : 'muted'} filled={s.favoritesOnly} />
              <span className="flex-1">Favorites</span>
            </button>
            <span className="mono muted text-[11px]">{(s.settings?.favorites ?? []).filter((k) => instances.some((i) => i.key === k)).length}</span>
          </div>
          {expanded.has('favorites') && favoriteHosts()}
        </li>
        {s.profiles.length === 0 && (
          <li>
            <button className="nav-row muted w-full text-left" onClick={() => s.set({ addAccountOpen: true })}>
              <Icon.plus />
              <span className="flex-1">Add AWS account…</span>
            </button>
          </li>
        )}
        {s.profiles.map((p) => {
          const st = s.statuses[p.name]
          const errs = errorsFor(p.name)
          const state = st?.state ?? 'unknown'
          const openAcct = expanded.has(`profile:${p.name}`)
          return (
            <li key={p.name} className="group">
              <div className={`nav-row !pl-1 ${s.profileFilter === p.name ? 'on' : ''} ${p.enabled ? '' : 'opacity-50'}`}>
                <button className="muted flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-[var(--accent-soft-2)]" title={openAcct ? 'Collapse' : 'Show instances'} onClick={() => toggleFolder(`profile:${p.name}`)}>
                  <Icon.chevron open={openAcct} />
                </button>
                <input
                  type="checkbox"
                  className="no-drag"
                  checked={p.enabled}
                  title="Include in scans"
                  onChange={async (e) => {
                    const disabled = new Set(s.settings?.disabledProfiles ?? [])
                    if (e.target.checked) disabled.delete(p.name)
                    else disabled.add(p.name)
                    await s.saveSettings({ disabledProfiles: Array.from(disabled) })
                    await s.refreshProfiles()
                  }}
                />
                <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => nav({ profileFilter: p.name })} onDoubleClick={() => toggleFolder(`profile:${p.name}`)} data-accent={metaFor(p.name, s.settings).color}>
                  <span className="relative">
                    <span className="avatar">{metaFor(p.name, s.settings).label.slice(0, 2).toUpperCase()}</span>
                    <span
                      className="dot absolute -right-0.5 -bottom-0.5 ring-2"
                      style={{ background: authColor[state], animation: state === 'checking' ? 'pulse 1.2s infinite' : undefined, ['--tw-ring-color' as string]: 'var(--panel)' }}
                      title={state === 'ok' ? 'Credentials OK' : state}
                    />
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 leading-4">
                      <span className="truncate font-medium">{metaFor(p.name, s.settings).label}</span>
                      {metaFor(p.name, s.settings).label.toLowerCase() !== p.name.toLowerCase() && <span className="env-chip">{p.name}</span>}
                    </span>
                    <span className="muted block truncate text-[10px] leading-3">
                      {st?.accountId ?? p.accountId ?? p.kind} · {p.region}
                    </span>
                  </span>
                </button>
                <span className="mono muted text-[11px]">{counts.get(p.name) ?? ''}</span>
                <button className="muted no-drag opacity-0 group-hover:opacity-70 hover:!opacity-100" title="Edit account (name, environment, SSH defaults, remove)" onClick={() => s.set({ editAccount: p.name })}>
                  <Icon.edit />
                </button>
                <button
                  className="muted no-drag opacity-0 group-hover:opacity-70 hover:!opacity-100"
                  title="Hide this profile (restore in Settings)"
                  onClick={async () => {
                    if (!window.confirm(`Hide profile "${p.name}" from the list? You can restore it in Settings.`)) return
                    await s.saveSettings({ hiddenProfiles: Array.from(new Set([...(s.settings?.hiddenProfiles ?? []), p.name])) })
                    await s.refreshProfiles()
                    if (s.profileFilter === p.name) nav({ profileFilter: null })
                  }}
                >
                  <Icon.x />
                </button>
              </div>
              {st?.state === 'login-required' && (
                <div className="mb-1 ml-8 mt-0.5">
                  <button className="btn btn-primary btn-sm" onClick={() => void s.login(p.name)}>
                    <Icon.key /> Login (SSO)
                  </button>
                </div>
              )}
              {openAcct && accountHosts(p.name)}
              {(st?.state === 'error' || errs.length > 0) && (
                <div className="mb-1 ml-8 text-[11px]" style={{ color: 'var(--err)' }} title={[st?.message, ...errs].filter(Boolean).join('\n')}>
                  {st?.state === 'error' ? st.message?.slice(0, 70) : `${errs.length} region error(s)`}
                  {st?.state === 'error' && p.kind === 'sso' && (
                    <button className="ml-1 underline" onClick={() => void s.login(p.name)}>
                      login
                    </button>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {/* Non-AWS servers, organised in user folders */}
      <div className="mt-4 flex items-center justify-between px-3">
        <span className="section-title">Other servers</span>
        <span className="flex items-center">
          <button className="btn btn-ghost btn-sm btn-icon" title="New folder" onClick={() => s.set({ folderEditor: 'new' })}>
            <Icon.folder />
          </button>
          <button className="btn btn-ghost btn-sm btn-icon" title="Add a server outside AWS" onClick={() => s.set({ manualHostEditor: 'new' })}>
            <Icon.plus />
          </button>
        </span>
      </div>
      <ul className="mt-1 space-y-0.5 px-2">
        {manualCount > 0 && (
          <li>
            <button className={`nav-row w-full text-left ${s.profileFilter === MANUAL_PROFILE ? 'on' : ''}`} onClick={() => nav({ profileFilter: MANUAL_PROFILE, favoritesOnly: false })}>
              <Icon.server className="muted" />
              <span className="flex-1">All servers</span>
              <span className="mono muted text-[11px]">{manualCount}</span>
            </button>
          </li>
        )}
        {s.folders().map((f) => {
          const m = metaFor(`group:${f}`, s.settings)
          const n = (s.settings?.manualHosts ?? []).filter((h) => h.group === f).length
          const key = `group:${f}`
          const open = expanded.has(f)
          return (
            <li key={f} className="group">
              <div className={`nav-row !pl-1 ${s.profileFilter === key ? 'on' : ''}`} data-accent={m.color}>
                <button className="muted flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-[var(--accent-soft-2)]" title={open ? 'Collapse' : 'Show servers'} onClick={() => toggleFolder(f)}>
                  <Icon.chevron open={open} />
                </button>
                <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => nav({ profileFilter: key, favoritesOnly: false })} onDoubleClick={() => toggleFolder(f)}>
                  <span className="avatar sm">{f.slice(0, 2).toUpperCase()}</span>
                  <span className="truncate">{f}</span>
                </button>
                <span className="mono muted text-[11px]">{n || ''}</span>
                <button className="muted opacity-0 group-hover:opacity-70 hover:!opacity-100" title="Add server to this folder" onClick={() => s.set({ manualHostEditor: 'new', manualHostFolder: f })}>
                  <Icon.plus />
                </button>
                <button className="muted opacity-0 group-hover:opacity-70 hover:!opacity-100" title="Rename, recolor or delete folder" onClick={() => s.set({ folderEditor: f })}>
                  <Icon.edit />
                </button>
              </div>
              {open && folderHosts(f, key)}
            </li>
          )
        })}
        {s.folders().length === 0 && manualCount === 0 && (
          <li>
            <button className="nav-row muted w-full text-left" onClick={() => s.set({ folderEditor: 'new' })}>
              <Icon.folder />
              <span className="flex-1">Create a folder…</span>
            </button>
          </li>
        )}
      </ul>

      {/* Filters */}
      <div className="mt-4 space-y-2 px-3">
        <span className="section-title">Filters</span>
        <Seg<OsFilter> value={s.osFilter} onChange={(v) => s.set({ osFilter: v })} options={[['all', 'All OS'], ['linux', 'Linux'], ['windows', 'Windows']]} />
        <Seg<StateFilter> value={s.stateFilter} onChange={(v) => s.set({ stateFilter: v })} options={[['running', 'Running'], ['all', 'Any state']]} />
        <Seg<ReachFilter> value={s.reachFilter} onChange={(v) => s.set({ reachFilter: v })} options={[['all', 'All'], ['reachable', 'Reachable'], ['unreachable', 'Unreachable']]} />
      </div>

      {/* Footer */}
      <div className="mt-auto space-y-2 border-t p-3" style={{ borderColor: 'var(--border)' }}>
        <div className="muted flex items-center justify-between text-[11px]">
          {s.scanning ? (
            <span>
              Scanning… {done}/{scanned.length} regions
            </span>
          ) : s.scannedAt ? (
            <span>Last scan {new Date(s.scannedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          ) : (
            <span>Not scanned yet</span>
          )}
          <span className="flex items-center gap-0.5">
            <button className="btn btn-ghost btn-sm btn-icon" title={`Theme: ${s.settings?.theme ?? 'system'} (click to switch)`} onClick={cycleTheme}>
              {themeIcon}
            </button>
            <button className="btn btn-ghost btn-sm btn-icon" title="Settings" onClick={() => s.set({ settingsOpen: true })}>
              <Icon.settings />
            </button>
            <button className="btn btn-ghost btn-sm btn-icon" title="Collapse sidebar (⌘B)" onClick={() => s.toggleSidebar(true)}>
              <span className="inline-flex" style={{ transform: 'rotate(180deg)' }}>
                <Icon.chevron />
              </span>
            </button>
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button className="btn btn-primary" disabled={s.scanning} onClick={() => void s.scan()}>
            <Icon.refresh className={s.scanning ? 'animate-spin' : ''} />
            {s.scanning ? 'Scanning' : 'Rescan'}
          </button>
          <button
            className="btn"
            disabled={s.loggingIn}
            title="Run `aws sso login` for the shared SSO session (your aws-login alias), then re-check accounts and rescan"
            onClick={() => void s.refreshToken()}
          >
            <Icon.key />
            {s.loggingIn ? 'Waiting…' : 'Refresh token'}
          </button>
        </div>
      </div>
    </aside>
  )
}

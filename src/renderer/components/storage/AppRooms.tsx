import { useEffect, useMemo, useState, type ReactElement } from 'react'
import type { CleanItem } from '@shared/cleanup'
import type { MacApp } from '@shared/macApps'
import { ago, bytes, plural } from '@shared/storage'
import { Icon } from '../icons'
import { useLocal } from '../plan/parts'
import CleanRoom from './CleanRoom'
import { ItemRow, NodeIcon, RoomHead, tilde, TrashBar, useNodeIcons } from './parts'
import { openInUninstaller, quitApps, trashItems, useStorage } from './state'

/**
 * The Apps rooms: Unused Apps and the Uninstaller share the installed apps (storage:apps, measured once and kept for
 * the page); Leftovers and Startup Items are Cleanup-style reports.
 */

const DAY = 86_400_000
let appsCache: MacApp[] | null = null

/** The installed apps, measured; kept for the page and reloaded after something went to the Trash. */
function useApps(): { apps: MacApp[] | null; error: string | null; reload: () => void } {
  const trashed = useStorage((s) => s.trashed)
  const [apps, setApps] = useState<MacApp[] | null>(appsCache)
  const [error, setError] = useState<string | null>(null)
  const [n, setN] = useState(0)
  useEffect(() => {
    let on = true
    window.api.invoke('storage:apps', true).then((a) => { appsCache = a; if (on) setApps(a) }, (e: Error) => { if (on) setError(e.message) })
    return () => { on = false }
  }, [trashed, n])
  return { apps, error, reload: () => setN((x) => x + 1) }
}

/** Asks open apps to quit, found by their bundle path among the apps running now. */
async function quitByPath(list: MacApp[]): Promise<void> {
  const { apps: open } = await window.api.invoke('storage:openApps')
  const pids = open.filter((o) => list.some((a) => a.path === o.path)).map((o) => o.pid)
  await quitApps(pids, list.map((a) => a.name))
}

const lastOpened = (a: MacApp): string => (a.lastUsed ? `Opened ${ago(a.lastUsed)}` : 'No record of being opened')
/** Why an app cannot simply go to the Trash from here, or ''. */
const blockOf = (a: MacApp): string => (a.systemExtension ? 'It has a system extension, which macOS removes only when Finder moves the app to the Trash: show it in Finder and press Command-Delete there.' : a.running ? 'Open now. Quit it before moving it to the Trash.' : '')

export function UnusedApps(): ReactElement {
  const { apps, error, reload } = useApps()
  const [days, setDays] = useLocal<string>('storage.unusedDays', '90')
  const [filter, setFilter] = useState<'unused' | 'big' | 'intel'>('unused')
  const [ticks, setTicks] = useState<Set<string>>(new Set())
  const shown = useMemo(() => {
    const list = (apps ?? []).filter((a) => !a.path.startsWith('/System/'))
    const cutoff = Date.now() - Number(days) * DAY
    const f = filter === 'big' ? list.filter((a) => a.size >= 1e9) : filter === 'intel' ? list.filter((a) => a.intelOnly) : list.filter((a) => a.lastUsed && a.lastUsed < cutoff)
    return f.sort((a, b) => b.size - a.size)
  }, [apps, days, filter])
  const icons = useNodeIcons(shown)
  const picked = shown.filter((a) => ticks.has(a.path) && !blockOf(a))
  const noRecord = (apps ?? []).filter((a) => !a.lastUsed).length
  return (
    <div className="st-list-room">
      <RoomHead icon={<Icon.moon />} title="Unused Apps" sub={apps ? `${plural(shown.length, 'app')} · ${bytes(shown.reduce((s, a) => s + a.size, 0))}` : 'Reading when each app was last opened…'}>
        {filter === 'unused' && (
          <select className="input st-select" value={days} aria-label="Not opened for" onChange={(e) => setDays(e.target.value)}>
            <option value="30">Not opened for a month</option><option value="90">… three months</option><option value="180">… six months</option><option value="365">… a year</option>
          </select>
        )}
      </RoomHead>
      <p className="st-intro">Apps not opened in the time you choose, from Spotlight's record on this Mac. This moves the apps alone; the Uninstaller takes their files elsewhere too.</p>
      <div className="st-chips">
        <button type="button" className={`st-chip ${filter === 'unused' ? 'on' : ''}`} onClick={() => setFilter('unused')}><Icon.moon />Not opened lately</button>
        <button type="button" className={`st-chip ${filter === 'big' ? 'on' : ''}`} onClick={() => setFilter('big')}><Icon.disk />1 GB or more</button>
        <button type="button" className={`st-chip ${filter === 'intel' ? 'on' : ''}`} onClick={() => setFilter('intel')}><Icon.alert />Made only for Intel</button>
      </div>
      <div className="plan-scroll st-list">
        {error && <div className="plan-error"><Icon.alert />{error}</div>}
        {!apps && !error && <div className="st-empty"><div className="st-spinner" aria-hidden="true" /><p>Measuring app sizes…</p></div>}
        {apps && !shown.length && <div className="st-empty"><Icon.check className="plan-empty-icon" /><p>{filter === 'intel' ? 'No app here is made only for Intel.' : filter === 'big' ? 'No app here takes 1 GB or more.' : noRecord === apps.length ? 'Spotlight has no record of when the apps here were opened, so none can be called unused.' : 'Every app has been opened lately.'}</p></div>}
        {shown.map((a) => {
          const block = blockOf(a)
          return (
            <ItemRow key={a.path} checked={ticks.has(a.path)} onCheck={block ? undefined : (on) => setTicks((t) => { const n = new Set(t); if (on) n.add(a.path); else n.delete(a.path); return n })} disabled={!!block}
              icon={<NodeIcon node={{ path: a.path, dir: true, package: true }} icons={icons} />} title={a.name}
              badge={<>{a.intelOnly && <span className="st-badge warn">Intel</span>}{a.running && <span className="st-badge info">Open</span>}</>}
              sub={`${a.version ? `${a.version} · ` : ''}${lastOpened(a)}`} note={block || (a.intelOnly ? 'Made only for Intel Macs: it runs through Rosetta, which Apple keeps fully available only through macOS 27.' : undefined)} warn={!!block} size={a.size}
              extra={<>
                {a.running && <button type="button" className="btn btn-sm" onClick={(e) => { e.stopPropagation(); void quitByPath([a]).then(() => setTimeout(reload, 1500)) }}>Quit</button>}
                {a.systemExtension && <button type="button" className="btn btn-sm" onClick={(e) => { e.stopPropagation(); void window.api.invoke('local:reveal', a.path) }}><Icon.finder />Show in Finder</button>}
                <button type="button" className="btn btn-sm btn-ghost" title="Open it in the Uninstaller, with the files it keeps elsewhere" onClick={(e) => { e.stopPropagation(); openInUninstaller([a.path]) }}>Uninstall…</button>
              </>} />
          )
        })}
      </div>
      <TrashBar items={picked.map((a) => ({ path: a.path, size: a.size, dir: true }))} from="Unused Apps" label="Move apps to Trash" onDone={() => setTicks(new Set())} />
    </div>
  )
}

export function Uninstaller(): ReactElement {
  const { apps, error, reload: reloadApps } = useApps()
  // An app asked to quit may take a moment (it may ask about unsaved work): look again shortly after.
  const reload = (): void => { setTimeout(reloadApps, 1500) }
  const request = useStorage((s) => s.uninstall)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useLocal<'size' | 'name' | 'used'>('storage.uninstallSort', 'size')
  const [chosen, setChosen] = useState<string[]>([])
  const [files, setFiles] = useState<Record<string, CleanItem[]>>({})
  const [ticks, setTicks] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!request) return
    useStorage.setState({ uninstall: null })
    setChosen(request.paths)
  }, [request?.nonce]) // eslint-disable-line react-hooks/exhaustive-deps
  // Each chosen app's files, read once; what is sure starts ticked, with the app itself.
  useEffect(() => {
    for (const p of chosen) {
      if (files[p]) continue
      void window.api.invoke('storage:appFiles', p).then((f) => {
        setFiles((m) => ({ ...m, [p]: f }))
        setTicks((t) => new Set([...t, p, ...f.filter((x) => x.safe && !x.blocked).map((x) => x.path)]))
      }, () => setFiles((m) => ({ ...m, [p]: [] })))
    }
  }, [chosen]) // eslint-disable-line react-hooks/exhaustive-deps

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    const l = (apps ?? []).filter((a) => !a.path.startsWith('/System/') && (!q || a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q)))
    return l.sort(sort === 'name' ? (a, b) => a.name.localeCompare(b.name) : sort === 'used' ? (a, b) => (a.lastUsed || 0) - (b.lastUsed || 0) : (a, b) => b.size - a.size)
  }, [apps, query, sort])
  const icons = useNodeIcons(list)
  const picked = chosen.map((p) => apps?.find((a) => a.path === p)).filter((a): a is MacApp => !!a)
  const runningOnes = picked.filter((a) => a.running)
  const blocked = picked.filter((a) => a.systemExtension)
  const toTrash = picked.filter((a) => !a.systemExtension).flatMap((a) => [
    ...(ticks.has(a.path) ? [{ path: a.path, size: a.size, dir: true }] : []),
    ...(files[a.path] ?? []).filter((f) => !f.blocked && ticks.has(f.path)).map((f) => ({ path: f.path, size: f.size, dir: f.dir }))
  ])
  const total = toTrash.reduce((s, i) => s + i.size, 0)
  const toggle = (path: string, on: boolean): void => setTicks((t) => { const n = new Set(t); if (on) n.add(path); else n.delete(path); return n })
  const choose = (path: string, add: boolean): void => setChosen((c) => (add ? (c.includes(path) ? c.filter((x) => x !== path) : [...c, path]) : [path]))

  return (
    <div className="st-uninstaller">
      <div className="st-un-list">
        <RoomHead icon={<Icon.trash />} title="Uninstaller" sub={apps ? `${plural(list.length, 'app')} that can be removed` : 'Measuring app sizes…'} />
        <div className="st-toolbar">
          <label className="links-search st-search"><Icon.search /><input value={query} placeholder="Search apps" aria-label="Search apps" onChange={(e) => setQuery(e.target.value)} /></label>
          <select className="input st-select" value={sort} aria-label="Order" onChange={(e) => setSort(e.target.value as 'size' | 'name' | 'used')}>
            <option value="size">Largest first</option><option value="used">Least recently opened</option><option value="name">By name</option>
          </select>
        </div>
        <div className="plan-scroll st-list">
          {error && <div className="plan-error"><Icon.alert />{error}</div>}
          {!apps && !error && <div className="st-empty"><div className="st-spinner" aria-hidden="true" /><p>Measuring app sizes…</p></div>}
          {list.map((a) => (
            <div key={a.path} className={`st-row ${chosen.includes(a.path) ? 'selected' : ''}`} title="Click to choose it; ⌘-click to choose several" onClick={(e) => choose(a.path, e.metaKey || e.shiftKey)}>
              <input type="checkbox" className="st-check" checked={chosen.includes(a.path)} aria-label={`Choose ${a.name}`} onClick={(e) => e.stopPropagation()} onChange={() => choose(a.path, true)} />
              <NodeIcon node={{ path: a.path, dir: true, package: true }} icons={icons} />
              <div className="st-row-body">
                <div className="st-row-title">{a.name}{a.running && <span className="st-badge info">Open</span>}{a.intelOnly && <span className="st-badge warn">Intel</span>}</div>
                <div className="st-row-sub">{lastOpened(a)}</div>
              </div>
              <span className="st-size">{bytes(a.size)}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="st-un-detail">
        {!picked.length ? (
          <div className="st-empty"><Icon.trash className="plan-empty-icon" /><p>Choose an app to see what goes with it.</p><p className="muted">Removing an app leaves preferences, caches and support files across your Library; this finds them and shows each before anything moves. ⌘-click to uninstall several together.</p></div>
        ) : (
          <>
            <div className="plan-scroll st-list">
              {picked.map((a) => (
                <section key={a.path} className="st-group">
                  <header className="st-group-head">
                    <div className="st-group-text">
                      <h3>{a.name} <span className="muted">{a.version}</span></h3>
                      <p>{a.id}{a.admin ? ' · installed by a package: only an administrator can move it, so Finder will ask' : ''}</p>
                    </div>
                    {a.running && <button type="button" className="btn btn-sm" onClick={() => void quitByPath([a]).then(reload)}>Quit</button>}
                  </header>
                  {a.systemExtension ? (
                    <ItemRow icon={<NodeIcon node={{ path: a.path, dir: true, package: true }} icons={icons} />} title="The application itself" sub={tilde(a.path)}
                      note="It has a system extension, which macOS removes only when Finder moves the app to the Trash: moved from here, the extension would keep running." warn size={a.size}
                      extra={<button type="button" className="btn btn-sm" onClick={() => void window.api.invoke('local:reveal', a.path)}><Icon.finder />Show in Finder</button>} />
                  ) : (
                    <ItemRow checked={ticks.has(a.path)} onCheck={(on) => toggle(a.path, on)} icon={<NodeIcon node={{ path: a.path, dir: true, package: true }} icons={icons} />} title="The application itself" sub={tilde(a.path)}
                      note={a.running ? `${a.name} is open. Quit it first, or its preferences will come back.` : undefined} warn={a.running} size={a.size} />
                  )}
                  {!files[a.path] && <div className="st-row disabled"><span className="st-spinner sm" /><div className="st-row-body"><div className="st-row-sub">Looking for what it keeps elsewhere…</div></div></div>}
                  {files[a.path] && !files[a.path].length && <div className="st-row disabled"><div className="st-row-body"><div className="st-row-sub">No leftovers found. Either this app keeps to itself, or its files do not carry its name.</div></div></div>}
                  {files[a.path]?.map((f) => (
                    <ItemRow key={f.path} checked={ticks.has(f.path)} onCheck={f.blocked ? undefined : (on) => toggle(f.path, on)} disabled={!!f.blocked}
                      icon={<span className="st-icon st-icon-glyph">{f.dir ? <Icon.folder /> : <Icon.note />}</span>} title={f.name} sub={tilde(f.path.replace(/\/[^/]+$/, ''))}
                      note={[f.note, f.blocked].filter(Boolean).join(' ')} warn={!f.safe} size={f.size}
                      extra={f.action?.reveal ? <button type="button" className="btn btn-sm" onClick={(e) => { e.stopPropagation(); void window.api.invoke('local:reveal', f.action!.reveal!) }}><Icon.finder />Show in Finder</button> : undefined} />
                  ))}
                </section>
              ))}
            </div>
            <div className="st-trashbar">
              <span className="st-trashbar-text">{toTrash.length ? <><b>{bytes(total)}</b> in {plural(toTrash.length, 'item')}</> : 'Nothing ticked'}{blocked.length > 0 && <span className="muted"> · {blocked.map((b) => b.name).join(', ')} must go through Finder</span>}</span>
              <span className="flex-1" />
              {runningOnes.length > 0 && <button type="button" className="btn btn-sm" onClick={() => void quitByPath(runningOnes).then(reload)}>Quit {runningOnes.length === 1 ? runningOnes[0].name : plural(runningOnes.length, 'app')}</button>}
              <button type="button" className="btn btn-sm btn-danger" disabled={!toTrash.length || busy || runningOnes.some((r) => ticks.has(r.path))}
                title={runningOnes.some((r) => ticks.has(r.path)) ? 'Quit the open apps first' : undefined}
                onClick={() => { setBusy(true); void trashItems(toTrash, 'Uninstaller').then(() => { setChosen([]); setFiles({}) }).finally(() => setBusy(false)) }}>
                <Icon.trash />{busy ? 'Moving…' : 'Uninstall'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export function Leftovers(): ReactElement {
  return (
    <CleanRoom room="leftovers" from="Leftovers" icon={<Icon.box />} title="Leftovers" sub="Files in your Library from apps no longer on this Mac."
      measuring="Looking through your Library…" load={() => window.api.invoke('storage:leftovers')}
      intro="Files in your Library named for apps that are no longer on this Mac, checked against every app, package and helper installed. Anything a present app might still use is left out, and only caches, settings and logs of apps the app is sure about start ticked." />
  )
}

export function StartupItems(): ReactElement {
  return (
    <CleanRoom room="startup" from="Startup Items" icon={<Icon.power />} title="Startup Items" sub="Everything that starts itself." noSizes
      measuring="Reading startup items…" load={() => window.api.invoke('storage:startup')}
      intro="Launch agents, launch daemons, helper tools and system extensions, matched against the apps you have installed. Only agents of your account whose program is gone start ticked; a removed agent stops at once. What needs a password goes by way of Finder." />
  )
}

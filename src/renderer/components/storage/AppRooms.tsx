import { useEffect, useMemo, useState, type ReactElement } from 'react'
import type { CleanItem } from '@shared/cleanup'
import { SCOPE_NAMES, type LaunchScope, type MacApp, type StartupItem } from '@shared/macApps'
import { ago, bytes, plural } from '@shared/storage'
import { Icon } from '../icons'
import CleanRoom, { CleanRow } from './CleanRoom'
import { Badge, Footer, GroupHead, Intro, ItemIcon, ListBar, Row, Segmented, tilde, TopBar, TrashFooter, useIcons, useLoad } from './parts'
import { loadApps, openInUninstaller, quitApps, trashItems, useStorage } from './state'

/**
 * The Unused Apps room and the Tools: Uninstaller, Startup Items, and Leftovers (a Cleanup-style list). The installed
 * apps are measured once for the page (state.loadApps) and again after something goes to the Trash.
 */

const DAY = 86_400_000
const month = (t: number): string => new Date(t).toLocaleDateString([], { month: 'short', year: 'numeric' })
const opened = (a: MacApp): string => (a.lastUsed ? `Opened ${ago(a.lastUsed)}` : `No record of being opened${a.added ? ` · here since ${month(a.added)}` : ''}`)
const removable = (a: MacApp): boolean => !a.path.startsWith('/System/')

/** The apps, measured, refreshed after a move to the Trash. */
function useApps(): MacApp[] | null {
  const apps = useStorage((s) => s.apps)
  const trashed = useStorage((s) => s.trashed)
  useEffect(() => { void loadApps(trashed > 0) }, [trashed])
  return apps
}

/** Asks open apps to quit, found by their bundle path among the apps running now; looks again a moment later. */
async function quitByPath(list: MacApp[]): Promise<void> {
  const { apps: open } = await window.api.invoke('storage:openApps')
  await quitApps(open.filter((o) => list.some((a) => a.path === o.path)).map((o) => o.pid), list.map((a) => a.name))
  setTimeout(() => void loadApps(true), 1500)
}

/** Why an app cannot simply go to the Trash from here, or ''. */
const blockOf = (a: MacApp): string => (a.systemExtension ? 'It has a system extension, which macOS removes only when Finder moves the app to the Trash: show it in Finder and press Command-Delete there.' : a.running ? 'Open now. Quit it before moving it to the Trash.' : '')

export function UnusedApps(): ReactElement {
  const apps = useApps()
  const [period, setPeriod] = useState<'90' | '180' | '365'>('90')
  const [sort, setSort] = useState<'used' | 'size' | 'name'>('used')
  const [ticks, setTicks] = useState<Set<string>>(new Set())
  const shown = useMemo(() => {
    const cutoff = Date.now() - Number(period) * DAY
    const l = (apps ?? []).filter((a) => removable(a) && !a.apple && (!a.lastUsed || a.lastUsed < cutoff))
    return l.sort(sort === 'name' ? (a, b) => a.name.localeCompare(b.name) : sort === 'size' ? (a, b) => b.size - a.size : (a, b) => (a.lastUsed || 0) - (b.lastUsed || 0))
  }, [apps, period, sort])
  const icons = useIcons(shown.map((a) => a.path))
  const picked = shown.filter((a) => ticks.has(a.path) && !blockOf(a))
  const label = period === '90' ? '3 months' : period === '180' ? '6 months' : 'a year'
  return (
    <div className="st-room">
      <TopBar title="Unused Apps" />
      <Intro actions={<Segmented value={period} onChange={setPeriod} options={[{ id: '90', label: '3 Months' }, { id: '180', label: '6 Months' }, { id: '365', label: '1 Year' }]} />}>Apps not opened in the time you choose, from Spotlight's record on this Mac.</Intro>
      <ListBar text={apps ? `${plural(shown.length, 'app')} not opened in ${label}` : 'Reading when each app was last opened…'}
        links={[{ label: 'Select All', onClick: () => setTicks(new Set(shown.filter((a) => !blockOf(a)).map((a) => a.path))), disabled: !shown.length }, { label: 'Select None', onClick: () => setTicks(new Set()), disabled: !picked.length }]}>
        <Segmented small value={sort} onChange={setSort} options={[{ id: 'used', label: 'Least used' }, { id: 'size', label: 'Largest' }, { id: 'name', label: 'Name' }]} />
      </ListBar>
      <div className="st-list">
        {!apps && <div className="st-empty"><div className="st-spinner" /><h3>Measuring app sizes…</h3></div>}
        {apps && !shown.length && <div className="st-empty"><span className="st-empty-art"><Icon.check /></span><h3>Every app has been opened lately</h3><p className="muted">No app here has gone unopened for {label}.</p></div>}
        {shown.map((a) => {
          const block = blockOf(a)
          return (
            <Row key={a.path} checked={ticks.has(a.path)} onCheck={block ? undefined : (on) => setTicks((t) => { const n = new Set(t); if (on) n.add(a.path); else n.delete(a.path); return n })} lock={!!block}
              icon={<ItemIcon path={a.path} icons={icons} size={28} />}
              title={<>{a.name} <span className="st-version">{a.version}</span></>}
              badges={<>{a.intelOnly && <Badge tone="warn">Intel</Badge>}{a.running && <Badge tone="info">Open</Badge>}</>}
              sub={block || opened(a)} size={a.size}
              extra={<>
                {a.running && <button type="button" className="st-button sm" onClick={(e) => { e.stopPropagation(); void quitByPath([a]) }}>Quit</button>}
                <button type="button" className="st-button sm" onClick={(e) => { e.stopPropagation(); openInUninstaller([a.path]) }}>Uninstall…</button>
              </>} />
          )
        })}
      </div>
      <TrashFooter items={picked.map((a) => ({ path: a.path, size: a.size, dir: true }))} from="Unused Apps" note="Moves the apps alone. The Uninstaller takes several at once, with the files each keeps elsewhere." onDone={() => setTicks(new Set())} />
    </div>
  )
}

export function Uninstaller(): ReactElement {
  const apps = useApps()
  const request = useStorage((s) => s.uninstall)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'name' | 'size'>('name')
  const [filter, setFilter] = useState<'all' | 'unused' | 'large' | 'intel'>('all')
  const [chosen, setChosen] = useState<string[]>([])
  const [files, setFiles] = useState<Record<string, CleanItem[]>>({})
  const [ticks, setTicks] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!request) return
    useStorage.setState({ uninstall: null })
    setChosen(request.paths)
  }, [request?.nonce]) // eslint-disable-line react-hooks/exhaustive-deps
  // Each chosen app's files, read once; the app itself and what is sure start ticked.
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
    const l = (apps ?? []).filter((a) => removable(a) && (!q || a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q)))
      .filter((a) => filter === 'unused' ? !a.lastUsed || Date.now() - a.lastUsed > 90 * DAY : filter === 'large' ? a.size >= 1e9 : filter === 'intel' ? a.intelOnly : true)
    return l.sort(sort === 'name' ? (a, b) => a.name.localeCompare(b.name) : (a, b) => b.size - a.size)
  }, [apps, query, sort, filter])
  const picked = chosen.map((p) => apps?.find((a) => a.path === p)).filter((a): a is MacApp => !!a)
  const icons = useIcons([...list.map((a) => a.path), ...picked.map((a) => a.path)])
  const runningOnes = picked.filter((a) => a.running)
  const blocked = picked.filter((a) => a.systemExtension)
  const toTrash = picked.filter((a) => !a.systemExtension).flatMap((a) => [
    ...(ticks.has(a.path) ? [{ path: a.path, size: a.size, dir: true }] : []),
    ...(files[a.path] ?? []).filter((f) => !f.blocked && ticks.has(f.path)).map((f) => ({ path: f.path, size: f.size, dir: f.dir }))
  ])
  const toggle = (path: string, on: boolean): void => setTicks((t) => { const n = new Set(t); if (on) n.add(path); else n.delete(path); return n })
  const choose = (path: string, add: boolean): void => setChosen((c) => (add ? (c.includes(path) ? c.filter((x) => x !== path) : [...c, path]) : [path]))

  return (
    <div className="st-room">
      <TopBar title="Uninstaller" />
      <div className="st-uninstaller">
        <div className="st-un-list">
          <div className="st-un-tools">
            <label className="st-searchbox sm"><Icon.search /><input value={query} placeholder="Filter apps" aria-label="Filter apps" onChange={(e) => setQuery(e.target.value)} /></label>
            <Segmented small value={sort} onChange={setSort} options={[{ id: 'name', label: 'Name' }, { id: 'size', label: 'Largest' }]} />
          </div>
          <div className="st-un-tools">
            <Segmented small value={filter} onChange={setFilter} options={[{ id: 'all', label: 'All' }, { id: 'unused', label: 'Unused' }, { id: 'large', label: 'Large' }, { id: 'intel', label: 'Intel' }]} />
            <span className="flex-1" />
            <button type="button" className="st-link" disabled={!list.length} onClick={() => setChosen(list.map((a) => a.path))}>Choose All</button>
            <button type="button" className="st-link" disabled={!chosen.length} onClick={() => setChosen([])}>Clear</button>
          </div>
          <div className="st-list">
            {!apps && <div className="st-empty"><div className="st-spinner" /><h3>Measuring app sizes…</h3></div>}
            {list.map((a) => (
              <div key={a.path} className={`st-row ${chosen.includes(a.path) ? 'selected' : ''}`} title="Click to choose it; ⌘-click to choose several" onClick={(e) => choose(a.path, e.metaKey || e.shiftKey)}>
                <span className="st-row-tick"><input type="checkbox" className="st-check" checked={chosen.includes(a.path)} aria-label={`Choose ${a.name}`} onClick={(e) => e.stopPropagation()} onChange={() => choose(a.path, true)} /></span>
                <ItemIcon path={a.path} icons={icons} size={28} />
                <div className="st-row-body">
                  <div className="st-row-title"><span className="st-row-name">{a.name}</span>{a.intelOnly && <Badge tone="warn">Intel</Badge>}{a.running && <Badge tone="info">Open</Badge>}</div>
                  <div className="st-row-sub">{opened(a)}</div>
                </div>
                <span className="st-size">{bytes(a.size)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="st-un-detail">
          {!picked.length ? (
            <div className="st-empty"><span className="st-empty-art"><Icon.trash /></span><h3>Pick an app</h3><p>Removing an app leaves preferences, caches and support files scattered across your Library. This finds them and shows you each one before anything moves.</p><p className="muted">To uninstall several apps together, tick them, or hold Command or Shift as you click, as in Finder.</p></div>
          ) : (
            <>
              <div className="st-list">
                {picked.map((a) => (
                  <section key={a.path} className="st-group">
                    <GroupHead icon={<ItemIcon path={a.path} icons={icons} size={34} />} title={<>{a.name} <span className="st-version">{a.version}</span></>}
                      sub={`${a.id}${a.admin ? ' · installed by a package: Finder asks for the password' : ''}`} size={a.size + (files[a.path] ?? []).reduce((s, f) => s + f.size, 0)}
                      extra={a.running ? <button type="button" className="st-button sm" onClick={(e) => { e.stopPropagation(); void quitByPath([a]) }}>Quit</button> : undefined} />
                    {a.systemExtension ? (
                      <Row indent lock icon={<ItemIcon path={a.path} icons={icons} />} title="The application itself" sub="It has a system extension: macOS removes it only when Finder moves the app to the Trash."
                        extra={<button type="button" className="st-button sm" onClick={() => void window.api.invoke('local:reveal', a.path)}><Icon.finder />Show in Finder</button>} size={a.size} />
                    ) : (
                      <Row indent checked={ticks.has(a.path)} onCheck={(on) => toggle(a.path, on)} icon={<ItemIcon path={a.path} icons={icons} />} title="The application itself"
                        badges={a.running ? <Badge tone="warn">Running</Badge> : undefined} sub={a.running ? 'Open: quit it first, or its preferences will come back.' : tilde(a.path)} size={a.size} reveal={a.path} />
                    )}
                    {!files[a.path] && <div className="st-row disabled indent"><span className="st-row-tick" /><span className="st-spinner sm" /><div className="st-row-body"><div className="st-row-sub">Looking for what it keeps elsewhere…</div></div></div>}
                    {files[a.path] && !files[a.path].length && <div className="st-row disabled indent"><span className="st-row-tick" /><div className="st-row-body"><div className="st-row-sub">No leftovers found. Either this app keeps to itself, or its files do not carry its name.</div></div></div>}
                    {files[a.path]?.map((f) => <CleanRow key={f.path} indent item={{ ...f, badges: [...(f.badges ?? []), f.safe ? { text: 'Very likely', tone: 'ok' } : { text: 'Likely', tone: 'muted' }] }} ticked={ticks.has(f.path)} onTick={(on) => toggle(f.path, on)} icons={icons} />)}
                  </section>
                ))}
              </div>
              <Footer count={toTrash.length} size={toTrash.reduce((s, i) => s + i.size, 0)} note={blocked.length ? `${blocked.map((b) => b.name).join(', ')} must go through Finder.` : 'What is ticked in each goes with it, to the Trash, and can be put back.'}>
                {runningOnes.length > 0 && <button type="button" className="st-button" onClick={() => void quitByPath(runningOnes)}>Quit {runningOnes.length === 1 ? runningOnes[0].name : plural(runningOnes.length, 'app')}</button>}
                <button type="button" className="st-primary" disabled={!toTrash.length || busy || runningOnes.some((r) => ticks.has(r.path))} title={runningOnes.some((r) => ticks.has(r.path)) ? 'Quit the open apps first' : undefined}
                  onClick={() => { setBusy(true); void trashItems(toTrash, 'Uninstaller').then(() => { setChosen([]); setFiles({}) }).finally(() => setBusy(false)) }}>{busy ? 'Moving…' : 'Uninstall…'}</button>
              </Footer>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export function Leftovers(): ReactElement {
  return (
    <CleanRoom room="leftovers" from="Leftovers" title="Leftovers" recommend="Select Very Likely" measuring="Looking through your Library…" load={() => window.api.invoke('storage:leftovers')}
      summary={(r) => `${plural(r.groups.reduce((s, g) => s + g.items.length, 0), 'item')} from ${plural(r.groups.length, 'app')}`}
      intro="Files in your Library that belong to apps no longer on this Mac, checked against every app, package and helper installed. Only the ones the app is sure about start ticked." />
  )
}

export function StartupItems(): ReactElement {
  const [n, setN] = useState(0)
  const trashed = useStorage((s) => s.trashed)
  const load = useLoad<StartupItem[]>(() => window.api.invoke('storage:startup'), [n, trashed])
  const [apple, setApple] = useState(false)
  const [by, setBy] = useState<'app' | 'kind'>('app')
  const [sort, setSort] = useState<'name' | 'size'>('name')
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [ticks, setTicks] = useState<Set<string>>(new Set())
  const items = useMemo(() => (load.data ?? []).filter((i) => apple || !i.apple), [load.data, apple])
  const missing = items.filter((i) => i.missing && !i.admin)
  useEffect(() => { setTicks(new Set()) }, [load.data])
  const groups = useMemo(() => {
    const m = new Map<string, { key: string; title: string; app?: string; kind: StartupItem['ownerKind'] | 'scope'; items: StartupItem[] }>()
    for (const i of items) {
      const key = by === 'app' ? (i.owner || '\u0000none') : i.scope
      const g = m.get(key) ?? { key, title: by === 'app' ? (i.owner || 'No installed app') : SCOPE_NAMES[i.scope], ...(by === 'app' && i.ownerApp ? { app: i.ownerApp } : {}), kind: by === 'app' ? i.ownerKind : 'scope', items: [] }
      g.items.push(i)
      m.set(key, g)
    }
    const l = [...m.values()]
    return l.sort(sort === 'size' ? (a, b) => b.items.reduce((s, i) => s + i.size, 0) - a.items.reduce((s, i) => s + i.size, 0) : (a, b) => (a.key === '\u0000none' ? -1 : b.key === '\u0000none' ? 1 : a.title.localeCompare(b.title)))
  }, [items, by, sort])
  const icons = useIcons(groups.map((g) => g.app))
  const picked = items.filter((i) => ticks.has(i.path) && !i.admin)
  const devs = new Set(items.filter((i) => i.ownerKind === 'developer').map((i) => i.owner)).size
  const appsN = new Set(items.filter((i) => i.ownerKind === 'app').map((i) => i.owner)).size
  const toggle = (paths: string[], on: boolean): void => setTicks((t) => { const x = new Set(t); for (const p of paths) { if (on) x.add(p); else x.delete(p) } return x })
  const describe = (g: { items: StartupItem[] }): string => {
    const parts = [plural(g.items.length, 'item')]
    const miss = g.items.filter((i) => i.missing).length
    if (miss) parts.push(`${miss} with a missing program`)
    if (g.items.some((i) => i.runAtLoad)) parts.push('runs at login')
    if (g.items.some((i) => i.scope === 'sysext')) parts.push('a system extension')
    if (g.items.some((i) => i.loaded)) parts.push('running now')
    return parts.join(' · ')
  }

  return (
    <div className="st-room">
      <TopBar title="Startup Items" />
      <Intro actions={<>
        <label className="st-toggle"><input type="checkbox" checked={apple} onChange={(e) => setApple(e.target.checked)} />Show Apple's</label>
        <Segmented small value={by} onChange={setBy} options={[{ id: 'app', label: 'By App' }, { id: 'kind', label: 'By Kind' }]} />
        <Segmented small value={sort} onChange={setSort} options={[{ id: 'name', label: 'Name' }, { id: 'size', label: 'Largest' }]} />
        <button type="button" className="st-button" onClick={() => void window.api.invoke('shell:open', 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension')}>Login Items…</button>
        <button type="button" className="st-iconbtn" title="Look again" aria-label="Look again" onClick={() => setN((x) => x + 1)}><Icon.refresh /></button>
      </>}>Launch agents, launch daemons, helper tools and system extensions, matched against the apps you have installed.</Intro>
      <ListBar text={load.data ? `${plural(items.length, 'item')} from ${plural(appsN, 'app')} and ${plural(devs, 'developer')}` : 'Reading startup items…'}
        links={[{ label: `Select Missing Programs (${missing.length})`, onClick: () => setTicks(new Set(missing.map((i) => i.path))), disabled: !missing.length }, { label: 'Select All', onClick: () => setTicks(new Set(items.filter((i) => !i.admin).map((i) => i.path))), disabled: !items.length }, { label: 'Select None', onClick: () => setTicks(new Set()), disabled: !picked.length }]} />
      <div className="st-list">
        {!load.data && <div className="st-empty"><div className="st-spinner" /><h3>Reading startup items…</h3></div>}
        {load.data && !items.length && <div className="st-empty"><h3>Nothing starts itself</h3><p className="muted">Nothing here besides macOS's own. Tick Show Apple's to see those.</p></div>}
        {groups.map((g) => {
          const selectable = g.items.filter((i) => !i.admin)
          const on = selectable.filter((i) => ticks.has(i.path))
          const isOpen = open.has(g.key)
          return (
            <section key={g.key} className="st-group flat">
              <GroupHead icon={g.app ? <ItemIcon path={g.app} icons={icons} size={30} /> : <span className="st-sq plain">{g.kind === 'none' ? <Icon.alert /> : g.kind === 'developer' ? <Icon.server /> : <Icon.power />}</span>}
                title={g.title} sub={describe(g)} size={g.items.reduce((s, i) => s + i.size, 0)} open={isOpen}
                onToggle={() => setOpen((o) => { const x = new Set(o); if (x.has(g.key)) x.delete(g.key); else x.add(g.key); return x })}
                state={!selectable.length ? 'off' : on.length === selectable.length ? 'all' : on.length ? 'some' : 'none'} onTick={(v) => toggle(selectable.map((i) => i.path), v)}
                badge={!selectable.length ? <span className="st-lock" title="Needs an administrator or macOS"><Icon.lock /></span> : undefined} />
              {isOpen && g.items.map((i) => (
                <Row key={i.path} indent checked={ticks.has(i.path)} onCheck={i.admin ? undefined : (v) => toggle([i.path], v)} lock={i.admin}
                  icon={<span className="st-icon st-icon-glyph"><Icon.power /></span>}
                  title={i.label} badges={<>{i.missing && <Badge tone="crit">Missing program</Badge>}{i.loaded && <Badge tone="ok">Running</Badge>}{i.admin && i.scope !== 'sysext' && <Badge tone="warn">Password</Badge>}</>}
                  sub={`${SCOPE_NAMES[i.scope as LaunchScope]} · ${i.note}`} size={i.size} reveal={i.path.startsWith('/') ? i.path : undefined} />
              ))}
            </section>
          )
        })}
      </div>
      <TrashFooter items={picked.map((i) => ({ path: i.path, size: i.size }))} from="Startup Items" note="A removed agent stops at once, and a daemon or helper at the next restart. What needs a password goes by way of Finder." onDone={() => setN((x) => x + 1)} />
    </div>
  )
}

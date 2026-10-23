import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { groupSize, type CleanItem, type PackageReceipt, type SystemCard } from '@shared/cleanup'
import { ago, bytes, plural } from '@shared/storage'
import { Icon } from '../icons'
import CleanRoom, { act, CleanRow } from './CleanRoom'
import { Badge, Footer, Intro, ListBar, Segmented, Squircle, tilde, TopBar, TrashFooter, useIcons, useLoad } from './parts'
import { setRoom, useStorage } from './state'

/** The Clean up rooms that measure places they know; Leftovers, Duplicates and Hidden Files have their own files. */

export function JunkFiles(): ReactElement {
  return (
    <CleanRoom room="junk" from="Junk Files" title="Junk Files" measuring="Measuring caches, logs and build data…" load={() => window.api.invoke('storage:junk')}
      intro="Caches, logs, build data and installers that can go without losing anything anyone made, and what is yours to judge: old downloads, Xcode's archives, virtual machines and games. Everything goes to the Trash, and can be put back." />
  )
}

type AiFilter = 'all' | 'model' | 'cache' | 'other'

export function AiModels(): ReactElement {
  const report = useStorage((s) => s.reports.ai)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState<AiFilter>('all')
  const [open, setOpen] = useState<Set<string>>(new Set(['apple']))
  const [ticks, setTicks] = useState<Set<string>>(new Set())
  const measure = (): void => {
    setBusy(true)
    void window.api.invoke('storage:ai').then((r) => useStorage.setState((s) => ({ reports: { ...s.reports, ai: r } }))).finally(() => setBusy(false))
  }
  useEffect(() => { if (!report) measure() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setTicks(new Set(report?.groups.flatMap((g) => g.items.filter((i) => i.safe && !i.blocked).map((i) => i.path)) ?? [])) }, [report?.at])
  const items = useMemo(() => report?.groups.flatMap((g) => g.items) ?? [], [report])
  const by = (c: AiFilter): number => items.filter((i) => (c === 'all' ? true : (i.category ?? 'other') === c)).reduce((s, i) => s + i.size, 0)
  const total = by('all') || 1
  const apple = report?.groups.find((g) => g.id === 'apple')
  const fromApps = items.filter((i) => !i.blocked).reduce((s, i) => s + i.size, 0)
  const caches = items.filter((i) => i.category === 'cache' && !i.blocked)
  const icons = useIcons(items.map((i) => i.path.startsWith('/') ? i.path : undefined))
  const picked = items.filter((i) => !i.blocked && ticks.has(i.path))
  const groups = (report?.groups ?? []).map((g) => ({ ...g, items: g.items.filter((i) => filter === 'all' || (i.category ?? 'other') === filter) })).filter((g) => g.items.length)
  const tick = (paths: string[], on: boolean): void => setTicks((t) => { const n = new Set(t); for (const p of paths) { if (on) n.add(p); else n.delete(p) } return n })
  const segs = [{ id: 'model', label: 'Models', color: '#8b5cf6' }, { id: 'cache', label: 'Caches', color: '#3b82f6' }, { id: 'other', label: 'Other', color: '#22c55e' }] as const

  return (
    <div className="st-room">
      <TopBar title="AI Data Sweeper" icon={<Icon.sparkles />} />
      <Intro actions={<button type="button" className="st-button" disabled={busy} onClick={measure}><Icon.refresh />{busy ? 'Looking…' : 'Look Again'}</button>}>Find and manage AI models and caches downloaded by apps.</Intro>
      <div className="st-scroll">
        {!report && <div className="st-empty"><div className="st-spinner" /><h3>Looking where AI apps keep models…</h3></div>}
        {report && (
          <>
            <section className="st-panel st-ai-sum">
              <div className="st-ai-total">
                <div><b>{bytes(by('all'))}</b><span>AI data on this Mac</span></div>
                <div className="st-stack slim">{segs.map((s) => <span key={s.id} style={{ width: `${(by(s.id) / total) * 100}%`, background: s.color }} />)}</div>
                <div className="st-ai-legend">{segs.map((s) => <span key={s.id}><i style={{ background: s.color }} />{s.label}<b>{Math.round((by(s.id) / total) * 100)}%</b><small>{bytes(by(s.id))}</small></span>)}</div>
              </div>
              <div className="st-ai-tiles">
                <div className="st-ai-tile"><Squircle look="ai" size={38} /><span><b>{bytes(fromApps)}</b><span>From AI apps</span><small>Can be moved to Trash</small></span></div>
                <div className="st-ai-tile"><Squircle look="apple" size={38} /><span><b>{bytes(apple ? groupSize(apple) : 0)}</b><span>Apple's own AI</span><small>Removed by macOS</small></span></div>
                <div className="st-ai-tile"><Squircle look="downloads" size={38} /><span><b>{caches.length}</b><span>{caches.length === 1 ? 'Cache' : 'Caches'}</span><small>Can be cleaned</small></span></div>
              </div>
            </section>
            {report.notes.map((n) => <div key={n} className="st-note"><Icon.shield />{n}</div>)}
            <div className="st-section-head">
              <div><h3>AI Components</h3><p className="muted">Each card says how its models come back. Only macOS removes Apple's own.</p></div>
              <Segmented value={filter} onChange={setFilter} options={[{ id: 'all', label: `All (${bytes(by('all'))})` }, { id: 'model', label: `Models (${bytes(by('model'))})` }, { id: 'cache', label: `Caches (${bytes(by('cache'))})` }, { id: 'other', label: `Other (${bytes(by('other'))})` }]} />
            </div>
            {!groups.length && <div className="st-empty"><h3>Nothing of that kind</h3><p className="muted">No AI models or caches of 1 MB or more in the places AI apps keep them.</p></div>}
            {groups.map((g) => {
              const isOpen = open.has(g.id)
              return (
                <section key={g.id} className="st-panel st-ai-card">
                  <div className="st-ai-card-head">
                    <Squircle look={g.look ?? 'ai'} size={44} />
                    <div className="flex-1"><h3>{g.id === 'apple' ? 'Apple\'s own AI' : g.title}{g.id === 'apple' && <Badge>System</Badge>}</h3><p>{g.text}</p></div>
                    <div className="st-ai-size"><b>{bytes(groupSize(g))}</b><small>{plural(g.items.length, 'item')}</small></div>
                    <button type="button" className="st-button" onClick={() => setOpen((o) => { const n = new Set(o); if (n.has(g.id)) n.delete(g.id); else n.add(g.id); return n })}>{isOpen ? 'Hide Details' : 'View Details'}</button>
                  </div>
                  {isOpen && (g.id === 'apple'
                    ? <div className="st-ai-sub">{g.items.map((i) => (
                      <div key={i.path} className="st-ai-subcard">
                        <div className="flex-1"><b>{i.label ?? i.name}</b><p>{i.note}</p></div>
                        <div className="st-ai-size"><b>{bytes(i.size)}</b></div>
                        {i.action && <button type="button" className="st-button sm" onClick={() => act(i.action!)}>{i.action.label}</button>}
                      </div>
                    ))}</div>
                    : <div className="st-ai-items">{g.items.map((i) => <CleanRow key={i.path} item={i} ticked={ticks.has(i.path)} onTick={(v) => tick([i.path], v)} icons={icons} />)}</div>)}
                </section>
              )
            })}
          </>
        )}
      </div>
      <TrashFooter items={picked.map((i) => ({ path: i.path, size: i.size, dir: i.dir }))} from="AI Data Sweeper" note="Models go to the Trash, and can be put back. Each card says how its models come back."
        links={[{ label: 'Select Caches', onClick: () => setTicks(new Set(caches.map((c) => c.path))), disabled: !caches.length }, { label: 'Select All', onClick: () => setTicks(new Set(items.filter((i) => !i.blocked).map((i) => i.path))), disabled: !items.some((i) => !i.blocked) }, { label: 'Select None', onClick: () => setTicks(new Set()), disabled: !picked.length }]} />
    </div>
  )
}

export function SystemData(): ReactElement {
  const [n, setN] = useState(0)
  const trashed = useStorage((s) => s.trashed)
  const load = useLoad(() => window.api.invoke('storage:systemData'), [n, trashed])
  const [ticks, setTicks] = useState<Set<string>>(new Set())
  useEffect(() => { setTicks(new Set(load.data?.cards.flatMap((c) => (c.items ?? []).filter((i) => i.safe && !i.blocked).map((i) => i.path)) ?? [])) }, [load.data])
  const items: CleanItem[] = load.data?.cards.flatMap((c) => c.items ?? []) ?? []
  const icons = useIcons(items.map((i) => i.path))
  const picked = items.filter((i) => ticks.has(i.path) && !i.blocked)
  return (
    <div className="st-room">
      <TopBar title="System Data" />
      <Intro actions={<button type="button" className="st-button" disabled={load.loading} onClick={() => setN((x) => x + 1)}><Icon.refresh />{load.loading ? 'Looking…' : 'Look Again'}</button>}>
        What System Data holds that can go, and the backups, attachments, simulators, sound libraries, snapshots and Trash that Storage settings counts beside it, each tagged with where it counts them. What can go goes to the Trash, and can be put back.
      </Intro>
      <div className="st-scroll">
        {!load.data && <div className="st-empty"><div className="st-spinner" /><h3>Measuring backups, attachments and the Trash…</h3></div>}
        {load.data?.notes.map((t) => <div key={t} className="st-note"><Icon.shield />{t}</div>)}
        <div className="st-cardcol">
          {load.data?.cards.map((c) => <SysCard key={c.id} card={c} ticks={ticks} icons={icons} onTick={(p, on) => setTicks((t) => { const x = new Set(t); if (on) x.add(p); else x.delete(p); return x })} />)}
        </div>
      </div>
      <TrashFooter items={picked.map((i) => ({ path: i.path, size: i.size, dir: i.dir }))} from="System Data" />
    </div>
  )
}

function SysCard({ card: c, ticks, icons, onTick }: { card: SystemCard; ticks: Set<string>; icons: Map<string, string>; onTick: (path: string, on: boolean) => void }): ReactElement {
  return (
    <section className="st-panel st-syscard">
      <div className="st-syscard-head">
        <Squircle look={c.look} size={34} />
        <div className="flex-1"><h3>{c.title}<Badge>{c.tag}</Badge></h3><p>{c.text}</p></div>
        {c.size !== undefined && c.size > 0 && <b className="st-syscard-size">{bytes(c.size)}</b>}
      </div>
      {c.rows?.map((r) => (
        r.room
          ? <button key={r.label} type="button" className="st-sysrow" onClick={() => setRoom(r.room as Parameters<typeof setRoom>[0])}><span className="flex-1">{r.label}</span>{r.size !== undefined && <span className="muted">{bytes(r.size)}</span>}<Icon.chevron /></button>
          : <div key={r.label} className="st-sysrow plain"><Icon.phone /><span className="flex-1"><b>{r.label}</b>{r.sub && <small>{r.sub}</small>}</span>{r.size !== undefined && <span className="muted">{bytes(r.size)}</span>}</div>
      ))}
      {c.items?.map((i) => <CleanRow key={i.path} item={i} ticked={ticks.has(i.path)} onTick={(on) => onTick(i.path, on)} icons={icons} />)}
      {c.actions && <div className="st-syscard-actions">{c.actions.map((a) => <button key={a.label} type="button" className="st-button" onClick={() => act(a)}>{a.label}</button>)}</div>}
    </section>
  )
}

export function Installers(): ReactElement {
  const [tab, setTab] = useState<'installers' | 'receipts'>('installers')
  const tabs = <div className="st-tabsbar"><Segmented value={tab} onChange={setTab} options={[{ id: 'installers', label: 'Leftover Installers' }, { id: 'receipts', label: 'Install Receipts' }]} /></div>
  if (tab === 'installers') {
    return (
      <CleanRoom room="installers" from="Installers" title="Installers" header={tabs} recommend="Select Confirmed"
        measuring="Looking inside the installers in Downloads and on the Desktop…" load={() => window.api.invoke('storage:installers')}
        summary={(r) => { const n = r.groups.flatMap((g) => g.items); return `${plural(n.length, 'installer')} for apps already installed, ${bytes(n.reduce((s, i) => s + i.size, 0))}` }}
        footNote="The apps stay installed. Installers go to the Trash, and can be put back."
        intro="Disk images, packages and zips in Downloads and on the Desktop whose app is already installed, at their version or newer. The app looks inside each without installing anything." />
    )
  }
  return <Receipts tabs={tabs} />
}

/** What each installer package put on this Mac, from macOS's receipts, and how much of it is still there. */
function Receipts({ tabs }: { tabs: ReactElement }): ReactElement {
  const [n, setN] = useState(0)
  const load = useLoad<PackageReceipt[]>(() => window.api.invoke('storage:receipts'), [n])
  const [sort, setSort] = useState<'size' | 'name' | 'date'>('size')
  const list = useMemo(() => [...(load.data ?? [])].sort(sort === 'name' ? (a, b) => (a.app ?? a.id).localeCompare(b.app ?? b.id) : sort === 'date' ? (a, b) => b.installedAt - a.installedAt : (a, b) => b.bytes - a.bytes), [load.data, sort])
  return (
    <div className="st-room">
      <TopBar title="Installers" />
      {tabs}
      <Intro actions={<button type="button" className="st-button" disabled={load.loading} onClick={() => setN((x) => x + 1)}><Icon.refresh />{load.loading ? 'Reading…' : 'Look Again'}</button>}>
        Each installer package's receipt lists what it put on this Mac, what is still there, and whether the app it installed is. Packages install into folders only an administrator can change; remove those apps with their own uninstaller, or in Finder.
      </Intro>
      <ListBar text={load.data ? `${plural(list.length, 'package')} besides Apple's` : 'Reading what each package installed…'}>
        <Segmented small value={sort} onChange={setSort} options={[{ id: 'size', label: 'Largest' }, { id: 'date', label: 'Newest' }, { id: 'name', label: 'Name' }]} />
      </ListBar>
      <div className="st-list">
        {load.data && !list.length && <div className="st-empty"><h3>No installer receipts</h3><p className="muted">Nothing has been installed from a package on this Mac, apart from Apple's own.</p></div>}
        {list.map((r) => (
          <div key={r.id} className="st-row">
            <span className="st-row-tick" />
            <span className="st-icon st-icon-glyph"><Icon.box /></span>
            <div className="st-row-body">
              <div className="st-row-title"><span className="st-row-name">{r.app ?? r.id}</span><span className="muted">{r.version}</span>{r.remaining === 0 && !r.unreadable && <Badge tone="muted">Only its receipt</Badge>}</div>
              <div className="st-row-sub">{r.app ? `${r.id} · ` : ''}into {tilde(r.location)}{r.installedAt ? ` · ${ago(r.installedAt)}` : ''} · {r.remaining.toLocaleString('en-US')} of {plural(r.files, 'file')} still there{r.unreadable ? `, ${r.unreadable.toLocaleString('en-US')} out of reach` : ''}</div>
            </div>
            <button type="button" className="st-link st-reveal" onClick={() => void window.api.invoke('local:reveal', r.location)}>Reveal</button>
            <span className="st-size">{bytes(r.bytes, '0 bytes')}</span>
          </div>
        ))}
      </div>
      <Footer count={0} note="Receipts are macOS's own record; this lists them and changes nothing." />
    </div>
  )
}

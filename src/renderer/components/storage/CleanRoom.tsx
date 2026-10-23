import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { groupSize, type CleanGroup, type CleanItem, type CleanReport } from '@shared/cleanup'
import { ago, bytes, plural } from '@shared/storage'
import { useStore } from '../../store'
import { Icon } from '../icons'
import { Badge, changed, GroupHead, Intro, ItemIcon, ItemMenu, ListBar, Row, Segmented, TopBar, TrashFooter, useIcons, where } from './parts'
import { setRoom, useStorage, type RoomId } from './state'

/**
 * A Cleanup room's list (Junk Files, Leftovers, Installers): main measures its places into groups of items; what is
 * safe to clear starts ticked, what only shows says why and what to do instead. The report is kept while the page
 * lives, and what goes to the Trash leaves it at once.
 */

export default function CleanRoom({ room, title, intro, measuring, load, from, recommend = 'Select Recommended', summary, footNote, header }: {
  room: RoomId
  title: string
  intro: ReactNode
  /** What the room says while it measures. */
  measuring: string
  load: () => Promise<CleanReport>
  /** The room's name in Recently Removed. */
  from?: string
  /** The Select link for what starts ticked. */
  recommend?: string
  /** "237 items, 70.2 GB": the list bar's text. */
  summary?: (r: CleanReport) => string
  footNote?: string
  /** Above the intro (Installers' tabs). */
  header?: ReactNode
}): ReactElement {
  const report = useStorage((s) => s.reports[room])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ticks, setTicks] = useState<Set<string>>(new Set())
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const [sort, setSort] = useState<'size' | 'name'>('size')
  const [menu, setMenu] = useState<{ item: CleanItem; anchor: HTMLElement } | null>(null)

  const measure = (): void => {
    setBusy(true)
    setError(null)
    load().then((r) => useStorage.setState((s) => ({ reports: { ...s.reports, [room]: r } })), (e: Error) => setError(e.message)).finally(() => setBusy(false))
  }
  useEffect(() => { if (!report && !busy) measure() }, [room]) // eslint-disable-line react-hooks/exhaustive-deps
  const recommended = useMemo(() => report?.groups.flatMap((g) => g.items.filter((i) => i.safe && !i.blocked).map((i) => i.path)) ?? [], [report])
  // A new report ticks what is safe; a smaller one (things went to the Trash) keeps the user's ticks.
  useEffect(() => { setTicks(new Set(recommended)) }, [report?.at]) // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => {
    const gs = (report?.groups ?? []).map((g) => ({ ...g, items: [...g.items].sort(sort === 'name' ? (a, b) => (a.label ?? a.name).localeCompare(b.label ?? b.name) : (a, b) => b.size - a.size) }))
    return sort === 'name' ? gs.sort((a, b) => a.title.localeCompare(b.title)) : gs.sort((a, b) => groupSize(b) - groupSize(a))
  }, [report, sort])
  const items = useMemo(() => groups.flatMap((g) => g.items), [groups])
  const icons = useIcons(items.map((i) => i.app ?? (i.path.startsWith('/') && !i.path.includes('#') ? i.path : undefined)))
  const picked = items.filter((i) => !i.blocked && ticks.has(i.path))
  const total = items.reduce((s, i) => s + i.size, 0)
  const tick = (paths: string[], on: boolean): void => setTicks((t) => { const n = new Set(t); for (const p of paths) { if (on) n.add(p); else n.delete(p) } return n })

  return (
    <div className="st-room">
      <TopBar title={title} />
      {header}
      <Intro actions={<button type="button" className="st-button" disabled={busy} onClick={measure}><Icon.refresh />{busy ? 'Looking…' : 'Look Again'}</button>}>{intro}</Intro>
      {report?.notes.map((n) => <div key={n} className="st-note"><Icon.shield />{n}</div>)}
      <ListBar text={busy && !report ? measuring : report ? (summary ? summary(report) : `${plural(items.length, 'item')}, ${bytes(total)}`) : ''}
        links={[{ label: recommend, onClick: () => setTicks(new Set(recommended)), disabled: !recommended.length }, { label: 'Select All', onClick: () => setTicks(new Set(items.filter((i) => !i.blocked).map((i) => i.path))), disabled: !items.length }, { label: 'Select None', onClick: () => setTicks(new Set()), disabled: !picked.length }]}>
        <Segmented small value={sort} onChange={setSort} options={[{ id: 'size', label: 'Largest' }, { id: 'name', label: 'Name' }]} />
      </ListBar>
      <div className="st-list">
        {error && <div className="plan-error"><Icon.alert />{error}</div>}
        {busy && !report && <div className="st-empty"><div className="st-spinner" aria-hidden="true" /><h3>{measuring}</h3></div>}
        {report && !report.groups.length && <div className="st-empty"><span className="st-empty-art"><Icon.check /></span><h3>Nothing here worth clearing</h3></div>}
        {groups.map((g) => (
          <Group key={g.id} group={g} ticks={ticks} open={!closed.has(g.id)} icons={icons}
            onToggle={() => setClosed((o) => { const n = new Set(o); if (n.has(g.id)) n.delete(g.id); else n.add(g.id); return n })}
            onTick={tick} onMenu={(item, anchor) => setMenu({ item, anchor })} />
        ))}
        {report && <p className="st-list-foot muted">Measured {ago(report.at)}.</p>}
      </div>
      <TrashFooter items={picked.map((i) => ({ path: i.path, size: i.size, dir: i.dir }))} from={from ?? title} note={footNote} />
      {menu && <ItemMenu node={{ path: menu.item.path, dir: menu.item.dir, size: menu.item.size }} anchor={menu.anchor} from={from ?? title} onClose={() => setMenu(null)} />}
    </div>
  )
}

/** Opens what an item offers instead of the Trash: a setting, a command to copy, Finder, another room. */
export function act(a: NonNullable<CleanItem['action']>): void {
  if (a.url) void window.api.invoke('shell:open', a.url)
  else if (a.copy) void window.api.invoke('clipboard:write', a.copy).then(() => useStore.getState().toast('success', `Copied: ${a.copy}. Paste it in Terminal.`))
  else if (a.reveal) void window.api.invoke('local:reveal', a.reveal)
  else if (a.room === 'trash') void window.api.invoke('storage:openTrash')
  else if (a.room) setRoom(a.room as RoomId)
}

/** One item of a report as a row: its title in words, its folder's name and age beneath, badges, Reveal, size. */
export function CleanRow({ item: i, ticked, onTick, icons, onMenu, indent }: { item: CleanItem; ticked: boolean; onTick: (on: boolean) => void; icons: Map<string, string>; onMenu?: (anchor: HTMLElement) => void; indent?: boolean }): ReactElement {
  const real = i.path.startsWith('/') && !i.path.includes('#')
  const sub = i.sub ?? [i.label ? i.name : real ? where(i.path) : '', changed(i.mtime)].filter(Boolean).join(' · ')
  return (
    <Row indent={indent} checked={ticked} onCheck={i.blocked ? undefined : onTick} lock={!!i.blocked}
      icon={<ItemIcon path={i.app ?? (real ? i.path : undefined)} icons={icons} dir={i.dir} />}
      title={<span title={[i.note, i.blocked].filter(Boolean).join(' ')}>{i.label ?? i.name}</span>}
      badges={i.badges?.map((b) => <Badge key={b.text} tone={b.tone}>{b.text}</Badge>)}
      sub={sub || i.note}
      extra={i.action && !i.action.reveal ? <button type="button" className="st-button sm" onClick={(e) => { e.stopPropagation(); act(i.action!) }}>{i.action.copy ? <Icon.copy /> : null}{i.action.label}</button> : undefined}
      reveal={real ? i.path : undefined} size={i.size}
      onMenu={real && !i.blocked ? onMenu : undefined} />
  )
}

function Group({ group, ticks, open, icons, onToggle, onTick, onMenu }: {
  group: CleanGroup
  ticks: Set<string>
  open: boolean
  icons: Map<string, string>
  onToggle: () => void
  onTick: (paths: string[], on: boolean) => void
  onMenu: (item: CleanItem, anchor: HTMLElement) => void
}): ReactElement {
  const selectable = group.items.filter((i) => !i.blocked)
  const on = selectable.filter((i) => ticks.has(i.path))
  return (
    <section className="st-group">
      <GroupHead look={group.look ?? 'items'} title={group.title} sub={group.sub ?? group.text} size={groupSize(group)} open={open} onToggle={onToggle}
        state={!selectable.length ? 'off' : on.length === selectable.length ? 'all' : on.length ? 'some' : 'none'} onTick={(v) => onTick(selectable.map((i) => i.path), v)} />
      {open && group.items.map((i) => <CleanRow key={i.path} item={i} ticked={ticks.has(i.path)} onTick={(v) => onTick([i.path], v)} icons={icons} onMenu={(a) => onMenu(i, a)} indent />)}
    </section>
  )
}

import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { groupSize, type CleanGroup, type CleanItem, type CleanReport } from '@shared/cleanup'
import { ago, bytes, plural } from '@shared/storage'
import { useStore } from '../../store'
import { Icon } from '../icons'
import { ItemMenu, ItemRow, NodeIcon, RoomHead, tilde, TrashBar, useNodeIcons } from './parts'
import { setRoom, useStorage, type RoomId } from './state'

/**
 * One Cleanup room (Junk Files, AI Models, System Data, Installers): main measures its places into groups of items;
 * what is safe to clear starts ticked, what only shows says why and what to do instead. The report is kept while the
 * page lives, and what goes to the Trash leaves it at once.
 */

const SHOW = 6

export default function CleanRoom({ room, icon, title, sub, intro, measuring, load, after, from }: {
  room: RoomId
  icon: ReactElement
  title: string
  sub: string
  intro: ReactNode
  /** What the room says while it measures. */
  measuring: string
  load: () => Promise<CleanReport>
  /** More below the list (Installers' receipts). */
  after?: ReactNode
  /** The room's name in Recently Removed. */
  from?: string
}): ReactElement {
  const report = useStorage((s) => s.reports[room])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ticks, setTicks] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<{ item: CleanItem; anchor: HTMLElement } | null>(null)

  const measure = (): void => {
    setBusy(true)
    setError(null)
    load().then((r) => useStorage.setState((s) => ({ reports: { ...s.reports, [room]: r } })), (e: Error) => setError(e.message)).finally(() => setBusy(false))
  }
  useEffect(() => { if (!report && !busy) measure() }, [room]) // eslint-disable-line react-hooks/exhaustive-deps
  // A new report ticks what is safe; a smaller one (things went to the Trash) keeps the user's ticks.
  useEffect(() => { setTicks(new Set(report?.groups.flatMap((g) => g.items.filter((i) => i.safe && !i.blocked).map((i) => i.path)) ?? [])) }, [report?.at]) // eslint-disable-line react-hooks/exhaustive-deps

  const items = useMemo(() => report?.groups.flatMap((g) => g.items) ?? [], [report])
  const icons = useNodeIcons(useMemo(() => items.filter((i) => i.path.startsWith('/') && !i.path.includes('#')), [items]))
  const picked = items.filter((i) => !i.blocked && ticks.has(i.path))
  const total = items.reduce((s, i) => s + i.size, 0)
  const safe = items.filter((i) => i.safe && !i.blocked).reduce((s, i) => s + i.size, 0)
  const tick = (paths: string[], on: boolean): void => setTicks((t) => { const n = new Set(t); for (const p of paths) { if (on) n.add(p); else n.delete(p) } return n })

  const act = (a: NonNullable<CleanItem['action']>): void => {
    if (a.url) void window.api.invoke('shell:open', a.url)
    else if (a.copy) void window.api.invoke('clipboard:write', a.copy).then(() => useStore.getState().toast('success', `Copied: ${a.copy}. Paste it in Terminal.`))
    else if (a.reveal) void window.api.invoke('local:reveal', a.reveal)
    else if (a.room === 'trash') void window.api.invoke('storage:openTrash')
    else if (a.room) setRoom(a.room as RoomId)
  }

  return (
    <div className="st-list-room">
      <RoomHead icon={icon} title={title} sub={busy ? measuring : report ? (total ? `${bytes(total)} found · ${bytes(safe)} can go without losing anything` : sub) : sub}>
        {report && <span className="muted st-when">Measured {ago(report.at)}</span>}
        <button type="button" className="btn btn-sm" disabled={busy} onClick={measure}><Icon.refresh />{busy ? 'Measuring…' : 'Look again'}</button>
      </RoomHead>
      <p className="st-intro">{intro}</p>
      {report?.notes.map((n) => <div key={n} className="st-note"><Icon.shield />{n}</div>)}
      <div className="plan-scroll st-list">
        {error && <div className="plan-error"><Icon.alert />{error}</div>}
        {busy && !report && <div className="st-empty"><div className="st-spinner" aria-hidden="true" /><p>{measuring}</p></div>}
        {report && !report.groups.length && <div className="st-empty"><Icon.check className="plan-empty-icon" /><p>Nothing here worth clearing.</p></div>}
        {report?.groups.map((g) => <Group key={g.id} group={g} ticks={ticks} open={open.has(g.id)} icons={icons}
          onOpen={() => setOpen((o) => { const n = new Set(o); if (n.has(g.id)) n.delete(g.id); else n.add(g.id); return n })}
          onTick={tick} onAct={act} onMenu={(item, anchor) => setMenu({ item, anchor })} />)}
        {after}
      </div>
      <TrashBar items={picked.map((i) => ({ path: i.path, size: i.size, dir: i.dir }))} from={from ?? title} />
      {menu && <ItemMenu node={{ path: menu.item.path, dir: menu.item.dir, size: menu.item.size }} anchor={menu.anchor} from={from ?? title} onClose={() => setMenu(null)} />}
    </div>
  )
}

function Group({ group, ticks, open, icons, onOpen, onTick, onAct, onMenu }: {
  group: CleanGroup
  ticks: Set<string>
  open: boolean
  icons: Map<string, string>
  onOpen: () => void
  onTick: (paths: string[], on: boolean) => void
  onAct: (a: NonNullable<CleanItem['action']>) => void
  onMenu: (item: CleanItem, anchor: HTMLElement) => void
}): ReactElement {
  const selectable = group.items.filter((i) => !i.blocked)
  const on = selectable.filter((i) => ticks.has(i.path))
  const shown = open || group.items.length <= SHOW + 1 ? group.items : group.items.slice(0, SHOW)
  return (
    <section className="st-group">
      <header className="st-group-head">
        {selectable.length > 0 && (
          <input type="checkbox" className="st-check" aria-label={`Select all in ${group.title}`} checked={on.length === selectable.length}
            ref={(el) => { if (el) el.indeterminate = on.length > 0 && on.length < selectable.length }}
            onChange={(e) => onTick(selectable.map((i) => i.path), e.target.checked)} />
        )}
        <div className="st-group-text">
          <h3>{group.title} <span className="muted">{plural(group.items.length, 'item')}</span></h3>
          {group.text && <p>{group.text}</p>}
        </div>
        <span className="st-size">{bytes(groupSize(group))}</span>
      </header>
      {shown.map((i) => (
        <ItemRow key={i.path} checked={ticks.has(i.path)} onCheck={i.blocked ? undefined : (v) => onTick([i.path], v)} disabled={!!i.blocked}
          icon={i.path.startsWith('/') && !i.path.includes('#') ? <NodeIcon node={i} icons={icons} /> : <span className="st-icon st-icon-glyph"><Icon.layers /></span>}
          title={i.name} sub={i.path.startsWith('/') && !i.path.includes('#') ? <span title={i.path}>{tilde(i.path.replace(/\/[^/]+$/, ''))}</span> : undefined}
          note={[i.note, i.blocked].filter(Boolean).join(' ')} warn={!i.safe && !i.blocked} size={i.size}
          extra={i.action && <button type="button" className="btn btn-sm" onClick={(e) => { e.stopPropagation(); onAct(i.action!) }}>{i.action.copy ? <Icon.copy /> : i.action.url ? <Icon.settings /> : null}{i.action.label}</button>}
          onMenu={i.path.startsWith('/') && !i.path.includes('#') && !i.blocked ? (anchor) => onMenu(i, anchor) : undefined} />
      ))}
      {group.items.length > shown.length && <button type="button" className="st-showmore" onClick={onOpen}>Show {plural(group.items.length - shown.length, 'more item')}</button>}
      {open && group.items.length > SHOW + 1 && <button type="button" className="st-showmore" onClick={onOpen}>Show fewer</button>}
    </section>
  )
}

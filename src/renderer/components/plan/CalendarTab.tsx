import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement, type RefObject } from 'react'
import { CALENDAR_COLORS, layoutDay, monthDays, occurrences, parseEventInput, weekDays, type CalEvent, type CalendarList, type Occurrence } from '@shared/calendar'
import { parseIcs, toIcs } from '@shared/ics'
import { addDays, addMonths, dayName, daysBetween, fromMinutes, fromYmd, monthName, relativeDay, repeatLabel, timeLabel, toMinutes, ymd, type Repeat } from '@shared/naturalDate'
import { itemsOf, putOp, puts, type RecordOp } from '@shared/records'
import { completeTask, type Task } from '@shared/tasks'
import { applyRecords, useRecords } from '../../records'
import { setTabKeys } from '../../shortcuts'
import { useStore, type Tab } from '../../store'
import { Icon } from '../icons'
import Modal from '../Modal'
import { downloadText, newId, pickTextFile, typing, UndoBar, useLocal, useToday } from './parts'
import './plan.css'

/**
 * Calendar: month, week, day and agenda views of the calendars kept as records (src/shared/calendar.ts), iCal links
 * read on the fly (calendar:feed; Google Calendar's secret address, iCloud's public link), and the dated tasks from
 * Tasks. Quick add reads "Lunch with Sam fri 12:30"; .ics files import into a calendar of their own and export back.
 * Keys while it is in front and nothing is typed: T today, ← → move, D W M A for the views, N new event (⌘N anywhere).
 */

type View = 'day' | 'week' | 'month' | 'agenda'
const HOUR = 44
const REPEATS: { id: string; label: string; repeat?: Repeat }[] = [
  { id: '', label: 'Does not repeat' },
  { id: 'daily', label: 'Every day', repeat: { freq: 'daily', interval: 1 } },
  { id: 'weekdays', label: 'Every weekday', repeat: { freq: 'weekly', interval: 1, byDay: [1, 2, 3, 4, 5] } },
  { id: 'weekly', label: 'Every week', repeat: { freq: 'weekly', interval: 1 } },
  { id: 'biweekly', label: 'Every 2 weeks', repeat: { freq: 'weekly', interval: 2 } },
  { id: 'monthly', label: 'Every month', repeat: { freq: 'monthly', interval: 1 } },
  { id: 'yearly', label: 'Every year', repeat: { freq: 'yearly', interval: 1 } }
]
const repeatId = (r?: Repeat): string => (!r ? '' : REPEATS.find((x) => x.repeat && JSON.stringify(x.repeat) === JSON.stringify(r))?.id ?? 'custom')

/** Subscribed calendars' events by calendar, kept for the page so switching tabs does not fetch again. */
const feeds = new Map<string, { at: number; events: CalEvent[]; error?: string; url: string }>()
const FEED_TTL = 30 * 60_000

interface Item {
  key: string
  day: string
  allDay: boolean
  start?: number
  end?: number
  first: boolean
  last: boolean
  title: string
  color: string
  event?: CalEvent
  task?: Task
  readOnly?: boolean
}

const monthTitle = (day: string): string => { const d = fromYmd(day); return `${monthName(d.getMonth())} ${d.getFullYear()}` }
const timeShort = (m: number): string => timeLabel(fromMinutes(m)).replace(' ', '').toLowerCase().replace(':00', '')

export default function CalendarTab({ active }: { tab: Tab; active: boolean }): ReactElement {
  const toast = useStore((s) => s.toast)
  const openTool = useStore((s) => s.openTool)
  const { doc, error } = useRecords('calendar')
  const tasksDoc = useRecords('tasks').doc
  const today = useToday()
  const [view, setView] = useLocal<View>('calendar.view', 'month')
  const [showTasks, setShowTasks] = useLocal<'on' | 'off'>('calendar.tasks', 'on')
  const [cursor, setCursor] = useState(today)
  const [editing, setEditing] = useState<{ event: CalEvent; isNew: boolean } | null>(null)
  const [undo, setUndo] = useState<{ label: string; key: number; ops: RecordOp[] } | null>(null)
  const [feedTick, setFeedTick] = useState(0)
  const [subscribing, setSubscribing] = useState(false)
  const addRef = useRef<HTMLInputElement>(null)

  const calendars = useMemo(() => (doc ? itemsOf<CalendarList>(doc, 'calendar').sort((a, b) => a.order - b.order) : []), [doc])
  const calById = useMemo(() => new Map(calendars.map((c) => [c.id, c])), [calendars])
  const local = calendars.filter((c) => !c.url)
  const events = useMemo(() => (doc ? itemsOf<CalEvent>(doc, 'event') : []), [doc])

  // Subscriptions: fetched when shown and every half hour.
  useEffect(() => {
    if (!active) return
    let stop = false
    const pull = async (force = false): Promise<void> => {
      for (const c of calendars.filter((x) => x.url && !x.hidden)) {
        const have = feeds.get(c.id)
        if (!force && have && have.url === c.url && Date.now() - have.at < FEED_TTL) continue
        try {
          const ics = parseIcs(await window.api.invoke('calendar:feed', c.url!))
          feeds.set(c.id, { at: Date.now(), url: c.url!, events: ics.events.map((e, i) => ({ ...e, id: `${c.id}-${i}`, type: 'event', calendarId: c.id, updatedAt: 0 })) })
        } catch (e) {
          feeds.set(c.id, { at: Date.now(), url: c.url!, events: have?.events ?? [], error: (e as Error).message })
        }
        if (!stop) setFeedTick((n) => n + 1)
      }
    }
    void pull()
    const t = setInterval(() => void pull(), FEED_TTL)
    const refresh = (): void => void pull(true)
    window.addEventListener('ec2ra:calendar-refresh', refresh)
    return () => { stop = true; clearInterval(t); window.removeEventListener('ec2ra:calendar-refresh', refresh) }
  }, [active, calendars])

  const range = useMemo((): [string, string] => {
    if (view === 'month') { const d = monthDays(cursor); return [d[0], d[41]] }
    if (view === 'week') { const d = weekDays(cursor); return [d[0], d[6]] }
    if (view === 'day') return [cursor, cursor]
    return [cursor, addDays(cursor, 59)]
  }, [view, cursor])

  const items = useMemo((): Item[] => {
    void feedTick
    const shown = new Set(calendars.filter((c) => !c.hidden).map((c) => c.id))
    const all = [...events.filter((e) => shown.has(e.calendarId)), ...calendars.filter((c) => c.url && !c.hidden).flatMap((c) => feeds.get(c.id)?.events ?? [])]
    const out: Item[] = occurrences(all, range[0], range[1]).map((o: Occurrence) => {
      const cal = calById.get(o.event.calendarId)
      return { key: o.key, day: o.day, allDay: o.allDay, start: o.start, end: o.end, first: o.first, last: o.last, title: o.event.title, color: cal?.color ?? CALENDAR_COLORS[0], event: o.event, readOnly: !!cal?.url }
    })
    if (showTasks === 'on' && tasksDoc) {
      for (const t of itemsOf<Task>(tasksDoc, 'task')) {
        if (!t.date || t.someday || t.date < range[0] || t.date > range[1]) continue
        if (t.doneAt && daysBetween(ymd(new Date(t.doneAt)), today) > 0 && t.date < today) continue
        const start = t.time ? toMinutes(t.time) : undefined
        out.push({ key: `task:${t.id}`, day: t.date, allDay: start === undefined, start, end: start !== undefined ? start + 30 : undefined, first: true, last: true, title: t.title, color: 'var(--accent)', task: t })
      }
    }
    return out.sort((a, b) => a.day.localeCompare(b.day) || Number(b.allDay) - Number(a.allDay) || (a.start ?? 0) - (b.start ?? 0))
  }, [events, calendars, calById, range, showTasks, tasksDoc, today, feedTick])
  const byDay = useMemo(() => {
    const m = new Map<string, Item[]>()
    for (const it of items) m.set(it.day, [...(m.get(it.day) ?? []), it])
    return m
  }, [items])

  /** The calendar new events go in: the first local one, made when there is none. */
  const defaultCalendar = (): { id: string; ops: RecordOp[] } => {
    const first = local.find((c) => !c.hidden) ?? local[0]
    if (first) return { id: first.id, ops: [] }
    const id = newId()
    return { id, ops: [putOp<CalendarList>({ id, type: 'calendar', name: 'Personal', color: CALENDAR_COLORS[0], order: 1, updatedAt: Date.now() })] }
  }
  const newEvent = (day: string, start?: string, end?: string): void => {
    const cal = defaultCalendar()
    if (cal.ops.length) void applyRecords('calendar', cal.ops)
    setEditing({ isNew: true, event: { id: newId(), type: 'event', calendarId: cal.id, title: '', date: day, ...(start ? { start, end: end ?? fromMinutes(toMinutes(start) + 60) } : {}), updatedAt: Date.now() } })
  }
  const quickAdd = (text: string): boolean => {
    const p = parseEventInput(text, view === 'month' || view === 'agenda' ? (cursor === today ? today : cursor) : cursor)
    if (!p.title) return false
    const cal = defaultCalendar()
    const e: CalEvent = { id: newId(), type: 'event', calendarId: cal.id, title: p.title, date: p.date, ...(p.start ? { start: p.start, end: p.end } : {}), ...(p.repeat ? { repeat: p.repeat } : {}), updatedAt: Date.now() }
    void applyRecords('calendar', [...cal.ops, { op: 'put', item: e }])
    setCursor(p.date)
    toast('success', `${p.title}: ${relativeDay(p.date, today)}${p.start ? ` ${timeLabel(p.start)}` : ''}`)
    return true
  }
  const saveEvent = (e: CalEvent): void => {
    const clean = { ...e }
    for (const k of Object.keys(clean) as (keyof CalEvent)[]) if (clean[k] === undefined || clean[k] === '') delete clean[k]
    void applyRecords('calendar', puts([clean]))
  }
  const deleteEvent = (e: CalEvent): void => {
    void applyRecords('calendar', [{ op: 'delete', id: e.id }])
    setUndo({ label: `Deleted “${e.title}”`, key: Date.now(), ops: puts([e]) })
  }
  // A task opens the Tasks tab; an event its editor (read-only for a subscribed calendar).
  const openItem = (it: Item): void => {
    if (it.task) openTool('tasks')
    else if (it.event) setEditing({ event: it.event, isNew: false })
  }
  const toggleTask = (t: Task): void => void applyRecords('tasks', puts(t.doneAt ? [{ ...t, doneAt: undefined }] : completeTask(t, Date.now(), today, newId)))

  const step = (dir: 1 | -1): void => setCursor((c) => (view === 'month' ? addMonths(c, dir) : view === 'week' ? addDays(c, 7 * dir) : view === 'day' ? addDays(c, dir) : addDays(c, 30 * dir)))

  // Keys.
  useEffect(() => {
    if (!active) return
    setTabKeys('calendar', (k) => {
      if (k.key === 'n' && !k.shift && !k.alt) { addRef.current?.focus(); return true }
      return false
    })
    return () => setTabKeys('calendar', null)
  }, [active])
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined)
  keyRef.current = (e: KeyboardEvent): void => {
    if (typing(e) || e.metaKey || e.ctrlKey || e.altKey || editing || document.querySelector('.modal-backdrop')) return
    const k = e.key.toLowerCase()
    const views: Record<string, View> = { d: 'day', w: 'week', m: 'month', a: 'agenda' }
    if (k === 't') setCursor(today)
    else if (k === 'arrowleft') step(-1)
    else if (k === 'arrowright') step(1)
    else if (views[k]) setView(views[k])
    else if (k === 'n') { e.preventDefault(); addRef.current?.focus() } else return
    e.preventDefault()
  }
  useEffect(() => {
    if (!active) return
    const on = (e: KeyboardEvent): void => keyRef.current(e)
    document.addEventListener('keydown', on)
    return () => document.removeEventListener('keydown', on)
  }, [active])

  const importIcs = async (): Promise<void> => {
    const file = await pickTextFile('.ics,text/calendar')
    if (!file) return
    try {
      const cal = parseIcs(file.text)
      if (!cal.events.length) { toast('info', 'No events in that file.'); return }
      const name = cal.name ?? file.name.replace(/\.ics$/i, '')
      const existing = local.find((c) => c.name.toLowerCase() === name.toLowerCase())
      const calId = existing?.id ?? newId()
      const ops: RecordOp[] = existing ? [] : [putOp<CalendarList>({ id: calId, type: 'calendar', name, color: CALENDAR_COLORS[calendars.length % CALENDAR_COLORS.length], order: calendars.length + 1, updatedAt: Date.now() })]
      // Importing the same file again adds nothing: events already there by their iCal UID are left.
      const have = new Set(events.filter((e) => e.calendarId === calId && e.uid).map((e) => e.uid))
      let added = 0
      for (const e of cal.events) {
        if (e.uid && have.has(e.uid)) continue
        ops.push(putOp<CalEvent>({ ...e, id: newId(), type: 'event', calendarId: calId, updatedAt: Date.now() }))
        added++
      }
      await applyRecords('calendar', ops)
      toast('success', `${added} event${added === 1 ? '' : 's'} imported into “${name}”${cal.events.length > added ? ` (${cal.events.length - added} already there)` : ''}${cal.approximate ? `. ${cal.approximate} repeat${cal.approximate === 1 ? '' : 's'} kept as single events` : ''}.`)
    } catch (e) { toast('error', (e as Error).message) }
  }
  const exportIcs = (cal?: CalendarList): void => {
    const list = events.filter((e) => (cal ? e.calendarId === cal.id : local.some((c) => c.id === e.calendarId)))
    if (!list.length) { toast('info', 'No events to export.'); return }
    downloadText(`${cal?.name ?? 'Calendar'}.ics`, toIcs(list, cal?.name ?? 'Calendar'), 'text/calendar')
  }

  const title = view === 'month' || view === 'agenda' ? monthTitle(cursor) : view === 'week'
    ? (() => { const d = weekDays(cursor); const a = fromYmd(d[0]); const b = fromYmd(d[6]); return a.getMonth() === b.getMonth() ? `${monthName(a.getMonth())} ${a.getDate()}–${b.getDate()}, ${b.getFullYear()}` : `${monthName(a.getMonth(), true)} ${a.getDate()} – ${monthName(b.getMonth(), true)} ${b.getDate()}, ${b.getFullYear()}` })()
    : `${dayName(cursor)}, ${monthName(fromYmd(cursor).getMonth())} ${fromYmd(cursor).getDate()}`

  return (
    <section className="plan calendar" aria-label="Calendar">
      <aside className="plan-side" aria-label="Calendars">
        <MiniMonth cursor={cursor} today={today} busy={byDay} onPick={setCursor} />
        <h4>Calendars<button type="button" className="plan-add" aria-label="New calendar" title="New calendar" onClick={() => {
          const name = window.prompt('Name of the new calendar')?.trim()
          if (name) void applyRecords('calendar', puts([{ id: newId(), type: 'calendar', name, color: CALENDAR_COLORS[calendars.length % CALENDAR_COLORS.length], order: calendars.length + 1, updatedAt: Date.now() } as CalendarList]))
        }}><Icon.plus /></button></h4>
        {calendars.map((c) => (
          <CalendarRow key={c.id} cal={c} feed={feeds.get(c.id)} onChange={(next) => void applyRecords('calendar', puts([next]))} onExport={() => exportIcs(c)}
            onRefresh={() => window.dispatchEvent(new Event('ec2ra:calendar-refresh'))}
            onDelete={() => {
              const own = events.filter((e) => e.calendarId === c.id)
              if (!window.confirm(`Delete the calendar “${c.name}”${own.length ? ` and its ${own.length} event${own.length === 1 ? '' : 's'}` : ''}?`)) return
              void applyRecords('calendar', [...own.map((e) => ({ op: 'delete' as const, id: e.id })), { op: 'delete', id: c.id }])
              setUndo({ label: `Deleted “${c.name}”`, key: Date.now(), ops: puts([c, ...own]) })
            }} />
        ))}
        {!calendars.length && <p className="plan-side-hint">Add an event and a “Personal” calendar is made for it.</p>}
        <label className="cal-toggle"><input type="checkbox" checked={showTasks === 'on'} onChange={(e) => setShowTasks(e.target.checked ? 'on' : 'off')} />Show tasks</label>
        <h4>Import and subscribe</h4>
        <button type="button" className="plan-nav" onClick={() => setSubscribing(true)}><Icon.globe />Subscribe to a calendar…</button>
        <button type="button" className="plan-nav" onClick={() => void importIcs()}><Icon.download />Import .ics file…</button>
        <button type="button" className="plan-nav" onClick={() => exportIcs()}><Icon.share />Export all (.ics)</button>
      </aside>

      <div className="plan-main">
        <header className="plan-head cal-head">
          <h1>{title}</h1>
          <span className="flex-1" />
          <button type="button" className="btn btn-sm" onClick={() => setCursor(today)} title="Today (T)">Today</button>
          <button type="button" className="btn btn-sm btn-icon" aria-label="Previous" title="Previous (←)" onClick={() => step(-1)}><Icon.back /></button>
          <button type="button" className="btn btn-sm btn-icon" aria-label="Next" title="Next (→)" onClick={() => step(1)}><Icon.forward /></button>
          <span className="plan-segment" role="radiogroup" aria-label="View">
            {(['day', 'week', 'month', 'agenda'] as View[]).map((v) => <button key={v} type="button" role="radio" aria-checked={view === v} className={view === v ? 'on' : ''} onClick={() => setView(v)} title={`${v[0].toUpperCase()}${v.slice(1)} (${v[0].toUpperCase()})`}>{v[0].toUpperCase() + v.slice(1)}</button>)}
          </span>
        </header>
        <QuickAdd inputRef={addRef} onAdd={quickAdd} />
        {error && <div className="plan-error cal-error"><Icon.alert />{error}</div>}
        {view === 'month' && <MonthView cursor={cursor} today={today} byDay={byDay} onDay={(d) => { setCursor(d); setView('day') }} onNew={(d) => newEvent(d)} onOpen={openItem} onToggle={toggleTask} />}
        {(view === 'week' || view === 'day') && <TimeView days={view === 'week' ? weekDays(cursor) : [cursor]} today={today} byDay={byDay} onNew={newEvent} onOpen={openItem} onToggle={toggleTask} onDay={(d) => { setCursor(d); setView('day') }} />}
        {view === 'agenda' && <AgendaView from={cursor} today={today} byDay={byDay} onOpen={openItem} onToggle={toggleTask} />}
        <UndoBar undo={undo} onUndo={() => { if (undo) void applyRecords('calendar', undo.ops); setUndo(null) }} onDone={() => setUndo(null)} />
      </div>

      {editing && <EventEditor event={editing.event} isNew={editing.isNew} calendars={calendars} readOnly={!!calById.get(editing.event.calendarId)?.url}
        onSave={(e) => { saveEvent(e); setEditing(null) }} onDelete={() => { deleteEvent(editing.event); setEditing(null) }} onClose={() => setEditing(null)} />}
      {subscribing && <SubscribeDialog onClose={() => setSubscribing(false)} onAdd={(name, url) => {
        void applyRecords('calendar', puts([{ id: newId(), type: 'calendar', name, url, color: CALENDAR_COLORS[(calendars.length + 3) % CALENDAR_COLORS.length], order: calendars.length + 1, updatedAt: Date.now() } as CalendarList]))
        setSubscribing(false)
      }} />}
    </section>
  )
}

function QuickAdd({ inputRef, onAdd }: { inputRef: RefObject<HTMLInputElement | null>; onAdd: (text: string) => boolean }): ReactElement {
  const [text, setText] = useState('')
  const found = useMemo(() => (text.trim() ? parseEventInput(text, ymd(new Date())).found : []), [text])
  return (
    <form className="tasks-add cal-add" onSubmit={(e) => { e.preventDefault(); if (onAdd(text)) setText('') }}>
      <Icon.plus className="tasks-add-icon" />
      <input ref={inputRef} className="tasks-add-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="New event — try “Lunch with Sam fri 12:30” or “Standup every weekday 9:30”" aria-label="New event"
        onKeyDown={(e) => { if (e.key === 'Escape') { setText(''); e.currentTarget.blur() } }} />
      {found.length > 0 && <span className="tasks-add-found">{found.map((f) => <span key={f} className="plan-chip">{f}</span>)}</span>}
    </form>
  )
}

function MiniMonth({ cursor, today, busy, onPick }: { cursor: string; today: string; busy: Map<string, Item[]>; onPick: (d: string) => void }): ReactElement {
  const [month, setMonth] = useState(cursor)
  useEffect(() => setMonth(cursor), [cursor.slice(0, 7)]) // eslint-disable-line react-hooks/exhaustive-deps
  const days = monthDays(month)
  return (
    <div className="cal-mini">
      <div className="cal-mini-head">
        <span>{monthTitle(month)}</span>
        <button type="button" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}><Icon.back /></button>
        <button type="button" aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))}><Icon.forward /></button>
      </div>
      <div className="cal-mini-grid">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <span key={i} className="cal-mini-dow">{d}</span>)}
        {days.map((d) => (
          <button key={d} type="button" className={`${d.slice(0, 7) !== month.slice(0, 7) ? 'out' : ''} ${d === today ? 'today' : ''} ${d === cursor ? 'on' : ''} ${busy.get(d)?.length ? 'busy' : ''}`} onClick={() => onPick(d)} aria-label={d}>
            {fromYmd(d).getDate()}
          </button>
        ))}
      </div>
    </div>
  )
}

function CalendarRow({ cal, feed, onChange, onDelete, onExport, onRefresh }: { cal: CalendarList; feed?: { error?: string; events: CalEvent[] }; onChange: (c: CalendarList) => void; onDelete: () => void; onExport: () => void; onRefresh: () => void }): ReactElement {
  const [menu, setMenu] = useState(false)
  return (
    <div className="cal-row">
      <label className="cal-row-main" title={cal.url ? `Subscribed: ${cal.url.replace(/(https?:\/\/[^/]+\/).*/, '$1…')}` : cal.name}>
        <input type="checkbox" checked={!cal.hidden} onChange={() => onChange({ ...cal, hidden: !cal.hidden || undefined })} style={{ accentColor: cal.color }} aria-label={`Show ${cal.name}`} />
        <span className="plan-nav-label">{cal.name}</span>
        {cal.url && <Icon.globe className="cal-row-sub" />}
      </label>
      <button type="button" className="plan-add" aria-label={`${cal.name} options`} onClick={() => setMenu(!menu)}><Icon.more /></button>
      {feed?.error && <p className="cal-row-error" title={feed.error}>{feed.error}</p>}
      {menu && (
        <div className="cal-row-menu" onMouseLeave={() => setMenu(false)}>
          <div className="cal-colors">{CALENDAR_COLORS.map((c) => <button key={c} type="button" aria-label={`Colour ${c}`} className={c === cal.color ? 'on' : ''} style={{ background: c }} onClick={() => onChange({ ...cal, color: c })} />)}</div>
          <button type="button" onClick={() => { const name = window.prompt('Rename calendar', cal.name)?.trim(); if (name) onChange({ ...cal, name }); setMenu(false) }}>Rename…</button>
          {cal.url ? <button type="button" onClick={() => { onRefresh(); setMenu(false) }}>Refresh now</button> : <button type="button" onClick={() => { onExport(); setMenu(false) }}>Export .ics</button>}
          <button type="button" className="danger" onClick={() => { setMenu(false); onDelete() }}>{cal.url ? 'Unsubscribe' : 'Delete…'}</button>
        </div>
      )}
    </div>
  )
}

function Chip({ it, onOpen, onToggle }: { it: Item; onOpen: (it: Item) => void; onToggle: (t: Task) => void }): ReactElement {
  return (
    <div className={`cal-chip ${it.allDay ? 'all-day' : ''} ${it.task ? 'task' : ''} ${it.task?.doneAt ? 'done' : ''} ${it.first ? 'first' : ''} ${it.last ? 'last' : ''}`} style={{ '--c': it.color } as CSSProperties}
      onClick={(e) => { e.stopPropagation(); onOpen(it) }} title={`${it.title}${it.start !== undefined ? ` · ${timeLabel(fromMinutes(it.start))}` : ''}${it.event?.location ? ` · ${it.event.location}` : ''}`}>
      {it.task && <button type="button" className="cal-task-check" aria-label={it.task.doneAt ? 'Mark not done' : 'Complete'} onClick={(e) => { e.stopPropagation(); onToggle(it.task!) }}>{it.task.doneAt && <Icon.check />}</button>}
      {!it.allDay && !it.task && <span className="cal-chip-dot" />}
      {!it.allDay && <span className="cal-chip-time">{timeShort(it.start!)}</span>}
      <span className="cal-chip-title">{it.first || it.allDay ? it.title : `↳ ${it.title}`}</span>
    </div>
  )
}

function MonthView({ cursor, today, byDay, onDay, onNew, onOpen, onToggle }: { cursor: string; today: string; byDay: Map<string, Item[]>; onDay: (d: string) => void; onNew: (d: string) => void; onOpen: (it: Item) => void; onToggle: (t: Task) => void }): ReactElement {
  const days = monthDays(cursor)
  const month = cursor.slice(0, 7)
  return (
    <div className="cal-month">
      {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div key={d} className="cal-dow">{d}</div>)}
      {days.map((d) => {
        const list = byDay.get(d) ?? []
        const max = 4
        return (
          <div key={d} className={`cal-cell ${d.slice(0, 7) !== month ? 'out' : ''} ${d === today ? 'today' : ''} ${[0, 6].includes(fromYmd(d).getDay()) ? 'weekend' : ''}`} onDoubleClick={() => onNew(d)}>
            <button type="button" className="cal-daynum" onClick={() => onDay(d)} aria-label={`Open ${d}`}>{fromYmd(d).getDate() === 1 ? `${monthName(fromYmd(d).getMonth(), true)} 1` : fromYmd(d).getDate()}</button>
            {list.slice(0, list.length > max ? max - 1 : max).map((it) => <Chip key={it.key} it={it} onOpen={onOpen} onToggle={onToggle} />)}
            {list.length > max && <button type="button" className="cal-more" onClick={() => onDay(d)}>{list.length - max + 1} more</button>}
          </div>
        )
      })}
    </div>
  )
}

function TimeView({ days, today, byDay, onNew, onOpen, onToggle, onDay }: { days: string[]; today: string; byDay: Map<string, Item[]>; onNew: (d: string, start?: string, end?: string) => void; onOpen: (it: Item) => void; onToggle: (t: Task) => void; onDay: (d: string) => void }): ReactElement {
  const scroller = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(t) }, [])
  // Opens on the working day, or on now when it is later.
  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = Math.max(0, Math.min(8 * HOUR, (now.getHours() - 2) * HOUR) - 12)
  }, [days.join()]) // eslint-disable-line react-hooks/exhaustive-deps
  const nowMin = now.getHours() * 60 + now.getMinutes()
  return (
    <div className="cal-time" style={{ '--cols': days.length } as CSSProperties}>
      <div className="cal-time-head">
        <span />
        {days.map((d) => (
          <button key={d} type="button" className={`cal-time-day ${d === today ? 'today' : ''}`} onClick={() => onDay(d)}>
            <span>{dayName(d, true)}</span><b>{fromYmd(d).getDate()}</b>
          </button>
        ))}
      </div>
      <div className="cal-allday">
        <span className="cal-gutter-label">all-day</span>
        {days.map((d) => (
          <div key={d} className="cal-allday-col" onDoubleClick={() => onNew(d)}>
            {(byDay.get(d) ?? []).filter((i) => i.allDay).map((it) => <Chip key={it.key} it={it} onOpen={onOpen} onToggle={onToggle} />)}
          </div>
        ))}
      </div>
      <div className="cal-time-scroll" ref={scroller}>
        <div className="cal-time-grid" style={{ height: 24 * HOUR }}>
          <div className="cal-gutter">{Array.from({ length: 24 }, (_, h) => <span key={h} style={{ top: h * HOUR }}>{h === 0 ? '' : timeShort(h * 60)}</span>)}</div>
          {days.map((d) => (
            <div key={d} className={`cal-col ${d === today ? 'today' : ''}`}
              onClick={(e) => {
                if (e.target !== e.currentTarget) return
                const y = e.clientY - e.currentTarget.getBoundingClientRect().top
                const m = Math.max(0, Math.min(23 * 60 + 30, Math.floor(y / HOUR * 2) * 30))
                onNew(d, fromMinutes(m))
              }}>
              {layoutDay(byDay.get(d) ?? []).map((l) => {
                const it = l.occ
                const top = (it.start! / 60) * HOUR
                const height = Math.max(18, ((it.end! - it.start!) / 60) * HOUR - 2)
                return (
                  <div key={it.key} className={`cal-block ${it.task ? 'task' : ''} ${it.task?.doneAt ? 'done' : ''} ${height < 34 ? 'short' : ''}`} style={{ top, height, left: `calc(${(l.col / l.cols) * 100}% + 2px)`, width: `calc(${100 / l.cols}% - 4px)`, '--c': it.color } as CSSProperties}
                    onClick={(e) => { e.stopPropagation(); onOpen(it) }} title={it.title}>
                    {it.task && <button type="button" className="cal-task-check" aria-label="Complete" onClick={(e) => { e.stopPropagation(); onToggle(it.task!) }}>{it.task.doneAt && <Icon.check />}</button>}
                    <b>{it.title}</b>
                    <span>{timeLabel(fromMinutes(it.start!))}{!it.task ? ` – ${timeLabel(fromMinutes(it.end!))}` : ''}{it.event?.location ? ` · ${it.event.location}` : ''}</span>
                  </div>
                )
              })}
              {d === today && <div className="cal-now" style={{ top: (nowMin / 60) * HOUR }} />}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function AgendaView({ from, today, byDay, onOpen, onToggle }: { from: string; today: string; byDay: Map<string, Item[]>; onOpen: (it: Item) => void; onToggle: (t: Task) => void }): ReactElement {
  const days = Array.from({ length: 60 }, (_, i) => addDays(from, i)).filter((d) => byDay.get(d)?.length)
  return (
    <div className="plan-scroll cal-agenda">
      {!days.length && <div className="plan-empty"><Icon.calendar className="plan-empty-icon" /><p>Nothing in the next 60 days.</p></div>}
      {days.map((d) => (
        <div key={d} className="cal-agenda-day">
          <h3 className={`tasks-group ${d === today ? 'cal-today' : ''}`}>{relativeDay(d, today)}<span>{dayName(d)}, {monthName(fromYmd(d).getMonth())} {fromYmd(d).getDate()}</span></h3>
          {byDay.get(d)!.map((it) => (
            <div key={it.key} className={`cal-agenda-row ${it.task?.doneAt ? 'done' : ''}`} onClick={() => onOpen(it)} style={{ '--c': it.color } as CSSProperties}>
              {it.task ? <button type="button" className="cal-task-check" aria-label="Complete" onClick={(e) => { e.stopPropagation(); onToggle(it.task!) }}>{it.task.doneAt && <Icon.check />}</button> : <span className="cal-chip-dot" />}
              <span className="cal-agenda-time">{it.allDay ? 'All day' : `${timeLabel(fromMinutes(it.start!))}${it.task ? '' : ` – ${timeLabel(fromMinutes(it.end!))}`}`}</span>
              <span className="cal-agenda-title">{it.title}{it.event?.location && <span className="muted"> · {it.event.location}</span>}</span>
              {it.event?.repeat && <Icon.refresh className="muted" />}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function EventEditor({ event, isNew, calendars, readOnly, onSave, onDelete, onClose }: { event: CalEvent; isNew: boolean; calendars: CalendarList[]; readOnly: boolean; onSave: (e: CalEvent) => void; onDelete: () => void; onClose: () => void }): ReactElement {
  const [e, setE] = useState<CalEvent>(event)
  const set = (patch: Partial<CalEvent>): void => setE((x) => ({ ...x, ...patch }))
  const allDay = !e.start
  const writable = calendars.filter((c) => !c.url)
  const valid = e.title.trim() && e.date && (!e.endDate || e.endDate >= e.date)
  return (
    <Modal title={readOnly ? e.title : isNew ? 'New event' : 'Edit event'} onClose={onClose}>
      {readOnly ? (
        <div className="cal-readonly">
          <p><Icon.calendar />{relativeDay(e.date, ymd(new Date()))}{e.endDate ? ` – ${relativeDay(e.endDate, ymd(new Date()))}` : ''}{e.start ? `, ${timeLabel(e.start)}${e.end ? ` – ${timeLabel(e.end)}` : ''}` : ' (all day)'}</p>
          {e.repeat && <p><Icon.refresh />{repeatLabel(e.repeat)}</p>}
          {e.location && <p><Icon.globe />{e.location}</p>}
          {e.notes && <p className="cal-readonly-notes">{e.notes}</p>}
          <p className="muted">From a subscribed calendar: change it where it comes from.</p>
          <div className="cal-edit-foot"><span className="flex-1" /><button type="button" className="btn btn-sm" onClick={onClose}>Close</button></div>
        </div>
      ) : (
        <form className="cal-edit" onSubmit={(x) => { x.preventDefault(); if (valid) onSave({ ...e, title: e.title.trim() }) }}>
          <input className="input cal-edit-title" autoFocus value={e.title} placeholder="Title" aria-label="Title" onChange={(x) => set({ title: x.target.value })} />
          <label className="cal-check"><input type="checkbox" checked={allDay} onChange={() => set(allDay ? { start: '09:00', end: '10:00', endDate: undefined } : { start: undefined, end: undefined })} />All day</label>
          <div className="cal-edit-row">
            <label><span>{allDay ? 'From' : 'Date'}</span><input type="date" className="input" value={e.date} onChange={(x) => set({ date: x.target.value })} /></label>
            {allDay
              ? <label><span>To</span><input type="date" className="input" value={e.endDate ?? e.date} min={e.date} onChange={(x) => set({ endDate: x.target.value > e.date ? x.target.value : undefined })} /></label>
              : <>
                <label><span>Starts</span><input type="time" className="input" value={e.start} onChange={(x) => { const len = toMinutes(e.end ?? e.start!) - toMinutes(e.start!); set({ start: x.target.value, end: fromMinutes(toMinutes(x.target.value) + Math.max(15, len)) }) }} /></label>
                <label><span>Ends</span><input type="time" className="input" value={e.end ?? ''} onChange={(x) => set({ end: x.target.value })} /></label>
              </>}
          </div>
          <div className="cal-edit-row">
            <label><span>Calendar</span><select className="input" value={e.calendarId} onChange={(x) => set({ calendarId: x.target.value })}>{writable.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            <label><span>Repeat</span><select className="input" value={repeatId(e.repeat)} onChange={(x) => set({ repeat: REPEATS.find((r) => r.id === x.target.value)?.repeat })}>
              {REPEATS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              {repeatId(e.repeat) === 'custom' && e.repeat && <option value="custom">{repeatLabel(e.repeat)}</option>}
            </select></label>
          </div>
          <input className="input" value={e.location ?? ''} placeholder="Location or video link" aria-label="Location" onChange={(x) => set({ location: x.target.value })} />
          <textarea className="input cal-edit-notes" value={e.notes ?? ''} placeholder="Notes" aria-label="Notes" rows={3} onChange={(x) => set({ notes: x.target.value })} />
          {e.repeat && (e.exdates?.length ?? 0) > 0 && <p className="muted">{e.exdates!.length} skipped day{e.exdates!.length === 1 ? '' : 's'}</p>}
          <div className="cal-edit-foot">
            {!isNew && <button type="button" className="btn btn-sm btn-ghost" onClick={onDelete}><Icon.x />Delete</button>}
            <span className="flex-1" />
            <button type="button" className="btn btn-sm" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-sm btn-primary" disabled={!valid}>{isNew ? 'Add' : 'Save'}</button>
          </div>
        </form>
      )}
    </Modal>
  )
}

function SubscribeDialog({ onAdd, onClose }: { onAdd: (name: string, url: string) => void; onClose: () => void }): ReactElement {
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [state, setState] = useState<{ busy?: boolean; error?: string; count?: number }>({})
  const check = async (): Promise<void> => {
    setState({ busy: true })
    try {
      const cal = parseIcs(await window.api.invoke('calendar:feed', url.trim()))
      if (!name.trim() && cal.name) setName(cal.name)
      setState({ count: cal.events.length })
    } catch (e) { setState({ error: (e as Error).message }) }
  }
  return (
    <Modal title="Subscribe to a calendar" onClose={onClose}>
      <form className="cal-edit" onSubmit={(e) => { e.preventDefault(); if (state.count !== undefined) onAdd(name.trim() || 'Subscribed', url.trim()); else void check() }}>
        <p className="muted cal-sub-help">Paste the calendar's iCal link. In Google Calendar: Settings → your calendar → <b>Secret address in iCal format</b>. In iCloud: share the calendar as Public and copy its link. Outlook: Settings → Shared calendars → Publish → ICS. It is read-only here and refreshed every 30 minutes.</p>
        <input className="input" autoFocus value={url} placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" aria-label="iCal link" onChange={(e) => { setUrl(e.target.value); setState({}) }} />
        <input className="input" value={name} placeholder="Name (optional)" aria-label="Name" onChange={(e) => setName(e.target.value)} />
        {state.error && <div className="plan-error"><Icon.alert />{state.error}</div>}
        {state.count !== undefined && <p className="cal-sub-ok"><Icon.check />Found {state.count} event{state.count === 1 ? '' : 's'}.</p>}
        <div className="cal-edit-foot">
          <span className="flex-1" />
          <button type="button" className="btn btn-sm" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-sm btn-primary" disabled={!url.trim() || state.busy}>{state.busy ? 'Checking…' : state.count !== undefined ? 'Subscribe' : 'Check link'}</button>
        </div>
      </form>
    </Modal>
  )
}

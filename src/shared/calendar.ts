/**
 * Calendar (components/calendar/CalendarTab.tsx): calendars and their events, kept as records
 * (src/shared/records.ts), plus read-only calendars read from an iCal link (Google Calendar's "secret address",
 * iCloud's public link) that are fetched, not stored. Events are on local days and times like tasks
 * (src/shared/naturalDate.ts). This expands events (repeats, several days) into what a month, week or day shows,
 * and lays out overlapping events side by side. Pure: tests/calendar.test.ts.
 */
import type { RecordItem } from './records'
import { addDays, daysBetween, fromMinutes, parseWhen, repeatDays, toMinutes, weekStart, type Repeat } from './naturalDate.ts'

export interface CalendarList extends RecordItem {
  type: 'calendar'
  name: string
  color: string
  hidden?: boolean
  /** An iCal (.ics) link it is read from; such a calendar is read-only here. */
  url?: string
  order: number
}

export interface CalEvent extends RecordItem {
  type: 'event'
  calendarId: string
  title: string
  /** The first day ('YYYY-MM-DD'). */
  date: string
  /** The last day, for an event over several days. */
  endDate?: string
  /** Start and end times ('HH:MM'); none means all day. */
  start?: string
  end?: string
  location?: string
  notes?: string
  url?: string
  repeat?: Repeat
  /** Days a repeat skips. */
  exdates?: string[]
  /** The iCal UID it was imported with, so importing the same file twice adds nothing. */
  uid?: string
}

export const CALENDAR_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b']

/** One appearance of an event on one day. */
export interface Occurrence {
  /** Unique per event and day (event id + day). */
  key: string
  event: CalEvent
  day: string
  allDay: boolean
  /** Minutes from midnight, for timed events. */
  start?: number
  end?: number
  /** For events over several days: whether this is the first and the last day. */
  first: boolean
  last: boolean
}

export const isAllDay = (e: Pick<CalEvent, 'start'>): boolean => !e.start

/** Every appearance of these events in [from, to], day by day, sorted (all-day first, then by start). */
export function occurrences(events: CalEvent[], from: string, to: string): Occurrence[] {
  const out: Occurrence[] = []
  for (const e of events) {
    const span = e.endDate && e.endDate > e.date ? daysBetween(e.date, e.endDate) : 0
    const starts = e.repeat ? repeatDays(e.repeat, e.date, addDays(from, -span), to, 2000).filter((d) => !e.exdates?.includes(d)) : [e.date]
    for (const s of starts) {
      for (let i = 0; i <= span; i++) {
        const day = addDays(s, i)
        if (day < from || day > to) continue
        const timed = !!e.start && span === 0
        const start = timed ? toMinutes(e.start!) : undefined
        let end = timed && e.end ? toMinutes(e.end) : start !== undefined ? start + 60 : undefined
        // An evening event ending after midnight shows until midnight on its day.
        if (start !== undefined && end !== undefined && end <= start) end = 24 * 60
        out.push({ key: `${e.id}:${day}`, event: e, day, allDay: !timed, start, end, first: i === 0, last: i === span })
      }
    }
  }
  return out.sort(occurrenceOrder)
}

export function occurrenceOrder(a: Occurrence, b: Occurrence): number {
  return a.day.localeCompare(b.day) || Number(b.allDay) - Number(a.allDay) || (a.start ?? 0) - (b.start ?? 0) || (b.end ?? 0) - (a.end ?? 0) || a.event.title.localeCompare(b.event.title)
}

/** The 42 days a month view shows: whole weeks from the Sunday on or before the 1st. */
export function monthDays(anyDayInMonth: string): string[] {
  const first = `${anyDayInMonth.slice(0, 7)}-01`
  const start = weekStart(first)
  return Array.from({ length: 42 }, (_, i) => addDays(start, i))
}

/** The seven days of the week a day is in (Sunday first). */
export const weekDays = (day: string): string[] => Array.from({ length: 7 }, (_, i) => addDays(weekStart(day), i))

/** How many days the week view spans on a phone or a narrow pane: seven columns there would be too thin to read. */
const NARROW_WEEK = 3

/** The days the week view shows: the whole week, or NARROW_WEEK days from the cursor when the column is narrow. */
export const weekSpan = (day: string, narrow: boolean): string[] =>
  (narrow ? Array.from({ length: NARROW_WEEK }, (_, i) => addDays(day, i)) : weekDays(day))

/**
 * Side by side for overlapping timed events of one day: each gets a column and how many columns its group of
 * overlapping events needs, so a 9–10 and a 9:30–11 sit half-width next to each other.
 */
export function layoutDay<T extends { allDay: boolean; start?: number; end?: number }>(occs: T[]): { occ: T; col: number; cols: number }[] {
  const timed = occs.filter((o) => !o.allDay).sort((a, b) => a.start! - b.start! || b.end! - a.end!)
  const out: { occ: T; col: number; cols: number }[] = []
  let group: { occ: T; col: number; cols: number }[] = []
  let groupEnd = -1
  const close = (): void => {
    const cols = Math.max(1, ...group.map((g) => g.col + 1))
    for (const g of group) g.cols = cols
    out.push(...group)
    group = []
  }
  for (const occ of timed) {
    if (occ.start! >= groupEnd && group.length) close()
    // The first column whose last event has ended.
    const used = group.filter((g) => g.occ.end! > occ.start!).map((g) => g.col)
    let col = 0
    while (used.includes(col)) col++
    group.push({ occ, col, cols: 1 })
    groupEnd = Math.max(groupEnd, occ.end!)
  }
  if (group.length) close()
  return out
}

export interface EventInput {
  title: string
  date: string
  start?: string
  end?: string
  repeat?: Repeat
  found: string[]
}

/** "Lunch with Sam fri 12:30" → Friday 12:30–13:30; no time means all day; no day means `defaultDay`. */
export function parseEventInput(input: string, defaultDay: string, now: Date = new Date()): EventInput {
  const w = parseWhen(input, now)
  const start = w.time
  return {
    title: w.text,
    date: w.date && (w.time || w.date !== defaultDay || /today|tonight/i.test(input)) ? w.date : w.date ?? defaultDay,
    start,
    end: start ? w.endTime ?? fromMinutes(toMinutes(start) + 60) : undefined,
    repeat: w.repeat,
    found: w.found
  }
}

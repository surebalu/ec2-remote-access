/**
 * iCalendar (.ics) for the Calendar: reading a file or an iCal link (Google Calendar, iCloud, Outlook) into events on
 * this device's local days and times, and writing events back out. Times in another zone are converted with the
 * platform's time-zone data (Intl), Outlook's Windows zone names included for the common ones. Repeats map onto
 * src/shared/naturalDate.ts's Repeat; a rule it cannot express (the second Tuesday of a month) keeps only its first
 * occurrence and is counted in `approximate`. Pure: tests/ics.test.ts.
 */
import type { CalEvent } from './calendar.ts'
import { addDays, isYmd, type Repeat } from './naturalDate.ts'

/** An event as read from a file, before it gets an id and a calendar. */
export type IcsEvent = Omit<CalEvent, 'id' | 'type' | 'updatedAt' | 'calendarId'>

export interface IcsCalendar {
  name?: string
  events: IcsEvent[]
  /** Repeats that could only be kept in part. */
  approximate: number
}

const WINDOWS_ZONES: Record<string, string> = {
  'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago', 'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix', 'Pacific Standard Time': 'America/Los_Angeles', 'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu', 'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin', 'Central Europe Standard Time': 'Europe/Budapest', 'Romance Standard Time': 'Europe/Paris',
  'Central European Standard Time': 'Europe/Warsaw', 'E. Europe Standard Time': 'Europe/Chisinau', 'FLE Standard Time': 'Europe/Kiev',
  'India Standard Time': 'Asia/Kolkata', 'China Standard Time': 'Asia/Shanghai', 'Tokyo Standard Time': 'Asia/Tokyo',
  'Singapore Standard Time': 'Asia/Singapore', 'AUS Eastern Standard Time': 'Australia/Sydney', 'UTC': 'UTC', 'Coordinated Universal Time': 'UTC'
}

/** The zone's offset from UTC (ms) at an instant, or null for a zone this platform does not know. */
function zoneOffset(zone: string, utcMs: number): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(utcMs))
    const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value)
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - utcMs
  } catch {
    return null
  }
}

const pad = (n: number): string => String(n).padStart(2, '0')
const localParts = (d: Date): { date: string; time: string } => ({ date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` })

/** A DATE or DATE-TIME value as a local day, and a local time unless it is a whole day. */
export function icsTime(value: string, params: Record<string, string>): { date: string; time?: string } | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim())
  if (!m) return null
  const [, y, mo, d, h, mi, s, z] = m
  if (!h || params.VALUE === 'DATE') return { date: `${y}-${mo}-${d}` }
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0))
  let utc: number | null = z ? wall : null
  const tzid = params.TZID?.replace(/^"|"$/g, '')
  if (!z && tzid) {
    const zone = WINDOWS_ZONES[tzid] ?? tzid.replace(/^\/[^/]+\/[^/]+\//, '')
    const first = zoneOffset(zone, wall)
    if (first !== null) {
      // Again at the instant found, for the hours either side of a daylight-saving change.
      const second = zoneOffset(zone, wall - first)
      utc = wall - (second ?? first)
    }
  }
  // No zone (or one this platform does not know): the time as written, on this device's clock.
  if (utc === null) return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}` }
  return localParts(new Date(utc))
}

/** Unfolds continuation lines and splits each into name, parameters and value. */
function lines(text: string): { name: string; params: Record<string, string>; value: string }[] {
  const out: { name: string; params: Record<string, string>; value: string }[] = []
  for (const raw of text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n')) {
    if (!raw.trim()) continue
    // The value starts at the first colon outside a quoted parameter.
    let i = 0
    let quoted = false
    for (; i < raw.length; i++) {
      if (raw[i] === '"') quoted = !quoted
      else if (raw[i] === ':' && !quoted) break
    }
    if (i >= raw.length) continue
    const [name, ...rest] = raw.slice(0, i).split(';')
    const params: Record<string, string> = {}
    for (const p of rest) {
      const eq = p.indexOf('=')
      if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1)
    }
    out.push({ name: name.toUpperCase(), params, value: raw.slice(i + 1) })
  }
  return out
}

const unescape = (v: string): string => v.replace(/\\([\\;,nN])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c))
const escapeText = (v: string): string => v.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

/** An RRULE as a Repeat; null (and approximate) for one it cannot express. */
function repeatFrom(rule: string, params: Record<string, string>): { repeat: Repeat | null; approximate: boolean } {
  const r: Record<string, string> = {}
  for (const part of rule.split(';')) {
    const [k, v] = part.split('=')
    if (k && v) r[k.toUpperCase()] = v
  }
  const freq = ({ DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly', YEARLY: 'yearly' } as Record<string, Repeat['freq'] | undefined>)[r.FREQ]
  if (!freq) return { repeat: null, approximate: true }
  const repeat: Repeat = { freq, interval: Math.max(1, Number(r.INTERVAL) || 1) }
  let approximate = false
  if (r.BYDAY) {
    const days = r.BYDAY.split(',')
    // "MO,WE" on a weekly rule is expressible; "2TU" (the second Tuesday) and BYDAY on other rules are not.
    if (freq === 'weekly' && days.every((d) => DAYS.includes(d))) repeat.byDay = days.map((d) => DAYS.indexOf(d)).sort()
    else approximate = true
  }
  if (r.BYSETPOS || r.BYMONTHDAY?.includes(',') || r.BYMONTH?.includes(',') || r.BYHOUR || r.BYWEEKNO || r.BYYEARDAY) approximate = true
  if (r.COUNT) repeat.count = Math.max(1, Number(r.COUNT) || 1)
  if (r.UNTIL) repeat.until = icsTime(r.UNTIL, params.TZID ? { TZID: params.TZID } : {})?.date
  return { repeat: approximate ? null : repeat, approximate }
}

/** Reads every VEVENT in an .ics text. Cancelled events are left out; a changed single occurrence replaces its day. */
export function parseIcs(text: string): IcsCalendar {
  const cal: IcsCalendar = { events: [], approximate: 0 }
  type Draft = IcsEvent & { recurrenceOf?: string; cancelled?: boolean }
  const drafts: Draft[] = []
  let cur: Draft | null = null
  let depth = 0
  let endParts: { date: string; time?: string } | null = null
  let duration: string | null = null
  for (const { name, params, value } of lines(text)) {
    if (name === 'BEGIN') {
      if (value.toUpperCase() === 'VEVENT') { cur = { title: '', date: '' }; endParts = null; duration = null } else if (cur) depth++
      continue
    }
    if (name === 'END') {
      if (value.toUpperCase() === 'VEVENT' && cur) {
        if (cur.date) {
          if (endParts) applyEnd(cur, endParts)
          else if (duration && cur.start) applyDuration(cur, duration)
          drafts.push(cur)
        }
        cur = null
      } else if (depth) depth--
      continue
    }
    if (!cur) {
      if (name === 'X-WR-CALNAME') cal.name = unescape(value)
      continue
    }
    if (depth) continue // inside a VALARM
    if (name === 'SUMMARY') cur.title = unescape(value).trim()
    else if (name === 'DTSTART') {
      const t = icsTime(value, params)
      if (t) { cur.date = t.date; if (t.time) cur.start = t.time; else delete cur.start }
    } else if (name === 'DTEND') endParts = icsTime(value, params)
    else if (name === 'DURATION') duration = value
    else if (name === 'LOCATION') cur.location = unescape(value).trim() || undefined
    else if (name === 'DESCRIPTION') cur.notes = unescape(value).trim() || undefined
    else if (name === 'URL') cur.url = value.trim()
    else if (name === 'UID') cur.uid = value.trim()
    else if (name === 'STATUS' && value.toUpperCase() === 'CANCELLED') cur.cancelled = true
    else if (name === 'RRULE') {
      const { repeat, approximate } = repeatFrom(value, params)
      if (repeat) cur.repeat = repeat
      if (approximate) cal.approximate++
    } else if (name === 'EXDATE') {
      for (const v of value.split(',')) {
        const t = icsTime(v, params)
        if (t) (cur.exdates ??= []).push(t.date)
      }
    } else if (name === 'RECURRENCE-ID') cur.recurrenceOf = icsTime(value, params)?.date
  }
  // A changed occurrence (RECURRENCE-ID) takes its day from the series; a cancelled one only removes it.
  const series = new Map(drafts.filter((d) => d.uid && !d.recurrenceOf).map((d) => [d.uid!, d]))
  for (const d of drafts) {
    if (!d.recurrenceOf || !d.uid) continue
    const master = series.get(d.uid)
    if (master?.repeat) (master.exdates ??= []).push(d.recurrenceOf)
  }
  for (const d of drafts) {
    if (d.cancelled) continue
    const { recurrenceOf, cancelled: _c, ...event } = d
    if (recurrenceOf && event.uid) event.uid = `${event.uid}#${recurrenceOf}`
    if (!event.title) event.title = '(No title)'
    cal.events.push(event)
  }
  return cal
}

function applyEnd(e: IcsEvent, end: { date: string; time?: string }): void {
  if (!e.start) {
    // A whole-day DTEND is the day after the last one.
    const last = addDays(end.date, -1)
    if (last > e.date) e.endDate = last
    return
  }
  if (!end.time) return
  if (end.date > e.date) {
    // Past midnight into the next morning stays a timed event; longer ones become days.
    if (end.date === addDays(e.date, 1) && end.time <= e.start) e.end = end.time
    else { e.endDate = end.date; e.end = end.time }
  } else e.end = end.time
}

function applyDuration(e: IcsEvent, d: string): void {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(d.trim())
  if (!m || !e.start) return
  const mins = (Number(m[1] ?? 0) * 7 * 24 + Number(m[2] ?? 0) * 24 + Number(m[3] ?? 0)) * 60 + Number(m[4] ?? 0)
  const total = Number(e.start.slice(0, 2)) * 60 + Number(e.start.slice(3, 5)) + mins
  if (total >= 24 * 60 * 2) { e.endDate = addDays(e.date, Math.floor(total / 1440)); return }
  const t = total % 1440
  e.end = `${pad(Math.floor(t / 60))}:${pad(t % 60)}`
}

// ----- writing -----

/** Folds a content line at 75 octets, as the standard asks. */
function fold(line: string): string {
  const out: string[] = []
  let cur = ''
  let bytes = 0
  for (const ch of line) {
    const b = new TextEncoder().encode(ch).length
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0 }
    cur += ch
    bytes += b
  }
  out.push(cur)
  return out.join('\r\n ')
}

const compact = (day: string): string => day.replace(/-/g, '')
const dateTime = (day: string, hm: string): string => `${compact(day)}T${hm.replace(':', '')}00`

function rrule(r: Repeat): string {
  const parts = [`FREQ=${r.freq.toUpperCase()}`]
  if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`)
  if (r.byDay?.length) parts.push(`BYDAY=${r.byDay.map((d) => DAYS[d]).join(',')}`)
  if (r.count) parts.push(`COUNT=${r.count}`)
  if (r.until && isYmd(r.until)) parts.push(`UNTIL=${compact(r.until)}`)
  return parts.join(';')
}

/** Events as an .ics file. Times are written as floating local times (no zone), as they are kept. */
export function toIcs(events: CalEvent[], name: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const out = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//EC2 Remote Access//Calendar//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${escapeText(name)}`]
  for (const e of events) {
    out.push('BEGIN:VEVENT', `UID:${e.uid ?? `${e.id}@ec2-remote-access`}`, `DTSTAMP:${stamp}`)
    if (e.start) {
      out.push(`DTSTART:${dateTime(e.date, e.start)}`)
      const endDay = e.endDate ?? (e.end && e.end <= e.start ? addDays(e.date, 1) : e.date)
      out.push(`DTEND:${dateTime(endDay, e.end ?? e.start)}`)
    } else {
      out.push(`DTSTART;VALUE=DATE:${compact(e.date)}`, `DTEND;VALUE=DATE:${compact(addDays(e.endDate ?? e.date, 1))}`)
    }
    out.push(`SUMMARY:${escapeText(e.title)}`)
    if (e.location) out.push(`LOCATION:${escapeText(e.location)}`)
    if (e.notes) out.push(`DESCRIPTION:${escapeText(e.notes)}`)
    if (e.url) out.push(`URL:${e.url}`)
    if (e.repeat) out.push(`RRULE:${rrule(e.repeat)}`)
    for (const x of e.exdates ?? []) out.push(e.start ? `EXDATE:${dateTime(x, e.start)}` : `EXDATE;VALUE=DATE:${compact(x)}`)
    out.push('END:VEVENT')
  }
  out.push('END:VCALENDAR')
  return `${out.map(fold).join('\r\n')}\r\n`
}

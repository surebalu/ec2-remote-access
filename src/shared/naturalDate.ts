/**
 * Days, repeats and natural-language dates for Tasks and Calendar. Days are local calendar days as 'YYYY-MM-DD'
 * strings and times are 'HH:MM' (24-hour), both on this device's clock: a task due Friday stays due Friday, without
 * time zones to drift it. `parseWhen` finds phrases like "tomorrow 3pm", "every monday", "oct 28", "in 2 weeks" or
 * "12:30-1:30" in typed text and returns them with the rest of the text, as the quick-add boxes show it.
 * Pure: tests/naturalDate.test.ts.
 */

export interface Repeat {
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly'
  /** Every `interval` days, weeks, months or years. */
  interval: number
  /** Weekly only: the days of the week (0 Sunday … 6 Saturday); absent means the start's own day. */
  byDay?: number[]
  /** Last day it may occur ('YYYY-MM-DD'). */
  until?: string
  /** How many times it occurs in all. */
  count?: number
}

const pad = (n: number): string => String(n).padStart(2, '0')
export const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export const isYmd = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
export const isHm = (s: unknown): s is string => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s)

/** Local midnight of a day. */
export function fromYmd(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}
export function addDays(s: string, n: number): string {
  const d = fromYmd(s)
  d.setDate(d.getDate() + n)
  return ymd(d)
}
/** Adds months, keeping the day of the month or, when the month is shorter, its last day. */
export function addMonths(s: string, n: number): string {
  const [y, m, d] = s.split('-').map(Number)
  const first = new Date(y, m - 1 + n, 1)
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  return ymd(new Date(first.getFullYear(), first.getMonth(), Math.min(d, last)))
}
export const daysBetween = (a: string, b: string): number => Math.round((fromYmd(b).getTime() - fromYmd(a).getTime()) / 86_400_000)
export const weekdayOf = (s: string): number => fromYmd(s).getDay()
/** The Sunday a day's week starts on (the US week, as the calendar shows it). */
export const weekStart = (s: string): string => addDays(s, -weekdayOf(s))
export const toMinutes = (hm: string): number => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5))
export const fromMinutes = (m: number): string => `${pad(Math.floor(((m % 1440) + 1440) % 1440 / 60))}:${pad(((m % 60) + 60) % 60)}`

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
export const dayName = (s: string, short = false): string => (short ? DAY_NAMES[weekdayOf(s)].slice(0, 3) : DAY_NAMES[weekdayOf(s)])
export const monthName = (m: number, short = false): string => (short ? MONTH_NAMES[m].slice(0, 3) : MONTH_NAMES[m])

/** "Today", "Tomorrow", "Yesterday", "Friday" within the coming week, else "Oct 28" (with the year when not this one). */
export function relativeDay(day: string, today: string): string {
  const diff = daysBetween(today, day)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  if (diff === -1) return 'Yesterday'
  if (diff > 1 && diff < 7) return dayName(day)
  const d = fromYmd(day)
  return `${monthName(d.getMonth(), true)} ${d.getDate()}${d.getFullYear() === fromYmd(today).getFullYear() ? '' : `, ${d.getFullYear()}`}`
}

/** "3 PM", "9:30 AM". */
export function timeLabel(hm: string): string {
  const h = Number(hm.slice(0, 2))
  const m = hm.slice(3, 5)
  return `${h % 12 || 12}${m === '00' ? '' : `:${m}`} ${h < 12 ? 'AM' : 'PM'}`
}

// ----- repeats -----

/** Whether a repeat that starts on `start` falls on `day` (not counting `count`, which needs the whole run). */
function fallsOn(r: Repeat, start: string, day: string): boolean {
  if (day < start || (r.until && day > r.until)) return false
  const every = Math.max(1, Math.floor(r.interval) || 1)
  if (r.freq === 'daily') return daysBetween(start, day) % every === 0
  if (r.freq === 'weekly') {
    const days = r.byDay?.length ? r.byDay : [weekdayOf(start)]
    return days.includes(weekdayOf(day)) && (daysBetween(weekStart(start), weekStart(day)) / 7) % every === 0
  }
  const a = fromYmd(start)
  const b = fromYmd(day)
  const months = (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth()
  if (r.freq === 'monthly') {
    // The 31st of a 30-day month falls on its last day, as addMonths does.
    const last = new Date(b.getFullYear(), b.getMonth() + 1, 0).getDate()
    return months % every === 0 && b.getDate() === Math.min(a.getDate(), last)
  }
  return months % (12 * every) === 0 && b.getDate() === a.getDate()
}

/** The days in [from, to] a repeat starting on `start` occurs on (at most `limit`). */
export function repeatDays(r: Repeat, start: string, from: string, to: string, limit = 1000): string[] {
  const out: string[] = []
  // With a count, the run is counted from its first day, so walk from there.
  let day = r.count ? start : from > start ? from : start
  let seen = 0
  for (let i = 0; day <= to && i < 20_000 && out.length < limit; i++, day = addDays(day, 1)) {
    if (!fallsOn(r, start, day)) continue
    seen++
    if (r.count && seen > r.count) break
    if (day >= from) out.push(day)
  }
  return out
}

/** The first day after `after` the repeat occurs on, or null when it has ended. */
export function nextRepeat(r: Repeat, start: string, after: string): string | null {
  const from = addDays(after, 1)
  return repeatDays(r, start, from < start ? start : from, addDays(from, 366 * 5), 1)[0] ?? null
}

/** "Every day", "Every 2 weeks on Mon, Wed", "Every weekday", "Every month". */
export function repeatLabel(r: Repeat): string {
  const n = Math.max(1, r.interval || 1)
  const unit = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[r.freq]
  const days = r.freq === 'weekly' && r.byDay?.length ? [...r.byDay].sort() : null
  if (days && n === 1 && days.join() === '1,2,3,4,5') return 'Every weekday'
  const base = n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`
  return days ? `${base} on ${days.map((d) => DAY_NAMES[d].slice(0, 3)).join(', ')}` : base
}

// ----- natural language -----

export interface When {
  /** The text with the date, time and repeat phrases taken out. */
  text: string
  date?: string
  time?: string
  endTime?: string
  repeat?: Repeat
  someday?: boolean
  /** The phrases found, in the order they appear, for the quick-add preview. */
  found: string[]
}

const WEEKDAYS: [RegExp, number][] = [
  [/^sun(day)?$/, 0], [/^mon(day)?$/, 1], [/^tue(s(day)?)?$/, 2], [/^wed(nesday)?$/, 3], [/^thu(r(s(day)?)?)?$/, 4], [/^fri(day)?$/, 5], [/^sat(urday)?$/, 6]
]
const WEEKDAY = '(?:sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)'
const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'
const dayNum = (w: string): number => WEEKDAYS.find(([re]) => re.test(w.toLowerCase()))?.[1] ?? -1
const monthNum = (m: string): number => ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m.toLowerCase().slice(0, 3))

/** The coming `weekday` (today when it is today). */
const comingDay = (today: string, wd: number): string => addDays(today, (wd - weekdayOf(today) + 7) % 7)
/** That weekday in next week (weeks start on Monday here, as people say "next Monday"). */
const nextWeekDay = (today: string, wd: number): string => {
  const monday = addDays(today, ((1 - weekdayOf(today) + 7) % 7) || 7)
  return addDays(monday, (wd + 6) % 7)
}

/** A calendar date from parts; without a year, the next time it comes round (today included). */
function dateFrom(today: string, month: number, day: number, year?: number): string | undefined {
  if (month < 0 || month > 11 || day < 1 || day > 31) return undefined
  const y = year === undefined ? fromYmd(today).getFullYear() : year < 100 ? 2000 + year : year
  const d = new Date(y, month, day)
  if (d.getMonth() !== month) return undefined
  const out = ymd(d)
  return year === undefined && out < today ? ymd(new Date(y + 1, month, day)) : out
}

/** "3pm", "3:30 pm", "15:00", "noon"; null when it is not a time. */
function timeFrom(h: string, m: string | undefined, ampm: string | undefined): string | null {
  let hour = Number(h)
  const minute = m ? Number(m) : 0
  if (minute > 59) return null
  const ap = ampm?.toLowerCase()[0]
  if (ap) {
    if (hour < 1 || hour > 12) return null
    hour = (hour % 12) + (ap === 'p' ? 12 : 0)
  } else if (hour > 23) return null
  return `${pad(hour)}:${pad(minute)}`
}

/**
 * Finds date, time and repeat phrases in `input` relative to `now`. Whole words only, so "Monday standup notes"
 * becomes a task on Monday called "standup notes", and "May" alone is not a date (only "May 3" is).
 */
export function parseWhen(input: string, now: Date = new Date()): When {
  const today = ymd(now)
  const out: When = { text: input, found: [] }
  let text = ` ${input} `
  // Takes the first match of `re` out of the text and hands its groups to `use`, which returns false to leave it.
  const take = (re: RegExp, use: (m: RegExpExecArray) => boolean | void): boolean => {
    const m = new RegExp(`(?<=\\s)(?:${re.source})(?=[\\s,.!?;]|$)`, 'i').exec(text)
    if (!m || use(m) === false) return false
    out.found.push(m[0].trim())
    text = `${text.slice(0, m.index)} ${text.slice(m.index + m[0].length)}`
    return true
  }

  // Repeats: they also set the first day when none is given.
  let repeatStart: string | undefined
  take(/every\s+weekday|weekdays/, () => { out.repeat = { freq: 'weekly', interval: 1, byDay: [1, 2, 3, 4, 5] }; repeatStart = [1, 2, 3, 4, 5].map((d) => comingDay(today, d)).sort()[0] })
  || take(new RegExp(`every\\s+(${WEEKDAY}(?:\\s*(?:,|and|&)\\s*${WEEKDAY})*)`), (m) => {
    const days = [...new Set(m[1].split(/\s*(?:,|and|&)\s*/).map(dayNum).filter((d) => d >= 0))].sort()
    out.repeat = { freq: 'weekly', interval: 1, byDay: days }
    repeatStart = days.map((d) => comingDay(today, d)).sort()[0]
  })
  || take(/every\s+(other\s+|\d+\s+)?(day|week|month|year)s?/, (m) => {
    const n = !m[1] ? 1 : /other/i.test(m[1]) ? 2 : Number(m[1])
    out.repeat = { freq: ({ day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' } as const)[m[2].toLowerCase() as 'day'], interval: Math.max(1, n) }
  })
  || take(/daily|weekly|monthly|yearly|annually/, (m) => {
    const w = m[0].toLowerCase()
    out.repeat = { freq: w === 'annually' ? 'yearly' : (w as Repeat['freq']), interval: 1 }
  })

  take(/someday|some\s+day/, () => { out.someday = true })

  // Dates, most specific first.
  const setDate = (d: string | undefined): boolean => {
    if (!d) return false
    out.date = d
    return true
  }
  const prefix = '(?:on\\s+|by\\s+|due\\s+)?'
  void (take(new RegExp(`${prefix}(\\d{4})-(\\d{2})-(\\d{2})`), (m) => setDate(dateFrom(today, Number(m[2]) - 1, Number(m[3]), Number(m[1]))))
    || take(new RegExp(`${prefix}(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`), (m) => setDate(dateFrom(today, monthNum(m[1]), Number(m[2]), m[3] ? Number(m[3]) : undefined)))
    || take(new RegExp(`${prefix}(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH})(?:,?\\s+(\\d{4}))?`), (m) => setDate(dateFrom(today, monthNum(m[2]), Number(m[1]), m[3] ? Number(m[3]) : undefined)))
    || take(new RegExp(`${prefix}(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?`), (m) => setDate(dateFrom(today, Number(m[1]) - 1, Number(m[2]), m[3] ? Number(m[3]) : undefined)))
    || take(/today|tod/, () => setDate(today))
    || take(/tonight/, () => { out.time ??= '18:00'; return setDate(today) })
    || take(/tomorrow|tmrw?|tmr/, () => setDate(addDays(today, 1)))
    || take(/(?:next|this\s+coming)\s+weekend/, () => setDate(nextWeekDay(today, 6)))
    || take(/(?:this\s+)?weekend/, () => setDate(comingDay(today, 6)))
    || take(/next\s+week/, () => setDate(nextWeekDay(today, 1)))
    || take(/next\s+month/, () => { const d = fromYmd(today); return setDate(ymd(new Date(d.getFullYear(), d.getMonth() + 1, 1))) })
    || take(/next\s+year/, () => setDate(`${fromYmd(today).getFullYear() + 1}-01-01`))
    || take(/in\s+(\d+|a|an|one|two|three)\s+(day|week|month|year)s?/, (m) => {
      const n = ({ a: 1, an: 1, one: 1, two: 2, three: 3 } as Record<string, number>)[m[1].toLowerCase()] ?? Number(m[1])
      const unit = m[2].toLowerCase()
      return setDate(unit === 'day' ? addDays(today, n) : unit === 'week' ? addDays(today, 7 * n) : addMonths(today, unit === 'month' ? n : 12 * n))
    })
    || take(new RegExp(`(?:next\\s+)(${WEEKDAY})`), (m) => setDate(nextWeekDay(today, dayNum(m[1]))))
    || take(new RegExp(`(?:on|this|by|due)\\s+(${WEEKDAY})`), (m) => setDate(comingDay(today, dayNum(m[1]))))
    // Alone, only names that are not also words: "sun", "sat" and "wed" need "on", "this", "next"…
    || take(/(sunday|monday|mon|tuesday|tues?|wednesday|thursday|thu(?:rs?)?|friday|fri|saturday)/, (m) => setDate(comingDay(today, dayNum(m[1])))))

  // Times: a range first ("12:30-1:30pm", "3 to 4pm"), then one time.
  const T = '(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm|a|p)?'
  take(new RegExp(`(?:at\\s+|from\\s+)?${T}\\s*(?:-|–|to|until)\\s*${T}`), (m) => {
    // "1-2pm": the first takes the second's am/pm when it has none (and still comes first).
    let start = timeFrom(m[1], m[2], m[3] ?? m[6])
    if (start && !m[3] && m[6] && start > (timeFrom(m[4], m[5], m[6]) ?? '')) start = timeFrom(m[1], m[2], m[6] === 'pm' || m[6] === 'p' ? 'am' : 'pm')
    const end = timeFrom(m[4], m[5], m[6] ?? m[3])
    if (!start || !end || (!m[2] && !m[3] && !m[5] && !m[6])) return false
    out.time = start
    out.endTime = end
  })
  || take(new RegExp(`(?:at\\s+)?(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm|a\\.m\\.|p\\.m\\.)`), (m) => {
    const t = timeFrom(m[1], m[2], m[3])
    if (!t) return false
    out.time = t
  })
  || take(/(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)/, (m) => { out.time = `${pad(Number(m[1]))}:${m[2]}` })
  || take(/at\s+(\d{1,2})/, (m) => {
    // "at 3" means the afternoon for 1 to 7, as people say it.
    const h = Number(m[1])
    if (h < 1 || h > 12) return false
    out.time = `${pad(h <= 7 ? h + 12 : h % 12 === 0 ? 12 : h)}:00`
  })
  || take(/noon|midday/, () => { out.time = '12:00' })
  || take(/(?:in\s+the\s+)?morning/, () => { out.time = '09:00' })
  || take(/(?:in\s+the\s+)?afternoon/, () => { out.time = '14:00' })
  || take(/(?:in\s+the\s+)?evening/, () => { out.time = '18:00' })

  // "for 90 minutes", "for 1.5h": an end time from the start.
  take(/for\s+(\d+(?:\.\d+)?)\s*(h|hrs?|hours?|m|mins?|minutes?)/, (m) => {
    if (!out.time) return false
    const mins = Math.round(Number(m[1]) * (m[2].toLowerCase().startsWith('h') ? 60 : 1))
    out.endTime = fromMinutes(toMinutes(out.time) + mins)
  })

  if (out.repeat && !out.date) out.date = repeatStart ?? today
  if (out.time && !out.date) out.date = today
  if (out.someday) delete out.date
  out.text = text.replace(/\s+/g, ' ').trim()
  return out
}

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { layoutDay, monthDays, occurrences, parseEventInput, weekDays, type CalEvent } from '../src/shared/calendar.ts'
import { icsTime, parseIcs, toIcs } from '../src/shared/ics.ts'

// Times below are read as New York local time, whatever this machine is set to.
process.env.TZ = 'America/New_York'
const NOW = new Date(2026, 9, 22, 10, 15)
let n = 0
const ev = (o: Partial<CalEvent>): CalEvent => ({ id: `e${++n}`, type: 'event', calendarId: 'c', title: `e${n}`, date: '2026-10-22', updatedAt: 0, ...o })

test('month and week grids start on Sunday', () => {
  const m = monthDays('2026-10-15')
  assert.deepEqual([m.length, m[0], m[4], m[41]], [42, '2026-09-27', '2026-10-01', '2026-11-07'])
  assert.deepEqual(weekDays('2026-10-22'), ['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24'])
})

test('occurrences: repeats, skipped days, several days, past midnight', () => {
  const weekly = ev({ title: 'standup', start: '09:00', end: '09:15', repeat: { freq: 'weekly', interval: 1, byDay: [1, 3] }, date: '2026-10-19', exdates: ['2026-10-21'] })
  const trip = ev({ title: 'trip', date: '2026-10-23', endDate: '2026-10-26' })
  const late = ev({ title: 'deploy', date: '2026-10-24', start: '23:00', end: '01:00' })
  const occ = occurrences([weekly, trip, late], '2026-10-19', '2026-10-25')
  const at = (day: string): string[] => occ.filter((o) => o.day === day).map((o) => `${o.event.title}${o.allDay ? '*' : `@${o.start}-${o.end}`}${o.first ? '<' : ''}${o.last ? '>' : ''}`)
  assert.deepEqual(at('2026-10-19'), ['standup@540-555<>'])
  assert.deepEqual(at('2026-10-21'), [], 'skipped day')
  assert.deepEqual(at('2026-10-23'), ['trip*<'])
  assert.deepEqual(at('2026-10-24'), ['trip*', 'deploy@1380-1440<>'], 'all day first; past midnight ends at midnight')
  assert.deepEqual(at('2026-10-25'), ['trip*'], 'the trip continues, its last day outside the range')
  assert.equal(occurrences([trip], '2026-10-25', '2026-10-31').length, 2, 'a run that started before the range still shows')
})

test('overlapping events sit side by side', () => {
  const occ = occurrences([
    ev({ title: 'a', start: '09:00', end: '10:00' }), ev({ title: 'b', start: '09:30', end: '11:00' }),
    ev({ title: 'c', start: '10:00', end: '10:30' }), ev({ title: 'd', start: '12:00', end: '13:00' })
  ], '2026-10-22', '2026-10-22')
  const l = Object.fromEntries(layoutDay(occ).map((x) => [x.occ.event.title, [x.col, x.cols]]))
  assert.deepEqual(l, { a: [0, 2], b: [1, 2], c: [0, 2], d: [0, 1] })
})

test('quick add for events', () => {
  const a = parseEventInput('Lunch with Sam fri 12:30', '2026-10-22', NOW)
  assert.deepEqual([a.title, a.date, a.start, a.end], ['Lunch with Sam', '2026-10-23', '12:30', '13:30'])
  const b = parseEventInput('Offsite', '2026-10-28', NOW)
  assert.deepEqual([b.title, b.date, b.start], ['Offsite', '2026-10-28', undefined], 'no day: the one picked in the calendar')
  const c = parseEventInput('Review 2-3pm', '2026-10-28', NOW)
  assert.deepEqual([c.date, c.start, c.end], ['2026-10-22', '14:00', '15:00'], 'a time alone is today, as typed')
})

test('iCal times: UTC, a zone, Outlook zone names, floating, whole days', () => {
  assert.deepEqual(icsTime('20261022T160000Z', {}), { date: '2026-10-22', time: '12:00' })
  assert.deepEqual(icsTime('20261022T090000', { TZID: 'America/Los_Angeles' }), { date: '2026-10-22', time: '12:00' })
  assert.deepEqual(icsTime('20261022T090000', { TZID: 'Pacific Standard Time' }), { date: '2026-10-22', time: '12:00' })
  assert.deepEqual(icsTime('20261022T230000', { TZID: 'Asia/Kolkata' }), { date: '2026-10-22', time: '13:30' })
  assert.deepEqual(icsTime('20261022T090000', {}), { date: '2026-10-22', time: '09:00' })
  assert.deepEqual(icsTime('20261022T090000', { TZID: 'Mars/Olympus' }), { date: '2026-10-22', time: '09:00' }, 'an unknown zone reads as written')
  assert.deepEqual(icsTime('20261022', { VALUE: 'DATE' }), { date: '2026-10-22' })
  assert.deepEqual(icsTime('20260308T120000Z', {}), { date: '2026-03-08', time: '08:00' }, 'after the DST change')
})

const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:Work', 'BEGIN:VTIMEZONE', 'TZID:America/Chicago', 'END:VTIMEZONE',
  'BEGIN:VEVENT', 'UID:a1', 'DTSTART;TZID=America/Chicago:20261019T090000', 'DTEND;TZID=America/Chicago:20261019T093000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6', 'EXDATE;TZID=America/Chicago:20261021T090000',
  'SUMMARY:Stand\\, up', 'DESCRIPTION:Line one\\nLine two', 'LOCATION:Room 4', 'BEGIN:VALARM', 'TRIGGER:-PT10M', 'SUMMARY:alarm', 'END:VALARM', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:a1', 'RECURRENCE-ID;TZID=America/Chicago:20261026T090000', 'DTSTART;TZID=America/Chicago:20261026T110000', 'DTEND;TZID=America/Chicago:20261026T113000', 'SUMMARY:Stand up (moved)', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:b2', 'DTSTART;VALUE=DATE:20261030', 'DTEND;VALUE=DATE:20261102', 'SUMMARY:Conference', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:c3', 'DTSTART:20261024T030000Z', 'DURATION:PT1H30M', 'SUMMARY:Late call', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:d4', 'DTSTART:20261025T150000Z', 'DTEND:20261025T160000Z', 'STATUS:CANCELLED', 'SUMMARY:Gone', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:e5', 'DTSTART:20261101T150000Z', 'RRULE:FREQ=MONTHLY;BYDAY=1SU', 'SUMMARY:First Sunday', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:f6', 'DTSTART:20261023T140000Z', 'DTEND:20261023T150000Z', 'SUMMARY:A very long title that will need folding when it is', '  written back out', 'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n')

test('reading an .ics file', () => {
  const cal = parseIcs(ICS)
  assert.equal(cal.name, 'Work')
  assert.equal(cal.approximate, 1, 'the first Sunday of a month cannot be expressed')
  const by = (uid: string): (typeof cal.events)[number] => cal.events.find((e) => e.uid === uid)!
  const s = by('a1')
  assert.deepEqual([s.title, s.date, s.start, s.end, s.location, s.notes], ['Stand, up', '2026-10-19', '10:00', '10:30', 'Room 4', 'Line one\nLine two'])
  assert.deepEqual(s.repeat, { freq: 'weekly', interval: 1, byDay: [1, 3], count: 6 })
  assert.deepEqual(s.exdates, ['2026-10-21', '2026-10-26'], 'the moved occurrence leaves its day')
  assert.deepEqual([by('a1#2026-10-26').title, by('a1#2026-10-26').start], ['Stand up (moved)', '12:00'])
  assert.deepEqual([by('b2').date, by('b2').endDate, by('b2').start], ['2026-10-30', '2026-11-01', undefined])
  assert.deepEqual([by('c3').date, by('c3').start, by('c3').end], ['2026-10-23', '23:00', '00:30'], 'UTC to local, past midnight')
  assert.equal(cal.events.some((e) => e.uid === 'd4'), false, 'cancelled')
  assert.equal(by('e5').repeat, undefined)
  assert.equal(by('f6').title, 'A very long title that will need folding when it is written back out')
})

test('writing .ics and reading it back', () => {
  const events = [
    ev({ id: 'x1', title: 'Standup; daily, mostly', date: '2026-10-19', start: '09:00', end: '09:15', repeat: { freq: 'weekly', interval: 2, byDay: [1, 3], until: '2026-12-31' }, exdates: ['2026-10-21'], notes: 'Agenda:\n- items' }),
    ev({ id: 'x2', title: 'Holiday', date: '2026-12-24', endDate: '2026-12-26' }),
    ev({ id: 'x3', title: 'Night shift', date: '2026-10-24', start: '22:00', end: '06:00' })
  ]
  const text = toIcs(events, 'Mine', new Date(Date.UTC(2026, 9, 22)))
  assert.ok(text.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75), 'lines folded at 75 octets')
  const back = parseIcs(text).events
  assert.deepEqual(back.map((e) => [e.title, e.date, e.endDate, e.start, e.end]), [
    ['Standup; daily, mostly', '2026-10-19', undefined, '09:00', '09:15'],
    ['Holiday', '2026-12-24', '2026-12-26', undefined, undefined],
    ['Night shift', '2026-10-24', undefined, '22:00', '06:00']
  ])
  assert.deepEqual(back[0].repeat, { freq: 'weekly', interval: 2, byDay: [1, 3], until: '2026-12-31' })
  assert.deepEqual([back[0].exdates, back[0].notes, back[0].uid], [['2026-10-21'], 'Agenda:\n- items', 'x1@ec2-remote-access'])
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addDays, addMonths, nextRepeat, parseWhen, relativeDay, repeatDays, repeatLabel, timeLabel, weekStart } from '../src/shared/naturalDate.ts'

// Thursday, October 22, 2026, 10:15 local time.
const NOW = new Date(2026, 9, 22, 10, 15)
const when = (s: string): ReturnType<typeof parseWhen> => parseWhen(s, NOW)

test('day arithmetic on local calendar days', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01')
  assert.equal(addDays('2026-03-08', 1), '2026-03-09', 'across the spring DST change')
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28', 'the 31st falls on a short month\'s last day')
  assert.equal(weekStart('2026-10-22'), '2026-10-18')
  assert.equal(relativeDay('2026-10-23', '2026-10-22'), 'Tomorrow')
  assert.equal(relativeDay('2026-10-26', '2026-10-22'), 'Monday')
  assert.equal(relativeDay('2026-11-05', '2026-10-22'), 'Nov 5')
  assert.equal(relativeDay('2027-01-05', '2026-10-22'), 'Jan 5, 2027')
  assert.equal(timeLabel('15:00'), '3 PM')
  assert.equal(timeLabel('00:30'), '12:30 AM')
})

test('relative dates', () => {
  assert.deepEqual([when('Pay rent today').date, when('Pay rent today').text], ['2026-10-22', 'Pay rent'])
  assert.equal(when('call mom tomorrow').date, '2026-10-23')
  assert.equal(when('ship it friday').date, '2026-10-23')
  assert.equal(when('standup thursday').date, '2026-10-22', 'a weekday named today is today')
  assert.equal(when('review next monday').date, '2026-10-26')
  assert.equal(when('plan next week').date, '2026-10-26')
  assert.equal(when('trip this weekend').date, '2026-10-24')
  assert.equal(when('renew in 2 weeks').date, '2026-11-05')
  assert.equal(when('renew in a month').date, '2026-11-22')
  assert.equal(when('budget next month').date, '2026-11-01')
})

test('calendar dates, the next time they come round', () => {
  assert.equal(when('dentist oct 28').date, '2026-10-28')
  assert.equal(when('dentist on 28th october').date, '2026-10-28')
  assert.equal(when('taxes march 15').date, '2027-03-15', 'past this year, so next year')
  assert.equal(when('party 12/31').date, '2026-12-31')
  assert.equal(when('launch 2027-02-01').date, '2027-02-01')
  assert.equal(when('feb 30 thing').date, undefined, 'not a date')
})

test('words that only look like dates stay in the title', () => {
  assert.deepEqual([when('Buy sun cream').date, when('Buy sun cream').text], [undefined, 'Buy sun cream'])
  assert.equal(when('may the force').date, undefined)
  assert.equal(when('read chapters 1-2').time, undefined)
  assert.equal(when('Monday standup notes').text, 'standup notes')
  assert.equal(when('on sat clean garage').date, '2026-10-24')
})

test('times and ranges', () => {
  assert.deepEqual([when('call 3pm').date, when('call 3pm').time], ['2026-10-22', '15:00'], 'a time alone means today')
  assert.equal(when('call at 3').time, '15:00', '"at 3" is the afternoon')
  assert.equal(when('gym at 9').time, '09:00')
  assert.equal(when('sync 14:30 tomorrow').time, '14:30')
  assert.equal(when('lunch noon').time, '12:00')
  const r = when('Lunch with Sam fri 12:30-1:30pm')
  assert.deepEqual([r.text, r.date, r.time, r.endTime], ['Lunch with Sam', '2026-10-23', '12:30', '13:30'])
  const r2 = when('review 1-2pm')
  assert.deepEqual([r2.time, r2.endTime], ['13:00', '14:00'])
  const r3 = when('workshop tomorrow 9am for 90 minutes')
  assert.deepEqual([r3.text, r3.time, r3.endTime], ['workshop', '09:00', '10:30'])
  assert.equal(when('dinner tonight').time, '18:00')
})

test('repeats, and the first day they set', () => {
  const w = when('water plants every monday')
  assert.deepEqual([w.text, w.date, w.repeat], ['water plants', '2026-10-26', { freq: 'weekly', interval: 1, byDay: [1] }])
  assert.deepEqual(when('standup every weekday 9:30').repeat, { freq: 'weekly', interval: 1, byDay: [1, 2, 3, 4, 5] })
  assert.equal(when('standup every weekday 9:30').date, '2026-10-22')
  assert.deepEqual(when('pay rent every month').repeat, { freq: 'monthly', interval: 1 })
  assert.deepEqual(when('backup every 2 weeks').repeat, { freq: 'weekly', interval: 2 })
  assert.deepEqual(when('backup every other day').repeat, { freq: 'daily', interval: 2 })
  assert.deepEqual(when('review daily').repeat, { freq: 'daily', interval: 1 })
  assert.deepEqual(when('mon and wed gym every mon and wed').repeat?.byDay, [1, 3])
  assert.equal(when('learn piano someday').someday, true)
  assert.equal(when('learn piano someday').date, undefined)
})

test('repeat days, counts and labels', () => {
  assert.deepEqual(repeatDays({ freq: 'weekly', interval: 1, byDay: [1, 3] }, '2026-10-19', '2026-10-19', '2026-10-31'), ['2026-10-19', '2026-10-21', '2026-10-26', '2026-10-28'])
  assert.deepEqual(repeatDays({ freq: 'weekly', interval: 2 }, '2026-10-22', '2026-10-22', '2026-11-20'), ['2026-10-22', '2026-11-05', '2026-11-19'])
  assert.deepEqual(repeatDays({ freq: 'monthly', interval: 1 }, '2026-01-31', '2026-01-01', '2026-04-30'), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'])
  assert.deepEqual(repeatDays({ freq: 'daily', interval: 1, count: 3 }, '2026-10-20', '2026-10-21', '2026-10-30'), ['2026-10-21', '2026-10-22'], 'the count runs from the first day')
  assert.deepEqual(repeatDays({ freq: 'daily', interval: 1, until: '2026-10-23' }, '2026-10-20', '2026-10-22', '2026-10-30'), ['2026-10-22', '2026-10-23'])
  assert.deepEqual(repeatDays({ freq: 'yearly', interval: 1 }, '2024-02-29', '2025-01-01', '2028-12-31'), ['2028-02-29'])
  assert.equal(nextRepeat({ freq: 'weekly', interval: 1, byDay: [1] }, '2026-10-19', '2026-10-22'), '2026-10-26')
  assert.equal(nextRepeat({ freq: 'daily', interval: 1, count: 2 }, '2026-10-20', '2026-10-21'), null, 'ended')
  assert.equal(repeatLabel({ freq: 'weekly', interval: 1, byDay: [1, 2, 3, 4, 5] }), 'Every weekday')
  assert.equal(repeatLabel({ freq: 'weekly', interval: 2, byDay: [3, 1] }), 'Every 2 weeks on Mon, Wed')
  assert.equal(repeatLabel({ freq: 'monthly', interval: 1 }), 'Every month')
})

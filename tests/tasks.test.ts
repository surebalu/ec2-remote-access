import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allTags, completeTask, parseTaskInput, taskCounts, upcomingGroups, viewTasks, type Task } from '../src/shared/tasks.ts'
import { applyOps, checkOp, emptyDoc, itemsOf, newRecordId } from '../src/shared/records.ts'

// Thursday, October 22, 2026.
const NOW = new Date(2026, 9, 22, 10, 15)
const TODAY = '2026-10-22'
let n = 0
const task = (o: Partial<Task>): Task => ({ id: `t${++n}`, type: 'task', title: 'x', order: n, createdAt: n, updatedAt: n, ...o })

test('views: inbox, today, upcoming, anytime, someday, logbook', () => {
  const inbox = task({ title: 'inbox' })
  const overdue = task({ title: 'overdue', date: '2026-10-20', projectId: 'p' })
  const today = task({ title: 'today', date: TODAY, time: '15:00' })
  const urgent = task({ title: 'urgent', date: TODAY, priority: 1 })
  const due = task({ title: 'deadline today', deadline: TODAY, projectId: 'p' })
  const later = task({ title: 'later', date: '2026-10-25', tags: ['home'] })
  const anytime = task({ title: 'anytime', projectId: 'p', tags: ['home', 'errand'] })
  const someday = task({ title: 'someday', someday: true })
  const done = task({ title: 'done', doneAt: 5 })
  const all = [inbox, overdue, today, urgent, due, later, anytime, someday, done]
  const titles = (v: Parameters<typeof viewTasks>[0]): string[] => viewTasks(v, all, TODAY).map((t) => t.title)
  assert.deepEqual(titles('inbox'), ['inbox'])
  assert.deepEqual(titles('today'), ['urgent', 'today', 'overdue', 'deadline today'], 'priority, then time, then order')
  assert.deepEqual(titles('upcoming'), ['later'])
  assert.deepEqual(new Set(titles('anytime')), new Set(['urgent', 'inbox', 'overdue', 'today', 'deadline today', 'anytime']), 'not later, someday or done')
  assert.deepEqual(titles('someday'), ['someday'])
  assert.deepEqual(titles('logbook'), ['done'])
  assert.deepEqual(titles('project:p'), ['overdue', 'deadline today', 'anytime'])
  assert.deepEqual(titles('tag:home'), ['later', 'anytime'])
  const c = taskCounts(all, TODAY)
  assert.deepEqual([c.inbox, c.today, c.overdue, c.upcoming, c.someday, c.projects.p, c.tags.home], [1, 4, 1, 1, 1, 3, 2])
  assert.deepEqual(allTags(all), ['errand', 'home'])
})

test('upcoming by day, with empty days and a later group', () => {
  const g = upcomingGroups([task({ date: '2026-10-24' }), task({ date: '2026-12-01' })], TODAY, 3)
  assert.deepEqual(g.map((x) => [x.day, x.tasks.length]), [['2026-10-23', 0], ['2026-10-24', 1], ['2026-10-25', 0], [null, 1]])
})

test('quick add: projects, tags, priority and dates', () => {
  const projects = [{ id: 'p1', name: 'Home' }, { id: 'p2', name: 'Home Lab' }, { id: 'p3', name: 'Platform' }]
  const a = parseTaskInput('Review PR tomorrow 3pm #Platform @code p1', projects, NOW)
  assert.deepEqual([a.title, a.date, a.time, a.projectId, a.tags, a.priority], ['Review PR', '2026-10-23', '15:00', 'p3', ['code'], 1])
  const b = parseTaskInput('Rack the switch #Home Lab', projects, NOW)
  assert.deepEqual([b.title, b.projectId], ['Rack the switch', 'p2'], 'the longest project name wins')
  const c = parseTaskInput('Paint fence #Garden @weekend !2', projects, NOW)
  assert.deepEqual([c.title, c.projectId, c.newProject, c.tags, c.priority], ['Paint fence', undefined, 'Garden', ['weekend'], 2])
  const d = parseTaskInput('email bob@example.com about p10', projects, NOW)
  assert.deepEqual([d.title, d.tags, d.priority], ['email bob@example.com about p10', [], undefined], 'an address is not a tag, p10 is not a priority')
  const e = parseTaskInput('Water plants every monday', projects, NOW)
  assert.deepEqual([e.title, e.date, e.repeat?.byDay], ['Water plants', '2026-10-26', [1]])
})

test('completing a repeating task logs it and plans the next one after today', () => {
  const t = task({ title: 'standup', date: '2026-10-19', repeat: { freq: 'daily', interval: 1 }, checklist: [{ id: 'c', text: 'notes', done: true }] })
  const [done, next] = completeTask(t, 99, TODAY, () => 'new')
  assert.equal(done.doneAt, 99)
  assert.deepEqual([next.id, next.date, next.doneAt, next.repeatFrom, next.checklist?.[0].done], ['new', '2026-10-23', undefined, '2026-10-19', false])
  const monthly = task({ date: '2026-01-31', repeat: { freq: 'monthly', interval: 1 } })
  const [, feb] = completeTask(monthly, 1, '2026-01-31', () => 'f')
  assert.equal(feb.date, '2026-02-28')
  const [, mar] = completeTask(feb, 2, '2026-02-28', () => 'm')
  assert.equal(mar.date, '2026-03-31', 'keeps to the 31st after a short month')
  assert.equal(completeTask(task({ date: TODAY }), 1, TODAY, () => 'x').length, 1, 'no repeat: just done')
})

test('records: checked operations, applied as a new revision', () => {
  const doc = applyOps(emptyDoc(), [checkOp({ op: 'put', item: task({ id: 'a' }) }), checkOp({ op: 'put', item: task({ id: 'b' }) })])
  assert.equal(doc.rev, 1)
  const next = applyOps(doc, [checkOp({ op: 'delete', id: 'a' })])
  assert.deepEqual([next.rev, Object.keys(next.items)], [2, ['b']])
  assert.equal(Object.keys(doc.items).length, 2, 'the old document is untouched')
  assert.equal(itemsOf<Task>(next, 'task').length, 1)
  assert.throws(() => checkOp({ op: 'put', item: { id: '../x', type: 'task' } }), /record id/)
  assert.throws(() => checkOp({ op: 'put', item: { id: 'a', type: 'Task!' } }), /record type/)
  assert.throws(() => checkOp({ op: 'put', item: { id: 'a', type: 'task', notes: 'x'.repeat(300_000) } }), /too large/)
  assert.throws(() => checkOp({ op: 'drop' }), /record change/)
  assert.match(newRecordId(1_700_000_000_000), /^[a-z0-9]{14}$/)
})

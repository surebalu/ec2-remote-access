/**
 * Tasks (components/tasks/TasksTab.tsx): a to-do list in the spirit of Things 3 and Todoist. A task can sit in the
 * Inbox, be planned for a day (it shows in Today once that day comes, and in Upcoming before), have a deadline, wait
 * for Someday, belong to a project, carry tags, a priority, notes, a checklist and a repeat. Completed tasks go to the
 * Logbook; completing a repeating one logs it and plans the next. Stored as records (src/shared/records.ts).
 * Pure: tests/tasks.test.ts.
 */
import type { RecordItem } from './records'
import { addDays, nextRepeat, parseWhen, type Repeat } from './naturalDate.ts'

export interface ChecklistItem { id: string; text: string; done: boolean }

export interface Task extends RecordItem {
  type: 'task'
  title: string
  notes?: string
  projectId?: string
  /** The day it is planned for ('YYYY-MM-DD'): it shows in Today from then on. */
  date?: string
  /** A time on that day ('HH:MM'). */
  time?: string
  /** A day it must be done by, shown in red once it is near. */
  deadline?: string
  someday?: boolean
  /** 1 is the highest (Todoist's p1); none is ordinary. */
  priority?: 1 | 2 | 3
  tags?: string[]
  checklist?: ChecklistItem[]
  repeat?: Repeat
  /** The first day of the repeat, so "the 31st of every month" keeps to the 31st after a short month. */
  repeatFrom?: string
  /** When it was completed (ms since 1970); completed tasks are in the Logbook. */
  doneAt?: number
  order: number
  createdAt: number
}

export interface Project extends RecordItem {
  type: 'project'
  name: string
  color: string
  notes?: string
  order: number
  /** Completed projects leave the sidebar. */
  doneAt?: number
}

export const PROJECT_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6', '#64748b']

export type TaskView = 'inbox' | 'today' | 'upcoming' | 'anytime' | 'someday' | 'logbook' | `project:${string}` | `tag:${string}`

const open = (t: Task): boolean => !t.doneAt
export const isOverdue = (t: Task, today: string): boolean => open(t) && !t.someday && ((!!t.date && t.date < today) || (!!t.deadline && t.deadline < today))
export const inToday = (t: Task, today: string): boolean => open(t) && !t.someday && ((!!t.date && t.date <= today) || (!!t.deadline && t.deadline <= today))
export const inInbox = (t: Task): boolean => open(t) && !t.projectId && !t.date && !t.deadline && !t.someday
export const inUpcoming = (t: Task, today: string): boolean => open(t) && !t.someday && !!t.date && t.date > today
export const inAnytime = (t: Task, today: string): boolean => open(t) && !t.someday && !inUpcoming(t, today)

/** Highest priority first, then the earlier time, then the order they were put in. */
export function taskOrder(a: Task, b: Task): number {
  return (a.priority ?? 4) - (b.priority ?? 4) || (a.time ?? '99').localeCompare(b.time ?? '99') || a.order - b.order || a.createdAt - b.createdAt
}

/** The tasks a view shows, in order (the Logbook newest first). */
export function viewTasks(view: TaskView, tasks: Task[], today: string): Task[] {
  if (view === 'logbook') return tasks.filter((t) => t.doneAt).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))
  const pick: (t: Task) => boolean = view === 'inbox' ? inInbox
    : view === 'today' ? (t) => inToday(t, today)
      : view === 'upcoming' ? (t) => inUpcoming(t, today)
        : view === 'anytime' ? (t) => inAnytime(t, today)
          : view === 'someday' ? (t) => open(t) && !!t.someday
            : view.startsWith('project:') ? (t) => open(t) && t.projectId === view.slice(8)
              : (t) => open(t) && !!t.tags?.includes(view.slice(4))
  const out = tasks.filter(pick)
  return view === 'upcoming' ? out.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || taskOrder(a, b)) : out.sort(taskOrder)
}

/** Upcoming by day: each of the next `days` days (empty ones too, as Things shows them), then everything later. */
export function upcomingGroups(tasks: Task[], today: string, days = 7): { day: string | null; tasks: Task[] }[] {
  const list = viewTasks('upcoming', tasks, today)
  const groups: { day: string | null; tasks: Task[] }[] = []
  for (let i = 1; i <= days; i++) {
    const day = addDays(today, i)
    groups.push({ day, tasks: list.filter((t) => t.date === day) })
  }
  const last = addDays(today, days)
  const later = list.filter((t) => (t.date ?? '') > last)
  if (later.length) groups.push({ day: null, tasks: later })
  return groups
}

export interface TaskCounts { inbox: number; today: number; overdue: number; upcoming: number; anytime: number; someday: number; projects: Record<string, number>; tags: Record<string, number> }

export function taskCounts(tasks: Task[], today: string): TaskCounts {
  const c: TaskCounts = { inbox: 0, today: 0, overdue: 0, upcoming: 0, anytime: 0, someday: 0, projects: {}, tags: {} }
  for (const t of tasks) {
    if (!open(t)) continue
    if (inInbox(t)) c.inbox++
    if (inToday(t, today)) c.today++
    if (isOverdue(t, today)) c.overdue++
    if (inUpcoming(t, today)) c.upcoming++
    if (inAnytime(t, today)) c.anytime++
    if (t.someday) c.someday++
    if (t.projectId) c.projects[t.projectId] = (c.projects[t.projectId] ?? 0) + 1
    for (const tag of t.tags ?? []) c.tags[tag] = (c.tags[tag] ?? 0) + 1
  }
  return c
}

/** Every tag in use, alphabetically. */
export const allTags = (tasks: Task[]): string[] => [...new Set(tasks.flatMap((t) => t.tags ?? []))].sort((a, b) => a.localeCompare(b))

export interface TaskInput {
  title: string
  date?: string
  time?: string
  repeat?: Repeat
  someday?: boolean
  priority?: 1 | 2 | 3
  tags: string[]
  /** A project of that name, when one exists. */
  projectId?: string
  /** A "#name" that names no project yet. */
  newProject?: string
  /** What was understood, for the preview under the box. */
  found: string[]
}

/**
 * Reads a quick-add line: "Review PR tomorrow 3pm #Platform @code p1". Projects may have spaces ("#Home Lab" when a
 * project is called that); tags are one word; p1–p3 (or !1–!3) set the priority. Dates, times and repeats are as
 * parseWhen reads them.
 */
export function parseTaskInput(input: string, projects: Pick<Project, 'id' | 'name'>[], now: Date = new Date()): TaskInput {
  let text = ` ${input} `
  const out: TaskInput = { title: '', tags: [], found: [] }
  // Longest project name first, so "#Home Lab" wins over "#Home".
  const byLength = [...projects].sort((a, b) => b.name.length - a.name.length)
  const hash = /\s#(\S[^#@]*)/.exec(text)
  if (hash) {
    const after = hash[1].toLowerCase()
    const match = byLength.find((p) => after.startsWith(p.name.toLowerCase()) && /^(\s|$)/.test(hash[1].slice(p.name.length)))
    const name = match ? hash[1].slice(0, match.name.length) : hash[1].split(/\s/)[0]
    if (match) out.projectId = match.id
    else out.newProject = name
    out.found.push(`#${name}`)
    text = text.replace(`#${name}`, ' ')
  }
  text = text.replace(/\s@([\p{L}\p{N}_\-/.]+)/gu, (_m, tag: string) => {
    if (!out.tags.includes(tag)) out.tags.push(tag)
    out.found.push(`@${tag}`)
    return ' '
  })
  text = text.replace(/\s(?:p([123])|!([123])|(!!!|!!))(?=\s)/i, (_m, p?: string, b?: string, bangs?: string) => {
    out.priority = Number(p ?? b ?? (bangs === '!!!' ? 1 : 2)) as 1 | 2 | 3
    out.found.push(`P${out.priority}`)
    return ' '
  })
  const when = parseWhen(text, now)
  out.title = when.text
  out.date = when.date
  out.time = when.time
  out.repeat = when.repeat
  out.someday = when.someday
  out.found.unshift(...when.found)
  return out
}

/**
 * Completing a task: it goes to the Logbook, and a repeating one also comes back as a new task on its next day after
 * today (so a daily task done late does not leave a trail of overdue copies). Returns the tasks to save.
 */
export function completeTask(t: Task, now: number, today: string, newId: () => string): Task[] {
  const done: Task = { ...t, doneAt: now }
  if (!t.repeat || !t.date) return [done]
  const from = t.repeatFrom ?? t.date
  const next = nextRepeat(t.repeat, from, t.date > today ? t.date : today)
  if (!next) return [done]
  return [done, {
    ...t, id: newId(), date: next, doneAt: undefined, repeatFrom: from, createdAt: now, updatedAt: now,
    checklist: t.checklist?.map((c) => ({ ...c, done: false }))
  }]
}

/** The next order number at the end of a list. */
export const nextOrder = (tasks: { order: number }[]): number => tasks.reduce((m, t) => Math.max(m, t.order), 0) + 1

/**
 * A task from one line said or typed elsewhere ("remind me to renew the cert friday 3pm #Platform"): the Tasks
 * quick-add rules, in the Inbox unless the line gives a day. The ops create its project too when "#Name" is new.
 */
export function quickTask(text: string, projects: Project[], tasks: Task[], now: number, newId: () => string): { ops: { op: 'put'; item: Task | Project }[]; task: Task } | null {
  const p = parseTaskInput(text, projects, new Date(now))
  if (!p.title) return null
  const ops: { op: 'put'; item: Task | Project }[] = []
  let projectId = p.projectId
  if (p.newProject) {
    projectId = newId()
    ops.push({ op: 'put', item: { id: projectId, type: 'project', name: p.newProject, color: PROJECT_COLORS[projects.length % PROJECT_COLORS.length], order: Math.max(0, ...projects.map((x) => x.order)) + 1, updatedAt: now } })
  }
  const task: Task = {
    id: newId(), type: 'task', title: p.title, order: Math.max(0, ...tasks.map((t) => t.order)) + 1, createdAt: now, updatedAt: now,
    ...(projectId ? { projectId } : {}), ...(p.date ? { date: p.date } : {}), ...(p.time ? { time: p.time } : {}), ...(p.priority ? { priority: p.priority } : {}),
    ...(p.someday ? { someday: true } : {}), ...(p.repeat ? { repeat: p.repeat, repeatFrom: p.date } : {}), ...(p.tags.length ? { tags: p.tags } : {})
  }
  ops.push({ op: 'put', item: task })
  return { ops, task }
}

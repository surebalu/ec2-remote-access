import { Fragment, useEffect, useMemo, useRef, useState, type ReactElement, type RefObject } from 'react'
import { addDays, dayName, fromYmd, monthName, relativeDay, repeatLabel, timeLabel, ymd, type Repeat } from '@shared/naturalDate'
import { itemsOf, puts, type RecordOp } from '@shared/records'
import { allTags, completeTask, inToday, isOverdue, nextOrder, parseTaskInput, PROJECT_COLORS, taskCounts, upcomingGroups, viewTasks, type Project, type Task, type TaskView } from '@shared/tasks'
import { applyRecords, useRecords } from '../../records'
import { setTabKeys } from '../../shortcuts'
import { useStore, type Tab } from '../../store'
import { Icon } from '../icons'
import { NavItem, newId, typing, UndoBar, useLocal, useToday } from './parts'
import './plan.css'

/**
 * Tasks: a to-do list in the spirit of Things 3 and Todoist (rules in src/shared/tasks.ts, kept as records). Views in
 * the sidebar, projects and tags under them; a quick-add box that reads "Review PR tomorrow 3pm #Work @code p1" and
 * shows what it understood; rows that open into an editor. Keys while the tab is in front and nothing is being typed:
 * N new task, ↑↓ (or J K) to move, ↩ to open, Space to complete, ⌫ to delete, Esc to close; ⌘N works from anywhere.
 */

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

const VIEWS: { id: TaskView; label: string; icon: () => ReactElement }[] = [
  { id: 'inbox', label: 'Inbox', icon: () => <Icon.download /> },
  { id: 'today', label: 'Today', icon: () => <Icon.star /> },
  { id: 'upcoming', label: 'Upcoming', icon: () => <Icon.calendar /> },
  { id: 'anytime', label: 'Anytime', icon: () => <Icon.layers /> },
  { id: 'someday', label: 'Someday', icon: () => <Icon.moon /> },
  { id: 'logbook', label: 'Logbook', icon: () => <Icon.tasks /> }
]

const longDate = (day: string): string => { const d = fromYmd(day); return `${dayName(day)}, ${monthName(d.getMonth())} ${d.getDate()}` }

export default function TasksTab({ active }: { tab: Tab; active: boolean }): ReactElement {
  const toast = useStore((s) => s.toast)
  const { doc, error } = useRecords('tasks')
  const today = useToday()
  const [view, setView] = useLocal<TaskView>('tasks.view', 'today')
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  // Completed while this view is shown: they stay in place, crossed out, until the view changes.
  const [justDone, setJustDone] = useState<Set<string>>(() => new Set())
  const [undo, setUndo] = useState<{ label: string; key: number; ops: RecordOp[] } | null>(null)
  const [addingProject, setAddingProject] = useState(false)
  const addRef = useRef<HTMLInputElement>(null)

  const tasks = useMemo(() => (doc ? itemsOf<Task>(doc, 'task') : []), [doc])
  const projects = useMemo(() => (doc ? itemsOf<Project>(doc, 'project').filter((p) => !p.doneAt).sort((a, b) => a.order - b.order) : []), [doc])
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])
  const counts = useMemo(() => taskCounts(tasks, today), [tasks, today])
  const tags = useMemo(() => allTags(tasks.filter((t) => !t.doneAt)), [tasks])
  // A task completed here is filtered as if still open, so it keeps its place.
  const shown = useMemo(() => tasks.map((t) => (justDone.has(t.id) ? { ...t, doneAt: undefined } : t)), [tasks, justDone])
  const project = view.startsWith('project:') ? projectById.get(view.slice(8)) : undefined
  // A project that is gone (deleted on another device) falls back to Today.
  useEffect(() => { if (view.startsWith('project:') && doc && !project) setView('today') }, [view, doc, project]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setJustDone(new Set()); setEditing(null) }, [view])

  const groups: { title?: string; sub?: string; tasks: Task[]; alert?: boolean }[] = useMemo(() => {
    if (view === 'today') {
      const list = viewTasks('today', shown, today)
      const overdue = list.filter((t) => isOverdue(t, today))
      return [...(overdue.length ? [{ title: 'Overdue', tasks: overdue, alert: true }] : []), { title: overdue.length ? 'Today' : undefined, tasks: list.filter((t) => !isOverdue(t, today)) }]
    }
    if (view === 'upcoming') return upcomingGroups(shown, today, 7).map((g) => ({ title: g.day ? relativeDay(g.day, today) : 'Later', sub: g.day ? longDate(g.day) : undefined, tasks: g.tasks }))
    if (view === 'logbook') {
      const by = new Map<string, Task[]>()
      for (const t of viewTasks('logbook', tasks, today)) {
        const day = ymd(new Date(t.doneAt!))
        by.set(day, [...(by.get(day) ?? []), t])
      }
      return [...by].map(([day, list]) => ({ title: relativeDay(day, today), tasks: list }))
    }
    return [{ tasks: viewTasks(view, shown, today) }]
  }, [view, shown, tasks, today])
  const flat = useMemo(() => groups.flatMap((g) => g.tasks), [groups])

  const save = (list: Task[]): void => void applyRecords('tasks', puts(list))
  const update = (t: Task, patch: Partial<Task>): void => {
    const next = { ...t, ...patch }
    for (const k of Object.keys(patch) as (keyof Task)[]) if (patch[k] === undefined) delete next[k]
    save([next])
  }

  const toggle = (t: Task): void => {
    if (t.doneAt && !justDone.has(t.id)) { update(t, { doneAt: undefined }); return }
    if (justDone.has(t.id)) {
      // Unticked again before leaving the view.
      setJustDone((s) => { const n = new Set(s); n.delete(t.id); return n })
      update(t, { doneAt: undefined })
      return
    }
    const changes = completeTask(t, Date.now(), today, newId)
    if (view !== 'logbook') setJustDone((s) => new Set(s).add(t.id))
    save(changes)
    if (changes.length > 1) toast('success', `Next: ${relativeDay(changes[1].date!, today)}`)
  }

  const remove = (list: Task[]): void => {
    if (!list.length) return
    void applyRecords('tasks', list.map((t) => ({ op: 'delete', id: t.id })))
    setUndo({ label: list.length === 1 ? `Deleted “${list[0].title}”` : `Deleted ${list.length} tasks`, key: Date.now(), ops: puts(list) })
    setEditing(null)
    setSelected(null)
  }

  /** The quick-add box: what the view implies (Today, this project…) unless the text says otherwise. */
  const add = (text: string): boolean => {
    const p = parseTaskInput(text, projects)
    if (!p.title) return false
    const now = Date.now()
    const ops: RecordOp[] = []
    let projectId = p.projectId ?? project?.id
    if (p.newProject) {
      projectId = newId()
      const created: Project = { id: projectId, type: 'project', name: p.newProject, color: PROJECT_COLORS[projects.length % PROJECT_COLORS.length], order: nextOrder(projects), updatedAt: now }
      ops.push({ op: 'put', item: created })
    }
    const date = p.date ?? (p.someday ? undefined : view === 'today' ? today : view === 'upcoming' ? addDays(today, 1) : undefined)
    const task: Task = {
      id: newId(), type: 'task', title: p.title, order: nextOrder(tasks), createdAt: now, updatedAt: now,
      ...(projectId ? { projectId } : {}), ...(date ? { date } : {}), ...(p.time ? { time: p.time } : {}), ...(p.priority ? { priority: p.priority } : {}),
      ...(p.someday || view === 'someday' ? { someday: true } : {}), ...(p.repeat ? { repeat: p.repeat, repeatFrom: date } : {}),
      ...(() => { const t = [...p.tags, ...(view.startsWith('tag:') ? [view.slice(4)] : [])]; return t.length ? { tags: [...new Set(t)] } : {} })()
    }
    ops.push({ op: 'put', item: task })
    void applyRecords('tasks', ops)
    setSelected(task.id)
    if (p.newProject) toast('success', `New project: ${p.newProject}`)
    // Said so when it went somewhere this view does not show.
    else if (view === 'inbox' && (task.date || task.projectId)) toast('info', `Added to ${task.projectId ? projectById.get(task.projectId)?.name ?? 'its project' : relativeDay(task.date!, today)}`)
    return true
  }

  // ⌘N from anywhere in the app while Tasks is in front; plain keys when nothing is being typed.
  useEffect(() => {
    if (!active) return
    setTabKeys('tasks', (k) => {
      if (k.key === 'n' && !k.shift && !k.alt) { addRef.current?.focus(); return true }
      return false
    })
    return () => setTabKeys('tasks', null)
  }, [active])
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined)
  keyRef.current = (e: KeyboardEvent): void => {
    if (typing(e) || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('.modal-backdrop')) return
    const at = flat.findIndex((t) => t.id === selected)
    const cur = at >= 0 ? flat[at] : undefined
    const k = e.key.toLowerCase()
    if (k === 'n') { e.preventDefault(); addRef.current?.focus() } else if (k === 'arrowdown' || k === 'j') {
      e.preventDefault()
      setSelected(flat[Math.min(flat.length - 1, at + 1)]?.id ?? null)
    } else if (k === 'arrowup' || k === 'k') {
      e.preventDefault()
      setSelected(flat[Math.max(0, at - 1)]?.id ?? flat[0]?.id ?? null)
    } else if (k === 'enter' && cur) { e.preventDefault(); setEditing(cur.id) } else if (k === ' ' && cur) { e.preventDefault(); toggle(cur) } else if ((k === 'backspace' || k === 'delete') && cur) { e.preventDefault(); remove([cur]) } else if (k === 'escape') { setEditing(null); setSelected(null) }
  }
  useEffect(() => {
    if (!active) return
    const on = (e: KeyboardEvent): void => keyRef.current(e)
    document.addEventListener('keydown', on)
    return () => document.removeEventListener('keydown', on)
  }, [active])

  const title = project?.name ?? (view.startsWith('tag:') ? `#${view.slice(4)}` : VIEWS.find((v) => v.id === view)?.label ?? 'Tasks')
  const editingTask = editing ? tasks.find((t) => t.id === editing) : undefined

  return (
    <section className="plan tasks" aria-label="Tasks">
      <div className="plan-frame">
        <aside className="plan-side" aria-label="Task lists">
          {VIEWS.map((v) => (
            <NavItem key={v.id} icon={v.icon()} label={v.label} on={view === v.id} onClick={() => setView(v.id)}
              count={v.id === 'today' ? counts.today : v.id === 'inbox' ? counts.inbox : v.id === 'logbook' ? 0 : v.id === 'upcoming' ? counts.upcoming : v.id === 'someday' ? counts.someday : 0}
              alert={v.id === 'today' && counts.overdue > 0} title={v.id === 'today' && counts.overdue ? `${counts.overdue} overdue` : undefined} />
          ))}
          <h4>Projects<button type="button" className="plan-add" aria-label="New project" title="New project" onClick={() => setAddingProject(true)}><Icon.plus /></button></h4>
          {projects.map((p) => (
            <NavItem key={p.id} color={p.color} label={p.name} count={counts.projects[p.id]} on={view === `project:${p.id}`} onClick={() => setView(`project:${p.id}`)} />
          ))}
          {addingProject && (
            <input className="input plan-side-input" autoFocus placeholder="Project name" aria-label="New project name"
              onBlur={() => setAddingProject(false)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setAddingProject(false)
                if (e.key !== 'Enter') return
                const name = e.currentTarget.value.trim()
                setAddingProject(false)
                if (!name) return
                const id = newId()
                void applyRecords('tasks', puts([{ id, type: 'project', name, color: PROJECT_COLORS[projects.length % PROJECT_COLORS.length], order: nextOrder(projects), updatedAt: Date.now() } as Project]))
                setView(`project:${id}`)
              }} />
          )}
          {!projects.length && !addingProject && <p className="plan-side-hint">Type <b>#Name</b> in a task to start a project.</p>}
          {tags.length > 0 && <h4>Tags</h4>}
          {tags.map((t) => <NavItem key={t} icon={<span className="plan-hash">#</span>} label={t} count={counts.tags[t]} on={view === `tag:${t}`} onClick={() => setView(`tag:${t}`)} />)}
        </aside>

        <div className="plan-main">
          <header className="plan-head">
            {project ? <ProjectTitle project={project} onChange={(p) => void applyRecords('tasks', puts([p]))} /> : <h1>{title}</h1>}
            {view === 'today' && <span className="plan-sub">{longDate(today)}</span>}
            <span className="flex-1" />
            {project && (
              <>
                <button type="button" className="btn btn-sm" title="Complete the project: it leaves the sidebar" onClick={() => {
                  const open = tasks.filter((t) => t.projectId === project.id && !t.doneAt)
                  if (open.length && !window.confirm(`Complete “${project.name}” and its ${open.length} open task${open.length === 1 ? '' : 's'}?`)) return
                  const now = Date.now()
                  save(open.map((t) => ({ ...t, doneAt: now })))
                  void applyRecords('tasks', puts([{ ...project, doneAt: now }]))
                  setView('today')
                }}><Icon.check />Complete</button>
                <button type="button" className="btn btn-sm btn-ghost" title="Delete the project and its tasks" aria-label="Delete project" onClick={() => {
                  const all = tasks.filter((t) => t.projectId === project.id)
                  if (!window.confirm(`Delete “${project.name}”${all.length ? ` and its ${all.length} task${all.length === 1 ? '' : 's'}` : ''}?`)) return
                  void applyRecords('tasks', [...all.map((t) => ({ op: 'delete' as const, id: t.id })), { op: 'delete', id: project.id }])
                  setUndo({ label: `Deleted “${project.name}”`, key: Date.now(), ops: puts([project, ...all]) })
                  setView('today')
                }}><Icon.x /></button>
              </>
            )}
            {view === 'logbook' && flat.length > 0 && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => { if (window.confirm(`Delete all ${flat.length} completed tasks for good?`)) remove(flat) }}>Clear Logbook</button>
            )}
          </header>
          {view !== 'logbook' && <QuickAdd inputRef={addRef} view={view} projects={projects} onAdd={add} />}
          <div className="plan-scroll" onClick={(e) => { if (e.target === e.currentTarget) { setSelected(null); setEditing(null) } }}>
            {error && <div className="plan-error"><Icon.alert />{error}</div>}
            {!doc && !error && <div className="plan-empty">Loading…</div>}
            {doc && groups.map((g, gi) => (
              <Fragment key={`${g.title ?? ''}${gi}`}>
                {g.title && <h3 className={`tasks-group ${g.alert ? 'alert' : ''}`}>{g.title}{g.sub && <span>{g.sub}</span>}</h3>}
                {g.tasks.map((t) => (t.id === editing && editingTask
                  ? <TaskEditor key={t.id} task={editingTask} projects={projects} tags={tags} today={today} onSave={(p) => update(editingTask, p)} onClose={() => setEditing(null)} onDelete={() => remove([editingTask])} onToggle={() => toggle(editingTask)} />
                  : <TaskRow key={t.id} task={t} done={!!tasks.find((x) => x.id === t.id)?.doneAt} today={today} inTodayView={view === 'today'} selected={selected === t.id} project={view.startsWith('project:') ? undefined : projectById.get(t.projectId ?? '')}
                    onSelect={() => setSelected(t.id)} onOpen={() => { setSelected(t.id); setEditing(t.id) }} onToggle={() => toggle(tasks.find((x) => x.id === t.id) ?? t)} />))}
                {view === 'upcoming' && !g.tasks.length && <div className="tasks-none" />}
              </Fragment>
            ))}
            {doc && !flat.length && view !== 'upcoming' && <Empty view={view} />}
          </div>
          <UndoBar undo={undo} onUndo={() => { if (undo) void applyRecords('tasks', undo.ops); setUndo(null) }} onDone={() => setUndo(null)} />
        </div>
      </div>
    </section>
  )
}

function Empty({ view }: { view: TaskView }): ReactElement {
  const text = view === 'today' ? 'Nothing planned for today.' : view === 'inbox' ? 'Your Inbox is empty.' : view === 'someday' ? 'Nothing for someday.' : view === 'logbook' ? 'Completed tasks appear here.' : 'No tasks here.'
  return <div className="plan-empty"><Icon.tasks className="plan-empty-icon" /><p>{text}</p>{view !== 'logbook' && <p className="muted">Press <kbd>N</kbd> to add one.</p>}</div>
}

function ProjectTitle({ project, onChange }: { project: Project; onChange: (p: Project) => void }): ReactElement {
  const [editing, setEditing] = useState(false)
  if (editing) {
    return <input className="input plan-title-input" autoFocus defaultValue={project.name} aria-label="Project name"
      onBlur={(e) => { setEditing(false); const name = e.currentTarget.value.trim(); if (name && name !== project.name) onChange({ ...project, name }) }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setEditing(false) }} />
  }
  return (
    <>
      <button type="button" className="plan-dot plan-dot-lg" style={{ background: project.color }} title="Change colour" aria-label="Change the project's colour"
        onClick={() => onChange({ ...project, color: PROJECT_COLORS[(PROJECT_COLORS.indexOf(project.color) + 1) % PROJECT_COLORS.length] })} />
      <h1 onDoubleClick={() => setEditing(true)} title="Double-click to rename">{project.name}</h1>
    </>
  )
}

function QuickAdd({ inputRef, view, projects, onAdd }: { inputRef: RefObject<HTMLInputElement | null>; view: TaskView; projects: Project[]; onAdd: (text: string) => boolean }): ReactElement {
  const [text, setText] = useState('')
  const parsed = useMemo(() => (text.trim() ? parseTaskInput(text, projects) : null), [text, projects])
  const hint = view === 'today' ? 'Add to Today' : view === 'upcoming' ? 'Add for tomorrow' : view === 'someday' ? 'Add to Someday' : view.startsWith('project:') ? 'Add to this project' : 'New task'
  return (
    <form className="tasks-add" onSubmit={(e) => { e.preventDefault(); if (onAdd(text)) setText('') }}>
      <Icon.plus className="tasks-add-icon" />
      <input ref={inputRef} className="tasks-add-input" value={text} onChange={(e) => setText(e.target.value)} placeholder={`${hint} — try “Call Sam tomorrow 3pm #Work @phone p1”`} aria-label="New task"
        onKeyDown={(e) => { if (e.key === 'Escape') { setText(''); e.currentTarget.blur() } }} />
      {parsed && parsed.found.length > 0 && (
        <span className="tasks-add-found" aria-label="Understood">{parsed.found.map((f) => <span key={f} className="plan-chip">{f}</span>)}</span>
      )}
    </form>
  )
}

function DateChip({ task, today, inTodayView }: { task: Task; today: string; inTodayView: boolean }): ReactElement | null {
  if (task.someday) return <span className="plan-chip">Someday</span>
  const parts: ReactElement[] = []
  // In Today, "Today" goes without saying; only its time is shown.
  if (task.date === today && inTodayView) {
    if (task.time) parts.push(<span key="d" className="plan-chip today">{timeLabel(task.time)}</span>)
  } else if (task.date) {
    const late = task.date < today && !task.doneAt
    parts.push(<span key="d" className={`plan-chip ${late ? 'late' : task.date === today ? 'today' : ''}`}><Icon.calendar />{relativeDay(task.date, today)}{task.time ? ` ${timeLabel(task.time)}` : ''}</span>)
  }
  if (task.deadline) {
    const near = task.deadline <= addDays(today, 2) && !task.doneAt
    parts.push(<span key="dl" className={`plan-chip ${near ? 'late' : ''}`} title="Deadline"><Icon.alert />{relativeDay(task.deadline, today)}</span>)
  }
  if (task.repeat) parts.push(<span key="r" className="plan-chip" title={repeatLabel(task.repeat)}><Icon.refresh /></span>)
  return parts.length ? <>{parts}</> : null
}

function TaskRow({ task, done, today, inTodayView, selected, project, onSelect, onOpen, onToggle }: {
  task: Task; done: boolean; today: string; inTodayView: boolean; selected: boolean; project?: Project
  onSelect: () => void; onOpen: () => void; onToggle: () => void
}): ReactElement {
  const checklist = task.checklist?.length ? `${task.checklist.filter((c) => c.done).length}/${task.checklist.length}` : null
  return (
    <div className={`task-row ${selected ? 'selected' : ''} ${done ? 'done' : ''}`} role="listitem" onClick={onSelect} onDoubleClick={onOpen} data-task={task.id}>
      <button type="button" className={`task-check p${task.priority ?? 0}`} aria-label={done ? `Mark “${task.title}” not done` : `Complete “${task.title}”`} aria-pressed={done}
        onClick={(e) => { e.stopPropagation(); onToggle() }}>{done && <Icon.check />}</button>
      <div className="task-body">
        <div className="task-title">{task.title}</div>
        <div className="task-meta">
          <DateChip task={task} today={today} inTodayView={inTodayView} />
          {project && <span className="plan-chip"><span className="plan-dot" style={{ background: project.color }} />{project.name}</span>}
          {task.tags?.map((t) => <span key={t} className="plan-chip tag">#{t}</span>)}
          {checklist && <span className="plan-chip"><Icon.list />{checklist}</span>}
          {task.notes && <span className="plan-chip" title={task.notes.slice(0, 200)}><Icon.note /></span>}
        </div>
      </div>
      <button type="button" className="task-open" aria-label={`Open “${task.title}”`} onClick={(e) => { e.stopPropagation(); onOpen() }}><Icon.edit /></button>
    </div>
  )
}

function TaskEditor({ task, projects, tags, today, onSave, onClose, onDelete, onToggle }: {
  task: Task; projects: Project[]; tags: string[]; today: string
  onSave: (patch: Partial<Task>) => void; onClose: () => void; onDelete: () => void; onToggle: () => void
}): ReactElement {
  const [title, setTitle] = useState(task.title)
  const [notes, setNotes] = useState(task.notes ?? '')
  const [newItem, setNewItem] = useState('')
  const [tagText, setTagText] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  // Text is saved when it is left (not on every key); the rest at once.
  const flush = (): void => {
    const patch: Partial<Task> = {}
    if (title.trim() && title.trim() !== task.title) patch.title = title.trim()
    if (notes !== (task.notes ?? '')) patch.notes = notes || undefined
    if (Object.keys(patch).length) onSave(patch)
  }
  const close = (): void => { flush(); onClose() }
  useEffect(() => { ref.current?.querySelector<HTMLInputElement>('.task-edit-title')?.focus() }, [])
  const checklist = task.checklist ?? []
  const setChecklist = (list: Task['checklist']): void => onSave({ checklist: list?.length ? list : undefined })
  const addTag = (raw: string): void => {
    const t = raw.trim().replace(/^[#@]/, '')
    if (t && !task.tags?.includes(t)) onSave({ tags: [...(task.tags ?? []), t] })
    setTagText('')
  }
  return (
    <div ref={ref} className="task-edit" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close() } }}
      onBlur={(e) => { if (!ref.current?.contains(e.relatedTarget as Node)) flush() }}>
      <div className="task-edit-top">
        <button type="button" className={`task-check p${task.priority ?? 0}`} aria-label="Complete" onClick={onToggle} />
        <input className="task-edit-title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" onKeyDown={(e) => { if (e.key === 'Enter') close() }} />
      </div>
      <textarea className="task-edit-notes" value={notes} placeholder="Notes" aria-label="Notes" rows={Math.min(8, Math.max(2, notes.split('\n').length))} onChange={(e) => setNotes(e.target.value)} />

      <div className="task-edit-checklist">
        {checklist.map((c) => (
          <label key={c.id} className={`task-item ${c.done ? 'done' : ''}`}>
            <input type="checkbox" checked={c.done} onChange={() => setChecklist(checklist.map((x) => (x.id === c.id ? { ...x, done: !x.done } : x)))} />
            <span>{c.text}</span>
            <button type="button" aria-label={`Remove ${c.text}`} onClick={(e) => { e.preventDefault(); setChecklist(checklist.filter((x) => x.id !== c.id)) }}><Icon.x /></button>
          </label>
        ))}
        <input className="task-item-add" value={newItem} placeholder="+ Checklist item" aria-label="New checklist item" onChange={(e) => setNewItem(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && newItem.trim()) { e.preventDefault(); setChecklist([...checklist, { id: newId(), text: newItem.trim(), done: false }]); setNewItem('') } }} />
      </div>

      <div className="task-edit-fields">
        <label><span>When</span>
          <span className="task-when">
            <input type="date" className="input" value={task.date ?? ''} aria-label="Date" onChange={(e) => onSave({ date: e.target.value || undefined, someday: undefined, repeatFrom: task.repeat ? e.target.value || undefined : undefined })} />
            <button type="button" className={`btn btn-sm ${task.date === today ? 'on' : ''}`} onClick={() => onSave({ date: today, someday: undefined })}>Today</button>
            <button type="button" className="btn btn-sm" onClick={() => onSave({ date: addDays(today, 1), someday: undefined })}>Tomorrow</button>
            <button type="button" className={`btn btn-sm ${task.someday ? 'on' : ''}`} onClick={() => onSave({ someday: task.someday ? undefined : true, date: undefined, time: undefined })}>Someday</button>
          </span>
        </label>
        <label><span>Time</span><input type="time" className="input" value={task.time ?? ''} disabled={!task.date} aria-label="Time" onChange={(e) => onSave({ time: e.target.value || undefined })} /></label>
        <label><span>Deadline</span><input type="date" className="input" value={task.deadline ?? ''} aria-label="Deadline" onChange={(e) => onSave({ deadline: e.target.value || undefined })} /></label>
        <label><span>Repeat</span>
          <select className="input" value={repeatId(task.repeat)} aria-label="Repeat" onChange={(e) => {
            const r = REPEATS.find((x) => x.id === e.target.value)?.repeat
            onSave({ repeat: r, repeatFrom: r ? task.date ?? today : undefined, date: r ? task.date ?? today : task.date })
          }}>
            {REPEATS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            {repeatId(task.repeat) === 'custom' && task.repeat && <option value="custom">{repeatLabel(task.repeat)}</option>}
          </select>
        </label>
        <label><span>Project</span>
          <select className="input" value={task.projectId ?? ''} aria-label="Project" onChange={(e) => onSave({ projectId: e.target.value || undefined })}>
            <option value="">None (Inbox)</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label><span>Priority</span>
          <span className="plan-segment" role="radiogroup" aria-label="Priority">
            {([undefined, 1, 2, 3] as const).map((p) => (
              <button key={p ?? 0} type="button" role="radio" aria-checked={task.priority === p} className={`${task.priority === p ? 'on' : ''} p${p ?? 0}`} onClick={() => onSave({ priority: p })}>{p ? `P${p}` : 'None'}</button>
            ))}
          </span>
        </label>
        <label className="task-tags"><span>Tags</span>
          <span className="task-tag-list">
            {task.tags?.map((t) => <button key={t} type="button" className="plan-chip tag" title="Remove" onClick={() => onSave({ tags: task.tags!.filter((x) => x !== t).length ? task.tags!.filter((x) => x !== t) : undefined })}>#{t} <Icon.x /></button>)}
            <input className="task-tag-input" list="task-tag-options" value={tagText} placeholder="Add tag" aria-label="Add a tag" onChange={(e) => setTagText(e.target.value)}
              onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ',') && tagText.trim()) { e.preventDefault(); addTag(tagText) } }} onBlur={() => { if (tagText.trim()) addTag(tagText) }} />
            <datalist id="task-tag-options">{tags.filter((t) => !task.tags?.includes(t)).map((t) => <option key={t} value={t} />)}</datalist>
          </span>
        </label>
      </div>
      <div className="task-edit-foot">
        <button type="button" className="btn btn-sm btn-ghost" onClick={onDelete}><Icon.x />Delete</button>
        <span className="flex-1" />
        <span className="muted">{task.doneAt ? `Completed ${relativeDay(ymd(new Date(task.doneAt)), today)}` : inToday(task, today) ? 'In Today' : ''}</span>
        <button type="button" className="btn btn-sm btn-primary" onClick={close}>Done</button>
      </div>
    </div>
  )
}

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { buildEmojiList, emojiTitle, noteRecentEmoji, searchEmoji, type EmojiEntry } from '@shared/emoji'
import { formatBits, rpmWord, type DownloadItem, type NetworkInfo, type ProcessInfo, type SpeedResult } from '@shared/macTools'
import { bytes, type DiskInfo } from '@shared/storage'
import type { MonitorSample } from '@shared/macApps'
import { displayPath, formatDate, parentOf } from '@shared/finder'
import { matchScore } from '@shared/launcher'
import { Icon } from '../components/icons'
import { copy, copyFile, hide, inApp, openPath, quickLook, reveal, used } from './actions'
import type { Group, LauncherMode, Row } from './rows'

/**
 * The launcher's modes: a command that opens a list of its own in the launcher, as Raycast's do (Search Emoji, Kill
 * Process, My IP, Speed Test, System Monitor, Downloads, Capture). The search field then filters that list; ⌫ on an
 * empty field or Esc goes back. Each mode reads only while it is open.
 */

export const MODES: Record<LauncherMode, { title: string; placeholder: string }> = {
  emoji: { title: 'Emoji', placeholder: 'Search emoji: smile, rocket, thumbs up…' },
  processes: { title: 'Kill Process', placeholder: 'Filter processes by name or PID…' },
  network: { title: 'My IP', placeholder: 'Filter addresses…' },
  speed: { title: 'Speed Test', placeholder: 'Testing this Mac’s connection…' },
  monitor: { title: 'System Monitor', placeholder: 'Filter…' },
  downloads: { title: 'Downloads', placeholder: 'Filter downloads by name…' },
  capture: { title: 'Capture', placeholder: 'A thought for today’s note… ↩ adds it, ⌘↩ as a task' }
}

export interface ModeContext {
  home: string
  /** The Accessibility permission is on, so emoji can be typed into the app in front (else they are copied). */
  canPaste: boolean
  notice: (text: string, tone?: 'ok' | 'err') => void
  setQuery: (q: string) => void
}

export interface ModeView {
  groups: Group[]
  /** Draw the rows as a grid of large symbols (the emoji). */
  grid?: boolean
  /** What to say when there are no rows yet. */
  empty?: string
}

const ago = (t: number, now: number): string => {
  const s = Math.max(0, (now - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`
  if (s < 7 * 86_400) return `${Math.round(s / 86_400)} d ago`
  return formatDate(t)
}

const uptimeWords = (secs: number): string => {
  const d = Math.floor(secs / 86_400)
  const h = Math.floor((secs % 86_400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`
}

/** Rows whose title or words hold the query (all of them when nothing is typed), in their own order. */
function filterRows(rows: Row[], q: string): Row[] {
  const query = q.trim()
  if (!query) return rows
  return rows.filter((r) => matchScore(query, r.title) > 0 || (r.keywords && r.keywords.toLowerCase().includes(query.toLowerCase())))
}

/** Reads `load` while `on`, again every `every` ms, and when `bump` changes. */
function usePoll<T>(on: boolean, load: () => Promise<T>, every: number, bump = 0): { data: T | null; error: string | null; loading: boolean } {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: false })
  useEffect(() => {
    if (!on) { setState({ data: null, error: null, loading: false }); return }
    let stop = false
    const go = (): void => {
      setState((s) => ({ ...s, loading: true }))
      load().then((data) => { if (!stop) setState({ data, error: null, loading: false }) }, (e: Error) => { if (!stop) setState((s) => ({ ...s, error: e.message, loading: false })) })
    }
    go()
    const t = every ? setInterval(go, every) : undefined
    return () => { stop = true; if (t) clearInterval(t) }
  }, [on, bump]) // eslint-disable-line react-hooks/exhaustive-deps
  return state
}

// ----- Emoji -----

let emojiList: EmojiEntry[] | null = null
const RECENT_EMOJI = 'launcher.emoji.recent'

async function loadEmoji(): Promise<EmojiEntry[]> {
  if (emojiList) return emojiList
  const [byEmoji, keywords] = await Promise.all([import('unicode-emoji-json'), import('emojilib')])
  emojiList = buildEmojiList(byEmoji.default, keywords.default)
  return emojiList
}

const readRecent = (): string[] => { try { return JSON.parse(localStorage.getItem(RECENT_EMOJI) ?? '[]') as string[] } catch { return [] } }

function useEmoji(on: boolean, query: string, ctx: ModeContext): Group[] {
  const [list, setList] = useState<EmojiEntry[] | null>(emojiList)
  useEffect(() => { if (on && !list) void loadEmoji().then(setList) }, [on]) // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(() => {
    if (!on || !list) return []
    const recent = readRecent()
    const found = searchEmoji(list, query, recent, query.trim() ? 240 : 400)
    const pick = (e: EmojiEntry): void => { try { localStorage.setItem(RECENT_EMOJI, JSON.stringify(noteRecentEmoji(readRecent(), e.char))) } catch { /* storage off */ } }
    const rows = found.map((e): Row => ({
      id: `emoji:${e.char}`, title: emojiTitle(e), icon: <span className="launcher-emoji">{e.char}</span>,
      detail: { kind: 'emoji', char: e.char, name: emojiTitle(e), words: e.words },
      actions: [
        ctx.canPaste
          ? { title: 'Paste into the App in Front', key: 'enter', run: () => { pick(e); used('tool:emoji'); void window.api.invoke('launcher:paste', e.char) } }
          : { title: 'Copy Emoji', key: 'enter', run: () => { pick(e); used('tool:emoji'); copy(e.char)() } },
        ctx.canPaste
          ? { title: 'Copy Emoji', key: 'cmd+enter', run: () => { pick(e); copy(e.char)() } }
          : { title: 'Paste Emoji Directly… (Accessibility)', key: 'cmd+enter', run: () => void window.api.invoke('wm:askAccess').catch(() => undefined) },
        { title: 'Copy Name', key: 'shift+cmd+c', run: copy(emojiTitle(e)) }
      ]
    }))
    const recentSet = new Set(recent)
    if (query.trim()) return [{ title: `${rows.length} found`, rows }]
    const first = rows.filter((r) => recentSet.has(r.id.slice(6)))
    return [{ title: 'Recently Used', rows: first }, { title: 'All Emoji', rows: rows.slice(first.length) }].filter((g) => g.rows.length)
  }, [on, list, query, ctx.canPaste]) // eslint-disable-line react-hooks/exhaustive-deps
}

// ----- Kill Process -----

function useProcesses(on: boolean, query: string, ctx: ModeContext): Group[] {
  const [bump, setBump] = useState(0)
  const { data } = usePoll(on, () => window.api.invoke('launcher:processes'), 3000, bump)
  const end = (p: ProcessInfo, force: boolean) => (): void => {
    window.api.invoke('launcher:kill', p.pid, force).then(
      () => { ctx.notice(`${force ? 'Force quit' : 'Asked to quit:'} ${p.name} (PID ${p.pid}).`, 'ok'); setBump((n) => n + 1) },
      (e: Error) => ctx.notice(`${p.name}: ${e.message}`, 'err')
    )
  }
  return useMemo(() => {
    if (!on || !data) return []
    const q = query.trim().toLowerCase()
    const list = q ? data.filter((p) => p.name.toLowerCase().includes(q) || String(p.pid).startsWith(q) || p.command.toLowerCase().includes(q)) : data
    const rows = list.slice(0, 120).map((p): Row => ({
      id: `proc:${p.pid}`, title: p.name, subtitle: `PID ${p.pid} · ${p.user}`, icon: <Icon.activity />, iconPath: p.app,
      accessory: <span className="launcher-meter">{p.cpu.toFixed(1)}% · {bytes(p.memory)}</span>,
      detail: { kind: 'facts', title: p.name, big: <Icon.activity />, facts: [['PID', p.pid], ['Parent', p.ppid], ['User', p.user], ['CPU', `${p.cpu.toFixed(1)}%`], ['Memory', bytes(p.memory)], ['Program', <span className="launcher-url">{p.command}</span>]], note: '↩ asks it to quit (SIGTERM); ⌘↩ ends it at once (SIGKILL), losing anything unsaved.' },
      actions: [
        { title: 'Quit Process', key: 'enter', run: end(p, false) },
        { title: 'Force Quit Process', key: 'cmd+enter', run: end(p, true) },
        { title: 'Copy PID', key: 'shift+cmd+c', run: copy(String(p.pid)) },
        { title: 'Reload', key: 'cmd+r', run: () => setBump((n) => n + 1) }
      ]
    }))
    return [{ title: `${list.length} process${list.length === 1 ? '' : 'es'} · busiest first`, rows }]
  }, [on, data, query]) // eslint-disable-line react-hooks/exhaustive-deps
}

// ----- My IP -----

function useNetwork(on: boolean, query: string, ctx: ModeContext): Group[] {
  const [bump, setBump] = useState(0)
  const { data, error } = usePoll<NetworkInfo>(on, () => window.api.invoke('launcher:network'), 0, bump)
  useEffect(() => { if (on && error) ctx.notice(error, 'err') }, [on, error]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (on && data?.publicError) ctx.notice(data.publicError, 'err') }, [on, data]) // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(() => {
    if (!on || !data) return []
    const rows = data.addresses.map((a, i): Row => ({
      id: `ip:${i}:${a.address}`, title: a.address, subtitle: a.label, keywords: `${a.label} ${a.note ?? ''}`, icon: a.label.startsWith('Public') ? <Icon.globe /> : a.label === 'Router' ? <Icon.server /> : <Icon.plug />,
      accessory: a.note && a.note.length < 22 ? a.note : undefined,
      detail: { kind: 'facts', title: a.label, big: <span className="launcher-big-text">{a.address}</span>, facts: [['Address', a.address], ['What', a.label], ['Note', a.note]] },
      actions: [
        { title: 'Copy Address', key: 'enter', run: () => { used('tool:network'); copy(a.address)() } },
        { title: 'Copy All', key: 'shift+cmd+c', run: copy(data.addresses.map((x) => `${x.label}: ${x.address}`).join('\n')) },
        { title: 'Read Again', key: 'cmd+r', run: () => setBump((n) => n + 1) }
      ]
    }))
    const shown = filterRows(rows, query)
    const pub = shown.filter((r) => r.subtitle?.startsWith('Public'))
    return [{ title: 'Public', rows: pub }, { title: 'This Mac', rows: shown.filter((r) => !pub.includes(r)) }].filter((g) => g.rows.length)
  }, [on, data, query]) // eslint-disable-line react-hooks/exhaustive-deps
}

// ----- Speed Test -----

function useSpeed(on: boolean): Group[] {
  const [run, setRun] = useState<{ started: number; result?: SpeedResult; error?: string } | null>(null)
  const [, tick] = useState(0)
  const start = (): void => {
    const started = Date.now()
    setRun({ started })
    window.api.invoke('launcher:speedTest').then((result) => setRun((r) => (r?.started === started ? { started, result } : r)), (e: Error) => setRun((r) => (r?.started === started ? { started, error: e.message } : r)))
  }
  useEffect(() => {
    if (!on) { setRun(null); return }
    used('tool:speed')
    start()
  }, [on]) // eslint-disable-line react-hooks/exhaustive-deps
  const running = on && !!run && !run.result && !run.error
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => tick((n) => n + 1), 500)
    return () => clearInterval(t)
  }, [running])
  if (!on || !run) return []
  const again = { title: 'Test Again', key: 'cmd+r', run: start }
  if (run.error) return [{ title: 'Speed Test', rows: [{ id: 'speed:error', title: 'The test did not finish', subtitle: run.error, icon: <Icon.alert />, actions: [{ ...again, key: 'enter' }] }] }]
  if (!run.result) {
    const secs = Math.round((Date.now() - run.started) / 1000)
    return [{ title: 'Speed Test', rows: [{
      id: 'speed:running', title: `Testing download and upload… ${secs} s`, subtitle: 'macOS’s networkQuality, against Apple’s servers; about twenty seconds', icon: <Icon.gauge className="launcher-spin" />,
      detail: { kind: 'facts', title: 'Testing…', big: <Icon.gauge className="launcher-spin" />, facts: [['Elapsed', `${secs} s`]], note: 'Download and upload run at the same time, then the delay under load (responsiveness) is worked out.' },
      actions: []
    }] }]
  }
  const r = run.result
  const summary = `Download ${formatBits(r.download)}, upload ${formatBits(r.upload)}, responsiveness ${r.rpm} RPM (${rpmWord(r.rpm)}), idle latency ${r.idleMs} ms`
  const fact = (id: string, title: string, value: string, sub: string, icon: ReactNode): Row => ({
    id: `speed:${id}`, title: value, subtitle: title, icon,
    detail: { kind: 'facts', title, big: <span className="launcher-big-text">{value}</span>, facts: [['Download', formatBits(r.download)], ['Upload', formatBits(r.upload)], ['Responsiveness', `${r.rpm} RPM · ${rpmWord(r.rpm)}`], ['Idle latency', `${r.idleMs} ms`], ['Interface', r.interface], ['Server', r.server]], note: sub },
    actions: [{ title: 'Copy Result', key: 'enter', run: copy(summary) }, again]
  })
  return [{ title: 'Speed Test', rows: [
    fact('down', 'Download', formatBits(r.download), 'How fast this Mac receives.', <Icon.arrowDown />),
    fact('up', 'Upload', formatBits(r.upload), 'How fast this Mac sends.', <Icon.arrowUp />),
    fact('rpm', 'Responsiveness', `${r.rpm} RPM · ${rpmWord(r.rpm)}`, 'Round trips a minute while the line is busy: how snappy calls, SSH and RDP stay under load.', <Icon.activity />),
    fact('idle', 'Idle latency', `${r.idleMs} ms`, 'One round trip with nothing else going on.', <Icon.gauge />)
  ] }]
}

// ----- System Monitor -----

function useMonitor(on: boolean, query: string): Group[] {
  const { data } = usePoll<MonitorSample>(on, () => window.api.invoke('storage:monitor'), 2000)
  const disk = usePoll<DiskInfo>(on, () => window.api.invoke('storage:disk'), 0).data
  return useMemo(() => {
    if (!on || !data) return []
    const open = inApp('tool:monitor', { kind: 'storage', room: 'monitor' })
    const row = (id: string, title: string, value: string, icon: ReactNode, facts: [string, ReactNode][]): Row => ({
      id: `mon:${id}`, title: value, subtitle: title, keywords: title, icon, detail: { kind: 'facts', title, big: <span className="launcher-big-text">{value}</span>, facts },
      actions: [{ title: 'Open the Monitor in Storage', key: 'enter', run: open }, { title: 'Copy', key: 'shift+cmd+c', run: copy(`${title}: ${value}`) }]
    })
    const m = data.memory
    const rows: Row[] = [
      row('cpu', 'Processor', `${data.cpu.toFixed(0)}%`, <Icon.activity />, [['User', `${data.cpuUser.toFixed(0)}%`], ['System', `${data.cpuSys.toFixed(0)}%`], ['Cores', data.cores.length], ['Load', data.load.map((x) => x.toFixed(2)).join(' · ')], ['Thermal', data.thermal === 'warm' ? 'Throttled (warm)' : 'Normal']]),
      row('mem', 'Memory', `${bytes(m.used)} of ${bytes(m.total)}`, <Icon.layers />, [['App memory', bytes(m.app)], ['Wired', bytes(m.wired)], ['Compressed', bytes(m.compressed)], ['Cached files', bytes(m.cached)], ['Swap', bytes(m.swap)], ['Pressure', m.pressure]]),
      ...(disk ? [row('disk', 'Disk', `${bytes(disk.free)} free of ${bytes(disk.total)}`, <Icon.disk />, [['Disk', disk.name], ['Free now', bytes(disk.freeNow)], ['Free (with purgeable)', bytes(disk.free)]])] : []),
      row('net', 'Network', `↓ ${bytes(data.net.rx)}/s  ↑ ${bytes(data.net.tx)}/s`, <Icon.plug />, [['Receiving', `${bytes(data.net.rx)}/s`], ['Sending', `${bytes(data.net.tx)}/s`], ['Address', data.address]]),
      ...(data.battery ? [row('battery', 'Battery', `${data.battery.percent}%${data.battery.charging ? ' · charging' : data.battery.plugged ? ' · plugged in' : ''}`, <Icon.power />, [['Time left', data.battery.minutes ? `${Math.floor(data.battery.minutes / 60)} h ${data.battery.minutes % 60} min` : undefined], ['Cycles', data.battery.cycles], ['Health', data.battery.health ? `${data.battery.health}%` : undefined]])] : []),
      row('uptime', 'Uptime', uptimeWords(data.uptime), <Icon.history />, [['Since', formatDate(Date.now() - data.uptime * 1000)]])
    ]
    const apps = data.apps.slice(0, 8).map((a): Row => ({
      id: `mon:app:${a.path}`, title: a.name, subtitle: `${a.cpu.toFixed(1)}% CPU · ${bytes(a.memory)}`, icon: <Icon.apps />, iconPath: a.path.endsWith('.app') ? a.path : undefined,
      detail: { kind: 'facts', title: a.name, facts: [['CPU', `${a.cpu.toFixed(1)}%`], ['Memory', bytes(a.memory)], ['Processes', a.pids.length]] },
      actions: [{ title: 'Open the Monitor in Storage', key: 'enter', run: open }]
    }))
    return [{ title: 'This Mac now', rows: filterRows(rows, query) }, { title: 'Working hardest', rows: filterRows(apps, query) }].filter((g) => g.rows.length)
  }, [on, data, disk, query]) // eslint-disable-line react-hooks/exhaustive-deps
}

// ----- Downloads -----

/** A download's actions, shared with the root's Latest Download commands. */
export function downloadRow(d: DownloadItem, home: string, now: number, reload?: () => void, notice?: ModeContext['notice']): Row {
  const id = `file:${d.path}`
  return {
    id, title: d.name, subtitle: `${ago(d.added, now)}${d.dir ? '' : ` · ${bytes(d.size)}`} · ${displayPath(parentOf(d.path), home)}`, icon: d.dir ? <Icon.folder /> : <Icon.download />, iconPath: d.path,
    detail: { kind: 'path', path: d.path },
    actions: [
      { title: 'Open', key: 'enter', run: openPath(id, d.path) },
      { title: 'Show in Finder', key: 'cmd+enter', run: reveal(d.path) },
      { title: 'Quick Look', key: 'cmd+y', run: quickLook(d.path) },
      { title: 'Copy File', key: 'shift+cmd+c', run: copyFile(d.path) },
      { title: 'Copy Path', key: 'alt+cmd+c', run: copy(d.path) },
      ...(reload ? [{ title: 'Move to Trash', key: 'cmd+backspace', run: () => {
        window.api.invoke('local:trash', [d.path]).then(() => { notice?.(`${d.name} is in the Trash.`, 'ok'); reload() }, (e: Error) => notice?.(e.message, 'err'))
      } }] : [])
    ]
  }
}

function useDownloads(on: boolean, query: string, ctx: ModeContext): Group[] {
  const [bump, setBump] = useState(0)
  const { data } = usePoll<DownloadItem[]>(on, () => window.api.invoke('launcher:downloads'), 0, bump)
  return useMemo(() => {
    if (!on || !data) return []
    const now = Date.now()
    const rows = filterRows(data.map((d) => downloadRow(d, ctx.home, now, () => setBump((n) => n + 1), ctx.notice)), query)
    const day = 86_400_000
    const byAdded = new Map(data.map((d) => [`file:${d.path}`, d.added]))
    const recent = rows.filter((r) => now - (byAdded.get(r.id) ?? 0) < day)
    const week = rows.filter((r) => !recent.includes(r) && now - (byAdded.get(r.id) ?? 0) < 7 * day)
    const older = rows.filter((r) => !recent.includes(r) && !week.includes(r))
    return [{ title: 'Today', rows: recent }, { title: 'This Week', rows: week }, { title: 'Earlier', rows: older }].filter((g) => g.rows.length)
  }, [on, data, query, ctx.home]) // eslint-disable-line react-hooks/exhaustive-deps
}

// ----- Capture -----

function useCapture(on: boolean, query: string, ctx: ModeContext): Group[] {
  const today = inApp('cmd:today', { kind: 'today' })
  const obsidian = (): void => {
    void window.api.invoke('notes:daily').then((p) => window.api.invoke('notes:openInObsidian', p)).then(hide, (e: Error) => ctx.notice(e.message, 'err'))
  }
  const add = (task: boolean) => (): void => {
    const text = query.trim()
    if (!text) return
    window.api.invoke('notes:capture', text, task).then((path) => {
      used('tool:capture')
      ctx.notice(`${task ? 'Task added to' : 'Added to'} ${path.split('/').pop()}`, 'ok')
      ctx.setQuery('')
    }, (e: Error) => ctx.notice(e.message, 'err'))
  }
  if (!on) return []
  const text = query.trim()
  const open: Row[] = [
    { id: 'capture:open', title: 'Open Today’s Note', subtitle: 'In the app’s Notes', icon: <Icon.note />, actions: [{ title: 'Open Today’s Note', key: 'enter', run: today }, { title: 'Open in Obsidian', key: 'cmd+o', run: obsidian }] },
    { id: 'capture:obsidian', title: 'Open Today’s Note in Obsidian', subtitle: 'obsidian://', icon: <Icon.openTab />, actions: [{ title: 'Open in Obsidian', key: 'enter', run: obsidian }] }
  ]
  if (!text) return [{ title: 'Today’s note', rows: open }]
  const preview = (task: boolean): ReactNode => <code className="launcher-capture">{task ? `- [ ] ${text}` : `- ${new Date().toTimeString().slice(0, 5)} ${text}`}</code>
  return [
    { title: 'Capture', rows: [
      { id: 'capture:add', title: `Add “${text}”`, subtitle: 'To the end of today’s note, with the time', icon: <Icon.plus />,
        detail: { kind: 'facts', title: 'Today’s note gets', facts: [], note: preview(false) },
        actions: [{ title: 'Add to Today’s Note', key: 'enter', run: add(false) }, { title: 'Add as a Task', key: 'cmd+enter', run: add(true) }] },
      { id: 'capture:task', title: `Add “${text}” as a task`, subtitle: 'A checkbox in today’s note (Obsidian’s Tasks see it)', icon: <Icon.tasks />,
        detail: { kind: 'facts', title: 'Today’s note gets', facts: [], note: preview(true) },
        actions: [{ title: 'Add as a Task', key: 'enter', run: add(true) }, { title: 'Add to Today’s Note', key: 'cmd+enter', run: add(false) }] }
    ] },
    { title: 'Today’s note', rows: open }
  ]
}

/** The list a mode shows for what is typed. */
export function useModeView(mode: LauncherMode | null, query: string, ctx: ModeContext): ModeView {
  const emoji = useEmoji(mode === 'emoji', query, ctx)
  const procs = useProcesses(mode === 'processes', query, ctx)
  const net = useNetwork(mode === 'network', query, ctx)
  const speed = useSpeed(mode === 'speed')
  const monitor = useMonitor(mode === 'monitor', query)
  const downloads = useDownloads(mode === 'downloads', query, ctx)
  const capture = useCapture(mode === 'capture', query, ctx)
  switch (mode) {
    case 'emoji': return { groups: emoji, grid: true, empty: emojiList ? 'No emoji has that name.' : 'Loading emoji…' }
    case 'processes': return { groups: procs, empty: 'Reading processes…' }
    case 'network': return { groups: net, empty: 'Reading addresses…' }
    case 'speed': return { groups: speed, empty: 'Starting…' }
    case 'monitor': return { groups: monitor, empty: 'Reading…' }
    case 'downloads': return { groups: downloads, empty: query ? 'No download has that name.' : 'Reading Downloads…' }
    case 'capture': return { groups: capture }
    default: return { groups: [] }
  }
}

import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppCommand, AwsProfile, Instance, Settings } from '@shared/types'
import type { RecentFile } from '@shared/finder'
import { calculate, formatNumber, matchScore, recentIds, usageBoost, type LauncherApp, type LauncherUsage } from '@shared/launcher'
import { comboOf, formatCombo, RAIL_SECTIONS, SECTION_NAMES, sectionKeys, type RailSection } from '@shared/keyCombos'
import { manualToInstance } from '@shared/manual'
import { matchesHost } from '@shared/hostSearch'
import { consoleHome, ec2InstanceUrl, normalizeInput } from '@shared/browser'
import { applyAppearance } from '../store'
import { applyUiFont } from '../uiFont'
import { Icon } from '../components/icons'

/**
 * The launcher: Raycast's search bar for this Mac and this app, in its own floating window (main/launcherWindow.ts)
 * opened by a key that works in every app. One field searches the apps on the Mac, your hosts, the app's sections and
 * commands, AWS consoles, files (Spotlight) and the web, and does arithmetic. ↵ runs a result's first action, ⌘↵ its
 * second, ⌘K lists them all. The app's window carries out anything inside the app (launcher:command → app:command).
 */

interface Action {
  title: string
  /** A combination as keyCombos.ts writes them: 'enter' for the first action, 'cmd+enter' for the second. */
  key?: string
  run: () => void
}

interface Row {
  id: string
  title: string
  subtitle?: string
  /** Words it is also found by. */
  keywords?: string
  icon: ReactNode
  /** A file or app whose Finder icon replaces `icon` once it has loaded. */
  iconPath?: string
  accessory?: ReactNode
  actions: Action[]
}

interface Group {
  title: string
  rows: Row[]
  /** How well its first row matches, which orders the groups between the calculator and web search. */
  best?: number
}

interface Data {
  apps: LauncherApp[]
  usage: LauncherUsage
  settings: Settings | null
  hosts: Instance[]
  profiles: AwsProfile[]
  home: string
}

const EMPTY: Data = { apps: [], usage: {}, settings: null, hosts: [], profiles: [], home: '' }

const SECTION_ICONS: Record<RailSection, (p: { className?: string }) => ReactElement> = {
  hosts: Icon.server, overview: Icon.grid, local: Icon.console, finder: Icon.finder, browser: Icon.globe, notes: Icon.note, board: Icon.board, claude: Icon.claude, chatgpt: Icon.chatgpt
}
const SECTION_ABOUT: Record<RailSection, string> = {
  hosts: 'Every account’s hosts', overview: 'All open sessions on one page', local: 'Shells on this Mac', finder: 'Files on this Mac',
  browser: 'AWS console spaces and web tabs', notes: 'Your Markdown notes', board: 'The scratch pad', claude: 'Chat, signed in on its own', chatgpt: 'Chat, signed in on its own'
}
const SECTION_WORDS: Record<RailSection, string> = {
  hosts: 'instances servers ec2 list', overview: 'all sessions grid', local: 'shell zsh console warp', finder: 'files folders', browser: 'web tabs arc',
  notes: 'obsidian markdown', board: 'whiteboard draw sketch', claude: 'ai chat anthropic', chatgpt: 'ai chat openai gpt'
}

const hide = (): void => void window.api.invoke('launcher:hide')
const used = (id: string): void => void window.api.invoke('launcher:used', id).catch(() => undefined)
/** Has the app's window do `c` (it comes to the front), counting a use of `id`. */
const inApp = (id: string, c: AppCommand) => (): void => {
  used(id)
  void window.api.invoke('launcher:command', c)
}
const openPath = (id: string, path: string) => (): void => void window.api.invoke('launcher:open', path, id).catch(() => undefined)
const copy = (text: string) => (): void => {
  void window.api.invoke('clipboard:write', text)
  hide()
}
const external = (url: string) => (): void => {
  void window.api.invoke('shell:open', url)
  hide()
}
const reveal = (path: string) => (): void => {
  void window.api.invoke('local:reveal', path)
  hide()
}

const parentOf = (p: string): string => p.replace(/\/[^/]+\/?$/, '') || '/'
const tilde = (p: string, home: string): string => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p)

/**
 * The best of the title's and the keywords' match, plus how often and lately it was used. Keywords (IPs, tags) count
 * only where a word starts or the text appears, never as scattered letters, which find noise in long tag lists.
 */
function rankRows(rows: Row[], q: string, usage: LauncherUsage, now: number): { rows: Row[]; best: number } {
  const scored = rows
    .map((r) => {
      const k = r.keywords ? matchScore(q, r.keywords) : 0
      const m = Math.max(matchScore(q, r.title), k >= 45 ? k * 0.6 : 0)
      return { r, s: m ? m + usageBoost(usage[r.id], now) : 0 }
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
  return { rows: scored.map((x) => x.r), best: scored[0]?.s ?? 0 }
}

export default function Launcher(): ReactElement {
  const [data, setData] = useState<Data>(EMPTY)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const [panel, setPanel] = useState<number | null>(null)
  const [files, setFiles] = useState<RecentFile[]>([])
  const [icons, setIcons] = useState<Record<string, string>>({})
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const fileSeq = useRef(0)

  const load = async (): Promise<void> => {
    const soft = <T,>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback)
    const [apps, usage, settings, cached, profiles, home] = await Promise.all([
      soft(window.api.invoke('launcher:apps'), [] as LauncherApp[]),
      soft(window.api.invoke('launcher:usage'), {} as LauncherUsage),
      soft(window.api.invoke('settings:get'), null),
      soft(window.api.invoke('inventory:cached'), null),
      soft(window.api.invoke('profiles:list'), [] as AwsProfile[]),
      soft(window.api.invoke('local:home'), '')
    ])
    if (settings) {
      applyUiFont(settings.uiFont)
      applyAppearance(settings.theme, settings.colorTheme)
    }
    const off = new Set(profiles.filter((p) => !p.enabled).map((p) => p.name))
    const hosts = [...(cached?.instances ?? []).filter((i) => !off.has(i.profile)), ...(settings?.manualHosts ?? []).map(manualToInstance)]
    setData({ apps, usage, settings, hosts, profiles, home })
  }

  useEffect(() => {
    void load()
    // Each time it appears: an empty field with the keyboard, and fresh lists (apps installed, hosts scanned since).
    return window.api.on('launcher:shown', () => {
      setQ('')
      setSel(0)
      setPanel(null)
      setFiles([])
      setTimeout(() => input.current?.focus(), 0)
      void load()
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ----- rows -----
  const settings = data.settings
  const accountLabel = (i: Instance): string => (i.manual ? (i.profile === 'servers' ? 'Server' : i.profile) : settings?.accountMeta?.[i.profile]?.label ?? i.profile)

  const appRow = (a: LauncherApp): Row => {
    const id = `app:${a.path}`
    return {
      id, title: a.name, icon: <Icon.openTab />, iconPath: a.path, accessory: 'Application',
      actions: [
        { title: 'Open Application', key: 'enter', run: openPath(id, a.path) },
        { title: 'Show in Finder', key: 'cmd+enter', run: reveal(a.path) },
        { title: 'Copy Path', key: 'shift+cmd+c', run: copy(a.path) }
      ]
    }
  }

  const fileRow = (f: Pick<RecentFile, 'name' | 'path' | 'type'>): Row => {
    const id = `file:${f.path}`
    const dir = f.type === 'dir' ? f.path : parentOf(f.path)
    return {
      id, title: f.name, subtitle: tilde(parentOf(f.path), data.home), icon: f.type === 'dir' ? <Icon.folder /> : <Icon.note />, iconPath: f.path, accessory: f.type === 'dir' ? 'Folder' : 'File',
      actions: [
        { title: f.type === 'dir' ? 'Open Folder' : 'Open File', key: 'enter', run: openPath(id, f.path) },
        { title: 'Show in Finder', key: 'cmd+enter', run: reveal(f.path) },
        { title: 'Copy Path', key: 'shift+cmd+c', run: copy(f.path) },
        { title: 'Open in the Finder Tab', key: 'shift+cmd+f', run: inApp(id, { kind: 'finder', path: dir }) },
        { title: 'Open a Terminal Here', key: 'shift+cmd+t', run: inApp(id, { kind: 'terminal', cwd: dir }) }
      ]
    }
  }

  const hostRow = (i: Instance): Row => {
    const id = `host:${i.key}`
    const windows = i.platform === 'windows'
    const address = i.privateIp ?? i.publicIp ?? ''
    const actions: Action[] = [
      { title: windows ? 'Open Remote Desktop' : 'Connect with SSH', key: 'enter', run: inApp(id, { kind: 'connect', key: i.key }) },
      { title: 'Show in Hosts', key: 'cmd+enter', run: inApp(id, { kind: 'reveal', key: i.key }) }
    ]
    if (!i.manual) actions.push({ title: 'Open in the AWS Console', key: 'shift+cmd+o', run: inApp(id, { kind: 'console', profile: i.profile, url: ec2InstanceUrl(i.region, i.instanceId) }) })
    if (address) actions.push({ title: `Copy IP Address (${address})`, key: 'shift+cmd+c', run: copy(address) })
    if (!i.manual) actions.push({ title: 'Copy Instance ID', key: 'shift+cmd+i', run: copy(i.instanceId) })
    return {
      id, title: i.name, subtitle: [accountLabel(i), i.manual ? '' : i.region, address || i.instanceId].filter(Boolean).join(' · '),
      keywords: [i.instanceId, address, i.publicIp, i.profile, accountLabel(i), ...Object.values(i.tags ?? {})].filter(Boolean).join(' '),
      icon: windows ? <Icon.monitor /> : <Icon.terminal />,
      accessory: i.manual || i.state === 'running' ? (settings?.favorites.includes(i.key) ? <Icon.star className="launcher-fav" /> : 'Host') : <span className="launcher-state">{i.state}</span>,
      actions
    }
  }

  const keys = sectionKeys(settings?.shortcuts)
  const appRows: Row[] = useMemo(() => [
    ...RAIL_SECTIONS.map((sec): Row => {
      const SecIcon = SECTION_ICONS[sec]
      const id = `section:${sec}`
      return {
        id, title: SECTION_NAMES[sec], subtitle: SECTION_ABOUT[sec], keywords: SECTION_WORDS[sec], icon: <SecIcon />,
        accessory: keys[sec] ? <kbd className="kbd">{formatCombo(keys[sec])}</kbd> : undefined,
        actions: [{ title: `Open ${SECTION_NAMES[sec]}`, key: 'enter', run: inApp(id, { kind: 'section', section: sec }) }]
      }
    }),
    { id: 'cmd:today', title: 'Today’s Note', subtitle: 'Notes', keywords: 'daily journal obsidian', icon: <Icon.note />, actions: [{ title: 'Open Today’s Note', key: 'enter', run: inApp('cmd:today', { kind: 'today' }) }] },
    { id: 'cmd:scan', title: 'Rescan AWS Accounts', subtitle: 'Hosts', keywords: 'refresh inventory reload', icon: <Icon.refresh />, actions: [{ title: 'Rescan', key: 'enter', run: inApp('cmd:scan', { kind: 'scan' }) }] },
    ...data.profiles.filter((p) => p.enabled && p.kind !== 'static').map((p): Row => {
      const id = `console:${p.name}`
      const label = settings?.accountMeta?.[p.name]?.label ?? p.name
      return {
        id, title: `AWS Console: ${label}`, subtitle: `${p.name} · ${p.region}`, keywords: `aws console ${p.name}`, icon: <Icon.cloud />,
        actions: [
          { title: 'Open Signed In', key: 'enter', run: inApp(id, { kind: 'console', profile: p.name, url: consoleHome(p.region) }) }
        ]
      }
    })
  ], [data, keys.hosts, keys.overview, keys.local, keys.finder, keys.browser, keys.notes, keys.board, keys.claude, keys.chatgpt]) // eslint-disable-line react-hooks/exhaustive-deps

  const query = q.trim()
  const calc = useMemo(() => {
    const v = calculate(query)
    return v === null || formatNumber(v) === query ? null : v
  }, [query])

  // Files by name from Spotlight, below the home folder, once two letters are typed (and it is not a sum).
  useEffect(() => {
    const n = ++fileSeq.current
    if (query.length < 2 || calc !== null || !data.home) { setFiles([]); return }
    const t = setTimeout(() => {
      window.api.invoke('finder:search', query, data.home).then((found) => {
        if (n !== fileSeq.current) return
        const lower = query.toLowerCase()
        const keep = found.filter((f) => !/\/(Library|node_modules)\//.test(f.path))
        const score = (f: RecentFile): number => (f.name.toLowerCase() === lower ? 3 : f.name.toLowerCase().startsWith(lower) ? 2 : 1)
        setFiles(keep.sort((a, b) => score(b) - score(a) || b.lastUsed - a.lastUsed).slice(0, 8))
      }).catch(() => undefined)
    }, 140)
    return () => clearTimeout(t)
  }, [query, calc, data.home])

  const groups: Group[] = useMemo(() => {
    const now = Date.now()
    if (!query) {
      const byId = new Map<string, Row>()
      for (const a of data.apps) byId.set(`app:${a.path}`, appRow(a))
      for (const h of data.hosts) byId.set(`host:${h.key}`, hostRow(h))
      for (const r of appRows) byId.set(r.id, r)
      const recent = recentIds(data.usage, now, 8).map((id) => byId.get(id) ?? (id.startsWith('file:') ? fileRow({ name: id.split('/').pop() ?? id, path: id.slice(5), type: 'file' }) : undefined)).filter((r): r is Row => !!r)
      const favorites = (settings?.favorites ?? []).map((k) => byId.get(`host:${k}`)).filter((r): r is Row => !!r && !recent.includes(r)).slice(0, 5)
      return [
        { title: 'Recent', rows: recent },
        { title: 'Favorite Hosts', rows: favorites },
        { title: 'EC2 Remote Access', rows: appRows.slice(0, RAIL_SECTIONS.length + 2) }
      ].filter((g) => g.rows.length)
    }
    const out: Group[] = []
    if (calc !== null) {
      out.push({ title: 'Calculator', rows: [{
        id: 'calc', title: formatNumber(calc), subtitle: query, icon: <span className="launcher-calc">=</span>, accessory: 'Copy',
        actions: [{ title: 'Copy Answer', key: 'enter', run: copy(String(calc)) }, { title: 'Copy Sum and Answer', key: 'cmd+enter', run: copy(`${query} = ${String(calc)}`) }]
      }] })
    }
    const middle: Group[] = []
    const apps = rankRows(data.apps.map(appRow), query, data.usage, now)
    middle.push({ title: 'Applications', rows: apps.rows.slice(0, 8), best: apps.best })
    const named = rankRows(data.hosts.map(hostRow), query, data.usage, now)
    // Every word of the query in a host's name, IPs, account, region or tags finds it too.
    const more = named.rows.length < 6 ? data.hosts.filter((h) => matchesHost(h, query) && !named.rows.some((r) => r.id === `host:${h.key}`)).map(hostRow) : []
    middle.push({ title: 'Hosts', rows: [...named.rows, ...more].slice(0, 6), best: Math.max(named.best, more.length ? 40 : 0) })
    const inside = rankRows(appRows, query, data.usage, now)
    middle.push({ title: 'EC2 Remote Access', rows: inside.rows.slice(0, 6), best: inside.best })
    middle.push({ title: 'Files', rows: files.map(fileRow), best: files.length ? matchScore(query, files[0].name) : 0 })
    // Groups in the order of their best match (a stable sort keeps this order on ties).
    out.push(...middle.filter((g) => g.rows.length).sort((a, b) => (b.best ?? 0) - (a.best ?? 0)))
    const url = normalizeInput(query)
    const search = url.startsWith('https://www.google.com/search')
    const web: Row[] = []
    if (!search) {
      web.push({ id: 'web:open', title: `Open ${url}`, icon: <Icon.globe />, actions: [{ title: 'Open in Your Browser', key: 'enter', run: external(url) }, { title: 'Open in the Browser Tab', key: 'cmd+enter', run: inApp('web:open', { kind: 'browse', url }) }] })
    }
    const google = `https://www.google.com/search?q=${encodeURIComponent(query)}`
    web.push(
      { id: 'web:google', title: `Search Google for “${query}”`, icon: <Icon.search />, actions: [{ title: 'Search in Your Browser', key: 'enter', run: external(google) }, { title: 'Search in the Browser Tab', key: 'cmd+enter', run: inApp('web:google', { kind: 'browse', url: google }) }] },
      { id: 'ask:claude', title: `Ask Claude: “${query}”`, icon: <Icon.claude />, actions: [{ title: 'Ask in the Claude Tab', key: 'enter', run: inApp('ask:claude', { kind: 'ask', app: 'claude', text: query }) }] },
      { id: 'ask:chatgpt', title: `Ask ChatGPT: “${query}”`, icon: <Icon.chatgpt />, actions: [{ title: 'Ask in the ChatGPT Tab', key: 'enter', run: inApp('ask:chatgpt', { kind: 'ask', app: 'chatgpt', text: query }) }] }
    )
    out.push({ title: 'Search', rows: web })
    return out
  }, [query, data, files, calc, appRows]) // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => groups.flatMap((g) => g.rows), [groups])
  const current = rows[Math.min(sel, rows.length - 1)]
  useEffect(() => setSel(0), [query])

  // Finder's icons for the apps and files on screen.
  useEffect(() => {
    const need = [...new Set(rows.map((r) => r.iconPath).filter((p): p is string => !!p && icons[p] === undefined))]
    if (!need.length) return
    void window.api.invoke('launcher:icons', need).then((found) => {
      setIcons((cur) => ({ ...cur, ...Object.fromEntries(need.map((p) => [p, found[p] ?? ''])) }))
    }).catch(() => undefined)
  }, [rows]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    list.current?.querySelector('.launcher-item.on')?.scrollIntoView({ block: 'nearest' })
  }, [sel, rows])

  const run = (a: Action | undefined): void => {
    if (!a) return
    setPanel(null)
    a.run()
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    const ev = e.nativeEvent
    const actions = current?.actions ?? []
    const move = (step: number, length: number, set: (fn: (n: number) => number) => void): void => {
      e.preventDefault()
      if (length) set((n) => (n + step + length) % length)
    }
    const down = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')
    const up = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')
    if (panel !== null) {
      if (down) return move(1, actions.length, (fn) => setPanel((n) => fn(n ?? 0)))
      if (up) return move(-1, actions.length, (fn) => setPanel((n) => fn(n ?? 0)))
      if (e.key === 'Enter') { e.preventDefault(); return run(actions[panel]) }
      if (e.key === 'Escape' || (e.metaKey && e.key.toLowerCase() === 'k')) { e.preventDefault(); return setPanel(null) }
    }
    if (down) return move(1, rows.length, setSel)
    if (up) return move(-1, rows.length, setSel)
    if (e.key === 'Escape') {
      e.preventDefault()
      if (q) setQ('')
      else hide()
      return
    }
    if (e.metaKey && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      if (actions.length) setPanel(0)
      return
    }
    const combo = comboOf({ code: ev.code, key: ev.key, meta: ev.metaKey, ctrl: ev.ctrlKey, alt: ev.altKey, shift: ev.shiftKey })
    const hit = combo ? actions.find((a) => a.key === combo) : undefined
    if (hit) {
      e.preventDefault()
      run(hit)
    }
  }

  let index = -1
  const primary = current?.actions[0]
  return (
    <div className="launcher-frame" onMouseDown={(e) => { if (e.target === e.currentTarget) hide() }}>
      <div className="launcher" role="dialog" aria-label="Launcher">
        <div className="launcher-search">
          <Icon.search className="launcher-search-icon" />
          <input
            ref={input}
            autoFocus
            spellCheck={false}
            aria-label="Search apps, files, hosts and commands"
            placeholder="Search apps, files, hosts and commands…"
            value={q}
            onChange={(e) => { setQ(e.target.value); setPanel(null) }}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="launcher-list" ref={list}>
          {groups.map((g) => (
            <div key={g.title} role="group" aria-label={g.title}>
              <div className="launcher-group">{g.title}</div>
              {g.rows.map((r) => {
                const at = ++index
                const img = r.iconPath ? icons[r.iconPath] : ''
                return (
                  <div
                    key={`${g.title}:${r.id}`}
                    role="option"
                    aria-selected={at === sel}
                    className={`launcher-item ${at === sel ? 'on' : ''}`}
                    onMouseMove={() => { if (sel !== at) setSel(at) }}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => run(r.actions[0])}
                  >
                    <span className="launcher-icon">{img ? <img src={img} alt="" /> : r.icon}</span>
                    <span className="launcher-title">{r.title}</span>
                    {r.subtitle && <span className="launcher-sub">{r.subtitle}</span>}
                    {r.accessory && <span className="launcher-acc">{r.accessory}</span>}
                  </div>
                )
              })}
            </div>
          ))}
          {!rows.length && <div className="launcher-empty">Loading…</div>}
        </div>
        <div className="launcher-foot">
          <span className="launcher-brand"><span className="brand-mark launcher-mark">&gt;_</span>EC2 Remote Access</span>
          <span className="flex-1" />
          {primary && <span className="launcher-hint">{primary.title} <kbd className="kbd">↩</kbd></span>}
          {current && current.actions.length > 1 && <span className="launcher-hint">Actions <kbd className="kbd">⌘K</kbd></span>}
        </div>
        {panel !== null && current && (
          <div className="launcher-actions" role="menu" aria-label="Actions" style={{ '--n': current.actions.length } as CSSProperties}>
            <div className="launcher-actions-title">{current.title}</div>
            {current.actions.map((a, n) => (
              <div key={a.title} role="menuitem" className={`launcher-action ${n === panel ? 'on' : ''}`} onMouseMove={() => setPanel(n)} onMouseDown={(e) => e.preventDefault()} onClick={() => run(a)}>
                <span>{a.title}</span>
                {a.key && <kbd className="kbd">{a.key === 'enter' ? '↩' : formatCombo(a.key)}</kbd>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

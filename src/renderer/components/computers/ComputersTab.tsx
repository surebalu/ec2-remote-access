import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { ComputerReach, Instance } from '@shared/types'
import { cardTone, computerLabel, libraryGroups } from '@shared/computers'
import { defaultSessionFor } from '@shared/tailnet'
import { matchesHost } from '@shared/hostSearch'
import { allInstances, routeOf, useStore, type Tab } from '../../store'
import { openDefaultFor, openFilesFor, openRdpFor, openScreenFor, openSshFor } from '../../quickConnect'
import { isMobile } from '../../mobile'
import { Icon } from '../icons'
import Popover, { MenuItem, MenuSep } from '../Popover'
import Sheet, { SheetItem } from '../mobile/Sheet'
import './computers.css'

/**
 * Computers: the machines you reach on screen, as a library of cards the way a screen-sharing app shows them. The
 * tailnet's machines first, then hand-added servers and starred hosts. A card shows the last picture of that screen
 * (saved by VncTab/RdpTab through `computers:saveThumb`), or a colour by what the machine is, and whether it answers
 * right now (`computers:probe`). Opening one does what its host does (a Mac's screen, Remote Desktop, SSH).
 */

type View = 'library' | 'recent'
const NO_THUMBS: Record<string, { image: string; at: number }> = {}

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null
    if (v && allowed.includes(v)) return v
  } catch { /* storage unavailable */ }
  return fallback
}
function writePref(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* storage unavailable */ }
}

const SESSION_NAME = { vnc: 'Share screen', rdp: 'Remote desktop', ssh: 'SSH terminal' } as const

export default function ComputersTab({ active }: { tab: Tab; active: boolean }): ReactElement {
  const s = useStore()
  const mobile = isMobile()
  const [view, setViewState] = useState<View>(() => readPref('ui.computers.view', ['library', 'recent'] as const, 'library'))
  const [layout, setLayoutState] = useState<'grid' | 'list'>(() => readPref('ui.computers.layout', ['grid', 'list'] as const, 'grid'))
  const [query, setQuery] = useState('')
  const [thumbs, setThumbs] = useState(NO_THUMBS)
  const [reach, setReach] = useState<Record<string, ComputerReach>>({})
  const [probing, setProbing] = useState(false)
  const [menu, setMenu] = useState<{ key: string; anchor: HTMLElement | null } | null>(null)
  const [more, setMore] = useState<HTMLElement | null>(null)
  const setView = (v: View): void => { setViewState(v); writePref('ui.computers.view', v) }
  const setLayout = (v: 'grid' | 'list'): void => { setLayoutState(v); writePref('ui.computers.layout', v) }

  const hosts = allInstances(s)
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const shown = q ? hosts.filter((h) => matchesHost(h, q) || computerLabel(h.name).toLowerCase().includes(q)) : hosts
    return libraryGroups(shown, s.settings?.favorites ?? [])
  }, [s.instances, s.tailnet, s.settings, query]) // eslint-disable-line react-hooks/exhaustive-deps
  const recent = useMemo(() => s.recentHosts.map((k) => hosts.find((h) => h.key === k)).filter((h): h is Instance => !!h), [s.recentHosts, s.instances, s.tailnet, s.settings]) // eslint-disable-line react-hooks/exhaustive-deps
  const keysRef = useRef<string[]>([])
  keysRef.current = groups.flatMap((g) => g.hosts.map((h) => h.key))

  const refresh = async (full = false): Promise<void> => {
    setProbing(true)
    try {
      if (full) await s.refreshTailnet(true)
      const [t, r] = await Promise.all([
        window.api.invoke('computers:thumbs').catch(() => NO_THUMBS),
        window.api.invoke('computers:probe', keysRef.current).catch(() => ({}))
      ])
      setThumbs(t)
      setReach(r)
    } finally {
      setProbing(false)
    }
  }
  // Read while shown: on opening, every minute, and when a session ends (a new picture to show).
  useEffect(() => {
    if (!active) return
    void refresh()
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 60_000)
    return () => clearInterval(timer)
  }, [active]) // eslint-disable-line react-hooks/exhaustive-deps
  const sessionCount = s.tabs.filter((t) => t.kind === 'vnc' || t.kind === 'rdp').length
  useEffect(() => { if (active) void window.api.invoke('computers:thumbs').then(setThumbs, () => undefined) }, [sessionCount]) // eslint-disable-line react-hooks/exhaustive-deps

  const open = (h: Instance): void => {
    const live = s.tabs.find((t) => t.instanceKey === h.key && (t.kind === 'vnc' || t.kind === 'rdp' || t.kind === 'ssh') && !t.transient)
    if (live) { s.setActive(live.id); return }
    const r = routeOf(h, s.settings).route
    if (r !== 'direct' && r !== 'ssm') { s.toast('info', `${computerLabel(h.name)} is offline.`); return }
    openDefaultFor(h.key)
  }
  const menuHost = menu ? hosts.find((h) => h.key === menu.key) : undefined
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressed = useRef(false)

  const status = (h: Instance): ReactElement => {
    const r = reach[h.key]
    if (probing && !r) return <span className="cmp-spinner" aria-label="Checking" />
    const state = r ?? (h.tailnet && !h.tailnet.online ? 'offline' : undefined)
    if (!state) return <span />
    const label = state === 'open' ? 'Answers' : state === 'closed' ? 'Not answering on its port' : state === 'tunnel' ? 'Through SSM' : 'Offline'
    return <span className={`cmp-dot ${state}`} title={label} aria-label={label} />
  }

  const card = (h: Instance): ReactElement => {
    const thumb = thumbs[h.key]?.image
    const offline = reach[h.key] === 'offline' || (!!h.tailnet && !h.tailnet.online)
    return (
      <button
        key={h.key}
        type="button"
        className={`cmp-card ${thumb ? 'has-thumb' : ''} ${offline ? 'off' : ''}`}
        data-tone={cardTone(h)}
        data-key={h.key}
        style={thumb ? { backgroundImage: `url(${thumb})` } : undefined}
        title={`${h.name} · ${h.publicIp ?? h.privateIp ?? h.instanceId}\n${SESSION_NAME[defaultSessionFor(h)]} · right-click or hold for more`}
        onClick={() => { if (longPressed.current) { longPressed.current = false; return } open(h) }}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ key: h.key, anchor: e.currentTarget }) }}
        onPointerDown={(e) => {
          if (e.pointerType !== 'touch') return
          const el = e.currentTarget
          pressTimer.current = setTimeout(() => { longPressed.current = true; setMenu({ key: h.key, anchor: el }) }, 500)
        }}
        onPointerUp={() => { if (pressTimer.current) clearTimeout(pressTimer.current) }}
        onPointerLeave={() => { if (pressTimer.current) clearTimeout(pressTimer.current) }}
      >
        <span className="cmp-status">{status(h)}</span>
        {h.tailnet?.self && <span className="cmp-this">This computer</span>}
        <span className="cmp-name">{computerLabel(h.name)}</span>
      </button>
    )
  }

  const row = (h: Instance, onRemove?: () => void): ReactElement => (
    <div key={h.key} className="cmp-row">
      <button type="button" className="cmp-row-main" data-key={h.key} onClick={() => open(h)} onContextMenu={(e) => { e.preventDefault(); setMenu({ key: h.key, anchor: e.currentTarget }) }}>
        <span className="cmp-row-icon" data-tone={cardTone(h)}>{h.tailnet?.os === 'macOS' ? <Icon.laptop /> : h.platform === 'windows' ? <Icon.windows /> : <Icon.linux />}</span>
        <span className="min-w-0 flex-1 truncate text-left">{computerLabel(h.name)}</span>
        {status(h)}
      </button>
      {onRemove && <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label={`Remove ${h.name} from recents`} onClick={onRemove}><Icon.x /></button>}
    </div>
  )

  const clearRecent = (): void => {
    s.set({ recentHosts: [] })
    try { localStorage.setItem('ui.recentHosts', '[]') } catch { /* storage unavailable */ }
  }
  const removeRecent = (key: string): void => {
    const next = s.recentHosts.filter((k) => k !== key)
    s.set({ recentHosts: next })
    try { localStorage.setItem('ui.recentHosts', JSON.stringify(next)) } catch { /* storage unavailable */ }
  }

  const actions = (h: Instance, close: () => void, Item: (p: { icon: ReactElement; label: string; run: () => void; disabled?: boolean }) => ReactElement): ReactElement => {
    const reachable = ['direct', 'ssm'].includes(routeOf(h, s.settings).route)
    const run = (fn: () => void) => () => { close(); fn() }
    return (
      <>
        {(h.platform !== 'windows' || h.tailnet?.os === 'macOS') && <Item icon={<Icon.screenShare />} label="Share screen" disabled={!reachable} run={run(() => void openScreenFor(h.key))} />}
        {h.platform === 'windows' && <Item icon={<Icon.monitor />} label="Remote desktop" disabled={!reachable} run={run(() => void openRdpFor(h.key))} />}
        {h.platform === 'windows' && <Item icon={<Icon.screenShare />} label="Share screen (VNC)" disabled={!reachable} run={run(() => void openScreenFor(h.key))} />}
        <Item icon={<Icon.terminal />} label="SSH terminal" disabled={!reachable} run={run(() => openSshFor(h.key))} />
        <Item icon={<Icon.folder />} label="Files" disabled={!reachable} run={run(() => openFilesFor(h.key))} />
        <Item icon={<Icon.info />} label="Details" run={run(() => s.revealHost(h.key))} />
      </>
    )
  }

  return (
    <div className={`computers ${mobile ? 'is-mobile' : ''}`}>
      <header className="cmp-head">
        <div className="min-w-0">
          <h1>Computers</h1>
          <p className="muted">{s.tailnet?.running ? `Tailnet ${s.tailnet.tailnet ?? ''}` : s.tailnet?.installed ? 'Tailscale is not connected on this computer.' : 'Machines you reach on screen'}</p>
        </div>
        <div className="cmp-pill" role="toolbar" aria-label="Computers">
          <button type="button" aria-label={layout === 'grid' ? 'Show as a list' : 'Show as cards'} title={layout === 'grid' ? 'List' : 'Cards'} onClick={() => setLayout(layout === 'grid' ? 'list' : 'grid')}>
            {layout === 'grid' ? <Icon.list /> : <Icon.grid />}
          </button>
          <button type="button" aria-label="Check again" title="Read the tailnet and check every computer again" onClick={() => void refresh(true)}>
            <Icon.refresh className={probing ? 'animate-spin' : ''} />
          </button>
          <button type="button" aria-label="More" title="More" onClick={(e) => setMore(more ? null : e.currentTarget)}><Icon.more /></button>
        </div>
      </header>

      <div className="cmp-bar">
        <div className="cmp-segment" role="tablist" aria-label="View">
          <button type="button" role="tab" aria-selected={view === 'library'} className={view === 'library' ? 'on' : ''} onClick={() => setView('library')}>Library</button>
          <button type="button" role="tab" aria-selected={view === 'recent'} className={view === 'recent' ? 'on' : ''} onClick={() => setView('recent')}>Recent</button>
        </div>
        <label className="cmp-search">
          <Icon.search className="muted" />
          <input type="search" placeholder="Search for a computer" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={query} onChange={(e) => { setQuery(e.target.value); if (view !== 'library') setView('library') }} />
        </label>
      </div>

      <div className="cmp-body">
        {view === 'library' && groups.map((g) => (
          <section key={g.id} className="cmp-group">
            <h2>{g.title}<span className="muted mono">{g.hosts.length}</span></h2>
            {layout === 'grid' ? <div className="cmp-grid">{g.hosts.map(card)}</div> : <div className="cmp-list">{g.hosts.map((h) => row(h))}</div>}
          </section>
        ))}
        {view === 'library' && !groups.length && (
          <div className="cmp-empty">
            <Icon.search />
            <p>{query ? 'No computer matches.' : 'No computers yet. Machines on your Tailscale network, servers you add and hosts you star appear here.'}</p>
          </div>
        )}
        {view === 'recent' && (recent.length ? (
          <section className="cmp-group">
            <h2>Recent connections</h2>
            <div className="cmp-list">
              {recent.map((h) => row(h, () => removeRecent(h.key)))}
              <button type="button" className="cmp-clear" onClick={clearRecent}><Icon.x /> Clear all</button>
            </div>
          </section>
        ) : (
          <div className="cmp-empty"><Icon.history /><p>Computers you connect to appear here.</p></div>
        ))}
      </div>

      {more && (
        <Popover anchor={more} align="right" width={240} onClose={() => setMore(null)}>
          <MenuItem onClick={() => { setMore(null); void refresh(true) }}>Check every computer again</MenuItem>
          <MenuItem onClick={() => { setMore(null); s.setActive('hosts') }}>Open the hosts list</MenuItem>
          <MenuSep />
          <MenuItem onClick={() => { setMore(null); s.set({ settingsOpen: true }) }}>Settings…</MenuItem>
        </Popover>
      )}
      {menu && menuHost && (mobile ? (
        <Sheet title={computerLabel(menuHost.name)} subtitle={<span className="mono">{menuHost.publicIp ?? menuHost.privateIp ?? menuHost.instanceId}</span>} onClose={() => setMenu(null)}>
          {actions(menuHost, () => setMenu(null), ({ icon, label, run, disabled }) => <SheetItem key={label} icon={icon} disabled={disabled} onClick={run}>{label}</SheetItem>)}
        </Sheet>
      ) : (
        <Popover anchor={menu.anchor} width={220} onClose={() => setMenu(null)}>
          {actions(menuHost, () => setMenu(null), ({ label, run, disabled }) => <MenuItem key={label} disabled={disabled} onClick={run}>{label}</MenuItem>)}
        </Popover>
      ))}
    </div>
  )
}

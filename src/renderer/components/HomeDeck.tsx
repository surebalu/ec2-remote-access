import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import type { Instance } from '@shared/types'
import { ago, ENV_NAMES, type Level, type PlmEnvId, type PlmHealthSnapshot } from '@shared/plmHealth'
import { rank } from '@shared/usage'
import { allInstances, isSession, routeOf, TOOL_NAMES, useStore, visibleInstances, type ToolKind } from '../store'
import { hasBrowser, openDefaultFor } from '../quickConnect'
import { metaFor } from '../colors'
import { sectionKeyLabel } from '../shortcuts'
import { LOOKS, lookVars } from '../toolLooks'
import { readUsage, USAGE_EVENT } from '../toolUsage'
import { mayPoll } from './health/poll'
import { Icon } from './icons'

/**
 * The top of the Hosts page, a command centre to get to work from in one click: a greeting with the fleet at a glance
 * and live status (sessions, the AWS sign-in, tunnels), quick actions, the hosts to jump back into, the tools you use
 * most (ordered by use, toolUsage.ts) and the platform's health per environment. Folds to its first line.
 */

const FOLD_KEY = 'ui.home.folded'
const TOOLS: ToolKind[] = ['health', 'local', 'browser', 'notes', 'claude', 'chatgpt', 'board', 'finder']
const readFolded = (): boolean => { try { return localStorage.getItem(FOLD_KEY) === '1' } catch { return false } }

/** The platform's health for the home page: read now and every two minutes while the page is in front. */
let glance: { at: number; snap: PlmHealthSnapshot | null; error: string | null } | null = null
function useHealthGlance(on: boolean): typeof glance {
  const [g, setG] = useState(glance)
  useEffect(() => {
    if (!on) return
    let gone = false
    const load = (): void => {
      window.api.invoke('health:snapshot').then(
        (snap) => { glance = { at: Date.now(), snap, error: null } },
        (e: Error) => { glance = { at: Date.now(), snap: glance?.snap ?? null, error: e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') } }
      ).finally(() => { if (!gone) setG(glance) })
    }
    if (!glance || Date.now() - glance.at > 60_000) load()
    const t = setInterval(() => { if (mayPoll()) load() }, 120_000)
    return () => { gone = true; clearInterval(t) }
  }, [on])
  return g
}

const greeting = (h: number): string => (h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening')

export default function HomeDeck(): ReactElement {
  const s = useStore()
  const [folded, setFolded] = useState(readFolded)
  const [usage, setUsage] = useState(readUsage)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const u = (): void => setUsage(readUsage())
    window.addEventListener(USAGE_EVENT, u)
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => { window.removeEventListener(USAGE_EVENT, u); clearInterval(t) }
  }, [])
  const fold = (v: boolean): void => { setFolded(v); try { localStorage.setItem(FOLD_KEY, v ? '1' : '0') } catch { /* storage off */ } }

  const hosts = visibleInstances(s)
  const all = allInstances(s)
  const running = hosts.filter((h) => h.state === 'running').length
  const reachable = hosts.filter((h) => ['ssm', 'direct'].includes(routeOf(h, s.settings).route)).length
  const sessions = s.tabs.filter((t) => isSession(t) && !t.transient)
  const live = sessions.filter((t) => t.status === 'connected').length
  const auth = s.authState()
  const front = s.gridView ? undefined : s.tabs.find((t) => t.id === s.activeTab)
  // The platform card reads Prometheus through SSM, so only for someone who uses Health (or has set its source).
  const wantsHealth = (usage.health?.n ?? 0) > 0 || s.tabs.some((t) => t.kind === 'health') || !!s.settings?.healthSource
  const health = useHealthGlance(wantsHealth && !folded && !s.gridView && s.activeTab === 'hosts')
  const tools = useMemo(() => rank(TOOLS.filter((t) => hasBrowser() || (t !== 'local' && t !== 'finder')), usage, now), [usage, now])
  const date = new Date(now)

  const chip = (o: { key: string; level: Level | 'info'; icon: ReactNode; text: string; title: string; onClick?: () => void }): ReactElement => (
    <button key={o.key} type="button" className={`hd-chip lvl-${o.level === 'info' ? 'ok' : o.level} ${o.level === 'info' ? 'info' : ''}`} title={o.title} onClick={o.onClick} disabled={!o.onClick}>
      <span className="hd-chip-dot" />{o.icon}<span>{o.text}</span>
    </button>
  )
  const chips: ReactElement[] = []
  if (sessions.length) {
    chips.push(chip({ key: 'sessions', level: live ? 'ok' : 'unknown', icon: <Icon.grid />, text: `${live} of ${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'} live`, title: 'All sessions on one page (⌘0)', onClick: () => s.showGrid(true) }))
  }
  chips.push(auth.kind === 'ok'
    ? chip({ key: 'aws', level: 'ok', icon: <Icon.cloud />, text: 'AWS signed in', title: 'Every SSO account is signed in' })
    : chip({ key: 'aws', level: auth.kind === 'expired' ? 'crit' : 'warn', icon: <Icon.key />, text: auth.kind === 'expired' ? 'Sign in to AWS' : `Sign-in ends in ${auth.minutesLeft} min`, title: `${auth.profiles.join(', ')}: sign in again`, onClick: () => void s.refreshToken() }))
  if (s.tunnels.length) {
    chips.push(chip({ key: 'tunnels', level: 'info', icon: <Icon.plug />, text: `${s.tunnels.length} ${s.tunnels.length === 1 ? 'tunnel' : 'tunnels'}`, title: s.tunnels.map((t) => `${t.title} → localhost:${t.localPort}`).join('\n') }))
  }

  const action = (key: string, icon: ReactNode, label: string, run: () => void, disabled = false): ReactElement => (
    <button key={key} type="button" className="hd-action" onClick={run} disabled={disabled} title={label}>{icon}<span>{label}</span></button>
  )
  const runnable = hosts.filter((h) => !h.manual && h.state === 'running' && h.ssmOnline).map((h) => h.key)

  return (
    <section className={`home-deck ${folded ? 'folded' : ''}`} aria-label="Home">
      <div className="hd-aurora" aria-hidden="true" />
      <header className="hd-top">
        <div className="hd-hello min-w-0">
          <h1>{greeting(date.getHours())}</h1>
          <p>
            {date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}
            <span className="hd-sep" />
            <strong>{running}</strong> of {hosts.length} hosts running
            <span className="hd-sep" />
            <strong>{reachable}</strong> reachable
            {all.length !== hosts.length && <span className="muted"> · {all.length - hosts.length} hidden by filters</span>}
          </p>
        </div>
        <div className="hd-status">
          {chips}
          <button type="button" className="hd-btn" disabled={s.scanning} onClick={() => void s.scan()} title="Scan every account again"><Icon.refresh className={s.scanning ? 'animate-spin' : ''} /><span>{s.scanning ? 'Refreshing…' : 'Refresh'}</span></button>
          <button type="button" className="hd-btn primary" onClick={() => s.set({ manualHostEditor: 'new' })} title="Add a server outside AWS"><Icon.plus /><span>Add server</span></button>
          <button type="button" className="hd-fold" aria-expanded={!folded} aria-label={folded ? 'Show the home panel' : 'Fold the home panel'} title={folded ? 'Show the home panel' : 'Fold the home panel'} onClick={() => fold(!folded)}><Icon.caret /></button>
        </div>
      </header>

      {!folded && (
        <>
          <div className="hd-dock">
            <div className="hd-tool-row" role="group" aria-label="Your tools, most used first">
              {tools.map((t) => {
                const open = s.tabs.some((x) => x.kind === t)
                const key = sectionKeyLabel(t, s.settings?.shortcuts)
                const prod = t === 'health' ? health?.snap?.envs.find((e) => e.id === 'prod') ?? health?.snap?.envs[0] : undefined
                return (
                  <button key={t} type="button" className={`hd-tool ${front?.kind === t ? 'here' : ''}`} title={`${TOOL_NAMES[t]}${key ? ` (${key})` : ''}`} onClick={() => s.openTool(t)}>
                    <span className="hd-squircle" style={lookVars(LOOKS[t].hue)}>
                      {LOOKS[t].icon()}
                      {prod ? <i className={`hd-badge lvl-${prod.level}`} /> : open ? <i className="hd-badge open" /> : null}
                    </span>
                    <span className="hd-tool-name">{TOOL_NAMES[t]}</span>
                  </button>
                )
              })}
            </div>
            <span className="hd-dock-sep" aria-hidden="true" />
            <div className="hd-actions" role="group" aria-label="Quick actions">
              {action('run', <Icon.broadcast />, 'Run command', () => s.set({ runCommandFor: { keys: runnable } }), !runnable.length)}
              {action('forward', <Icon.plug />, 'Forward a port', () => s.set({ portForwardFor: {} }))}
              {action('today', <Icon.note />, "Today's note", () => void window.api.invoke('notes:daily').then((p) => s.openNotes(p), (e: Error) => s.toast('error', e.message)))}
              {action('workspace', <Icon.grid />, 'Save workspace', () => s.set({ workspaceSaveOpen: true }), !s.tabs.length)}
            </div>
          </div>
          <div className="hd-row">
            <JumpBackIn />
            <Platform health={wantsHealth ? health : null} now={now} />
          </div>
        </>
      )}
    </section>
  )
}

/** Recent connections and favorites; a card returns to a live session rather than opening another. */
function JumpBackIn(): ReactElement {
  const s = useStore()
  const hosts = visibleInstances(s)
  const byKey = new Map(hosts.map((h) => [h.key, h]))
  const quick = [...new Set([...s.recentHosts, ...(s.settings?.favorites ?? [])])]
    .map((key) => byKey.get(key)).filter((h): h is Instance => !!h && h.state !== 'terminated').slice(0, 4)
  const sessions = s.tabs.filter(isSession)
  const hasRecent = quick.some((h) => s.recentHosts.includes(h.key))
  return (
    <section className="hd-card hd-jump host-quick-access" aria-label="Quick access hosts">
      <div className="hd-card-head"><span><Icon.history />{hasRecent ? 'Jump back in' : 'Quick access'}</span><span className="muted">Recent connections and favorites</span></div>
      {quick.length ? (
        <div className="hd-jump-grid">
          {quick.map((h) => {
            const tab = sessions.find((t) => t.instanceKey === h.key && t.status === 'connected') ?? sessions.find((t) => t.instanceKey === h.key && t.status === 'connecting')
            const canConnect = ['ssm', 'direct'].includes(routeOf(h, s.settings).route)
            const act = tab ? `Return to ${tab.kind.toUpperCase()}` : canConnect ? `Connect ${h.platform === 'windows' ? 'RDP' : 'SSH'}` : 'View details'
            const account = metaFor(h.manual ? `group:${h.region}` : h.profile, s.settings)
            return (
              <button key={h.key} type="button" className="quick-host-card hd-host" data-accent={account.color} aria-label={`${act}: ${h.name}`} title={`${h.name} · ${account.label} · ${h.region}`}
                onClick={() => (tab ? s.setActive(tab.id) : canConnect ? openDefaultFor(h.key) : s.revealHost(h.key))}>
                <span className="hd-host-icon">{h.platform === 'windows' ? <Icon.monitor /> : <Icon.terminal />}{tab && <i className="hd-live" />}</span>
                <span className="hd-host-text">
                  <strong>{h.name}</strong>
                  <span>{account.label} · {h.region}{h.staleReason ? ' · Cached' : ''}</span>
                </span>
                <span className="hd-host-go">{act}</span>
              </button>
            )
          })}
        </div>
      ) : <p className="hd-empty">Connect to a host, or star one, and it waits here.</p>}
    </section>
  )
}

/** Each environment's verdict from the Health tab; a click opens Health on that environment. */
function Platform({ health, now }: { health: ReturnType<typeof useHealthGlance> | null; now: number }): ReactElement {
  const s = useStore()
  const open = (env?: PlmEnvId): void => {
    if (env) {
      try { localStorage.setItem('ui.health.env', env) } catch { /* storage off */ }
      window.dispatchEvent(new CustomEvent('ec2ra:health-env', { detail: env }))
    }
    s.openTool('health')
  }
  const envs = health?.snap?.envs ?? []
  return (
    <section className="hd-card hd-platform" aria-label="Platform health">
      <div className="hd-card-head"><span><Icon.health />Platform</span><span className="muted">{health?.snap ? `Updated ${ago(health.snap.at, now)}` : '3DEXPERIENCE'}</span></div>
      {envs.length ? (
        <div className="hd-envs">
          {envs.map((e) => {
            const n = e.issues.filter((i) => i.level === 'crit' || i.level === 'warn').length
            return (
              <button key={e.id} type="button" className={`hd-env lvl-${e.level}`} onClick={() => open(e.id)} title={`${e.name}: ${e.headline}`}>
                <i className="hd-env-dot" />
                <span className="hd-env-name">{ENV_NAMES[e.id] ?? e.name}</span>
                <span className="hd-env-line">{e.headline}</span>
                <span className="hd-env-count">{n || '✓'}</span>
              </button>
            )
          })}
        </div>
      ) : (
        <button type="button" className="hd-empty hd-empty-btn" onClick={() => open()}>
          {health?.error ? `Health could not be read: ${health.error}` : health ? 'Reading the platform…' : 'Open Health to see Production, QA and Development here.'}
        </button>
      )}
    </section>
  )
}

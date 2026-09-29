import { useEffect, useState, type ReactElement } from 'react'
import { useStore, type Tab } from '../../store'
import { nativeApp, postNative, setLayoutPreference, trackVisualViewport } from '../../mobile'
import { SessionPanes } from '../TerminalTabs'
import AuthBanner from '../AuthBanner'
import { Icon } from '../icons'
import MobileHosts from './MobileHosts'
import Sheet, { SheetItem } from './Sheet'

type View = 'hosts' | 'sessions' | 'more'

const dotFor = (st: Tab['status']): string => (st === 'connected' ? 'var(--ok)' : st === 'connecting' ? 'var(--warn)' : st === 'error' ? 'var(--err)' : 'var(--muted)')
const kindIcon = (t: Tab): ReactElement => (t.kind === 'rdp' ? <Icon.monitor /> : t.kind === 'sftp' ? <Icon.folder /> : <Icon.terminal />)
const kindLabel = (t: Tab): string => (t.kind === 'rdp' ? 'Remote desktop' : t.kind === 'sftp' ? 'Files' : 'Terminal')

const LIST_HIDDEN_KEY = 'ui.mobileListHidden'

/** Unfolded foldables and tablets: list and session side by side. Phones in landscape are too short for it. */
const WIDE_QUERY = '(min-width: 700px) and (min-height: 500px)'
function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE_QUERY).matches)
  useEffect(() => {
    const mq = window.matchMedia(WIDE_QUERY)
    const on = (): void => setWide(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return wide
}

/**
 * Touch shell around the same store and session components as the desktop window. On a phone, list views (hosts,
 * sessions, more) sit above a bottom tab bar and an open session is full screen with a back button. On a wide screen
 * (an unfolded foldable, a tablet) the list stays on the left and the session fills the right.
 *
 * The side column and the stage are always both in the tree and only CSS decides which shows, so folding or unfolding
 * never remounts SessionPanes: terminals and desktops stay connected and just resize.
 */
export default function MobileApp(): ReactElement {
  const s = useStore()
  const [view, setView] = useState<View>('hosts')
  const [switcher, setSwitcher] = useState(false)
  const wide = useWide()
  const active = s.tabs.find((t) => t.id === s.activeTab)
  // Wide screens: the session can take the whole width. Remembered, but the list always shows when nothing is open.
  const [listHidden, setListHidden] = useState(() => { try { return localStorage.getItem(LIST_HIDDEN_KEY) === '1' } catch { return false } })
  const toggleList = (): void => {
    const next = !listHidden
    setListHidden(next)
    try { localStorage.setItem(LIST_HIDDEN_KEY, next ? '1' : '0') } catch { /* storage unavailable */ }
  }
  const fullSession = wide && listHidden && !!active

  useEffect(() => trackVisualViewport(), [])
  // The iPhone app keeps the screen awake while sessions are open, so a terminal left running doesn't lock the phone.
  useEffect(() => postNative({ type: 'sessions', count: s.tabs.length }), [s.tabs.length])
  useEffect(() => {
    document.documentElement.toggleAttribute('data-mobile-session', !!active)
    return () => document.documentElement.removeAttribute('data-mobile-session')
  }, [active])

  const title = view === 'hosts' ? 'Hosts' : view === 'sessions' ? 'Sessions' : 'More'
  return (
    <div className={`m-app ${wide ? 'wide' : ''} ${active ? 'has-session' : ''} ${fullSession ? 'list-hidden' : ''}`}>
      <aside className="m-side">
        <header className="m-header">
          <h1>{title}</h1>
          {view === 'hosts' && (
            <button className="m-header-btn" disabled={s.scanning} aria-label="Rescan" onClick={() => void s.scan()}>
              <Icon.refresh className={s.scanning ? 'animate-spin' : ''} />
            </button>
          )}
        </header>
        <AuthBanner />
        <div className="m-scroll">
          {view === 'hosts' && <MobileHosts />}
          {view === 'sessions' && <MobileSessions />}
          {view === 'more' && <MobileMore />}
        </div>
        <nav className="m-tabbar" aria-label="Sections">
          <button className={view === 'hosts' ? 'on' : ''} onClick={() => setView('hosts')}><Icon.cloud /><span>Hosts</span></button>
          <button className={view === 'sessions' ? 'on' : ''} onClick={() => setView('sessions')}>
            <span className="relative"><Icon.layers />{s.tabs.length > 0 && <span className="m-badge">{s.tabs.length}</span>}</span><span>Sessions</span>
          </button>
          <button className={view === 'more' ? 'on' : ''} onClick={() => setView('more')}><Icon.more /><span>More</span></button>
        </nav>
      </aside>
      <section className="m-stage">
        {active ? (
          <header className="m-header m-session-header">
            {wide && (
              <button className="m-header-btn" aria-label={fullSession ? 'Show host list' : 'Full screen session'} aria-pressed={fullSession} onClick={toggleList}>
                <Icon.panelRight filled={!fullSession} className="-scale-x-100" />
              </button>
            )}
            {!wide && (
              <button className="m-back" onClick={() => { s.setActive('hosts'); setView('sessions') }} aria-label="Back to sessions">
                <Icon.chevron className="rotate-180" /> <span>Sessions</span>
              </button>
            )}
            <div className="m-session-title">
              <span className="dot" style={{ background: dotFor(active.status), animation: active.status === 'connecting' ? 'pulse 1.2s infinite' : undefined }} />
              <span className="truncate">{active.title.replace(/ @ .*/, '')}</span>
              {active.status === 'connected' && active.route && <span className={`m-route ${active.route}`}>{active.route === 'ssm' ? 'SSM' : 'DIR'}</span>}
            </div>
            <button className="m-header-btn" aria-label="Switch session" onClick={() => setSwitcher(true)}>
              <Icon.layers /><span className="mono">{s.tabs.length}</span>
            </button>
          </header>
        ) : (
          <div className="m-stage-empty">
            <Icon.monitor />
            <p>Pick a host to open a terminal, remote desktop or files.</p>
          </div>
        )}
        <main className="m-main">
          <SessionPanes />
          {wide && active && (
            <button className="m-divider-toggle" aria-label={fullSession ? 'Show host list' : 'Hide host list'} onClick={toggleList}>
              <Icon.chevron className={fullSession ? '' : 'rotate-180'} />
            </button>
          )}
        </main>
      </section>
      {switcher && (
        <Sheet title="Sessions" onClose={() => setSwitcher(false)}>
          {s.tabs.map((t) => (
            <SheetItem key={t.id} icon={kindIcon(t)} hint={<span className="dot" style={{ background: dotFor(t.status) }} />} onClick={() => { setSwitcher(false); s.setActive(t.id) }}>
              {t.title.replace(/ @ .*/, '')} <span className="muted">· {kindLabel(t)}</span>
            </SheetItem>
          ))}
          <SheetItem icon={<Icon.cloud />} onClick={() => { setSwitcher(false); s.setActive('hosts'); setView('hosts') }}>Open another host…</SheetItem>
        </Sheet>
      )}
    </div>
  )
}

function MobileSessions(): ReactElement {
  const s = useStore()
  if (!s.tabs.length && !s.tunnels.length) {
    return <div className="m-empty"><p>No open sessions. Pick a host to start a terminal, desktop or file browser.</p></div>
  }
  return (
    <div className="m-list-page">
      {s.tabs.length > 0 && <h3 className="m-group-title">Open sessions</h3>}
      <div className="m-card-list">
        {s.tabs.map((t) => (
          <div key={t.id} className={`m-host ${s.activeTab === t.id ? 'on' : ''}`} role="button" tabIndex={0} onClick={() => s.setActive(t.id)}>
            <span className="m-host-os">{kindIcon(t)}</span>
            <span className="min-w-0 flex-1 text-left">
              <span className="m-host-name"><span className="dot mr-1.5" style={{ background: dotFor(t.status) }} />{t.title.replace(/ @ .*/, '')}</span>
              <span className="m-host-meta">{kindLabel(t)} · {t.message ?? t.status}</span>
            </span>
            <button className="m-row-close" aria-label={`Close ${t.title}`} onClick={(e) => { e.stopPropagation(); void s.closeTab(t.id) }}><Icon.x /></button>
          </div>
        ))}
      </div>
      {s.tunnels.length > 0 && (
        <>
          <h3 className="m-group-title">Port forwards (on the host computer)</h3>
          <div className="m-card-list">
            {s.tunnels.map((t) => (
              <div key={t.id} className="m-host">
                <span className="m-host-os"><Icon.plug /></span>
                <span className="min-w-0 flex-1 text-left">
                  <span className="m-host-name">{t.title}</span>
                  <span className="m-host-meta mono">localhost:{t.localPort} → {t.remotePort} · {t.status}</span>
                </span>
                <button className="m-row-close" aria-label={`Stop ${t.title}`} onClick={() => void window.api.invoke('tunnels:close', t.id)}><Icon.x /></button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function MobileMore(): ReactElement {
  const s = useStore()
  const auth = s.authState()
  const theme = s.settings?.theme ?? 'system'
  return (
    <div className="m-list-page">
      <h3 className="m-group-title">AWS</h3>
      <div className="m-card-list">
        <button className="m-host" disabled={s.loggingIn} onClick={() => void s.refreshToken()}>
          <span className="m-host-os"><Icon.key /></span>
          <span className="min-w-0 flex-1 text-left">
            <span className="m-host-name">{s.loggingIn ? 'Waiting for sign-in…' : 'Sign in to AWS'}</span>
            <span className="m-host-meta">{auth.kind === 'ok' ? 'SSO session is valid' : auth.kind === 'expired' ? 'Session expired' : `Expires in ${auth.minutesLeft} min`}.</span>
          </span>
        </button>
        <button className="m-host" disabled={s.scanning} onClick={() => void s.scan()}>
          <span className="m-host-os"><Icon.refresh className={s.scanning ? 'animate-spin' : ''} /></span>
          <span className="min-w-0 flex-1 text-left">
            <span className="m-host-name">Rescan accounts</span>
            <span className="m-host-meta">{s.profiles.filter((p) => p.enabled).length} accounts{s.scanErrors.length ? ` · ${s.scanErrors.length} region(s) failed` : ''}</span>
          </span>
        </button>
      </div>
      <h3 className="m-group-title">Appearance</h3>
      <div className="m-segment" role="radiogroup" aria-label="Theme">
        {(['system', 'light', 'dark'] as const).map((t) => (
          <button key={t} role="radio" aria-checked={theme === t} className={theme === t ? 'on' : ''} onClick={() => void s.setTheme(t)}>
            {t === 'system' ? 'Auto' : t === 'light' ? 'Light' : 'Dark'}
          </button>
        ))}
      </div>
      <h3 className="m-group-title">App</h3>
      <div className="m-card-list">
        {nativeApp() && (
          <button className="m-host" onClick={() => postNative({ type: 'settings' })}>
            <span className="m-host-os"><Icon.shield /></span>
            <span className="min-w-0 flex-1 text-left"><span className="m-host-name">iPhone app</span><span className="m-host-meta">Paired computers, Face ID lock</span></span>
            <Icon.chevron className="muted" />
          </button>
        )}
        <button className="m-host" onClick={() => s.set({ settingsOpen: true })}>
          <span className="m-host-os"><Icon.settings /></span>
          <span className="min-w-0 flex-1 text-left"><span className="m-host-name">Settings</span><span className="m-host-meta">Defaults, terminal, snippets, phone access</span></span>
          <Icon.chevron className="muted" />
        </button>
        <button className="m-host" onClick={() => s.set({ manualHostEditor: 'new', manualHostFolder: null })}>
          <span className="m-host-os"><Icon.plus /></span>
          <span className="min-w-0 flex-1 text-left"><span className="m-host-name">Add a server</span><span className="m-host-meta">A host outside AWS, by address</span></span>
          <Icon.chevron className="muted" />
        </button>
        {!nativeApp() && <button className="m-host" onClick={() => setLayoutPreference('desktop')}>
          <span className="m-host-os"><Icon.grid /></span>
          <span className="min-w-0 flex-1 text-left"><span className="m-host-name">Use desktop layout</span><span className="m-host-meta">For a tablet or large screen. Open this page with ?layout=auto to come back.</span></span>
        </button>}
      </div>
      <p className="m-footnote muted">Sessions run on the computer hosting EC2 Remote Access. AWS credentials never leave it; this phone sends keystrokes and shows the screen.</p>
    </div>
  )
}

import type { ReactElement, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import type { AuthState } from '@shared/types'
import type { FrequentSite } from '@shared/browser'
import { Favicon, ServiceBadge, SPACE_SERVICES, SpaceAvatar, spaceVars, type Space } from './parts'

const greeting = (h: number): string => (h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening')

/**
 * What a new tab (or a space with no tabs) shows: the time, the command bar, and the space's way in. An AWS account
 * space leads with its console services; every space lists its most visited sites.
 */
export default function StartPage({ space, auth, frequent, favicons, commandBar, onOpen, onSignIn }: {
  space: Space
  auth?: AuthState
  frequent: FrequentSite[]
  favicons: Record<string, string>
  commandBar: ReactNode
  onOpen: (url: string) => void
  onSignIn: () => void
}): ReactElement {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000)
    return () => clearInterval(t)
  }, [])
  const region = space.region ?? 'us-east-1'

  return (
    <div className="start-page" data-accent={space.color} style={spaceVars(space)}>
      <div className="start-inner">
        <div className="start-clock">{now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>
        <div className="start-greet">{greeting(now.getHours())} · {now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</div>
        <div className="start-search">{commandBar}</div>

        {space.profile && (
          <section className="start-card">
            <div className="start-card-head">
              <SpaceAvatar space={space} size={34} />
              <div className="min-w-0 flex-1">
                <div className="start-card-title">{space.name}</div>
                <div className="start-card-sub">AWS account{space.accountId ? ` ${space.accountId}` : ''} · {region}</div>
              </div>
              {auth === 'ok' ? (
                <span className="start-chip ok">Signed in</span>
              ) : auth === 'login-required' || auth === 'error' ? (
                <button type="button" className="btn btn-sm btn-primary" onClick={onSignIn}>Sign in to AWS</button>
              ) : (
                <span className="start-chip">{auth === 'checking' ? 'Checking…' : 'SSO'}</span>
              )}
            </div>
            <div className="start-services">
              {SPACE_SERVICES.map((svc) => (
                <button key={svc.id} type="button" className="start-service" onClick={() => onOpen(svc.url(region))}>
                  <ServiceBadge id={svc.id} size={30} />
                  <span className="truncate">{svc.name}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {frequent.length > 0 && (
          <section className="start-sites">
            <div className="start-label">Frequently visited</div>
            <div className="start-site-grid">
              {frequent.map((f) => (
                <button key={f.host} type="button" className="start-site" title={f.url} onClick={() => onOpen(f.url)}>
                  <span className="start-site-icon"><Favicon src={favicons[f.host]} url={f.url} size={22} /></span>
                  <span className="truncate">{f.host}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {!space.profile && !frequent.length && (
          <p className="start-hint">
            Each space keeps its own logins. AWS accounts get a space each, signed in to the console with the account's SSO
            access. <kbd>⌘T</kbd> opens a tab, <kbd>⌘S</kbd> hides the sidebar, <kbd>⌥⌘↓</kbd> switches space.
          </p>
        )}
      </div>
    </div>
  )
}

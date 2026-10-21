/**
 * Keeping the built-in browser signed in across restarts. Sign-in services (JumpCloud's SSO session, Quickbase's
 * ticket) often use session cookies, which have no expiry and live only in memory, so quitting the app signed every
 * space out however long the service allows. Chrome keeps them when it restores your tabs; main/sessionCookies.ts
 * does the same, encrypted. This is the pure part: which cookies to keep and how to put one back.
 */

/** A cookie as Electron's `cookies.get` reports it (the fields used here). */
export interface CookieLike {
  name: string
  value: string
  domain?: string
  hostOnly?: boolean
  path?: string
  secure?: boolean
  httpOnly?: boolean
  session?: boolean
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
}

/** What `cookies.set` takes (Electron's CookiesSetDetails, the fields used here). */
export interface CookieSet {
  url: string
  name: string
  value: string
  domain?: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
}

/** How long a saved set is worth putting back: past this the services have ended those sessions anyway. */
export const KEEP_DAYS = 7

/** Only session cookies: the others are on disk already, with their own expiry. */
export const restorable = (c: CookieLike): boolean => !!c.session && !!c.name && !!c.domain

/**
 * The details that set the same cookie again, still as a session cookie (no expiry). A host-only cookie goes back
 * without a domain, or it would start matching subdomains; `__Host-` cookies must have none anyway.
 */
export function cookieSet(c: CookieLike): CookieSet {
  const host = (c.domain ?? '').replace(/^\./, '')
  const secure = !!c.secure || c.name.startsWith('__Secure-') || c.name.startsWith('__Host-')
  const path = c.path || '/'
  const hostOnly = c.hostOnly ?? !(c.domain ?? '').startsWith('.')
  return {
    url: `${secure ? 'https' : 'http'}://${host}${path}`,
    name: c.name,
    value: c.value,
    ...(hostOnly || c.name.startsWith('__Host-') ? {} : { domain: c.domain }),
    path,
    secure,
    httpOnly: !!c.httpOnly,
    sameSite: c.sameSite ?? 'unspecified'
  }
}

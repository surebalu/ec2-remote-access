import type { SsoSessionInfo } from './types'

export type SsoWaitOutcome = 'pending' | 'signed-in' | 'expired'

/** The Mac polls AWS on an interval of its own, so allow a little past the code's lifetime before calling it expired. */
const EXPIRY_GRACE_MS = 20_000

/**
 * Where a device-code sign-in stands, judged from the token the Mac wrote rather than from pushed events.
 *
 * Completion is also pushed to the page (`profiles:status`), but a push only reaches sockets that are open at that
 * moment. A phone sends the user to Safari to approve, iOS suspends the app and drops its socket, and the push is
 * gone by the time the page reconnects. The token cache is the durable record: a valid token whose expiry differs from
 * the one the sign-in started with was written by this sign-in.
 */
export function ssoWaitOutcome(p: {
  session: SsoSessionInfo | undefined
  /** `expiresAt` of the session's token when the sign-in started (undefined when there was none). */
  expiresAtBefore: string | undefined
  startedAt: number
  /** Lifetime of the device code, from the flow the Mac returned. */
  flowExpiresInSec: number
  now: number
}): SsoWaitOutcome {
  const s = p.session
  if (s?.tokenValid && s.expiresAt && s.expiresAt !== p.expiresAtBefore) return 'signed-in'
  if (p.now > p.startedAt + p.flowExpiresInSec * 1000 + EXPIRY_GRACE_MS) return 'expired'
  return 'pending'
}

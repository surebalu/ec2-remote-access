/**
 * Liveness probing for RDP relays that run through an SSM port-forward.
 *
 * Why this exists: when the session-manager-plugin's WebSocket to AWS dies (network blip, failed ResumeSession), the
 * plugin neither exits nor prints anything on stdout (its own log is off by default), and its 127.0.0.1 listener
 * stays up. TCP keepalive on our socket to that listener is answered by the local kernel, so it never fails, and an
 * idle RDP desktop legitimately sends nothing. The relay then looks exactly like a healthy idle session until the user
 * types for minutes. Newer SSM agents (> 3.1.1511.0) also run the plugin's smux multiplexer with keepalive disabled,
 * so nothing inside the tunnel notices either.
 *
 * The probe opens a second TCP connection to the plugin's local port. With a multiplexing agent that becomes a new
 * stream over the same data channel, and the instance's RDP service must answer an X.224 Connection Request. A reply
 * proves the WebSocket, the agent and TermService are all alive; silence proves the data channel is gone.
 *
 * Kept free of relative imports so the node test runner can load it directly.
 */
import { connect } from 'node:net'

/** How long the server may be silent before an idle relay gets probed. */
export const IDLE_PROBE_AFTER_MS = 45_000
/** Minimum spacing between probes while the relay stays silent and healthy. */
export const PROBE_INTERVAL_MS = 60_000
/** Client input unanswered this long means the user is looking at a possibly frozen screen: probe sooner. */
export const INPUT_PROBE_AFTER_MS = 10_000
/** A healthy tunnel answers an X.224 request in well under a second; this is deliberately generous. */
export const PROBE_TIMEOUT_MS = 12_000
/** After one failed probe, confirm quickly instead of waiting a full interval. */
export const RETRY_AFTER_FAILURE_MS = 3_000
/** Consecutive failed probes needed before a relay is cut. One failure alone never cuts a session. */
export const FAILURES_TO_CUT = 2
/** A watchdog tick arriving this late means the process was suspended (sleep, App Nap): probe right away. */
export const CLOCK_JUMP_MS = 30_000

/**
 * The plugin multiplexes several local connections over one data channel only for agents newer than 3.0.196.0.
 * Older agents use "basic" forwarding, where a second local connection replaces the first and would kill the live
 * RDP session, so probing is only safe when the agent version is known to be new enough.
 */
export function agentSupportsMux(version: string | undefined): boolean {
  if (!version) return false
  const parts = version.split('.').map((p) => Number.parseInt(p, 10))
  if (parts.length === 0 || parts.some((n) => !Number.isFinite(n))) return false
  const min = [3, 0, 196, 0]
  for (let i = 0; i < min.length; i++) {
    const v = parts[i] ?? 0
    if (v !== min[i]) return v > min[i]
  }
  return false
}

/** TPKT + X.224 Connection Request + RDP_NEG_REQ (TLS | CredSSP), the same first packet mstsc sends. */
export function x224ConnectionRequest(): Buffer {
  return Buffer.from([0x03, 0x00, 0x00, 0x13, 0x0e, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x08, 0x00, 0x03, 0x00, 0x00, 0x00])
}

/** True once `buf` holds a TPKT-framed X.224 Connection Confirm. A negotiation failure still counts: the server answered. */
export function isX224Confirm(buf: Buffer): boolean {
  if (buf.length < 7 || buf[0] !== 0x03) return false
  const len = buf.readUInt16BE(2)
  if (len < 7 || buf.length < len) return false
  return (buf[5] & 0xf0) === 0xd0
}

export interface ProbeResult {
  ok: boolean
  ms: number
  error?: string
}

/** Asks the RDP service behind host:port for an X.224 Connection Confirm, then hangs up. Never rejects. */
export function probeRdp(host: string, port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  const started = Date.now()
  return new Promise((resolve) => {
    let done = false
    let acc = Buffer.alloc(0)
    const sock = connect({ host, port })
    const finish = (ok: boolean, error?: string): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      sock.destroy()
      resolve({ ok, ms: Date.now() - started, ...(error ? { error } : {}) })
    }
    const timer = setTimeout(() => finish(false, `no X.224 reply within ${Math.round(timeoutMs / 1000)} s`), timeoutMs)
    sock.setNoDelay(true)
    sock.once('connect', () => sock.write(x224ConnectionRequest()))
    sock.on('data', (d: Buffer) => {
      acc = Buffer.concat([acc, d])
      if (isX224Confirm(acc)) finish(true)
      else if (acc.length > 64) finish(false, 'unexpected reply to X.224 request')
    })
    sock.once('error', (e) => finish(false, e.message))
    sock.once('close', () => finish(false, 'tunnel closed the probe connection'))
  })
}

/** Everything the probe scheduler needs to know about one relay at one instant. */
export interface ProbeState {
  now: number
  /** Last time the server sent anything (or the relay opened). */
  lastDownAt: number
  /** When unanswered client input started, or null. */
  waitingSince: number | null
  /** When the last probe finished, or null if none has run. */
  lastProbeAt: number | null
  /** Consecutive failed probes. */
  failures: number
  /** The watchdog noticed the process had been suspended. */
  clockJumped: boolean
}

/** Whether to start a probe now. Pure so the thresholds can be unit-tested. */
export function shouldProbe(s: ProbeState): boolean {
  const silentFor = s.now - s.lastDownAt
  const sinceProbe = s.lastProbeAt === null ? Infinity : s.now - s.lastProbeAt
  if (s.clockJumped) return true
  if (s.failures > 0) return sinceProbe >= RETRY_AFTER_FAILURE_MS
  if (s.waitingSince !== null && s.now - s.waitingSince >= INPUT_PROBE_AFTER_MS) return sinceProbe >= INPUT_PROBE_AFTER_MS
  return silentFor >= IDLE_PROBE_AFTER_MS && sinceProbe >= PROBE_INTERVAL_MS
}

/**
 * Folds a probe result into the failure count. A failure is discarded when the server sent bytes on the real relay
 * while the probe was out: the session itself just proved it is alive.
 */
export function afterProbe(failures: number, result: ProbeResult, probeStartedAt: number, lastDownAt: number): { failures: number; cut: boolean } {
  if (result.ok || lastDownAt >= probeStartedAt) return { failures: 0, cut: false }
  const next = failures + 1
  return { failures: next, cut: next >= FAILURES_TO_CUT }
}

import type { BoxStatus } from './box'
import type { AwsProfile, Instance, ProfileStatus, Route, ScanResult } from './types'

export interface WorkspaceSession {
  id: string
  title: string
  kind: string
  status: string
  transient?: boolean
}

export type AttentionItem = {
  id: string
  kind: 'account' | 'scan' | 'cached' | 'route' | 'session' | 'box'
  title: string
  detail: string
  target?: string
}

/** Box sync stops quietly when it stops (signed out after 60 days unused, a failing sync): a problem worth saying. */
const BOX_LATE_MS = 15 * 60_000

export function boxIssue(box: BoxStatus | null | undefined, now: number): AttentionItem | null {
  if (!box?.available) return null
  // Still knows the account but holds no sign-in: Box ended it (a refresh token unused for 60 days, or revoked).
  if (!box.signedIn) return box.user ? { id: 'box', kind: 'box', target: 'signin', title: 'Box signed this computer out', detail: 'Tasks, Calendar, Links and whiteboards are not syncing. Sign in to Box again.' } : null
  if (box.lastError) return { id: 'box', kind: 'box', target: 'sync', title: 'Box sync is failing', detail: box.lastError }
  if (!box.syncing && box.lastSync && now - box.lastSync > BOX_LATE_MS) return { id: 'box', kind: 'box', target: 'sync', title: 'Box has not synced for a while', detail: `Last synced ${Math.round((now - box.lastSync) / 60_000)} minutes ago.` }
  return null
}

/** Derives a workspace from known facts only: a route is not a successful connection or a health check. */
export function workspaceSummary(input: {
  hosts: Instance[]
  profiles: AwsProfile[]
  statuses: Record<string, ProfileStatus>
  errors: ScanResult['errors']
  sessions: WorkspaceSession[]
  route: (host: Instance) => Route
  box?: BoxStatus | null
  now?: number
}) {
  const profiles = input.profiles.filter((p) => p.enabled)
  const disabled = new Set(input.profiles.filter((p) => !p.enabled).map((p) => p.name))
  const hosts = input.hosts.filter((h) => h.manual || !disabled.has(h.profile))
  const sessions = input.sessions.filter((t) => !t.transient && ['ssh', 'rdp', 'sftp'].includes(t.kind))
  const stale = hosts.filter((h) => h.staleReason)
  const errors = input.errors.filter((e) => !disabled.has(e.profile))
  const issues: AttentionItem[] = []
  for (const p of profiles) {
    const status = input.statuses[p.name]
    if (status?.state === 'error' || status?.state === 'login-required') issues.push({
      id: `account:${p.name}`, kind: 'account', target: p.name,
      title: status.state === 'login-required' ? `${p.name}: sign-in required` : `${p.name}: account check failed`,
      detail: status.message || 'Review this account before opening a new connection.'
    })
  }
  const failed = new Set(errors.map((e) => `${e.profile}/${e.allRegions ? '*' : e.region}`))
  if (failed.size) issues.push({ id: 'scan', kind: 'scan', title: `${failed.size} inventory ${failed.size === 1 ? 'scan needs' : 'scans need'} a retry`, detail: `${stale.length} cached ${stale.length === 1 ? 'host' : 'hosts'}. Last known details are kept until a scan succeeds.` })
  else if (stale.length) issues.push({ id: 'cached', kind: 'cached', title: `${stale.length} cached ${stale.length === 1 ? 'host needs' : 'hosts need'} verification`, detail: 'Refresh inventory to verify the last known state and route.' })
  for (const t of sessions.filter((t) => t.status === 'error' || t.status === 'closed')) issues.push({
    id: `session:${t.id}`, kind: 'session', target: t.id,
    title: `${t.title}: ${t.status === 'error' ? 'connection failed' : 'disconnected'}`, detail: 'Return to the session to review the error or reconnect.'
  })
  // A stale or stopped host cannot support a current reachability claim.
  const noRoute = hosts.filter((h) => !h.staleReason && h.state === 'running' && input.route(h) === 'unreachable')
  if (noRoute.length) issues.push({ id: 'route', kind: 'route', title: `${noRoute.length} running ${noRoute.length === 1 ? 'host has' : 'hosts have'} no automatic route`, detail: 'Check SSM status, or choose a direct address in connection options.' })
  const box = boxIssue(input.box, input.now ?? Date.now())
  if (box) issues.push(box)
  const verified = profiles.filter((p) => input.statuses[p.name]?.state === 'ok').length
  const accountState = !profiles.length ? 'none' : issues.some((i) => i.kind === 'account') ? 'attention' : verified === profiles.length ? 'verified' : 'unverified'
  return {
    total: hosts.length, running: hosts.filter((h) => h.state === 'running').length,
    routes: hosts.filter((h) => ['ssm', 'direct'].includes(input.route(h))).length,
    stale: stale.length, sessions: sessions.length, live: sessions.filter((t) => t.status === 'connected').length,
    accountState, verifiedAccounts: verified, accounts: profiles.length, issues
  }
}

/** Health polls every two minutes; a missed interval must not remain an unqualified green verdict. */
export function healthIsStale(at: number | undefined, error: string | null, now: number): boolean {
  return !!error || !at || now - at > 180_000
}

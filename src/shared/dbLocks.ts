/**
 * Database locks (main/dbLocks.ts, components/dblocks/): who is blocking whom on the platform's Oracle databases (RDS),
 * read through an SSM tunnel with the master user from Secrets Manager, and ending a blocker with RDS's own kill
 * procedure. This is the pure part: the queries, chains of blockers and waiters, which secret belongs to which
 * database, what may be ended. tests/dbLocks.test.ts.
 */

export type DbEnv = 'prod' | 'qa' | 'dev'

export interface DbTarget {
  id: string
  env: DbEnv | null
  engine: string
  profile: string
  region: string
  endpoint: string
  port: number
  /** The service name ("ORCL"). */
  dbName: string
  /** The host the tunnel goes through: one in the database's network that talks to it. */
  via: { key: string; name: string } | null
  /** The Secrets Manager secret with the master password, found by its name or description. */
  secret: { name: string; profile: string } | null
  /** Why it cannot be read, when it cannot. */
  problem?: string
}

export interface DbSession {
  inst: number
  sid: number
  serial: number
  user: string | null
  osUser: string | null
  machine: string | null
  program: string | null
  module: string | null
  /** ACTIVE, INACTIVE, KILLED… */
  status: string
  type: string
  event: string | null
  waitClass: string | null
  /** In its current wait (waiters), seconds. */
  waitSec: number | null
  /** Since its last call started (ACTIVE) or ended (INACTIVE), seconds. */
  lastCallSec: number | null
  logonAt: number | null
  sqlId: string | null
  prevSqlId: string | null
  sqlText: string | null
  prevSqlText: string | null
  blockingInst: number | null
  blockingSid: number | null
  /** The object a waiter waits on (owner.name), from its row wait. */
  waitObject: string | null
  /** What it holds locks on, with the mode (blockers). */
  locked: { object: string; type: string; mode: string }[]
  /** When its open transaction began (ms), when it has one. */
  txSince: number | null
}

export interface LockChain {
  root: DbSession
  /** Everyone waiting behind the root, directly or through another waiter, with how deep. */
  waiters: { s: DbSession; depth: number }[]
  /** The longest of their waits, seconds. */
  longestWaitSec: number
}

export interface LockReport {
  at: number
  db: string
  env: DbEnv | null
  /** Through which host and how many user sessions there are, for context. */
  via: string
  sessions: { active: number; inactive: number; total: number }
  chains: LockChain[]
}

export interface DbKillRequest { id: string; inst: number; sid: number; serial: number }
export interface DbAudit { at: number; by: string; db: string; sid: number; serial: number; user: string | null; machine: string | null; program: string | null; result: 'done' | 'failed'; message: string }

/** Blockers and their waiters: a session waiting on another, or one someone waits on. */
export const SESSIONS_SQL = `
SELECT s.inst_id, s.sid, s.serial#, s.username, s.osuser, s.machine, s.program, s.module, s.status, s.type, s.event, s.wait_class,
       ROUND(s.wait_time_micro / 1e6) AS wait_sec, s.last_call_et, (s.logon_time - DATE '1970-01-01') * 86400 AS logon_epoch,
       s.sql_id, s.prev_sql_id, s.blocking_instance, s.blocking_session, s.row_wait_obj#
  FROM gv$session s
 WHERE s.blocking_session IS NOT NULL
    OR EXISTS (SELECT 1 FROM gv$session w WHERE w.blocking_session = s.sid AND w.blocking_instance = s.inst_id)`

export const COUNTS_SQL = `SELECT status, COUNT(*) AS n FROM gv$session WHERE type = 'USER' GROUP BY status`

/** Statement text for up to 50 sql ids (binds :1…:n). */
export const sqlTextSql = (n: number): string =>
  `SELECT sql_id, MAX(SUBSTR(sql_text, 1, 1000)) AS sql_text FROM gv$sql WHERE sql_id IN (${binds(n)}) GROUP BY sql_id`

/** What the given sessions hold locks on. */
export const lockedSql = (n: number): string => `
SELECT lo.inst_id, lo.session_id, o.owner, o.object_name, o.object_type, lo.locked_mode
  FROM gv$locked_object lo JOIN dba_objects o ON o.object_id = lo.object_id
 WHERE lo.session_id IN (${binds(n)})`

export const objectsSql = (n: number): string => `SELECT object_id, owner, object_name FROM dba_objects WHERE object_id IN (${binds(n)})`

/** When the given sessions' transactions began. */
export const txSql = (n: number): string => `
SELECT s.inst_id, s.sid, (t.start_date - DATE '1970-01-01') * 86400 AS start_epoch
  FROM gv$transaction t JOIN gv$session s ON s.taddr = t.addr AND s.inst_id = t.inst_id
 WHERE s.sid IN (${binds(n)})`

/** The session as it is now, checked just before it is ended (its serial must still match). */
export const SESSION_NOW_SQL = `SELECT username, machine, program, status, type FROM gv$session WHERE inst_id = :inst AND sid = :sid AND serial# = :serial`

/** RDS's procedure: the master user cannot ALTER SYSTEM KILL SESSION itself. */
export const KILL_SQL = `BEGIN rdsadmin.rdsadmin_util.kill(sid => :sid, serial => :serial, method => 'IMMEDIATE'); END;`

const binds = (n: number): string => Array.from({ length: Math.max(1, n) }, (_, i) => `:${i + 1}`).join(', ')

/** Oracle's lock modes (v$locked_object.locked_mode). */
export function lockModeName(mode: number): string {
  return ['None', 'Null', 'Row share', 'Row exclusive', 'Share', 'Share row exclusive', 'Exclusive'][mode] ?? String(mode)
}

const skey = (inst: number, sid: number): string => `${inst}:${sid}`

/**
 * Sessions grouped into chains, one per session at the head (blocking others and not itself waiting on anyone listed),
 * worst first: the most waiters, then the longest wait. A cycle (a deadlock Oracle has not broken yet) still shows,
 * headed by its first member.
 */
export function buildChains(sessions: DbSession[]): LockChain[] {
  const by = new Map(sessions.map((s) => [skey(s.inst, s.sid), s]))
  const kids = new Map<string, DbSession[]>()
  for (const s of sessions) {
    if (s.blockingSid === null) continue
    const k = skey(s.blockingInst ?? s.inst, s.blockingSid)
    kids.set(k, [...(kids.get(k) ?? []), s])
  }
  const blockedBy = (s: DbSession): DbSession | undefined => (s.blockingSid === null ? undefined : by.get(skey(s.blockingInst ?? s.inst, s.blockingSid)))
  const roots = sessions.filter((s) => kids.has(skey(s.inst, s.sid)) && !blockedBy(s))
  const placed = new Set<string>()
  const walk = (root: DbSession): LockChain => {
    const waiters: LockChain['waiters'] = []
    const visit = (s: DbSession, depth: number): void => {
      placed.add(skey(s.inst, s.sid))
      for (const w of kids.get(skey(s.inst, s.sid)) ?? []) {
        if (placed.has(skey(w.inst, w.sid))) continue
        waiters.push({ s: w, depth })
        visit(w, depth + 1)
      }
    }
    visit(root, 1)
    return { root, waiters, longestWaitSec: Math.max(0, ...waiters.map((w) => w.s.waitSec ?? 0)) }
  }
  const chains = roots.map(walk)
  // A cycle has no head: start it at whichever member is left.
  for (const s of sessions) if (!placed.has(skey(s.inst, s.sid)) && kids.has(skey(s.inst, s.sid))) chains.push(walk(s))
  return chains.sort((a, b) => b.waiters.length - a.waiters.length || b.longestWaitSec - a.longestWaitSec)
}

/** The environment a database identifier names ("prod-ms-db" → prod). */
export function dbEnvOf(id: string): DbEnv | null {
  if (/(^|[-_])prod/i.test(id)) return 'prod'
  if (/(^|[-_])qa([-_]|$)/i.test(id)) return 'qa'
  if (/(^|[-_])dev([-_]|$)/i.test(id)) return 'dev'
  return null
}

/**
 * How well a secret fits a database's master password: it has to speak of a master user (or be RDS's own
 * "rds!db-…" secret for it) and name the database or its environment. 0 = not it.
 */
export function secretScore(name: string, description: string, db: { id: string; env: DbEnv | null; resourceId?: string }): number {
  const text = `${name} ${description}`.toLowerCase()
  if (db.resourceId && name.toLowerCase().startsWith(`rds!${db.resourceId.toLowerCase()}`)) return 100
  if (!/master/.test(text)) return 0
  let score = 0
  if (text.includes(db.id.toLowerCase())) score += 50
  const env = db.env === 'prod' ? /(^|[^a-z])(prod|production)([^a-z]|$)/ : db.env === 'qa' ? /(^|[^a-z])qa([^a-z]|$)/ : db.env === 'dev' ? /(^|[^a-z])(dev|development)([^a-z]|$)/ : null
  if (env?.test(text)) score += 30
  if (!score) return 0
  if (/oracle|rds|\bdb\b|database/.test(text)) score += 10
  if (/(pwd|password)/.test(text)) score += 5
  return score
}

/** A secret's text: JSON with username/password (RDS's own and most others), or the password alone. */
export function parseSecret(text: string, defaultUser: string): { user: string; password: string } {
  const t = text.trim()
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t) as Record<string, unknown>
      const pick = (...keys: string[]): string | undefined => {
        for (const k of keys) { const v = j[k]; if (typeof v === 'string' && v) return v }
        return undefined
      }
      const password = pick('password', 'Password', 'PASSWORD', 'pwd', 'masterPassword', 'master_password')
      if (password) return { user: pick('username', 'Username', 'user', 'USER', 'masterUsername', 'master_username') ?? defaultUser, password }
    } catch { /* not JSON after all: the whole text is the password */ }
  }
  if (!t) throw new Error('The secret is empty.')
  return { user: defaultUser, password: t }
}

const PROTECTED = /^(SYS|SYSTEM|RDSADMIN|DBSNMP|SYSBACKUP|SYSDG|SYSKM|AUDSYS)$/i

/** Why a session may not be ended from here, or null when it may. */
export function cannotKill(s: Pick<DbSession, 'type' | 'user' | 'status'>, ownUser: string): string | null {
  if (s.type !== 'USER') return 'Oracle background processes are never ended from here.'
  if (!s.user) return 'A session with no user is an Oracle process.'
  if (PROTECTED.test(s.user)) return `${s.user} is an Oracle or RDS system account.`
  if (s.user.toUpperCase() === ownUser.toUpperCase()) return `${s.user} is the account this app reads with: ending it would end the reading, not the lock.`
  if (s.status === 'KILLED') return 'Already being ended.'
  return null
}

/** Whole positive integers only: they go to Oracle as binds, but a mistyped request is refused before it gets there. */
export function validKill(r: DbKillRequest): boolean {
  return [r.inst, r.sid, r.serial].every((n) => Number.isInteger(n) && n > 0 && n < 2 ** 31) && /^[A-Za-z0-9-]{1,63}$/.test(r.id)
}

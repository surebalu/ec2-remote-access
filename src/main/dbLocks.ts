import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DescribeDBInstancesCommand, RDSClient } from '@aws-sdk/client-rds'
import { GetSecretValueCommand, ListSecretsCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import type { Connection } from 'oracledb'
import {
  COUNTS_SQL, KILL_SQL, SESSIONS_SQL, SESSION_NOW_SQL, buildChains, cannotKill, dbEnvOf, lockModeName, lockedSql, objectsSql, parseSecret, secretScore, sqlTextSql, txSql, validKill,
  type DbAudit, type DbKillRequest, type DbSession, type DbTarget, type LockReport
} from '@shared/dbLocks'
import type { Instance } from '@shared/types'
import { credentialsFor } from './aws/credentials'
import { getCachedInventory } from './store'
import { forwardVia } from './plmHealth'
import { identity } from './services'
import { host } from './host'
import { log } from './log'

/**
 * Database locks (channels db:*): the platform's Oracle databases on RDS, found in every account the host list covers;
 * each read through an SSM port forward from a server in the database's network that already talks to it (3DSpace),
 * signed in as the master user whose password is in Secrets Manager (found by the secret's name or description, read
 * only in this process, never logged or sent to a page). Reading is queries on gv$ views; ending a blocker is RDS's
 * rdsadmin_util.kill, after checking the session is still the one that was shown, and goes into the audit history.
 */

interface Found extends DbTarget { master: string; resourceId: string; vpcId: string }

const DISCOVER_MS = 30 * 60_000
const IDLE_MS = 5 * 60_000
let found: { at: number; list: Found[] } | null = null
let finding: Promise<Found[]> | null = null
const conns = new Map<string, { conn: Connection; user: string; port: number; timer: ReturnType<typeof setTimeout> }>()

const auditFile = (): string => join(host().userDataDir(), 'db-actions.jsonl')

/** The databases, with how each would be reached and signed in to (or why it cannot be). */
export async function dbList(force = false): Promise<DbTarget[]> {
  return (await discover(force)).map(({ master: _m, resourceId: _r, vpcId: _v, ...t }) => t)
}

async function discover(force = false): Promise<Found[]> {
  if (!force && found && Date.now() - found.at < DISCOVER_MS) return found.list
  if (finding) return finding
  finding = (async () => {
    const insts = (getCachedInventory()?.instances ?? []).filter((i) => !i.manual)
    const pairs = [...new Map(insts.map((i) => [`${i.profile}|${i.region}`, { profile: i.profile, region: i.region }])).values()]
    const dbs: Found[] = []
    await Promise.all(pairs.map(async ({ profile, region }) => {
      const rds = new RDSClient({ region, credentials: credentialsFor(profile) })
      try {
        let marker: string | undefined
        do {
          const out = await rds.send(new DescribeDBInstancesCommand({ Marker: marker }))
          for (const d of out.DBInstances ?? []) {
            if (!/^oracle/i.test(d.Engine ?? '') || !d.DBInstanceIdentifier || !d.Endpoint?.Address) continue
            dbs.push({
              id: d.DBInstanceIdentifier, env: dbEnvOf(d.DBInstanceIdentifier), engine: `${d.Engine} ${(d.EngineVersion ?? '').split('.')[0]}`.trim(), profile, region,
              endpoint: d.Endpoint.Address, port: d.Endpoint.Port ?? 1521, dbName: d.DBName ?? 'ORCL', via: null, secret: null,
              master: d.MasterUsername ?? 'admin', resourceId: d.DbiResourceId ?? '', vpcId: d.DBSubnetGroup?.VpcId ?? ''
            })
          }
          marker = out.Marker
        } while (marker)
      } catch (e) {
        log('db', 'describe failed', { profile, region, error: (e as Error).message })
      } finally { rds.destroy() }
    }))

    // Secrets in every account: the master password may live in another account than the database (it does here).
    const secrets: { name: string; description: string; profile: string; region: string }[] = []
    const regions = new Set(dbs.map((d) => d.region))
    await Promise.all(pairs.filter((p) => regions.has(p.region)).map(async ({ profile, region }) => {
      const sm = new SecretsManagerClient({ region, credentials: credentialsFor(profile) })
      try {
        let next: string | undefined
        do {
          const out = await sm.send(new ListSecretsCommand({ NextToken: next, MaxResults: 100 }))
          for (const s of out.SecretList ?? []) if (s.Name) secrets.push({ name: s.Name, description: s.Description ?? '', profile, region })
          next = out.NextToken
        } while (next)
      } catch (e) {
        log('db', 'list secrets failed', { profile, region, error: (e as Error).message })
      } finally { sm.destroy() }
    }))

    for (const d of dbs) {
      const best = secrets.filter((s) => s.region === d.region).map((s) => ({ s, score: secretScore(s.name, s.description, d) + (s.profile === d.profile ? 1 : 0) }))
        .filter((x) => x.score > 1).sort((a, b) => b.score - a.score)[0]
      d.secret = best ? { name: best.s.name, profile: best.s.profile } : null
      const v = viaFor(d, insts)
      d.via = v ? { key: v.key, name: v.name } : null
      d.problem = !d.via ? `No running server with an online SSM agent in ${d.id}'s network (${d.vpcId || 'unknown VPC'}) to reach it through.`
        : !d.secret ? `No secret in Secrets Manager names ${d.id}'s master password (looked for "master" with "${d.env ?? d.id}" in a secret's name or description).`
          : undefined
    }
    dbs.sort((a, b) => ['prod', 'qa', 'dev', null].indexOf(a.env) - ['prod', 'qa', 'dev', null].indexOf(b.env) || a.id.localeCompare(b.id))
    found = { at: Date.now(), list: dbs }
    return dbs
  })().finally(() => { finding = null })
  return finding
}

/** A server in the database's VPC that talks to it: 3DSpace first (its security group is let in on 1521). */
function viaFor(d: Found, insts: Instance[]): Instance | null {
  const rank = (i: Instance): number => (/3dspace/i.test(i.name) && !/derived|index|search/i.test(i.name) ? 0 : /3dspace|space/i.test(i.name) ? 1 : /passport|dashboard|fcs|swym/i.test(i.name) ? 2 : 3)
  return insts.filter((i) => i.profile === d.profile && i.vpcId === d.vpcId && i.state === 'running' && i.ssmOnline && i.platform !== 'windows')
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))[0] ?? null
}

async function target(id: string): Promise<Found> {
  let t = (await discover()).find((d) => d.id === id)
  if (!t) t = (await discover(true)).find((d) => d.id === id)
  if (!t) throw new Error(`${id} is not among the databases found. Rescan the hosts, then try again.`)
  if (t.problem) throw new Error(t.problem)
  return t
}

async function connect(t: Found): Promise<{ conn: Connection; user: string }> {
  const via = (getCachedInventory()?.instances ?? []).find((i) => i.key === t.via!.key)
  if (!via) throw new Error(`${t.via!.name} is no longer in the host list. Rescan.`)
  const port = await forwardVia(via, t.endpoint, t.port)
  const have = conns.get(t.id)
  if (have && have.port === port) {
    try {
      await have.conn.ping()
      keepOpen(t.id)
      return have
    } catch { await drop(t.id) }
  } else if (have) await drop(t.id)
  const sm = new SecretsManagerClient({ region: t.region, credentials: credentialsFor(t.secret!.profile) })
  let creds: { user: string; password: string }
  try {
    const out = await sm.send(new GetSecretValueCommand({ SecretId: t.secret!.name }))
    creds = parseSecret(out.SecretString ?? '', t.master)
  } catch (e) {
    throw new Error(`Could not read the secret ${t.secret!.name} (${t.secret!.profile}): ${(e as Error).message}`)
  } finally { sm.destroy() }
  const { default: oracledb } = await import('oracledb')
  let conn: Connection
  try {
    conn = await oracledb.getConnection({ user: creds.user, password: creds.password, connectString: `127.0.0.1:${port}/${t.dbName}`, connectTimeout: 20, transportConnectTimeout: 20 })
  } catch (e) {
    // The driver's message names the error, never the password.
    throw new Error(`Could not sign in to ${t.id} as ${creds.user}: ${(e as Error).message.split('\n')[0]}`)
  }
  // So a DBA looking at v$session sees what this is.
  conn.module = 'EC2 Remote Access'
  conn.action = 'lock check'
  conn.callTimeout = 30_000
  const entry = { conn, user: creds.user, port, timer: setTimeout(() => void drop(t.id), IDLE_MS) }
  conns.set(t.id, entry)
  log('db', 'connected', { db: t.id, via: via.name, user: creds.user })
  return entry
}

function keepOpen(id: string): void {
  const c = conns.get(id)
  if (!c) return
  clearTimeout(c.timer)
  c.timer = setTimeout(() => void drop(id), IDLE_MS)
}

async function drop(id: string): Promise<void> {
  const c = conns.get(id)
  conns.delete(id)
  if (!c) return
  clearTimeout(c.timer)
  await c.conn.close().catch(() => undefined)
}

export async function closeDbLocks(): Promise<void> {
  await Promise.all([...conns.keys()].map(drop))
}

type Row = Record<string, unknown>
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

async function rows(conn: Connection, sql: string, binds: unknown[] | Record<string, unknown> = []): Promise<Row[]> {
  const { default: oracledb } = await import('oracledb')
  return (await conn.execute<Row>(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT, maxRows: 2000 })).rows ?? []
}

/** Who blocks whom right now, with what they run and hold. */
export async function dbLocks(id: string): Promise<LockReport> {
  const t = await target(id)
  let c = await connect(t)
  let raw: Row[]
  try { raw = await rows(c.conn, SESSIONS_SQL) } catch {
    // A connection the tunnel's end left half-open: once more on a fresh one.
    await drop(t.id)
    c = await connect(t)
    raw = await rows(c.conn, SESSIONS_SQL)
  }
  // The object a waiter's row lock is on, by session, for details().
  const waitObj = new Map<DbSession, number>()
  const sessions: DbSession[] = raw.map((r) => {
    const s: DbSession = {
      inst: num(r.INST_ID) ?? 1, sid: num(r.SID) ?? 0, serial: num(r['SERIAL#']) ?? 0, user: str(r.USERNAME), osUser: str(r.OSUSER), machine: str(r.MACHINE), program: str(r.PROGRAM),
      module: str(r.MODULE), status: str(r.STATUS) ?? '', type: str(r.TYPE) ?? '', event: str(r.EVENT), waitClass: str(r.WAIT_CLASS),
      waitSec: num(r.BLOCKING_SESSION) !== null ? num(r.WAIT_SEC) : null, lastCallSec: num(r.LAST_CALL_ET),
      logonAt: num(r.LOGON_EPOCH) !== null ? Math.round(num(r.LOGON_EPOCH)! * 1000) : null, sqlId: str(r.SQL_ID), prevSqlId: str(r.PREV_SQL_ID), sqlText: null, prevSqlText: null,
      blockingInst: num(r.BLOCKING_INSTANCE), blockingSid: num(r.BLOCKING_SESSION), waitObject: null, locked: [], txSince: null
    }
    const o = num(r['ROW_WAIT_OBJ#'])
    if (o !== null && o > 0) waitObj.set(s, o)
    return s
  })
  const [counts] = await Promise.all([
    rows(c.conn, COUNTS_SQL).catch(() => [] as Row[]),
    details(c.conn, sessions, waitObj).catch((e: Error) => log('db', 'details failed', { db: id, error: e.message }))
  ])
  const by = (k: string): number => num(counts.find((r) => r.STATUS === k)?.N) ?? 0
  return {
    at: Date.now(), db: t.id, env: t.env, via: t.via!.name,
    sessions: { active: by('ACTIVE'), inactive: by('INACTIVE'), total: counts.reduce((a, r) => a + (num(r.N) ?? 0), 0) },
    chains: buildChains(sessions)
  }
}

/** Statement text, locked objects, waited-on objects and transaction start times, filled into the sessions. */
async function details(conn: Connection, sessions: DbSession[], waitObj: Map<DbSession, number>): Promise<void> {
  if (!sessions.length) return
  const ids = [...new Set(sessions.flatMap((s) => [s.sqlId, s.prevSqlId]).filter((x): x is string => !!x))].slice(0, 50)
  const blockers = sessions.filter((s) => sessions.some((w) => w.blockingSid === s.sid && (w.blockingInst ?? w.inst) === s.inst))
  const sids = [...new Set(blockers.map((s) => s.sid))].slice(0, 100)
  const objIds = [...new Set(waitObj.values())].slice(0, 100)
  const [texts, locked, objs, tx] = await Promise.all([
    ids.length ? rows(conn, sqlTextSql(ids.length), ids) : Promise.resolve([]),
    sids.length ? rows(conn, lockedSql(sids.length), sids) : Promise.resolve([]),
    objIds.length ? rows(conn, objectsSql(objIds.length), objIds) : Promise.resolve([]),
    sids.length ? rows(conn, txSql(sids.length), sids) : Promise.resolve([])
  ])
  const text = new Map(texts.map((r) => [str(r.SQL_ID), str(r.SQL_TEXT)]))
  const obj = new Map(objs.map((r) => [num(r.OBJECT_ID), `${str(r.OWNER)}.${str(r.OBJECT_NAME)}`]))
  for (const s of sessions) {
    s.sqlText = s.sqlId ? text.get(s.sqlId) ?? null : null
    s.prevSqlText = s.prevSqlId ? text.get(s.prevSqlId) ?? null : null
    const o = waitObj.get(s)
    s.waitObject = s.blockingSid !== null && o ? obj.get(o) ?? null : null
    s.locked = locked.filter((r) => num(r.SESSION_ID) === s.sid && (num(r.INST_ID) ?? 1) === s.inst)
      .map((r) => ({ object: `${str(r.OWNER)}.${str(r.OBJECT_NAME)}`, type: str(r.OBJECT_TYPE) ?? '', mode: lockModeName(num(r.LOCKED_MODE) ?? 0) }))
    const t = tx.find((r) => num(r.SID) === s.sid && (num(r.INST_ID) ?? 1) === s.inst)
    s.txSince = t && num(t.START_EPOCH) !== null ? Math.round(num(t.START_EPOCH)! * 1000) : null
  }
}

/**
 * Ends one session with RDS's kill procedure. The session must still have the serial number that was shown (a sid is
 * reused once a session ends), be a user session of an application account, and production needs `PROD` typed.
 */
export async function dbKill(req: DbKillRequest & { confirm?: string }): Promise<{ message: string }> {
  if (!validKill(req)) throw new Error('Not a session this can end.')
  const t = await target(req.id)
  if (t.env === 'prod' && req.confirm !== 'PROD') throw new Error('Type PROD to end a session on the production database.')
  const c = await connect(t)
  const now = (await rows(c.conn, SESSION_NOW_SQL, { inst: req.inst, sid: req.sid, serial: req.serial }))[0]
  if (!now) throw new Error(`Session ${req.sid},${req.serial} has already ended.`)
  const s = { user: str(now.USERNAME), machine: str(now.MACHINE), program: str(now.PROGRAM), status: str(now.STATUS) ?? '', type: str(now.TYPE) ?? '' }
  const why = cannotKill(s, c.user)
  if (why) throw new Error(why)
  let result: DbAudit['result'] = 'done'
  let message = `Ended session ${req.sid},${req.serial} (${s.user}${s.machine ? ` on ${s.machine}` : ''}). Its open transaction is rolled back.`
  try {
    await c.conn.execute(KILL_SQL, { sid: req.sid, serial: req.serial })
  } catch (e) {
    result = 'failed'
    message = `Could not end session ${req.sid},${req.serial}: ${(e as Error).message.split('\n')[0]}`
  }
  await record({ at: Date.now(), by: await identity(t.profile), db: t.id, sid: req.sid, serial: req.serial, user: s.user, machine: s.machine, program: s.program, result, message })
  if (result === 'failed') throw new Error(message)
  return { message }
}

async function record(entry: DbAudit): Promise<void> {
  log('db', `kill ${entry.sid},${entry.serial} on ${entry.db}: ${entry.result}`, { by: entry.by, user: entry.user, machine: entry.machine })
  try { appendFileSync(auditFile(), `${JSON.stringify(entry)}\n`, { mode: 0o600 }) } catch (e) { log('db', 'audit write failed', { error: (e as Error).message }) }
}

/** The sessions ended from here, newest first. */
export function dbHistory(limit = 100): DbAudit[] {
  if (!existsSync(auditFile())) return []
  return readFileSync(auditFile(), 'utf8').trim().split('\n').slice(-limit)
    .map((l) => { try { return JSON.parse(l) as DbAudit } catch { return null } }).filter((x): x is DbAudit => !!x).reverse()
}

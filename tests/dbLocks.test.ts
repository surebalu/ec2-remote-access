import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildChains, cannotKill, dbEnvOf, lockModeName, parseSecret, secretScore, validKill, type DbSession } from '../src/shared/dbLocks.ts'

const s = (sid: number, blockingSid: number | null, waitSec: number | null = null, extra: Partial<DbSession> = {}): DbSession => ({
  inst: 1, sid, serial: sid * 10, user: 'APPUSER', osUser: 'tomcat', machine: 'ip-10-0-2-213', program: 'JDBC Thin Client', module: null, status: 'ACTIVE', type: 'USER',
  event: blockingSid === null ? null : 'enq: TX - row lock contention', waitClass: null, waitSec, lastCallSec: null, logonAt: null, sqlId: null, prevSqlId: null,
  sqlText: null, prevSqlText: null, blockingInst: blockingSid === null ? null : 1, blockingSid, waitObject: null, locked: [], txSince: null, ...extra
})

test('chains: each blocker at the head of everyone behind it, worst first', () => {
  // 10 blocks 11 and 12; 12 blocks 13 (13 waits behind 10 too); 20 blocks 21.
  const chains = buildChains([s(10, null), s(11, 10, 30), s(12, 10, 5), s(13, 12, 400), s(20, null), s(21, 20, 900)])
  assert.deepEqual(chains.map((c) => [c.root.sid, c.waiters.map((w) => `${w.s.sid}@${w.depth}`), c.longestWaitSec]), [
    [10, ['11@1', '12@1', '13@2'], 400],
    [20, ['21@1'], 900]
  ])
})

test('a deadlock Oracle has not broken yet still shows, with no session twice', () => {
  const chains = buildChains([s(1, 2, 3), s(2, 1, 4)])
  assert.equal(chains.length, 1)
  assert.equal(chains[0].waiters.length, 1)
})

test('a blocker on another instance is matched by instance and sid', () => {
  const chains = buildChains([s(5, null, null, { inst: 2 }), s(5, 5, 60, { inst: 1, blockingInst: 2 })])
  assert.deepEqual(chains.map((c) => [c.root.inst, c.waiters.map((w) => w.s.inst)]), [[2, [1]]])
})

test('which secret is a database master password', () => {
  const prod = { id: 'prod-ms-db', env: dbEnvOf('prod-ms-db') }
  const qa = { id: 'qa-ms-db', env: dbEnvOf('qa-ms-db') }
  const secrets: [string, string][] = [
    ['env-refresh/qa-3dspace-pwd', 'QA 3DSPACE schema password (must match DataModelConfig.xml)'],
    ['env-refresh/prod-master-pwd', 'PROD RDS Oracle master user password'],
    ['env-refresh/qa-master-pwd', 'QA RDS Oracle master user password'],
    ['mip/dev/n8n/rds-master', 'Master credentials for mip-dev-compute-rds-n8n']
  ]
  const best = (db: { id: string; env: ReturnType<typeof dbEnvOf> }): string => [...secrets].sort((a, b) => secretScore(b[0], b[1], db) - secretScore(a[0], a[1], db))[0][0]
  assert.equal(best(prod), 'env-refresh/prod-master-pwd')
  assert.equal(best(qa), 'env-refresh/qa-master-pwd')
  assert.equal(secretScore('env-refresh/qa-3dspace-pwd', 'QA 3DSPACE schema password', qa), 0, 'a schema password is not the master')
  assert.equal(secretScore('env-refresh/prod-master-pwd', 'PROD RDS Oracle master user password', qa), 0, 'not another environment\'s')
  assert.equal(secretScore('rds!db-abc123-xyz', '', { ...qa, resourceId: 'db-ABC123' }), 100, 'RDS\'s own secret for it')
  assert.equal(dbEnvOf('dev-ms-db'), 'dev')
  assert.equal(dbEnvOf('mip-dev-compute-rds-n8n'), 'dev')
  assert.equal(dbEnvOf('reporting'), null)
})

test('a secret is JSON or the password alone', () => {
  assert.deepEqual(parseSecret('{"username":"admin2","password":"p w"}', 'admin'), { user: 'admin2', password: 'p w' })
  assert.deepEqual(parseSecret('{"password":"x"}', 'admin'), { user: 'admin', password: 'x' })
  assert.deepEqual(parseSecret('  plain-secret \n', 'admin'), { user: 'admin', password: 'plain-secret' })
  assert.deepEqual(parseSecret('{not json', 'admin'), { user: 'admin', password: '{not json' })
  assert.throws(() => parseSecret('  ', 'admin'))
})

test('what may be ended', () => {
  assert.equal(cannotKill({ type: 'USER', user: 'APPUSER', status: 'INACTIVE' }, 'admin'), null)
  assert.match(cannotKill({ type: 'BACKGROUND', user: null, status: 'ACTIVE' }, 'admin')!, /background/)
  assert.match(cannotKill({ type: 'USER', user: 'SYS', status: 'ACTIVE' }, 'admin')!, /system account/)
  assert.match(cannotKill({ type: 'USER', user: 'RDSADMIN', status: 'ACTIVE' }, 'admin')!, /system account/)
  assert.match(cannotKill({ type: 'USER', user: 'ADMIN', status: 'ACTIVE' }, 'admin')!, /reads with/)
  assert.ok(validKill({ id: 'prod-ms-db', inst: 1, sid: 123, serial: 4567 }))
  assert.ok(!validKill({ id: 'prod-ms-db', inst: 1, sid: 1.5, serial: 4567 }))
  assert.ok(!validKill({ id: "x'; drop", inst: 1, sid: 1, serial: 1 }))
  assert.equal(lockModeName(3), 'Row exclusive')
  assert.equal(lockModeName(6), 'Exclusive')
})

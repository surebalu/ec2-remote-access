import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkNote, envOf, parseLicense, gcTrend, isFullGc, formatBytes, formatDuration, formatMs, formatPct, ipOf, isFrontProbe, levelBelow, levelOf, LIMITS, nodeLabel, probeOk, roleOf, serviceLevel, verdict, worst, type Endpoint, type ServiceNode } from '../src/shared/plmHealth.ts'

test('addresses come out of node, JMX, Apache and probe labels alike', () => {
  assert.equal(ipOf('10.0.2.175:9100'), '10.0.2.175')
  assert.equal(ipOf('ip-10-1-5-52.us-west-1.compute.internal:9404'), '10.1.5.52')
  assert.equal(ipOf('http://ip-10-1-5-114.us-west-1.compute.internal:8080/3dpassport/healthcheck'), '10.1.5.114')
  assert.equal(ipOf('http://10.0.2.96:5001/swagger-ui/index.html#'), '10.0.2.96')
  assert.equal(ipOf('https://pass-pplm.mainspring.network/3dpassport/healthcheck'), null)
})

test('the environment comes from the job name or a public address, and mixed jobs are left to the caller', () => {
  assert.equal(envOf('PROD 3DSpace Server 01', '10.1.2.144:9100'), 'prod')
  assert.equal(envOf('Production Environment Service HTTP Healthcheck', 'http://ip-10-1-2-133.us-west-1.compute.internal:8080/3dpassport/healthcheck'), 'prod')
  assert.equal(envOf('QA Envt Apache Server 02', 'ip-10-0-5-12.us-west-1.compute.internal:9117'), 'qa')
  assert.equal(envOf('Development Server', '10.0.2.149:9100'), 'dev')
  assert.equal(envOf('Development 3DSpace JVM Details'), 'dev')
  assert.equal(envOf('QA Environment ALB Healthcheck', 'https://space-qplm.mainspring.network/3dspace/servlet/fcs/ping'), 'qa')
  // The URL wins over a generic job.
  assert.equal(envOf('Apache Service HTTP Healthcheck', 'https://help-dplm.mainspring.network/English'), 'dev')
  assert.equal(envOf('QA and Dev CAD Converter URL', 'http://10.0.2.96:5001/swagger-ui/index.html#'), null)
  assert.equal(envOf('Dev & QA Migration Servers', '10.0.2.28:9182'), null)
  assert.equal(envOf('Apache Service HTTP Healthcheck', 'http://ip-10-0-5-12.us-west-1.compute.internal:80'), null)
})

test('each series finds its part of the platform, a probe by its address first', () => {
  const r = (job: string, instance = ''): string | undefined => roleOf(job, instance)?.id
  assert.equal(r('QA 3DPassport Server 02', '10.0.5.24:9100'), 'passport')
  assert.equal(r('Production Environment ALB Healthcheck', 'https://space-pplm.mainspring.network/3dspace/servlet/fcs/ping'), 'space')
  assert.equal(r('Production Environment ALB Healthcheck', 'https://space-pplm.mainspring.network/internal/servlet/fcs/ping'), 'space')
  assert.equal(r('Production Environment ALB Healthcheck', 'https://fcs-pplm.mainspring.network/fcs/servlet/fcs/ping'), 'fcs')
  assert.equal(r('QA Environment Service HTTP Healthcheck', 'http://ip-10-0-2-119.us-west-1.compute.internal:8050/federated/manager?query=monitoring'), 'search')
  assert.equal(r('Production Environment Service HTTP Healthcheck', 'http://ip-10-1-2-194.us-west-1.compute.internal:19010/search-api/isAlive'), 'index')
  assert.equal(r('QA Environment Service HTTP Healthcheck', 'http://ip-10-0-2-217.us-west-1.compute.internal:19000'), 'index')
  assert.equal(r('QA 3DSpaceIndex Server', '10.0.2.217:9100'), 'index')
  assert.equal(r('PROD 3DSpace DerivedObjectsServer Server'), 'converter')
  assert.equal(r('QA 3DSpace Derived Object Converter Server'), 'converter')
  assert.equal(r('PROD 3DSpace 01 JVM Details'), 'space')
  assert.equal(r('QA and Dev CAD Converter URL', 'http://10.0.2.58:5001/swagger-ui/index.html#'), 'cad')
  assert.equal(r('Production Environment Service HTTP Healthcheck', 'http://ip-10-1-5-55.us-west-1.compute.internal:8181/enovia/adminui'), 'tif')
  assert.equal(r('QA Environment ALB Healthcheck', 'https://help-qplm.mainspring.network/English'), 'docs')
  assert.equal(r('Apache Service HTTP Healthcheck', 'http://ip-10-0-2-99.us-west-1.compute.internal:80'), 'apache')
  assert.equal(r('PROD Envt Apache Server 01'), 'apache')
  assert.equal(r('PROD FTS Primary Server'), 'index')
  assert.equal(r('PROD Federated Server 02'), 'search')
  assert.equal(r('Development Server'), 'allinone')
  assert.equal(r('Production Migration Servers'), 'migration')
  assert.equal(r('PrometheusServer'), 'monitoring')
  assert.equal(r('QA 3DNotification Server'), 'notification')
  assert.equal(r('Production Environment ALB Healthcheck', 'https://notif-pplm.mainspring.network/3dnotification/healthcheck'), 'notification')
})

test('servers are told apart as Finder… as 01, 02, Primary', () => {
  assert.equal(nodeLabel('QA 3DPassport Server 02'), '02')
  assert.equal(nodeLabel('PROD 3DSpace 01 JVM Details'), '01')
  assert.equal(nodeLabel('PROD FTS Secondary Server'), 'Secondary')
  assert.equal(nodeLabel('QA 3DSwym Server'), '')
  assert.equal(nodeLabel('QA 3DSpace Server 01'), '01')
})

test('load balancer checks are told from server checks, and redirects count as up', () => {
  assert.equal(isFrontProbe('QA Environment ALB Healthcheck', 'https://pass-qplm.mainspring.network/3dpassport/healthcheck'), true)
  assert.equal(isFrontProbe('QA Environment Service HTTP Healthcheck', 'http://ip-10-0-2-175.us-west-1.compute.internal:8080/3dpassport/healthcheck'), false)
  assert.equal(probeOk(302, 0), true)
  assert.equal(probeOk(0, 0), false)
  assert.equal(probeOk(null, 1), true)
})

test('levels follow the thresholds, and stopped or unknown parts never make things look worse', () => {
  assert.equal(levelOf(86.3, LIMITS.disk), 'crit')
  assert.equal(levelOf(80, LIMITS.disk), 'warn')
  assert.equal(levelOf(null, LIMITS.disk), 'unknown')
  assert.equal(levelBelow(5, LIMITS.certDays), 'crit')
  assert.equal(levelBelow(20, LIMITS.certDays), 'warn')
  assert.equal(levelBelow(300, LIMITS.certDays), 'ok')
  assert.equal(worst(['ok', 'off', 'unknown']), 'ok')
  assert.equal(worst(['off', 'off']), 'off')
  assert.equal(worst(['ok', 'warn', 'crit', 'off']), 'crit')
})

const ep = (level: Endpoint['level']): Endpoint => ({ url: 'u', level, status: level === 'crit' ? 0 : 200, ms: 10 })
let nodeN = 0
const node = (level: Endpoint['level'], stopped = false): ServiceNode => ({ ...ep(level), label: '01', ip: `10.0.0.${++nodeN}`, name: 'n', stopped })

test('a service is down when users cannot reach it, degraded when one server is, and a stopped server is only noted', () => {
  assert.equal(serviceLevel([ep('crit')], [node('ok')]).level, 'crit')
  assert.equal(serviceLevel([ep('ok')], [node('crit'), node('ok')]).level, 'warn')
  assert.equal(serviceLevel([ep('ok')], [node('crit'), node('crit')]).level, 'crit')
  const stopped = serviceLevel([ep('ok')], [node('ok'), node('crit', true)])
  assert.equal(stopped.level, 'ok')
  assert.match(stopped.summary, /1 stopped/)
  assert.equal(serviceLevel([], [node('crit', true)]).level, 'off')
})

test('the headline names an outage first, then counts problems', () => {
  const svc = (name: string, level: Endpoint['level']) => ({ id: name, name, blurb: '', level, summary: '', fronts: [], nodes: [] })
  assert.equal(verdict([], [svc('3DSpace', 'ok')]).headline, 'All systems operational')
  assert.equal(verdict([{ level: 'crit', text: 'x', section: 'services' }], [svc('3DPassport', 'crit')]).headline, '3DPassport is down')
  const v = verdict([{ level: 'warn', text: 'disk', section: 'storage' }, { level: 'crit', text: 'db', section: 'db' }], [svc('3DSpace', 'ok')])
  assert.equal(v.headline, '1 problem needs attention')
  assert.deepEqual(v.issues.map((i) => i.text), ['db', 'disk'])
})

test('numbers read the way people say them', () => {
  assert.equal(formatBytes(8589934592), '8.0 GB')
  assert.equal(formatBytes(510027366400), '475 GB')
  assert.equal(formatDuration(138172.991), '1d 14h')
  assert.equal(formatMs(1500), '1.5 s')
  assert.equal(formatMs(42.4), '42 ms')
  assert.equal(formatPct(86.34), '86%')
  assert.equal(formatPct(4.25), '4.3%')
})

test('full collections are told from partial and young ones across JVMs', () => {
  for (const n of ['global garbage collect', 'G1 Old Generation', 'PS MarkSweep', 'ConcurrentMarkSweep', 'MarkSweepCompact']) assert.equal(isFullGc(n), true, n)
  for (const n of ['partial gc', 'scavenge', 'G1 Young Generation', 'PS Scavenge', 'ParNew', 'Copy']) assert.equal(isFullGc(n), false, n)
})

const GB = 1024 ** 3
const hourly = (n: number, f: (i: number) => number): { t: number[]; v: (number | null)[] } => ({ t: Array.from({ length: n }, (_, i) => i * 3_600_000), v: Array.from({ length: n }, (_, i) => f(i)) })

test('the heap after GC tells a healthy saw-tooth from a leak, as on the GCeasy graph', () => {
  // Drops back to the same level after every collection.
  const flat = hourly(48, (i) => 1.5 * GB + (i % 3) * 0.02 * GB)
  const ok = gcTrend(flat.t, flat.v, 8 * GB)
  assert.equal(ok.level, 'ok')
  assert.match(ok.text, /Healthy saw-tooth.*1\.5 GB \(19% of 8\.0 GB\)/)
  // Climbing a GB a day: a leak, with days left until full.
  const leak = hourly(72, (i) => 2 * GB + (i / 24) * GB)
  const l = gcTrend(leak.t, leak.v, 8 * GB)
  assert.equal(l.level, 'warn')
  assert.match(l.text, /about 1\.0 GB a day.*full in 3 days.*Possible memory leak/)
  assert.ok(l.line && l.line[3] > l.line[1], 'a rising line to draw')
  // Stuck near the maximum while collections run: the collector cannot free it.
  const stuck = hourly(24, () => 7.5 * GB)
  assert.equal(gcTrend(stuck.t, stuck.v, 8 * GB).level, 'crit')
  // Caches filling after a restart, then levelling off: not a leak.
  const warm = hourly(36, (i) => (i < 12 ? 3.2 * GB + i * 0.1 * GB : 4.4 * GB))
  const w = gcTrend(warm.t, warm.v, 8 * GB, 0)
  assert.equal(w.level, 'ok')
  assert.match(w.text, /levelled off/)
  assert.doesNotMatch(gcTrend(warm.t, warm.v, 8 * GB).text, /restart/, 'no restart on screen, no restart note')
  // Before the JVM started does not count.
  const restart = hourly(48, (i) => (i < 24 ? 7.6 * GB : 1.2 * GB))
  assert.equal(gcTrend(restart.t, restart.v, 8 * GB, 24 * 3_600_000).level, 'ok')
  assert.equal(gcTrend([1, 2], [1, 2], 8 * GB).level, 'unknown')
})

test('a service counts machines, not checks, and says when its check is not running or missing', () => {
  const n = (ip: string, url: string, level: 'ok' | 'crit' | 'unknown' = 'ok', stopped = false): ServiceNode => ({ url, level, status: 200, ms: 5, label: '01', ip, name: ip, stopped })
  // 3DSpace: two checks on each of two servers.
  assert.equal(serviceLevel([ep('ok')], [n('a', 'a/3dspace'), n('a', 'a/internal'), n('b', 'b/3dspace'), n('b', 'b/internal')]).summary, '2 servers up')
  assert.equal(serviceLevel([ep('ok')], [n('a', 'a/3dspace', 'crit'), n('a', 'a/internal', 'crit'), n('b', 'b/3dspace')]).summary, '1 of 2 servers down, still served')
  assert.deepEqual(serviceLevel([], [n('a', 'a', 'unknown')]), { level: 'unknown', summary: 'Its health check is not running' })
  assert.equal(serviceLevel([], []).summary, 'Not checked: only its servers are monitored')
})

test('checks that only load a page are told from real health endpoints', () => {
  assert.match(checkNote('https://federated-qplm.mainspring.network/federated/manager?query=monitoring') ?? '', /login page/)
  assert.ok(checkNote('http://10.0.2.58:5001/swagger-ui/index.html#'))
  assert.ok(checkNote('http://ip-10-0-2-113.us-west-1.compute.internal:8181/enovia/adminui'))
  assert.ok(checkNote('https://help-qplm.mainspring.network/English'))
  assert.ok(checkNote('http://ip-10-0-2-217.us-west-1.compute.internal:19000'))
  assert.ok(checkNote('http://ip-10-0-2-99.us-west-1.compute.internal:80'))
  for (const u of ['https://pass-pplm.mainspring.network/3dpassport/healthcheck', 'http://ip-10-1-2-194.us-west-1.compute.internal:19010/search-api/isAlive', 'https://space-pplm.mainspring.network/3dspace/servlet/fcs/ping', 'https://dash-pplm.mainspring.network/3ddashboard/test-alive']) assert.equal(checkNote(u), null, u)
})

test('the license server check reads status, version and each server reached, and leaves out the license file', () => {
  const block = [
    'Dump of DSLS configuration file (/var/DassaultSystemes/Licenses/DSLicSrv.txt)', '---------------', '',
    '1 license servers declared: ',
    'r1-usw1-licensing.3dexperience.3ds.com:443,r1-usw1-licensing-1.3dexperience.3ds.com:443',
    '   + status       : RUNNING', '   + type         : MANAGED', '   + version      : 6.428.3', '   + build date   : 05-Feb-2026 12:17',
    '   + offline licenses : Enabled', '   + auth. file   : /var/DassaultSystemes/Licenses/AAAAA-BBBBB_0000_1.LIC', '   + customer id  : R123',
    '   + r1-usw1-licensing.3dexperience.3ds.com : ', '         + IP address   : 157.250.13.209', '         + port         : 443', '         + round-trip   : 3 ms', '         + OS name      : Linux', '         + OS version   : 4.18.0',
    '   + r1-usw1-licensing-1.3dexperience.3ds.com : ', '         + IP address   : 157.250.12.74', '         + port         : 443', '         + round-trip   : 12 ms'
  ]
  const l = parseLicense(block, 1000)!
  assert.deepEqual([l.status, l.type, l.version, l.offline, l.level], ['RUNNING', 'MANAGED', '6.428.3', 'Enabled', 'ok'])
  assert.deepEqual(l.nodes, [
    { host: 'r1-usw1-licensing.3dexperience.3ds.com', ip: '157.250.13.209', port: '443', rttMs: 3 },
    { host: 'r1-usw1-licensing-1.3dexperience.3ds.com', ip: '157.250.12.74', port: '443', rttMs: 12 }
  ])
  assert.ok(!JSON.stringify(l).includes('LIC') && !JSON.stringify(l).includes('R123'), 'no license file or customer id')
  assert.equal(parseLicense(block.map((x) => x.replace('RUNNING', 'NOT REACHABLE')), 1)!.level, 'crit')
  assert.equal(parseLicense(['nothing here'], 1), null)
})

test('a server whose check is not running is counted apart, never as up', () => {
  const n = (ip: string, level: 'ok' | 'crit' | 'unknown'): ServiceNode => ({ url: ip, level, status: null, ms: null, label: ip, ip, name: ip, stopped: false })
  assert.deepEqual(serviceLevel([], [n('a', 'ok'), n('b', 'unknown')]), { level: 'ok', summary: 'Up · 1 not checked' })
  assert.equal(serviceLevel([], [n('a', 'crit'), n('b', 'unknown')]).level, 'crit')
  assert.equal(serviceLevel([], [n('a', 'unknown'), n('b', 'unknown')]).summary, 'Its health check is not running')
})

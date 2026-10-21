import { test } from 'node:test'
import assert from 'node:assert/strict'
import { envOf, formatBytes, formatDuration, formatMs, formatPct, ipOf, isFrontProbe, levelBelow, levelOf, LIMITS, nodeLabel, probeOk, roleOf, serviceLevel, verdict, worst, type Endpoint, type ServiceNode } from '../src/shared/plmHealth.ts'

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
const node = (level: Endpoint['level'], stopped = false): ServiceNode => ({ ...ep(level), label: '01', ip: '10.0.0.1', name: 'n', stopped })

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

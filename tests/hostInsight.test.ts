import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatRate, fullestOwnDisk, parseProcess, parseSnapshot, peers, portName, processScript, sections, snapshotScript, techOf, technologies } from '../src/shared/hostInsight.ts'

const SNAP = `@@UPTIME
15206400.55 900000.00
@@CPUS
4
@@LOAD
0.52 0.40 0.31 1/300 4242
@@MEM
MemTotal:        3881104 kB
MemAvailable:    1940552 kB
SwapTotal:             0 kB
SwapFree:              0 kB
@@OS
Red Hat Enterprise Linux 8.10 (Ootpa)
4.18.0-553.el8_10.x86_64
@@DF
/dev/nvme0n1p4 xfs 52305457152 7314505728 44990951424 14% /
/dev/mapper/vg-apps xfs 32145637376 7686225920 24459411456 24% /apps/DassaultSystemes
fs-1.efs.us-west-1.amazonaws.com:/ nfs4 10200547328 1712128 10198835200 1% /3ddashboarddata
@@DEVMAP
/dev/mapper/vg-apps /dev/dm-0
@@STAT1
cpu  1000 0 500 8000 100 0 0 0 0 0
@@STAT2
cpu  1200 0 600 8600 100 0 0 0 0 0
@@NET
eth0 100000 400000 200 100 1 0 0 2
@@DISK
nvme0n1p4 10 1000 40 20480
dm-0 0 0 4 64
@@PCPU
4242 400
@@PS
   4242       1 tomcat                              15000000 1342177 300 java /usr/lib/jvm/java/bin/java -Dcatalina.home=/usr/DassaultSystemes/tomee org.apache.catalina.startup.Bootstrap start
    880       1 root                                15206000   16000   7 node_exporter /opt/node_exporter/node_exporter
     99       1 root                                     100     800   1 my proc (x) /bin/my proc
@@UNITS
4242 3ddashboard.service
880 node_exporter.service
@@LISTEN
LISTEN 0 100 *:8060 *:* users:(("java",pid=4242,fd=50))
LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=900,fd=3))
LISTEN 0 4096 [::]:9100 [::]:* users:(("node_exporter",pid=880,fd=3))
@@EST
     12 in 8060 10.1.2.52 - 4242
      1 out - 10.1.2.144 8070 4242
      2 out - 10.0.2.105 9090 -
@@END
`

test('the snapshot comes back as rates over the sample, with processes, units, ports and connections', () => {
  const s = parseSnapshot(SNAP, 1000)
  assert.equal(s.cpus, 4)
  assert.deepEqual(s.load, [0.52, 0.4, 0.31])
  assert.equal(Math.round(s.cpuPct!), 33, '300 busy ticks of 900')
  assert.equal(s.memTotal, 3881104 * 1024)
  assert.equal(s.os, 'Red Hat Enterprise Linux 8.10 (Ootpa)')
  assert.equal(s.uptimeSec, 15206400.55)
  const root = s.disks.find((d) => d.mount === '/')!
  assert.equal(root.fs, 'xfs')
  assert.equal(root.readBps, (1000 * 512) / 2)
  assert.equal(root.writeBps, (20480 * 512) / 2)
  assert.equal(root.writeIops, 20)
  assert.equal(s.disks.find((d) => d.mount === '/apps/DassaultSystemes')!.writeIops, 2, 'an LVM volume is found under its dm name')
  assert.equal(s.disks.find((d) => d.mount === '/3ddashboarddata')!.readBps, null, 'a network store has no diskstats')
  assert.deepEqual(s.nets.map((n) => [n.iface, n.rxBps, n.txBps, n.txDrop]), [['eth0', 50000, 200000, 2]])
  const java = s.processes.find((p) => p.pid === 4242)!
  assert.equal(java.tech, 'Apache TomEE', 'Tomcat started from a TomEE folder')
  assert.equal(java.unit, '3ddashboard.service')
  assert.equal(java.cpuPct, (400 / 100 / 2 / 4) * 100, 'ticks over the sample, as a share of all four cores')
  assert.equal(java.rssBytes, 1342177 * 1024)
  assert.equal(s.processes.find((p) => p.pid === 99)!.cpuPct, 0, 'not in the CPU list: it used none')
  assert.deepEqual(s.listening.map((l) => [l.port, l.process]), [[8060, 'java'], [22, 'sshd'], [9100, 'node_exporter']])
  assert.deepEqual(s.connections.map((c) => [c.count, c.direction, c.localPort, c.remote, c.remotePort, c.process]), [
    [12, 'in', 8060, '10.1.2.52', null, 'java'], [1, 'out', null, '10.1.2.144', 8070, 'java'], [2, 'out', null, '10.0.2.105', 9090, null]
  ])
  assert.deepEqual(technologies(s.processes).map((t) => t.tech), ['Apache TomEE', 'Prometheus node exporter', 'Other'])
})

test('one process in detail, or gone', () => {
  const out = `@@CPUS
2
@@PS
   4242       1 tomcat 15000000 1342177 4000000 300 java /usr/bin/java -jar tomee.jar
@@STARTED
Mon Apr 28 14:42:39 2026
@@STATUS
State:	S (sleeping)
Threads:	300
VmHWM:	 1500000 kB
VmSwap:	       0 kB
@@UNIT
3dspace.service
@@FDS
812
@@LIMIT
Max open files            65536                65536                files
@@EXE
/usr/lib/jvm/java/bin/java
/usr/DassaultSystemes/tomee
@@T1
4242 (java) S 1 4242 4242 0 -1 0 0 0 0 0 10000 2000 0 0 20 0 300 0 100 0 0
@@T2
4242 (java) S 1 4242 4242 0 -1 0 0 0 0 0 10040 2010 0 0 20 0 300 0 100 0 0
@@LISTEN
LISTEN 0 100 *:8090 *:* users:(("java",pid=4242,fd=50))
@@EST
      3 in 8090 10.1.2.52 - 4242
@@END
`
  const p = parseProcess(out, 4242, 1)
  assert.equal(p.gone, false)
  assert.deepEqual([p.user, p.threads, p.unit, p.fds, p.fdLimit, p.exe, p.cwd], ['tomcat', 300, '3dspace.service', 812, 65536, '/usr/lib/jvm/java/bin/java', '/usr/DassaultSystemes/tomee'])
  assert.equal(p.cpuPct, (50 / 100 / 2) * 100)
  assert.equal(p.hwmBytes, 1500000 * 1024)
  assert.equal(p.state, 'S (sleeping)')
  assert.equal(p.tech, 'Apache TomEE')
  assert.deepEqual(p.connections.map((c) => [c.direction, c.count, c.process]), [['in', 3, 'java']])
  assert.equal(parseProcess('@@GONE\n', 7, 1).gone, true)
  assert.throws(() => processScript(Number('1; rm -rf /')))
  assert.throws(() => processScript(-1))
  assert.match(processScript(4242)[1], /^P=4242$/)
})

test('technologies are named from the process', () => {
  assert.equal(techOf('httpd', '/usr/sbin/httpd -DFOREGROUND', 1), 'Apache HTTP Server')
  assert.equal(techOf('java', '/jdk/bin/java -javaagent:/opt/jmx_prometheus_javaagent.jar=9404:c.yml -Dcatalina.base=/usr/DS/tomee org.apache.catalina.startup.Bootstrap start', 1), 'Apache TomEE', 'the JMX agent does not make it an exporter')
  assert.equal(techOf('kworker/0:1', '[kworker/0:1]', 2), 'Linux kernel')
  assert.equal(techOf('amazon-ssm-agen', '/usr/bin/amazon-ssm-agent', 1), 'AWS Systems Manager agent')
  assert.equal(techOf('oneagentos', '/opt/dynatrace/oneagent/agent/lib64/oneagentos', 1), 'Dynatrace OneAgent')
  assert.ok(sections(snapshotScript().join('\n')).size === 0, 'the script itself has no markers on their own lines')
})

test('connections fold into one row per machine, named from the inventory', () => {
  const s = parseSnapshot(SNAP, 1000)
  const names = (ip: string): string | null => (ip === '10.1.2.52' ? 'Apache 01' : null)
  assert.deepEqual(peers(s.connections, 'in', names), [{ remote: '10.1.2.52', name: 'Apache 01', ports: [8060], connections: 12, processes: ['java'] }])
  assert.deepEqual(peers(s.connections, 'out', names).map((p) => [p.remote, p.ports, p.connections]), [['10.0.2.105', [9090], 2], ['10.1.2.144', [8070], 1]])
  assert.equal(portName(1521), 'Oracle')
  assert.equal(portName(12345), null)
  assert.equal(formatRate(1536), '1.5 KB/s')
  assert.equal(formatRate(null), '–')
  assert.equal(fullestOwnDisk(s.disks)?.mount, '/apps/DassaultSystemes', 'the EFS share is left out')
})

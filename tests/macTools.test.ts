import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatBits, interfaceLabel, isFinishedDownload, parseProcesses, parseSpeedTest, quitAllPlan, rpmWord, sortProcesses } from '../src/shared/macTools.ts'

test('ps lines become processes, an app’s main process named after the app', () => {
  const text = [
    '  501     1 sbalu    12.5  204800 /Applications/Visual Studio Code.app/Contents/MacOS/Electron',
    '  777   501 sbalu     3.0   10240 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper',
    '   88     1 root      0.0    2048 /usr/sbin/syslogd',
    'garbage'
  ].join('\n')
  const list = parseProcesses(text)
  assert.equal(list.length, 3)
  assert.deepEqual({ ...list[0] }, { pid: 501, ppid: 1, user: 'sbalu', cpu: 12.5, memory: 204800 * 1024, command: '/Applications/Visual Studio Code.app/Contents/MacOS/Electron', name: 'Visual Studio Code', app: '/Applications/Visual Studio Code.app' })
  assert.equal(list[1].name, 'Code Helper')
  assert.equal(list[2].name, 'syslogd')
  assert.equal(list[2].app, undefined)
  assert.deepEqual(sortProcesses(list, 'sbalu').map((p) => p.pid), [501, 777, 88])
})

test('networkQuality’s JSON', () => {
  const r = parseSpeedTest(JSON.stringify({ dl_throughput: 412_345_678, ul_throughput: 23_456_789, responsiveness: 1234.6, base_rtt: 18.4, interface_name: 'en0', test_endpoint: 'sjc-edge' }))
  assert.deepEqual(r, { download: 412_345_678, upload: 23_456_789, rpm: 1235, idleMs: 18, interface: 'en0', server: 'sjc-edge' })
  assert.equal(parseSpeedTest('not json'), null)
  assert.equal(parseSpeedTest('{}'), null)
  assert.equal(formatBits(412_345_678), '412 Mbps')
  assert.equal(formatBits(23_456_789), '23.5 Mbps')
  assert.equal(formatBits(1_250_000_000), '1.25 Gbps')
  assert.equal(formatBits(850_000), '850 kbps')
  assert.deepEqual([rpmWord(200), rpmWord(500), rpmWord(2000)], ['Low', 'Medium', 'High'])
})

test('interfaces in words', () => {
  assert.equal(interfaceLabel('en0', '192.168.0.20', 'en0'), 'Wi-Fi (en0)')
  assert.equal(interfaceLabel('en7', '10.0.0.4', 'en0'), 'Ethernet (en7)')
  assert.equal(interfaceLabel('utun4', '100.101.7.3', 'en0'), 'Tailscale')
  assert.equal(interfaceLabel('utun2', '10.8.0.2', 'en0'), 'VPN (utun2)')
})

test('downloads still arriving, and hidden files, are not offered', () => {
  assert.deepEqual(['report.pdf', '.DS_Store', 'big.iso.download', 'x.crdownload', 'y.part', 'Icon\r'].filter(isFinishedDownload), ['report.pdf'])
})

test('Quit All Apps leaves Finder and this app', () => {
  const plan = quitAllPlan([
    { id: 'com.apple.finder', name: 'Finder', pid: 10, type: 'Foreground' },
    { id: 'com.mainspring.ec2-remote-access', name: 'EC2 Remote Access', pid: 11, type: 'Foreground' },
    { id: 'com.tinyspeck.slackmacgap', name: 'Slack', pid: 12, type: 'Foreground' },
    { id: 'com.apple.Safari', name: 'Safari', pid: 13, type: 'Foreground' },
    { id: 'com.apple.dock', name: 'Dock', pid: 14, type: 'UIElement' }
  ], ['com.apple.Safari'])
  assert.deepEqual(plan.apps, [{ pid: 12, name: 'Slack' }])
  assert.deepEqual(plan.kept, ['Finder', 'EC2 Remote Access', 'Safari'])
})

// What networkQuality wrote under a pseudo-terminal on this Mac (live lines over each other, then the summary).
const TTY = '\x04\b\b\r\x1b[2K\rDownlink: 18.602 Mbps, 0 RPM - Uplink: 0.000 Mbps, 0 RPM\r\x1b[2K\rDownlink: 357.749 Mbps, 0 RPM - Uplink: 73.016 Mbps, 0 RPM\r\x1b[2K\rDownlink: 1124.724 Mbps, 1613 RPM - Uplink: 342.614 Mbps, 1613 RPM\r\x1b[2K==== Verbose Results ====\r\n   Test Endpoint: usewr1-edge-bx-026.aaplimg.com\r\n   Interface: en13\r\n==== SUMMARY ====\r\nUplink capacity: 342.614 Mbps\r\nDownlink capacity: 1.098 Gbps\r\nResponsiveness: High (37.196 milliseconds | 1613 RPM)\r\nIdle Latency: 25.824 milliseconds | 2323 RPM\r\n'

test('networkQuality’s live lines and summary', async () => {
  const { parseSpeedProgress, parseSpeedSummary, capacityBps } = await import('../src/shared/macTools.ts')
  assert.deepEqual(parseSpeedProgress(TTY), [{ down: 18.602, up: 0, rpm: 0 }, { down: 357.749, up: 73.016, rpm: 0 }, { down: 1124.724, up: 342.614, rpm: 1613 }])
  const r = parseSpeedSummary(TTY)!
  assert.deepEqual([r.download, r.upload, r.rpm, r.idleMs, r.rating, r.workingMs, r.interface, r.server], [1_098_000_000, 342_614_000, 1613, 25.8, 'High', 37.2, 'en13', 'usewr1-edge-bx-026.aaplimg.com'])
  assert.equal(parseSpeedSummary('Downlink: 1 Mbps, 0 RPM - Uplink: 1 Mbps, 0 RPM'), null, 'no summary yet')
  assert.equal(capacityBps('850.5 Kbps'), 850_500)
})

test('the gauge’s scale and what a speed is good for', async () => {
  const { gaugeFraction, speedCapabilities, ispName } = await import('../src/shared/macTools.ts')
  assert.equal(gaugeFraction(0), 0)
  assert.equal(gaugeFraction(1), 1 / 7)
  assert.equal(gaugeFraction(100), 5 / 7)
  assert.ok(Math.abs(gaugeFraction(300) - (5 + 0.5) / 7) < 1e-9)
  assert.equal(gaugeFraction(1568), 1)
  const fast = speedCapabilities(1.5e9, 1.4e9)
  assert.ok([...fast.voice, ...fast.video, ...fast.streaming].every((x) => x.ok))
  const slow = speedCapabilities(4e6, 1.2e6)
  assert.deepEqual(slow.video.map((x) => x.ok), [true, false, false, false])
  assert.deepEqual(slow.streaming.map((x) => x.ok), [true, false, false, false])
  assert.equal(ispName('AS5650 Frontier Communications of America, Inc.'), 'Frontier Communications of America')
})

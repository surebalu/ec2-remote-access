import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultSessionFor, deviceName, parseTailnetStatus, tailnetKey, type TailnetStatusJson } from '../src/shared/tailnet.ts'

// Shaped like `tailscale status --json` from a real tailnet (names and addresses changed).
const status: TailnetStatusJson = {
  BackendState: 'Running',
  CurrentTailnet: { Name: 'someone@example.com', MagicDNSSuffix: 'tail0000.ts.net' },
  Self: { ID: 'nSELF', HostName: 'Work MacBook Pro', DNSName: 'work-macbook-pro.tail0000.ts.net.', OS: 'macOS', TailscaleIPs: ['100.98.1.1', 'fd7a:115c:a1e0::1'], Online: true, LastSeen: '0001-01-01T00:00:00Z' },
  Peer: {
    'nodekey:a': { ID: 'nWIN', HostName: 'GRAPHICS-PC', DNSName: 'graphics-pc.tail0000.ts.net.', OS: 'windows', TailscaleIPs: ['100.72.2.2', 'fd7a:115c:a1e0::2'], Online: false, LastSeen: '2026-10-16T14:07:14.1Z' },
    'nodekey:b': { ID: 'nPHONE', HostName: 'localhost', DNSName: 'iphone182.tail0000.ts.net.', OS: 'iOS', TailscaleIPs: ['100.123.3.3'], Online: true },
    'nodekey:c': { ID: 'nPI', HostName: 'raspberrypi', DNSName: 'raspberrypi.tail0000.ts.net.', OS: 'linux', TailscaleIPs: ['fd7a:115c:a1e0::4', '100.100.4.4'], Online: true, Tags: ['tag:server'] },
    'nodekey:d': { ID: 'nSHARED', HostName: 'friends-mac', DNSName: 'friends-mac.other.ts.net.', OS: 'macOS', TailscaleIPs: ['100.90.5.5'], Online: true, ShareeNode: true },
    'nodekey:e': { HostName: 'no id', OS: 'linux', TailscaleIPs: ['100.1.1.1'] }
  }
}

test('computers become hosts routed to their Tailscale address; phones are left out', () => {
  const st = parseTailnetStatus(status)
  assert.equal(st.running, true)
  assert.equal(st.tailnet, 'someone@example.com')
  assert.deepEqual(st.devices.map((d) => d.name), ['Work MacBook Pro', 'friends-mac', 'raspberrypi', 'GRAPHICS-PC'], 'this computer first, then online ones, then offline, by name')
  const pi = st.devices.find((d) => d.name === 'raspberrypi')!
  assert.equal(pi.key, tailnetKey('nPI'))
  assert.equal(pi.publicIp, '100.100.4.4', 'the IPv4 address even when IPv6 is listed first')
  assert.equal(pi.instanceId, 'raspberrypi.tail0000.ts.net', 'MagicDNS name without the trailing dot')
  assert.equal(pi.manual, true, 'routed like a hand-added server: directly, no AWS actions')
  assert.equal(pi.region, 'Tailscale')
  assert.equal(pi.tags.Tags, 'tag:server')
  const win = st.devices.find((d) => d.name === 'GRAPHICS-PC')!
  assert.equal(win.platform, 'windows')
  assert.equal(win.state, 'stopped')
  assert.equal(win.tailnet?.lastSeen, '2026-10-16T14:07:14.1Z')
  const mac = st.devices[0]
  assert.equal(mac.tailnet?.self, true)
  assert.equal(mac.state, 'running')
  assert.equal(mac.tailnet?.lastSeen, undefined, 'the zero time Tailscale reports for itself is not a date')
  assert.equal(st.devices.find((d) => d.name === 'friends-mac')!.tags.Shared, 'Shared from another tailnet')
})

test('a stopped or logged-out Tailscale lists nothing', () => {
  assert.deepEqual(parseTailnetStatus({ ...status, BackendState: 'Stopped' }).devices, [])
  assert.deepEqual(parseTailnetStatus({ BackendState: 'NeedsLogin', Peer: null }).devices, [])
})

test('names: iPhones report "localhost", so the MagicDNS label stands in', () => {
  assert.equal(deviceName({ HostName: 'localhost', DNSName: 'ipad155.tail0000.ts.net.' }), 'ipad155')
  assert.equal(deviceName({ HostName: 'Surendra’s MacBook Pro', DNSName: 'x.ts.net.' }), 'Surendra’s MacBook Pro')
  assert.equal(deviceName({}), 'Unnamed')
})

test('opening a machine: a Mac shows its screen, Windows Remote Desktop, anything else a terminal', () => {
  const [mac, , pi, win] = parseTailnetStatus(status).devices
  assert.equal(defaultSessionFor(mac), 'vnc')
  assert.equal(defaultSessionFor(pi), 'ssh')
  assert.equal(defaultSessionFor(win), 'rdp')
  assert.equal(defaultSessionFor({ platform: 'linux' }), 'ssh', 'not a tailnet host: the usual SSH')
})

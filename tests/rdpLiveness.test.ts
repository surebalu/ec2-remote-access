import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server, type Socket } from 'node:net'
import {
  afterProbe,
  agentSupportsMux,
  FAILURES_TO_CUT,
  IDLE_PROBE_AFTER_MS,
  INPUT_PROBE_AFTER_MS,
  isX224Confirm,
  PROBE_INTERVAL_MS,
  probeRdp,
  RETRY_AFTER_FAILURE_MS,
  shouldProbe,
  x224ConnectionRequest,
  type ProbeState
} from '../src/main/rdp/liveness.ts'

const CONFIRM = Buffer.from([0x03, 0x00, 0x00, 0x13, 0x0e, 0xd0, 0x00, 0x00, 0x12, 0x34, 0x00, 0x02, 0x1f, 0x08, 0x00, 0x02, 0x00, 0x00, 0x00])

async function listen(onConn: (s: Socket) => void): Promise<{ server: Server; port: number }> {
  const server = createServer(onConn)
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()))
  const addr = server.address()
  return { server, port: typeof addr === 'object' && addr ? addr.port : 0 }
}

test('agentSupportsMux only trusts agents known to be newer than 3.0.196.0', () => {
  assert.equal(agentSupportsMux(undefined), false)
  assert.equal(agentSupportsMux(''), false)
  assert.equal(agentSupportsMux('garbage'), false)
  assert.equal(agentSupportsMux('3.0.196.0'), false)
  assert.equal(agentSupportsMux('3.0.161.0'), false)
  assert.equal(agentSupportsMux('2.3.1644.0'), false)
  assert.equal(agentSupportsMux('3.0.196.1'), true)
  assert.equal(agentSupportsMux('3.0.222.0'), true)
  assert.equal(agentSupportsMux('3.3.2299.0'), true)
})

test('X.224 request is a well-formed TPKT and the confirm parser accepts only a complete CC', () => {
  const req = x224ConnectionRequest()
  assert.equal(req.length, req.readUInt16BE(2))
  assert.equal(req[5], 0xe0)
  assert.equal(isX224Confirm(CONFIRM), true)
  assert.equal(isX224Confirm(CONFIRM.subarray(0, 10)), false)
  assert.equal(isX224Confirm(req), false)
})

test('probeRdp succeeds when the far side answers the X.224 request, split across packets', async () => {
  const { server, port } = await listen((s) => {
    s.once('data', () => {
      s.write(CONFIRM.subarray(0, 5))
      setTimeout(() => s.write(CONFIRM.subarray(5)), 20)
    })
  })
  const r = await probeRdp('127.0.0.1', port, 2000)
  assert.equal(r.ok, true)
  server.close()
})

test('probeRdp fails when a listener accepts but nothing answers (dead SSM data channel)', async () => {
  const held: Socket[] = []
  const { server, port } = await listen((s) => held.push(s))
  const r = await probeRdp('127.0.0.1', port, 300)
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /no X\.224 reply/)
  for (const s of held) s.destroy()
  server.close()
})

test('probeRdp fails when the tunnel hangs up on the probe', async () => {
  const { server, port } = await listen((s) => s.end())
  const r = await probeRdp('127.0.0.1', port, 2000)
  assert.equal(r.ok, false)
  server.close()
})

test('shouldProbe leaves active and recently probed relays alone', () => {
  const base: ProbeState = { now: 1_000_000, lastDownAt: 1_000_000, waitingSince: null, lastProbeAt: null, failures: 0, clockJumped: false }
  // Server just sent something: no reason to probe.
  assert.equal(shouldProbe(base), false)
  // Idle but not long enough.
  assert.equal(shouldProbe({ ...base, lastDownAt: base.now - IDLE_PROBE_AFTER_MS + 1 }), false)
  // Idle long enough and never probed.
  assert.equal(shouldProbe({ ...base, lastDownAt: base.now - IDLE_PROBE_AFTER_MS }), true)
  // Idle, but probed recently and it succeeded.
  assert.equal(shouldProbe({ ...base, lastDownAt: base.now - 10 * 60_000, lastProbeAt: base.now - PROBE_INTERVAL_MS + 1 }), false)
  assert.equal(shouldProbe({ ...base, lastDownAt: base.now - 10 * 60_000, lastProbeAt: base.now - PROBE_INTERVAL_MS }), true)
  // Server traffic after an old probe, then silence again: probing resumes once idle long enough.
  assert.equal(shouldProbe({ ...base, lastProbeAt: base.now - 5 * 60_000, lastDownAt: base.now - IDLE_PROBE_AFTER_MS }), true)
})

test('shouldProbe reacts faster to unanswered input, a previous failure, or a clock jump', () => {
  const base: ProbeState = { now: 1_000_000, lastDownAt: 1_000_000 - 20_000, waitingSince: null, lastProbeAt: null, failures: 0, clockJumped: false }
  assert.equal(shouldProbe(base), false)
  assert.equal(shouldProbe({ ...base, waitingSince: base.now - INPUT_PROBE_AFTER_MS + 1 }), false)
  assert.equal(shouldProbe({ ...base, waitingSince: base.now - INPUT_PROBE_AFTER_MS }), true)
  assert.equal(shouldProbe({ ...base, failures: 1, lastProbeAt: base.now - RETRY_AFTER_FAILURE_MS + 1 }), false)
  assert.equal(shouldProbe({ ...base, failures: 1, lastProbeAt: base.now - RETRY_AFTER_FAILURE_MS }), true)
  assert.equal(shouldProbe({ ...base, lastDownAt: base.now, clockJumped: true }), true)
})

test('afterProbe needs consecutive failures and forgives a failure if the session itself spoke', () => {
  const fail = { ok: false, ms: 12_000, error: 'no X.224 reply' }
  const ok = { ok: true, ms: 40 }
  let s = afterProbe(0, fail, 100, 50)
  assert.deepEqual(s, { failures: 1, cut: FAILURES_TO_CUT <= 1 })
  s = afterProbe(s.failures, fail, 200, 50)
  assert.equal(s.cut, true)
  // Server bytes arrived on the real relay while the probe was out: not a failure.
  assert.deepEqual(afterProbe(1, fail, 200, 250), { failures: 0, cut: false })
  assert.deepEqual(afterProbe(1, ok, 200, 50), { failures: 0, cut: false })
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { attachCommand, detachedShells, hostShells, isShellName, killCommand, newShellName, parseProbe, probeCommand, shellNameFor, shq, switchCommand } from '../src/main/ssh/persist.ts'

const sh = (cmd: string): string => execFileSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' })

test('shq survives the shell unchanged, quotes included', () => {
  for (const s of ["it's", "a'b'c", '$HOME `x` "y" \\z', "',*:smcup@:rmcup@'"]) assert.equal(sh(`printf %s ${shq(s)}`), s)
})

test('a tab keeps one shell name for its life, and only our names are accepted', () => {
  assert.equal(shellNameFor('ssh-mvb3yby4-qz8c'), 'ec2ra-mvb3yby4qz8c')
  assert.equal(isShellName('ec2ra-mvb3yby4qz8c'), true)
  assert.equal(isShellName('main'), false)
  assert.equal(isShellName("ec2ra-x'; rm -rf ~"), false)
})

test('the probe reports a missing tmux, a non-POSIX host, and the shells on our socket', () => {
  assert.deepEqual(parseProbe('ec2ra:none\n'), { available: false, now: null, sessions: [] })
  assert.equal(parseProbe("'sh' is not recognized as an internal or external command"), null)
  const p = parseProbe('ec2ra:now 1000\r\nec2ra:s ec2ra-a\t0\t900\tbash\t/etc/systemd/system\t100\r\nec2ra:s ec2ra-b\t1\t990\ttop\t/root\n')
  assert.deepEqual(p, {
    available: true,
    now: 1000,
    sessions: [
      { name: 'ec2ra-a', attached: false, activity: 900, command: 'bash', path: '/etc/systemd/system', created: 100 },
      { name: 'ec2ra-b', attached: true, activity: 990, command: 'top', path: '/root', created: null }
    ]
  })
})

test('detached shells exclude attached ones, the tab\'s own and foreign sessions, newest first', () => {
  const p = parseProbe(['ec2ra:now 1000', 'ec2ra:s ec2ra-old\t0\t100\tbash\t/tmp', 'ec2ra:s ec2ra-new\t0\t950\tvim\t/etc', 'ec2ra:s ec2ra-live\t1\t999\tbash\t/', 'ec2ra:s ec2ra-mine\t0\t999\tbash\t/', 'ec2ra:s work\t0\t999\tbash\t/'].join('\n'))!
  assert.deepEqual(detachedShells(p, 'ec2ra-mine'), [
    { name: 'ec2ra-new', command: 'vim', path: '/etc', idleSec: 50 },
    { name: 'ec2ra-old', command: 'bash', path: '/tmp', idleSec: 900 }
  ])
})

test('attach commands create only when needed, configure only a new server, and fall back to a plain shell', () => {
  const plan = { name: 'ec2ra-a', create: true, startServer: true, cols: 120, rows: 32 }
  // What sh -c receives once the login shell has removed the quoting.
  const fresh = sh(`printf %s ${attachCommand(plan).replace(/^sh -c /, '')}`)
  assert.equal(attachCommand(plan).startsWith('sh -c '), true)
  for (const part of ['start-server', 'set -g default-terminal', 'new-session -d -s \'ec2ra-a\' -x 120 -y 32', 'set -g mouse off', 'set -g prefix None', 'smcup@:rmcup@', "attach-session -d -t 'ec2ra-a'", 'exec "${SHELL:-/bin/sh}" -l']) {
    assert.ok(fresh.includes(part), `fresh server script has ${part}`)
  }
  const resume = attachCommand({ ...plan, create: false, startServer: false })
  assert.equal(resume.includes('new-session'), false)
  assert.equal(resume.includes('set -g'), false)
  assert.ok(killCommand('ec2ra-a').includes('kill-session'))
  assert.ok(probeCommand().includes('-L ec2ra'))
})

test('the session list shows every shell of ours, oldest first, marking this tab\'s and ones shown elsewhere', () => {
  const p = parseProbe(['ec2ra:now 1000', 'ec2ra:s ec2ra-t-2\t1\t990\ttop\t/root\t900', 'ec2ra:s ec2ra-t\t1\t995\tbash\t/tmp\t100', 'ec2ra:s ec2ra-u\t0\t500\tbash\t/\t400', 'ec2ra:s mine\t0\t1\tbash\t/\t1'].join('\n'))!
  assert.deepEqual(hostShells(p, 'ec2ra-t'), [
    { name: 'ec2ra-t', command: 'bash', path: '/tmp', idleSec: 5, ageSec: 900, current: true, attached: true },
    { name: 'ec2ra-u', command: 'bash', path: '/', idleSec: 500, ageSec: 600, current: false, attached: false },
    { name: 'ec2ra-t-2', command: 'top', path: '/root', idleSec: 10, ageSec: 100, current: false, attached: true }
  ])
  assert.match(newShellName('ssh-mvb3yby4-qz8c'), /^ec2ra-mvb3yby4qz8c-[a-z0-9]+$/)
  assert.ok(isShellName(newShellName('ssh-a-b')))
})

test('switching moves this tab\'s client, takes the target from other clients, and creates only when asked', () => {
  const script = (c: string): string => sh(`printf %s ${c.replace(/^sh -c /, '')}`)
  const sw = script(switchCommand({ from: 'ec2ra-a', to: 'ec2ra-b', create: false, cols: 100, rows: 30 }))
  for (const part of ["list-clients -t 'ec2ra-a'", "detach-client -s 'ec2ra-b'", 'switch-client -c "$C" -t \'ec2ra-b\' && echo ec2ra:switched', 'refresh-client']) assert.ok(sw.includes(part), part)
  assert.equal(sw.includes('new-session'), false)
  assert.ok(script(switchCommand({ from: 'ec2ra-a', to: 'ec2ra-c', create: true, cols: 100, rows: 30 })).includes("new-session -d -s 'ec2ra-c' -x 100 -y 30"))
})

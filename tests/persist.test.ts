import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { attachCommand, detachedShells, isShellName, killCommand, parseProbe, probeCommand, shellNameFor, shq } from '../src/main/ssh/persist.ts'

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
  const p = parseProbe('ec2ra:now 1000\r\nec2ra:s ec2ra-a\t0\t900\tbash\t/etc/systemd/system\r\nec2ra:s ec2ra-b\t1\t990\ttop\t/root\n')
  assert.deepEqual(p, {
    available: true,
    now: 1000,
    sessions: [
      { name: 'ec2ra-a', attached: false, activity: 900, command: 'bash', path: '/etc/systemd/system' },
      { name: 'ec2ra-b', attached: true, activity: 990, command: 'top', path: '/root' }
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
  const plan = { name: 'ec2ra-a', create: true, startServer: true, history: false, cols: 120, rows: 32 }
  // What sh -c receives once the login shell has removed the quoting.
  const fresh = sh(`printf %s ${attachCommand(plan).replace(/^sh -c /, '')}`)
  assert.equal(attachCommand(plan).startsWith('sh -c '), true)
  for (const part of ['start-server', 'set -g default-terminal', 'new-session -d -s \'ec2ra-a\' -x 120 -y 32', 'set -g mouse off', 'set -g prefix None', 'smcup@:rmcup@', "attach-session -d -t 'ec2ra-a'", 'exec "${SHELL:-/bin/sh}" -l']) {
    assert.ok(fresh.includes(part), `fresh server script has ${part}`)
  }
  assert.equal(fresh.includes('capture-pane'), false)
  const resume = attachCommand({ ...plan, create: false, startServer: false, history: true })
  assert.equal(resume.includes('new-session'), false)
  assert.equal(resume.includes('set -g'), false)
  assert.ok(resume.includes('capture-pane'))
  assert.ok(killCommand('ec2ra-a').includes('kill-session'))
  assert.ok(probeCommand().includes('-L ec2ra'))
})

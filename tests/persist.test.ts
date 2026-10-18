import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { attachCommand, cleanLabel, detachedShells, hostShells, isShellName, killCommand, labelCommand, newShellName, parseProbe, probeCommand, shellNameFor, shq, switchCommand } from '../src/main/ssh/persist.ts'

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
      { name: 'ec2ra-a', attached: false, activity: 900, command: 'bash', path: '/etc/systemd/system', created: 100, label: '', user: '', args: '', preview: '' },
      { name: 'ec2ra-b', attached: true, activity: 990, command: 'top', path: '/root', created: null, label: '', user: '', args: '', preview: '' }
    ]
  })
})

test('detached shells exclude attached ones, the tab\'s own and foreign sessions, newest first', () => {
  const p = parseProbe(['ec2ra:now 1000', 'ec2ra:s ec2ra-old\t0\t100\tbash\t/tmp', 'ec2ra:s ec2ra-new\t0\t950\tvim\t/etc', 'ec2ra:s ec2ra-live\t1\t999\tbash\t/', 'ec2ra:s ec2ra-mine\t0\t999\tbash\t/', 'ec2ra:s work\t0\t999\tbash\t/'].join('\n'))!
  assert.deepEqual(detachedShells(p, 'ec2ra-mine').map((d) => [d.name, d.command, d.path, d.idleSec]), [
    ['ec2ra-new', 'vim', '/etc', 50],
    ['ec2ra-old', 'bash', '/tmp', 900]
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
  assert.deepEqual(hostShells(p, 'ec2ra-t').map((x) => [x.name, x.idleSec, x.ageSec, x.current, x.attached]), [
    ['ec2ra-t', 5, 900, true, true],
    ['ec2ra-u', 500, 600, false, false],
    ['ec2ra-t-2', 10, 100, false, true]
  ])
  assert.match(newShellName('ssh-mvb3yby4-qz8c'), /^ec2ra-mvb3yby4qz8c-[a-z0-9]+$/)
  assert.ok(isShellName(newShellName('ssh-a-b')))
})

test('switching moves this tab\'s client, takes the target from other clients, and creates only when asked', () => {
  const script = (c: string): string => sh(`printf %s ${c.replace(/^sh -c /, '')}`)
  const sw = script(switchCommand({ from: 'ec2ra-a', to: 'ec2ra-b', create: false, cols: 100, rows: 30 }))
  for (const part of ["list-clients -t 'ec2ra-a'", "detach-client -s 'ec2ra-b'", 'switch-client -c "$C" -t \'ec2ra-b\' || exit 0', 'ec2ra:switched', '@ec2ra_label', 'refresh-client']) assert.ok(sw.includes(part), part)
  assert.equal(sw.includes('new-session'), false)
  assert.ok(script(switchCommand({ from: 'ec2ra-a', to: 'ec2ra-c', create: true, cols: 100, rows: 30 })).includes("new-session -d -s 'ec2ra-c' -x 100 -y 30"))
})

test('the probe reads each shell\'s name, real user and command, and last screen line', () => {
  const out = [
    'ec2ra:now 1000',
    'ec2ra:s ec2ra-a\t0\t900\tbash\t/home/ec2-user\t100',
    'ec2ra:s ec2ra-b\t1\t990\tbash\t/home/ec2-user\t200',
    'ec2ra:l ec2ra-a\tdebug',
    'ec2ra:x ec2ra-a\t3dxadmin                         tail -f /var/log/catalina.out',
    'ec2ra:p ec2ra-a\t2026-10-17 INFO\tServer startup in 4211 ms   ',
    'ec2ra:x ec2ra-b\troot -bash',
    'ec2ra:p ec2ra-b\troot@ip-10-1-2-144:/etc/systemd/system#'
  ].join('\n')
  const p = parseProbe(out)!
  const [a, b] = hostShells(p, 'ec2ra-b')
  assert.deepEqual([a.label, a.user, a.args, a.preview], ['debug', '3dxadmin', 'tail -f /var/log/catalina.out', '2026-10-17 INFO\tServer startup in 4211 ms'])
  assert.deepEqual([b.label, b.user, b.args, b.preview], ['', 'root', 'bash', 'root@ip-10-1-2-144:/etc/systemd/system#'])
  assert.ok(probeCommand().includes('@ec2ra_label') && probeCommand().includes('tpgid'))
})

test('names are one clean line, stored on the session and cleared when empty', () => {
  assert.equal(cleanLabel('  debug\tthe   indexer\n'), 'debug the indexer')
  assert.equal(cleanLabel('x'.repeat(60)).length, 40)
  const script = (c: string): string => sh(`printf %s ${c.replace(/^sh -c /, '')}`)
  assert.ok(script(labelCommand('ec2ra-a', "it's debug")).includes(`set-option -t 'ec2ra-a' @ec2ra_label 'it'\\''s debug'`))
  assert.ok(script(labelCommand('ec2ra-a', '   ')).includes("set-option -u -t 'ec2ra-a' @ec2ra_label"))
  assert.ok(script(switchCommand({ from: 'ec2ra-a', to: 'ec2ra-c', create: true, label: 'indexing', cols: 80, rows: 24 })).includes("set-option -t 'ec2ra-c' @ec2ra_label 'indexing'"))
  const attach = script(attachCommand({ name: 'ec2ra-d', create: true, startServer: false, label: 'debug', cols: 80, rows: 24 }))
  assert.ok(attach.includes("set-option -t 'ec2ra-d' @ec2ra_label 'debug'"))
  assert.equal(attach.includes('capture-pane'), false)
  assert.ok(script(attachCommand({ name: 'ec2ra-d', create: false, startServer: false, history: true, cols: 80, rows: 24 })).includes('capture-pane'))
})

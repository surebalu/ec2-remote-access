import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initLog, log, logFilePath, recentLog } from '../src/main/log.ts'

test('log file captures console output and structured entries, and recentLog filters the tail', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ec2ra-log-'))
  initLog(dir)
  assert.equal(logFilePath(), join(dir, 'main.log'))
  console.log('[app] hello from console')
  console.warn('[rdp-proxy] something odd')
  log('rdp', 'relay closed', { token: 'abcd1234', up: 10, down: 0, target: '127.0.0.1:3389' })
  log('ssm', 'plugin', { line: 'Waiting for connections...' })
  const text = await readFile(join(dir, 'main.log'), 'utf8')
  assert.match(text, /info\s+\[app\] hello from console/)
  assert.match(text, /warn\s+\[rdp-proxy\] something odd/)
  assert.match(text, /\[rdp\] relay closed token="abcd1234" up=10 down=0 target="127\.0\.0\.1:3389"/)
  const rdpOnly = recentLog(100, 'rdp')
  assert.equal(rdpOnly.path, join(dir, 'main.log'))
  assert.match(rdpOnly.text, /relay closed/)
  assert.doesNotMatch(rdpOnly.text, /hello from console/)
  const last1 = recentLog(1)
  assert.equal(last1.text.split('\n').length, 1)
  assert.match(last1.text, /\[ssm\] plugin/)
  await rm(dir, { recursive: true, force: true })
})

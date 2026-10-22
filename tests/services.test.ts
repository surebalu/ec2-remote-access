import { test } from 'node:test'
import assert from 'node:assert/strict'
import { actionScript, catalogOf, DEFAULT_SERVICES, isUnitName, logsScript, parseStatus, statusScript, unitWord } from '../src/shared/services.ts'

test('only plain unit names reach a shell command', () => {
  for (const u of ['3dspace.service', 'thbtasklist.service', '3dspaceDerivedconverter.service', 'getty@tty1.service']) assert.equal(isUnitName(u), true, u)
  for (const u of ['3dspace', 'a b.service', 'x.service; rm -rf /', '$(id).service', "q'.service", '../x.service', '']) assert.equal(isUnitName(u), false, u)
  assert.throws(() => actionScript('restart', 'x.service; reboot'))
  assert.throws(() => actionScript('reboot' as never, '3dspace.service'))
  assert.throws(() => logsScript('a b.service'))
})

test('the catalog drops bad unit names and empty services, and falls back to the install sheet', () => {
  assert.deepEqual(catalogOf(undefined), DEFAULT_SERVICES)
  assert.deepEqual(catalogOf([]), DEFAULT_SERVICES, 'an empty saved list means the defaults')
  assert.deepEqual(catalogOf([{ id: 'x', name: 'X', units: ['ok.service', 'bad name.service'] }, { id: 'y', name: 'Y', units: ['nope'] }]), [{ id: 'x', name: 'X', units: ['ok.service'] }])
  assert.ok(DEFAULT_SERVICES.find((d) => d.id === 'converter')!.units.includes('thbtasklist.service'))
})

test('scripts run the action with a timeout and print the state', () => {
  assert.deepEqual(actionScript('restart', '3dspace.service', 600)[0], 'timeout 600 systemctl restart 3dspace.service; echo "RC=$?"')
  assert.match(statusScript(['3dspace.service', 'bad name.service'])[1], /systemctl show --no-pager .* 3dspace\.service$/)
  assert.match(logsScript('tif.service', 50)[0], /^journalctl -u tif\.service -n 50 /)
})

test('systemctl show is read back: present units, state, pid, memory and how long since', () => {
  const now = 1_000_000_000
  const out = [
    'UPTIME=1000.50',
    'RC=0',
    'Id=3dspace.service', 'Description=3DSpace TomEE', 'LoadState=loaded', 'ActiveState=active', 'SubState=running', 'UnitFileState=enabled', 'MainPID=4242',
    'MemoryCurrent=2147483648', 'ActiveEnterTimestampMonotonic=900500000', 'InactiveEnterTimestampMonotonic=0',
    '',
    'Id=tif.service', 'LoadState=loaded', 'ActiveState=failed', 'SubState=failed', 'UnitFileState=enabled', 'MainPID=0', 'MemoryCurrent=[not set]',
    'ActiveEnterTimestampMonotonic=0', 'InactiveEnterTimestampMonotonic=990500000',
    '',
    'Id=federated.service', 'LoadState=not-found', 'ActiveState=inactive'
  ].join('\n')
  const { units, rc } = parseStatus(out, now)
  assert.equal(rc, 0)
  assert.deepEqual(units.map((u) => u.unit), ['3dspace.service', 'tif.service'], 'not-found units are left out')
  assert.equal(units[0].pid, 4242)
  assert.equal(units[0].memBytes, 2147483648)
  assert.equal(units[0].since, now - 100_000, 'active for the last 100 s of a 1000.5 s uptime')
  assert.equal(units[1].pid, null)
  assert.equal(units[1].memBytes, null)
  assert.equal(units[1].since, now - 10_000)
  assert.deepEqual(unitWord(units[0]), { word: 'Running', level: 'ok' })
  assert.deepEqual(unitWord(units[1]), { word: 'Failed', level: 'crit' })
  assert.deepEqual(unitWord({ active: 'inactive', sub: 'dead' }), { word: 'Stopped', level: 'off' })
})

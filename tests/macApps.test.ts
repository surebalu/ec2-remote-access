import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  belongsTo, groupByApp, isIntelOnly, launchProgram, leftoverOf, mdlsDate, mdlsList, memoryFrom, nameFromId, parseBattery, parseDiskIo, parseNetstat, parsePs,
  parseSwap, parseSystemExtensions, parseVmStat, splitMdls, startupOwner
} from '../src/shared/macApps.ts'

test('mdls values split per file, with lists and dates read', () => {
  const text = ['com.a.one', '1.0', '2026-10-21 14:03:11 +0000', '(\n    arm64,\n    x86_64\n)', 'com.b.two', '', '', '(\n    x86_64\n)'].join('\0')
  const rows = splitMdls(text, 4, 2)
  assert.deepEqual(rows[0].slice(0, 2), ['com.a.one', '1.0'])
  assert.equal(mdlsDate(rows[0][2]), Date.parse('2026-10-21T14:03:11+00:00'))
  assert.equal(mdlsDate(rows[1][2]), 0)
  assert.deepEqual(mdlsList(rows[0][3]), ['arm64', 'x86_64'])
  assert.equal(isIntelOnly(mdlsList(rows[0][3])), false)
  assert.equal(isIntelOnly(mdlsList(rows[1][3])), true)
  assert.equal(isIntelOnly([]), false, 'no record is not Intel')
})

test('an app\'s Library files are matched by bundle id, by name, or only by vendor', () => {
  const app = { id: 'com.example.Writer', name: 'Writer' }
  assert.equal(belongsTo('com.example.Writer.plist', app), 'sure')
  assert.equal(belongsTo('com.example.Writer.savedState', app), 'sure')
  assert.equal(belongsTo('ABCDE12345.com.example.Writer', app), 'sure')
  assert.equal(belongsTo('com.example.Writer.helper', app), 'sure')
  assert.equal(belongsTo('Writer', app), 'likely')
  assert.equal(belongsTo('com.example.Other', app), 'maybe')
  assert.equal(belongsTo('com.elsewhere.Writer2', app), null)
  assert.equal(belongsTo('com.apple.Safari', { id: 'com.apple.Notes', name: 'Notes' }), null, 'Apple is not one vendor')
})

test('a leftover is a bundle id nothing installed accounts for', () => {
  const installed = ['com.google.Chrome', 'com.microsoft.VSCode']
  assert.deepEqual(leftoverOf('com.spotify.client.plist', installed), { verdict: 'sure', id: 'com.spotify.client' })
  assert.deepEqual(leftoverOf('com.google.Keystone.Agent.plist', installed), { verdict: 'maybe', id: 'com.google.Keystone.Agent' }, 'the vendor has apps here')
  assert.equal(leftoverOf('com.google.Chrome', installed), 'owned')
  assert.equal(leftoverOf('com.microsoft.VSCode.ShipIt', installed), 'owned')
  assert.equal(leftoverOf('com.apple.Safari', installed), null)
  assert.equal(leftoverOf('Google', installed), null, 'plain names are never guessed at')
  assert.equal(leftoverOf('warp.log.old.0', installed), null, 'not a domain')
  assert.equal(leftoverOf('org.swift.swiftpm', installed), null, 'command-line tools')
  assert.equal(leftoverOf('group.com.apple.notes', installed), null)
  assert.deepEqual(leftoverOf('ABCDE12345.com.gone.app', installed), { verdict: 'sure', id: 'com.gone.app' })
  assert.equal(leftoverOf('com.bugsnag.Bugsnag', installed, new Set(['bugsnag'])), 'owned', 'a library inside an installed app')
  assert.equal(nameFromId('com.spotify.client'), 'spotify')
  assert.equal(nameFromId('com.techsmith.snagit'), 'snagit')
  assert.equal(nameFromId('com.vendor.app.2'), 'vendor')
})

test('a startup item belongs to the app its program lives in, or its one app by id', () => {
  const apps = [{ id: 'com.docker.docker', name: 'Docker' }, { id: 'com.adobe.Acrobat', name: 'Acrobat' }, { id: 'com.adobe.Photoshop', name: 'Photoshop' }]
  assert.equal(launchProgram({ ProgramArguments: ['/Applications/Docker.app/Contents/MacOS/com.docker.backend', '--x'] }), '/Applications/Docker.app/Contents/MacOS/com.docker.backend')
  assert.equal(launchProgram({ Program: '/usr/local/bin/tool' }), '/usr/local/bin/tool')
  assert.equal(startupOwner('com.x.helper', '/Applications/Tailscale.app/Contents/MacOS/Tailscale', apps), 'Tailscale')
  assert.equal(startupOwner('com.docker.vmnetd', '/Library/PrivilegedHelperTools/com.docker.vmnetd', apps), 'Docker')
  assert.equal(startupOwner('com.adobe.ARMDC.agent', '/Library/x', apps), '2 apps from adobe')
  assert.equal(startupOwner('org.unknown.thing', '/usr/local/bin/thing', apps), '')
})

test('system extensions are read from systemextensionsctl', () => {
  const text = '2 extension(s)\n--- com.apple.system_extension.driver_extension\nenabled\tactive\tteamID\tbundleID (version)\tname\t[state]\n*\t*\tR2H967U7J8\tcom.razer.appengine.driver (0.0.14/1)\tRazer HID Driver Extension\t[activated enabled]\n'
  assert.deepEqual(parseSystemExtensions(text), [{ id: 'com.razer.appengine.driver', name: 'Razer HID Driver Extension', state: 'activated enabled' }])
})

test('memory reads as Activity Monitor splits it', () => {
  const vm = parseVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:     100.\nPages wired down:     200.\nPages purgeable:     10.\n"Translation faults":     5.\nFile-backed pages:     300.\nAnonymous pages:     400.\nPages occupied by compressor:     50.\n')
  assert.equal(vm['Pages wired down'], 200)
  assert.equal(vm['Translation faults'], 5)
  const m = memoryFrom(vm, 16384, 2000 * 16384, 0, 2)
  assert.equal(m.app, 390 * 16384)
  assert.equal(m.used, (390 + 200 + 50) * 16384)
  assert.equal(m.pressure, 'warn')
  assert.equal(parseSwap('total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)'), 1024.5 * 1024 ** 2)
  assert.equal(parseSwap('total = 0.00M  used = 0.00M  free = 0.00M'), 0)
})

test('network and disk counters add up the right interfaces and drives', () => {
  const net = [
    'Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll',
    'lo0        16384 <Link#1>                      15059965     0 34069174493 15059965     0 34069174493     0',
    'en0        1500  <Link#11>   aa:bb:cc:dd:ee:ff  1000     0     5000000   900     0     2000000     0',
    'en0        1500  192.168.0     192.168.0.20     1000     -     5000000   900     -     2000000     -',
    'utun3      1380  <Link#20>                      10     0     999   10     0     999     0'
  ].join('\n')
  assert.deepEqual(parseNetstat(net), { rx: 5000000, tx: 2000000 })
  assert.deepEqual(parseDiskIo('"Statistics" = {"Bytes (Read)"=100,"Bytes (Write)"=50}\n"Statistics" = {"Bytes (Read)"=1,"Bytes (Write)"=2}'), { read: 101, write: 52 })
})

test('the battery: charge, health against its design, and a time only when it means something', () => {
  const b = parseBattery('"BatteryInstalled" = Yes\n"CurrentCapacity" = 77\n"MaxCapacity" = 100\n"ExternalConnected" = Yes\n"IsCharging" = No\n"AvgTimeToEmpty" = 56625\n"CycleCount" = 116\n"BatteryData" = {"AppleRawMaxCapacity"=5198,"DesignCapacity"=6249}\n"Temperature" = 3012')!
  assert.equal(b.percent, 77)
  assert.equal(b.health, 83)
  assert.equal(b.minutes, null, 'plugged in, not charging')
  assert.equal(b.cycles, 116)
  assert.equal(b.temperature, 30)
  assert.equal(parseBattery('"BatteryInstalled" = No'), null)
})

test('processes add up by the app they belong to', () => {
  const rows = parsePs('  101     1  12.5  204800 /Applications/Dia.app/Contents/MacOS/Dia\n  102   101  40.0  512000 /Applications/Dia.app/Contents/Frameworks/Dia Helper (Renderer).app/Contents/MacOS/Dia Helper (Renderer)\n  200     1   1.0   1024 /usr/libexec/logd\n')
  assert.equal(rows.length, 3)
  const apps = groupByApp(rows)
  const dia = apps.find((a) => a.name === 'Dia')!
  assert.equal(dia.cpu, 52.5)
  assert.equal(dia.memory, (204800 + 512000) * 1024)
  assert.deepEqual(dia.pids, [101, 102])
  assert.equal(apps.find((a) => a.name === 'logd')?.system, true)
})

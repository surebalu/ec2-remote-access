import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bytes, compareVersions, extOf, hiddenInfo, isPackageName, kindOf, protectedReason, tildePath } from '../src/shared/storage.ts'
import { squarify } from '../src/shared/treemap.ts'

const HOME = '/Users/me'

test('sizes read as Finder writes them, in decimal units', () => {
  assert.equal(bytes(0), 'Zero KB')
  assert.equal(bytes(999), '999 bytes')
  assert.equal(bytes(1000), '1 KB')
  assert.equal(bytes(1_500_000), '1.5 MB')
  assert.equal(bytes(452_363_059_000), '452 GB')
  assert.equal(bytes(800_000_000), '800 MB')
  assert.equal(bytes(100_000_000), '100 MB')
  assert.equal(bytes(280e9), '280 GB')
  assert.equal(bytes(2e9), '2 GB')
  assert.equal(bytes(12_340_000_000), '12.3 GB')
  assert.equal(bytes(undefined), '—')
})

test('a file is known by its extension, and apps and packages by theirs', () => {
  assert.equal(extOf('movie.MOV'), 'mov')
  assert.equal(extOf('.zshrc'), '')
  assert.equal(kindOf('holiday.mp4'), 'video')
  assert.equal(kindOf('installer.dmg'), 'diskimage')
  assert.equal(kindOf('model.gguf'), 'developer')
  assert.equal(kindOf('Notes.app', true), 'app')
  assert.equal(kindOf('README'), 'other')
  assert.equal(isPackageName('Photos Library.photoslibrary'), true)
  assert.equal(isPackageName('Xcode.app'), true)
  assert.equal(isPackageName('Projects'), false)
})

test('macOS, the Trash, keys and standard folders never go to the Trash from here', () => {
  assert.match(protectedReason('/System/Library/Fonts', HOME)!, /Part of macOS/)
  assert.match(protectedReason('/usr/lib/libz.dylib', HOME)!, /Part of macOS/)
  assert.equal(protectedReason('/usr/local/lib/big.a', HOME), null)
  assert.match(protectedReason(`${HOME}/.Trash/old.zip`, HOME)!, /Already in the Trash/)
  assert.match(protectedReason(`${HOME}/Library/Keychains/login.keychain-db`, HOME)!, /keychain/)
  assert.match(protectedReason(`${HOME}/Library/Mobile Documents/com~apple~CloudDocs/a.pdf`, HOME)!, /cloud/)
  assert.match(protectedReason(`${HOME}/Documents`, HOME)!, /standard folder/)
  assert.match(protectedReason(`${HOME}/Library/Caches`, HOME)!, /standard folder/)
  assert.equal(protectedReason(`${HOME}/Library/Caches/com.example.app`, HOME), null)
  assert.match(protectedReason(`${HOME}/.ssh/id_ed25519`, HOME)!, /private key/)
  assert.match(protectedReason('/', HOME)!, /standard folder/)
  assert.match(protectedReason('relative/path', HOME)!, /full path/)
  assert.equal(protectedReason(`${HOME}/Downloads/big.iso`, HOME), null)
})

test('common hidden folders are explained, and only caches are disposable', () => {
  assert.equal(hiddenInfo('.npm')?.level, 'cache')
  assert.equal(hiddenInfo('.ssh')?.level, 'yours')
  assert.equal(hiddenInfo('.rustup')?.level, 'tool')
  assert.equal(hiddenInfo('._IMG_0001.jpg')?.level, 'rebuilt')
  assert.equal(hiddenInfo('.somethingunknown'), null)
})

test('versions compare by number, not by text', () => {
  assert.ok(compareVersions('1.10.0', '1.9.5') > 0)
  assert.equal(compareVersions('2.0', '2.0.0'), 0)
  assert.ok(compareVersions('126.0.6478.61', '127.0.1') < 0)
})

test('home paths shorten to ~', () => {
  assert.equal(tildePath(`${HOME}/Downloads/a.zip`, HOME), '~/Downloads/a.zip')
  assert.equal(tildePath(HOME, HOME), '~')
  assert.equal(tildePath('/Users/meanwhile/x', HOME), '/Users/meanwhile/x')
})

test('the treemap fills its box with areas in proportion, as square as it can', () => {
  const items = [{ value: 6 }, { value: 6 }, { value: 4 }, { value: 3 }, { value: 2 }, { value: 2 }, { value: 1 }]
  const out = squarify(items, { x: 0, y: 0, w: 6, h: 4 })
  assert.equal(out.length, items.length)
  const area = out.reduce((s, o) => s + o.rect.w * o.rect.h, 0)
  assert.ok(Math.abs(area - 24) < 1e-9)
  for (const o of out) {
    assert.ok(Math.abs(o.rect.w * o.rect.h - o.item.value) < 1e-9, 'area in proportion')
    assert.ok(o.rect.x >= -1e-9 && o.rect.y >= -1e-9 && o.rect.x + o.rect.w <= 6 + 1e-9 && o.rect.y + o.rect.h <= 4 + 1e-9, 'inside the box')
    assert.ok(Math.max(o.rect.w / o.rect.h, o.rect.h / o.rect.w) < 4, 'not a sliver')
  }
  assert.deepEqual(squarify([{ value: 0 }], { x: 0, y: 0, w: 10, h: 10 }), [])
  assert.deepEqual(squarify([{ value: 5 }], { x: 0, y: 0, w: 0, h: 10 }), [])
})

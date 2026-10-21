import { test } from 'node:test'
import assert from 'node:assert/strict'
import { launcherBounds, calculate, convert, formatNumber, issueKey, jiraSite, matchScore, nameQuery, rank, recentIds, recordUse, usageBoost, wantedFile } from '../src/shared/launcher.ts'

test('names match best whole, then by their start, a word, initials, anywhere, letters in order', () => {
  const s = (q: string, t: string): number => matchScore(q, t)
  assert.equal(s('safari', 'Safari'), 100)
  assert.ok(s('saf', 'Safari') > s('code', 'Visual Studio Code'), 'start of the name beats start of a word')
  assert.ok(s('saf', 'Safari') > s('saf', 'Safari Technology Preview'), 'shorter names first')
  assert.ok(s('code', 'Visual Studio Code') > s('vsc', 'Visual Studio Code'))
  assert.ok(s('vsc', 'Visual Studio Code') > s('stud', 'Visual Studio Code') - 30)
  assert.ok(s('vsc', 'Visual Studio Code') > s('isual', 'Visual Studio Code'), 'initials beat a substring')
  assert.ok(s('drive', 'OneDrive') >= 70, 'camelCase humps are words')
  assert.ok(s('isual', 'Visual Studio Code') > s('vlsd', 'Visual Studio Code'))
  assert.ok(s('vlsd', 'Visual Studio Code') > 0, 'letters in order')
  assert.equal(s('xyz', 'Safari'), 0)
  assert.equal(s('v', 'Safari'), 0, 'a single letter needs more than letters in order')
  assert.ok(s('visual code', 'Visual Studio Code') >= 70, 'several words each match a word')
  assert.equal(s('visual xcode', 'Visual Studio Code'), 0)
  assert.equal(s('', 'Anything'), 1)
})

test('what was opened often and lately rises', () => {
  const now = Date.UTC(2026, 9, 19)
  assert.equal(usageBoost(undefined, now), 0)
  assert.ok(usageBoost({ count: 10, last: now - 1000 }, now) > usageBoost({ count: 10, last: now - 40 * 86_400_000 }, now))
  assert.ok(usageBoost({ count: 50, last: now }, now) <= 30)
  const apps = [{ name: 'Slack' }, { name: 'Safari' }, { name: 'Sublime Text' }]
  const ranked = (usage = {}): string[] => rank(apps, 's', { text: (a) => a.name, id: (a) => a.name, usage, now }).map((a) => a.name)
  assert.deepEqual(ranked(), ['Slack', 'Safari', 'Sublime Text'])
  assert.equal(ranked({ 'Sublime Text': { count: 20, last: now } })[0], 'Sublime Text')
  assert.deepEqual(rank(apps, 'zz', { text: (a) => a.name, id: (a) => a.name }), [])
})

test('uses are counted, the latest first, and capped', () => {
  const now = 1_000_000
  let u = recordUse({}, 'app:a', now)
  u = recordUse(u, 'app:a', now + 1)
  u = recordUse(u, 'host:b', now + 2)
  assert.deepEqual(u['app:a'], { count: 2, last: now + 1 })
  assert.deepEqual(recentIds(u, now + 3, 5), ['app:a', 'host:b'])
  let big = {}
  for (let n = 0; n < 405; n++) big = recordUse(big, `f:${n}`, now + n)
  assert.equal(Object.keys(big).length, 400)
  assert.equal(big['f:0' as keyof typeof big], undefined, 'the oldest go')
})

test('arithmetic is calculated without evaluating code', () => {
  assert.equal(calculate('2*(3+4)'), 14)
  assert.equal(calculate('1.5^2'), 2.25)
  assert.equal(calculate('2^3^2'), 512)
  assert.equal(calculate('-2^2'), -4)
  assert.equal(calculate('0.1 + 0.2'), 0.3)
  assert.equal(calculate('200 * 15%'), 30)
  assert.equal(calculate('1,250 / 4'), 312.5)
  assert.equal(calculate('10 × 3 ÷ 4'), 7.5)
  assert.equal(calculate('sqrt(16) + abs(-2)'), 6)
  assert.equal(calculate('round(pi * 100)'), 314)
  assert.equal(calculate('2 ** 10'), 1024)
  for (const no of ['42', 'safari', 'web-prod-01', '10.0.1.15', '2 +', '(1 + 2', '1/0', 'alert(1)', 'process.exit()', '2 + x', '']) {
    assert.equal(calculate(no), null, no)
  }
})

test('results read with grouped thousands', () => {
  assert.equal(formatNumber(1234.5), '1,234.5')
  assert.equal(formatNumber(14), '14')
  assert.equal(formatNumber(1 / 3), '0.3333333333')
  assert.equal(formatNumber(1e22), '1.000000e+22')
})

test('file search covers the whole Mac but leaves out system folders, app insides and hidden folders', () => {
  const home = '/Users/me'
  for (const yes of ['/Users/me/Documents/plan.pdf', '/Users/me/Desktop/Desktop-Content/x.pdf', '/Users/me/Library/CloudStorage/GoogleDrive-me@x.com/Shared drives/Quality (Shared)/Part qualification',
    '/Users/me/Library/Mobile Documents/com~apple~CloudDocs/taxes.xlsx', '/Volumes/Backup/photos/a.png', '/Applications/Setapp/readme.txt']) assert.equal(wantedFile(yes, home), true, yes)
  for (const no of ['/System/Library/Fonts/a.ttf', '/Library/Application Support/x', '/private/var/log/x', '/usr/share/doc/readme', '/Users/me/Library/Caches/notes.db',
    '/Users/me/.config/notes', '/Users/me/code/app/node_modules/x/readme.md', '/Applications/Obsidian.app', '/Applications/Obsidian.app/Contents/Info.plist',
    '/Users/me/Pictures/Photos Library.photoslibrary/x.jpg']) assert.equal(wantedFile(no, home), false, no)
})

test('several typed words each match the name, in any order', () => {
  assert.equal(nameQuery('invoice'), 'kMDItemFSName == "*invoice*"cd')
  assert.equal(nameQuery('  tax  2024 '), 'kMDItemFSName == "*tax*"cd && kMDItemFSName == "*2024*"cd')
  assert.equal(nameQuery('a"b*c?d\\e'), 'kMDItemFSName == "*abcde*"cd', 'quotes and wildcards cannot break out of the query')
  assert.equal(nameQuery('   '), '')
})

test('units convert within what they measure', () => {
  const c = (q: string) => { const r = convert(q); return r && `${formatNumber(r.value)} ${r.unit}` }
  assert.equal(c('5 GB to MiB'), '4,768.37158203 MiB')
  assert.equal(c('1 GiB in MB'), '1,073.741824 MB')
  assert.equal(c('100f to c'), '37.7777777778 °C')
  assert.equal(c('0 c in f'), '32 °F')
  assert.equal(c('90 min as h'), '1.5 h')
  assert.equal(c('3.5 ft = cm'), '106.68 cm')
  assert.equal(c('2*1.5 km to mi'), '1.8641135767 mi')
  assert.equal(c('1,000 lb to kg'), '453.59237 kg')
  assert.equal(c('10 kg to km'), null, 'mass is not length')
  assert.equal(c('5 apples to pears'), null)
  assert.equal(c('5 GB'), null)
  assert.equal(convert('5 gb to mib')?.from, '5 GB')
})

test('Jira issue keys, and where your Jira is from the Browser history', () => {
  assert.equal(issueKey('plm-123'), 'PLM-123')
  assert.equal(issueKey(' INC-4211 '), 'INC-4211')
  for (const no of ['web-prod-01', 'PLM-', '123-45', 'a-1', 'plm 123']) assert.equal(issueKey(no), null, no)
  const pages = [
    { url: 'https://old.atlassian.net/browse/OPS-1', space: 'w1', at: 1 },
    { url: 'https://mainspring.atlassian.net/browse/PLM-77?focus=1', space: 'work', at: 5 },
    { url: 'https://mainspring.atlassian.net/wiki/spaces/X', space: 'work', at: 9 },
    { url: 'https://github.com/x/y/browse/README', space: 'p', at: 10 }
  ]
  assert.deepEqual(jiraSite(pages), { base: 'https://mainspring.atlassian.net', space: 'work' })
  assert.equal(jiraSite([]), null)
})

test('the launcher opens over the app when the app is in front, else on the pointer\'s screen like Spotlight', () => {
  const size = { width: 700, height: 446 }
  const screen = { x: 0, y: 25, width: 1512, height: 920 }
  // Centred on the app's window.
  assert.deepEqual(launcherBounds(size, { x: 100, y: 60, width: 1200, height: 800 }, screen, screen), { x: 350, y: 237, width: 700, height: 446 })
  // A window near the screen's edge (or smaller than the launcher) keeps the launcher on that screen.
  assert.deepEqual(launcherBounds(size, { x: 1300, y: 700, width: 400, height: 300 }, screen, screen), { x: 812, y: 499, width: 700, height: 446 })
  // A second display to the left, with the app on it.
  const left = { x: -1920, y: 0, width: 1920, height: 1055 }
  assert.deepEqual(launcherBounds(size, { x: -1800, y: 100, width: 1000, height: 700 }, left, screen), { x: -1650, y: 227, width: 700, height: 446 })
  // From another app: the pointer's screen, a fifth of the way down.
  assert.deepEqual(launcherBounds(size, null, null, screen), { x: 406, y: 191, width: 700, height: 446 })
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TERMINAL_THEMES } from '../src/renderer/terminalThemes.ts'
import { ACCENTS, buildAppThemes, contrast, mix } from '../src/renderer/appThemeTokens.ts'

const themes = buildAppThemes(TERMINAL_THEMES)

test('every accent names a terminal scheme, and every theme fills in the same tokens', () => {
  assert.equal(themes.length, ACCENTS.length)
  // Every theme sets every token the stylesheet defines; gradient schemes add the two backdrops on top.
  const optional = ['--rail-backdrop', '--panel-backdrop']
  const keys = Object.keys(themes.find((t) => t.id === 'dracula')!.tokens).sort()
  for (const t of themes) assert.deepEqual(Object.keys(t.tokens).filter((k) => !optional.includes(k)).sort(), keys, t.id)
  assert.ok(themes.find((t) => t.id === 'cyber-wave')!.tokens['--rail-backdrop'].startsWith('linear-gradient'), 'Cyber Wave fades down the rail')
  for (const k of ['--bg', '--bg-elev', '--panel', '--panel-2', '--border', '--text', '--text-2', '--muted', '--accent', '--on-accent', '--ok', '--err']) assert.ok(keys.includes(k), k)
})

test('text stays readable on every surface of every theme', () => {
  for (const t of themes) {
    const k = t.tokens
    for (const surface of ['--bg', '--bg-elev', '--panel', '--panel-2']) {
      assert.ok(contrast(k['--text'], k[surface]) >= 7, `${t.id}: text on ${surface} is ${contrast(k['--text'], k[surface]).toFixed(1)}`)
      assert.ok(contrast(k['--text-2'], k[surface]) >= 4.5, `${t.id}: secondary text on ${surface} is ${contrast(k['--text-2'], k[surface]).toFixed(1)}`)
      assert.ok(contrast(k['--muted'], k[surface]) >= 3, `${t.id}: muted text on ${surface} is ${contrast(k['--muted'], k[surface]).toFixed(1)}`)
    }
    assert.ok(contrast(k['--on-accent'], k['--accent']) >= 3, `${t.id}: button text on the accent is ${contrast(k['--on-accent'], k['--accent']).toFixed(1)}`)
    assert.ok(contrast(k['--accent'], k['--panel']) >= 3, `${t.id}: the accent on a panel is ${contrast(k['--accent'], k['--panel']).toFixed(1)}`)
  }
})

test('dark themes sit darker than their terminal, light ones keep white panels; mixing is linear', () => {
  const cyber = themes.find((t) => t.id === 'cyber-wave')!
  assert.equal(cyber.dark, true)
  assert.equal(cyber.scheme, 'cyber-wave')
  assert.ok(contrast(cyber.tokens['--bg'], '#000000') < contrast('#002633', '#000000'), 'canvas darker than the terminal background')
  const gh = themes.find((t) => t.id === 'github-light')!
  assert.equal(gh.dark, false)
  assert.equal(gh.tokens['--panel'].toLowerCase(), '#ffffff')
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080')
  assert.equal(mix('#102030', '#102030', 0.7), '#102030')
  assert.equal(contrast('#000000', '#ffffff').toFixed(0), '21')
})

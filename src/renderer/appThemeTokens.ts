/**
 * The colour maths behind the app's colour themes (appThemes.ts), free of the DOM and of value imports so the unit
 * tests can load it: tokens for styles.css computed from a terminal scheme's palette, and contrast checks.
 */
import type { ITheme } from '@xterm/xterm'

export interface AppTheme {
  id: string
  name: string
  dark: boolean
  /** The terminal scheme a terminal on "Match app" uses with this theme. */
  scheme: string
  accent: string
  tokens: Record<string, string>
}

/** The accent of each theme: the colour the theme itself uses for focus and links. */
export const ACCENTS: [id: string, accent: string][] = [
  ['cyber-wave', '#c26ad6'],
  ['dracula', '#bd93f9'],
  ['tokyo-night', '#7aa2f7'],
  ['catppuccin-mocha', '#cba6f7'],
  ['nord', '#88c0d0'],
  ['one-dark', '#61afef'],
  ['gruvbox-dark', '#fe8019'],
  ['monokai', '#f92672'],
  ['solarized-dark', '#268bd2'],
  ['github-dark', '#58a6ff'],
  ['solarized-light', '#268bd2'],
  ['github-light', '#0969da'],
  ['one-light', '#4078f2']
]

const rgb = (c: string): [number, number, number] => {
  const h = c.replace('#', '')
  const full = h.length === 3 ? h.split('').map((x) => x + x).join('') : h.slice(0, 6)
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number]
}
const toHex = (v: number[]): string => `#${v.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('')}`

/** `a` moved `t` of the way towards `b` (0 = a, 1 = b), as a hex colour. */
export function mix(a: string, b: string, t: number): string {
  const A = rgb(a)
  const B = rgb(b)
  return toHex(A.map((v, i) => v + (B[i] - v) * t))
}

const alpha = (c: string, a: number): string => {
  const [r, g, b] = rgb(c)
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

/** WCAG relative luminance. */
function luminance(c: string): number {
  const [r, g, b] = rgb(c).map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two colours (1 to 21). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * `c` moved towards `toward` (white on dark themes, black on light) only as far as it takes to reach `target`
 * contrast on every surface, so a soft palette (Solarized, One Dark) keeps its hue and still reads as UI text.
 */
function readable(c: string, surfaces: string[], target: number, toward: string): string {
  for (let t = 0; t <= 1.0001; t += 0.04) {
    const x = mix(c, toward, t)
    if (Math.min(...surfaces.map((s) => contrast(x, s))) >= target) return x
  }
  return toward
}

/** Text on an accent-coloured button: white, or near-black when the accent is too light for white to read. */
const onAccent = (accent: string): string => (contrast(accent, '#ffffff') >= 3 ? '#ffffff' : '#101114')

export function tokensFor(t: ITheme, accent: string, dark: boolean): Record<string, string> {
  const bg = t.background ?? (dark ? '#0f1115' : '#ffffff')
  const fg = t.foreground ?? (dark ? '#e6e6e6' : '#1c2128')
  const ok = t.green ?? '#3dd68c'
  const warn = t.yellow ?? '#f5a524'
  const err = t.red ?? '#ff6369'
  const info = t.blue ?? '#52a9ff'
  const common = {
    '--accent': accent,
    '--accent-soft': alpha(accent, dark ? 0.15 : 0.11),
    '--accent-soft-2': alpha(accent, dark ? 0.26 : 0.19),
    '--on-accent': onAccent(accent),
    '--ok': ok, '--ok-soft': alpha(ok, dark ? 0.14 : 0.12),
    '--warn': warn, '--warn-soft': alpha(warn, dark ? 0.15 : 0.13),
    '--err': err, '--err-soft': alpha(err, dark ? 0.15 : 0.12),
    '--info': info, '--info-soft': alpha(info, dark ? 0.15 : 0.12)
  }
  const surfaces = dark
    ? { '--bg': mix(bg, '#000000', 0.3), '--bg-elev': mix(bg, '#000000', 0.16), '--panel': mix(bg, fg, 0.035), '--panel-2': mix(bg, fg, 0.07) }
    : { '--bg': mix(bg, fg, 0.05), '--bg-elev': mix(bg, fg, 0.025), '--panel': bg, '--panel-2': mix(bg, fg, 0.035) }
  const on = Object.values(surfaces)
  const toward = dark ? '#ffffff' : '#000000'
  const text = {
    // Targets: body text 7.5:1, secondary 4.8:1 (above WCAG AA's 4.5), muted labels 3.2:1.
    '--text': readable(fg, on, 7.5, toward),
    '--text-2': readable(mix(fg, bg, dark ? 0.26 : 0.22), on, 4.8, toward),
    '--muted': readable(mix(fg, bg, dark ? 0.45 : 0.4), on, 3.2, toward)
  }
  if (dark) {
    return {
      ...common,
      ...surfaces,
      ...text,
      // The canvas sits a little darker than the terminal's own background, the panels a little lighter.
      '--border': mix(bg, fg, 0.13),
      '--border-strong': mix(bg, fg, 0.21),
      '--accent-2': mix(accent, '#ffffff', 0.15),
      '--shadow': '0 1px 2px rgba(0, 0, 0, 0.45)',
      '--shadow-md': '0 6px 16px -4px rgba(0, 0, 0, 0.55)',
      '--shadow-lg': '0 28px 64px -12px rgba(0, 0, 0, 0.75), 0 0 0 1px rgba(255, 255, 255, 0.05)'
    }
  }
  return {
    ...common,
    ...surfaces,
    ...text,
    '--border': mix(bg, fg, 0.12),
    '--border-strong': mix(bg, fg, 0.2),
    '--accent-2': mix(accent, '#000000', 0.12),
    '--shadow': `0 1px 2px ${alpha(fg, 0.06)}, 0 1px 1px ${alpha(fg, 0.04)}`,
    '--shadow-md': `0 4px 12px -2px ${alpha(fg, 0.1)}, 0 2px 4px -2px ${alpha(fg, 0.06)}`,
    '--shadow-lg': `0 24px 56px -12px ${alpha(fg, 0.3)}, 0 0 0 1px ${alpha(fg, 0.06)}`
  }
}

/** One app theme per scheme that has an accent, in ACCENTS order. */
export function buildAppThemes(schemes: { id: string; name: string; dark: boolean; theme: ITheme; backdrop?: string }[]): AppTheme[] {
  return ACCENTS.flatMap(([id, accent]) => {
    const s = schemes.find((t) => t.id === id)
    if (!s) return []
    const tokens = tokensFor(s.theme, accent, s.dark)
    // A scheme painted with a gradient (Cyber Wave) gets the same fade down the rail and the side panels.
    if (s.backdrop) {
      tokens['--rail-backdrop'] = `linear-gradient(180deg, ${tokens['--bg-elev']} 0%, ${mix(tokens['--bg-elev'], '#000000', 0.8)} 100%)`
      tokens['--panel-backdrop'] = `linear-gradient(180deg, ${tokens['--panel']} 0%, ${mix(tokens['--panel'], '#000000', 0.75)} 100%)`
    }
    return [{ id, name: s.name, dark: s.dark, scheme: s.id, accent, tokens }]
  })
}

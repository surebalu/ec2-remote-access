/**
 * Colour themes for the whole app. Each one fills in the tokens styles.css defines for light and dark (--bg, --panel,
 * --border, --text, --accent, the status colours…), computed from a terminal scheme's palette (appThemeTokens.ts) so
 * the chrome matches the terminal. The default theme leaves the stylesheet alone (Auto / Light / Dark); a colour
 * theme fixes light or dark itself, and a terminal set to "Match app" takes the theme's scheme.
 */
import { TERMINAL_THEMES } from './terminalThemes'
import { buildAppThemes, type AppTheme } from './appThemeTokens'

export type { AppTheme }

export const APP_THEMES: AppTheme[] = buildAppThemes(TERMINAL_THEMES)

export const findAppTheme = (id: string | undefined): AppTheme | null => (id ? APP_THEMES.find((t) => t.id === id) ?? null : null)

/** The terminal scheme to draw with: the chosen one, or on "Match app" the colour theme's (else the app default). */
export function effectiveScheme(terminalTheme: string | undefined, colorTheme: string | undefined): string | undefined {
  if (terminalTheme && terminalTheme !== 'auto') return terminalTheme
  return findAppTheme(colorTheme)?.scheme ?? terminalTheme
}

let applied: string[] = []

/** Paints the theme's tokens on <html> (inline, so they win over the stylesheet), or clears them for the default. */
export function applyColorTheme(id: string | undefined): AppTheme | null {
  const root = document.documentElement
  for (const k of applied) root.style.removeProperty(k)
  applied = []
  const t = findAppTheme(id)
  if (!t) {
    root.removeAttribute('data-color-theme')
    return null
  }
  for (const [k, v] of Object.entries(t.tokens)) root.style.setProperty(k, v)
  applied = Object.keys(t.tokens)
  root.setAttribute('data-color-theme', t.id)
  return t
}

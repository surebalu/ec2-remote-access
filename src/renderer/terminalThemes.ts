/**
 * Colour schemes for the embedded xterm.js terminal. Palettes follow the upstream projects' published values
 * (same numbers Warp / iTerm2 / Windows Terminal ship), so a scheme here looks like the one in your terminal.
 * 'auto' follows the app's light/dark appearance with the default xterm palette.
 */
import type { ITheme } from '@xterm/xterm'

export interface TerminalTheme {
  id: string
  name: string
  /** Whether the scheme has a dark background; drives contrast for the settings preview. */
  dark: boolean
  theme: ITheme
}

const p = (
  background: string, foreground: string, cursor: string, selection: string,
  black: string, red: string, green: string, yellow: string, blue: string, magenta: string, cyan: string, white: string,
  brightBlack: string, brightRed: string, brightGreen: string, brightYellow: string, brightBlue: string, brightMagenta: string, brightCyan: string, brightWhite: string
): ITheme => ({
  background, foreground, cursor, cursorAccent: background, selectionBackground: selection,
  black, red, green, yellow, blue, magenta, cyan, white,
  brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite
})

export const TERMINAL_THEMES: TerminalTheme[] = [
  { id: 'auto', name: 'Match app (default)', dark: true, theme: {} },
  {
    id: 'dracula', name: 'Dracula', dark: true,
    theme: p('#282a36', '#f8f8f2', '#f8f8f2', '#44475a80',
      '#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2',
      '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff')
  },
  {
    id: 'one-dark', name: 'One Dark', dark: true,
    theme: p('#282c34', '#abb2bf', '#528bff', '#3e445180',
      '#282c34', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf',
      '#5c6370', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff')
  },
  {
    id: 'tokyo-night', name: 'Tokyo Night', dark: true,
    theme: p('#1a1b26', '#c0caf5', '#c0caf5', '#33467c80',
      '#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6',
      '#414868', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5')
  },
  {
    id: 'catppuccin-mocha', name: 'Catppuccin Mocha', dark: true,
    theme: p('#1e1e2e', '#cdd6f4', '#f5e0dc', '#585b7080',
      '#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de',
      '#585b70', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8')
  },
  {
    id: 'nord', name: 'Nord', dark: true,
    theme: p('#2e3440', '#d8dee9', '#d8dee9', '#434c5e80',
      '#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0',
      '#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4')
  },
  {
    id: 'gruvbox-dark', name: 'Gruvbox Dark', dark: true,
    theme: p('#282828', '#ebdbb2', '#ebdbb2', '#50494580',
      '#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984',
      '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2')
  },
  {
    id: 'monokai', name: 'Monokai', dark: true,
    theme: p('#272822', '#f8f8f2', '#f8f8f0', '#49483e80',
      '#272822', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f8f8f2',
      '#75715e', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f9f8f5')
  },
  {
    id: 'solarized-dark', name: 'Solarized Dark', dark: true,
    theme: p('#002b36', '#839496', '#839496', '#073642a0',
      '#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5',
      '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3')
  },
  {
    id: 'github-dark', name: 'GitHub Dark', dark: true,
    theme: p('#0d1117', '#c9d1d9', '#c9d1d9', '#264f7880',
      '#484f58', '#ff7b72', '#3fb950', '#d29922', '#58a6ff', '#bc8cff', '#39c5cf', '#b1bac4',
      '#6e7681', '#ffa198', '#56d364', '#e3b341', '#79c0ff', '#d2a8ff', '#56d4dd', '#f0f6fc')
  },
  {
    id: 'solarized-light', name: 'Solarized Light', dark: false,
    theme: p('#fdf6e3', '#657b83', '#657b83', '#eee8d5c0',
      '#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5',
      '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3')
  },
  {
    id: 'github-light', name: 'GitHub Light', dark: false,
    theme: p('#ffffff', '#24292f', '#24292f', '#0969da30',
      '#24292f', '#cf222e', '#116329', '#4d2d00', '#0969da', '#8250df', '#1b7c83', '#6e7781',
      '#57606a', '#a40e26', '#1a7f37', '#633c01', '#218bff', '#a475f9', '#3192aa', '#8c959f')
  },
  {
    id: 'one-light', name: 'One Light', dark: false,
    theme: p('#fafafa', '#383a42', '#526fff', '#e5e5e6c0',
      '#383a42', '#e45649', '#50a14f', '#c18401', '#0184bc', '#a626a4', '#0997b3', '#a0a1a7',
      '#4f525e', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff')
  }
]

const AUTO_DARK: ITheme = { background: '#0f1115', foreground: '#e6e6e6', cursor: '#e6e6e6', cursorAccent: '#0f1115' }
const AUTO_LIGHT: ITheme = { background: '#ffffff', foreground: '#1c2128', cursor: '#1c2128', cursorAccent: '#ffffff' }

/** Resolves a theme id to xterm options, falling back to the app appearance when the id is 'auto' or unknown. */
export function resolveTerminalTheme(id: string | undefined, appDark: boolean): ITheme {
  const t = TERMINAL_THEMES.find((x) => x.id === id && x.id !== 'auto')
  return t ? t.theme : appDark ? AUTO_DARK : AUTO_LIGHT
}

/** Fonts offered in Settings. Every one except JetBrains Mono / Fira Code ships with macOS. */
export const TERMINAL_FONTS = ['Monaco', 'Menlo', 'SF Mono', 'JetBrains Mono', 'Fira Code', 'Courier New', 'Andale Mono']

export const DEFAULT_TERMINAL_FONT = 'Monaco'
export const DEFAULT_TERMINAL_FONT_SIZE = 13

/** Font stack for xterm: the chosen family first, then Mac monospace fallbacks so a missing font degrades gracefully. */
export function terminalFontFamily(font: string | undefined): string {
  const first = (font ?? '').trim() || DEFAULT_TERMINAL_FONT
  const fallbacks = ['Menlo', 'SF Mono', 'monospace'].filter((f) => f !== first)
  return [first, ...fallbacks].map((f) => (/\s/.test(f) ? `'${f}'` : f)).join(', ')
}

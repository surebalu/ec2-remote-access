/**
 * The app's font (Settings → General → App font): one stack for the interface and one for code-like text (IDs, IPs,
 * output), set as --ui-font and --mono-font on <html>. With a monospace choice such as Monaco both are that font.
 * Notes and terminals keep their own font settings; the whiteboard draws its text in the app font.
 */

export interface UiFont { id: string; label: string; stack: string; mono: boolean }

const MONO_FALLBACK = "'SF Mono', ui-monospace, Menlo, monospace"

export const UI_FONTS: UiFont[] = [
  { id: 'Monaco', label: 'Monaco', stack: `Monaco, ${MONO_FALLBACK}`, mono: true },
  { id: 'SF Mono', label: 'SF Mono', stack: MONO_FALLBACK, mono: true },
  { id: 'Menlo', label: 'Menlo', stack: "Menlo, Monaco, ui-monospace, monospace", mono: true },
  { id: 'System', label: 'San Francisco', stack: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif", mono: false },
  { id: 'Helvetica Neue', label: 'Helvetica Neue', stack: "'Helvetica Neue', Helvetica, Arial, sans-serif", mono: false },
  { id: 'Avenir Next', label: 'Avenir Next', stack: "'Avenir Next', Avenir, -apple-system, sans-serif", mono: false }
]

export const DEFAULT_UI_FONT = 'System'

const fontOf = (id: string | undefined): UiFont => UI_FONTS.find((f) => f.id === id) ?? UI_FONTS.find((f) => f.id === DEFAULT_UI_FONT)!

let current = fontOf(DEFAULT_UI_FONT).stack

/** The current interface font stack, for canvas text measuring (the whiteboard), which cannot read CSS variables. */
export const uiFontStack = (): string => current

/** Sets --ui-font and --mono-font for the chosen font. */
export function applyUiFont(id: string | undefined): void {
  const f = fontOf(id)
  current = f.stack
  const root = document.documentElement
  root.style.setProperty('--ui-font', f.stack)
  root.style.setProperty('--mono-font', f.mono ? f.stack : MONO_FALLBACK)
  // Monospaced letters run about a fifth wider; styles.css gives the sidebar and search field that much more room.
  root.toggleAttribute('data-ui-font-mono', f.mono)
}

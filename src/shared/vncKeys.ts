/**
 * X11 keysyms for screen sharing (RFB sends keys as keysyms, not characters or scancodes).
 *
 * macOS's own server reads them through a table in ScreensharingAgent (RemoteManagement), which pairs
 * Alt_L/Super_L with ⌘ Command (kVK 0x37), Alt_R/Super_R with right ⌘ (0x36), Meta_L with ⌥ Option (0x3A) and Meta_R
 * with right ⌥ (0x3D); Mode_switch and ISO_Level3_Shift are not in it at all. noVNC, on a Mac or iPhone, sends ⌘ as
 * Alt_L (fine for a Mac) and ⌥ as Mode_switch / ISO_Level3_Shift (the RealVNC convention for Linux servers), which a
 * Mac drops: `forAppleServer` turns those back into Meta so ⌥ works.
 */
export const KEYSYM = {
  BackSpace: 0xff08, Tab: 0xff09, Return: 0xff0d, Escape: 0xff1b, Delete: 0xffff,
  Home: 0xff50, Left: 0xff51, Up: 0xff52, Right: 0xff53, Down: 0xff54, PageUp: 0xff55, PageDown: 0xff56, End: 0xff57,
  Shift_L: 0xffe1, Control_L: 0xffe3, Meta_L: 0xffe7, Meta_R: 0xffe8, Alt_L: 0xffe9, Alt_R: 0xffea, Super_L: 0xffeb,
  Mode_switch: 0xff7e, ISO_Level3_Shift: 0xfe03, F1: 0xffbe
} as const

/** The keysym that types one character: Latin-1 is its own code, anything else the Unicode keysym range. */
export function charKeysym(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0
  if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return cp
  if (ch === '\n' || ch === '\r') return KEYSYM.Return
  if (ch === '\t') return KEYSYM.Tab
  return 0x01000000 + cp
}

/** Keys the phone's key bar and keyboard name (KeyboardEvent.key values), as keysyms. */
export const NAMED_KEYSYMS: Record<string, number> = {
  Escape: KEYSYM.Escape, Tab: KEYSYM.Tab, Enter: KEYSYM.Return, Backspace: KEYSYM.BackSpace, Delete: KEYSYM.Delete,
  ArrowUp: KEYSYM.Up, ArrowDown: KEYSYM.Down, ArrowLeft: KEYSYM.Left, ArrowRight: KEYSYM.Right,
  Home: KEYSYM.Home, End: KEYSYM.End, PageUp: KEYSYM.PageUp, PageDown: KEYSYM.PageDown,
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, KEYSYM.F1 + i]))
}

/** What noVNC sends for ⌥, made into what a Mac reads as ⌥. Every other keysym passes unchanged. */
export function forAppleServer(keysym: number): number {
  if (keysym === KEYSYM.Mode_switch) return KEYSYM.Meta_L
  if (keysym === KEYSYM.ISO_Level3_Shift) return KEYSYM.Meta_R
  return keysym
}

export type VncModifier = 'cmd' | 'option' | 'ctrl' | 'shift'

/** A modifier from the phone's key bar: ⌘/⌥ mean Command/Option on a Mac, Windows key/Alt elsewhere. */
export function modifierKeysym(mod: VncModifier, appleServer: boolean): number {
  if (mod === 'ctrl') return KEYSYM.Control_L
  if (mod === 'shift') return KEYSYM.Shift_L
  if (mod === 'cmd') return appleServer ? KEYSYM.Alt_L : KEYSYM.Super_L
  return appleServer ? KEYSYM.Meta_L : KEYSYM.Alt_L
}

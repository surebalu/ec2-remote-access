/** Byte sequences for the phone key bar (components/mobile/KeyBar.tsx); kept free of React so tests can load it. */

/** Sticky modifiers from the key bar; they apply to the next key typed on the phone keyboard, then release. */
export interface StickyMods { ctrl: boolean; alt: boolean }

/** Applies armed modifiers to what the terminal is about to send: Ctrl maps to the C0 control code, Alt prefixes ESC. */
export function applyStickyMods(data: string, mods: StickyMods): string {
  let out = data
  if (mods.ctrl && out.length === 1) {
    const c = out.toLowerCase().charCodeAt(0)
    if (c >= 97 && c <= 122) out = String.fromCharCode(c - 96)
    else if (out === ' ' || out === '@' || out === '2') out = '\x00'
    else if ('[3'.includes(out)) out = '\x1b'
    else if ('\\4'.includes(out)) out = '\x1c'
    else if (']5'.includes(out)) out = '\x1d'
    else if ('^6'.includes(out)) out = '\x1e'
    else if ('_-7'.includes(out)) out = '\x1f'
    else if (out === '?' || out === '8') out = '\x7f'
  }
  if (mods.alt) out = `\x1b${out}`
  return out
}

/** Escape sequences for the bar's keys; arrows follow the terminal's application-cursor mode like a real keyboard. */
export function keySequence(key: string, appCursor: boolean): string {
  const csi = appCursor ? '\x1bO' : '\x1b['
  switch (key) {
    case 'Esc': return '\x1b'
    case 'Tab': return '\t'
    case 'Up': return `${csi}A`
    case 'Down': return `${csi}B`
    case 'Right': return `${csi}C`
    case 'Left': return `${csi}D`
    case 'Home': return '\x1b[H'
    case 'End': return '\x1b[F'
    case 'PgUp': return '\x1b[5~'
    case 'PgDn': return '\x1b[6~'
    default: return key
  }
}

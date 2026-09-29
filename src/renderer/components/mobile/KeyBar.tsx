import type { ReactElement, ReactNode } from 'react'
import type { StickyMods } from '../../terminalKeys'
import { Icon } from '../icons'

function K({ children, on, wide, label, onPress }: { children: ReactNode; on?: boolean; wide?: boolean; label?: string; onPress: () => void }): ReactElement {
  return (
    <button
      type="button"
      className={`m-key ${on ? 'on' : ''} ${wide ? 'wide' : ''}`}
      aria-label={label}
      aria-pressed={on}
      // Keep focus (and the iOS keyboard) on the terminal: never let the bar itself take focus.
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPress}
    >
      {children}
    </button>
  )
}

export const TERMINAL_KEYS = ['Esc', 'Tab', 'Up', 'Down', 'Left', 'Right', '|', '/', '-', '~', '`', 'Home', 'End', 'PgUp', 'PgDn'] as const
const GLYPH: Record<string, string> = { Up: '↑', Down: '↓', Left: '←', Right: '→' }

/**
 * Accessory row above the iOS keyboard. `onKey` receives a TERMINAL_KEYS name; the host decides what it means
 * (escape sequence for SSH, scancode for RDP).
 */
export default function KeyBar({ mods, onMods, onKey, keys = TERMINAL_KEYS, keyboardOpen, onKeyboard, onMore, leading }: {
  mods: StickyMods
  onMods: (m: StickyMods) => void
  onKey: (key: string) => void
  keys?: readonly string[]
  keyboardOpen: boolean
  onKeyboard: () => void
  onMore?: () => void
  leading?: ReactNode
}): ReactElement {
  return (
    <div className="m-keybar" role="toolbar" aria-label="Extra keys">
      <K label={keyboardOpen ? 'Hide keyboard' : 'Show keyboard'} on={keyboardOpen} onPress={onKeyboard}><Icon.keyboard className="m-key-icon" /></K>
      {leading}
      <div className="m-keybar-scroll">
        <K on={mods.ctrl} label="Control (applies to the next key)" onPress={() => onMods({ ...mods, ctrl: !mods.ctrl })}>ctrl</K>
        <K on={mods.alt} label="Alt (applies to the next key)" onPress={() => onMods({ ...mods, alt: !mods.alt })}>alt</K>
        {keys.map((k) => (
          <K key={k} wide={k.length > 2 && !GLYPH[k]} label={k} onPress={() => onKey(k)}>{GLYPH[k] ?? k}</K>
        ))}
      </div>
      {onMore && <K label="More actions" onPress={onMore}>•••</K>}
    </div>
  )
}

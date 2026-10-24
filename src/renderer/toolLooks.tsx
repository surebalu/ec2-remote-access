import type { CSSProperties, ReactElement } from 'react'
import type { ToolKind } from './store'
import { Icon } from './components/icons'

/**
 * Each section's colour and icon, shared by the radial menu's bubbles and the home page's tool tiles so a tool looks
 * the same wherever it appears. Hues are fixed per section (never by rank), so a tile keeps its colour as the order
 * changes.
 */
export interface Look { hue: number; sat?: number; icon: () => ReactElement }

export const LOOKS: Record<ToolKind | 'hosts' | 'overview', Look> = {
  hosts: { hue: 212, icon: () => <Icon.server /> },
  overview: { hue: 282, icon: () => <Icon.grid /> },
  computers: { hue: 268, icon: () => <Icon.screenShare /> },
  devtools: { hue: 260, icon: () => <Icon.code /> },
  tasks: { hue: 124, icon: () => <Icon.tasks /> },
  calendar: { hue: 48, icon: () => <Icon.calendar /> },
  links: { hue: 228, icon: () => <Icon.bookmark /> },
  health: { hue: 345, icon: () => <Icon.health /> },
  local: { hue: 150, icon: () => <Icon.console /> },
  finder: { hue: 196, icon: () => <Icon.finder /> },
  storage: { hue: 322, icon: () => <Icon.storage /> },
  cad: { hue: 28, icon: () => <Icon.cube /> },
  browser: { hue: 26, icon: () => <Icon.globe /> },
  notes: { hue: 88, icon: () => <Icon.note /> },
  board: { hue: 302, icon: () => <Icon.board /> },
  claude: { hue: 14, icon: () => <Icon.claude /> },
  chatgpt: { hue: 168, icon: () => <Icon.chatgpt /> }
}

/** A squircle or bubble's fill, shadow and ring for a hue, as CSS variables (--bg, --shadow, --ring). */
export function lookVars(hue: number, sat = 88, shadow = '0 8px 18px -6px'): CSSProperties {
  return {
    '--bg': `linear-gradient(140deg, hsl(${hue} ${sat}% 66%), hsl(${hue + 18} ${Math.max(0, sat - 4)}% 46%))`,
    '--shadow': `${shadow} hsl(${hue} ${sat}% 38% / .6)`,
    '--ring': `hsl(${hue} ${sat}% 60%)`
  } as CSSProperties
}

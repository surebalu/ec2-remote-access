import type { AccentColor, AccountMeta, Instance, Settings } from '@shared/types'
import { MANUAL_PROFILE } from '@shared/manual'

export const ACCENTS: AccentColor[] = ['emerald', 'amber', 'rose', 'violet', 'sky', 'teal', 'orange', 'slate']

/** Deterministic fallback so every account gets a distinct color before the user picks one. */
function hashColor(key: string): AccentColor {
  let h = 0
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return ACCENTS[h % (ACCENTS.length - 1)] // never 'slate' by default
}

/** Group id for an instance: profile name for AWS, `group:<name>` for manual hosts. */
export function groupKeyOf(i: Instance): string {
  return i.manual ? `group:${i.region}` : i.profile
}

export function metaFor(key: string, settings?: Settings): Required<AccountMeta> {
  const m = settings?.accountMeta?.[key] ?? {}
  const label = m.label ?? (key.startsWith('group:') ? key.slice(6) : key)
  return { label, color: m.color ?? (key === MANUAL_PROFILE ? 'teal' : hashColor(key)) }
}

export function initials(label: string): string {
  const parts = label.replace(/[^a-zA-Z0-9 _-]/g, ' ').split(/[\s_-]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return label.slice(0, 2).toUpperCase()
}

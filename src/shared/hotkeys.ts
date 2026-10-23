/**
 * Every key the app takes from all of macOS while it runs: the launcher's, the Links panels', the window layouts' and
 * the app hotkeys'. Settings checks a new one against the rest (no two may share a combination) and main registers
 * them (main/launcherWindow.ts, main/linksPanel.ts, main/desktopKeys.ts). Pure, for tests/hotkeys.test.ts.
 */
import type { AppHotkey, Settings } from './types'
import type { GlobalKey } from './keyCombos'
import { normalizeCombo } from './keyCombos.ts'
import { layoutById } from './windowLayouts.ts'

export interface NamedGlobalKey extends GlobalKey {
  /** 'launcher', 'linkSave', 'linkFind', 'window:<layout id>' or 'app:<hotkey id>'. */
  id: string
}

type KeySettings = Pick<Settings, 'launcherKey' | 'linkSaveKey' | 'linkFindKey' | 'windowKeys' | 'appHotkeys'>

/** The Links panels keep Anybox's keys unless changed ('' turns one off). */
export const LINK_KEY_DEFAULTS = { linkSaveKey: 'ctrl+s', linkFindKey: 'ctrl+f' } as const

export function globalKeysOf(s: KeySettings | undefined): NamedGlobalKey[] {
  const out: NamedGlobalKey[] = [
    { id: 'launcher', combo: s?.launcherKey ?? '', does: 'opens the launcher' },
    { id: 'linkSave', combo: s?.linkSaveKey ?? LINK_KEY_DEFAULTS.linkSaveKey, does: 'saves the page in front to Links' },
    { id: 'linkFind', combo: s?.linkFindKey ?? LINK_KEY_DEFAULTS.linkFindKey, does: 'searches Links' }
  ]
  for (const [id, combo] of Object.entries(s?.windowKeys ?? {})) {
    const l = layoutById(id)
    if (l && combo) out.push({ id: `window:${id}`, combo: normalizeCombo(combo), does: `moves the window in front to ${l.name}` })
  }
  for (const h of s?.appHotkeys ?? []) if (h.combo) out.push({ id: `app:${h.id}`, combo: normalizeCombo(h.combo), does: `opens ${h.name}` })
  return out.filter((k) => k.combo)
}

/** The other keys a new one for `id` must not repeat. */
export const otherGlobalKeys = (s: KeySettings | undefined, id: string): NamedGlobalKey[] => globalKeysOf(s).filter((k) => k.id !== id)

/** An app hotkey as stored: a name from the bundle when none is given, the combination in the stored order. */
export function cleanAppHotkey(h: AppHotkey): AppHotkey {
  const name = h.name.trim() || h.path.replace(/\/+$/, '').split('/').pop()!.replace(/\.app$/i, '')
  return { id: h.id, path: h.path, name, combo: normalizeCombo(h.combo) }
}

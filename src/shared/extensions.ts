/**
 * Browser extensions (main/extensions.ts, components/browser/Extensions.tsx): Chrome extensions from the Chrome Web
 * Store or a folder, loaded with Electron's own extension support into every Browser space (no third-party library,
 * so no licence to pay or follow). Electron gives extensions content scripts, background service workers, popups,
 * storage, scripting, declarativeNetRequest, webRequest and alarms, but not context menus, notifications, cookies,
 * keyboard commands or opening tabs and windows, so extensions that work on the page (Dark Reader, uBlock Origin Lite,
 * JSON viewers) work and some toolbar popups do not. This is the pure part: tests/extensions.test.ts.
 */

export interface ExtensionInfo {
  /** The Chrome Web Store id, or `local-…` for a folder. */
  id: string
  /** The id pages use (chrome-extension://<runtimeId>/…), once it is loaded. */
  runtimeId: string | null
  name: string
  version: string
  description: string
  /** Its icon as a data URL, '' when it has none. */
  icon: string
  /** Its toolbar popup page, relative to the extension. */
  popup: string | null
  /** Its options page, relative to the extension. */
  options: string | null
  enabled: boolean
  source: 'store' | 'folder'
  path: string
  manifestVersion: number
  /** Which sites it can read and change. */
  access: { all: boolean; hosts: string[] }
  /** Chrome features it asks for that Electron does not have, so parts of it may not work. */
  missing: string[]
  installedAt: number
}

/** The 32-letter id in a Chrome Web Store link ("…/detail/dark-reader/eimadpbcbfnmbkopoojfekhnkhdbieeh") or alone. */
export function storeIdOf(input: string): string | null {
  const s = input.trim()
  if (/^[a-p]{32}$/.test(s)) return s
  let u: URL
  try { u = new URL(s) } catch { return null }
  if (!/(^|\.)chromewebstore\.google\.com$|^chrome\.google\.com$/.test(u.hostname)) return null
  return u.pathname.split('/').find((p) => /^[a-p]{32}$/.test(p)) ?? null
}

/** Where the zip starts inside a CRX package (versions 2 and 3); throws when it is not one. */
export function crxZipOffset(buf: Uint8Array): number {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const magic = String.fromCharCode(buf[0], buf[1], buf[2], buf[3])
  if (buf.length < 16 || magic !== 'Cr24') throw new Error('The Chrome Web Store did not send an extension package.')
  const version = view.getUint32(4, true)
  const off = version === 3 ? 12 + view.getUint32(8, true) : version === 2 ? 16 + view.getUint32(8, true) + view.getUint32(12, true) : -1
  if (off < 0 || off + 4 > buf.length || buf[off] !== 0x50 || buf[off + 1] !== 0x4b) throw new Error('The extension package is not in a format this app reads.')
  return off
}

type Manifest = Record<string, unknown> & { manifest_version?: number }
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** The popup page (Manifest V3 `action`, V2 `browser_action` or `page_action`). */
export function popupOf(m: Manifest): string | null {
  return str(obj(m.action).default_popup) ?? str(obj(m.browser_action).default_popup) ?? str(obj(m.page_action).default_popup)
}

export function optionsOf(m: Manifest): string | null {
  return str(obj(m.options_ui).page) ?? str(m.options_page)
}

/** The icon file closest to `px` (and at least as large when there is one). */
export function iconPathOf(m: Manifest, px = 32): string | null {
  const sets = [obj(m.icons), obj(obj(m.action).default_icon), obj(obj(m.browser_action).default_icon)]
  for (const set of sets) {
    const sizes = Object.keys(set).map(Number).filter((n) => Number.isFinite(n) && str(set[String(n)])).sort((a, b) => a - b)
    if (!sizes.length) continue
    const pick = sizes.find((n) => n >= px) ?? sizes[sizes.length - 1]
    return str(set[String(pick)])
  }
  return str(obj(m.action).default_icon) ?? str(obj(m.browser_action).default_icon)
}

/** Which sites it can read and change: from host permissions and content-script matches. */
export function siteAccess(m: Manifest): { all: boolean; hosts: string[] } {
  const patterns: string[] = []
  const add = (v: unknown): void => { if (Array.isArray(v)) for (const p of v) if (typeof p === 'string') patterns.push(p) }
  add(m.host_permissions)
  if ((m.manifest_version ?? 2) < 3) add((Array.isArray(m.permissions) ? m.permissions : []).filter((p) => typeof p === 'string' && (p.includes('://') || p === '<all_urls>')))
  for (const cs of Array.isArray(m.content_scripts) ? m.content_scripts : []) add(obj(cs).matches)
  const all = patterns.some((p) => p === '<all_urls>' || /^(\*|https?):\/\/\*\/\*$/.test(p))
  const hosts = [...new Set(patterns.filter((p) => p !== '<all_urls>').map((p) => /^[^:]+:\/\/([^/]+)/.exec(p)?.[1] ?? '').filter((h) => h && h !== '*'))].sort()
  return { all, hosts: all ? [] : hosts }
}

/** Chrome features Electron does not give extensions; asking for one means part of the extension may not work. */
const UNSUPPORTED: Record<string, string> = {
  contextMenus: 'right-click menu items', notifications: 'notifications', cookies: 'reading cookies', commands: 'keyboard shortcuts',
  webNavigation: 'page navigation events', tabGroups: 'tab groups', history: 'browsing history', bookmarks: 'bookmarks', downloads: 'downloads',
  identity: 'signing in with Google', nativeMessaging: 'talking to a Mac app', sidePanel: 'a side panel', debugger: 'the debugger', proxy: 'proxy settings'
}

export function missingFeatures(m: Manifest): string[] {
  const asked = [...(Array.isArray(m.permissions) ? m.permissions : []), ...(Array.isArray(m.optional_permissions) ? m.optional_permissions : [])]
  const out = asked.filter((p): p is string => typeof p === 'string' && p in UNSUPPORTED).map((p) => UNSUPPORTED[p])
  if (m.commands) out.push(UNSUPPORTED.commands)
  if (m.side_panel) out.push(UNSUPPORTED.sidePanel)
  return [...new Set(out)]
}

/** Resolves "__MSG_appName__" from the extension's messages (`messages` = the default locale's file). */
export function localized(text: string, messages: Record<string, { message?: string }> | null): string {
  const m = /^__MSG_(.+)__$/.exec(text)
  if (!m || !messages) return text
  const key = Object.keys(messages).find((k) => k.toLowerCase() === m[1].toLowerCase())
  return (key && messages[key]?.message) || text
}

/** Whether `url` is a page of one of these loaded extensions (a popup or options page may be shown in a webview). */
export function isExtensionPage(url: string | undefined, runtimeIds: Iterable<string>): boolean {
  const m = /^chrome-extension:\/\/([a-p]{32})\//.exec(url ?? '')
  return !!m && [...runtimeIds].includes(m[1])
}

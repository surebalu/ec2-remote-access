/**
 * The Links panels, two small windows over any app as Anybox has (main/linksPanel.ts, renderer/linksPanel): one key
 * (⌃S by default) saves the page in front, in whichever browser, to Links with its tags, folder, comment and star;
 * another (⌃F) searches Links, its tags and folders from anywhere. What is pure about them lives here: which browsers
 * can say what page they show and the script that asks, reading the answers, the search list, and the saved item.
 * Pure: tests/linksPanel.test.ts.
 */
import { matchScore } from './launcher.ts'
import { domainOf, folderAndBelow, hasTag, normalizeUrl, searchLinks, type LinkFolder, type LinkItem } from './links.ts'

export type LinksPanelMode = 'save' | 'find'

/** The page in front when the save key was pressed. `url` is '' when there is none, and `problem` says why. */
export interface FrontPage {
  url: string
  title: string
  /** The app it came from ("Safari"; "Browser" for this app's own). */
  app?: string
  /**
   * 'not-browser': the app in front is not a browser. 'no-script': a browser that cannot tell other apps its page
   * (Firefox, Zen). 'not-allowed': macOS has not allowed this app to ask (Privacy & Security → Automation).
   * 'no-window': the browser has no window. 'failed': anything else.
   */
  problem?: 'not-browser' | 'no-script' | 'not-allowed' | 'no-window' | 'failed'
}

type Flavor = 'safari' | 'chromium' | 'none'
const safari = (name: string): { name: string; flavor: Flavor } => ({ name, flavor: 'safari' })
const chromium = (name: string): { name: string; flavor: Flavor } => ({ name, flavor: 'chromium' })
const none = (name: string): { name: string; flavor: Flavor } => ({ name, flavor: 'none' })

/**
 * Browsers by bundle id. Safari's scripting dictionary (Orion copies it) calls the tab `current tab` and its title
 * `name`; Chrome's (every Chromium browser, Arc and Dia included) `active tab` and `title`. Firefox and its relatives
 * have no dictionary at all, so their page cannot be read.
 */
const BROWSERS: Record<string, { name: string; flavor: Flavor }> = {
  'com.apple.Safari': safari('Safari'),
  'com.apple.SafariTechnologyPreview': safari('Safari Technology Preview'),
  'com.kagi.kagimacOS': safari('Orion'),
  'com.google.Chrome': chromium('Chrome'),
  'com.google.Chrome.beta': chromium('Chrome Beta'),
  'com.google.Chrome.dev': chromium('Chrome Dev'),
  'com.google.Chrome.canary': chromium('Chrome Canary'),
  'org.chromium.Chromium': chromium('Chromium'),
  'com.brave.Browser': chromium('Brave'),
  'com.brave.Browser.beta': chromium('Brave Beta'),
  'com.brave.Browser.nightly': chromium('Brave Nightly'),
  'com.microsoft.edgemac': chromium('Edge'),
  'com.microsoft.edgemac.Beta': chromium('Edge Beta'),
  'com.microsoft.edgemac.Dev': chromium('Edge Dev'),
  'com.vivaldi.Vivaldi': chromium('Vivaldi'),
  'com.operasoftware.Opera': chromium('Opera'),
  'company.thebrowser.Browser': chromium('Arc'),
  'company.thebrowser.dia': chromium('Dia'),
  'org.mozilla.firefox': none('Firefox'),
  'org.mozilla.firefoxdeveloperedition': none('Firefox Developer Edition'),
  'org.mozilla.nightly': none('Firefox Nightly'),
  'app.zen-browser.zen': none('Zen'),
  'net.waterfox.waterfox': none('Waterfox'),
  'io.gitlab.librewolf-community': none('LibreWolf')
}

/**
 * The browser an app is, and the AppleScript that returns its front tab's address and title on two lines (null for a
 * browser that cannot be asked). Not a browser: null. The bundle id goes into the script only once it is found in the
 * table above, so nothing from outside ever does.
 */
export function browserFor(bundleId: string): { name: string; script: string | null } | null {
  const b = Object.hasOwn(BROWSERS, bundleId) ? BROWSERS[bundleId] : undefined
  if (!b) return null
  if (b.flavor === 'none') return { name: b.name, script: null }
  const tab = b.flavor === 'safari' ? 'current tab of front window' : 'active tab of front window'
  const title = b.flavor === 'safari' ? 'name' : 'title'
  return { name: b.name, script: `tell application id "${bundleId}" to return (URL of ${tab}) & linefeed & (${title} of ${tab})` }
}

/** The front app from `lsappinfo info <asn>`: its name on the first line, then `bundleID="…"`. */
export function parseAppInfo(text: string): { name: string; bundleId: string } {
  return { name: /^\s*"([^"]*)"/.exec(text)?.[1] ?? '', bundleId: /bundleID="([^"]+)"/.exec(text)?.[1] ?? '' }
}

/** The script's answer: the address on the first line, the title after it. A blank tab answers "missing value". */
export function parseFrontPage(out: string): { url: string; title: string } {
  const at = out.indexOf('\n')
  const first = (at < 0 ? out : out.slice(0, at)).trim()
  const rest = at < 0 ? '' : out.slice(at + 1).trim()
  const url = first === 'missing value' || !/^[a-z][a-z0-9+.-]*:/i.test(first) ? '' : first
  return { url, title: rest === 'missing value' ? '' : rest }
}

/** Why osascript failed, from its error text: -1743 is macOS refusing (Automation), -1719/-1728 no such window. */
export function scriptProblem(stderr: string): FrontPage['problem'] {
  if (/-1743\b|not authori[sz]ed|not allowed/i.test(stderr)) return 'not-allowed'
  if (/-17(19|28)\b|Invalid index|Can.t get (window|tab|document)/i.test(stderr)) return 'no-window'
  return 'failed'
}

// ----- saving -----

/** The link already kept at this address (any spelling normalizeUrl folds together), if there is one. */
export function findSaved(links: LinkItem[], url: string): LinkItem | undefined {
  if (!url.trim()) return undefined
  const key = normalizeUrl(url)
  return links.find((l) => l.kind === 'link' && !!l.url && normalizeUrl(l.url) === key)
}

/** A tag as typed: no leading "#", no spaces around its "/" levels, no empty levels. '' when nothing is left. */
export function cleanTag(raw: string): string {
  return raw.trim().replace(/^#+/, '').split('/').map((p) => p.trim().replace(/\s+/g, ' ')).filter(Boolean).join('/').slice(0, 80)
}

/** The tags to offer for what is typed: best match first, none already chosen. All of them (by use) when nothing is typed. */
export function tagSuggestions(all: { path: string; count: number }[], typed: string, chosen: string[], limit = 8): string[] {
  const q = cleanTag(typed).toLowerCase()
  const have = new Set(chosen.map((t) => t.toLowerCase()))
  return all
    .filter((t) => !have.has(t.path.toLowerCase()))
    .map((t) => ({ t, score: q ? Math.max(matchScore(q, t.path), matchScore(q, t.path.split('/').pop() ?? '')) : 1 }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.t.count - a.t.count || a.t.path.localeCompare(b.t.path))
    .slice(0, limit)
    .map((x) => x.t.path)
}

export interface SaveForm {
  url: string
  title: string
  note: string
  tags: string[]
  folderId?: string
  starred: boolean
}

/**
 * What the save panel writes: the link already kept at this address with the form's values, or a new one. A kept
 * link keeps its own spelling of the address when the form's is only another spelling of it (www., a trailing slash).
 */
export function savedItem(existing: LinkItem | undefined, form: SaveForm, now: number, newId: () => string): LinkItem {
  const typed = form.url.trim()
  const url = existing?.url && normalizeUrl(existing.url) === normalizeUrl(typed) ? existing.url : typed
  const tags = [...new Set(form.tags.map(cleanTag).filter(Boolean))]
  const base: LinkItem = existing
    ? { ...existing, url, updatedAt: now }
    : { id: newId(), type: 'link', kind: 'link', url, title: '', addedAt: now, updatedAt: now }
  const next: LinkItem = { ...base, title: form.title.trim() || existing?.title || domainOf(url) || url }
  const set = <K extends keyof LinkItem>(k: K, v: LinkItem[K] | undefined): void => { if (v === undefined || v === '' || v === false || (Array.isArray(v) && !v.length)) delete next[k]; else next[k] = v as LinkItem[K] }
  set('note', form.note.trim())
  set('tags', tags)
  set('folderId', form.folderId)
  set('starred', form.starred)
  return next
}

// ----- searching -----

/** Where the search panel looks: everywhere, or inside a tag (and the tags below it) or a folder (and its subfolders). */
export type PanelScope = { kind: 'tag'; path: string } | { kind: 'folder'; id: string } | null

export type PanelEntry =
  | { kind: 'tag'; path: string; count: number }
  | { kind: 'folder'; folder: LinkFolder; count: number }
  | { kind: 'item'; item: LinkItem }

const lastUse = (l: LinkItem): number => Math.max(l.openedAt ?? 0, l.addedAt)

/**
 * The search panel's list. With nothing typed: the biggest tags and folders (inside a scope, the ones directly below
 * it), then what was opened or added most recently. With a query: the tags and folders whose name matches, then the
 * items Links' own search finds (every word somewhere in it), except that an item whose keyword is typed exactly
 * comes first of all, as Anybox's keywords do.
 */
export function panelEntries(links: LinkItem[], folders: LinkFolder[], query: string, scope: PanelScope, limit = 60): PanelEntry[] {
  const live = links.filter((l) => !l.archived)
  const folderMap = new Map(folders.map((f) => [f.id, f]))
  const inFolder = (id: string): LinkItem[] => { const ids = folderAndBelow(id, folders); return live.filter((l) => !!l.folderId && ids.has(l.folderId)) }
  const pool = !scope ? live : scope.kind === 'tag' ? live.filter((l) => hasTag(l, scope.path)) : inFolder(scope.id)

  // Every tag path used, with its parents, and how many items each covers.
  const tagPaths = new Set<string>()
  for (const l of live) for (const t of l.tags ?? []) { const parts = t.split('/'); for (let i = 1; i <= parts.length; i++) tagPaths.add(parts.slice(0, i).join('/')) }
  const tagCount = (path: string): number => live.filter((l) => hasTag(l, path)).length
  const childTag = (path: string): boolean => (scope?.kind === 'tag' ? path.startsWith(`${scope.path}/`) && !path.slice(scope.path.length + 1).includes('/') : !scope && !path.includes('/'))
  const childFolder = (f: LinkFolder): boolean => (scope?.kind === 'folder' ? f.parentId === scope.id : !scope && (!f.parentId || !folderMap.has(f.parentId)))
  // Inside a tag no folders are offered and inside a folder no tags: each narrows by its own kind.
  const tagsHere = scope?.kind === 'folder' ? [] : [...tagPaths].filter((p) => (scope?.kind === 'tag' ? p.startsWith(`${scope.path}/`) : true))
  const foldersHere = scope?.kind === 'tag' ? [] : scope?.kind === 'folder' ? folders.filter((f) => f.id !== scope.id && folderAndBelow(scope.id, folders).has(f.id)) : folders

  const q = query.trim()
  if (!q) {
    const tags = tagsHere.filter(childTag).map((path) => ({ kind: 'tag' as const, path, count: tagCount(path) })).filter((t) => t.count).sort((a, b) => b.count - a.count || a.path.localeCompare(b.path)).slice(0, scope ? 12 : 5)
    const fs = foldersHere.filter(childFolder).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)).map((folder) => ({ kind: 'folder' as const, folder, count: inFolder(folder.id).length })).slice(0, scope ? 12 : 5)
    const items = [...pool].sort((a, b) => lastUse(b) - lastUse(a)).map((item) => ({ kind: 'item' as const, item }))
    return [...tags, ...fs, ...items].slice(0, limit)
  }

  const tagHits = tagsHere
    .map((path) => ({ path, score: Math.max(matchScore(q, path.split('/').pop() ?? path), matchScore(q, path) - 5) }))
    .filter((x) => x.score >= 50).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 4)
    .map(({ path }) => ({ kind: 'tag' as const, path, count: tagCount(path) })).filter((t) => t.count)
  const folderHits = foldersHere
    .map((folder) => ({ folder, score: matchScore(q, folder.name) }))
    .filter((x) => x.score >= 50).sort((a, b) => b.score - a.score || a.folder.name.localeCompare(b.folder.name)).slice(0, 4)
    .map(({ folder }) => ({ kind: 'folder' as const, folder, count: inFolder(folder.id).length }))
  const found = searchLinks(pool, q, folderMap)
  const keyword = found[0]?.keyword && found[0].keyword.toLowerCase() === q.toLowerCase() ? [found.shift()!] : []
  const toEntry = (item: LinkItem): PanelEntry => ({ kind: 'item', item })
  return [...keyword.map(toEntry), ...tagHits, ...folderHits, ...found.map(toEntry)].slice(0, limit)
}

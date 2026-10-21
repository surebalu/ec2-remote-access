import { execFile } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, statSync, realpathSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { FinderPlace, FinderPlaces, OpenWithApp, RecentFile } from '@shared/finder'
import { cloudName, copyName, isBundle, placeKind } from '@shared/finder'
import { getSettings } from './store'

/**
 * The Finder tab's sidebar and Spotlight lists (macOS). Favorites are the ones in the macOS Finder sidebar, read from
 * com.apple.LSSharedFileList.FavoriteItems.sfl* with JavaScript for Automation (the file is a keyed archive of
 * bookmarks, which only Foundation resolves), plus folders added in this app, minus the ones hidden here.
 */

const run = (cmd: string, args: string[], timeout = 8000): Promise<string> =>
  new Promise((resolve, reject) => execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(out))))

// Resolves each sidebar bookmark to its path, without mounting anything (NSURLBookmarkResolutionWithoutMounting).
const FAVORITES_JXA = `
ObjC.import('Foundation')
function run() {
  const dir = $.NSHomeDirectory().js + '/Library/Application Support/com.apple.sharedfilelist/'
  const name = ['sfl4', 'sfl3', 'sfl2'].map((x) => 'com.apple.LSSharedFileList.FavoriteItems.' + x).find((f) => $.NSFileManager.defaultManager.fileExistsAtPath(dir + f))
  if (!name) return '[]'
  const data = $.NSData.dataWithContentsOfFile(dir + name)
  const root = $.NSKeyedUnarchiver.unarchiveObjectWithData(data)
  if (!root || root.isNil()) return '[]'
  const items = root.objectForKey('items')
  const out = []
  for (let i = 0; i < items.count; i++) {
    const bm = items.objectAtIndex(i).objectForKey('Bookmark')
    if (!bm || bm.isNil()) continue
    const url = $.NSURL.URLByResolvingBookmarkDataOptionsRelativeToURLBookmarkDataIsStaleError(bm, 1 << 9, $(), Ref(), $())
    if (url && !url.isNil() && url.isFileURL) out.push(url.path.js)
  }
  return JSON.stringify(out)
}`

let finderCache: { at: number; paths: string[] } | null = null

/** The macOS Finder sidebar's favorite folders, in its order (cached for a minute). */
async function finderFavorites(): Promise<string[]> {
  if (process.platform !== 'darwin') return []
  if (finderCache && Date.now() - finderCache.at < 60_000) return finderCache.paths
  try {
    const paths = (JSON.parse((await run('osascript', ['-l', 'JavaScript', '-e', FAVORITES_JXA])).trim() || '[]') as string[]).filter((p) => typeof p === 'string')
    finderCache = { at: Date.now(), paths }
    return paths
  } catch (e) {
    console.warn('[finder] could not read the Finder favorites:', (e as Error).message)
    return finderCache?.paths ?? []
  }
}

const isDir = (p: string): boolean => { try { return statSync(p).isDirectory() } catch { return false } }

export async function finderPlaces(): Promise<FinderPlaces> {
  const home = homedir()
  const s = getSettings()
  const hidden = new Set(s.finderHidden ?? [])
  const fromFinder = await finderFavorites()
  const defaults = process.platform === 'darwin' && !fromFinder.length ? ['/Applications', `${home}/Desktop`, `${home}/Documents`, `${home}/Downloads`] : []
  const seen = new Set<string>()
  const favorites: FinderPlace[] = []
  const add = (path: string, finder: boolean): void => {
    if (seen.has(path) || hidden.has(path) || !isDir(path)) return
    seen.add(path)
    favorites.push({ name: path === '/' ? 'Macintosh HD' : basename(path), path, kind: placeKind(path, home), fromFinder: finder || undefined })
  }
  for (const p of [...fromFinder, ...defaults]) add(p, true)
  for (const p of s.finderExtra ?? []) add(p, false)

  const locations: FinderPlace[] = []
  const icloud = join(home, 'Library/Mobile Documents/com~apple~CloudDocs')
  if (isDir(icloud)) locations.push({ name: 'iCloud Drive', path: icloud, kind: 'icloud' })
  const cloud = join(home, 'Library/CloudStorage')
  try {
    for (const d of readdirSync(cloud).sort()) if (!d.startsWith('.') && isDir(join(cloud, d))) locations.push({ name: cloudName(d), path: join(cloud, d), kind: 'cloud' })
  } catch { /* no cloud storage */ }
  if (process.platform === 'darwin') {
    locations.push({ name: 'Macintosh HD', path: '/', kind: 'computer' })
    try {
      for (const v of readdirSync('/Volumes').sort()) {
        const p = join('/Volumes', v)
        // The startup disk appears here as a link to /; Recovery is not something to browse.
        if (v === 'Recovery' || v.startsWith('.')) continue
        try { if (lstatSync(p).isSymbolicLink() && realpathSync(p) === '/') continue } catch { continue }
        if (isDir(p)) locations.push({ name: v, path: p, kind: 'volume' })
      }
    } catch { /* no volumes */ }
  } else {
    locations.push({ name: 'Computer', path: '/', kind: 'computer' })
  }
  return { favorites, locations, home }
}

/** Files opened in the last few weeks (Spotlight's last-used date), newest first, like Finder's Recents. */
export async function finderRecents(days = 30, limit = 150): Promise<RecentFile[]> {
  if (process.platform !== 'darwin') return []
  const home = homedir()
  let paths: string[]
  try {
    paths = (await run('mdfind', ['-0', '-onlyin', home, `kMDItemLastUsedDate >= $time.today(-${days}) && kMDItemContentType != public.folder`]))
      .split('\0').filter((p) => p && !p.includes('/Library/') && !/\/\./.test(p)).slice(0, 400)
  } catch {
    return []
  }
  if (!paths.length) return []
  let used: string[] = []
  try { used = (await run('mdls', ['-name', 'kMDItemLastUsedDate', '-raw', ...paths])).split('\0') } catch { /* sort by date modified instead */ }
  const out: RecentFile[] = []
  paths.forEach((p, i) => {
    try {
      const st = statSync(p)
      const lu = Date.parse((used[i] ?? '').replace(' +0000', 'Z').replace(' ', 'T'))
      out.push({ name: basename(p), path: p, type: st.isDirectory() ? 'dir' : 'file', size: st.size, mtime: st.mtimeMs, mode: st.mode, lastUsed: Number.isFinite(lu) ? lu : st.mtimeMs })
    } catch { /* gone since Spotlight saw it */ }
  })
  return out.sort((a, b) => b.lastUsed - a.lastUsed).slice(0, limit)
}

/** Spotlight search by name below a folder (Finder's search field with "This folder" chosen). */
export async function finderSearch(query: string, dir: string, limit = 300): Promise<RecentFile[]> {
  const q = query.trim()
  if (!q || process.platform !== 'darwin' || !existsSync(dir)) return []
  let paths: string[]
  try { paths = (await run('mdfind', ['-0', '-onlyin', dir, '-name', q])).split('\0').filter((p) => p && !/\/\./.test(p)).slice(0, limit) } catch { return [] }
  const out: RecentFile[] = []
  for (const p of paths) {
    try {
      const st = statSync(p)
      out.push({ name: basename(p), path: p, type: st.isDirectory() ? 'dir' : 'file', size: st.size, mtime: st.mtimeMs, mode: st.mode, lastUsed: st.mtimeMs })
    } catch { /* gone */ }
  }
  return out
}

// The default app first, then every other app Launch Services says can open the item (macOS 12+), by display name.
const OPEN_WITH_JXA = `
ObjC.import('AppKit')
function run(argv) {
  const ws = $.NSWorkspace.sharedWorkspace
  const fm = $.NSFileManager.defaultManager
  const url = $.NSURL.fileURLWithPath(argv[0])
  const out = []
  const add = (u, isDefault) => {
    if (!u || u.isNil()) return
    const path = u.path.js
    out.push({ path, name: fm.displayNameAtPath(path).js.replace(/\\.app$/, ''), isDefault })
  }
  add(ws.URLForApplicationToOpenURL(url), true)
  const all = ws.URLsForApplicationsToOpenURL ? ws.URLsForApplicationsToOpenURL(url) : $()
  for (let i = 0; i < (all.count || 0); i++) add(all.objectAtIndex(i), false)
  return JSON.stringify(out)
}`

/** The apps that can open an item, for Open With: the default first, then the rest by name, each app once. */
export async function finderOpenWithApps(path: string): Promise<OpenWithApp[]> {
  if (process.platform !== 'darwin' || typeof path !== 'string' || !path.startsWith('/') || !existsSync(path)) return []
  let found: OpenWithApp[]
  try { found = JSON.parse((await run('osascript', ['-l', 'JavaScript', '-e', OPEN_WITH_JXA, path])).trim() || '[]') as OpenWithApp[] } catch { return [] }
  // The same app can be registered from more than one place (/Applications and a system cryptex): show it once,
  // preferring the copy in /Applications.
  const byName = new Map<string, OpenWithApp>()
  for (const a of found) {
    const had = byName.get(a.name)
    if (!had) byName.set(a.name, a)
    else if (a.isDefault || (!had.isDefault && a.path.startsWith('/Applications/') && !had.path.startsWith('/Applications/'))) byName.set(a.name, { ...a, isDefault: a.isDefault || had.isDefault })
  }
  const list = [...byName.values()]
  return [...list.filter((a) => a.isDefault), ...list.filter((a) => !a.isDefault).sort((a, b) => a.name.localeCompare(b.name))]
}

const existing = (paths: unknown): string[] => {
  if (!Array.isArray(paths) || !paths.length) throw new Error('Nothing is selected.')
  for (const p of paths) if (typeof p !== 'string' || !p.startsWith('/') || !existsSync(p)) throw new Error(`“${basename(String(p))}” is no longer there.`)
  return paths as string[]
}

/** Opens items in the given app (Open With). */
export async function finderOpenWith(paths: string[], app: string): Promise<void> {
  const items = existing(paths)
  if (typeof app !== 'string' || !/\.app\/?$/i.test(app) || !isDir(app)) throw new Error('That app is no longer there.')
  await run('open', ['-a', app, ...items], 15_000)
}

const real = (p: string): string => { try { return realpathSync(p) } catch { return p } }

/**
 * Copies items into a folder, as Finder's Paste and Duplicate do, and returns their new paths. It never replaces
 * anything: an item beside its original is "name copy", one whose name is taken there keeps both ("name 2"). On a
 * Mac with ditto, which keeps what Finder keeps (extended attributes, app bundles' links and signatures).
 */
export async function finderPaste(paths: string[], dir: string): Promise<string[]> {
  const items = existing(paths)
  if (typeof dir !== 'string' || !dir.startsWith('/') || !isDir(dir)) throw new Error('Open a folder to paste into.')
  const into = real(dir)
  const taken = readdirSync(dir)
  const made: string[] = []
  for (const p of items) {
    const from = real(p)
    if (into === from || into.startsWith(`${from}/`)) throw new Error(`“${basename(p)}” cannot be copied into itself.`)
    const plainFolder = isDir(p) && !isBundle({ name: basename(p), type: 'dir' })
    const name = copyName(basename(p), plainFolder, taken, real(dirname(p)) === into)
    const to = join(dir, name)
    if (process.platform === 'darwin') await run('ditto', [p, to], 0)
    else await cp(p, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true })
    taken.push(name)
    made.push(to)
  }
  return made
}

/** Duplicate: each item copied beside itself. */
export async function finderDuplicate(paths: string[]): Promise<string[]> {
  const made: string[] = []
  for (const p of existing(paths)) made.push(...(await finderPaste([p], dirname(p))))
  return made
}

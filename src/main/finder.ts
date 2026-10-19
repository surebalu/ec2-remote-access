import { execFile } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, statSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { FinderPlace, FinderPlaces, RecentFile } from '@shared/finder'
import { cloudName, placeKind } from '@shared/finder'
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

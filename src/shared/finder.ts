/**
 * The pure rules behind the Finder tab (components/finder): display names for cloud folders, the Kind column, sizes
 * and dates the way Finder writes them, sorting, and the path bar. No Node or DOM, so the unit tests load it.
 */
import type { SftpEntry } from './types'

/** A place in the Finder sidebar. */
export interface FinderPlace {
  name: string
  path: string
  kind: 'recents' | 'home' | 'desktop' | 'documents' | 'downloads' | 'applications' | 'folder' | 'icloud' | 'cloud' | 'volume' | 'computer'
  /** From the macOS Finder sidebar (as opposed to added in this app). */
  fromFinder?: boolean
}

export interface FinderPlaces {
  favorites: FinderPlace[]
  locations: FinderPlace[]
  home: string
}

/** A file from Spotlight's recently used list: its entry plus when it was last opened. */
export interface RecentFile extends SftpEntry {
  lastUsed: number
}

const PROVIDERS: Record<string, string> = { GoogleDrive: 'Google Drive', OneDrive: 'OneDrive', Dropbox: 'Dropbox', Box: 'Box', iCloudDrive: 'iCloud Drive' }

/** "GoogleDrive-me@example.com" (a folder in ~/Library/CloudStorage) as Finder shows it: "Google Drive - me@example.com". */
export function cloudName(dir: string): string {
  const dash = dir.indexOf('-')
  const provider = dash < 0 ? dir : dir.slice(0, dash)
  const label = PROVIDERS[provider] ?? provider.replace(/([a-z])([A-Z])/g, '$1 $2')
  return dash < 0 ? label : `${label} - ${dir.slice(dash + 1)}`
}

/**
 * A folder as the launcher shows it under a file's name: cloud drives by their name ("Google Drive/Shared drives/Ops"),
 * iCloud Drive and the home folder (~) shortened, and a long path cut in the middle so its last folders stay.
 */
export function displayPath(dir: string, home: string, max = 48): string {
  let p = dir
  const cloud = `${home}/Library/CloudStorage/`
  const icloud = `${home}/Library/Mobile Documents/com~apple~CloudDocs`
  if (p.startsWith(cloud)) {
    const [drive, ...rest] = p.slice(cloud.length).split('/')
    p = [cloudName(drive).replace(/ - .*$/, ''), ...rest].join('/')
  } else if (p === icloud || p.startsWith(`${icloud}/`)) p = `iCloud Drive${p.slice(icloud.length)}`
  else if (home && (p === home || p.startsWith(`${home}/`))) p = `~${p.slice(home.length)}`
  if (p.length <= max) return p
  const parts = p.split('/')
  let tail = parts[parts.length - 1]
  for (let i = parts.length - 2; i > 0 && parts[0].length + tail.length + parts[i].length + 3 <= max; i--) tail = `${parts[i]}/${tail}`
  return `${parts[0]}/…/${tail}`
}

/** The kind of a well-known folder, for its sidebar icon. */
export function placeKind(path: string, home: string): FinderPlace['kind'] {
  if (path === home) return 'home'
  if (path === `${home}/Desktop`) return 'desktop'
  if (path === `${home}/Documents`) return 'documents'
  if (path === `${home}/Downloads`) return 'downloads'
  if (path === '/Applications' || path === `${home}/Applications`) return 'applications'
  return 'folder'
}

const KINDS: [RegExp, string][] = [
  [/^(png|jpe?g|gif|heic|webp|tiff?|bmp|svg)$/, 'image'], [/^pdf$/, 'PDF document'], [/^(md|markdown)$/, 'Markdown'],
  [/^(txt|log|rtf)$/, 'text'], [/^(docx?|pages)$/, 'document'], [/^(xlsx?|numbers|csv)$/, 'spreadsheet'],
  [/^(pptx?|key)$/, 'presentation'], [/^(zip|tar|gz|tgz|bz2|xz|7z|rar)$/, 'archive'], [/^(dmg|iso)$/, 'disk image'],
  [/^(mp4|mov|m4v|avi|mkv)$/, 'video'], [/^(mp3|m4a|wav|aac|flac)$/, 'audio'], [/^(pkg|mpkg)$/, 'installer package'],
  [/^(js|ts|tsx|jsx|py|go|rs|java|swift|c|h|cpp|sh|zsh|rb|php|cs|kt|sql|yaml|yml|json|toml|xml|html|css)$/, 'code'],
  [/^(pem|key|crt|cer|p12|pub)$/, 'key or certificate'], [/^rdp$/, 'Remote Desktop file']
]

/** Finder's Kind column: Folder, Application, Alias, or a description from the extension. */
export function kindOf(e: Pick<SftpEntry, 'name' | 'type'>): string {
  if (e.type === 'dir') return /\.app$/i.test(e.name) ? 'Application' : 'Folder'
  if (e.type === 'link') return 'Alias'
  const ext = /\.([^.]+)$/.exec(e.name)?.[1]?.toLowerCase() ?? ''
  if (!ext) return 'Document'
  const k = KINDS.find(([re]) => re.test(ext))?.[1]
  if (!k) return `${ext.toUpperCase()} file`
  return k === 'image' || k === 'video' || k === 'audio' || k === 'archive' || k === 'text' ? `${ext.toUpperCase()} ${k}` : k[0].toUpperCase() + k.slice(1)
}

/** Treat a bundle like Example.app as a file: double-click opens it rather than going inside. */
export const isBundle = (e: Pick<SftpEntry, 'name' | 'type'>): boolean => e.type === 'dir' && /\.(app|bundle|pkg|photoslibrary)$/i.test(e.name)

/** Sizes as Finder writes them (decimal units): "--" for folders, "612 bytes", "4 KB", "1.2 MB". */
export function formatSize(e: Pick<SftpEntry, 'size' | 'type' | 'name'>): string {
  if (e.type === 'dir' && !isBundle(e)) return '--'
  const n = e.size
  if (n < 1000) return `${n} byte${n === 1 ? '' : 's'}`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1000
  let i = 0
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++ }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/** "Dec 13, 2025 at 7:10 PM", or "Today at 9:41 AM" / "Yesterday at …" like Finder. */
export function formatDate(ms: number, now = Date.now(), locale?: string): string {
  const d = new Date(ms)
  const time = d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
  const day = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(new Date(now)) - day(d)) / 86_400_000)
  if (diff === 0) return `Today at ${time}`
  if (diff === 1) return `Yesterday at ${time}`
  return `${d.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' })} at ${time}`
}

export type FinderSort = { key: 'name' | 'mtime' | 'size' | 'kind'; dir: 1 | -1 }

/** Finder's order: folders mixed with files by the chosen column, names compared the way Finder does (2 before 10). */
export function sortEntries<T extends SftpEntry>(list: T[], sort: FinderSort): T[] {
  const byName = (a: T, b: T): number => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  const cmp = (a: T, b: T): number => {
    switch (sort.key) {
      case 'mtime': return a.mtime - b.mtime || byName(a, b)
      case 'size': return (a.type === 'dir' ? -1 : a.size) - (b.type === 'dir' ? -1 : b.size) || byName(a, b)
      case 'kind': return kindOf(a).localeCompare(kindOf(b)) || byName(a, b)
      default: return byName(a, b)
    }
  }
  return [...list].sort((a, b) => cmp(a, b) * sort.dir)
}

/** The path bar's steps from the disk down to `path`: [{ name: 'Macintosh HD', path: '/' }, { name: 'Users', … }, …]. */
export function pathSteps(path: string, diskName = 'Macintosh HD'): { name: string; path: string }[] {
  const parts = path.split('/').filter(Boolean)
  return [{ name: diskName, path: '/' }, ...parts.map((name, i) => ({ name, path: `/${parts.slice(0, i + 1).join('/')}` }))]
}

/** An app that can open an item (the Finder tab's Open With). */
export interface OpenWithApp {
  name: string
  path: string
  isDefault: boolean
}

/** The parent folder ('/' stays '/'). */
export const parentOf = (path: string): string => (path.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/')

/**
 * The name a copied item takes in its folder, as Finder names it: beside the original "report copy.pdf", then
 * "report copy 2.pdf" (a copy of a copy counts on rather than adding another "copy"); in another folder its own name, or
 * "report 2.pdf" when that is taken (Finder's Keep Both). A plain folder's name is never split at a dot.
 */
export function copyName(name: string, plainFolder: boolean, taken: string[], beside: boolean): string {
  const set = new Set(taken.map((t) => t.toLowerCase()))
  if (!beside && !set.has(name.toLowerCase())) return name
  const dot = plainFolder ? -1 : name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  const base = beside ? `${/^(.*) copy(?: \d+)?$/.exec(stem)?.[1] ?? stem} copy` : stem
  if (beside && !set.has(`${base}${ext}`.toLowerCase())) return `${base}${ext}`
  for (let n = 2; ; n++) if (!set.has(`${base} ${n}${ext}`.toLowerCase())) return `${base} ${n}${ext}`
}

/** A name for a new folder that is not taken yet: "untitled folder", "untitled folder 2", … */
export function freeName(base: string, taken: string[]): string {
  const set = new Set(taken.map((t) => t.toLowerCase()))
  if (!set.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) if (!set.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`
}

/**
 * The settings change for adding a folder to the Finder tab's favorites (it also shows a hidden Finder favorite again)
 * or removing one (a macOS Finder favorite is hidden here, never removed from Finder).
 */
export function favoritePatch(s: { finderExtra?: string[]; finderHidden?: string[] }, path: string, add: boolean): { finderExtra: string[]; finderHidden: string[] } {
  const extra = s.finderExtra ?? []
  const hidden = s.finderHidden ?? []
  return add
    ? { finderExtra: extra.includes(path) ? extra : [...extra, path], finderHidden: hidden.filter((p) => p !== path) }
    : { finderExtra: extra.filter((p) => p !== path), finderHidden: hidden.includes(path) ? hidden : [...hidden, path] }
}

// ----- Go to Folder (⇧⌘G) -----

/** A path as Go to Folder shows it: the home folder as ~. */
export const tildePath = (path: string, home: string): string => (home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path)

/**
 * A typed path as an absolute one, as Finder's Go to Folder reads it: ~ and ~/… are the home folder, a path without a
 * leading / is inside the current folder, quotes around a pasted path go, and . and .. resolve (never above /).
 */
export function resolveTyped(input: string, home: string, cwd: string): string {
  const text = input.trim().replace(/^(['"])(.*)\1$/, '$2')
  const full = text === '~' || text.startsWith('~/') ? home + text.slice(1) : text.startsWith('/') ? text : `${cwd.replace(/\/+$/, '')}/${text}`
  const parts: string[] = []
  for (const p of full.split('/')) {
    if (!p || p === '.') continue
    if (p === '..') parts.pop()
    else parts.push(p)
  }
  return `/${parts.join('/')}`
}

/**
 * What to suggest while typing: the folder the text is in so far (everything up to the last /) and the start of the
 * name after it. Folders whose name starts with that (any case) are offered; hidden ones only once the name starts
 * with a dot, or while hidden files are shown.
 */
export function typedParts(input: string): { dir: string; partial: string } {
  const text = input.trimStart()
  const cut = text.lastIndexOf('/')
  if (cut < 0) return text === '~' ? { dir: '~', partial: '' } : { dir: '', partial: text }
  return { dir: text.slice(0, cut + 1), partial: text.slice(cut + 1) }
}

export function folderHints<T extends Pick<SftpEntry, 'name' | 'type'>>(entries: T[], partial: string, showHidden: boolean, max = 8): T[] {
  const p = partial.toLowerCase()
  return entries
    .filter((e) => e.type === 'dir' && e.name.toLowerCase().startsWith(p) && (showHidden || p.startsWith('.') || !e.name.startsWith('.')))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    .slice(0, max)
}

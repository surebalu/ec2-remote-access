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

/** The parent folder ('/' stays '/'). */
export const parentOf = (path: string): string => (path.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/')

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

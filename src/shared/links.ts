/**
 * Links (components/links/LinksTab.tsx): a bookmark library in the spirit of Anybox. Links and short notes, in nested
 * folders, with tags, a star, a comment, a description and a keyword to open one quickly; kept as records
 * (src/shared/records.ts). Imports the formats other apps export (a browser's or Anybox's HTML bookmarks file, Anybox,
 * Pinboard, GoodLinks or this app's JSON, Pocket, Raindrop or any CSV with a URL column) and Anybox's own library on
 * this Mac (main/anybox.ts), and exports JSON (everything), HTML (for browsers and Anybox) and CSV.
 * Pure: tests/links.test.ts.
 */
import type { RecordItem, RecordOp } from './records'

export interface LinkItem extends RecordItem {
  type: 'link'
  /** A web link, a note (text, no URL), or a file kept on the Mac (Anybox's documents and images, copied out). */
  kind: 'link' | 'note' | 'file'
  url?: string
  /** A file's absolute path on the Mac. */
  path?: string
  /** A file's size in bytes. */
  size?: number
  title: string
  /** The page's own description. */
  description?: string
  /** The user's comment. */
  note?: string
  /** A note's text. */
  text?: string
  folderId?: string
  tags?: string[]
  starred?: boolean
  archived?: boolean
  /** A word that finds it at once in search (Anybox's keyword). */
  keyword?: string
  addedAt: number
  openedAt?: number
}

export interface LinkFolder extends RecordItem {
  type: 'folder'
  name: string
  parentId?: string
  order: number
}

/** A link or note as read from an import, before it has an id. */
export interface ParsedLink {
  kind: 'link' | 'note' | 'file'
  url?: string
  path?: string
  size?: number
  title: string
  description?: string
  note?: string
  text?: string
  /** Folder names from the top. */
  folder?: string[]
  tags?: string[]
  starred?: boolean
  archived?: boolean
  keyword?: string
  addedAt?: number
}

export interface ParsedLinks { links: ParsedLink[]; format: string }

/** Anybox's library on this Mac, read by main/anybox.ts. */
export interface AnyboxLibrary { links: ParsedLink[]; skippedFiles: number; source: string }

export type LinkView = 'all' | 'starred' | 'unsorted' | 'notes' | 'files' | 'archived' | `folder:${string}` | `tag:${string}`

// ----- urls -----

/** The address without its noise, to spot the same link twice: scheme and host lower-cased, no default port, no
 *  trailing slash, no utm_* tracking parameters. */
export function normalizeUrl(raw: string): string {
  let u: URL
  try { u = new URL(raw.trim()) } catch { return raw.trim() }
  for (const k of [...u.searchParams.keys()]) if (/^utm_|^fbclid$|^gclid$/i.test(k)) u.searchParams.delete(k)
  let s = `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.searchParams.toString() ? `?${u.searchParams}` : ''}${u.hash}`
  if (/^https?:$/.test(u.protocol)) s = s.replace(/^https?:\/\/www\./, (m) => m.replace('www.', ''))
  return s
}

export function domainOf(url: string | undefined): string {
  if (!url) return ''
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}

/** A typed address as a link: "example.com/x" becomes https://example.com/x; null when it is not one. */
/** A file item's extension, lower case ('' when it has none). */
export const extOf = (l: Pick<LinkItem, 'path' | 'title'>): string => ((l.path ?? l.title).match(/\.([a-z0-9]{1,6})$/i)?.[1] ?? '').toLowerCase()

/** A file's size as Finder writes it, '' when unknown. */
export const sizeLabel = (n?: number): string => (n === undefined ? '' : n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`)

export function asUrl(text: string): string | null {
  const t = text.trim()
  if (!t || /\s/.test(t)) return null
  if (/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(t)) return t
  if (/^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?(\/\S*)?$/i.test(t)) return `https://${t}`
  return null
}

// ----- folders -----

/** A folder's names from the top ("Work", "Docs"). */
export function folderPath(id: string | undefined, folders: Map<string, LinkFolder>): string[] {
  const out: string[] = []
  for (let f = id ? folders.get(id) : undefined, i = 0; f && i < 50; f = f.parentId ? folders.get(f.parentId) : undefined, i++) out.unshift(f.name)
  return out
}

/** A folder and every folder inside it. */
export function folderAndBelow(id: string, folders: LinkFolder[]): Set<string> {
  const out = new Set([id])
  for (let grew = true; grew;) {
    grew = false
    for (const f of folders) if (f.parentId && out.has(f.parentId) && !out.has(f.id)) { out.add(f.id); grew = true }
  }
  return out
}

/** Folders as an indented list (depth-first, by order then name), for the sidebar and pickers. */
export function folderTree(folders: LinkFolder[]): { folder: LinkFolder; depth: number }[] {
  const ids = new Set(folders.map((f) => f.id))
  const kids = (parent: string | undefined): LinkFolder[] => folders
    .filter((f) => (parent ? f.parentId === parent : !f.parentId || !ids.has(f.parentId)))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
  const out: { folder: LinkFolder; depth: number }[] = []
  const walk = (parent: string | undefined, depth: number): void => {
    for (const f of kids(parent)) {
      out.push({ folder: f, depth })
      if (depth < 20) walk(f.id, depth + 1)
    }
  }
  walk(undefined, 0)
  return out
}

// ----- views and search -----

export function viewLinks(view: LinkView, links: LinkItem[], folders: LinkFolder[]): LinkItem[] {
  if (view === 'archived') return links.filter((l) => l.archived)
  const live = links.filter((l) => !l.archived)
  if (view === 'starred') return live.filter((l) => l.starred)
  if (view === 'unsorted') return live.filter((l) => !l.folderId || !folders.some((f) => f.id === l.folderId))
  if (view === 'notes') return live.filter((l) => l.kind === 'note')
  if (view === 'files') return live.filter((l) => l.kind === 'file')
  if (view.startsWith('folder:')) {
    const ids = folderAndBelow(view.slice(7), folders)
    return live.filter((l) => l.folderId && ids.has(l.folderId))
  }
  if (view.startsWith('tag:')) return live.filter((l) => hasTag(l, view.slice(4)))
  return live
}

/**
 * A folder as Finder shows it: the folders directly inside it, in their order, then the items directly in it (not those
 * in its subfolders, which are a double-click away). Archived items stay in Archived.
 */
export function folderContents(id: string, links: LinkItem[], folders: LinkFolder[]): { folders: LinkFolder[]; items: LinkItem[] } {
  return {
    folders: folders.filter((f) => f.parentId === id).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)),
    items: links.filter((l) => !l.archived && l.folderId === id)
  }
}

/** The folders from the top down to `id` (its own included), for a path bar. */
export function folderChain(id: string | undefined, folders: Map<string, LinkFolder>): LinkFolder[] {
  const out: LinkFolder[] = []
  for (let f = id ? folders.get(id) : undefined, i = 0; f && i < 50; f = f.parentId ? folders.get(f.parentId) : undefined, i++) out.unshift(f)
  return out
}

/** Whether an item has the tag or one below it ("aws" covers "aws/iam", as Anybox's nested tags do). */
export const hasTag = (l: Pick<LinkItem, 'tags'>, path: string): boolean => !!l.tags?.some((t) => t === path || t.startsWith(`${path}/`))

/**
 * Tags as a tree by their "/" segments, depth-first and alphabetical: "aws" then "aws/iam". A parent that is only a
 * prefix ("aws" when only "aws/iam" is used) is still a node, so its children have somewhere to hang.
 */
export function tagTree(tags: string[]): { path: string; name: string; depth: number; parent?: string; hasChildren: boolean }[] {
  const paths = new Set<string>()
  for (const t of tags) {
    const parts = t.split('/').filter(Boolean)
    for (let i = 1; i <= parts.length; i++) paths.add(parts.slice(0, i).join('/'))
  }
  // Segment by segment, ignoring case first, so a tag's children stay together ("aws", "aws/iam", then "AWS").
  const byPath = (a: string, b: string): number => {
    const A = a.split('/'), B = b.split('/')
    for (let i = 0; i < Math.min(A.length, B.length); i++) {
      const c = A[i].toLowerCase().localeCompare(B[i].toLowerCase()) || A[i].localeCompare(B[i])
      if (c) return c
    }
    return A.length - B.length
  }
  const sorted = [...paths].sort(byPath)
  return sorted.map((path) => {
    const parts = path.split('/')
    return { path, name: parts[parts.length - 1], depth: parts.length - 1, parent: parts.length > 1 ? parts.slice(0, -1).join('/') : undefined, hasChildren: sorted.some((p) => p.startsWith(`${path}/`)) }
  })
}

/** Every word must be somewhere in it: title, address, description, comment, note text, tags, keyword or folder. */
export function searchLinks(links: LinkItem[], query: string, folders: Map<string, LinkFolder>): LinkItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return links
  const scored = links.map((l) => {
    const hay = [l.title, l.url, l.path?.split('/').pop(), l.description, l.note, l.text, l.keyword, ...(l.tags ?? []).map((t) => `#${t}`), ...folderPath(l.folderId, folders)].filter(Boolean).join(' \n').toLowerCase()
    if (!words.every((w) => hay.includes(w))) return null
    // A keyword typed exactly comes first, then title matches.
    const score = (l.keyword && words.join(' ') === l.keyword.toLowerCase() ? 100 : 0) + words.filter((w) => l.title.toLowerCase().includes(w)).length
    return { l, score }
  }).filter((x): x is { l: LinkItem; score: number } => !!x)
  return scored.sort((a, b) => b.score - a.score).map((x) => x.l)
}

export type LinkSort = 'added' | 'title' | 'domain' | 'opened'
export function sortLinks(links: LinkItem[], by: LinkSort): LinkItem[] {
  const out = [...links]
  if (by === 'title') return out.sort((a, b) => a.title.localeCompare(b.title))
  if (by === 'domain') return out.sort((a, b) => domainOf(a.url).localeCompare(domainOf(b.url)) || a.title.localeCompare(b.title))
  if (by === 'opened') return out.sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0) || b.addedAt - a.addedAt)
  return out.sort((a, b) => b.addedAt - a.addedAt)
}

export const allLinkTags = (links: LinkItem[]): string[] => [...new Set(links.flatMap((l) => l.tags ?? []))].sort((a, b) => a.localeCompare(b))

// ----- reading imports -----

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™', deg: '°', times: '×', euro: '€', pound: '£'
}
export const decodeEntities = (s: string): string => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === '#') {
    const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m
  }
  return ENTITIES[e.toLowerCase()] ?? m
})
const stripTags = (s: string): string => decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()

/** A date as seconds, milliseconds or text, as milliseconds. */
function toMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e11 ? Math.round(v * 1000) : Math.round(v)
  if (typeof v === 'string' && v.trim()) {
    if (/^\d+(\.\d+)?$/.test(v.trim())) return toMs(Number(v))
    const t = Date.parse(v)
    return Number.isNaN(t) ? undefined : t
  }
  return undefined
}

const splitTags = (v: unknown): string[] | undefined => {
  const raw = Array.isArray(v) ? v.map((t) => (typeof t === 'string' ? t : typeof t === 'object' && t ? String((t as { name?: unknown; title?: unknown }).name ?? (t as { title?: unknown }).title ?? '') : '')) : typeof v === 'string' ? v.split(v.includes(',') ? ',' : v.includes('|') ? '|' : /\s+/) : []
  const tags = [...new Set(raw.map((t) => t.trim().replace(/^#/, '')).filter(Boolean))]
  return tags.length ? tags : undefined
}

/** A browser's (or Anybox's, Raindrop's…) bookmarks file: nested <DL> folders of <A> links, <DD> descriptions. */
export function parseBookmarksHtml(html: string): ParsedLink[] {
  const out: ParsedLink[] = []
  const stack: (string | null)[] = []
  let pending: string | null = null
  let last: ParsedLink | null = null
  const re = /<(\/?)(dl|h3|a|dd)\b([^>]*)>/gi
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const close = m[1] === '/'
    const tag = m[2].toLowerCase()
    if (tag === 'dl') {
      if (close) stack.pop()
      else { stack.push(pending); pending = null }
      continue
    }
    if (close) continue
    const attrs: Record<string, string> = {}
    for (const a of m[3].matchAll(/([\w-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) attrs[a[1].toLowerCase()] = decodeEntities(a[3] ?? a[4] ?? a[5] ?? '')
    const end = html.slice(re.lastIndex).search(tag === 'dd' ? /<(dt|dl|\/dl|dd)\b/i : new RegExp(`</${tag}>`, 'i'))
    const inner = end < 0 ? '' : html.slice(re.lastIndex, re.lastIndex + end)
    if (tag === 'h3') pending = stripTags(inner) || 'Untitled'
    else if (tag === 'a') {
      if (!attrs.href || /^(javascript|place|data):/i.test(attrs.href)) { last = null; continue }
      last = {
        kind: 'link', url: attrs.href, title: stripTags(inner) || attrs.href,
        folder: stack.filter((s): s is string => !!s), tags: splitTags(attrs.tags), addedAt: toMs(attrs.add_date),
        starred: attrs.starred === 'true' || attrs.favorite === 'true' || undefined
      }
      out.push(last)
    } else if (tag === 'dd' && last) {
      const text = stripTags(inner)
      if (text) last.description = text
      last = null
    }
  }
  return out
}

const pick = (o: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const k of keys) {
    const hit = Object.keys(o).find((x) => x.toLowerCase() === k.toLowerCase())
    if (hit && o[hit] !== undefined && o[hit] !== null && o[hit] !== '') return o[hit]
  }
  return undefined
}
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v.trim() || undefined : typeof v === 'number' ? String(v) : undefined)
const yes = (v: unknown): boolean | undefined => (v === true || v === 1 || v === 'yes' || v === 'true' || v === '1' ? true : undefined)

/** One object from an Anybox, Pinboard, GoodLinks, Raindrop or this app's JSON export. */
function fromObject(o: Record<string, unknown>, folderOf?: (o: Record<string, unknown>) => string[] | undefined): ParsedLink | null {
  const url = str(pick(o, 'url', 'href', 'link', 'uri', 'address'))
  const text = str(pick(o, 'text', 'content', 'body'))
  // Pinboard keeps the title in "description" and the notes in "extended".
  const pinboard = 'href' in o && 'extended' in o
  const title = str(pinboard ? pick(o, 'description') : pick(o, 'title', 'name', 'linkTitle', 'link_title')) ?? url ?? (text ? text.split('\n')[0].slice(0, 80) : undefined)
  if (!title || (!url && !text && !(o.kind === 'file' && str(o.path)))) return null
  // A file this app exported (kind "file" with its path on the Mac).
  const path = o.kind === 'file' ? str(o.path) : undefined
  const folderRaw = path ? undefined : pick(o, 'folder', 'folderPath', 'collection', 'collectionTitle', 'category', 'path', 'folders', 'collections')
  const folder = folderOf ? folderOf(o) : (Array.isArray(folderRaw) ? folderRaw.map(String).filter(Boolean) : typeof folderRaw === 'string' ? folderRaw.split(/\s*[/>]\s*/).filter(Boolean) : typeof folderRaw === 'object' && folderRaw ? [str(pick(folderRaw as Record<string, unknown>, 'name', 'title')) ?? ''].filter(Boolean) : undefined)
  const kind: ParsedLink['kind'] = path ? 'file' : url ? 'link' : 'note'
  return {
    kind, url, title, text: kind === 'note' ? text : undefined, path, size: path && typeof o.size === 'number' ? o.size : undefined,
    description: str(pinboard ? undefined : pick(o, 'linkDescription', 'link_description', 'excerpt', 'summary', 'description')),
    note: str(pinboard ? pick(o, 'extended') : pick(o, 'comment', 'note', 'notes', 'annotation', 'memo')),
    folder: folder?.length ? folder : undefined,
    tags: splitTags(pick(o, 'tags', 'tag', 'labels', 'keywords')),
    starred: yes(pick(o, 'starred', 'isStarred', 'favorite', 'favourite', 'important', 'pinned')),
    archived: yes(pick(o, 'archived', 'isArchived')),
    keyword: str(pick(o, 'keyword')),
    addedAt: toMs(pick(o, 'addedAt', 'dateAdded', 'date_added', 'added', 'createdAt', 'created', 'created_at', 'time', 'time_added', 'add_date', 'date'))
  }
}

/** JSON exports: an array of links, or an object holding one (this app's own export keeps its folders by id). */
export function parseLinksJson(data: unknown): ParsedLink[] {
  const root = data as Record<string, unknown>
  // This app's export: folders with ids, links with folderId.
  if (root && !Array.isArray(root) && Array.isArray(root.links) && Array.isArray(root.folders)) {
    const folders = new Map((root.folders as LinkFolder[]).filter((f) => f && f.id).map((f) => [f.id, f]))
    return (root.links as Record<string, unknown>[]).map((o) => fromObject(o, (x) => {
      const p = folderPath(typeof x.folderId === 'string' ? x.folderId : undefined, folders)
      return p.length ? p : undefined
    })).filter((x): x is ParsedLink => !!x)
  }
  const list = Array.isArray(data) ? data : ['links', 'bookmarks', 'items', 'documents', 'data', 'posts', 'results'].map((k) => (root as Record<string, unknown>)?.[k]).find(Array.isArray)
  if (!Array.isArray(list)) throw new Error('No list of links in that JSON file.')
  return list.filter((o): o is Record<string, unknown> => !!o && typeof o === 'object').map((o) => fromObject(o)).filter((x): x is ParsedLink => !!x)
}

/** Rows of a CSV file (quoted fields, doubled quotes and line breaks inside quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const s = text.replace(/^﻿/, '')
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++ } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some((f) => f !== '')) rows.push(row)
      row = []
    } else field += c
  }
  row.push(field)
  if (row.some((f) => f !== '')) rows.push(row)
  return rows
}

/** A CSV export (Pocket, Raindrop, a spreadsheet): needs a URL column; the others are read by their header. */
export function parseLinksCsv(text: string): ParsedLink[] {
  const [head, ...rows] = parseCsv(text)
  if (!head) return []
  const keys = head.map((h) => h.trim())
  if (!keys.some((k) => /^(url|href|link|address)$/i.test(k))) throw new Error('That CSV file has no URL column.')
  return rows.map((r) => fromObject(Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ''])))).filter((x): x is ParsedLink => !!x)
}

/** Reads an export file by its content: HTML bookmarks, JSON or CSV. */
export function parseLinksFile(text: string, name = ''): ParsedLinks {
  const t = text.replace(/^﻿/, '').trimStart()
  if (/^<!DOCTYPE\s+NETSCAPE-Bookmark-file/i.test(t) || /\.html?$/i.test(name) || /<dt>\s*<a\s/i.test(t.slice(0, 20000))) return { links: parseBookmarksHtml(t), format: 'HTML bookmarks' }
  if (/^[[{]/.test(t)) {
    let data: unknown
    try { data = JSON.parse(t) } catch { throw new Error('That JSON file could not be read.') }
    return { links: parseLinksJson(data), format: 'JSON' }
  }
  return { links: parseLinksCsv(t), format: 'CSV' }
}

/** A page's title and description from its HTML head (Open Graph first, as link previews show them). */
export function pagePreview(html: string): { title?: string; description?: string } {
  const head = html.slice(0, 300_000)
  const meta = (name: string): string | undefined => {
    for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
      const tag = m[0]
      const key = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]
      if (key?.toLowerCase() !== name) continue
      const content = /\bcontent\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag)
      const v = content ? decodeEntities(content[2] ?? content[3] ?? '').replace(/\s+/g, ' ').trim() : ''
      if (v) return v
    }
    return undefined
  }
  const title = meta('og:title') ?? meta('twitter:title') ?? (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ? stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)![1]) : undefined)
  const description = meta('og:description') ?? meta('description') ?? meta('twitter:description')
  return { title: title?.slice(0, 500) || undefined, description: description?.slice(0, 2000) || undefined }
}

// ----- planning an import -----

export interface ImportPlan {
  ops: RecordOp[]
  added: number
  /** Already here: given the imported tags (and star) they lacked. */
  merged: number
  skipped: number
  folders: number
}

/**
 * What importing adds: folders by name under their parents (reusing ones that exist), and links not already here by
 * address (notes by title and text). A link that is already here keeps everything it has and gains the import's tags
 * and star.
 */
export function planImport(existing: { links: LinkItem[]; folders: LinkFolder[] }, parsed: ParsedLink[], newId: () => string, now = Date.now()): ImportPlan {
  const plan: ImportPlan = { ops: [], added: 0, merged: 0, skipped: 0, folders: 0 }
  const folders = [...existing.folders]
  const folderIds = new Map<string, string>()
  const keyOf = (parent: string | undefined, name: string): string => `${parent ?? ''}\u0000${name.toLowerCase()}`
  for (const f of folders) folderIds.set(keyOf(f.parentId, f.name), f.id)
  let order = folders.reduce((m, f) => Math.max(m, f.order), 0)
  const folderFor = (path: string[] | undefined): string | undefined => {
    let parent: string | undefined
    for (const name of path ?? []) {
      const k = keyOf(parent, name)
      let id = folderIds.get(k)
      if (!id) {
        id = newId()
        const f: LinkFolder = { id, type: 'folder', name: name.slice(0, 200), parentId: parent, order: ++order, updatedAt: now }
        folders.push(f)
        folderIds.set(k, id)
        plan.ops.push({ op: 'put', item: f })
        plan.folders++
      }
      parent = id
    }
    return parent
  }
  const byUrl = new Map(existing.links.filter((l) => l.url).map((l) => [normalizeUrl(l.url!), l]))
  const notes = new Set(existing.links.filter((l) => l.kind === 'note').map((l) => `${l.title}\u0000${l.text ?? ''}`))
  const files = new Set(existing.links.filter((l) => l.kind === 'file' && l.path).map((l) => l.path!))
  // Links added by this import: a later copy of the same address folds into it (one put per item).
  const added = new Map<string, LinkItem>()
  for (const p of parsed) {
    if (p.kind === 'link' && p.url) {
      const key = normalizeUrl(p.url)
      const have = byUrl.get(key)
      const mine = have ? added.get(have.id) : undefined
      if (mine) {
        const tags = [...new Set([...(mine.tags ?? []), ...(p.tags ?? [])])]
        if (tags.length) mine.tags = tags
        if (p.starred) mine.starred = true
        plan.skipped++
        continue
      }
      if (have) {
        const tags = [...new Set([...(have.tags ?? []), ...(p.tags ?? [])])]
        const gains = tags.length > (have.tags?.length ?? 0) || (p.starred && !have.starred)
        if (gains) {
          const merged: LinkItem = { ...have, tags, starred: have.starred || p.starred || undefined, updatedAt: now }
          byUrl.set(key, merged)
          plan.ops.push({ op: 'put', item: merged })
          plan.merged++
        } else plan.skipped++
        continue
      }
    } else if (p.kind === 'note') {
      const key = `${p.title}\u0000${p.text ?? ''}`
      if (notes.has(key)) { plan.skipped++; continue }
      notes.add(key)
    } else if (p.kind === 'file' && p.path) {
      if (files.has(p.path)) { plan.skipped++; continue }
      files.add(p.path)
    }
    const item: LinkItem = {
      id: newId(), type: 'link', kind: p.kind, url: p.url, path: p.path, size: p.size, title: p.title.slice(0, 1000), description: p.description, note: p.note, text: p.text,
      folderId: folderFor(p.folder), tags: p.tags, starred: p.starred, archived: p.archived, keyword: p.keyword, addedAt: p.addedAt ?? now, updatedAt: now
    }
    for (const k of Object.keys(item) as (keyof LinkItem)[]) if (item[k] === undefined) delete item[k]
    if (item.url) { byUrl.set(normalizeUrl(item.url), item); added.set(item.id, item) }
    plan.ops.push({ op: 'put', item })
    plan.added++
  }
  return plan
}

// ----- exporting -----

/** Everything, in a form this app reads back exactly (folders by id). */
export function exportLinksJson(links: LinkItem[], folders: LinkFolder[], now = Date.now()): string {
  const clean = <T extends RecordItem>(i: T): Omit<T, 'type' | 'updatedAt'> => {
    const { type: _t, updatedAt: _u, ...rest } = i
    return rest
  }
  return JSON.stringify({ app: 'EC2 Remote Access', kind: 'links', version: 1, exportedAt: new Date(now).toISOString(), folders: folders.map(clean), links: links.map(clean) }, null, 2)
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The Netscape bookmarks file browsers and Anybox import: folders as nested lists. Notes and files (no address) are left out. */
export function exportLinksHtml(links: LinkItem[], folders: LinkFolder[]): string {
  const out = ['<!DOCTYPE NETSCAPE-Bookmark-file-1>', '<!-- This is an automatically generated file. -->', '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">', '<TITLE>Bookmarks</TITLE>', '<H1>Bookmarks</H1>', '<DL><p>']
  const withUrl = links.filter((l) => l.url)
  const ids = new Set(folders.map((f) => f.id))
  const linkLine = (l: LinkItem, indent: string): void => {
    const attrs = [`HREF="${esc(l.url!)}"`, `ADD_DATE="${Math.floor(l.addedAt / 1000)}"`]
    if (l.tags?.length) attrs.push(`TAGS="${esc(l.tags.join(','))}"`)
    out.push(`${indent}<DT><A ${attrs.join(' ')}>${esc(l.title)}</A>`)
    const dd = [l.description, l.note].filter(Boolean).join('\n\n')
    if (dd) out.push(`${indent}<DD>${esc(dd)}`)
  }
  const walk = (parent: string | undefined, indent: string, depth: number): void => {
    for (const { folder: f } of folderTree(folders).filter((x) => (parent ? x.folder.parentId === parent : !x.folder.parentId || !ids.has(x.folder.parentId)))) {
      out.push(`${indent}<DT><H3>${esc(f.name)}</H3>`, `${indent}<DL><p>`)
      if (depth < 20) walk(f.id, `${indent}    `, depth + 1)
      for (const l of withUrl.filter((x) => x.folderId === f.id)) linkLine(l, `${indent}    `)
      out.push(`${indent}</DL><p>`)
    }
  }
  walk(undefined, '    ', 0)
  for (const l of withUrl.filter((x) => !x.folderId || !ids.has(x.folderId))) linkLine(l, '    ')
  out.push('</DL><p>')
  return `${out.join('\n')}\n`
}

const csvCell = (v: unknown): string => {
  const s = v === undefined || v === null ? '' : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function exportLinksCsv(links: LinkItem[], folders: LinkFolder[]): string {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const rows = [['title', 'url', 'folder', 'tags', 'description', 'note', 'text', 'starred', 'archived', 'keyword', 'added', 'file']]
  for (const l of links) rows.push([l.title, l.url ?? '', folderPath(l.folderId, byId).join('/'), (l.tags ?? []).join(','), l.description ?? '', l.note ?? '', l.text ?? '', l.starred ? 'true' : '', l.archived ? 'true' : '', l.keyword ?? '', new Date(l.addedAt).toISOString(), l.path ?? ''])
  return `${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`
}

/**
 * Path rules for notes (./notes.ts), kept free of fs and Electron so tests can load them. Every path the renderer
 * names is relative to the notes folder and must stay inside it; notes are Markdown files only.
 */
import { isAbsolute, posix, relative, resolve, sep } from 'node:path'

export const HOST_FOLDER_DEFAULT = 'EC2 Remote/Hosts'

/** Absolute path of a note inside `root`; throws when `rel` would leave it or is not a Markdown file. */
export function notePath(root: string, rel: string): string {
  // A leading slash means the notes folder's root, as in Obsidian; anything resolving outside it is refused below.
  const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!clean) throw new Error('Pick a note inside the notes folder.')
  const abs = resolve(root, clean)
  const back = relative(resolve(root), abs)
  if (!back || back.startsWith('..') || isAbsolute(back) || back.split(sep).includes('..')) throw new Error('That note is outside the notes folder.')
  if (!/\.md$/i.test(abs)) throw new Error('Notes are Markdown (.md) files.')
  return abs
}

/** Absolute path of a folder inside `root` (never the root itself, never a hidden folder such as .obsidian). */
export function folderPath(root: string, rel: string): string {
  const clean = rel.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!clean || clean.split('/').some((p) => !p || p.startsWith('.'))) throw new Error('Pick a folder inside the notes folder.')
  const abs = resolve(root, clean)
  const back = relative(resolve(root), abs)
  if (!back || back.startsWith('..') || isAbsolute(back) || back.split(sep).includes('..')) throw new Error('That folder is outside the notes folder.')
  return abs
}

/** A folder path inside the notes folder ("EC2 Remote/Hosts"), normalised; empty or escaping values fall back. */
export function cleanFolder(folder: string | undefined, fallback = HOST_FOLDER_DEFAULT): string {
  const f = (folder ?? '').replace(/\\/g, '/').split('/').map((p) => p.trim()).filter((p) => p && p !== '.' && p !== '..').join('/')
  return f || fallback
}

/** A file name Obsidian, macOS and Windows all accept. */
export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled'
}

/** The host note's path: "<folder>/<name> (<account>).md", or "<folder>/<name>.md" for a server outside AWS. */
export function hostNoteRel(folder: string, host: { name: string; instanceId: string; profile: string; manual?: boolean }): string {
  const name = safeFileName(host.name || host.instanceId)
  return posix.join(cleanFolder(folder), host.manual ? `${name}.md` : `${name} (${safeFileName(host.profile)}).md`)
}

/** The `ec2_key` a host note carries in its frontmatter, so a note survives the instance being renamed. */
export function frontmatterKey(text: string): string | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const k = m && /^ec2_key:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(m[1])
  return k ? k[1] : null
}

/**
 * Today's daily note, following Obsidian's Daily notes settings (`.obsidian/daily-notes.json`) for its folder. Only
 * the default YYYY-MM-DD name is produced, which is also Obsidian's default format.
 */
export function dailyNoteRel(obsidianDaily: { folder?: string } | null, now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const name = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.md`
  const folder = obsidianDaily ? cleanFolder(obsidianDaily.folder, '') : 'EC2 Remote/Daily'
  return folder ? posix.join(folder, name) : name
}

/** Relative path as shown and passed around: forward slashes. */
export function toRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/')
}

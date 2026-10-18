/**
 * Notes: Markdown files in one folder, by default the vault Obsidian has open, so both apps edit the same files with
 * no import or sync (Obsidian keeps working; this app adds a note per host beside its sessions and capture from
 * terminals). Settings → Notes folder moves it (a NAS share, say). Paths from the renderer are relative to the folder
 * and checked by ./notesPaths to stay inside it.
 */
import { existsSync, readFileSync } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { NoteEntry, NoteFile, NoteHit, NotesInfo } from '@shared/types'
import { findInstance } from './aws/inventory'
import { host } from './host'
import { cleanFolder, dailyNoteRel, folderPath, frontmatterKey, hostNoteRel, notePath, toRel } from './notesPaths'
import { getSettings } from './store'

const MAX_FILES = 5000
const SEARCH_FILE_BYTES = 1_000_000

/** The vault Obsidian has open (or used last) on this machine, from its own settings file. */
function obsidianVault(): string | null {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), 'Library/Application Support/obsidian/obsidian.json'), 'utf8')) as { vaults?: Record<string, { path?: string; open?: boolean; ts?: number }> }
    const vaults = Object.values(cfg.vaults ?? {})
    const pick = vaults.find((v) => v.open) ?? vaults.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))[0]
    return pick?.path && existsSync(pick.path) ? pick.path : null
  } catch {
    return null
  }
}

export function notesInfo(): NotesInfo {
  const s = getSettings()
  const hostFolder = cleanFolder(s.notesHostFolder)
  const chosen = s.notesDir.trim().replace(/^~(?=$|\/)/, homedir())
  const vault = chosen ? null : obsidianVault()
  const dir = chosen || vault || join(homedir(), 'Documents', 'EC2 Remote Access', 'Notes')
  return { dir, source: chosen ? 'setting' : vault ? 'obsidian' : 'default', hostFolder, exists: existsSync(dir) }
}

function root(): string {
  return notesInfo().dir
}

async function walk(dir: string, base: string, out: NoteEntry[]): Promise<void> {
  if (out.length >= MAX_FILES) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    // Obsidian's own folders (.obsidian, .trash) and other hidden or tooling folders are not notes.
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    const abs = join(dir, e.name)
    if (e.isDirectory()) {
      out.push({ path: toRel(base, abs), mtime: 0, size: 0, folder: true })
      await walk(abs, base, out)
    }
    else if (e.isFile() && /\.md$/i.test(e.name)) {
      const st = await stat(abs).catch(() => null)
      if (st) out.push({ path: toRel(base, abs), mtime: st.mtimeMs, size: st.size })
    }
    if (out.length >= MAX_FILES) return
  }
}

export async function listNotes(): Promise<NoteEntry[]> {
  const dir = root()
  const out: NoteEntry[] = []
  await walk(dir, dir, out)
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

export async function readNote(rel: string): Promise<NoteFile> {
  const abs = notePath(root(), rel)
  const [text, st] = await Promise.all([readFile(abs, 'utf8'), stat(abs)])
  return { path: rel, text, mtime: st.mtimeMs }
}

export async function statNote(rel: string): Promise<number | null> {
  return (await stat(notePath(root(), rel)).catch(() => null))?.mtimeMs ?? null
}

/**
 * Saves a note. With `baseMtime` (when the editor loaded it), a file changed on disk since (Obsidian saved it) is not
 * overwritten: the disk version comes back as `conflict` for the editor to offer. Written to a temporary sibling and
 * renamed, so a crash never leaves half a note.
 */
export async function writeNote(rel: string, text: string, baseMtime?: number): Promise<{ mtime: number; conflict?: NoteFile }> {
  const abs = notePath(root(), rel)
  if (baseMtime !== undefined) {
    const disk = await stat(abs).catch(() => null)
    if (disk && disk.mtimeMs > baseMtime + 1) return { mtime: disk.mtimeMs, conflict: await readNote(rel) }
  }
  await mkdir(dirname(abs), { recursive: true })
  const tmp = `${abs}.ec2ra-${process.pid}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, abs)
  return { mtime: (await stat(abs)).mtimeMs }
}

/** Creates a note (with a title line) unless it exists; returns its path. */
export async function createNote(rel: string, body?: string): Promise<string> {
  const abs = notePath(root(), rel)
  if (!existsSync(abs)) {
    await mkdir(dirname(abs), { recursive: true })
    const title = rel.split('/').pop()!.replace(/\.md$/i, '')
    await writeFile(abs, body ?? `# ${title}\n\n`, { encoding: 'utf8', flag: 'wx' }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e })
  }
  return rel
}

/** The note for a host, created on first use with what identifies it. Found by its ec2_key if the host was renamed. */
export async function hostNote(instanceKey: string): Promise<string> {
  const inst = findInstance(instanceKey)
  const info = notesInfo()
  const rel = hostNoteRel(info.hostFolder, { name: inst.name, instanceId: inst.instanceId, profile: inst.profile, manual: inst.key.startsWith('manual/') })
  if (existsSync(notePath(info.dir, rel))) return rel
  const folder = join(info.dir, info.hostFolder)
  for (const name of await readdir(folder).catch(() => [] as string[])) {
    if (!name.endsWith('.md')) continue
    const head = await readFile(join(folder, name), 'utf8').then((t) => t.slice(0, 2000)).catch(() => '')
    if (frontmatterKey(head) === inst.key) return `${info.hostFolder}/${name}`
  }
  const facts = [
    inst.key.startsWith('manual/') ? `Address: ${inst.publicIp ?? ''}` : `Instance: ${inst.instanceId} · ${inst.instanceType} · ${inst.region}`,
    [inst.privateIp && `Private IP: ${inst.privateIp}`, inst.publicIp && !inst.key.startsWith('manual/') && `Public IP: ${inst.publicIp}`, inst.osHint].filter(Boolean).join(' · ')
  ].filter(Boolean)
  const body = [
    '---',
    `ec2_key: ${inst.key}`,
    `account: ${inst.profile}`,
    'tags: [ec2]',
    '---',
    `# ${inst.name || inst.instanceId}`,
    '',
    ...facts.map((f) => `${f}  `),
    '',
    ''
  ].join('\n')
  return createNote(rel, body)
}

/** Today's daily note, in the folder Obsidian's Daily notes settings use. */
export async function dailyNote(): Promise<string> {
  const dir = root()
  let cfg: { folder?: string } | null = null
  try {
    cfg = JSON.parse(readFileSync(join(dir, '.obsidian', 'daily-notes.json'), 'utf8')) as { folder?: string }
  } catch {
    cfg = existsSync(join(dir, '.obsidian')) ? {} : null
  }
  const rel = dailyNoteRel(cfg)
  return createNote(rel, `# ${rel.split('/').pop()!.replace(/\.md$/, '')}\n\n`)
}

/** Adds a block to the end of a note (send-to-note from a terminal), creating the note if needed. */
export async function appendNote(rel: string, text: string): Promise<void> {
  const abs = notePath(root(), rel)
  await createNote(rel)
  const current = await readFile(abs, 'utf8').catch(() => '')
  const lead = !current || current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n'
  await appendFile(abs, `${lead}${text.replace(/\s+$/, '')}\n`, 'utf8')
}

/** Case-insensitive search over note names and contents; names first, then up to three lines per note. */
export async function searchNotes(query: string): Promise<NoteHit[]> {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const dir = root()
  const notes = (await listNotes()).filter((n) => !n.folder)
  const hits: NoteHit[] = notes.filter((n) => n.path.toLowerCase().includes(q)).slice(0, 50).map((n) => ({ path: n.path, line: 0, text: '' }))
  for (const n of notes) {
    if (hits.length >= 200) break
    if (n.size > SEARCH_FILE_BYTES) continue
    const text = await readFile(join(dir, n.path), 'utf8').catch(() => '')
    if (!text.toLowerCase().includes(q)) continue
    let found = 0
    text.split('\n').some((line, i) => {
      if (!line.toLowerCase().includes(q)) return false
      hits.push({ path: n.path, line: i + 1, text: line.trim().slice(0, 200) })
      return ++found >= 3
    })
  }
  return hits
}

/** Creates a folder (and any missing parents); returns its path. */
export async function createFolder(rel: string): Promise<string> {
  await mkdir(folderPath(root(), rel), { recursive: true })
  return rel.replace(/^\/+|\/+$/g, '')
}

/**
 * Renames (or moves) a note or a folder. A note keeps its .md extension; an existing note or folder at the new path
 * is never replaced. Links to it in other notes are not rewritten (Obsidian does that when renaming there).
 */
export async function renameEntry(from: string, to: string): Promise<string> {
  const dir = root()
  const isFolder = !/\.md$/i.test(from) && (await stat(folderPath(dir, from)).catch(() => null))?.isDirectory()
  const target = isFolder ? to.replace(/^\/+|\/+$/g, '') : /\.md$/i.test(to) ? to : `${to}.md`
  const src = isFolder ? folderPath(dir, from) : notePath(dir, from)
  const dst = isFolder ? folderPath(dir, target) : notePath(dir, target)
  if (src === dst) return target
  if (existsSync(dst) && src.toLowerCase() !== dst.toLowerCase()) throw new Error(`"${target}" already exists.`)
  await mkdir(dirname(dst), { recursive: true })
  await rename(src, dst)
  return target
}

/** Moves a note or folder to the Trash (the desktop's; a trash folder beside the gateway's data), never deleting outright. */
export async function deleteEntry(rel: string): Promise<void> {
  const dir = root()
  const isFolder = !/\.md$/i.test(rel)
  await host().trashPaths([isFolder ? folderPath(dir, rel) : notePath(dir, rel)])
}

/** A native folder picker for the notes folder (null on the headless gateway). */
export async function pickNotesFolder(): Promise<string | null> {
  return (await host().pickPaths({ title: 'Choose the notes folder', kind: 'directory', buttonLabel: 'Use this folder' }))?.[0] ?? null
}

/**
 * The data folder (Settings → Data): a second home for what you make in the app, typically a share on a NAS. This Mac
 * keeps its own copy in the app's data folder and always works from it, so nothing waits on the network and nothing
 * is lost while the NAS is away (a laptop on the road); whenever the folder can be reached the two are merged. The
 * Tasks, Calendar and Links documents merge item by item (mergeDocs in src/shared/records.ts: the later change of an
 * item wins, a deletion included), the whiteboards board by board (boardStep in src/shared/dataFolder.ts: the later
 * save wins; deleted boards are remembered so a copy does not bring them back). Another Mac pointed at the same folder
 * shares the same lists. Syncs a moment after each change, every minute, and when the setting changes.
 */
import { access, copyFile, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { boardStep, linkFileDest, mergeStamps } from '@shared/dataFolder'
import type { LinkItem } from '@shared/links'
import { itemsOf, mergeDocs, pruneDeleted, puts, RECORD_KINDS, type RecordDoc, type RecordKind } from '@shared/records'
import type { DataStatus } from '@shared/types'
import { boardsDir, deletedBoards, deletedBoardsFile, isBoardId, onBoardsChanged } from './boards'
import { host } from './host'
import { notesInfo } from './notes'
import { adoptRecords, applyRecords, loadRecords, onRecordsApplied, recordsDir } from './records'
import { getSettings } from './store'

/** Where the Links files Anybox's library brought in were put (scratchpad migration, Links' file items). */
const LINK_FILES = join(homedir(), 'Documents', 'EC2 Remote Access', 'Links Files')
const EVERY_MS = 60_000
/** A share whose server has gone can leave file calls hanging; past this the folder counts as unreachable. */
const REACH_MS = 6000

let timer: NodeJS.Timeout | null = null
let soon: NodeJS.Timeout | null = null
let syncing = false
let again = false
let reachable = false
let lastSync: number | undefined
let lastError: string | undefined
let linkFiles: DataStatus['linkFiles']
let unhook: (() => void)[] = []

const dataDir = (): string => (getSettings().dataDir ?? '').trim().replace(/^~(?=$|\/)/, homedir())

function within<T>(p: Promise<T>, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} did not answer within ${REACH_MS / 1000} s.`)), REACH_MS))])
}

/** Written next to the file under a name of this Mac's own, then moved over it, so a reader never sees half. */
async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${hostname().replace(/[^A-Za-z0-9_-]/g, '')}-${process.pid}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, file)
}

export function dataStatus(): DataStatus {
  const dir = dataDir()
  const user = host().userDataDir()
  const notes = notesInfo()
  return {
    dir,
    reachable: dir ? reachable : false,
    syncing,
    lastSync,
    lastError,
    linkFiles,
    places: [
      { id: 'app', label: 'This Mac’s copy', path: user, note: 'Settings, saved hosts, the cached inventory, passwords (sealed by the Keychain), Browser spaces and sign-ins.' },
      { id: 'records', label: 'Tasks, Calendar and Links', path: recordsDir(), note: dir ? 'Merged into the data folder.' : undefined },
      { id: 'boards', label: 'Whiteboards', path: boardsDir(), note: dir ? 'Copied to the data folder.' : undefined },
      { id: 'linkFiles', label: 'Links files', path: linkFilesRoot() },
      { id: 'notes', label: 'Notes', path: notes.dir, note: notes.source === 'obsidian' ? 'Your Obsidian vault (Settings → Notes changes it).' : 'Settings → Notes changes it.' },
      { id: 'logs', label: 'Logs', path: host().logsDir() }
    ]
  }
}

/** Where the Links file items are: their common folder, else the default one. */
export function linkFilesRoot(): string {
  let paths: string[] = []
  try { paths = itemsOf<LinkItem>(loadRecords('links'), 'link').flatMap((l) => (l.kind === 'file' && l.path ? [l.path] : [])) } catch { /* unreadable: the default */ }
  if (!paths.length) return LINK_FILES
  let common = dirname(paths[0])
  for (const p of paths) while (common.length > 1 && !p.startsWith(`${common}/`)) common = dirname(common)
  return common.length > 1 ? common : LINK_FILES
}

const tell = (): void => host().broadcast('data:status', dataStatus())

async function syncRecords(dir: string, kind: RecordKind): Promise<void> {
  const file = join(dir, 'records', `${kind}.json`)
  let theirs: RecordDoc | null = null
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as RecordDoc
    if (!raw || typeof raw.rev !== 'number' || !raw.items || typeof raw.items !== 'object') throw new Error('bad')
    theirs = pruneDeleted(raw)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`records/${kind}.json in the data folder could not be read, so it was left as it is.`)
  }
  const mine = loadRecords(kind)
  if (!theirs) {
    await writeAtomic(file, JSON.stringify(mine))
    return
  }
  // Theirs into mine (saved here and shown at once), and whatever only this Mac has back into the folder.
  await adoptRecords(kind, theirs)
  if (mergeDocs(theirs, loadRecords(kind)).changed) await writeAtomic(file, JSON.stringify(loadRecords(kind)))
}

async function boardStamp(file: string): Promise<number> {
  try {
    const b = JSON.parse(await readFile(file, 'utf8')) as { updatedAt?: unknown }
    return typeof b.updatedAt === 'number' ? b.updatedAt : 0
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? -1 : 0
  }
}

async function copyOver(from: string, to: string): Promise<void> {
  const tmp = `${to}.${hostname().replace(/[^A-Za-z0-9_-]/g, '')}-${process.pid}.tmp`
  await copyFile(from, tmp)
  const s = await stat(from)
  // The copy keeps the original's time, so the next sync sees the two are the same without reading them.
  await utimes(tmp, s.atime, s.mtime)
  await rename(tmp, to)
}

async function syncBoards(dir: string): Promise<void> {
  const mineDir = boardsDir()
  const theirsDir = join(dir, 'boards')
  await mkdir(theirsDir, { recursive: true })
  const theirsDeletedFile = join(dir, 'boards-deleted.json')
  let theirsDeleted: Record<string, number> = {}
  try { theirsDeleted = JSON.parse(await readFile(theirsDeletedFile, 'utf8')) as Record<string, number> } catch { /* none yet */ }
  const { merged: deleted, aChanged, bChanged } = mergeStamps(deletedBoards(), theirsDeleted)
  if (aChanged) await writeAtomic(deletedBoardsFile(), JSON.stringify(deleted))
  if (bChanged) await writeAtomic(theirsDeletedFile, JSON.stringify(deleted))

  const ids = (names: string[]): string[] => names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter(isBoardId)
  const all = new Set([...ids(await readdir(mineDir)), ...ids(await readdir(theirsDir))])
  for (const id of all) {
    const mineFile = join(mineDir, `${id}.json`)
    const theirsFile = join(theirsDir, `${id}.json`)
    const [a, b] = await Promise.all([stat(mineFile).catch(() => null), stat(theirsFile).catch(() => null)])
    // Same size and time: the copy made last time, nothing to read.
    if (a && b && a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 1000 && !deleted[id]) continue
    const step = boardStep(a ? await boardStamp(mineFile) : -1, b ? await boardStamp(theirsFile) : -1, deleted[id])
    if (step === 'delete') await Promise.all([rm(mineFile, { force: true }), rm(theirsFile, { force: true })])
    else if (step === 'push') await copyOver(mineFile, theirsFile)
    else if (step === 'pull') await copyOver(theirsFile, mineFile)
  }
}

/** Merges this Mac's copy with the data folder's, once; a call while one runs makes it run again after. */
export async function syncNow(): Promise<DataStatus> {
  const dir = dataDir()
  if (!dir) return dataStatus()
  if (syncing) { again = true; return dataStatus() }
  syncing = true
  tell()
  try {
    try {
      await within(access(dir, constants.R_OK | constants.W_OK), 'The data folder')
    } catch (e) {
      reachable = false
      throw new Error((e as NodeJS.ErrnoException).code === 'ENOENT'
        ? `${dir} is not there (is the NAS connected?). This Mac keeps working from its own copy and syncs when it is back.`
        : `${dir} cannot be reached (${(e as Error).message}). This Mac keeps working from its own copy and syncs when it is back.`)
    }
    reachable = true
    await mkdir(join(dir, 'records'), { recursive: true })
    for (const kind of RECORD_KINDS) await within(syncRecords(dir, kind), 'The data folder')
    await within(syncBoards(dir), 'The data folder')
    lastSync = Date.now()
    lastError = undefined
  } catch (e) {
    lastError = (e as Error).message
    console.warn('[data]', lastError)
  } finally {
    syncing = false
    tell()
    if (again) { again = false; void syncNow() }
  }
  return dataStatus()
}

/** A sync shortly after a change here, so several changes in a row make one. */
function syncSoon(): void {
  if (!dataDir()) return
  if (soon) clearTimeout(soon)
  soon = setTimeout(() => { soon = null; void syncNow() }, 2000)
}

/** Starts or stops syncing to match the setting; safe to call after every settings save. */
export function updateDataFolder(): void {
  const dir = dataDir()
  if (!dir) {
    if (timer) clearInterval(timer)
    timer = null
    for (const u of unhook) u()
    unhook = []
    reachable = false
    lastError = undefined
    return
  }
  if (!timer) {
    timer = setInterval(() => void syncNow(), EVERY_MS)
    unhook = [onRecordsApplied(syncSoon), onBoardsChanged(syncSoon)]
  }
  syncSoon()
}

/** On quit: a change still waiting for its sync goes to the data folder now, for at most a few seconds. */
export async function flushDataFolder(): Promise<void> {
  const pending = !!soon
  if (timer) clearInterval(timer)
  if (soon) clearTimeout(soon)
  timer = soon = null
  for (const u of unhook) u()
  unhook = []
  if (pending && dataDir()) await Promise.race([syncNow(), new Promise((r) => setTimeout(r, 4000))])
}

/** Checks a folder before it becomes the data folder: there, a folder, and writable. */
export async function checkDataFolder(dir: string): Promise<string> {
  const d = dir.trim().replace(/^~(?=$|\/)/, homedir())
  if (!d.startsWith('/')) throw new Error('Choose a folder (a full path).')
  const s = await within(stat(d), 'That folder').catch((e: Error) => { throw new Error(`${d} cannot be used: ${e.message}`) })
  if (!s.isDirectory()) throw new Error(`${d} is not a folder.`)
  await within(access(d, constants.W_OK), 'That folder').catch(() => { throw new Error(`This app cannot write to ${d}.`) })
  return d
}

/**
 * Copies the Links files into the data folder (keeping their folders) and points the links at the copies. The
 * originals stay where they are, to be deleted by hand once the copies are checked. Runs in the background; its
 * progress is in the status.
 */
export async function copyLinkFiles(): Promise<DataStatus> {
  const dir = dataDir()
  if (!dir) throw new Error('Choose a data folder first.')
  if (linkFiles && !linkFiles.finished) return dataStatus()
  const files = itemsOf<LinkItem>(loadRecords('links'), 'link').filter((l) => l.kind === 'file' && l.path)
  const root = linkFilesRoot()
  const to = join(dir, 'Links Files')
  linkFiles = { to, done: 0, total: files.length, finished: false }
  tell()
  void (async () => {
    const moved: LinkItem[] = []
    try {
      for (const l of files) {
        const dest = linkFileDest(l.path!, root, to)
        if (dest !== l.path) {
          const have = await stat(dest).catch(() => null)
          const src = await stat(l.path!).catch(() => null)
          if (!src) { linkFiles!.done++; continue }
          if (!have || have.size !== src.size) {
            await mkdir(dirname(dest), { recursive: true })
            await copyOver(l.path!, dest)
          }
          moved.push({ ...l, path: dest })
        }
        linkFiles!.done++
        if (linkFiles!.done % 20 === 0) tell()
      }
      if (moved.length) await applyRecords('links', puts(moved))
      linkFiles = { ...linkFiles!, finished: true }
    } catch (e) {
      // What was copied so far is pointed at, so a second run carries on where this one stopped.
      if (moved.length) await applyRecords('links', puts(moved)).catch(() => undefined)
      linkFiles = { ...linkFiles!, finished: true, error: (e as Error).message }
    }
    tell()
  })()
  return dataStatus()
}


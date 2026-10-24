import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { BOX_FOLDER, BOX_SIMPLE_UPLOAD_MAX, linkFileKey, syncDoc, type BoxStatus, type RemoteDoc } from '@shared/box'
import { boardStep, mergeStamps } from '@shared/dataFolder'
import type { LinkItem } from '@shared/links'
import type { BoxSetup, SetupPreview } from '@shared/setup'
import { itemsOf, puts, RECORD_KINDS, type RecordKind } from '@shared/records'
import { boardsDir, deletedBoards, deletedBoardsFile, isBoardId, onBoardsChanged } from './boards'
import { BoxHttpError, boxApp, boxSignedIn, boxSignOut, download, fileInfo, folderIn, listFolder, onBoxConnected, onBoxSignIn, removeFile, upload, uploadLarge, type BoxItem } from './box'
import { linkFilesRoot } from './dataFolder'
import { buildSetupFile, computerName, previewSetup } from './setup'
import { host } from './host'
import { log } from './log'
import { adoptRecords, applyRecords, loadRecords, onRecordsApplied } from './records'

/**
 * The sync with Box (Settings → Data → Box; channels box:*). Like the data folder (dataFolder.ts) this computer works
 * from its own copy and merges with Box a moment after each change, every minute and at start, with the same rules:
 * Tasks, Calendar, Links and CAD reviews item by item (syncDoc, which writes only over the version it read), the
 * whiteboards board by board (the later save wins, deletions remembered), and Links' files uploaded once each so a
 * computer without them downloads them when one is opened (openLinkFile). In Box:
 *   Remote Access Tool/records/<kind>.json, boards/<id>.json, boards-deleted.json, Links Files/…, setup/<computer>.json
 * box-state.json keeps the folder ids and what each file was at the last sync, so an unchanged minute costs three
 * listings and nothing is downloaded.
 */

interface State {
  user?: { name: string; login: string }
  rootId?: string
  dirs: Record<string, string>
  /** 'records/tasks.json' → Box's sha1 of it and this computer's revision, at the last sync. */
  seen: Record<string, { sha1: string; rev?: number }>
}

const EVERY_MS = 60_000
const stateFile = (): string => join(host().userDataDir(), 'box-state.json')
let state: State | null = null

function st(): State {
  if (state) return state
  try { state = JSON.parse(readFileSync(stateFile(), 'utf8')) as State } catch { state = { dirs: {}, seen: {} } }
  state.dirs ??= {}
  state.seen ??= {}
  return state
}

function saveState(): void {
  const tmp = `${stateFile()}.tmp`
  writeFileSync(tmp, JSON.stringify(st()))
  renameSync(tmp, stateFile())
}

const sha1 = (b: Buffer): string => createHash('sha1').update(b).digest('hex')
const named = (items: BoxItem[], name: string): BoxItem | undefined => items.find((e) => e.type === 'file' && e.name.toLowerCase() === name.toLowerCase())

let timer: NodeJS.Timeout | null = null
let soon: NodeJS.Timeout | null = null
let syncing = false
let again = false
let lastSync: number | undefined
let lastError: string | undefined
let files: BoxStatus['files']
let filesRunning = false
let unhook: (() => void)[] = []

export function boxStatus(): BoxStatus {
  const s = st()
  return {
    available: !!boxApp(),
    signedIn: boxSignedIn(),
    ...(s.user ? { user: s.user } : {}),
    ...(s.rootId ? { folder: { id: s.rootId, name: BOX_FOLDER } } : {}),
    syncing, lastSync, lastError, files
  }
}

const tell = (): void => host().broadcast('box:status', boxStatus())

// ----- folders -----

async function root(): Promise<string> {
  st().rootId ??= await folderIn('0', BOX_FOLDER)
  return st().rootId!
}

/** A folder below the app's, by its path ('records', 'Links Files/Docs'), made where missing. */
async function dir(path: string[]): Promise<string> {
  const key = path.join('/')
  if (st().dirs[key]) return st().dirs[key]
  const parent = path.length > 1 ? await dir(path.slice(0, -1)) : await root()
  st().dirs[key] = await folderIn(parent, path.at(-1)!)
  return st().dirs[key]
}

// ----- records -----

async function syncRecords(kind: RecordKind, dirId: string, listing: BoxItem[]): Promise<void> {
  const name = `${kind}.json`
  const key = `records/${name}`
  let current = named(listing, name)
  const seen = st().seen[key]
  if (current?.sha1 && seen && current.sha1 === seen.sha1 && seen.rev === loadRecords(kind).rev) return
  const remote: RemoteDoc = {
    read: async () => {
      if (!current) return null
      // The version tag first, then the content: a save in between only makes the write retry, never lose it.
      const info = await fileInfo(current.id)
      const bytes = await download(current.id)
      current = info
      return { text: bytes.toString('utf8'), etag: info.etag ?? '' }
    },
    write: async (text, etag) => {
      const r = await upload(dirId, name, Buffer.from(text, 'utf8'), current ? { id: current.id, ...(etag ? { etag } : {}) } : undefined)
      if (r === 'conflict') { current = named(await listFolder(dirId), name); return 'conflict' }
      current = r
      return 'ok'
    }
  }
  await syncDoc(remote, () => loadRecords(kind), async (theirs) => { await adoptRecords(kind, theirs) })
  if (current?.sha1) st().seen[key] = { sha1: current.sha1, rev: loadRecords(kind).rev }
}

// ----- whiteboards -----

const stampOf = (b: Buffer | null): number => {
  if (!b) return -1
  try {
    const v = JSON.parse(b.toString('utf8')) as { updatedAt?: unknown }
    return typeof v.updatedAt === 'number' ? v.updatedAt : 0
  } catch {
    return 0
  }
}

async function writeAtomic(file: string, data: Buffer | string): Promise<void> {
  const tmp = `${file}.box-${process.pid}.tmp`
  await writeFile(tmp, data)
  await rename(tmp, file)
}

async function syncBoards(rootItems: BoxItem[]): Promise<void> {
  const rootId = await root()
  const boardsId = await dir(['boards'])
  const delEntry = named(rootItems, 'boards-deleted.json')
  let theirsDeleted: Record<string, number> = {}
  if (delEntry) { try { theirsDeleted = JSON.parse((await download(delEntry.id)).toString('utf8')) as Record<string, number> } catch { /* unreadable: rewritten below */ } }
  const { merged: deleted, aChanged, bChanged } = mergeStamps(deletedBoards(), theirsDeleted)
  if (aChanged) await writeAtomic(deletedBoardsFile(), JSON.stringify(deleted))
  // A write that meets another computer's is left for the next sync, which merges the two lists again.
  if (bChanged) await upload(rootId, 'boards-deleted.json', Buffer.from(JSON.stringify(deleted)), delEntry ? { id: delEntry.id, ...(delEntry.etag ? { etag: delEntry.etag } : {}) } : undefined)

  const remote = new Map((await listFolder(boardsId)).filter((e) => e.type === 'file' && e.name.endsWith('.json')).map((e) => [e.name.slice(0, -5), e]))
  const mine = (await readdir(boardsDir()).catch(() => [] as string[])).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5))
  for (const id of new Set([...mine, ...remote.keys()])) {
    if (!isBoardId(id)) continue
    const file = join(boardsDir(), `${id}.json`)
    const mineBytes = await readFile(file).catch(() => null)
    const r = remote.get(id)
    if (mineBytes && r?.sha1 && sha1(mineBytes) === r.sha1 && !deleted[id]) continue
    const theirsBytes = r ? await download(r.id) : null
    const step = boardStep(stampOf(mineBytes), stampOf(theirsBytes), deleted[id])
    if (step === 'delete') {
      await rm(file, { force: true })
      if (r) await removeFile(r.id)
    } else if (step === 'push' && mineBytes) {
      await upload(boardsId, `${id}.json`, mineBytes, r ? { id: r.id, ...(r.etag ? { etag: r.etag } : {}) } : undefined)
    } else if (step === 'pull' && theirsBytes) {
      await writeAtomic(file, theirsBytes)
    }
  }
}

// ----- Links files -----

/**
 * Sends each Links file that is on this computer and not yet in Box, keeping its folders under "Links Files", and
 * records where it went (`box` on the item), which the next sync carries to the other computers. One file at a time,
 * apart from the sync, so a first upload of hundreds of files never holds up Tasks or Calendar.
 */
async function uploadLinkFiles(): Promise<void> {
  if (filesRunning || !boxSignedIn()) return
  const todo = itemsOf<LinkItem>(loadRecords('links'), 'link').filter((l) => l.kind === 'file' && l.path && !l.box && existsSync(l.path))
  if (!todo.length) return
  filesRunning = true
  const from = linkFilesRoot()
  let done = 0
  let tooLarge = 0
  let batch: LinkItem[] = []
  const flush = async (): Promise<void> => { if (batch.length) { const b = batch; batch = []; await applyRecords('links', puts(b)) } }
  files = { done, total: todo.length, tooLarge }
  tell()
  try {
    for (const l of todo) {
      if (!boxSignedIn()) break
      const size = statSync(l.path!).size
      const parts = linkFileKey(l.path!, from)
      const parent = await dir(['Links Files', ...parts.slice(0, -1)])
      const name = parts.at(-1)!
      // Up to 50 MB in one request; larger in parts, read from disk a part at a time.
      let r = size > BOX_SIMPLE_UPLOAD_MAX ? await uploadLarge(parent, name, l.path!, size) : await upload(parent, name, await readFile(l.path!))
      // Already there (an earlier run whose note of it was lost): that copy.
      if (r === 'conflict') r = named(await listFolder(parent), name) ?? 'conflict'
      if (r === 'too-large') tooLarge++
      else if (r !== 'conflict') batch.push({ ...l, box: { id: r.id, size } })
      done++
      files = { done, total: todo.length, tooLarge }
      if (done % 10 === 0) { await flush(); saveState(); tell() }
    }
  } catch (e) {
    log('box', `uploading Links files stopped: ${(e as Error).message}`)
    lastError = `Links files: ${(e as Error).message}`
  } finally {
    await flush().catch(() => undefined)
    saveState()
    filesRunning = false
    tell()
  }
}

/** Opens a Links file: from its place on this computer, else its copy in Box (downloaded once, kept in the app's data). */
export async function openLinkFile(id: string): Promise<void> {
  const l = loadRecords('links').items[id] as LinkItem | undefined
  if (!l || l.type !== 'link' || l.kind !== 'file') throw new Error('That link is not a file.')
  if (l.path && existsSync(l.path)) { await host().openPath(l.path); return }
  const name = basename(l.path ?? l.title).replace(/[\\/]/g, '_') || 'file'
  if (!l.box) throw new Error(`${name} is on another computer and not in Box yet; it is sent there from the computer that has it.`)
  if (!boxSignedIn()) throw new Error(`${name} is in Box: sign in to Box (Settings → Data) to open it here.`)
  const dest = join(host().userDataDir(), 'box-files', l.box.id, name)
  if (!existsSync(dest)) {
    const bytes = await download(l.box.id)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(`${dest}.tmp`, bytes)
    renameSync(`${dest}.tmp`, dest)
  }
  await host().openPath(dest)
}

// ----- each Mac's setup -----

/** A computer's name as a file name in Box (Box refuses slashes, and leading or trailing dots and spaces). */
const setupName = (computer: string): string => `${computer.replace(/[\\/]/g, '-').replace(/^[\s.]+|[\s.]+$/g, '') || 'Mac'}.json`

/**
 * This Mac's setup (what Export setup writes: settings and the Identity Center profiles, never secrets) kept in Box
 * as setup/<computer>.json, rewritten only when it changes (compared without its time), so a new Mac signed in to
 * Box can bring it over in one step. The gateway has no Mac setup to keep.
 */
async function syncSetup(): Promise<void> {
  if (!process.versions.electron) return
  const content = buildSetupFile(0)
  const hash = sha1(Buffer.from(JSON.stringify(content)))
  const name = setupName(content.from.computer)
  const key = `setup/${name}`
  if (st().seen[key]?.sha1 === hash) return
  const setupId = await dir(['setup'])
  const existing = named(await listFolder(setupId), name)
  // No version check: each Mac is the only writer of its own file.
  const r = await upload(setupId, name, Buffer.from(`${JSON.stringify({ ...content, exportedAt: Date.now() }, null, 2)}\n`), existing ? { id: existing.id } : undefined)
  if (r !== 'conflict') st().seen[key] = { sha1: hash }
}

/** The setups in Box, newest first, this Mac's own marked. */
export async function boxSetups(): Promise<BoxSetup[]> {
  if (!boxSignedIn()) throw new Error('Sign in to Box first (Settings → Data).')
  const mine = setupName(computerName()).toLowerCase()
  const out: BoxSetup[] = []
  for (const f of (await listFolder(await dir(['setup']))).filter((e) => e.type === 'file' && e.name.endsWith('.json'))) {
    try {
      const v = JSON.parse((await download(f.id)).toString('utf8')) as { kind?: string; exportedAt?: number; from?: { computer?: string } }
      if (v.kind !== 'ec2ra-setup') continue
      out.push({ id: f.id, computer: String(v.from?.computer ?? f.name.slice(0, -5)), exportedAt: Number(v.exportedAt) || 0, mine: f.name.toLowerCase() === mine })
    } catch { /* not a setup file */ }
  }
  return out.sort((a, b) => b.exportedAt - a.exportedAt)
}

/** What importing one of them would do; applied by setup:apply like a file. */
export async function previewBoxSetup(id: string): Promise<SetupPreview> {
  if (!/^\d+$/.test(id)) throw new Error('Not a Box file.')
  const text = (await download(id)).toString('utf8')
  const computer = (() => { try { return String((JSON.parse(text) as { from?: { computer?: string } }).from?.computer ?? '') } catch { return '' } })()
  return previewSetup(text, `Box: ${setupName(computer || 'Mac')}`)
}

// ----- running -----

export async function boxSyncNow(): Promise<BoxStatus> {
  if (!boxSignedIn()) return boxStatus()
  if (syncing) { again = true; return boxStatus() }
  syncing = true
  tell()
  try {
    const rootId = await root()
    const rootItems = await listFolder(rootId)
    const recordsId = await dir(['records'])
    const listing = await listFolder(recordsId)
    for (const kind of RECORD_KINDS) await syncRecords(kind, recordsId, listing)
    await syncBoards(rootItems)
    await syncSetup()
    lastSync = Date.now()
    lastError = undefined
    saveState()
  } catch (e) {
    lastError = (e as Error).message
    // The app's folder (or one below it) was moved or deleted in Box: found or made again next time.
    if (e instanceof BoxHttpError && e.status === 404) { st().rootId = undefined; st().dirs = {}; saveState() }
    log('box', `sync: ${lastError}`)
  } finally {
    syncing = false
    tell()
    if (again) { again = false; void boxSyncNow() } else void uploadLinkFiles()
  }
  return boxStatus()
}

function syncSoon(): void {
  if (!boxSignedIn()) return
  if (soon) clearTimeout(soon)
  soon = setTimeout(() => { soon = null; void boxSyncNow() }, 2000)
}

/** Starts or stops syncing to match the sign-in; called at start and whenever it changes. */
export function updateBoxSync(): void {
  if (!boxSignedIn()) {
    if (timer) clearInterval(timer)
    if (soon) clearTimeout(soon)
    timer = soon = null
    for (const u of unhook) u()
    unhook = []
    return
  }
  if (!timer) {
    timer = setInterval(() => void boxSyncNow(), EVERY_MS)
    unhook = [onRecordsApplied(syncSoon), onBoardsChanged(syncSoon)]
  }
  syncSoon()
}

/** On quit: a change still waiting for its sync goes to Box now, for at most a few seconds. */
export async function flushBoxSync(): Promise<void> {
  const pending = !!soon
  if (timer) clearInterval(timer)
  if (soon) clearTimeout(soon)
  timer = soon = null
  for (const u of unhook) u()
  unhook = []
  if (pending && boxSignedIn()) await Promise.race([boxSyncNow(), new Promise((r) => setTimeout(r, 4000))])
}

export async function signOutOfBox(): Promise<BoxStatus> {
  await boxSignOut()
  state = { dirs: {}, seen: {} }
  saveState()
  lastSync = undefined
  lastError = undefined
  files = undefined
  tell()
  return boxStatus()
}

// A new sign-in starts from what is in Box: no folder ids or versions remembered from another account.
onBoxConnected(async (user) => {
  state = { user, dirs: {}, seen: {} }
  saveState()
})
onBoxSignIn(() => { updateBoxSync(); tell() })

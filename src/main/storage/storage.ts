import { execFile } from 'node:child_process'
import { access, lstat, mkdir, readdir, readFile, rename, rm, statfs, writeFile, constants } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { host, type StorageHost } from '../host'
import {
  BIG_FILE, diffSnapshots, diskPartPaths, protectedReason,
  type DiskInfo, type KindGroup, type NestNode, type ScanChanges, type DiskPart, type DuplicateGroup, type MapNode, type MapView, type RemovedEntry, type RemovedItem, type ScanRootKind, type ScanState, type ScanSummary, type TrashOutcome
} from '@shared/storage'

/**
 * The Storage tool's main-process side (channels storage:*, Mac app only): starts scans in the scan process and passes
 * the rooms' questions to it, reads the disk's capacity, and moves things to the Trash with a record of where each
 * went, so Recently Removed can put it back. Nothing is ever deleted: the Trash is emptied in Finder or not at all.
 */

const run = (cmd: string, args: string[], timeout = 20_000): Promise<string> =>
  new Promise((resolve, reject) => execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, out, errOut) => (err ? reject(Object.assign(err, { stderr: errOut })) : resolve(out))))

const dataDir = (): string => join(host().userDataDir(), 'storage')
async function readJson<T>(name: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(join(dataDir(), name), 'utf8')) as T } catch { return fallback }
}
async function writeJson(name: string, value: unknown): Promise<void> {
  await mkdir(dataDir(), { recursive: true })
  const file = join(dataDir(), name)
  await writeFile(`${file}.tmp`, JSON.stringify(value))
  await rename(`${file}.tmp`, file)
}

function scanHost(): StorageHost {
  const s = host().storage
  if (!s) throw new Error('The Storage tool is in the Mac app only.')
  return s
}

// ----- Scans -----

let state: ScanState = { status: 'idle' }
let loaded = false
let listening = false
let idleTimer: NodeJS.Timeout | null = null

const push = (): void => host().broadcast('storage:scanState', state)

/** The last scan's summary survives a restart; its tree does not (`live` says whether the scan process has it). */
async function ensureLoaded(): Promise<void> {
  if (loaded) return
  loaded = true
  const last = await readJson<ScanSummary | null>('last-scan.json', null)
  if (last && state.status === 'idle') state = { status: 'done', summary: last, live: false }
}

function listen(s: StorageHost): void {
  if (listening) return
  listening = true
  let last = 0
  s.onEvent((e) => {
    if (e.event === 'progress' && state.status === 'scanning') {
      state = { ...state, progress: e.progress as ScanState['progress'] }
      const now = Date.now()
      if (now - last > 300) { last = now; push() }
    } else if (e.event === 'duplicates') host().broadcast('storage:dupProgress', { done: e.done, total: e.total, phase: e.phase })
  })
}

/** Ends the scan process after ten minutes with nothing asked of it, which frees its memory (the tree goes too). */
function touch(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (state.status === 'scanning') return touch()
    host().storage?.stop()
    if (state.status === 'done') { state = { ...state, live: false }; push() }
  }, 10 * 60_000)
}

async function ask<T>(op: string, args?: Record<string, unknown>): Promise<T> {
  const s = scanHost()
  listen(s)
  touch()
  return s.call<T>(op, args)
}

/** Whether macOS lets the app read what it keeps behind Full Disk Access (Safari's folder is one such place). */
export async function fullDiskAccess(): Promise<boolean> {
  for (const p of [join(homedir(), 'Library/Safari'), '/Library/Application Support/com.apple.TCC']) {
    try { await readdir(p); return true } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES') return false
    }
  }
  return false
}

export async function storageState(): Promise<ScanState> {
  await ensureLoaded()
  if (state.status === 'done' && state.live && !host().storage?.running()) state = { ...state, live: false }
  return state
}

/** Starts a scan of the whole Mac, the home folder or a folder; progress and the result arrive as storage:scan. */
export async function startScan(kind: ScanRootKind, path?: string): Promise<ScanState> {
  await ensureLoaded()
  const home = homedir()
  const root = kind === 'mac' ? '/' : kind === 'home' ? home : (path ?? '').replace(/\/+$/, '')
  if (!root.startsWith('/')) throw new Error('Choose a folder to scan.')
  const fda = await fullDiskAccess()
  // Reading a cloud folder would download it, and without Full Disk Access reading another app's container asks the
  // user about "data from other apps" for each one: both are listed, their contents not counted.
  const closed: { path: string; reason: 'cloud' | 'protected' }[] = [
    { path: `${home}/Library/CloudStorage`, reason: 'cloud' },
    { path: `${home}/Library/Mobile Documents`, reason: 'cloud' }
  ]
  if (!fda) closed.push({ path: `${home}/Library/Containers`, reason: 'protected' }, { path: `${home}/Library/Group Containers`, reason: 'protected' })
  const skip = kind === 'mac'
    // Another view of the same folders (the Data volume, firmlinked into '/'), other drives, and macOS's magic folders.
    ? ['/System/Volumes', '/Volumes', '/dev', '/net', '/home', '/Network', '/private/var/vm', '/.vol', '/.nofollow', '/.resolve', '/.Spotlight-V100', '/.fseventsd']
    : []
  const devices: number[] = []
  if (kind === 'mac') { try { devices.push((await lstat('/System/Volumes/Data')).dev) } catch { /* not APFS: one volume */ } }
  state = { status: 'scanning', root, progress: { dirs: 0, files: 0, bytes: 0, path: root } }
  push()
  const started = Date.now()
  type Done = { root: string; bytes: number; files: number; dirs: number; unreadable: number; byKind: ScanSummary['byKind']; kindCounts: ScanSummary['kindCounts']; smallBytes: number; smallFiles: number }
  void ask<Done>('scan', { root, skip, closed, devices, concurrency: 16 })
    .then(async (r) => {
      const summary: ScanSummary = { root: r.root, kind, at: Date.now(), took: Date.now() - started, bytes: r.bytes, files: r.files, dirs: r.dirs, unreadable: r.unreadable, fullDiskAccess: fda, byKind: r.byKind, kindCounts: r.kindCounts, smallBytes: r.smallBytes, smallFiles: r.smallFiles }
      summary.parts = await partsOf(summary).catch(() => undefined)
      state = { status: 'done', summary, live: true }
      push()
      await writeJson('last-scan.json', summary).catch(() => undefined)
      await saveSnapshot(summary).catch(() => undefined)
    }, (e: Error) => {
      if (e.message === 'cancelled') return
      state = { status: 'error', error: e.message, ...(state.summary ? { summary: state.summary } : {}) }
      push()
    })
  return state
}

export async function cancelScan(): Promise<void> {
  if (state.status !== 'scanning') return
  await ask('cancel').catch(() => undefined)
  const last = await readJson<ScanSummary | null>('last-scan.json', null)
  state = last ? { status: 'done', summary: last, live: false } : { status: 'idle' }
  push()
}

/** Splits the disk's use into the Overview's parts, from the scan's folder sizes. */
async function partsOf(s: ScanSummary): Promise<{ id: DiskPart; bytes: number }[]> {
  const home = homedir()
  const p = diskPartPaths(home)
  const homeView = await ask<MapView>('view', { path: home, limit: 400 }).catch(() => null)
  const hiddenInHome = homeView ? homeView.children.filter((c) => c.name.startsWith('.') && c.name !== '.Trash').reduce((t, c) => t + c.size, 0) : 0
  const list = [...p.apps, ...p.downloads, ...p.pictures, ...p.library, ...p.trash, home, '/System', '/private', '/usr', '/bin', '/sbin', '/cores']
  const sizes = await ask<(number | null)[]>('sizes', { paths: list })
  const at = (path: string): number => sizes[list.indexOf(path)] ?? 0
  const sum = (paths: string[]): number => paths.reduce((t, x) => t + at(x), 0)
  const apps = sum(p.apps)
  const downloads = sum(p.downloads)
  const pictures = sum(p.pictures)
  const library = sum(p.library)
  const trash = sum(p.trash)
  const documents = Math.max(0, at(home) - sum(p.documentsExcept) - hiddenInHome)
  const disk = await diskInfo().catch(() => null)
  const used = disk ? disk.total - disk.freeNow : 0
  const scannedSystem = s.kind === 'mac' ? sum(['/System', '/private', '/usr', '/bin', '/sbin', '/cores']) : 0
  const counted = apps + documents + downloads + pictures + library + trash + scannedSystem
  const other = Math.max(0, s.bytes - counted)
  // macOS: its own folders plus whatever the disk reports as used that no folder accounts for (swap, snapshots);
  // for a scan of the home folder, everything outside it.
  const system = s.kind === 'path' ? 0 : Math.max(0, scannedSystem + Math.max(0, used - s.bytes))
  const parts: { id: DiskPart; bytes: number }[] = [
    { id: 'apps', bytes: apps }, { id: 'documents', bytes: documents }, { id: 'downloads', bytes: downloads }, { id: 'pictures', bytes: pictures },
    { id: 'library', bytes: library }, { id: 'other', bytes: other }, { id: 'trash', bytes: trash }, { id: 'system', bytes: system }
  ]
  return parts.filter((x) => x.bytes > 0)
}

// ----- Questions about the last scan -----

/** A question for the scan's tree when there is one in memory, else null (the Cleanup rooms use it when it helps). */
export async function scanQuery<T>(op: string, args: Record<string, unknown>): Promise<T | null> {
  if (state.status !== 'done' || !state.live || !host().storage?.running()) return null
  return ask<T>(op, args)
}

export const storageView = (ref: { id?: number; path?: string }): Promise<MapView> => ask('view', { ...ref, limit: 240 })
export const storageNest = (ref: { id?: number; path?: string }, dirsOnly: boolean): Promise<{ node: NestNode; chain: { id: number; name: string }[] }> => ask('nest', { ...ref, dirsOnly, per: [14, 10, 6] })
export const storageAppsNest = (): Promise<{ apps: NestNode[]; rest: { count: number; size: number }; total: number; count: number }> => ask('appsNest', { limit: 24, per: [6, 4] })
export const storageKinds = (): Promise<KindGroup[]> => ask('kinds', { perKind: 8 })
/** The Overview's largest folders: never the containers everything is in. */
export const topFolders = (): Promise<MapNode[]> => { const home = homedir(); return ask('topFolders', { limit: 5, exclude: ['/', '/Users', home, `${home}/Library`, '/Library', '/private', '/private/var'] }) }
export const reportLists = async (): Promise<{ folders: MapNode[]; files: MapNode[]; recent: MapNode[] }> => ({
  folders: await ask('largestFolders', { limit: 200 }),
  files: await ask('largest', { min: BIG_FILE, limit: 200, exclude: [] }),
  recent: await ask('recentLarge', { min: 100e6, limit: 8 })
})

// ----- Snapshots: what grew or shrank between scans of the same place -----

const snapDir = (root: string): string => join(dataDir(), 'snapshots', Buffer.from(root).toString('base64url'))

async function saveSnapshot(s: ScanSummary): Promise<void> {
  const rows = await ask<[string, number][]>('snapshot', { min: 50e6 })
  const dir = snapDir(s.root)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${s.at}.json`), JSON.stringify({ at: s.at, bytes: s.bytes, rows }))
  // Thirty scans of a place are kept; older ones go.
  const all = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()
  for (const f of all.slice(0, Math.max(0, all.length - 30))) await rm(join(dir, f), { force: true })
}

/** The scans of the last scanned place, and what changed by 50 MB or more between `base` (or the one before) and the last. */
export async function scanChanges(base?: number): Promise<ScanChanges> {
  const root = state.summary?.root
  if (!root) return { scans: [], changes: [] }
  const dir = snapDir(root)
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.json')).sort()
  const load = async (f: string): Promise<{ at: number; bytes: number; rows: [string, number][] }> => JSON.parse(await readFile(join(dir, f), 'utf8'))
  const scans = await Promise.all(files.map(async (f) => { const x = await load(f); return { at: x.at, bytes: x.bytes } }))
  if (files.length < 2) return { scans, changes: [] }
  const last = await load(files[files.length - 1])
  const baseFile = base ? files.find((f) => f === `${base}.json`) : files[files.length - 2]
  if (!baseFile) return { scans, changes: [] }
  const before = await load(baseFile)
  return { scans, base: before.at, changes: diffSnapshots(before.rows, last.rows, 50e6) }
}

/** Where Large Files does not look unless asked: inside libraries and macOS's own folders. */
const systemAreas = (): string[] => [join(homedir(), 'Library'), '/Library', '/System', '/private', '/usr', '/bin', '/sbin', '/opt', '/cores']

export const largeFiles = (min: number, everywhere: boolean): Promise<MapNode[]> => ask('largest', { min: Math.max(BIG_FILE, min), limit: 400, exclude: everywhere ? [] : systemAreas() })
export const searchScan = (query: string, min: number, sort: 'size' | 'name' | 'date'): Promise<MapNode[]> => ask('search', { query, min, sort, limit: 400 })
export const hiddenItems = (): Promise<MapNode[]> => ask('hidden', { min: BIG_FILE, limit: 300 })
export const findDuplicates = (): Promise<DuplicateGroup[]> =>
  // Apps and libraries keep their own copies on purpose, as macOS's folders do.
  ask('duplicates', { exclude: [...systemAreas(), '/Applications', join(homedir(), 'Applications')] })
export const cancelDuplicates = (): Promise<void> => ask('cancel')

// ----- The disk -----

const DISK_JXA = `
ObjC.import('Foundation')
function run() {
  const keys = ['NSURLVolumeAvailableCapacityForImportantUsageKey', 'NSURLVolumeTotalCapacityKey', 'NSURLVolumeLocalizedNameKey']
  const v = $.NSURL.fileURLWithPath('/').resourceValuesForKeysError($(keys), null)
  const o = {}
  for (const k of keys) { const x = v.objectForKey(k); o[k] = x && !x.isNil() ? ObjC.unwrap(x) : null }
  return JSON.stringify(o)
}`

let diskCache: { at: number; value: Omit<DiskInfo, 'history'> } | null = null

export async function diskInfo(): Promise<DiskInfo> {
  if (!diskCache || Date.now() - diskCache.at > 20_000) {
    const st = await statfs('/')
    const total = st.blocks * st.bsize
    const freeNow = st.bavail * st.bsize
    let free = freeNow
    let name = 'Macintosh HD'
    let volumeTotal = total
    try {
      const v = JSON.parse((await run('osascript', ['-l', 'JavaScript', '-e', DISK_JXA], 8000)).trim()) as Record<string, number | string | null>
      if (typeof v.NSURLVolumeAvailableCapacityForImportantUsageKey === 'number') free = v.NSURLVolumeAvailableCapacityForImportantUsageKey
      if (typeof v.NSURLVolumeTotalCapacityKey === 'number') volumeTotal = v.NSURLVolumeTotalCapacityKey
      if (typeof v.NSURLVolumeLocalizedNameKey === 'string') name = v.NSURLVolumeLocalizedNameKey
    } catch { /* statfs alone: purgeable space not counted as free */ }
    diskCache = { at: Date.now(), value: { name, total: volumeTotal, free, freeNow } }
  }
  const history = await noteDiskUse(diskCache.value)
  return { ...diskCache.value, history }
}

const today = (): string => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

/** One reading of the disk's use a day, kept 120 days, for the Overview's trend. */
export async function noteDiskUse(disk?: Omit<DiskInfo, 'history'>): Promise<DiskInfo['history']> {
  const history = await readJson<DiskInfo['history']>('disk-history.json', [])
  const day = today()
  if (history.at(-1)?.day === day) return history
  let d = disk
  if (!d) { const st = await statfs('/'); d = { name: '', total: st.blocks * st.bsize, free: st.bavail * st.bsize, freeNow: st.bavail * st.bsize } }
  const next = [...history, { day, used: d.total - d.free, total: d.total }].slice(-120)
  await writeJson('disk-history.json', next).catch(() => undefined)
  return next
}

// ----- The Trash, with Put Back -----

// NSFileManager hands back where each item went in the Trash, which Put Back needs. AppleScriptObjC, because
// JavaScript for Automation crashes reading that out-parameter. One line per item: OK|ERR, tab, path, tab, detail.
const TRASH_SCRIPT = [
  'use AppleScript version "2.4"',
  'use framework "Foundation"',
  'use scripting additions',
  'on run argv',
  'set fm to current application\'s NSFileManager\'s defaultManager()',
  'set out to {}',
  'repeat with p in argv',
  'set u to current application\'s NSURL\'s fileURLWithPath:(p as text)',
  'set {ok, newURL, err} to fm\'s trashItemAtURL:u resultingItemURL:(reference) |error|:(reference)',
  'if ok then',
  'set end of out to "OK" & tab & (p as text) & tab & ((newURL\'s |path|()) as text)',
  'else',
  'set end of out to "ERR" & tab & (p as text) & tab & ((err\'s localizedDescription()) as text)',
  'end if',
  'end repeat',
  'set AppleScript\'s text item delimiters to linefeed',
  'return out as text',
  'end run'
]

const ADMIN = 'Only an administrator can move this: it belongs to the system or another account. Show it in Finder and press Command-Delete there; Finder asks for the password.'

/**
 * Moves items to the Trash (never deletes), each checked first: macOS's own and other protected places stay, and what
 * only an administrator can move is handed back for Finder. Every move is recorded for Recently Removed.
 */
export async function moveToTrash(items: { path: string; size?: number; dir?: boolean }[], from: string): Promise<TrashOutcome> {
  const home = homedir()
  const out: TrashOutcome = { moved: [], failed: [], bytes: 0 }
  const go: { path: string; size: number; dir: boolean }[] = []
  for (const it of items) {
    const reason = protectedReason(it.path, home)
    if (reason) { out.failed.push({ path: it.path, reason }); continue }
    let st
    try { st = await lstat(it.path) } catch { out.failed.push({ path: it.path, reason: 'No longer on disk. It may already have been removed.' }); continue }
    try { await access(dirname(it.path), constants.W_OK) } catch { out.failed.push({ path: it.path, reason: ADMIN, admin: true }); continue }
    go.push({ path: it.path, size: it.size ?? (st.isDirectory() ? 0 : st.blocks * 512), dir: it.dir ?? st.isDirectory() })
  }
  // A launch agent of this account is unloaded first, so it stops now rather than running until the next login.
  const agents = join(home, 'Library/LaunchAgents/')
  for (const g of go) if (g.path.startsWith(agents) && g.path.endsWith('.plist')) await run('launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}`, g.path], 10_000).catch(() => undefined)
  for (let k = 0; k < go.length; k += 100) {
    const batch = go.slice(k, k + 100)
    let lines: string[] = []
    try {
      lines = (await run('osascript', [...TRASH_SCRIPT.flatMap((l) => ['-e', l]), ...batch.map((b) => b.path)], 120_000)).split('\n').filter(Boolean)
    } catch (e) {
      for (const b of batch) out.failed.push({ path: b.path, reason: (e as Error).message })
      continue
    }
    for (const line of lines) {
      const [status, path, detail] = line.split('\t')
      const b = batch.find((x) => x.path === path)
      if (!b) continue
      if (status === 'OK' && detail) {
        out.moved.push({ id: `${Date.now().toString(36)}-${out.moved.length}`, path, trashPath: detail, size: b.size })
        out.bytes += b.size
      } else {
        const admin = /permission|privilege|not allowed|owner/i.test(detail ?? '')
        out.failed.push({ path, reason: admin ? ADMIN : detail || 'Could not be moved to the Trash.', ...(admin ? { admin: true } : {}) })
      }
    }
  }
  if (out.moved.length) {
    const now = Date.now()
    const list = await readJson<RemovedItem[]>('removed.json', [])
    const added: RemovedItem[] = out.moved.map((m) => ({ id: m.id, path: m.path, trashPath: m.trashPath, size: m.size, at: now, from, dir: go.find((g) => g.path === m.path)?.dir ?? false }))
    const cutoff = now - 90 * 86_400_000
    await writeJson('removed.json', [...added, ...list].filter((x) => x.at >= cutoff).slice(0, 5000))
    // The scan forgets them, so its lists and totals match the disk.
    if (host().storage?.running()) await ask('remove', { paths: out.moved.map((m) => m.path) }).catch(() => undefined)
    diskCache = null
    host().broadcast('storage:trashed', { count: out.moved.length, bytes: out.bytes })
  }
  return out
}

const exists = async (p: string): Promise<boolean | null> => {
  try { await lstat(p); return true } catch (e) { const c = (e as NodeJS.ErrnoException).code; return c === 'ENOENT' || c === 'ENOTDIR' ? false : null }
}

/** What the Storage tool moved to the Trash in the last 90 days, and whether each can go back now. */
export async function removedItems(): Promise<RemovedEntry[]> {
  const list = await readJson<RemovedItem[]>('removed.json', [])
  return Promise.all(list.map(async (r): Promise<RemovedEntry> => {
    const inTrash = await exists(r.trashPath)
    // Without Full Disk Access the Trash cannot be looked into: assume it is still there and let Put Back try.
    if (inTrash === false) return { ...r, state: 'gone' }
    if (await exists(r.path)) return { ...r, state: 'occupied' }
    if ((await exists(dirname(r.path))) === false) return { ...r, state: 'no-folder' }
    return { ...r, state: 'in-trash' }
  }))
}

/** Moves items back from the Trash to where they were. Never replaces anything at the old place. */
export async function putBack(ids: string[]): Promise<{ restored: string[]; failed: { id: string; reason: string }[] }> {
  const list = await readJson<RemovedItem[]>('removed.json', [])
  const restored: string[] = []
  const failed: { id: string; reason: string }[] = []
  for (const id of ids) {
    const r = list.find((x) => x.id === id)
    if (!r) { failed.push({ id, reason: 'It is no longer in the list.' }); continue }
    if (await exists(r.path)) { failed.push({ id, reason: `Something else is at ${basename(r.path)}'s old place now. Put Back never replaces anything, so it stays in the Trash.` }); continue }
    if ((await exists(dirname(r.path))) === false) { failed.push({ id, reason: 'The folder it came from no longer exists. Drag it out of the Trash to a place of your choosing.' }); continue }
    try {
      await rename(r.trashPath, r.path)
      restored.push(id)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      failed.push({ id, reason: code === 'ENOENT' ? 'No longer in the Trash. It may have been emptied.' : code === 'EPERM' || code === 'EACCES' ? 'macOS did not let the app reach the Trash. Give it Full Disk Access, or use Put Back in Finder.' : (e as Error).message })
    }
  }
  if (restored.length) await writeJson('removed.json', list.filter((x) => !restored.includes(x.id)))
  diskCache = null
  return { restored, failed }
}

export async function forgetRemoved(ids: string[]): Promise<void> {
  const list = await readJson<RemovedItem[]>('removed.json', [])
  await writeJson('removed.json', list.filter((x) => !ids.includes(x.id)))
}

/** Bytes waiting in the Trash (null without Full Disk Access, which looking into the Trash needs). */
export function trashSize(): Promise<number | null> {
  return new Promise((resolve) => execFile('du', ['-sk', join(homedir(), '.Trash')], { timeout: 30_000 }, (err, out) => {
    const kb = parseInt(out, 10)
    resolve(err && /Operation not permitted/.test(String((err as { stderr?: string }).stderr ?? err.message)) ? null : Number.isFinite(kb) ? kb * 1024 : null)
  }))
}

/** Opens the Trash in Finder, where Empty is. */
export async function openTrash(): Promise<void> {
  await run('open', [join(homedir(), '.Trash')])
}

export async function pickScanFolder(): Promise<string | null> {
  const paths = await host().pickPaths({ title: 'Choose a folder or drive to scan', kind: 'directory', buttonLabel: 'Scan' })
  return paths?.[0] ?? null
}

export function closeStorage(): void {
  if (idleTimer) clearTimeout(idleTimer)
  host().storage?.stop()
}

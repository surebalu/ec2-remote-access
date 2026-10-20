import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { RecentFile } from '@shared/finder'
import { nameQuery, recordUse, wantedFile, type LauncherApp, type LauncherPreview, type LauncherUsage } from '@shared/launcher'
import { host } from './host'

/**
 * The launcher's list of the apps on this Mac, and what it opened (launcher.json in the app's data folder, for
 * ranking). Plain file reads, no Electron, so handlers.ts can serve them (the gateway refuses launcher:* anyway).
 */

/** Where macOS keeps apps; folders inside them (Setapp, Microsoft Office, Adobe…) are looked into one level deep. */
const ROOTS = ['/Applications', '/Applications/Utilities', '/System/Applications', '/System/Applications/Utilities', '~/Applications', '/System/Library/CoreServices/Applications']
const ALSO = ['/System/Library/CoreServices/Finder.app']

let cache: { at: number; apps: LauncherApp[] } | null = null

const isDir = (p: string): boolean => { try { return statSync(p).isDirectory() } catch { return false } }

/** The installed apps by name, the first of a name kept (so /Applications wins over a copy elsewhere). Cached 30 s. */
export function listApps(): LauncherApp[] {
  if (process.platform !== 'darwin') return []
  if (cache && Date.now() - cache.at < 30_000) return cache.apps
  const seen = new Set<string>()
  const apps: LauncherApp[] = []
  const add = (path: string): void => {
    const name = basename(path, '.app')
    if (seen.has(name.toLowerCase())) return
    seen.add(name.toLowerCase())
    apps.push({ name, path })
  }
  const scan = (dir: string, depth: number): void => {
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }
    for (const e of entries.sort()) {
      if (e.startsWith('.')) continue
      const p = join(dir, e)
      if (e.endsWith('.app')) add(p)
      else if (depth > 0 && isDir(p)) scan(p, depth - 1)
    }
  }
  for (const root of ROOTS) scan(root.replace(/^~/, homedir()), 1)
  for (const p of ALSO) if (existsSync(p)) add(p)
  cache = { at: Date.now(), apps }
  return apps
}

const usageFile = (): string => join(host().userDataDir(), 'launcher.json')
let usage: LauncherUsage | null = null

export function launcherUsage(): LauncherUsage {
  if (!usage) {
    try { usage = (JSON.parse(readFileSync(usageFile(), 'utf8')) as { usage?: LauncherUsage }).usage ?? {} } catch { usage = {} }
  }
  return usage
}

/** Counts a use of a launcher result ('app:/Applications/Safari.app', 'host:<key>'…). */
export function noteUse(id: string): void {
  if (typeof id !== 'string' || !id || id.length > 2048) return
  usage = recordUse(launcherUsage(), id, Date.now())
  const tmp = `${usageFile()}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify({ usage }))
    renameSync(tmp, usageFile())
  } catch (e) {
    console.warn('[launcher] could not save what was opened:', (e as Error).message)
  }
}

const run = (cmd: string, args: string[], timeout = 4000): Promise<string> =>
  new Promise((resolve, reject) => execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(out))))

/** The searches of the latest query; a new query stops them (typing fast would otherwise pile up mdfind runs). */
let searches: ChildProcess[] = []

/**
 * Spotlight's hits for `query` on every indexed disk, as they stream in, keeping those `keep` accepts; it stops at
 * `max` of them or after `ms` (a common word matches over 100,000 files, which mdfind would take seconds to list).
 */
function spotlight(query: string, keep: (p: string) => boolean, max: number, ms: number): Promise<string[]> {
  return new Promise((resolve) => {
    const out: string[] = []
    const decoder = new StringDecoder('utf8')
    let rest = ''
    let done = false
    const child = spawn('mdfind', ['-0', query], { stdio: ['ignore', 'pipe', 'ignore'] })
    searches.push(child)
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.kill()
      searches = searches.filter((c) => c !== child)
      resolve(out)
    }
    const timer = setTimeout(finish, ms)
    child.stdout.on('data', (chunk: Buffer) => {
      const parts = (rest + decoder.write(chunk)).split('\0')
      rest = parts.pop() ?? ''
      for (const p of parts) {
        if (p && keep(p) && out.push(p) >= max) return finish()
      }
    })
    child.on('close', finish)
    child.on('error', finish)
  })
}

/** When each file was last opened (Spotlight's kMDItemLastUsedDate), 0 for never. */
async function lastOpened(paths: string[]): Promise<number[]> {
  if (!paths.length) return []
  try {
    const raw = (await run('mdls', ['-name', 'kMDItemLastUsedDate', '-raw', ...paths])).split('\0')
    return paths.map((_, i) => {
      const t = Date.parse((raw[i] ?? '').replace(' +0000', 'Z').replace(' ', 'T'))
      return Number.isFinite(t) ? t : 0
    })
  } catch {
    return paths.map(() => 0)
  }
}

/**
 * Files and folders on this Mac whose names hold every typed word, from Spotlight's index (no index of our own: it is
 * macOS's, always up to date). The ones opened in the last year come first, newest first, then the rest.
 */
export async function launcherFiles(query: string, limit = 60): Promise<RecentFile[]> {
  const name = nameQuery(String(query ?? ''))
  if (process.platform !== 'darwin' || !name || String(query).trim().length < 2) return []
  const home = homedir()
  const keep = (p: string): boolean => wantedFile(p, home)
  for (const c of searches) c.kill()
  searches = []
  const [recent, any] = await Promise.all([
    spotlight(`(${name}) && kMDItemLastUsedDate >= $time.today(-365)`, keep, 150, 1500),
    spotlight(name, keep, 250, 1500)
  ])
  const paths = [...new Set([...recent, ...any])].slice(0, 200)
  const used = await lastOpened(paths)
  const out: RecentFile[] = []
  paths.forEach((p, i) => {
    try {
      const st = statSync(p)
      out.push({ name: basename(p), path: p, type: st.isDirectory() ? 'dir' : 'file', size: st.size, mtime: st.mtimeMs, mode: st.mode, lastUsed: used[i] })
    } catch { /* gone since Spotlight saw it */ }
  })
  return out.sort((a, b) => b.lastUsed - a.lastUsed || b.mtime - a.mtime).slice(0, limit)
}

/** What the launcher's side pane shows about a file, folder or app, all but the thumbnail (launcherWindow.ts makes that). */
export async function fileDetails(path: string): Promise<Omit<LauncherPreview, 'thumbnail'>> {
  const st = statSync(path)
  let kind = st.isDirectory() ? (path.endsWith('.app') ? 'Application' : 'Folder') : 'Document'
  let opened: number | null = null
  if (process.platform === 'darwin') {
    try {
      const out = await run('mdls', ['-name', 'kMDItemKind', '-name', 'kMDItemLastUsedDate', path], 3000)
      const k = /kMDItemKind\s*=\s*"(.*)"/.exec(out)?.[1]
      if (k) kind = k
      const u = /kMDItemLastUsedDate\s*=\s*(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) \+0000/.exec(out)?.[1]
      if (u) opened = Date.parse(`${u.replace(' ', 'T')}Z`)
    } catch { /* Spotlight has nothing on it */ }
  }
  return { path, isDir: st.isDirectory(), kind, size: st.size, created: st.birthtimeMs, modified: st.mtimeMs, lastOpened: opened }
}

import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { recordUse, type LauncherApp, type LauncherUsage } from '@shared/launcher'
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

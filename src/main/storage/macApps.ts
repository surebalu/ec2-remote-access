import { execFile } from 'node:child_process'
import { access, constants, lstat, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { CleanGroup, CleanItem, CleanReport } from '@shared/cleanup'
import {
  belongsTo, parseSystemExtensions, entryKey, isIntelOnly, launchProgram, LIBRARY_PLACES, leftoverOf, mdlsDate, mdlsList, nameFromId, splitMdls, startupOwner, SYSTEM_PLACES,
  type Confidence, type LaunchScope, type MacApp
} from '@shared/macApps'
import { runningApps } from './cleanup'

/**
 * The Apps rooms (Unused Apps, Uninstaller, Leftovers, Startup Items), Mac app only: the installed apps with when
 * Spotlight last saw each opened, what an app keeps in the Library, what removed apps left behind, and everything
 * that starts itself. Nothing here moves anything; what the user ticks goes to storage:trash.
 */

const home = homedir()

function out(cmd: string, args: string[], timeout = 60_000): Promise<string> {
  return new Promise((resolve) => execFile(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (_err, stdout) => resolve(stdout ?? '')))
}

async function sizes(paths: string[]): Promise<Map<string, number>> {
  const m = new Map<string, number>()
  for (let k = 0; k < paths.length; k += 150) {
    for (const line of (await out('du', ['-sk', '--', ...paths.slice(k, k + 150)], 300_000)).split('\n')) {
      const tab = line.indexOf('\t')
      if (tab > 0) m.set(line.slice(tab + 1), parseInt(line.slice(0, tab), 10) * 1024)
    }
  }
  return m
}

async function list(dir: string): Promise<{ name: string; path: string; dir: boolean }[]> {
  try { return (await readdir(dir, { withFileTypes: true })).filter((d) => !d.name.startsWith('.')).map((d) => ({ name: d.name, path: join(dir, d.name), dir: d.isDirectory() })) } catch { return [] }
}
const exists = async (p: string): Promise<boolean> => { try { await lstat(p); return true } catch { return false } }

/** The .app bundles in the Applications folders, and one folder down (Utilities, Setapp, vendors' folders). */
async function appPaths(): Promise<string[]> {
  const found: string[] = []
  for (const root of ['/Applications', join(home, 'Applications')]) {
    for (const e of await list(root)) {
      if (e.name.endsWith('.app')) found.push(e.path)
      else if (e.dir) for (const f of await list(e.path)) if (f.name.endsWith('.app')) found.push(f.path)
    }
  }
  return found
}

let appCache: { at: number; sized: boolean; apps: MacApp[] } | null = null

/** The installed apps (cached two minutes); with `withSizes`, each measured on disk. */
export async function installedApps(withSizes: boolean): Promise<MacApp[]> {
  if (appCache && Date.now() - appCache.at < 120_000 && (appCache.sized || !withSizes)) return appCache.apps
  const paths = await appPaths()
  const names = ['kMDItemCFBundleIdentifier', 'kMDItemVersion', 'kMDItemLastUsedDate', 'kMDItemExecutableArchitectures']
  const meta: string[][] = []
  for (let k = 0; k < paths.length; k += 150) {
    const batch = paths.slice(k, k + 150)
    meta.push(...splitMdls(await out('mdls', [...names.flatMap((n) => ['-name', n]), '-raw', '-nullMarker', '', ...batch], 60_000), names.length, batch.length))
  }
  const running = await runningApps()
  const sz = withSizes ? await sizes(paths) : new Map<string, number>()
  const uid = process.getuid?.() ?? 501
  const apps = await Promise.all(paths.map(async (path, i): Promise<MacApp> => {
    const [id = '', version = '', last = '', archs = ''] = meta[i] ?? []
    let owner = uid
    try { owner = (await lstat(path)).uid } catch { /* gone */ }
    const writable = await access(path.replace(/\/[^/]+$/, ''), constants.W_OK).then(() => true, () => false)
    return {
      path, name: basename(path, '.app'), id, version, size: sz.get(path) ?? 0, lastUsed: mdlsDate(last), intelOnly: isIntelOnly(mdlsList(archs)),
      running: running.some((r) => r.path === path || (!!id && r.id === id)),
      systemExtension: await exists(join(path, 'Contents/Library/SystemExtensions')),
      admin: owner === 0 || !writable,
      apple: id.startsWith('com.apple.')
    }
  }))
  appCache = { at: Date.now(), sized: withSizes, apps }
  return apps
}

/** What an app keeps in the Library, with how sure the app is of each and whether it is safe to clear. */
export async function appFiles(appPath: string): Promise<CleanItem[]> {
  const app = (await installedApps(false)).find((a) => a.path === appPath)
  if (!app) throw new Error('That app is no longer installed.')
  const found: { path: string; dir: boolean; conf: Confidence; note: string; tick: boolean; admin: boolean }[] = []
  for (const place of LIBRARY_PLACES) {
    for (const e of await list(join(home, 'Library', place.dir))) {
      const conf = belongsTo(e.name, app)
      if (conf) found.push({ path: e.path, dir: e.dir, conf, note: place.note, tick: place.tick && conf === 'sure', admin: false })
    }
  }
  for (const dir of SYSTEM_PLACES) {
    for (const e of await list(dir)) {
      const conf = belongsTo(e.name, app)
      if (conf) found.push({ path: e.path, dir: e.dir, conf, note: 'Installed for every account, in a folder only an administrator can change.', tick: false, admin: true })
    }
  }
  const sz = await sizes(found.map((f) => f.path))
  const why: Record<Confidence, string> = { sure: 'Named for the app\'s bundle identifier.', likely: 'Named like the app.', maybe: 'Uses the same vendor prefix; check it yourself.' }
  return found.map((f) => ({
    path: f.path, name: basename(f.path), size: sz.get(f.path) ?? 0, dir: f.dir, safe: f.tick && !f.admin, note: `${why[f.conf]} ${f.note}`,
    ...(f.admin ? { blocked: 'Only an administrator can move this: show it in Finder and press Command-Delete there.', action: { label: 'Show in Finder', reveal: f.path } } : {})
  })).sort((a, b) => Number(b.safe) - Number(a.safe) || b.size - a.size)
}

/** The names (lower-cased, no extension) of the frameworks, helpers and plug-ins inside the installed apps. */
async function embeddedNames(): Promise<Set<string>> {
  const names = new Set<string>()
  const inside = ['Contents/Frameworks', 'Contents/PlugIns', 'Contents/Helpers', 'Contents/XPCServices', 'Contents/Library/LoginItems', 'Contents/Library/LaunchServices', 'Contents/Library/SystemExtensions']
  await Promise.all((await appPaths()).map(async (app) => {
    for (const d of inside) for (const e of await list(join(app, d))) names.add(e.name.replace(/\.[^.]+$/, '').toLowerCase())
  }))
  return names
}

/** Every bundle id this Mac can account for: apps anywhere Spotlight looks, package receipts, running processes. */
async function knownIds(): Promise<string[]> {
  const bundles = (await out('mdfind', ['-0', "kMDItemContentType == 'com.apple.application-bundle' || kMDItemContentType == 'com.apple.systemextension' || kMDItemContentType == 'com.apple.application-extension'"], 60_000)).split('\0').filter(Boolean)
  const ids: string[] = []
  for (let k = 0; k < bundles.length; k += 250) {
    const batch = bundles.slice(k, k + 250)
    ids.push(...(await out('mdls', ['-name', 'kMDItemCFBundleIdentifier', '-raw', '-nullMarker', '', ...batch], 60_000)).split('\0').map((s) => s.trim()))
  }
  const receipts = (await out('pkgutil', ['--pkgs'], 20_000)).split('\n').map((s) => s.trim())
  const running = (await runningApps()).map((r) => r.id)
  return [...new Set([...ids, ...receipts, ...running, ...(await installedApps(false)).map((a) => a.id)].filter(Boolean))]
}

/** Files in the Library that belong to apps no longer on this Mac, grouped by the app they name. */
export async function leftoversReport(): Promise<CleanReport> {
  const [installed, embedded] = await Promise.all([knownIds(), embeddedNames()])
  const groups = new Map<string, { verdict: Confidence; items: { path: string; dir: boolean; note: string; tick: boolean }[] }>()
  for (const place of LIBRARY_PLACES) {
    for (const e of await list(join(home, 'Library', place.dir))) {
      const v = leftoverOf(e.name, installed, embedded)
      if (!v || v === 'owned') continue
      const g = groups.get(v.id) ?? { verdict: v.verdict, items: [] }
      g.items.push({ path: e.path, dir: e.dir, note: place.note, tick: place.tick && v.verdict === 'sure' })
      groups.set(v.id, g)
    }
  }
  const all = [...groups.values()].flatMap((g) => g.items.map((i) => i.path))
  const sz = await sizes(all)
  const out2: CleanGroup[] = [...groups.entries()].map(([id, g]) => ({
    id,
    title: nameFromId(id),
    text: g.verdict === 'sure' ? `${id}: no app with this identifier is installed, and nothing else from its vendor is.` : `${id}: no app with this identifier is installed, but other apps from its vendor are, and may use it. Not ticked for you.`,
    items: g.items.map((i) => ({ path: i.path, name: basename(i.path), size: sz.get(i.path) ?? 0, dir: i.dir, safe: i.tick, note: i.note }))
  })).sort((a, b) => b.items.reduce((s, i) => s + i.size, 0) - a.items.reduce((s, i) => s + i.size, 0))
  return { groups: out2, at: Date.now(), notes: ['Only names that are bundle identifiers (com.vendor.app) are judged; folders named in plain words are never guessed at.'] }
}

/** Everything that starts itself: launch agents and daemons, helper tools and system extensions, and who owns them. */
export async function startupReport(): Promise<CleanReport> {
  const apps = (await installedApps(false)).map((a) => ({ id: a.id, name: a.name }))
  const loaded = new Set((await out('launchctl', ['list'], 10_000)).split('\n').map((l) => l.trim().split(/\s+/)[2]).filter(Boolean))
  const read = async (path: string): Promise<Record<string, unknown> | null> => {
    try { return JSON.parse(await out('plutil', ['-convert', 'json', '-o', '-', path], 5000)) as Record<string, unknown> } catch { return null }
  }
  const scopes: { dir: string; scope: LaunchScope; title: string; text: string }[] = [
    { dir: join(home, 'Library/LaunchAgents'), scope: 'user-agent', title: 'Launch agents, your account', text: 'Started when you log in. A removed agent stops at your next login.' },
    { dir: '/Library/LaunchAgents', scope: 'agent', title: 'Launch agents, every account', text: 'Started when anyone logs in. Only an administrator can remove them; Finder asks for the password.' },
    { dir: '/Library/LaunchDaemons', scope: 'daemon', title: 'Launch daemons', text: 'Started with the Mac, before anyone logs in. A removed daemon stops at the next restart.' }
  ]
  const groups: CleanGroup[] = []
  for (const s of scopes) {
    const items: CleanItem[] = []
    for (const e of await list(s.dir)) {
      if (!e.name.endsWith('.plist')) continue
      const plist = await read(e.path)
      const label = typeof plist?.Label === 'string' ? plist.Label : entryKey(e.name)
      if (label.startsWith('com.apple.')) continue
      const program = plist ? launchProgram(plist) : ''
      const missing = !!program && program.startsWith('/') && !(await exists(program))
      const owner = startupOwner(label, program, apps)
      const what = !plist ? 'Its file could not be read, so what it runs is unknown.' : !program ? 'It names no program, so launchd has nothing to start.' : missing ? `Its program, ${program}, is no longer there, so launchd has nothing to start.` : `Runs ${program}.`
      const user = s.scope === 'user-agent'
      items.push({
        path: e.path, name: label, size: 0, dir: false,
        safe: user && missing,
        note: `${owner ? `From ${owner}.` : 'No installed app matches its name, what it runs, or the apps it names.'} ${what}${user && loaded.has(label) ? ' Running now.' : ''}`,
        ...(user ? {} : { blocked: 'Only an administrator can move this: show it in Finder and press Command-Delete there.', action: { label: 'Show in Finder', reveal: e.path } })
      })
    }
    if (items.length) groups.push({ id: s.scope, title: s.title, text: s.text, items: items.sort((a, b) => Number(b.safe) - Number(a.safe) || a.name.localeCompare(b.name)) })
  }
  const helpers = await list('/Library/PrivilegedHelperTools')
  if (helpers.length) groups.push({
    id: 'helper', title: 'Helper tools', text: 'Programs apps install to do what needs an administrator, started by a launch daemon.',
    items: helpers.map((h) => ({ path: h.path, name: h.name, size: 0, dir: false, safe: false, note: (() => { const o = startupOwner(h.name, '', apps); return o ? `From ${o}.` : 'No installed app matches its name.' })(), blocked: 'Only an administrator can move this.', action: { label: 'Show in Finder', reveal: h.path } }))
  })
  const ext = await out('systemextensionsctl', ['list'], 10_000)
  const exts = parseSystemExtensions(ext)
  if (exts.length) groups.push({
    id: 'sysext', title: 'System extensions', text: 'Network filters, endpoint security and drivers apps add to macOS. Only macOS removes them, when their app goes to the Trash in Finder.',
    items: exts.map((x) => ({ path: `sysext:${x.id}`, name: x.name || x.id, size: 0, dir: false, safe: false, note: `${x.id} · ${x.state}.`, blocked: 'Only macOS removes a system extension.', action: { label: 'Login Items & Extensions', url: 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension' } }))
  })
  return { groups, at: Date.now(), notes: ['Apps that open at login, and the switches for apps allowed to run in the background, are kept where only macOS can read them: see Login Items & Extensions in System Settings.'] }
}

// NSRunningApplication's terminate asks an app to quit as Command-Q does: anything unsaved asks first.
const QUIT_JXA = `
ObjC.import('AppKit')
function run(argv) {
  const out = []
  for (const pid of argv) {
    const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(pid))
    out.push(app && !app.isNil() && app.terminate ? 'ok' : 'no')
  }
  return out.join(',')
}`

/** Asks apps to quit (by process id). Returns how many accepted. */
export async function quitApps(pids: number[]): Promise<number> {
  if (!pids.length) return 0
  const res = await out('osascript', ['-l', 'JavaScript', '-e', QUIT_JXA, ...pids.map(String)], 20_000)
  appCache = null
  return res.split(',').filter((x) => x.trim() === 'ok').length
}

export function forgetApps(): void { appCache = null }

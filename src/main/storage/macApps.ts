import { execFile } from 'node:child_process'
import { access, constants, lstat, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { CleanGroup, CleanItem, CleanReport } from '@shared/cleanup'
import {
  belongsTo, parseSystemExtensions, entryKey, isIntelOnly, launchProgram, LIBRARY_PLACES, leftoverOf, mdlsDate, mdlsList, nameFromId, splitMdls, startupOwner, SYSTEM_PLACES,
  type Confidence, type LaunchScope, type MacApp, type StartupItem
} from '@shared/macApps'
import { runningApps } from './running'

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
  const names = ['kMDItemCFBundleIdentifier', 'kMDItemVersion', 'kMDItemLastUsedDate', 'kMDItemExecutableArchitectures', 'kMDItemDateAdded']
  const meta: string[][] = []
  for (let k = 0; k < paths.length; k += 150) {
    const batch = paths.slice(k, k + 150)
    meta.push(...splitMdls(await out('mdls', [...names.flatMap((n) => ['-name', n]), '-raw', '-nullMarker', '', ...batch], 60_000), names.length, batch.length))
  }
  const running = await runningApps()
  const sz = withSizes ? await sizes(paths) : new Map<string, number>()
  const uid = process.getuid?.() ?? 501
  const apps = await Promise.all(paths.map(async (path, i): Promise<MacApp> => {
    const [id = '', version = '', last = '', archs = '', added = ''] = meta[i] ?? []
    let owner = uid
    try { owner = (await lstat(path)).uid } catch { /* gone */ }
    const writable = await access(path.replace(/\/[^/]+$/, ''), constants.W_OK).then(() => true, () => false)
    return {
      path, name: basename(path, '.app'), id, version, size: sz.get(path) ?? 0, lastUsed: mdlsDate(last), added: mdlsDate(added), intelOnly: isIntelOnly(mdlsList(archs)),
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

/** What kind of Library place each folder is, as the Leftovers room names it. */
const PLACE_LABELS: Record<string, string> = {
  Caches: 'Cache', Logs: 'Logs', Preferences: 'Preferences', 'Preferences/ByHost': 'Preferences (this Mac)', 'Saved Application State': 'Saved State', HTTPStorages: 'HTTP Storage', Cookies: 'Cookies',
  LaunchAgents: 'Launch Agent', 'Application Support': 'Application Support', Containers: 'Container', 'Group Containers': 'Group Container', WebKit: 'WebKit Data', 'Application Scripts': 'App Scripts',
  '/Library/Application Support': 'Application Support (all accounts)', '/Library/Caches': 'Cache (all accounts)', '/Library/Preferences': 'Preferences (all accounts)', '/Library/LaunchAgents': 'Launch Agent (all accounts)',
  '/Library/LaunchDaemons': 'Launch Daemon', '/Library/PrivilegedHelperTools': 'Helper Tool', '/Library/Logs': 'Logs (all accounts)'
}

/** com.betafish.adblock-mac → "Adblock Mac", and its vendor as a web address, "betafish.com". */
const titleOf = (id: string): string => nameFromId(id).replace(/\b\w/g, (c) => c.toUpperCase())
const vendorOf = (id: string): string => { const p = id.split('.'); return p.length > 1 ? `${p[1]}.${p[0]}` : id }

/** Files in the Library that belong to apps no longer on this Mac, grouped by the app they name. */
export async function leftoversReport(): Promise<CleanReport> {
  const [installed, embedded] = await Promise.all([knownIds(), embeddedNames()])
  const groups = new Map<string, { verdict: Confidence; items: { path: string; dir: boolean; note: string; tick: boolean; label: string; admin: boolean }[] }>()
  const places = [...LIBRARY_PLACES.map((p) => ({ dir: join(home, 'Library', p.dir), key: p.dir, tick: p.tick, note: p.note, admin: false })), ...SYSTEM_PLACES.map((d) => ({ dir: d, key: d, tick: false, note: 'Installed for every account, in a folder only an administrator can change.', admin: true }))]
  for (const place of places) {
    for (const e of await list(place.dir)) {
      const v = leftoverOf(e.name, installed, embedded)
      if (!v || v === 'owned') continue
      const g = groups.get(v.id) ?? { verdict: v.verdict, items: [] }
      g.items.push({ path: e.path, dir: e.dir, note: place.note, tick: place.tick && v.verdict === 'sure', label: PLACE_LABELS[place.key] ?? place.key, admin: place.admin })
      groups.set(v.id, g)
    }
  }
  const all = [...groups.values()].flatMap((g) => g.items.map((i) => i.path))
  const sz = await sizes(all)
  const mt = new Map(await Promise.all(all.map(async (p) => [p, await lstat(p).then((s) => s.mtimeMs, () => 0)] as const)))
  const out2: CleanGroup[] = [...groups.entries()].map(([id, g]) => ({
    id,
    title: titleOf(id),
    sub: `${vendorOf(id)} · ${g.items.length} ${g.items.length === 1 ? 'item' : 'items'}`,
    look: 'leftover',
    text: g.verdict === 'sure' ? `${id}: no app with this identifier is installed, and nothing else from its vendor is.` : `${id}: no app with this identifier is installed, but other apps from its vendor are, and may use it. Not ticked for you.`,
    items: g.items.map((i) => ({
      path: i.path, name: basename(i.path), label: i.label, size: sz.get(i.path) ?? 0, dir: i.dir, safe: i.tick && !i.admin, note: i.note, mtime: mt.get(i.path) || undefined,
      badges: [i.tick ? { text: 'Very likely', tone: 'ok' as const } : { text: 'Likely', tone: 'muted' as const }, ...(i.admin ? [{ text: 'Password', tone: 'warn' as const }] : [])],
      ...(i.admin ? { blocked: 'Only an administrator can move this: show it in Finder and press Command-Delete there.', action: { label: 'Reveal', reveal: i.path } } : {})
    })).sort((a, b) => b.size - a.size)
  })).sort((a, b) => b.items.reduce((s, i) => s + i.size, 0) - a.items.reduce((s, i) => s + i.size, 0))
  return { groups: out2, at: Date.now(), notes: [] }
}

/** Everything that starts itself: launch agents and daemons, helper tools and system extensions, and who owns them. */
export async function startupItems(): Promise<StartupItem[]> {
  const installed = await installedApps(false)
  const apps = installed.map((a) => ({ id: a.id, name: a.name }))
  const pathOf = (name: string): string | undefined => installed.find((a) => a.name === name)?.path
  const loaded = new Set((await out('launchctl', ['list'], 10_000)).split('\n').map((l) => l.trim().split(/\s+/)[2]).filter(Boolean))
  const read = async (path: string): Promise<Record<string, unknown> | null> => {
    try { return JSON.parse(await out('plutil', ['-convert', 'json', '-o', '-', path], 5000)) as Record<string, unknown> } catch { return null }
  }
  const items: StartupItem[] = []
  const add = async (path: string, scope: LaunchScope, plist: Record<string, unknown> | null, labelIn?: string): Promise<void> => {
    let st = { size: 0, mtime: 0 }
    try { const x = await lstat(path); st = { size: (x.blocks ?? 0) * 512, mtime: x.mtimeMs } } catch { /* gone */ }
    const label = labelIn ?? (typeof plist?.Label === 'string' ? plist.Label : entryKey(basename(path)))
    const program = plist ? launchProgram(plist) : scope === 'helper' ? path : ''
    const missing = !!program && program.startsWith('/') && !(await exists(program))
    const owner = startupOwner(label, program, apps)
    const ownerApp = owner ? pathOf(owner) : undefined
    const what = scope === 'helper' ? 'A program an app installed to do what needs an administrator, started by a launch daemon.' : !plist ? 'Its file could not be read, so what it runs is unknown.' : !program ? 'It names no program, so launchd has nothing to start.' : missing ? `Its program, ${program}, is no longer there, so launchd has nothing to start.` : `Runs ${program}.`
    items.push({
      path, label, scope, program, missing, apple: label.startsWith('com.apple.'), owner, ...(ownerApp ? { ownerApp } : {}),
      ownerKind: !owner ? 'none' : ownerApp ? 'app' : 'developer',
      loaded: loaded.has(label), runAtLoad: plist?.RunAtLoad === true || !!plist?.KeepAlive, admin: scope !== 'user-agent', size: st.size, mtime: st.mtime, note: what
    })
  }
  const dirs: { dir: string; scope: LaunchScope }[] = [{ dir: join(home, 'Library/LaunchAgents'), scope: 'user-agent' }, { dir: '/Library/LaunchAgents', scope: 'agent' }, { dir: '/Library/LaunchDaemons', scope: 'daemon' }]
  for (const d of dirs) for (const e of await list(d.dir)) if (e.name.endsWith('.plist')) await add(e.path, d.scope, await read(e.path))
  for (const h of await list('/Library/PrivilegedHelperTools')) await add(h.path, 'helper', null, h.name)
  for (const x of parseSystemExtensions(await out('systemextensionsctl', ['list'], 10_000))) {
    const owner = startupOwner(x.id, '', apps)
    items.push({ path: `sysext:${x.id}`, label: x.name, scope: 'sysext', program: x.id, missing: false, apple: x.id.startsWith('com.apple.'), owner, ...(pathOf(owner) ? { ownerApp: pathOf(owner) } : {}), ownerKind: !owner ? 'none' : pathOf(owner) ? 'app' : 'developer', loaded: /enabled/.test(x.state), runAtLoad: true, admin: true, size: 0, mtime: 0, note: `${x.id} · ${x.state}. Only macOS removes a system extension, when its app goes to the Trash in Finder.` })
  }
  return items
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

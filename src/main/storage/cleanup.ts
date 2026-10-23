import { execFile } from 'node:child_process'
import { lstat, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { BIG_FILE, compareVersions, extOf, type MapNode } from '@shared/storage'
import {
  AI_CACHE_DIRS, AI_PLACES, SUPPORT_CACHES, supportCacheLabel, APPLE_ASSETS, appleAssetGroup, blobDigest, cacheOwner, DOWNLOAD_CACHES, hfRepo, INSTALLER_EXTS, KEEP_CACHES, MODEL_EXTS,
  parseOllamaManifest, parsePackageInfo, VERDICT_NOTE, zipAppPlist,
  type CleanGroup, type CleanItem, type CleanReport, type InstallerVerdict, type PackageReceipt, type SystemCard
} from '@shared/cleanup'
import { fullDiskAccess, scanQuery } from './storage'
import { runningApps } from './running'
import { installedApps } from './macApps'
export { runningApps }

/**
 * The Cleanup rooms' measuring (Junk Files, AI Models, System Data, Installers), Mac app only. Each room's report is
 * a list of groups of items with their sizes, whether they are safe to clear (ticked for you) and why. Sizes come from
 * du, one run for many folders; nothing here moves anything: the renderer sends what the user ticks to storage:trash.
 */

const home = homedir()
const DAY = 86_400_000

/** Runs a command and resolves with what it printed, even when it exits non-zero (du does, for one unreadable folder). */
function out(cmd: string, args: string[], timeout = 60_000): Promise<string> {
  return new Promise((resolve) => execFile(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (_err, stdout) => resolve(stdout ?? '')))
}
function must(cmd: string, args: string[], timeout = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error(stderr?.trim() || err.message)) : resolve(stdout)))
    // Nothing to answer: a disk image with a licence asks on stdin, and the end of input declines it.
    child.stdin?.end()
  })
}

/** Bytes on disk beneath each path, from du (hard links counted once across the batch). Missing paths are left out. */
async function sizes(paths: string[]): Promise<Map<string, number>> {
  const m = new Map<string, number>()
  for (let k = 0; k < paths.length; k += 150) {
    const text = await out('du', ['-sk', '--', ...paths.slice(k, k + 150)], 180_000)
    for (const line of text.split('\n')) {
      const tab = line.indexOf('\t')
      if (tab > 0) m.set(line.slice(tab + 1), parseInt(line.slice(0, tab), 10) * 1024)
    }
  }
  return m
}

async function list(dir: string): Promise<{ name: string; path: string; dir: boolean }[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((d) => d.name !== '.DS_Store' && d.name !== '.localized').map((d) => ({ name: d.name, path: join(dir, d.name), dir: d.isDirectory() }))
  } catch { return [] }
}
const exists = async (p: string): Promise<boolean> => { try { await lstat(p); return true } catch { return false } }
const mtimeOf = async (p: string): Promise<number> => { try { return (await lstat(p)).mtimeMs } catch { return 0 } }

/** Whether a command-line process of this name is running (Ollama's server has no app bundle). */
const processRunning = async (name: string): Promise<boolean> => (await out('pgrep', ['-x', name], 5000)).trim().length > 0

/** When Spotlight last saw each path opened (ms), or 0. */
async function lastUsed(paths: string[]): Promise<Map<string, number>> {
  const m = new Map<string, number>()
  for (let k = 0; k < paths.length; k += 100) {
    const batch = paths.slice(k, k + 100)
    const text = await out('mdls', ['-name', 'kMDItemLastUsedDate', '-raw', '-nullMarker', '', ...batch], 30_000)
    const values = text.split('\0')
    batch.forEach((p, i) => { const t = Date.parse((values[i] ?? '').trim().replace(' +0000', 'Z').replace(' ', 'T')); m.set(p, Number.isFinite(t) ? t : 0) })
  }
  return m
}

const item = (path: string, size: number, dir: boolean, safe: boolean, note?: string, extra: Partial<CleanItem> = {}): CleanItem => ({ path, name: basename(path), size, dir, safe, ...(note ? { note } : {}), ...extra })

/** Folders in Application Support never looked into for caches: big, private, or another room's. */
const SUPPORT_SKIP = new Set(['MobileSync', 'Steam', 'AddressBook', 'CallHistoryDB', 'Knowledge', 'CrashReporter', 'nomic.ai', 'Jan', 'LM Studio', 'node_modules', '.git', 'Caches'])

/** The cache folders Chromium and Electron apps keep in Application Support (Cache, Code Cache, CacheStorage…). */
async function supportCaches(): Promise<{ path: string; rel: string }[]> {
  const root = join(home, 'Library/Application Support')
  const found: { path: string; rel: string }[] = []
  let visited = 0
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > 5 || visited > 6000) return
    visited++
    const entries = await list(dir)
    if (entries.length > 400) return
    for (const e of entries) {
      if (!e.dir || SUPPORT_SKIP.has(e.name) || e.name.startsWith('com.apple.')) continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (SUPPORT_CACHES[e.name] && (e.name !== 'CacheStorage' || rel.endsWith('Service Worker')) && depth > 0) found.push({ path: e.path, rel: r })
      else await walk(e.path, r, depth + 1)
    }
  }
  await walk(root, '', 0)
  return found
}

// ----- Junk Files -----

export async function junkReport(): Promise<CleanReport> {
  const fda = await fullDiskAccess()
  const running = (await runningApps()).filter((a) => a.id || a.name)
  const notes: string[] = []
  const L = (p: string): string => join(home, 'Library', p)

  const apps = await installedApps(false).catch(() => [])
  const appFor = (folder: string): { name: string; path: string } | undefined => {
    const f = folder.toLowerCase()
    return apps.find((a) => a.id && (f === a.id.toLowerCase() || f.startsWith(`${a.id.toLowerCase()}.`))) ?? apps.find((a) => a.name.toLowerCase() === f)
  }
  const caches = (await list(L('Caches'))).filter((e) => !e.name.startsWith('.') && !KEEP_CACHES.has(e.name))
  const fromSupport = await supportCaches()
  const downloadCaches = caches.filter((e) => DOWNLOAD_CACHES[e.name])
  const appCaches = caches.filter((e) => !DOWNLOAD_CACHES[e.name])
  const dotCache = (await list(join(home, '.cache'))).filter((e) => !AI_CACHE_DIRS.has(e.name) && !e.name.startsWith('.'))
  const toolCaches = [join(home, '.npm/_cacache'), join(home, '.npm/_npx'), join(home, 'go/pkg/mod/cache/download'), join(home, '.cargo/registry/cache'), join(home, '.cargo/git/checkouts'), join(home, '.gradle/caches'), join(home, '.pub-cache/hosted'), join(home, 'Library/pnpm/store')]
  const presentTools = (await Promise.all(toolCaches.map(async (p) => ((await exists(p)) ? p : null)))).filter((p): p is string => !!p)
  const logs = (await list(L('Logs'))).filter((e) => !e.name.startsWith('.'))
  let containerCaches: { name: string; path: string; dir: boolean; id: string }[] = []
  if (fda) {
    for (const c of await list(L('Containers'))) {
      const p = join(c.path, 'Data/Library/Caches')
      if (await exists(p)) containerCaches.push({ name: c.name, path: p, dir: true, id: c.name })
    }
  } else notes.push('Without Full Disk Access, the caches apps keep in their containers, Docker\'s disk and UTM\'s machines are not measured.')
  containerCaches = containerCaches.filter((c) => !c.id.startsWith('com.apple.'))

  const dev = L('Developer')
  const derived = await list(join(dev, 'Xcode/DerivedData'))
  const deviceSupport = [...await list(join(dev, 'Xcode/iOS DeviceSupport')), ...await list(join(dev, 'Xcode/watchOS DeviceSupport'))]
  const devSingles = [join(dev, 'Xcode/Archives'), join(dev, 'CoreSimulator/Caches'), join(dev, 'Xcode/UserData/Previews'), join(dev, 'Xcode/Products')]
  const presentDev = (await Promise.all(devSingles.map(async (p) => ((await exists(p)) ? p : null)))).filter((p): p is string => !!p)

  const inst = [...await list(join(home, 'Downloads')), ...await list(join(home, 'Desktop'))].filter((e) => !e.dir && ['dmg', 'pkg', 'mpkg', 'xip', 'iso', 'ipsw'].includes(extOf(e.name)))
  const macInstallers = (await list('/Applications')).filter((e) => /^Install macOS .*\.app$/.test(e.name))
  const iosUpdates = [...await list(L('iTunes/iPhone Software Updates')), ...await list(L('iTunes/iPad Software Updates'))].filter((e) => extOf(e.name) === 'ipsw')
  const downloads = (await list(join(home, 'Downloads'))).filter((e) => !e.name.startsWith('.') && !inst.some((i) => i.path === e.path))

  const vmCandidates = [
    { path: L('Containers/com.docker.docker/Data/vms/0/data/Docker.raw'), note: 'Every image, container and volume Docker keeps. Remove those you no longer need in Docker, or with docker system prune. Moved to the Trash, all of them go with it.' },
    ...(await list(L('Containers/com.utmapp.UTM/Data/Documents'))).filter((e) => e.name.endsWith('.utm')).map((e) => ({ path: e.path, note: 'A whole computer kept as files by UTM. Moved to the Trash, everything in it goes with it.' })),
    ...(await list(join(home, 'Parallels'))).filter((e) => e.name.endsWith('.pvm')).map((e) => ({ path: e.path, note: 'A whole computer kept as files by Parallels. Everything in it goes with it.' })),
    ...(await list(join(home, 'Virtual Machines.localized'))).filter((e) => e.name.endsWith('.vmwarevm')).map((e) => ({ path: e.path, note: 'A whole computer kept as files by VMware. Everything in it goes with it.' })),
    ...(await list(join(home, 'VirtualBox VMs'))).map((e) => ({ path: e.path, note: 'A whole computer kept as files by VirtualBox. Everything in it goes with it.' })),
    ...(await list(L('Application Support/Steam/steamapps/common'))).map((e) => ({ path: e.path, note: 'A game Steam installed. Remove it in Steam, which keeps its list right.' }))
  ]
  const vms = (await Promise.all(vmCandidates.map(async (v) => ((await exists(v.path)) ? v : null)))).filter((v): v is { path: string; note: string } => !!v)

  // node_modules of projects left alone for months, from the last scan when there is one.
  const modules = (await scanQuery<MapNode[]>('named', { names: ['node_modules'], min: 50 * BIG_FILE }).catch(() => null)) ?? []

  const all = [...fromSupport.map((s) => ({ path: s.path })), ...appCaches, ...downloadCaches, ...dotCache, ...logs, ...derived, ...deviceSupport, ...inst, ...macInstallers, ...iosUpdates, ...downloads, ...containerCaches].map((e) => e.path)
  const sz = await sizes([...all, ...presentTools, ...presentDev, ...vms.map((v) => v.path)])
  const size = (p: string): number => sz.get(p) ?? 0
  const MB = BIG_FILE

  const RUNNING = { text: 'Running', tone: 'warn' as const }
  const ownerNote = (name: string): { safe: boolean; note: string; badges?: CleanItem['badges'] } => {
    const owner = cacheOwner(name, running)
    if (owner) return { safe: false, note: `${owner.name || owner.id} is open, and may be writing into it: quit it first.`, badges: [RUNNING] }
    if (name.startsWith('com.apple.')) return { safe: false, note: 'Kept by a part of macOS, which rebuilds it. Not ticked for you.', badges: [{ text: 'macOS', tone: 'muted' }] }
    return { safe: true, note: 'The app rebuilds its cache when it next needs it.' }
  }
  /** A ~/Library/Caches folder titled with its app's name, the folder's own beneath. */
  const cacheItem = (e: { name: string; path: string; dir: boolean }, id = e.name): CleanItem => {
    const o = ownerNote(id)
    const app = appFor(id)
    return item(e.path, size(e.path), e.dir, o.safe, o.note, { ...(app ? { label: app.name, app: app.path } : {}), ...(o.badges ? { badges: o.badges } : {}), ...(e.name !== id ? { name: id } : {}) })
  }
  const xcodeOpen = running.some((r) => r.id === 'com.apple.dt.Xcode')

  const groups: CleanGroup[] = [
    {
      id: 'caches', title: 'App caches', text: 'Copies apps and browsers keep to open faster. Each rebuilds its own when it next needs it.',
      items: [
        ...appCaches.map((e) => cacheItem(e)),
        ...fromSupport.map((s) => {
          const { app, label } = supportCacheLabel(s.rel)
          const owner = cacheOwner(app, running) ?? cacheOwner(s.rel.split('/')[0], running)
          const inst = apps.find((a) => a.name.toLowerCase() === app.toLowerCase() || a.name.toLowerCase() === s.rel.split('/')[0].toLowerCase())
          return item(s.path, size(s.path), true, !owner, owner ? `${owner.name} is open, and may be writing into it: quit it first.` : 'The app rebuilds it when it next needs it.', {
            label, name: s.rel.split('/').slice(-1)[0], ...(inst ? { app: inst.path } : {}), ...(owner ? { badges: [RUNNING] } : {})
          })
        }),
        ...containerCaches.map((c) => cacheItem({ name: 'Caches', path: c.path, dir: true }, c.id))
      ]
    },
    {
      id: 'logs', title: 'Logs and crash reports', text: 'Records apps and macOS wrote about what they did and how they failed. Logs are records, not documents.',
      items: logs.map((e) => item(e.path, size(e.path), e.dir, true, 'Logs are diagnostic records, not documents.'))
    },
    {
      id: 'downloads', title: 'Package managers\' downloads', text: 'Downloads Homebrew, npm, pip and other tools keep in case they are needed again.',
      items: [
        ...downloadCaches.map((e) => item(e.path, size(e.path), e.dir, true, 'The tool downloads what it needs again.', { name: DOWNLOAD_CACHES[e.name] })),
        ...presentTools.map((p) => item(p, size(p), true, !p.includes('pnpm/store'), p.includes('pnpm/store') ? 'pnpm links each package from this store into every project, so moving it frees far less than its size. Not ticked for you.' : 'The tool downloads what it needs again.', { name: p.replace(`${home}/`, '~/') })),
        ...dotCache.map((e) => item(e.path, size(e.path), e.dir, true, 'Kept in ~/.cache, where tools put what they can fetch again.', { name: `~/.cache/${e.name}` }))
      ]
    },
    {
      id: 'developer', title: 'Developer build data', text: 'What Xcode, the simulators and your projects\' tools make again as needed, and Xcode\'s archives.',
      items: [
        ...derived.map((e) => item(e.path, size(e.path), true, !xcodeOpen, xcodeOpen ? 'Xcode is open, and may be writing into it: quit it first.' : 'Xcode builds this project again the next time it is opened.', { name: `DerivedData: ${e.name.replace(/-[a-z]{20,}$/, '')}` })),
        ...presentDev.map((p) => p.endsWith('Archives')
          ? item(p, size(p), true, false, 'Apps as Xcode archived them, with the symbols needed to read their crash reports. Keep the archives of versions people still use. Not ticked for you.', { name: 'Xcode archives' })
          : item(p, size(p), true, !xcodeOpen, p.includes('Previews') ? 'Xcode makes these again for the next preview.' : 'The simulators and Xcode rebuild these.', { name: p.includes('Previews') ? 'SwiftUI preview data' : p.includes('Products') ? 'Xcode products' : 'Simulator caches' })),
        ...deviceSupport.map((e) => item(e.path, size(e.path), true, false, 'Copied from a device when it was plugged in, and copied again the next time it is. Not ticked for you.', { name: `Device support: ${e.name}` }))
      ]
    },
    { id: 'modules', title: 'node_modules of quiet projects', text: 'Packages a project installed. Installing the project\'s packages brings them back.', items: await moduleItems(modules) },
    {
      id: 'installers', title: 'Installers', text: 'Disk images, packages, macOS installers and iPhone and iPad updates. What they installed stays.',
      items: [
        ...inst.map((e) => item(e.path, size(e.path), false, false, 'An installer you downloaded. What it installed stays. Not ticked for you (Installers ticks the ones whose app is already installed).')),
        ...macInstallers.map((e) => item(e.path, size(e.path), true, false, 'A macOS installer. Your Mac does not need it to run; keep it only to install that version of macOS. Not ticked for you.')),
        ...iosUpdates.map((e) => item(e.path, size(e.path), false, false, 'An iPhone or iPad update Finder downloaded. Finder downloads it again when a device needs it. Not ticked for you.'))
      ]
    },
    { id: 'old', title: 'Downloads not opened for three months', text: 'Files in Downloads nobody has opened lately. Yours, so never ticked for you.', items: await oldDownloads(downloads.map((d) => ({ ...d, size: size(d.path) }))) },
    { id: 'vms', title: 'Virtual machines and games', text: 'Whole computers kept as files, and installed games. Never ticked for you.', items: vms.map((v) => item(v.path, size(v.path), !v.path.endsWith('.raw'), false, v.note)) }
  ]
  const LOOKS: Record<string, string> = { caches: 'caches', logs: 'logs', downloads: 'downloads', developer: 'developer', modules: 'developer', installers: 'installers', old: 'downloads-old', vms: 'vms' }
  for (const g of groups) {
    g.items = g.items.filter((i) => i.size >= MB).sort((a, b) => b.size - a.size)
    g.look = LOOKS[g.id]
    // When each last changed, for the line under its name.
    await Promise.all(g.items.map(async (i) => { if (!i.mtime) i.mtime = await mtimeOf(i.path) }))
  }
  return { groups: groups.filter((g) => g.items.length), at: Date.now(), notes }
}

/** A node_modules folder is ticked only when its project has a lockfile and nothing in it changed for three months. */
async function moduleItems(nodes: MapNode[]): Promise<CleanItem[]> {
  const out: CleanItem[] = []
  for (const n of nodes.slice(0, 200)) {
    const project = n.path.replace(/\/node_modules$/, '')
    const entries = (await list(project)).filter((e) => e.name !== 'node_modules' && e.name !== '.git')
    const lock = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'].find((f) => entries.some((e) => e.name === f))
    let newest = 0
    for (const e of entries.slice(0, 200)) newest = Math.max(newest, await mtimeOf(e.path))
    const quiet = newest > 0 && Date.now() - newest > 90 * DAY
    const tool = lock?.startsWith('pnpm') ? 'pnpm install' : lock?.startsWith('yarn') ? 'yarn install' : lock?.startsWith('bun') ? 'bun install' : 'npm install'
    const note = !lock ? `${tool} brings it back. Not ticked for you: without a lockfile, the versions it installs may differ.`
      : !quiet ? `${tool} brings it back, from ${lock}. Not ticked for you: the project changed in the last three months.`
        : `Nothing in the project has changed for months. ${tool} brings it back, the same, from ${lock}.`
    out.push(item(n.path, n.size, true, !!lock && quiet, note, { name: basename(project), mtime: newest }))
  }
  return out
}

async function oldDownloads(entries: { name: string; path: string; dir: boolean; size: number }[]): Promise<CleanItem[]> {
  const big = entries.filter((e) => e.size >= 10 * BIG_FILE)
  const used = await lastUsed(big.map((e) => e.path))
  const out: CleanItem[] = []
  for (const e of big) {
    const last = used.get(e.path) || (await mtimeOf(e.path))
    if (Date.now() - last > 90 * DAY) out.push(item(e.path, e.size, e.dir, false, 'Not opened for three months or more.', { used: last }))
  }
  return out
}

// ----- AI Models -----

export async function aiReport(): Promise<CleanReport> {
  const groups = new Map<string, CleanGroup>()
  const add = (tool: string, text: string, items: CleanItem[]): void => {
    const g = groups.get(tool) ?? { id: tool.toLowerCase().replace(/\W+/g, '-'), title: tool, text, items: [] }
    g.items.push(...items)
    groups.set(tool, g)
  }
  const running = await runningApps()
  const appOpen = (name: string): boolean => running.some((r) => r.name === name)
  const ollamaOn = await processRunning('ollama') || appOpen('Ollama')
  const known: string[] = []

  for (const place of AI_PLACES) {
    const root = join(home, place.path)
    if (!(await exists(root))) continue
    known.push(root)
    if (place.layout === 'ollama') {
      const models: CleanItem[] = []
      const used = new Set<string>()
      const manifests = join(root, 'manifests')
      const walkManifests = async (dir: string, rel: string): Promise<void> => {
        for (const e of await list(dir)) {
          if (e.dir) await walkManifests(e.path, rel ? `${rel}/${e.name}` : e.name)
          else {
            const m = parseOllamaManifest(rel ? `${rel}/${e.name}` : e.name, await readFile(e.path, 'utf8').catch(() => ''))
            if (!m) continue
            for (const b of m.blobs) used.add(b.digest)
            models.push(item(e.path, m.size, false, false, place.back, {
              name: m.name, category: 'model',
              blocked: `Removed with ollama rm in Terminal: only Ollama removes its models safely.${ollamaOn ? '' : ' It works when Ollama is running.'}`,
              action: { label: 'Copy the command', copy: `ollama rm ${m.name}` }
            }))
          }
        }
      }
      await walkManifests(manifests, '')
      const blobs = await list(join(root, 'blobs'))
      const orphans = blobs.filter((b) => !b.dir && (b.name.includes('-partial') || !used.has(blobDigest(b.name))))
      const sz = await sizes(orphans.map((o) => o.path))
      add('Ollama', 'Ollama keeps models as shared layers; only Ollama removes a model safely. Downloads that stopped part way, or that no model uses, can go.', [
        ...models.sort((a, b) => b.size - a.size),
        ...orphans.map((o) => item(o.path, sz.get(o.path) ?? 0, false, !ollamaOn, ollamaOn ? 'Ollama is running: quit it, or stop its server, first.' : o.name.includes('-partial') ? 'A download that stopped part way.' : 'A download no model uses.', { name: o.name.includes('-partial') ? 'Unfinished download' : 'Layer no model uses', category: 'cache' }))
      ])
      continue
    }
    let entries = await list(root)
    if (place.tool === 'LM Studio') entries = (await Promise.all(entries.filter((e) => e.dir).map((e) => list(e.path)))).flat()
    if (place.layout === 'hf') {
      const repos = entries.filter((e) => e.dir && hfRepo(e.name))
      const sz = await sizes(repos.map((r) => r.path))
      add('Hugging Face', 'What Python libraries downloaded from Hugging Face. Each comes back the next time code asks for it, though big ones take a while.', repos.map((r) => {
        const repo = hfRepo(r.name)!
        return item(r.path, sz.get(r.path) ?? 0, true, false, `${repo.kind === 'model' ? 'A model' : repo.kind === 'dataset' ? 'A dataset' : 'A space'}. ${place.back}`, { name: repo.name, category: repo.kind === 'model' ? 'model' : 'other' })
      }))
      const xet = join(home, '.cache/huggingface/xet')
      if (await exists(xet)) add('Hugging Face', '', [item(xet, (await sizes([xet])).get(xet) ?? 0, true, true, 'A cache of the pieces downloads are made of. Fetched again as needed.', { name: 'Download cache (xet)', category: 'cache' })])
      continue
    }
    const open = place.tool === 'LM Studio' ? appOpen('LM Studio') : place.tool === 'GPT4All' ? appOpen('GPT4All') : place.tool === 'Jan' ? appOpen('Jan') : false
    const shown = place.layout === 'files' ? entries : entries.filter((e) => e.dir)
    const sz = await sizes(shown.map((e) => e.path))
    add(place.tool, place.back, shown.map((e) => item(e.path, sz.get(e.path) ?? 0, e.dir, false, open ? `${place.tool} is open: quit it before moving its models. ${place.back}` : place.back, { category: place.path.includes('cache') && place.tool !== 'LM Studio' ? 'cache' : 'model', ...(place.tool === 'LM Studio' ? { name: e.path.split('/').slice(-2).join('/') } : {}) })))
  }

  // Model files elsewhere, from the last scan.
  const found = (await scanQuery<MapNode[]>('search', { query: MODEL_EXTS.join(' '), min: 100 * BIG_FILE, limit: 300 }).catch(() => null)) ?? []
  const other = found.filter((f) => !known.some((k) => f.path.startsWith(`${k}/`)) && !f.path.startsWith('/System/'))
  if (other.length) add('Other model files', 'Model files from tools the app does not know by name. A model added by hand has to be downloaded again from where it came from.', other.map((f) => item(f.path, f.size, f.dir, false, 'Model files from a tool the app does not know by name.', { category: 'other' })))

  // Apple's own, which only macOS removes.
  const assets = await list('/System/Library/AssetsV2')
  const byGroup = new Map<string, string[]>()
  for (const a of assets) { const g = appleAssetGroup(a.name); if (g) byGroup.set(g, [...(byGroup.get(g) ?? []), a.path]) }
  const appleSizes = await sizes([...byGroup.values()].flat())
  const apple: CleanItem[] = APPLE_ASSETS.filter((a) => byGroup.has(a.id)).map((a) => item(`/System/Library/AssetsV2#${a.id}`, (byGroup.get(a.id) ?? []).reduce((s, p) => s + (appleSizes.get(p) ?? 0), 0), true, false, `${a.text} ${a.how}`, {
    name: a.title, label: a.title, category: 'model', blocked: 'macOS downloads these by itself and protects them: only macOS removes them.', action: { label: 'Open the setting', url: a.url }, sub: a.id
  }))
  if (apple.length) add('Apple', 'On-device models for Apple Intelligence, Siri, dictation, voices and translation. macOS protects them, and only macOS can remove them.', apple)

  const out = [...groups.values()].map((g) => ({ ...g, look: g.id === 'apple' ? 'apple' : 'ai', items: g.items.filter((i) => i.size >= BIG_FILE).sort((a, b) => b.size - a.size) })).filter((g) => g.items.length)
  const notes = (await fullDiskAccess()) ? [] : ['Without Full Disk Access, models kept inside apps\' containers (Draw Things, for one) are not measured.']
  return { groups: out, at: Date.now(), notes }
}

// ----- System Data -----

/** What System Data holds and what Storage settings counts beside it, as cards: each says where it is managed. */
export async function systemCards(): Promise<{ cards: SystemCard[]; notes: string[] }> {
  const fda = await fullDiskAccess()
  const L = (p: string): string => join(home, 'Library', p)
  const notes: string[] = fda ? [] : ['macOS hides device backups, attachments and the Trash from apps without Full Disk Access, so some of these could not be measured.']
  const backups = await list(L('Application Support/MobileSync/Backup'))
  const music = ['/Library/Application Support/GarageBand', '/Library/Application Support/Logic', '/Library/Audio/Apple Loops']
  const mail = L('Containers/com.apple.mail/Data/Library/Mail Downloads')
  const messages = L('Messages/Attachments')
  const trash = join(home, '.Trash')
  const devices = L('Developer/CoreSimulator/Devices')
  const junkPlaces = [L('Caches'), L('Logs'), L('Developer/Xcode/DerivedData')]
  const aiPlaces = AI_PLACES.map((p) => join(home, p.path))
  const sz = await sizes([...backups.map((b) => b.path), ...music, mail, messages, trash, devices, ...junkPlaces, ...aiPlaces])
  const size = (p: string): number => sz.get(p) ?? 0
  const storage = 'x-apple.systempreferences:com.apple.settings.Storage'

  const backupItems: CleanItem[] = []
  for (const b of backups) {
    const info = join(b.path, 'Info.plist')
    const name = (await out('plutil', ['-extract', 'Device Name', 'raw', '-o', '-', info], 5000)).trim()
    const when = (await out('plutil', ['-extract', 'Last Backup Date', 'raw', '-o', '-', info], 5000)).trim()
    backupItems.push(item(b.path, size(b.path), true, false, 'A device that backs up to iCloud does not need this.', { label: name ? `${name}` : 'Device backup', sub: when ? `backed up ${when.slice(0, 10)}` : undefined }))
  }
  // Simulator runtimes, with their size and when each was last used (xcrun is there only with Xcode).
  const runtimes: { label: string; sub?: string; size?: number }[] = []
  try {
    const j = JSON.parse(await out('xcrun', ['simctl', 'runtime', 'list', '-j'], 15_000) || '{}') as Record<string, { version?: string; sizeBytes?: number; lastUsedAt?: string; platformIdentifier?: string }>
    for (const r of Object.values(j)) {
      const plat = /iphone/i.test(r.platformIdentifier ?? '') ? 'iOS' : /watch/i.test(r.platformIdentifier ?? '') ? 'watchOS' : /tv/i.test(r.platformIdentifier ?? '') ? 'tvOS' : /xr|vision/i.test(r.platformIdentifier ?? '') ? 'visionOS' : ''
      runtimes.push({ label: `${plat} ${r.version ?? ''}`.trim(), sub: r.lastUsedAt ? `used ${r.lastUsedAt.slice(0, 10)}` : undefined, size: r.sizeBytes })
    }
  } catch { /* no Xcode */ }
  runtimes.sort((a, b) => (b.size ?? 0) - (a.size ?? 0))
  const swap = /used = ([\d.]+)M/.exec(await out('sysctl', ['-n', 'vm.swapusage'], 5000))
  const snapshots = (await out('tmutil', ['listlocalsnapshots', '/'], 10_000)).split('\n').filter((l) => l.includes('com.apple.TimeMachine')).length
  const trashCount = (await list(trash)).length

  const cards: SystemCard[] = [
    { id: 'system', title: 'In System Data', tag: 'System Data', look: 'system', text: 'Storage settings counts caches, logs, app support files and the like as System Data, and macOS looks after most of it. What of it can go has a room of its own.',
      rows: [{ label: 'Caches, logs and build data', size: junkPlaces.reduce((t, p) => t + size(p), 0), room: 'junk' }, { label: 'Leftovers of removed apps', room: 'leftovers' }] },
    { id: 'ai', title: 'AI Models', tag: 'System Data or Documents', look: 'ai', text: 'What AI apps downloaded. Storage settings counts models an app keeps in your Library as System Data; those in a folder of their own, such as Ollama\'s, may count as Documents.',
      rows: [{ label: 'Models and caches from AI apps', size: aiPlaces.reduce((t, p) => t + size(p), 0), room: 'ai' }] },
    { id: 'backups', title: 'iPhone and iPad Backups', tag: 'iOS Files', look: 'backups', text: backupItems.length ? 'Copies Finder made when a device was backed up to this Mac, often of a phone long since replaced.' : 'None on this Mac. Finder makes one when a device is backed up to this Mac rather than to iCloud.',
      ...(backupItems.length ? { size: backupItems.reduce((t, i) => t + i.size, 0), items: backupItems } : {}) },
    { id: 'mail', title: 'Mail\'s Copies of Attachments', tag: 'Mail', look: 'mail', text: 'Mail saves a copy of an attachment when you open it. The original stays in the message, and Mail saves it again if you open it again, so these can go.',
      ...(size(mail) >= BIG_FILE ? { size: size(mail), items: [item(mail, size(mail), true, true, 'Copies of attachments you opened.', { label: 'Mail Downloads' })] } : {}) },
    ...(size(messages) ? [{ id: 'messages', title: 'Messages Attachments', tag: 'Messages', look: 'messages', size: size(messages), text: 'Photos, videos and files from your conversations. Remove them in Messages, or in Storage settings with the Info button beside Messages, so the conversations keep track of what went. Moving the folder would leave gaps in them.', actions: [{ label: 'Open Storage Settings', url: storage }] }] : []),
    ...(runtimes.length || size(devices) ? [{ id: 'simulators', title: 'Xcode Simulators', tag: 'Developer', look: 'simulators', size: runtimes.reduce((t, r) => t + (r.size ?? 0), 0) + size(devices),
      text: 'The versions of iOS and the other systems Xcode\'s simulators run, and the simulators themselves. macOS keeps them where only Xcode may change them: remove those you no longer test on in Xcode, Settings, Components.',
      rows: [...runtimes, ...(size(devices) ? [{ label: 'Simulator devices', sub: 'everything installed in them', size: size(devices) }] : [])], actions: [{ label: 'Open Xcode', url: 'file:///Applications/Xcode.app' }] }] : []),
    ...(music.some((m) => size(m)) ? [{ id: 'music', title: 'GarageBand and Logic Sounds', tag: 'Music Creation', look: 'music', size: music.reduce((t, m) => t + size(m), 0), text: 'Instruments, loops and samples GarageBand and Logic Pro downloaded. Remove those you do not use in Storage settings, under Music Creation; deleted any other way, the apps ask to download them again.', actions: [{ label: 'Open Storage Settings', url: storage }] }] : []),
    ...(swap && parseFloat(swap[1]) > 0 ? [{ id: 'swap', title: 'Swap', tag: 'macOS', look: 'system', size: parseFloat(swap[1]) * 1_048_576, text: 'Memory macOS set aside on the disk to make room. It shrinks by itself as memory frees up.' }] : []),
    { id: 'snapshots', title: 'Time Machine Snapshots', tag: 'Counted as available', look: 'snapshots', text: snapshots ? `${snapshots} local snapshot${snapshots === 1 ? '' : 's'} Time Machine keeps between backups. macOS deletes them by itself when the space is needed, and already counts it as available.` : 'None now. Time Machine keeps local copies between backups, and macOS deletes them by itself when the space is needed.', actions: [{ label: 'Time Machine Settings', url: 'x-apple.systempreferences:com.apple.Time-Machine-Settings.extension' }] },
    { id: 'trash', title: 'The Trash', tag: 'Trash', look: 'trash', size: size(trash), text: `${trashCount ? `${trashCount} item${trashCount === 1 ? '' : 's'} already removed, still taking space. ` : ''}This app moves things here and never empties it, because that is the one step that cannot be undone: choose Empty in Finder to get the space back.`, actions: [{ label: 'Open Trash', room: 'trash' }] }
  ]
  return { cards, notes }
}

// ----- Installers -----

/** The app an installer carries (bundle id and version), read without installing anything; null when it cannot be read. */
async function carried(path: string): Promise<{ id: string; version: string; name: string } | null> {
  const ext = extOf(path)
  const tmp = await mkdtemp(join(tmpdir(), 'ec2ra-inst-'))
  let stillMounted = false
  try {
    if (ext === 'zip') {
      const entry = zipAppPlist((await must('unzip', ['-Z1', path], 30_000)).split('\n'))
      if (!entry) return null
      await must('unzip', ['-qq', '-o', path, entry, '-d', tmp], 30_000)
      return plistApp(join(tmp, entry), entry.split('/').find((p) => p.endsWith('.app')) ?? '')
    }
    if (ext === 'pkg' || ext === 'mpkg') {
      const files = (await must('xar', ['-tf', path], 30_000)).split('\n').filter((f) => /(^|\/)PackageInfo$/.test(f))
      for (const f of files.slice(0, 8)) {
        await must('xar', ['-xf', path, '-C', tmp, f], 30_000)
        const app = parsePackageInfo(await readFile(join(tmp, f), 'utf8'))[0]
        if (app?.id) return { id: app.id, version: app.version, name: basename(app.path) }
      }
      return null
    }
    if (ext === 'dmg') {
      // An encrypted image would ask for its password in a dialog: not opened.
      if (/encrypted: YES/i.test(await out('hdiutil', ['isencrypted', path], 15_000))) return null
      const plist = await must('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-noverify', '-mountrandom', tmp, '-plist', path], 90_000)
      const mounts = [...plist.matchAll(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/g)].map((m) => m[1])
      try {
        for (const m of mounts) {
          const app = (await list(m)).find((e) => e.dir && e.name.endsWith('.app'))
          if (app) return await plistApp(join(app.path, 'Contents/Info.plist'), app.name)
        }
        return null
      } finally {
        for (const m of mounts) await must('hdiutil', ['detach', '-force', m], 30_000).catch(() => { stillMounted = true })
      }
    }
    return null
  } catch { return null } finally {
    // Never clear the temporary folder while an image is still mounted inside it.
    if (!stillMounted) await rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function plistApp(plist: string, appName: string): Promise<{ id: string; version: string; name: string } | null> {
  try {
    const j = JSON.parse(await must('plutil', ['-convert', 'json', '-o', '-', plist], 10_000)) as Record<string, string>
    return j.CFBundleIdentifier ? { id: j.CFBundleIdentifier, version: j.CFBundleShortVersionString || j.CFBundleVersion || '', name: appName } : null
  } catch { return null }
}

/** The installed app with a bundle id (Applications first) and its version. */
async function installed(id: string): Promise<{ path: string; version: string } | null> {
  const paths = (await out('mdfind', [`kMDItemCFBundleIdentifier == '${id.replace(/'/g, '')}'`], 10_000)).split('\n').filter((p) => p.endsWith('.app') && !p.includes('/Volumes/') && !p.startsWith(tmpdir()))
  const pick = paths.find((p) => p.startsWith('/Applications/')) ?? paths[0]
  if (!pick) return null
  const app = await plistApp(join(pick, 'Contents/Info.plist'), basename(pick))
  return { path: pick, version: app?.version ?? '' }
}

export async function installersReport(): Promise<CleanReport> {
  const files = [...await list(join(home, 'Downloads')), ...await list(join(home, 'Desktop'))].filter((e) => !e.dir && INSTALLER_EXTS.has(extOf(e.name)) || (e.dir && extOf(e.name) === 'pkg'))
  const sz = await sizes(files.map((f) => f.path))
  const apps = (await list('/Applications')).filter((e) => e.name.endsWith('.app')).map((e) => e.name.replace(/\.app$/, '').toLowerCase())
  const items: CleanItem[] = []
  for (const f of files) {
    const size = sz.get(f.path) ?? 0
    if (size < BIG_FILE) continue
    const app = await carried(f.path)
    let verdict: InstallerVerdict = 'none'
    let have: { path: string; version: string } | null = null
    if (app) {
      have = await installed(app.id)
      verdict = !have ? 'none' : !app.version || !have.version ? 'unread' : compareVersions(app.version, have.version) > 0 ? 'newer' : compareVersions(app.version, have.version) < 0 ? 'older' : 'same'
    } else {
      // Not readable: a name that matches an installed app is worth listing, unticked.
      const stem = f.name.replace(/\.(dmg|pkg|mpkg|zip|xip)$/i, '').toLowerCase().replace(/[-_ ]?(v?\d[\w.]*|universal|arm64|x64|intel|mac(os)?|osx|installer|setup)+$/g, '').trim()
      if (stem.length > 2 && apps.some((a) => a === stem || a.startsWith(`${stem} `) || stem.startsWith(a))) verdict = 'unread'
    }
    if (verdict === 'none') continue
    const what = app ? `${app.name.replace(/\.app$/, '')} ${app.version}`.trim() : ''
    const where = f.path.startsWith(join(home, 'Downloads')) ? 'Downloads' : 'Desktop'
    const badge: CleanItem['badges'] = [verdict === 'same' ? { text: 'Same as installed', tone: 'ok' } : verdict === 'older' ? { text: 'Older than installed', tone: 'info' } : verdict === 'newer' ? { text: 'Newer than installed', tone: 'warn' } : { text: 'Version not read', tone: 'muted' }]
    items.push(item(f.path, size, f.dir, verdict === 'same' || verdict === 'older', VERDICT_NOTE[verdict], {
      badges: badge, mtime: await mtimeOf(f.path),
      sub: [what ? `${what} inside` : '', have?.version ? `${have.version} installed` : '', where].filter(Boolean).join(' · '),
      ...(have ? { app: have.path } : {})
    }))
  }
  return { groups: items.length ? [{ id: 'installers', title: 'Installers for apps already installed', text: 'Disk images, packages and zips in Downloads and on the Desktop whose app is already installed, at their version or newer. The apps stay installed.', items: items.sort((a, b) => b.size - a.size) }] : [], at: Date.now(), notes: [] }
}

/** What each installer package put on this Mac (receipts other than Apple's), and how much of it is still there. */
export async function packageReceipts(): Promise<PackageReceipt[]> {
  const ids = (await out('pkgutil', ['--pkgs'], 20_000)).split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('com.apple.'))
  const out2: PackageReceipt[] = []
  const one = async (id: string): Promise<void> => {
    const info = await out('pkgutil', ['--pkg-info-plist', id], 10_000)
    const val = (k: string): string => new RegExp(`<key>${k}</key>\\s*<(?:string|integer)>([^<]*)</`).exec(info)?.[1] ?? ''
    const volume = val('volume') || '/'
    const location = val('install-location')
    const files = (await out('pkgutil', ['--only-files', '--files', id], 20_000)).split('\n').filter(Boolean)
    let remaining = 0
    let bytes = 0
    let unreadable = 0
    for (const f of files.slice(0, 20_000)) {
      try { const st = await lstat(join(volume, location, f)); remaining++; bytes += (st.blocks ?? 0) * 512 } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') unreadable++ }
    }
    const app = files.find((f) => /^[^/]+\.app\/Contents\/Info\.plist$/.test(f) || /^Applications\/[^/]+\.app\/Contents\/Info\.plist$/.test(f))
    out2.push({ id, version: val('pkg-version'), installedAt: Number(val('install-time')) * 1000, location: join(volume, location), files: files.length, remaining, bytes, unreadable, ...(app ? { app: app.replace(/\/Contents\/Info\.plist$/, '').split('/').pop() } : {}) })
  }
  for (let k = 0; k < ids.length; k += 6) await Promise.all(ids.slice(k, k + 6).map(one))
  return out2.sort((a, b) => b.bytes - a.bytes)
}

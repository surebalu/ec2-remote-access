import { execFile } from 'node:child_process'
import { lstat, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { BIG_FILE, compareVersions, extOf, type MapNode } from '@shared/storage'
import {
  AI_CACHE_DIRS, AI_PLACES, APPLE_ASSETS, appleAssetGroup, blobDigest, cacheOwner, DOWNLOAD_CACHES, hfRepo, INSTALLER_EXTS, KEEP_CACHES, MODEL_EXTS,
  parseOllamaManifest, parsePackageInfo, VERDICT_NOTE, zipAppPlist,
  type CleanGroup, type CleanItem, type CleanReport, type InstallerVerdict, type PackageReceipt
} from '@shared/cleanup'
import { fullDiskAccess, scanQuery } from './storage'

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

/** The apps running now, with their bundle ids (lsappinfo needs no permission). */
export async function runningApps(): Promise<{ id: string; name: string; pid: number; type: string; path: string }[]> {
  const text = await out('lsappinfo', ['list'], 10_000)
  const apps: { id: string; name: string; pid: number; type: string; path: string }[] = []
  for (const block of text.split(/\n(?=\s*\d+\) ")/)) {
    const name = /^\s*\d+\) "([^"]*)"/.exec(block)?.[1]
    if (!name) continue
    apps.push({
      name,
      id: /bundleID="([^"]*)"/.exec(block)?.[1] ?? '',
      pid: Number(/pid = (\d+)/.exec(block)?.[1] ?? 0),
      type: /type="([^"]*)"/.exec(block)?.[1] ?? '',
      path: /bundle path="([^"]*)"/.exec(block)?.[1] ?? ''
    })
  }
  return apps
}

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

// ----- Junk Files -----

export async function junkReport(): Promise<CleanReport> {
  const fda = await fullDiskAccess()
  const running = (await runningApps()).filter((a) => a.id || a.name)
  const notes: string[] = []
  const L = (p: string): string => join(home, 'Library', p)

  const caches = (await list(L('Caches'))).filter((e) => !e.name.startsWith('.') && !KEEP_CACHES.has(e.name))
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

  const all = [...appCaches, ...downloadCaches, ...dotCache, ...logs, ...derived, ...deviceSupport, ...inst, ...macInstallers, ...iosUpdates, ...downloads, ...containerCaches].map((e) => e.path)
  const sz = await sizes([...all, ...presentTools, ...presentDev, ...vms.map((v) => v.path)])
  const size = (p: string): number => sz.get(p) ?? 0
  const MB = BIG_FILE

  const ownerNote = (name: string): { safe: boolean; note: string } => {
    const owner = cacheOwner(name, running)
    if (owner) return { safe: false, note: `${owner.name || owner.id} is open, and may be writing into it: quit it first.` }
    if (name.startsWith('com.apple.')) return { safe: false, note: 'Kept by a part of macOS, which rebuilds it. Not ticked for you.' }
    return { safe: true, note: 'The app rebuilds its cache when it next needs it.' }
  }
  const xcodeOpen = running.some((r) => r.id === 'com.apple.dt.Xcode')

  const groups: CleanGroup[] = [
    {
      id: 'caches', title: 'App caches', text: 'Copies apps and browsers keep to open faster. Each rebuilds its own when it next needs it.',
      items: [
        ...appCaches.map((e) => { const o = ownerNote(e.name); return item(e.path, size(e.path), e.dir, o.safe, o.note) }),
        ...containerCaches.map((c) => { const o = ownerNote(c.id); return item(c.path, size(c.path), true, o.safe, o.note, { name: c.id }) })
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
  for (const g of groups) g.items = g.items.filter((i) => i.size >= MB).sort((a, b) => b.size - a.size)
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
              name: m.name,
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
        ...orphans.map((o) => item(o.path, sz.get(o.path) ?? 0, false, !ollamaOn, ollamaOn ? 'Ollama is running: quit it, or stop its server, first.' : o.name.includes('-partial') ? 'A download that stopped part way.' : 'A download no model uses.', { name: o.name.includes('-partial') ? 'Unfinished download' : 'Layer no model uses' }))
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
        return item(r.path, sz.get(r.path) ?? 0, true, false, `${repo.kind === 'model' ? 'A model' : repo.kind === 'dataset' ? 'A dataset' : 'A space'}. ${place.back}`, { name: repo.name })
      }))
      const xet = join(home, '.cache/huggingface/xet')
      if (await exists(xet)) add('Hugging Face', '', [item(xet, (await sizes([xet])).get(xet) ?? 0, true, true, 'A cache of the pieces downloads are made of. Fetched again as needed.', { name: 'Download cache (xet)' })])
      continue
    }
    const open = place.tool === 'LM Studio' ? appOpen('LM Studio') : place.tool === 'GPT4All' ? appOpen('GPT4All') : place.tool === 'Jan' ? appOpen('Jan') : false
    const shown = place.layout === 'files' ? entries : entries.filter((e) => e.dir)
    const sz = await sizes(shown.map((e) => e.path))
    add(place.tool, place.back, shown.map((e) => item(e.path, sz.get(e.path) ?? 0, e.dir, false, open ? `${place.tool} is open: quit it before moving its models. ${place.back}` : place.back, place.tool === 'LM Studio' ? { name: e.path.split('/').slice(-2).join('/') } : {})))
  }

  // Model files elsewhere, from the last scan.
  const found = (await scanQuery<MapNode[]>('search', { query: MODEL_EXTS.join(' '), min: 100 * BIG_FILE, limit: 300 }).catch(() => null)) ?? []
  const other = found.filter((f) => !known.some((k) => f.path.startsWith(`${k}/`)) && !f.path.startsWith('/System/'))
  if (other.length) add('Other model files', 'Model files from tools the app does not know by name. A model added by hand has to be downloaded again from where it came from.', other.map((f) => item(f.path, f.size, f.dir, false, 'Model files from a tool the app does not know by name.')))

  // Apple's own, which only macOS removes.
  const assets = await list('/System/Library/AssetsV2')
  const byGroup = new Map<string, string[]>()
  for (const a of assets) { const g = appleAssetGroup(a.name); if (g) byGroup.set(g, [...(byGroup.get(g) ?? []), a.path]) }
  const appleSizes = await sizes([...byGroup.values()].flat())
  const apple: CleanItem[] = APPLE_ASSETS.filter((a) => byGroup.has(a.id)).map((a) => item(`/System/Library/AssetsV2#${a.id}`, (byGroup.get(a.id) ?? []).reduce((s, p) => s + (appleSizes.get(p) ?? 0), 0), true, false, `${a.text} ${a.how}`, {
    name: a.title, blocked: 'macOS downloads these by itself and protects them: only macOS removes them.', action: { label: 'Open the setting', url: a.url }
  }))
  if (apple.length) add('Apple', 'On-device models for Apple Intelligence, Siri, dictation, voices and translation. macOS protects them, and only macOS can remove them.', apple)

  const out = [...groups.values()].map((g) => ({ ...g, items: g.items.filter((i) => i.size >= BIG_FILE).sort((a, b) => b.size - a.size) })).filter((g) => g.items.length)
  const notes = (await fullDiskAccess()) ? [] : ['Without Full Disk Access, models kept inside apps\' containers (Draw Things, for one) are not measured.']
  return { groups: out, at: Date.now(), notes }
}

// ----- System Data -----

export async function systemReport(): Promise<CleanReport> {
  const fda = await fullDiskAccess()
  const L = (p: string): string => join(home, 'Library', p)
  const notes: string[] = fda ? [] : ['macOS hides device backups, attachments and the Trash from apps without Full Disk Access, so some of these could not be measured.']
  const backups = await list(L('Application Support/MobileSync/Backup'))
  const music = ['/Library/Application Support/GarageBand', '/Library/Application Support/Logic', '/Library/Audio/Apple Loops']
  const sims = ['/Library/Developer/CoreSimulator/Volumes', '/Library/Developer/CoreSimulator/Images', L('Developer/CoreSimulator/Devices')]
  const mail = L('Containers/com.apple.mail/Data/Library/Mail Downloads')
  const messages = L('Messages/Attachments')
  const trash = join(home, '.Trash')
  const sz = await sizes([...backups.map((b) => b.path), ...music, ...sims, mail, messages, trash, L('Caches'), L('Logs')])
  const size = (p: string): number => sz.get(p) ?? 0

  const backupItems: CleanItem[] = []
  for (const b of backups) {
    const info = join(b.path, 'Info.plist')
    const name = (await out('plutil', ['-extract', 'Device Name', 'raw', '-o', '-', info], 5000)).trim()
    const when = (await out('plutil', ['-extract', 'Last Backup Date', 'raw', '-o', '-', info], 5000)).trim()
    backupItems.push(item(b.path, size(b.path), true, false, `Copies Finder made when ${name || 'a device'} was backed up to this Mac${when ? `, last on ${when.slice(0, 10)}` : ''}. A device that backs up to iCloud does not need them.`, { name: name ? `${name} backup` : 'Device backup' }))
  }
  const swap = /used = ([\d.]+)M/.exec(await out('sysctl', ['-n', 'vm.swapusage'], 5000))
  const snapshots = (await out('tmutil', ['listlocalsnapshots', '/'], 10_000)).split('\n').filter((l) => l.includes('com.apple.TimeMachine')).length
  const storageSettings = 'x-apple.systempreferences:com.apple.settings.Storage'

  const groups: CleanGroup[] = [
    {
      id: 'can-go', title: 'What can go', text: 'Moved to the Trash, and can be put back.',
      items: [
        ...(size(mail) ? [item(mail, size(mail), true, true, 'Mail saves a copy of an attachment when you open it. The original stays in the message, and Mail saves it again if you open it again.', { name: 'Mail\'s copies of attachments' })] : []),
        ...backupItems
      ]
    },
    {
      id: 'counted', title: 'Counted beside System Data', text: 'What Storage settings counts beside System Data, each with where it is managed.',
      items: [
        ...(size(messages) ? [item(messages, size(messages), true, false, 'Photos, videos and files from your conversations.', { name: 'Messages attachments', blocked: 'Remove them in Messages, or in Storage settings, so the conversations keep track of what went.', action: { label: 'Storage settings', url: storageSettings } })] : []),
        ...music.filter((m) => size(m)).map((m) => item(m, size(m), true, false, 'Instruments, loops and samples GarageBand and Logic Pro downloaded.', { name: basename(m) === 'Apple Loops' ? 'Apple Loops' : `${basename(m)} sounds`, blocked: 'Remove those you do not use in Storage settings, under Music Creation, or the app asks to download them again.', action: { label: 'Storage settings', url: storageSettings } })),
        ...sims.filter((s) => size(s)).map((s) => item(s, size(s), true, false, s.includes('Devices') ? 'Your simulators and everything installed in them.' : 'The iOS and other system versions Xcode\'s simulators run.', { name: s.includes('Devices') ? 'Simulator devices' : 'Simulator runtimes', blocked: s.includes('Devices') ? 'Delete simulators you no longer use in Xcode, Window, Devices and Simulators.' : 'Remove the versions you no longer test on in Xcode, Settings, Components.' })),
        ...(swap ? [item('swap', parseFloat(swap[1]) * 1_048_576, false, false, 'Memory macOS set aside on the disk to make room. It shrinks by itself as memory frees up.', { name: 'Swap', blocked: 'macOS manages it.' })] : []),
        ...(snapshots ? [item('snapshots', 0, false, false, `${snapshots} local snapshot${snapshots === 1 ? '' : 's'} Time Machine keeps between backups. macOS deletes them by itself when the space is needed, and already counts it as available.`, { name: 'Time Machine snapshots', blocked: 'Counted as available.' })] : []),
        ...(size(trash) ? [item(trash, size(trash), true, false, 'Already removed, still taking space until it is emptied in Finder.', { name: 'The Trash', blocked: 'Empty it in Finder.', action: { label: 'Open the Trash', room: 'trash' } })] : []),
        item(L('Caches'), size(L('Caches')), true, false, 'Caches, logs and app support files: Storage settings counts them as System Data. What of them can go is in Junk Files.', { name: 'Caches', blocked: 'See Junk Files.', action: { label: 'Junk Files', room: 'junk' } })
      ]
    }
  ]
  return { groups: groups.map((g) => ({ ...g, items: g.items.filter((i) => i.size >= BIG_FILE || i.path === 'snapshots') })).filter((g) => g.items.length), at: Date.now(), notes }
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
    items.push(item(f.path, size, f.dir, verdict === 'same' || verdict === 'older', `${what ? `Carries ${what}. ` : ''}${VERDICT_NOTE[verdict]}${have?.version && app?.version ? ` Installed: ${have.version}.` : ''}`, { ...(have ? { action: { label: 'Show the app', reveal: have.path } } : {}) }))
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

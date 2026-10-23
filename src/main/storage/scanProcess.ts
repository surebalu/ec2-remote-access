import { walk, type ScanTree, type WalkOptions } from './scanner'

/**
 * The Storage tool's scan process: an Electron utility process (scanClient.ts forks it, out/main/storageScan.js) that
 * walks the disk and keeps the last scan's tree, answering the rooms' questions about it. Apart from the app, a scan's
 * hundreds of thousands of reads and its tree's memory never touch the main process, which carries every session;
 * the app ends it when the Storage tool has been closed a while, and the memory goes with it.
 * Messages in: { id, op, args }; out: { id, result } or { id, error }, and { event: 'progress', ... } while scanning.
 */

let tree: ScanTree | null = null
let scanning: AbortController | null = null
let comparing: AbortController | null = null
const port = process.parentPort

const need = (): ScanTree => {
  if (!tree) throw new Error('Nothing scanned yet. Scan the Mac, your home folder or a folder first.')
  return tree
}

type Args = Record<string, unknown>
const ops: Record<string, (a: Args) => unknown> = {
  async scan(a) {
    scanning?.abort()
    const ac = new AbortController()
    scanning = ac
    const t = await walk({ ...(a as unknown as WalkOptions), signal: ac.signal, onProgress: (progress) => port.postMessage({ event: 'progress', progress }) })
    if (scanning !== ac) throw new Error('cancelled')
    scanning = null
    tree = t
    const d = t.distribution()
    return { root: t.root, bytes: t.size[0], files: t.files[0], dirs: t.dirs, unreadable: t.unreadable, byKind: d.bytes, kindCounts: d.counts, smallBytes: d.smallBytes, smallFiles: d.smallFiles }
  },
  cancel() { scanning?.abort(); comparing?.abort(); return null },
  view(a) {
    const t = need()
    const id = typeof a.id === 'number' ? a.id : t.find(String(a.path ?? t.root))
    if (id < 0 || id >= t.n) throw new Error('That folder is not in the last scan. Scan again.')
    return t.view(id, Number(a.limit ?? 200))
  },
  largest(a) { return need().largest(Number(a.min), Number(a.limit ?? 300), (a.exclude as string[]) ?? []) },
  search(a) { return need().search(String(a.query ?? ''), Number(a.min ?? 0), Number(a.limit ?? 300), (a.sort as 'size' | 'name' | 'date') ?? 'size') },
  hidden(a) { return need().hidden(Number(a.min ?? 1e6), Number(a.limit ?? 200)) },
  sizes(a) { return need().sizes(a.paths as string[]) },
  named(a) { return need().named(a.names as string[], Number(a.min ?? 0)) },
  remove(a) { const t = tree; return t ? (a.paths as string[]).map((p) => t.remove(p)) : [] },
  async duplicates(a) {
    const t = need()
    comparing?.abort()
    const ac = new AbortController()
    comparing = ac
    let last = 0
    const groups = await t.duplicates((a.exclude as string[]) ?? [], (done, total, phase) => {
      const now = Date.now()
      if (now - last < 250 && done < total) return
      last = now
      port.postMessage({ event: 'duplicates', done, total, phase })
    }, ac.signal)
    if (comparing === ac) comparing = null
    return groups
  },
  nest(a) {
    const t = need()
    const id = typeof a.id === 'number' ? a.id : t.find(String(a.path ?? t.root))
    if (id < 0 || id >= t.n) throw new Error('That folder is not in the last scan. Scan again.')
    return { node: t.nest(id, (a.per as number[]) ?? [14, 10, 6], !!a.dirsOnly), chain: t.view(id, 0, 0).chain }
  },
  appsNest(a) { return need().appsNest(Number(a.limit ?? 24), (a.per as number[]) ?? [6, 4]) },
  kinds(a) { return need().kinds(Number(a.perKind ?? 8)) },
  topFolders(a) { return need().topFolders(Number(a.limit ?? 5), (a.exclude as string[]) ?? []) },
  largestFolders(a) { return need().largestFolders(Number(a.limit ?? 8)) },
  recentLarge(a) { return need().recentLarge(Number(a.min ?? 100e6), Number(a.limit ?? 8)) },
  snapshot(a) { return need().snapshot(Number(a.min ?? 50e6)) },
  has() { return tree ? { root: tree.root } : null }
}

port.on('message', (e) => {
  const { id, op, args } = e.data as { id: number; op: string; args?: Args }
  const fn = ops[op]
  Promise.resolve()
    .then(() => {
      if (!fn) throw new Error(`Unknown request: ${op}`)
      return fn(args ?? {})
    })
    .then((result) => port.postMessage({ id, result }), (err: unknown) => port.postMessage({ id, error: (err as Error)?.message ?? String(err) }))
})

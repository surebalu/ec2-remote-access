import { lstat, open, opendir } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { createHash } from 'node:crypto'
import { BIG_FILE, kindOf, isPackageName, packageKind, type FileKind, type KindGroup, type MapNode, type MapView, type NestNode, type ScanProgress } from '../../shared/storage.ts'

/**
 * The Storage tool's disk scan: walks a folder (or the whole disk) and keeps every folder, and every file of 1 MB or
 * more, by name; smaller files are only counted into their folder, which keeps a scan of millions of files to a few
 * hundred thousand entries. Sizes are bytes allocated on disk, as Finder reports them, with hard links counted once.
 * Entries live in typed arrays indexed by number (a parent always comes before its children), so the tree costs tens
 * of bytes an entry rather than an object each. Runs in the scan process (scanProcess.ts); Node only, so
 * tests/storageScan.test.ts runs it on a temporary folder.
 */

export const F = {
  DIR: 1, PACKAGE: 2, HIDDEN: 4, IN_PACKAGE: 8, IN_HIDDEN: 16, UNREADABLE: 32, CLOUD: 64, PROTECTED: 128, TIMEOUT: 256, MOUNT: 512,
  /** Moved to the Trash since the scan (it and everything beneath it). */
  REMOVED: 1024
} as const

export interface WalkOptions {
  root: string
  /** Whole subtrees left out, not even listed (another view of the same folders, other drives). */
  skip?: string[]
  /** Devices the walk may enter besides the root's own (APFS firmlinks put the Data volume's folders under '/'). */
  devices?: number[]
  /** Folders listed with their contents not counted: cloud folders (reading them would download) and protected ones. */
  closed?: { path: string; reason: 'cloud' | 'protected' }[]
  /** A folder that has not answered in this long is left out (a network share gone quiet). */
  timeoutMs?: number
  concurrency?: number
  signal?: AbortSignal
  onProgress?: (p: ScanProgress) => void
}

const blocks = (st: Stats): number => (st.blocks ?? 0) * 512

export class ScanTree {
  n = 0
  parent = new Int32Array(0)
  /** Own bytes while walking; bytes beneath (itself included) once finished. */
  size = new Float64Array(0)
  /** A file's length (st.size): what duplicates compare. */
  length = new Float64Array(0)
  files = new Uint32Array(0)
  mtime = new Float64Array(0)
  flags = new Uint16Array(0)
  names: string[] = []
  childStart = new Int32Array(0)
  childCount = new Int32Array(0)
  childList = new Int32Array(0)
  unreadable = 0
  dirs = 0

  readonly root: string
  constructor(root: string) { this.root = root; this.grow(4096) }

  private grow(cap: number): void {
    const g = <A extends Int32Array | Float64Array | Uint32Array | Uint16Array>(a: A, C: new (n: number) => A): A => { const b = new C(cap); b.set(a.subarray(0, this.n)); return b }
    this.parent = g(this.parent, Int32Array)
    this.size = g(this.size, Float64Array)
    this.length = g(this.length, Float64Array)
    this.files = g(this.files, Uint32Array)
    this.mtime = g(this.mtime, Float64Array)
    this.flags = g(this.flags, Uint16Array)
  }

  add(parent: number, name: string, flags: number, size: number, mtime: number, length: number, files: number): number {
    if (this.n === this.parent.length) this.grow(this.n * 2)
    const i = this.n++
    this.parent[i] = parent
    this.size[i] = size
    this.length[i] = length
    this.files[i] = files
    this.mtime[i] = mtime
    this.flags[i] = flags
    this.names.push(name)
    return i
  }

  /** Adds each entry's bytes and files to its folders, and lists every folder's children, largest first. */
  finish(): void {
    const { n, parent, size, files } = this
    for (let i = n - 1; i > 0; i--) { size[parent[i]] += size[i]; files[parent[i]] += files[i] }
    const count = new Int32Array(n)
    for (let i = 1; i < n; i++) count[parent[i]]++
    const start = new Int32Array(n)
    for (let i = 1, acc = count[0]; i < n; i++) { start[i] = acc; acc += count[i] }
    const fill = new Int32Array(n)
    const list = new Int32Array(Math.max(0, n - 1))
    for (let i = 1; i < n; i++) { const p = parent[i]; list[start[p] + fill[p]++] = i }
    for (let p = 0; p < n; p++) {
      if (count[p] < 2) continue
      const part = Array.from(list.subarray(start[p], start[p] + count[p])).sort((a, b) => size[b] - size[a])
      list.set(part, start[p])
    }
    this.childStart = start
    this.childCount = count
    this.childList = list
  }

  /** A folder's children, largest first (as they were when the scan finished). */
  children(i: number): Int32Array {
    const all = this.childList.subarray(this.childStart[i], this.childStart[i] + this.childCount[i])
    return this.removed ? all.filter((c) => !(this.flags[c] & F.REMOVED)) : all
  }

  /** Whether anything has been taken out since the scan (then children() filters). */
  private removed = false

  /**
   * Takes an entry out after it went to the Trash: its folders lose its bytes and files, and it and everything beneath
   * it are left out of every list from now on. Returns whether the scan had it.
   */
  remove(path: string): boolean {
    const i = this.find(path)
    if (i <= 0) return false
    const size = this.size[i]
    const files = this.files[i]
    for (let j = this.parent[i]; j >= 0; j = this.parent[j]) { this.size[j] -= size; this.files[j] -= files }
    this.removed = true
    const stack = [i]
    while (stack.length) {
      const k = stack.pop()!
      this.flags[k] |= F.REMOVED
      for (const c of this.childList.subarray(this.childStart[k], this.childStart[k] + this.childCount[k])) stack.push(c)
    }
    return true
  }

  pathOf(i: number): string {
    const parts: string[] = []
    for (let j = i; j > 0; j = this.parent[j]) parts.push(this.names[j])
    if (!parts.length) return this.root
    parts.reverse()
    return this.root === '/' ? `/${parts.join('/')}` : `${this.root}/${parts.join('/')}`
  }

  /** The entry at a path inside the scan, or -1. */
  find(path: string): number {
    const p = path.replace(/\/+$/, '') || '/'
    if (p === this.root) return 0
    const prefix = this.root === '/' ? '/' : `${this.root}/`
    if (!p.startsWith(prefix)) return -1
    let at = 0
    for (const part of p.slice(prefix.length).split('/')) {
      const kids = this.children(at)
      let next = -1
      for (let k = 0; k < kids.length; k++) if (this.names[kids[k]] === part) { next = kids[k]; break }
      if (next < 0) return -1
      at = next
    }
    return at
  }

  node(i: number): MapNode {
    const f = this.flags[i]
    const dir = !!(f & F.DIR)
    const closed = f & F.UNREADABLE ? 'unreadable' : f & F.CLOUD ? 'cloud' : f & F.PROTECTED ? 'protected' : f & F.TIMEOUT ? 'timeout' : f & F.MOUNT ? 'mount' : undefined
    const name = i === 0 ? this.root : this.names[i]
    return {
      id: i, name, path: this.pathOf(i), size: this.size[i], files: this.files[i], dir,
      ...(f & F.PACKAGE ? { package: true } : {}),
      ...(dir && this.childCount[i] > 0 ? { more: true } : {}),
      ...(closed ? { closed } : {}),
      ...(!dir ? { mtime: this.mtime[i], kind: kindOf(name) } : f & F.PACKAGE ? { kind: kindOf(name, true) } : {})
    }
  }

  /** A folder's view for the Space Map: its largest children, what its small files add up to, and the way up. */
  view(i: number, limit = 200, inner = 10): MapView {
    const kids = this.children(i)
    const shown = Array.from(kids).sort((a, b) => this.size[b] - this.size[a]).slice(0, limit)
    let childBytes = 0
    let childFiles = 0
    for (let k = 0; k < kids.length; k++) { childBytes += this.size[kids[k]]; childFiles += this.files[kids[k]] }
    const chain: { id: number; name: string }[] = []
    for (let j = this.parent[i]; j >= 0; j = this.parent[j]) chain.unshift({ id: j, name: j === 0 ? this.root : this.names[j] })
    const innerMap: MapView['inner'] = {}
    if (inner > 0) {
      for (const c of shown) {
        if (!(this.flags[c] & F.DIR) || this.childCount[c] < 2) continue
        innerMap[c] = Array.from(this.children(c).subarray(0, inner)).map((g) => ({ size: this.size[g], dir: !!(this.flags[g] & F.DIR), ...(this.flags[g] & F.DIR ? {} : { kind: kindOf(this.names[g]) }) }))
      }
    }
    return {
      node: this.node(i),
      chain,
      children: shown.map((c) => this.node(c)),
      small: { bytes: Math.max(0, this.size[i] - childBytes), files: Math.max(0, this.files[i] - childFiles) },
      inner: innerMap
    }
  }

  /** Bytes and files directly in a folder that the scan counted without names (files under 1 MB). */
  private own(i: number): { bytes: number; files: number } {
    let bytes = this.size[i]
    let files = this.files[i]
    for (const c of this.children(i)) { bytes -= this.size[c]; files -= this.files[c] }
    return { bytes: Math.max(0, bytes), files: Math.max(0, files) }
  }

  /**
   * Every byte of the scan by kind: files of 1 MB or more by their extension, packages as one item by theirs (Photos'
   * library is pictures, an app is an app), and what small files add up to in their folders. The parts sum to the scan.
   */
  distribution(): { bytes: Partial<Record<FileKind, number>>; counts: Partial<Record<FileKind, number>>; smallBytes: number; smallFiles: number } {
    const bytes: Partial<Record<FileKind, number>> = {}
    const counts: Partial<Record<FileKind, number>> = {}
    let smallBytes = 0
    let smallFiles = 0
    for (let i = 0; i < this.n; i++) {
      const f = this.flags[i]
      if (f & (F.IN_PACKAGE | F.REMOVED)) continue
      if (f & F.PACKAGE || !(f & F.DIR)) {
        const k = f & F.PACKAGE ? packageKind(this.names[i]) : kindOf(this.names[i])
        bytes[k] = (bytes[k] ?? 0) + this.size[i]
        counts[k] = (counts[k] ?? 0) + 1
        continue
      }
      const o = this.own(i)
      smallBytes += o.bytes
      smallFiles += o.files
    }
    return { bytes, counts, smallBytes, smallFiles }
  }

  /** Entries directly inside a folder: the named ones and the small files counted together. */
  private itemsOf(i: number): number {
    if (!(this.flags[i] & F.DIR)) return 1
    return this.children(i).length + this.own(i).files
  }

  private nestNode(i: number): NestNode {
    const n = this.node(i)
    return { id: i, name: n.name, path: n.path, size: n.size, items: this.itemsOf(i), dir: n.dir, ...(n.package ? { package: true } : {}), ...(n.kind ? { kind: n.kind } : {}), ...(n.more ? { more: true } : {}), ...(n.closed ? { closed: n.closed } : {}) }
  }

  /**
   * A folder nested for the Space Map's cards: its largest children, theirs, and theirs again (`per` says how many at
   * each level), with the rest summed up. A folder whose only entry is one folder (an app's Contents) shows that one's
   * children instead. `dirsOnly` leaves files out (the Folders view).
   */
  nest(i: number, per: number[], dirsOnly = false): NestNode {
    const node = this.nestNode(i)
    if (!per.length || !node.dir || node.closed) return node
    let at = i
    for (let guard = 0; guard < 4; guard++) {
      const kids = this.children(at)
      if (kids.length !== 1 || !(this.flags[kids[0]] & F.DIR) || this.own(at).bytes > this.size[at] * 0.02) break
      at = kids[0]
    }
    const kids = Array.from(this.children(at)).filter((c) => !dirsOnly || this.flags[c] & F.DIR).sort((a, b) => this.size[b] - this.size[a])
    const shown = kids.slice(0, per[0]).filter((c) => this.size[c] > 0)
    const restIds = kids.slice(shown.length)
    const own = this.own(at)
    const restSize = restIds.reduce((s, c) => s + this.size[c], 0) + own.bytes
    node.children = shown.map((c) => this.nest(c, per.slice(1), dirsOnly))
    if (restSize > 0) node.rest = { count: restIds.length + own.files, size: restSize }
    return node
  }

  /** The apps in the scan (outside other packages), largest first, each nested two levels; the rest summed up. */
  appsNest(limit: number, per: number[]): { apps: NestNode[]; rest: { count: number; size: number }; total: number; count: number } {
    const all: number[] = []
    for (let i = 1; i < this.n; i++) {
      const f = this.flags[i]
      if (f & F.PACKAGE && !(f & (F.IN_PACKAGE | F.REMOVED)) && this.names[i].toLowerCase().endsWith('.app')) all.push(i)
    }
    all.sort((a, b) => this.size[b] - this.size[a])
    const shown = all.slice(0, limit)
    const rest = all.slice(limit)
    return {
      apps: shown.map((i) => this.nest(i, per)),
      rest: { count: rest.length, size: rest.reduce((s, i) => s + this.size[i], 0) },
      total: all.reduce((s, i) => s + this.size[i], 0),
      count: all.length
    }
  }

  /** Each kind of file with its largest files and packages (a package nested one level), and the small files. */
  kinds(perKind: number): KindGroup[] {
    const by = new Map<FileKind, number[]>()
    for (let i = 1; i < this.n; i++) {
      const f = this.flags[i]
      if (f & (F.IN_PACKAGE | F.REMOVED) || (f & F.DIR && !(f & F.PACKAGE))) continue
      const k = f & F.PACKAGE ? packageKind(this.names[i]) : kindOf(this.names[i])
      const l = by.get(k)
      if (l) l.push(i)
      else by.set(k, [i])
    }
    const d = this.distribution()
    const groups: KindGroup[] = [...by.entries()].map(([kind, ids]) => {
      ids.sort((a, b) => this.size[b] - this.size[a])
      return { kind, size: d.bytes[kind] ?? 0, count: ids.length, top: ids.slice(0, perKind).map((i) => (this.flags[i] & F.PACKAGE ? this.nest(i, [4]) : this.nestNode(i))) }
    })
    groups.push({ kind: 'small', size: d.smallBytes, count: d.smallFiles, top: [] })
    return groups.sort((a, b) => b.size - a.size)
  }

  /**
   * The largest folders that say where the space went: never a container like the home folder or a Library (`exclude`),
   * and never one inside another already listed (Documents, not Documents and the project folder inside it).
   */
  topFolders(limit: number, exclude: string[]): MapNode[] {
    const cands: number[] = []
    for (let i = 1; i < this.n; i++) {
      const f = this.flags[i]
      if (f & F.DIR && !(f & (F.PACKAGE | F.IN_PACKAGE | F.REMOVED))) cands.push(i)
    }
    cands.sort((a, b) => this.size[b] - this.size[a])
    const skip = new Set(exclude)
    const picked: string[] = []
    const out: MapNode[] = []
    for (const i of cands.slice(0, 4000)) {
      const p = this.pathOf(i)
      if (skip.has(p) || picked.some((q) => p.startsWith(`${q}/`) || q.startsWith(`${p}/`))) continue
      picked.push(p)
      out.push(this.node(i))
      if (out.length >= limit) break
    }
    return out
  }

  /** Folders by size, containers included (the Report's list), outside packages. */
  largestFolders(limit: number): MapNode[] {
    const cands: number[] = []
    for (let i = 1; i < this.n; i++) {
      const f = this.flags[i]
      if (f & F.DIR && !(f & (F.PACKAGE | F.IN_PACKAGE | F.REMOVED))) cands.push(i)
    }
    return cands.sort((a, b) => this.size[b] - this.size[a]).slice(0, limit).map((i) => this.node(i))
  }

  /** Files of `min` bytes or more, newest first (outside packages). */
  recentLarge(min: number, limit: number): MapNode[] {
    const hits: number[] = []
    for (let i = 1; i < this.n; i++) {
      const f = this.flags[i]
      if (!(f & (F.DIR | F.IN_PACKAGE | F.REMOVED)) && this.size[i] >= min) hits.push(i)
    }
    return hits.sort((a, b) => this.mtime[b] - this.mtime[a]).slice(0, limit).map((i) => this.node(i))
  }

  /** Every folder of `min` bytes or more with its size, for comparing this scan with a later one. */
  snapshot(min: number): [string, number][] {
    const out: [string, number][] = []
    for (let i = 0; i < this.n; i++) {
      const f = this.flags[i]
      if (f & F.DIR && !(f & (F.IN_PACKAGE | F.REMOVED)) && this.size[i] >= min) out.push([this.pathOf(i), this.size[i]])
    }
    return out
  }

  /** Whether an entry's path starts with any of these folders. */
  private under(i: number, prefixes: string[]): boolean {
    if (!prefixes.length) return false
    const p = this.pathOf(i)
    return prefixes.some((x) => p === x || p.startsWith(`${x}/`))
  }

  /** Files of `min` bytes or more, largest first, leaving out those inside packages and under `exclude`. */
  largest(min: number, limit: number, exclude: string[] = []): MapNode[] {
    const hits: number[] = []
    for (let i = 1; i < this.n; i++) {
      const f = this.flags[i]
      if (f & (F.DIR | F.IN_PACKAGE | F.REMOVED) || this.size[i] < min) continue
      hits.push(i)
    }
    hits.sort((a, b) => this.size[b] - this.size[a])
    const out: MapNode[] = []
    for (const i of hits) {
      if (this.under(i, exclude)) continue
      out.push(this.node(i))
      if (out.length >= limit) break
    }
    return out
  }

  /**
   * Folders and named files whose name holds `query`, of `min` bytes or more, outside packages; largest first, by
   * name, or newest first. A query made only of extensions ('.mp4 .mov') and quoted names ('"node_modules"') matches
   * any of them; anything else is one piece of text the name must hold.
   */
  search(query: string, min: number, limit: number, sort: 'size' | 'name' | 'date' = 'size'): MapNode[] {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const tokens = q.split(/\s+/)
    const listed = tokens.every((t) => /^\.[a-z0-9]+$/.test(t) || /^".+"$/.test(t))
    const exts = listed ? tokens.filter((t) => t.startsWith('.')) : []
    const exact = new Set(listed ? tokens.filter((t) => t.startsWith('"')).map((t) => t.slice(1, -1)) : [])
    const hits: number[] = []
    for (let i = 1; i < this.n; i++) {
      if (this.flags[i] & (F.IN_PACKAGE | F.REMOVED) || this.size[i] < min) continue
      const name = this.names[i].toLowerCase()
      if (listed ? exact.has(name) || exts.some((e) => name.endsWith(e)) : name.includes(q)) hits.push(i)
    }
    if (sort === 'name') hits.sort((a, b) => this.names[a].localeCompare(this.names[b]))
    else if (sort === 'date') hits.sort((a, b) => this.mtime[b] - this.mtime[a])
    else hits.sort((a, b) => this.size[b] - this.size[a])
    return hits.slice(0, limit).map((i) => this.node(i))
  }

  /** The outermost hidden items (name starting with a dot) of `min` bytes or more, outside packages; largest first. */
  hidden(min: number, limit: number): MapNode[] {
    const hits: number[] = []
    for (let i = 1; i < this.n; i++) {
      const f = this.flags[i]
      if (f & F.HIDDEN && !(f & (F.IN_HIDDEN | F.IN_PACKAGE | F.REMOVED)) && this.size[i] >= min) hits.push(i)
    }
    return hits.sort((a, b) => this.size[b] - this.size[a]).slice(0, limit).map((i) => this.node(i))
  }

  /** Bytes beneath each path (null when the scan does not have it). */
  sizes(paths: string[]): (number | null)[] {
    return paths.map((p) => { const i = this.find(p); return i < 0 ? null : this.size[i] })
  }

  /**
   * Files with identical contents: grouped by length, then by a hash of their first and last 64 KB, then read in full
   * only if they still match. Leaves out packages, hidden folders and `exclude`. Each group's first file is the one to
   * keep: the oldest, then the shortest path.
   */
  async duplicates(exclude: string[], onProgress?: (done: number, total: number, phase: string) => void, signal?: AbortSignal): Promise<{ length: number; files: MapNode[] }[]> {
    const byLength = new Map<number, number[]>()
    for (let i = 1; i < this.n; i++) {
      const f = this.flags[i]
      if (f & (F.DIR | F.IN_PACKAGE | F.HIDDEN | F.IN_HIDDEN | F.REMOVED) || this.length[i] < BIG_FILE) continue
      const list = byLength.get(this.length[i])
      if (list) list.push(i)
      else byLength.set(this.length[i], [i])
    }
    let groups = [...byLength.values()].filter((g) => g.length > 1).map((g) => g.filter((i) => !this.under(i, exclude))).filter((g) => g.length > 1)
    const split = async (phase: string, hashOf: (path: string, length: number) => Promise<string | null>): Promise<void> => {
      const total = groups.reduce((s, g) => s + g.length, 0)
      let done = 0
      const next: number[][] = []
      for (const g of groups) {
        const by = new Map<string, number[]>()
        for (const i of g) {
          if (signal?.aborted) throw new Error('cancelled')
          const h = await hashOf(this.pathOf(i), this.length[i])
          done++
          onProgress?.(done, total, phase)
          if (!h) continue
          const l = by.get(h)
          if (l) l.push(i)
          else by.set(h, [i])
        }
        for (const l of by.values()) if (l.length > 1) next.push(l)
      }
      groups = next
    }
    await split('Comparing the start and end of each file', sampleHash)
    await split('Reading the files that might match, in full', fullHash)
    return groups
      .map((g) => g.sort((a, b) => this.mtime[a] - this.mtime[b] || this.pathOf(a).length - this.pathOf(b).length))
      .map((g) => ({ length: this.length[g[0]], files: g.map((i) => this.node(i)) }))
      .sort((a, b) => b.length * (b.files.length - 1) - a.length * (a.files.length - 1))
  }

  /** Folders with one of these names, not inside another of the same name (node_modules inside node_modules). */
  named(names: string[], min: number): MapNode[] {
    const want = new Set(names)
    const out: MapNode[] = []
    for (let i = 1; i < this.n; i++) {
      if (!(this.flags[i] & F.DIR) || this.flags[i] & F.REMOVED || !want.has(this.names[i]) || this.size[i] < min) continue
      let nested = false
      for (let j = this.parent[i]; j > 0; j = this.parent[j]) if (this.names[j] === this.names[i]) { nested = true; break }
      if (!nested) out.push(this.node(i))
    }
    return out.sort((a, b) => b.size - a.size)
  }
}

async function sampleHash(path: string, length: number): Promise<string | null> {
  let fh
  try {
    fh = await open(path, 'r')
    const n = Math.min(65536, length)
    const head = Buffer.alloc(n)
    await fh.read(head, 0, n, 0)
    const tail = Buffer.alloc(n)
    await fh.read(tail, 0, n, Math.max(0, length - n))
    return createHash('sha1').update(head).update(tail).digest('hex')
  } catch { return null } finally { await fh?.close() }
}

async function fullHash(path: string): Promise<string | null> {
  let fh
  try {
    fh = await open(path, 'r')
    const hash = createHash('sha256')
    const buf = Buffer.alloc(1 << 20)
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null)
      if (!bytesRead) break
      hash.update(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead))
    }
    return hash.digest('hex')
  } catch { return null } finally { await fh?.close() }
}

const errCode = (e: unknown): string => (e as NodeJS.ErrnoException)?.code ?? ''

/** Walks `opts.root` into a finished ScanTree. Rejects with 'cancelled' when the signal fires. */
export async function walk(opts: WalkOptions): Promise<ScanTree> {
  const root = opts.root.replace(/\/+$/, '') || '/'
  const rootSt = await lstat(root)
  if (!rootSt.isDirectory()) throw new Error(`${root} is a file, not a folder.`)
  const tree = new ScanTree(root)
  tree.add(-1, root, F.DIR, blocks(rootSt), rootSt.mtimeMs, 0, 0)
  tree.dirs = 1
  const devices = new Set([rootSt.dev, ...(opts.devices ?? [])])
  const skip = new Set(opts.skip ?? [])
  const closed = new Map((opts.closed ?? []).map((c) => [c.path, c.reason]))
  const links = new Set<string>()
  const timeoutMs = opts.timeoutMs ?? 15_000
  const concurrency = opts.concurrency ?? 12
  let files = 0
  let bytes = blocks(rootSt)
  let lastPath = root
  let lastReport = 0
  const report = (force = false): void => {
    const now = Date.now()
    if (!opts.onProgress || (!force && now - lastReport < 250)) return
    lastReport = now
    opts.onProgress({ dirs: tree.dirs, files, bytes, path: lastPath })
  }

  /** Reads one folder's entries and their sizes. */
  const readDir = async (path: string): Promise<{ entries: { name: string; full: string }[]; stats: (Stats | null)[] }> => {
    const entries: { name: string; full: string }[] = []
    const dir = await opendir(path, { bufferSize: 256 })
    for await (const d of dir) {
      const full = path === '/' ? `/${d.name}` : `${path}/${d.name}`
      if (!skip.has(full)) entries.push({ name: d.name, full })
    }
    const stats: (Stats | null)[] = new Array(entries.length)
    for (let k = 0; k < entries.length; k += 64) {
      await Promise.all(entries.slice(k, k + 64).map((e, j) => lstat(e.full).then((st) => { stats[k + j] = st }, () => { stats[k + j] = null })))
    }
    return { entries, stats }
  }

  /** Adds a folder's entries: its files of 1 MB or more by name, the rest into its total, its folders to the queue. */
  const addEntries = (idx: number, entries: { name: string; full: string }[], stats: (Stats | null)[], queue: { idx: number; path: string }[]): void => {
    const pf = tree.flags[idx]
    const inherited = (pf & (F.PACKAGE | F.IN_PACKAGE) ? F.IN_PACKAGE : 0) | (pf & (F.HIDDEN | F.IN_HIDDEN) ? F.IN_HIDDEN : 0)
    for (let k = 0; k < entries.length; k++) {
      const st = stats[k]
      if (!st) continue
      const { name, full } = entries[k]
      const hidden = name.charCodeAt(0) === 46 ? F.HIDDEN : 0
      if (st.isDirectory()) {
        const pkg = isPackageName(name) ? F.PACKAGE : 0
        const reason = closed.get(full)
        if (reason || !devices.has(st.dev)) {
          tree.add(idx, name, F.DIR | pkg | hidden | inherited | (reason === 'cloud' ? F.CLOUD : reason === 'protected' ? F.PROTECTED : F.MOUNT), 0, st.mtimeMs, 0, 0)
          continue
        }
        const child = tree.add(idx, name, F.DIR | pkg | hidden | inherited, blocks(st), st.mtimeMs, 0, 0)
        tree.dirs++
        bytes += blocks(st)
        queue.push({ idx: child, path: full })
        continue
      }
      let b = blocks(st)
      if (st.nlink > 1 && st.isFile()) {
        const key = `${st.dev}:${st.ino}`
        if (links.has(key)) b = 0
        else links.add(key)
      }
      files++
      bytes += b
      if (b >= BIG_FILE) {
        tree.add(idx, name, hidden | inherited, b, st.mtimeMs, st.size, 1)
      } else {
        tree.size[idx] += b
        tree.files[idx] += 1
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    // Depth first, so the queue stays as deep as the disk rather than as wide as its widest level.
    const queue: { idx: number; path: string }[] = [{ idx: 0, path: root }]
    let active = 0
    let finished = false
    const end = (err?: Error): void => {
      if (finished) return
      finished = true
      if (err) reject(err)
      else resolve()
    }
    const pump = (): void => {
      if (finished) return
      if (opts.signal?.aborted) return end(new Error('cancelled'))
      while (active < concurrency && queue.length) {
        const job = queue.pop()!
        active++
        lastPath = job.path
        // A folder that answers after it timed out is dropped: the walk has moved on without it.
        let settled = false
        const settle = (): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          active--
          report()
          if (!queue.length && !active) end()
          else pump()
        }
        const timer = setTimeout(() => { tree.flags[job.idx] |= F.TIMEOUT; tree.unreadable++; settle() }, timeoutMs)
        readDir(job.path).then(({ entries, stats }) => {
          if (settled || finished) return
          addEntries(job.idx, entries, stats, queue)
          settle()
        }, (e: unknown) => {
          if (settled || finished) return
          if (errCode(e) !== 'ENOENT') { tree.flags[job.idx] |= F.UNREADABLE; tree.unreadable++ }
          settle()
        })
      }
    }
    pump()
  })
  report(true)
  tree.finish()
  return tree
}

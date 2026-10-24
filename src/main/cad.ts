/**
 * The CAD tool's files (channels cad:*; Mac app only, the gateway refuses them): a model file's bytes with its SHA-256
 * (the review's key), the Open dialog, and a cache of what the tool made of each file. Tessellating a large STEP
 * assembly takes a while, so the renderer saves the meshes it built as a GLB here, by the source's SHA-256, and opens
 * that next time. The cache is trimmed to the newest CACHE_FILES files and CACHE_BYTES in all.
 */
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { CAD_EXTENSIONS, cadFormat, type CadFormat } from '@shared/cad'
import { host } from './host'

/** Larger than any part or assembly people open by hand; the WebAssembly reader would run out of memory first. */
const MAX_BYTES = 1.5 * 1024 ** 3
const CACHE_FILES = 80
const CACHE_BYTES = 3 * 1024 ** 3

export interface CadFile {
  name: string
  path: string
  size: number
  mtime: number
  sha256: string
  format: CadFormat
  bytes: Uint8Array
}

export async function cadRead(path: string): Promise<CadFile> {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Not a file path.')
  const format = cadFormat(path)
  if (!format) throw new Error(`${basename(path)} is not a CAD file the viewer reads (STEP, IGES, B-rep, STL, glTF, OBJ, 3MF).`)
  const st = await stat(path).catch(() => null)
  if (!st?.isFile()) throw new Error(`${basename(path)} is no longer there.`)
  if (st.size > MAX_BYTES) throw new Error(`${basename(path)} is ${(st.size / 1024 ** 3).toFixed(1)} GB, more than the viewer can open.`)
  const bytes = await readFile(path)
  return { name: basename(path), path, size: st.size, mtime: st.mtimeMs, sha256: createHash('sha256').update(bytes).digest('hex'), format, bytes }
}

export async function cadPick(): Promise<string | null> {
  return (await host().pickPaths({ title: 'Open a CAD file', kind: 'file', buttonLabel: 'Open', extensions: CAD_EXTENSIONS }))?.[0] ?? null
}

const cacheDir = (): string => join(host().userDataDir(), 'cad-cache')
const isSha = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s)

export async function cadCacheGet(sha: string): Promise<Uint8Array | null> {
  if (!isSha(sha)) return null
  const file = join(cacheDir(), `${sha}.glb`)
  try {
    const bytes = await readFile(file)
    // Used now: the trim keeps it.
    const now = new Date()
    await utimes(file, now, now).catch(() => undefined)
    return bytes
  } catch {
    return null
  }
}

export async function cadCachePut(sha: string, bytes: Uint8Array): Promise<void> {
  if (!isSha(sha) || !(bytes instanceof Uint8Array) || bytes.byteLength > MAX_BYTES) return
  const dir = cacheDir()
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `.${sha}.${process.pid}.tmp`)
  await writeFile(tmp, bytes)
  await rename(tmp, join(dir, `${sha}.glb`))
  await trimCache(dir)
}

async function trimCache(dir: string): Promise<void> {
  const files = await Promise.all((await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.glb')).map(async (n) => {
    const st = await stat(join(dir, n)).catch(() => null)
    return st ? { path: join(dir, n), size: st.size, at: st.mtimeMs } : null
  }))
  const list = files.filter((f): f is { path: string; size: number; at: number } => !!f).sort((a, b) => b.at - a.at)
  let total = 0
  for (const [i, f] of list.entries()) {
    total += f.size
    if (i >= CACHE_FILES || total > CACHE_BYTES) await rm(f.path, { force: true })
  }
}

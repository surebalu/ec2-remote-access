import { isMobile } from '../../mobile'

/**
 * Where a file comes from and where what OpenCascade made is kept. The Mac app reads files by path (cad:read, so
 * the lists can reopen them) and caches in main (cad:cacheGet/Put, <userData>/cad-cache). Anywhere else (the
 * iPhone and iPad app, a browser on the gateway) the file is picked on the device and read in the page: the
 * gateway refuses cad:*, which would read the computer's files, and the cache is this device's IndexedDB.
 */
export const ON_MAC = /\bElectron\//.test(navigator.userAgent) && !isMobile()

const DB = 'cad-cache'
const STORE = 'glb'
/** A phone's storage is smaller than a Mac's: a dozen models, 600 MB at most. */
const KEEP = 12
const KEEP_BYTES = 600 * 1024 * 1024

interface Entry { sha: string; glb: ArrayBuffer; size: number; at: number }

let db: Promise<IDBDatabase | null> | null = null
function open(version?: number): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, version)
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'sha' }) }
      req.onsuccess = () => {
        const d = req.result
        if (d.objectStoreNames.contains(STORE)) { resolve(d); return }
        // A database by this name without the store (made by something else first): one version up adds it.
        const next = d.version + 1
        d.close()
        if (version) resolve(null)
        else void open(next).then(resolve)
      }
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}
const database = (): Promise<IDBDatabase | null> => (db ??= open())

const done = <T,>(req: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error) })

export async function cacheGet(sha: string): Promise<Uint8Array | null> {
  if (ON_MAC) return window.api.invoke('cad:cacheGet', sha).catch(() => null)
  try {
    const d = await database()
    if (!d) return null
    const e = await done(d.transaction(STORE).objectStore(STORE).get(sha)) as Entry | undefined
    if (!e) return null
    // Touched, so the models opened most recently are the ones kept.
    void done(d.transaction(STORE, 'readwrite').objectStore(STORE).put({ ...e, at: Date.now() })).catch(() => undefined)
    return new Uint8Array(e.glb)
  } catch {
    return null
  }
}

export async function cachePut(sha: string, glb: Uint8Array): Promise<void> {
  if (ON_MAC) { await window.api.invoke('cad:cachePut', sha, glb); return }
  try {
    const d = await database()
    if (!d) return
    const bytes = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer
    await done(d.transaction(STORE, 'readwrite').objectStore(STORE).put({ sha, glb: bytes, size: bytes.byteLength, at: Date.now() } satisfies Entry))
    const all = (await done(d.transaction(STORE).objectStore(STORE).getAll())) as Entry[]
    all.sort((a, b) => b.at - a.at)
    let total = 0
    const drop = all.filter((e, i) => { total += e.size; return i >= KEEP || total > KEEP_BYTES })
    if (drop.length) {
      const store = d.transaction(STORE, 'readwrite').objectStore(STORE)
      for (const e of drop) store.delete(e.sha)
    }
  } catch { /* full or private: the model is read again next time */ }
}

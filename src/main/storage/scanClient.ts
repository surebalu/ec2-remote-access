import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import type { StorageHost } from '../host'

/**
 * The Mac app's side of the Storage tool's scan process (scanProcess.ts): forked on first use, asked questions by id,
 * its progress handed to `onEvent`. Electron only (utilityProcess), so it is reached through host().storage.
 */

let proc: UtilityProcess | null = null
let seq = 0
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
let listener: ((e: { event: string } & Record<string, unknown>) => void) | null = null

function ensure(): UtilityProcess {
  if (proc) return proc
  // A wider thread pool than Node's 4: the walk keeps many reads in flight, and this process does nothing else.
  const p = utilityProcess.fork(join(__dirname, 'storageScan.js'), [], { serviceName: 'Storage scan', env: { ...process.env, UV_THREADPOOL_SIZE: '16' } })
  p.on('message', (m: { id?: number; result?: unknown; error?: string; event?: string }) => {
    if (m.event) { listener?.(m as { event: string }); return }
    const w = m.id === undefined ? undefined : waiting.get(m.id)
    if (!w) return
    waiting.delete(m.id!)
    if (m.error) w.reject(new Error(m.error))
    else w.resolve(m.result)
  })
  p.on('exit', () => {
    if (proc === p) proc = null
    for (const w of waiting.values()) w.reject(new Error('The scan stopped. Scan again.'))
    waiting.clear()
  })
  proc = p
  return p
}

export const electronStorage: StorageHost = {
  call<T>(op: string, args?: Record<string, unknown>): Promise<T> {
    const p = ensure()
    const id = ++seq
    return new Promise<T>((resolve, reject) => {
      waiting.set(id, { resolve: resolve as (v: unknown) => void, reject })
      p.postMessage({ id, op, args })
    })
  },
  onEvent(fn) { listener = fn },
  running: () => !!proc,
  stop() { proc?.kill(); proc = null }
}

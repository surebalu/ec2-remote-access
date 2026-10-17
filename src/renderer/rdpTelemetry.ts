/**
 * Memory telemetry for the embedded RDP client, printed by "Copy diagnostics".
 *
 * Why it exists: after days of use the renderer can reach gigabytes and burn a core while RDP tabs are open. The IronRDP
 * wasm module's linear memory is invisible to V8's own accounting and never shrinks, so Activity Monitor cannot say whether
 * the JS heap or the wasm heap is growing, nor whether growth tracks reconnects. A sample on every connect plus one every
 * few minutes puts that curve into the pasted diagnostics.
 */

interface Sample {
  at: number
  jsHeapMB: number | null
  wasmMB: number | null
  tabs: number
  mounts: number
  connects: number
  freed: number
}

const PERIODIC_MS = 5 * 60_000
const MAX_SAMPLES = 120
const REPORT_ROWS = 40

const samples: Sample[] = []
const counts = { mounts: 0, connects: 0, freed: 0 }
let tabs = 0
let timer: ReturnType<typeof setInterval> | undefined
let wasmMemory: WebAssembly.Memory | null = null
let hooked = false

/**
 * `init()` of the RDP backend returns nothing, so the only way to read its linear memory is to take the `memory` export
 * as the module is instantiated. Call once, right before `init()`. A no-op if WebAssembly is not patchable.
 */
export function watchWasmMemory(): void {
  if (hooked) return
  hooked = true
  try {
    const wa = WebAssembly as unknown as Record<string, unknown>
    for (const name of ['instantiateStreaming', 'instantiate']) {
      const orig = wa[name]
      if (typeof orig !== 'function') continue
      wa[name] = async (...args: unknown[]): Promise<unknown> => {
        const out = await (orig as (...a: unknown[]) => Promise<unknown>).apply(WebAssembly, args)
        // instantiate(bytes) resolves to { module, instance }; instantiate(module) resolves to the instance itself.
        const inst = (out as { instance?: WebAssembly.Instance }).instance ?? (out as WebAssembly.Instance)
        const mem = (inst.exports as Record<string, unknown> | undefined)?.memory
        if (!wasmMemory && mem instanceof WebAssembly.Memory) wasmMemory = mem
        return out
      }
    }
  } catch {
    /* diagnostics only */
  }
}

const mb = (n: number): number => Math.round(n / 1048576)

function take(): void {
  const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
  samples.push({
    at: Date.now(),
    jsHeapMB: heap ? mb(heap.usedJSHeapSize) : null,
    wasmMB: wasmMemory ? mb(wasmMemory.buffer.byteLength) : null,
    tabs,
    ...counts
  })
  if (samples.length > MAX_SAMPLES) samples.shift()
}

/** Registers an open RDP tab and starts the periodic sampler with the first one. Returns the matching release. */
export function trackTab(): () => void {
  tabs += 1
  if (!timer) {
    take()
    timer = setInterval(take, PERIODIC_MS)
  }
  return () => {
    tabs = Math.max(0, tabs - 1)
    if (tabs === 0 && timer) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

export const noteMount = (): void => { counts.mounts += 1 }
export const noteFreed = (): void => { counts.freed += 1 }
export function noteConnect(): void {
  counts.connects += 1
  take()
}

/** Lines for the diagnostics header. */
export function telemetryReport(): string[] {
  take()
  const up = Math.round(performance.now() / 60_000)
  const out = [
    `--- Renderer memory (page up ${Math.floor(up / 60)} h ${up % 60} min; counters are per page load) ---`,
    `RDP tabs open: ${tabs} · element mounts: ${counts.mounts} · sessions connected: ${counts.connects} · sessions freed: ${counts.freed}`,
    'time(UTC)  jsHeapMB  wasmMB  tabs  mounts  connects  freed'
  ]
  for (const s of samples.slice(-REPORT_ROWS)) {
    out.push(
      `${new Date(s.at).toISOString().slice(11, 19)}   ${String(s.jsHeapMB ?? 'n/a').padStart(8)}  ${String(s.wasmMB ?? 'n/a').padStart(6)}  ${String(s.tabs).padStart(4)}  ${String(s.mounts).padStart(6)}  ${String(s.connects).padStart(8)}  ${String(s.freed).padStart(5)}`
    )
  }
  return out
}

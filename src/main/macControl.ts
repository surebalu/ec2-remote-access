/**
 * The ec2ra-control helper (native/control/main.swift): one process for the app's run, started on first use, that
 * moves other apps' windows, opens and hides apps for their hotkeys, presses ⌘V for the launcher's emoji, and reads
 * the calendars macOS has. One JSON request per line on its stdin, one answer per line on its stdout, matched by id.
 * Its path comes from host().mac (Electron-only: the app's Resources, or build/native in development); everything
 * else here is plain Node, so the gateway can load the module and simply finds no helper.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { host } from './host'
import { log } from './log'

export const NO_HELPER = 'The window and calendar helper is missing from this build. Run scripts/build-native.sh (it needs Xcode or its Command Line Tools), then restart the app.'

/** An answer the helper gave as an error; `code` is 'accessibility' or 'calendar' for a permission macOS has not given. */
export class ControlError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
  }
}

let proc: ChildProcessWithoutNullStreams | null = null
let seq = 0
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()

export function controlPath(): string | null {
  return host().mac?.controlPath() ?? null
}

function start(): ChildProcessWithoutNullStreams {
  if (proc) return proc
  const bin = controlPath()
  if (!bin) throw new Error(NO_HELPER)
  const p = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] })
  proc = p
  let buf = ''
  p.stdout.setEncoding('utf8')
  p.stdout.on('data', (chunk: string) => {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      let msg: { id?: number; ok?: boolean; result?: unknown; error?: string; code?: string }
      try { msg = JSON.parse(line) } catch { continue }
      const w = typeof msg.id === 'number' ? waiting.get(msg.id) : undefined
      if (!w) continue
      waiting.delete(msg.id!)
      clearTimeout(w.timer)
      if (msg.ok) w.resolve(msg.result)
      else w.reject(new ControlError(msg.error || 'The helper failed.', msg.code ?? ''))
    }
  })
  p.stderr.setEncoding('utf8')
  p.stderr.on('data', (t: string) => log('control', 'helper stderr', { text: t.slice(0, 500) }))
  const gone = (why: string): void => {
    if (proc === p) proc = null
    for (const [id, w] of waiting) {
      clearTimeout(w.timer)
      w.reject(new Error(`The window and calendar helper stopped (${why}).`))
      waiting.delete(id)
    }
  }
  p.on('exit', (code, signal) => gone(signal ?? `exit ${code}`))
  p.on('error', (e) => gone(e.message))
  return p
}

/** Asks the helper; `timeout` covers macOS's permission questions (askCalendar waits for the user). */
export function control<T>(op: string, args: Record<string, unknown> = {}, timeout = 10_000): Promise<T> {
  let p: ChildProcessWithoutNullStreams
  try { p = start() } catch (e) { return Promise.reject(e) }
  const id = ++seq
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id)
      reject(new Error(`The window and calendar helper did not answer (${op}).`))
    }, timeout)
    waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
    p.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`)
  })
}

export interface ControlStatus {
  helper: boolean
  accessibility: boolean
  /** authorized, writeOnly, denied, restricted, notDetermined, unknown. */
  calendar: string
}

/** What macOS allows the app now; asks nothing. */
export async function controlStatus(): Promise<ControlStatus> {
  if (!controlPath()) return { helper: false, accessibility: false, calendar: 'unknown' }
  try {
    return { helper: true, ...(await control<{ accessibility: boolean; calendar: string }>('status')) }
  } catch (e) {
    log('control', 'status failed', { message: (e as Error).message })
    return { helper: true, accessibility: false, calendar: 'unknown' }
  }
}

export function closeControl(): void {
  proc?.stdin.end()
  proc?.kill()
  proc = null
}

/**
 * Persistent log for the connection engine. Everything console.* prints, plus structured `log()` calls, lands in
 * `<logsDir>/main.log` (macOS: ~/Library/Logs/EC2 Remote Access/main.log; gateway: <dataDir>/logs/main.log) so a
 * problem seen in a packaged build can still be diagnosed afterwards. Rotates once at 5 MB to main.1.log.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAX_BYTES = 5 * 1024 * 1024
let file: string | null = null
let bytes = 0

export function logFilePath(): string | null {
  return file
}

/** Starts writing to `<dir>/main.log` and mirrors console.log/warn/error into it. Safe to call once. */
export function initLog(dir: string): void {
  if (file) return
  try {
    mkdirSync(dir, { recursive: true })
    file = join(dir, 'main.log')
    bytes = existsSync(file) ? statSync(file).size : 0
  } catch {
    file = null
    return
  }
  for (const level of ['log', 'warn', 'error'] as const) {
    const orig = console[level].bind(console)
    console[level] = (...args: unknown[]): void => {
      orig(...args)
      write(level === 'log' ? 'info' : level, args.map(fmt).join(' '))
    }
  }
  write('info', `---- log opened (pid ${process.pid}, ${process.platform} ${process.arch}, node ${process.versions.node}) ----`)
}

function fmt(a: unknown): string {
  if (typeof a === 'string') return a
  if (a instanceof Error) return a.stack ?? a.message
  try { return JSON.stringify(a) } catch { return String(a) }
}

function write(level: string, text: string): void {
  if (!file) return
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${text}\n`
  try {
    if (bytes + line.length > MAX_BYTES) {
      renameSync(file, file.replace(/\.log$/, '.1.log'))
      bytes = 0
    }
    appendFileSync(file, line)
    bytes += line.length
  } catch { /* disk full or unwritable: never let logging break the app */ }
}

/** Structured entry: `[scope] message key=value …`. Values are JSON-encoded so paths and messages stay greppable. */
export function log(scope: string, message: string, data?: Record<string, unknown>): void {
  const extra = data ? ' ' + Object.entries(data).map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v) : fmt(v)}`).join(' ') : ''
  write('info', `[${scope}] ${message}${extra}`)
}

/** Tail of the log for "Copy diagnostics": the last `lines` entries, optionally only those matching `filter`. */
export function recentLog(lines = 400, filter?: string): { path: string | null; text: string } {
  if (!file || !existsSync(file)) return { path: file, text: '' }
  let all: string[]
  try { all = readFileSync(file, 'utf8').split('\n') } catch { return { path: file, text: '' } }
  const re = filter ? new RegExp(filter, 'i') : null
  const picked = (re ? all.filter((l) => re.test(l)) : all).filter(Boolean).slice(-lines)
  return { path: file, text: picked.join('\n') }
}

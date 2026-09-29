import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getSettings } from '../store'

// CSI (colours, cursor moves), OSC (window titles, hyperlinks) and the remaining two-byte escapes.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g

export interface Recorder {
  file: string
  write: (data: string) => void
  close: () => void
}

export function sessionLogDir(): string {
  return getSettings().sessionLogDir.trim().replace(/^~(?=$|\/)/, homedir()) || join(homedir(), 'Documents', 'EC2 Remote Access', 'Session logs')
}

/**
 * Plain-text transcript of an SSH session for change records. Escape sequences are stripped so the file reads like
 * the screen did; full-screen programs (vim, top) come out garbled, as they do with `script`.
 */
export function startRecorder(hostName: string, user: string): Recorder | null {
  if (!getSettings().sessionLogging) return null
  const dir = sessionLogDir()
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:]/g, '-').replace(/\..+/, '')
  const file = join(dir, `${hostName.replace(/[^\w.-]+/g, '_')}-${stamp}.log`)
  const out: WriteStream = createWriteStream(file, { flags: 'a' })
  out.on('error', () => undefined)
  out.write(`# ${user}@${hostName} started ${new Date().toString()}\n`)
  return {
    file,
    write: (data) => out.write(data.replace(ANSI, '').replace(/\r(?!\n)/g, '')),
    close: () => {
      out.end(`\n# session ended ${new Date().toString()}\n`)
    }
  }
}

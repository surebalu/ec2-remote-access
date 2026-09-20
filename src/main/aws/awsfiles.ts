/**
 * Minimal, formatting-preserving editor for ~/.aws/config and ~/.aws/credentials.
 * Sections are `[header]` blocks; we replace/remove whole sections and leave everything else untouched.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const AWS_DIR = process.env.AWS_CONFIG_FILE ? join(process.env.AWS_CONFIG_FILE, '..') : join(homedir(), '.aws')
export const CONFIG_FILE = process.env.AWS_CONFIG_FILE ?? join(AWS_DIR, 'config')
export const CREDENTIALS_FILE = process.env.AWS_SHARED_CREDENTIALS_FILE ?? join(AWS_DIR, 'credentials')

function read(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

function write(file: string, text: string): void {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text.endsWith('\n') || text === '' ? text : text + '\n')
  try {
    chmodSync(file, 0o600)
  } catch {
    /* ignore */
  }
}

interface Section {
  header: string
  start: number
  end: number
}

function sections(text: string): Section[] {
  const lines = text.split('\n')
  const out: Section[] = []
  let cur: Section | null = null
  lines.forEach((line, idx) => {
    const m = /^\s*\[([^\]]+)\]\s*(?:[#;].*)?$/.exec(line)
    if (m) {
      if (cur) cur.end = idx
      cur = { header: m[1].trim(), start: idx, end: lines.length }
      out.push(cur)
    }
  })
  return out
}

function renderSection(header: string, kv: Record<string, string | undefined>): string {
  const body = Object.entries(kv)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k} = ${v}`)
    .join('\n')
  return `[${header}]\n${body}\n`
}

/** Replace (or append) a whole section. */
export function upsertSection(file: string, header: string, kv: Record<string, string | undefined>): void {
  const text = read(file)
  const lines = text.split('\n')
  const sec = sections(text).find((s) => s.header === header)
  const block = renderSection(header, kv)
  let next: string
  if (sec) {
    // keep a trailing blank line between sections
    const after = lines.slice(sec.end)
    next = [...lines.slice(0, sec.start), ...block.replace(/\n$/, '').split('\n'), ...(after.length && after[0].trim() !== '' ? [''] : []), ...after].join('\n')
  } else {
    const sep = text.trim() === '' ? '' : text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n'
    next = text + sep + block
  }
  write(file, next)
}

export function removeSection(file: string, header: string): boolean {
  const text = read(file)
  const sec = sections(text).find((s) => s.header === header)
  if (!sec) return false
  const lines = text.split('\n')
  // also swallow blank lines that followed the section
  let end = sec.end
  while (end < lines.length && lines[end].trim() === '') end++
  write(file, [...lines.slice(0, sec.start), ...lines.slice(end)].join('\n'))
  return true
}

export function renameSection(file: string, from: string, to: string): boolean {
  const text = read(file)
  const sec = sections(text).find((s) => s.header === from)
  if (!sec) return false
  const lines = text.split('\n')
  lines[sec.start] = lines[sec.start].replace(`[${from}]`, `[${to}]`)
  write(file, lines.join('\n'))
  return true
}

export function readSection(file: string, header: string): Record<string, string> | null {
  const text = read(file)
  const sec = sections(text).find((s) => s.header === header)
  if (!sec) return null
  const kv: Record<string, string> = {}
  for (const line of text.split('\n').slice(sec.start + 1, sec.end)) {
    const m = /^\s*([^=#;\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(line)
    if (m) kv[m[1]] = m[2]
  }
  return kv
}

export function listSectionHeaders(file: string): string[] {
  return sections(read(file)).map((s) => s.header)
}

/**
 * The planning tools' documents (Tasks, Calendar, Links; src/shared/records.ts): one JSON file per tool in
 * <userData>/records, written atomically, one write at a time. Every applied change is broadcast as records:changed,
 * so the Mac's window, a phone and an iPad on the gateway all reload what changed. Kept with the app's data, like the
 * whiteboards, so the gateway serves the same lists.
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { applyOps, checkOp, emptyDoc, RECORD_KINDS, type RecordDoc, type RecordKind } from '@shared/records'
import { host } from './host'

const docs = new Map<RecordKind, RecordDoc>()
let writing: Promise<void> = Promise.resolve()

const dir = (): string => {
  const d = join(host().userDataDir(), 'records')
  mkdirSync(d, { recursive: true })
  return d
}
const fileFor = (kind: RecordKind): string => join(dir(), `${kind}.json`)

function checkKind(kind: unknown): RecordKind {
  if (!RECORD_KINDS.includes(kind as RecordKind)) throw new Error('Not a list this app keeps.')
  return kind as RecordKind
}

export function loadRecords(kind: RecordKind): RecordDoc {
  checkKind(kind)
  let doc = docs.get(kind)
  if (!doc) {
    try {
      const raw = JSON.parse(readFileSync(fileFor(kind), 'utf8')) as RecordDoc
      doc = raw && typeof raw.rev === 'number' && raw.items && typeof raw.items === 'object' ? raw : emptyDoc()
    } catch (e) {
      // No file yet is an empty list; an unreadable one is kept aside rather than overwritten.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`The ${kind} file could not be read; it was left as it is.`)
      doc = emptyDoc()
    }
    docs.set(kind, doc)
  }
  return doc
}

/** Applies changes and saves them; returns the new revision. */
export async function applyRecords(kind: RecordKind, ops: unknown[]): Promise<number> {
  checkKind(kind)
  if (!Array.isArray(ops) || ops.length > 20_000) throw new Error('Too many changes at once.')
  const next = applyOps(loadRecords(kind), ops.map(checkOp))
  docs.set(kind, next)
  const save = async (): Promise<void> => {
    const file = fileFor(kind)
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(docs.get(kind)), 'utf8')
    await rename(tmp, file)
  }
  writing = writing.then(save, save)
  await writing
  host().broadcast('records:changed', { kind, rev: next.rev })
  return next.rev
}

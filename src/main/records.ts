/**
 * The planning tools' documents (Tasks, Calendar, Links; src/shared/records.ts): one JSON file per tool in
 * <userData>/records, written atomically, one write at a time. Every applied change is broadcast as records:changed,
 * so the Mac's window, a phone and an iPad on the gateway all reload what changed. Kept with the app's data, like the
 * whiteboards, so the gateway serves the same lists; a data folder (main/dataFolder.ts) gets a merged copy.
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { applyOps, checkOp, emptyDoc, mergeDocs, pruneDeleted, RECORD_KINDS, type RecordDoc, type RecordKind } from '@shared/records'
import { host } from './host'

const docs = new Map<RecordKind, RecordDoc>()
let writing: Promise<void> = Promise.resolve()
const listeners = new Set<(kind: RecordKind) => void>()

const dir = (): string => {
  const d = join(host().userDataDir(), 'records')
  mkdirSync(d, { recursive: true })
  return d
}
const fileFor = (kind: RecordKind): string => join(dir(), `${kind}.json`)
/** Where the documents are kept, for Settings → Data. */
export const recordsDir = (): string => dir()

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
      // Deletion markers every copy has long seen are dropped as the document is read (saved with the next change).
      doc = raw && typeof raw.rev === 'number' && raw.items && typeof raw.items === 'object' ? pruneDeleted(raw) : emptyDoc()
    } catch (e) {
      // No file yet is an empty list; an unreadable one is kept aside rather than overwritten.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`The ${kind} file could not be read; it was left as it is.`)
      doc = emptyDoc()
    }
    docs.set(kind, doc)
  }
  return doc
}

/** Writes the document as it is now and tells every window. */
async function persist(kind: RecordKind): Promise<number> {
  const save = async (): Promise<void> => {
    const file = fileFor(kind)
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(docs.get(kind)), 'utf8')
    await rename(tmp, file)
  }
  writing = writing.then(save, save)
  await writing
  const rev = docs.get(kind)!.rev
  host().broadcast('records:changed', { kind, rev })
  return rev
}

/** Applies changes and saves them; returns the new revision. */
export async function applyRecords(kind: RecordKind, ops: unknown[]): Promise<number> {
  checkKind(kind)
  if (!Array.isArray(ops) || ops.length > 20_000) throw new Error('Too many changes at once.')
  docs.set(kind, applyOps(loadRecords(kind), ops.map(checkOp)))
  const rev = await persist(kind)
  for (const l of listeners) l(kind)
  return rev
}

/**
 * Takes in a copy from elsewhere (the data folder's): merged into the document as it is now, so a change applied here
 * while that copy was being read is kept. Returns whether anything changed.
 */
export async function adoptRecords(kind: RecordKind, incoming: RecordDoc): Promise<boolean> {
  const { doc, changed } = mergeDocs(loadRecords(checkKind(kind)), incoming)
  if (!changed) return false
  docs.set(kind, doc)
  await persist(kind)
  return true
}

/** Calls `cb` after each change applied here (not after adoptRecords), so the data folder can follow. */
export function onRecordsApplied(cb: (kind: RecordKind) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

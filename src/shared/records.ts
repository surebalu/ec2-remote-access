/**
 * The planning tools' data (Tasks, Calendar, Links): one document per tool, kept by main in <userData>/records and
 * served by the gateway too, so a phone or iPad edits the same lists. A document is a flat map of items by id; every
 * change is a list of operations (put an item whole, or delete one), so two devices editing different items never
 * overwrite each other, and the last write of one item wins. A deleted item leaves a small marker (type 'deleted'), so
 * when two copies are merged (this Mac's and the one in a data folder on a NAS, main/dataFolder.ts) the deletion wins
 * over the older item instead of the item coming back. The item shapes belong to each tool (src/shared/tasks.ts,
 * calendar.ts, links.ts); this is only the container. Pure: tests/tasks.test.ts covers it.
 */

export type RecordKind = 'tasks' | 'calendar' | 'links'
export const RECORD_KINDS: readonly RecordKind[] = ['tasks', 'calendar', 'links']

export interface RecordItem {
  id: string
  /** What the item is within its tool ('task', 'project', 'event', 'link', 'folder'…). */
  type: string
  updatedAt: number
}

export interface RecordDoc {
  /** Goes up by one with every applied change; a client that has seen it has seen everything before it. */
  rev: number
  items: Record<string, RecordItem>
}

export type RecordOp = { op: 'put'; item: RecordItem } | { op: 'delete'; id: string }

/** Ids are made by the renderer: short, and safe as object keys and in a URL. */
export const isRecordId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)

export const MAX_ITEMS = 50_000
/** One item's JSON, so a pasted novel in a note cannot grow the file without bound. */
export const MAX_ITEM_BYTES = 256 * 1024

export const emptyDoc = (): RecordDoc => ({ rev: 0, items: {} })

/** A new id: time first (so ids sort by creation), then randomness. */
export function newRecordId(now = Date.now()): string {
  const rand = Array.from({ length: 6 }, () => Math.floor(Math.random() * 36).toString(36)).join('')
  return `${now.toString(36)}${rand}`
}

/** Checks one operation from a client; throws a readable error for anything a document should not take. */
export function checkOp(op: unknown): RecordOp {
  const o = op as Partial<{ op: string; id: unknown; item: Partial<RecordItem> }>
  if (o?.op === 'delete') {
    if (!isRecordId(o.id)) throw new Error('Not a record id.')
    return { op: 'delete', id: o.id }
  }
  if (o?.op !== 'put' || !o.item || typeof o.item !== 'object') throw new Error('Not a record change.')
  const item = o.item
  if (!isRecordId(item.id)) throw new Error('Not a record id.')
  if (typeof item.type !== 'string' || !/^[a-z]{1,24}$/.test(item.type) || item.type === DELETED) throw new Error('Not a record type.')
  if (JSON.stringify(item).length > MAX_ITEM_BYTES) throw new Error('That item is too large to save.')
  return { op: 'put', item: { ...item, updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now() } as RecordItem }
}

/** What a deleted item leaves behind: the marker that wins a merge against older copies of it. */
export const DELETED = 'deleted'
/** Deletion markers older than this are dropped (every copy has long seen them). */
export const KEEP_DELETED_MS = 180 * 24 * 3600_000

/** Applies operations to a document (a new object; the old one is untouched). */
export function applyOps(doc: RecordDoc, ops: RecordOp[], now = Date.now()): RecordDoc {
  if (!ops.length) return doc
  const items = { ...doc.items }
  for (const op of ops) {
    if (op.op === 'delete') items[op.id] = { id: op.id, type: DELETED, updatedAt: Math.max(now, (items[op.id]?.updatedAt ?? 0) + 1) }
    else items[op.item.id] = op.item
  }
  if (Object.keys(items).length > MAX_ITEMS) throw new Error(`A list can hold at most ${MAX_ITEMS.toLocaleString()} items.`)
  return { rev: doc.rev + 1, items }
}

/** The items of one type, as an array. */
export function itemsOf<T extends RecordItem>(doc: RecordDoc, type: T['type']): T[] {
  return Object.values(doc.items).filter((i): i is T => i.type === type)
}

/**
 * Two copies of a document as one: for each item the copy changed last wins (a deletion is a change), so edits made
 * on either side while they were apart both survive. `changed` says whether the result differs from `a`.
 */
export function mergeDocs(a: RecordDoc, b: RecordDoc): { doc: RecordDoc; changed: boolean } {
  let changed = false
  const items = { ...a.items }
  for (const [id, theirs] of Object.entries(b.items)) {
    const mine = items[id]
    if (!mine || theirs.updatedAt > mine.updatedAt) { items[id] = theirs; changed = true }
  }
  return { doc: { rev: Math.max(a.rev, b.rev) + (changed ? 1 : 0), items }, changed }
}

/** Drops deletion markers old enough that every copy has seen them. */
export function pruneDeleted(doc: RecordDoc, now = Date.now()): RecordDoc {
  const items = Object.fromEntries(Object.entries(doc.items).filter(([, i]) => i.type !== DELETED || now - i.updatedAt < KEEP_DELETED_MS))
  return Object.keys(items).length === Object.keys(doc.items).length ? doc : { ...doc, items }
}

/** One put operation, typed by the item it saves. */
export const putOp = <T extends RecordItem>(item: T): RecordOp => ({ op: 'put', item })

/** Put operations for changed or new items (stamped now). */
export const puts = <T extends RecordItem>(items: T[], now = Date.now()): RecordOp[] => items.map((item) => ({ op: 'put', item: { ...item, updatedAt: now } }))

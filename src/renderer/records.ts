import { useEffect, useSyncExternalStore } from 'react'
import { applyOps, type RecordDoc, type RecordKind, type RecordOp } from '@shared/records'
import { useStore } from './store'

/**
 * The renderer's copy of the Tasks, Calendar and Links documents (src/shared/records.ts, kept by main/records.ts):
 * one per tool for the whole page, so the Calendar shows the tasks the Tasks tab edits. A change shows at once and is
 * sent to main; a change from another device (records:changed with a newer revision) reloads the document.
 */

interface Entry { doc: RecordDoc | null; error: string | null; loading: Promise<void> | null; listeners: Set<() => void>; pending: number }
const entries = new Map<RecordKind, Entry>()
let subscribed = false

const entry = (kind: RecordKind): Entry => {
  let e = entries.get(kind)
  if (!e) {
    e = { doc: null, error: null, loading: null, listeners: new Set(), pending: 0 }
    entries.set(kind, e)
  }
  return e
}
const notify = (e: Entry): void => { for (const l of e.listeners) l() }

function load(kind: RecordKind): Promise<void> {
  const e = entry(kind)
  e.loading ??= window.api.invoke('records:load', kind).then(
    (doc) => { e.doc = doc; e.error = null },
    (err: Error) => { e.error = err.message }
  ).finally(() => { e.loading = null; notify(e) })
  return e.loading
}

function listen(): void {
  if (subscribed) return
  subscribed = true
  window.api.on('records:changed', ({ kind, rev }) => {
    const e = entries.get(kind)
    // Our own changes are already shown; a newer revision while none of ours is in flight came from elsewhere.
    if (e?.doc && rev > e.doc.rev && e.pending === 0) void load(kind)
  })
}

/** Applies changes here at once and saves them; on failure the saved document is reloaded and the error shown. */
export async function applyRecords(kind: RecordKind, ops: RecordOp[]): Promise<void> {
  if (!ops.length) return
  const e = entry(kind)
  if (!e.doc) await load(kind)
  if (!e.doc) throw new Error(e.error ?? 'Not loaded yet.')
  e.doc = applyOps(e.doc, ops)
  e.pending++
  notify(e)
  try {
    const rev = await window.api.invoke('records:apply', kind, ops)
    // Another device changed it in between (main is further on than our copy): fetch what main has.
    if (rev > (e.doc?.rev ?? 0)) await load(kind)
  } catch (err) {
    useStore.getState().toast('error', (err as Error).message)
    await load(kind)
  } finally {
    e.pending--
    notify(e)
  }
}

/** The document of a tool (null while it loads) and its load error. */
export function useRecords(kind: RecordKind): { doc: RecordDoc | null; error: string | null } {
  const e = entry(kind)
  useEffect(() => {
    listen()
    if (!e.doc && !e.loading) void load(kind)
  }, [kind]) // eslint-disable-line react-hooks/exhaustive-deps
  const doc = useSyncExternalStore((cb) => { e.listeners.add(cb); return () => { e.listeners.delete(cb) } }, () => e.doc)
  const error = useSyncExternalStore((cb) => { e.listeners.add(cb); return () => { e.listeners.delete(cb) } }, () => e.error)
  return { doc, error }
}

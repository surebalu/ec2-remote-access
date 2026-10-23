import { create } from 'zustand'
import { bytes, plural, type DiskInfo, type ScanRootKind, type ScanState, type TrashOutcome } from '@shared/storage'
import type { CleanReport } from '@shared/cleanup'
import type { MacApp } from '@shared/macApps'
import { useStore } from '../../store'

/**
 * The Storage tool's page-wide state: the scan (pushed by main as storage:scanState), the disk, which room is open,
 * and the last move to the Trash (for its Put Back bar). Rooms keep their own lists and reload when `trashed` moves.
 */

export type RoomId = 'overview' | 'map' | 'search' | 'large' | 'hidden' | 'junk' | 'ai' | 'system' | 'duplicates' | 'installers' | 'unused' | 'uninstaller' | 'leftovers' | 'startup' | 'monitor' | 'optimize' | 'removed' | 'report'

const ROOM_KEY = 'storage.room'
const savedRoom = (): RoomId => { try { return (localStorage.getItem(ROOM_KEY) as RoomId | null) ?? 'overview' } catch { return 'overview' } }

interface StorageState {
  scan: ScanState
  disk: DiskInfo | null
  fda: boolean | null
  room: RoomId
  /** Moves on whenever something went to the Trash (from any room): lists reload. */
  trashed: number
  /** Where the Space Map should open next ("Open in the Space Map"). */
  mapRequest: { path: string; nonce: number } | null
  /** The last move to the Trash, offered back for a while. */
  undo: { label: string; ids: string[]; key: number } | null
  /** What only an administrator can move, for Finder. */
  adminItems: { path: string; reason: string }[] | null
  /** The Cleanup rooms' last reports, kept while the page lives so coming back does not measure again. */
  reports: Partial<Record<RoomId, CleanReport>>
  /** Apps to open the Uninstaller on ("Open in the Uninstaller"). */
  uninstall: { paths: string[]; nonce: number } | null
  /** The installed apps, measured (Unused Apps, the Uninstaller, the Overview). */
  apps: MacApp[] | null
  /** A search to run when the Search room opens (from the Space Map's field or the Overview). */
  searchRequest: { query: string; nonce: number } | null
}

export const useStorage = create<StorageState>(() => ({
  scan: { status: 'idle' }, disk: null, fda: null, room: savedRoom(), trashed: 0, mapRequest: null, undo: null, adminItems: null, reports: {}, uninstall: null, apps: null, searchRequest: null
}))

/** Takes what went to the Trash out of every kept report, so the rooms match the disk without measuring again. */
export function dropFromReports(paths: string[]): void {
  const gone = new Set(paths)
  useStorage.setState((s) => ({
    reports: Object.fromEntries(Object.entries(s.reports).map(([k, r]) => [k, r && { ...r, groups: r.groups.map((g) => ({ ...g, items: g.items.filter((i) => !gone.has(i.path)) })).filter((g) => g.items.length) }]))
  }))
}

export function setRoom(room: RoomId): void {
  useStorage.setState({ room })
  try { localStorage.setItem(ROOM_KEY, room) } catch { /* private window */ }
}

let started = false
/** Subscribes to main's pushes once per page and reads the scan, the disk and Full Disk Access. */
export function initStorage(): void {
  if (started) return
  started = true
  window.api.on('storage:scanState', (scan) => useStorage.setState({ scan }))
  window.api.on('storage:trashed', () => { useStorage.setState((s) => ({ trashed: s.trashed + 1 })); void refreshDisk() })
  void window.api.invoke('storage:state').then((scan) => useStorage.setState({ scan }), () => undefined)
  void refreshDisk()
  void refreshFda()
}

export async function refreshDisk(): Promise<void> {
  try { useStorage.setState({ disk: await window.api.invoke('storage:disk') }) } catch { /* shown as unknown */ }
}

export async function refreshFda(): Promise<boolean | null> {
  try {
    const fda = await window.api.invoke('storage:fullDiskAccess')
    useStorage.setState({ fda })
    return fda
  } catch { return null }
}

const toast = (kind: 'error' | 'info' | 'success', msg: string): void => useStore.getState().toast(kind, msg)

export async function startScan(kind: ScanRootKind, path?: string): Promise<void> {
  try {
    let where = path
    if (kind === 'path' && !where) {
      where = (await window.api.invoke('storage:pickFolder')) ?? undefined
      if (!where) return
    }
    useStorage.setState({ scan: await window.api.invoke('storage:scan', kind, where) })
  } catch (e) { toast('error', (e as Error).message) }
}

export const cancelScan = (): Promise<void> => window.api.invoke('storage:cancel').catch(() => undefined)

let appsLoading: Promise<void> | null = null
/** Measures the installed apps once for the page (again with `force`, or after something went to the Trash). */
export function loadApps(force = false): Promise<void> {
  if (appsLoading && !force) return appsLoading
  if (useStorage.getState().apps && !force) return Promise.resolve()
  appsLoading = window.api.invoke('storage:apps', true).then((apps) => useStorage.setState({ apps }), () => undefined).finally(() => { appsLoading = null })
  return appsLoading
}

const measuring = new Set<RoomId>()
/** Measures a Cleanup room's report in the background (the Overview fills its numbers this way), once at a time. */
export function measureReport(room: 'junk' | 'leftovers' | 'ai' | 'installers', force = false): void {
  if (measuring.has(room) || (!force && useStorage.getState().reports[room])) return
  measuring.add(room)
  const channel = room === 'junk' ? 'storage:junk' : room === 'leftovers' ? 'storage:leftovers' : room === 'ai' ? 'storage:ai' : 'storage:installers'
  void window.api.invoke(channel).then((r) => useStorage.setState((s) => ({ reports: { ...s.reports, [room]: r } })), () => undefined).finally(() => measuring.delete(room))
}

export function openSearch(query: string): void {
  useStorage.setState({ searchRequest: { query, nonce: Date.now() } })
  setRoom('search')
}

export function openInUninstaller(paths: string[]): void {
  useStorage.setState({ uninstall: { paths, nonce: Date.now() } })
  setRoom('uninstaller')
}

/** Asks apps to quit (as Command-Q does) and says how many did. */
export async function quitApps(pids: number[], names: string[]): Promise<number> {
  try {
    const n = await window.api.invoke('storage:quitApps', pids)
    toast(n ? 'success' : 'info', n ? `Asked ${names.length === 1 ? names[0] : plural(n, 'app')} to quit. Anything unsaved asks first.` : 'Nothing was asked to quit.')
    return n
  } catch (e) { toast('error', (e as Error).message); return 0 }
}

export function openInMap(path: string): void {
  useStorage.setState({ mapRequest: { path, nonce: Date.now() } })
  setRoom('map')
}

/**
 * Moves items to the Trash through main (which checks each and records it for Put Back), then says what happened:
 * a Put Back bar for what went, Finder for what only an administrator can move, the reason for the rest.
 */
export async function trashItems(items: { path: string; size?: number; dir?: boolean }[], from: string): Promise<TrashOutcome | null> {
  if (!items.length) return null
  let out: TrashOutcome
  try { out = await window.api.invoke('storage:trash', items, from) } catch (e) { toast('error', (e as Error).message); return null }
  if (out.moved.length) {
    dropFromReports(out.moved.map((m) => m.path))
    const label = out.moved.length === 1 ? `Moved ${out.moved[0].path.split('/').pop()} (${bytes(out.bytes)}) to the Trash` : `Moved ${plural(out.moved.length, 'item')} (${bytes(out.bytes)}) to the Trash`
    useStorage.setState({ undo: { label, ids: out.moved.map((m) => m.id), key: Date.now() } })
  }
  const admin = out.failed.filter((f) => f.admin)
  if (admin.length) useStorage.setState({ adminItems: admin })
  const other = out.failed.filter((f) => !f.admin)
  if (other.length) toast('error', other.length === 1 ? `${other[0].path.split('/').pop()}: ${other[0].reason}` : `${plural(other.length, 'item')} stayed. ${other[0].reason}`)
  return out
}

export async function putBack(ids: string[]): Promise<number> {
  try {
    const r = await window.api.invoke('storage:putBack', ids)
    if (r.failed.length) toast('error', r.failed[0].reason)
    if (r.restored.length) {
      toast('success', `Put back ${plural(r.restored.length, 'item')}.`)
      void refreshDisk()
    }
    return r.restored.length
  } catch (e) { toast('error', (e as Error).message); return 0 }
}

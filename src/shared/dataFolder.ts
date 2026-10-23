/**
 * The data folder's rules (main/dataFolder.ts): what to do with each whiteboard found on this Mac and in the folder,
 * how two lists of deletions combine, and where a Links file goes when the files are copied there. Pure:
 * tests/dataFolder.test.ts. The Tasks, Calendar and Links documents merge item by item in src/shared/records.ts.
 */

/**
 * One board here (`mine`: its updatedAt, -1 when this Mac has none) and in the data folder (`theirs`): the later
 * save wins, and a deletion later than both copies removes them.
 */
export function boardStep(mine: number, theirs: number, deletedAt = 0): 'keep' | 'push' | 'pull' | 'delete' {
  if (deletedAt && deletedAt >= Math.max(mine, theirs)) return mine < 0 && theirs < 0 ? 'keep' : 'delete'
  if (mine > theirs) return 'push'
  if (theirs > mine) return 'pull'
  return 'keep'
}

/** Two lists of deletions (id → when) as one, the later time for each, and whether each side lacked something. */
export function mergeStamps(a: Record<string, number>, b: Record<string, number>): { merged: Record<string, number>; aChanged: boolean; bChanged: boolean } {
  const merged = { ...a }
  let aChanged = false
  for (const [id, t] of Object.entries(b)) if (!(id in merged) || t > merged[id]) { merged[id] = t; aChanged = true }
  const bChanged = Object.entries(merged).some(([id, t]) => b[id] !== t)
  return { merged, aChanged, bChanged }
}

/** Where a Links file goes in the data folder: the same folders below `fromRoot`, else in "Other". */
export function linkFileDest(path: string, fromRoot: string, toRoot: string): string {
  const root = fromRoot.replace(/\/+$/, '')
  const rel = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : `Other/${path.split('/').pop() ?? 'file'}`
  return `${toRoot.replace(/\/+$/, '')}/${rel}`
}

/** "2 min ago" for the last sync. */
export function agoLabel(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 45) return 'just now'
  if (s < 90 * 60) return `${Math.max(1, Math.round(s / 60))} min ago`
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} days ago`
}

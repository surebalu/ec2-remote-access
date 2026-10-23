import type { WorkspaceTool } from '@shared/types'

type ContextKind = 'local' | 'browser' | 'finder'
const readers = new Map<ContextKind, () => WorkspaceTool | null>()

/** Read the mounted tool's current state, including changes its debounced disk save has not written yet. */
export function registerWorkspaceContext(kind: ContextKind, read: () => WorkspaceTool | null): () => void {
  readers.set(kind, read)
  return () => { if (readers.get(kind) === read) readers.delete(kind) }
}

export function readWorkspaceContext(kind: ContextKind): WorkspaceTool | null {
  return readers.get(kind)?.() ?? null
}

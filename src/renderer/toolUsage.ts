import { bump, type Use } from '@shared/usage'
import { TOOL_NAMES, useStore, type ToolKind } from './store'

/**
 * Counts how often each tool comes to the front (from the rail, a shortcut, the radial menu, ⌘K or a split), for the
 * home page's Tools, most used first (src/shared/usage.ts). Kept per Mac in localStorage: a convenience, never shared.
 */

const KEY = 'ui.toolUsage'
export const USAGE_EVENT = 'ec2ra:tool-usage'

export function readUsage(): Partial<Record<ToolKind, Use>> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Record<ToolKind, Use>> } catch { return {} }
}

function record(kind: ToolKind): void {
  const usage = readUsage()
  usage[kind] = bump(usage[kind], Date.now())
  try { localStorage.setItem(KEY, JSON.stringify(usage)) } catch { /* storage off: the order stays as it was */ }
  window.dispatchEvent(new Event(USAGE_EVENT))
}

/** Starts counting; returns the unsubscribe. */
export function installToolUsage(): () => void {
  let front = ''
  return useStore.subscribe((s) => {
    const tab = s.gridView ? undefined : s.tabs.find((t) => t.id === s.activeTab)
    const id = tab?.id ?? ''
    if (id === front) return
    front = id
    if (tab && tab.kind in TOOL_NAMES) record(tab.kind as ToolKind)
  })
}

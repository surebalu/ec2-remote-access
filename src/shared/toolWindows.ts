/**
 * Detached tools (main/toolWindows.ts, renderer/ToolWindow.tsx): which rail sections can have a window of their own,
 * where that window goes, and whether a drag ended outside the main window. Pure: tests/toolWindows.test.ts.
 */

/** The tools that can be dragged out into a window of their own (the hosts list and Overview stay in the main window). */
export const DETACHABLE_TOOLS = ['local', 'browser', 'notes', 'board', 'finder', 'claude', 'chatgpt', 'health', 'devtools', 'tasks', 'calendar', 'links'] as const
export type DetachableTool = (typeof DETACHABLE_TOOLS)[number]
export const isToolKind = (k: unknown): k is DetachableTool => typeof k === 'string' && (DETACHABLE_TOOLS as readonly string[]).includes(k)

/** The drag type a detached window's icon carries back to the main window. */
export const TOOL_DRAG_TYPE = 'application/x-ec2ra-tool'

interface Rect { x: number; y: number; width: number; height: number }

/**
 * Where a tool's window opens: its top-left corner a little up and left of where it was dropped, so the window lands
 * under the pointer, kept on that screen; three quarters of the main window's size, within limits.
 */
export function toolWindowBounds(point: { x: number; y: number }, area: Rect, main: Rect | null): Rect {
  const width = Math.round(Math.min(area.width, Math.max(640, Math.min(1280, (main?.width ?? 1200) * 0.75))))
  const height = Math.round(Math.min(area.height, Math.max(460, Math.min(900, (main?.height ?? 820) * 0.8))))
  const clamp = (v: number, lo: number, hi: number): number => Math.round(Math.max(lo, Math.min(v, hi)))
  return {
    x: clamp(point.x - 80, area.x, area.x + area.width - width),
    y: clamp(point.y - 20, area.y, area.y + area.height - height),
    width,
    height
  }
}

/**
 * Whether a drag that ended at screen point `p` was let go outside the window (`win`, its screen rectangle). A drop
 * the page did not take with the pointer still over the window is no detach: it was let go on the page itself.
 */
export function droppedOutside(p: { x: number; y: number }, win: Rect): boolean {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || (p.x === 0 && p.y === 0)) return false
  return p.x < win.x || p.y < win.y || p.x >= win.x + win.width || p.y >= win.y + win.height
}

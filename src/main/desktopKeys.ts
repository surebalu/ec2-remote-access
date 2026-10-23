import { globalShortcut, Notification, screen, shell } from 'electron'
import { toAccelerator } from '@shared/keyCombos'
import { layoutById, layoutFrame, sameFrame, type Rect } from '@shared/windowLayouts'
import { control, ControlError } from './macControl'
import { getSettings } from './store'
import { log } from './log'

/**
 * Window layouts and app hotkeys (Settings → Windows), Mac app only; handlers.ts reaches this through host().mac.
 * Each key is an Electron global shortcut, so it works in every app without the Accessibility permission; what the
 * key does (moving another app's window) goes through the ec2ra-control helper (main/macControl.ts), which does need
 * it. The arithmetic of where a window goes is src/shared/windowLayouts.ts; the displays come from Electron's screen,
 * whose work areas leave out the menu bar and the Dock, in the same coordinates as the accessibility API.
 */

interface FrontWindow extends Rect {
  title: string
  fullscreen: boolean
  minimized: boolean
}

interface Front {
  pid: number
  name: string
  bundleId: string
  path: string
  window?: FrontWindow
}

/** id ('window:left-half', 'app:<id>') → the accelerator macOS gave us. */
const registered = new Map<string, string>()
/** Keys macOS refused (another app holds them). */
const refused = new Set<string>()
let paused = false

/** Per window: where it was before the layouts moved it (Restore goes back there), and where they last put it. */
const original = new Map<string, Rect>()
const placed = new Map<string, Rect>()
const windowId = (f: Front): string => `${f.pid}:${f.window?.title ?? ''}`

const displays = (): Rect[] => screen.getAllDisplays().map((d) => ({ x: d.workArea.x, y: d.workArea.y, w: d.workArea.width, h: d.workArea.height }))

export async function applyLayout(id: string): Promise<void> {
  const layout = layoutById(id)
  if (!layout) throw new Error('There is no such window layout.')
  const front = await control<Front>('front')
  const who = front.name || 'The app in front'
  if (layout.op === 'fullscreen') {
    await control('fullscreen', { pid: front.pid })
    return
  }
  if (!front.window) throw new Error(`${who} has no window to move.`)
  if (layout.op === 'minimize') {
    await control('minimize', { pid: front.pid })
    return
  }
  if (front.window.fullscreen) throw new Error(`${who}’s window is full screen. Leave full screen first (⌃⌘F).`)
  const win: Rect = { x: front.window.x, y: front.window.y, w: front.window.w, h: front.window.h }
  const key = windowId(front)
  let target: Rect | null
  if (layout.op === 'restore') {
    target = original.get(key) ?? null
    original.delete(key)
    placed.delete(key)
    if (!target) return
  } else {
    target = layoutFrame(layout, win, displays(), Math.max(0, Math.min(60, getSettings().windowGap ?? 0)))
    if (!target) return
    // Moved by hand since the last layout (or never placed): that is the frame Restore goes back to.
    const last = placed.get(key)
    if (!last || !sameFrame(last, win, 6)) original.set(key, win)
  }
  const got = await control<Partial<Rect>>('setFrame', { pid: front.pid, ...target })
  placed.set(key, { x: got.x ?? target.x, y: got.y ?? target.y, w: got.w ?? target.w, h: got.h ?? target.h })
  if (placed.size > 500) { placed.clear(); original.clear() }
}

let warned = false

/** A key pressed in another app has nowhere to show an error but a notification (once per run for the permission). */
function report(e: unknown): void {
  const err = e as Error
  log('windows', 'key failed', { message: err.message })
  if (err instanceof ControlError && err.code === 'accessibility') {
    if (warned) return
    warned = true
  }
  if (!Notification.isSupported()) return
  const n = new Notification({ title: 'EC2 Remote Access', body: err.message, silent: true })
  if (err instanceof ControlError && err.code === 'accessibility') n.on('click', () => void openPrivacy('accessibility'))
  n.show()
}

async function toggleApp(path: string): Promise<void> {
  try {
    await control('toggleApp', { path })
  } catch (e) {
    // Without the helper the app still opens; it just cannot be hidden by the same key.
    if (e instanceof ControlError) throw e
    const error = await shell.openPath(path)
    if (error) throw new Error(`Could not open ${path}: ${error}`)
  }
}

/** Takes the keys Settings names (letting go of changed ones). Safe to call after every settings save. */
export function updateDesktopKeys(): void {
  const s = getSettings()
  const want = new Map<string, { accel: string; run: () => void }>()
  if (!paused && process.platform === 'darwin') {
    for (const [id, combo] of Object.entries(s.windowKeys ?? {})) {
      const accel = toAccelerator(combo)
      if (accel && layoutById(id)) want.set(`window:${id}`, { accel, run: () => void applyLayout(id).catch(report) })
    }
    for (const h of s.appHotkeys ?? []) {
      const accel = toAccelerator(h.combo)
      if (accel && h.path) want.set(`app:${h.id}`, { accel, run: () => void toggleApp(h.path).catch(report) })
    }
  }
  for (const [id, accel] of registered) {
    if (want.get(id)?.accel === accel) continue
    globalShortcut.unregister(accel)
    registered.delete(id)
  }
  refused.clear()
  const taken = new Set(registered.values())
  for (const [id, { accel, run }] of want) {
    if (registered.get(id) === accel) continue
    // Two entries on one key: the first keeps it (Settings refuses this; a hand-edited file might not).
    if (taken.has(accel)) { refused.add(id); continue }
    try {
      if (globalShortcut.register(accel, run)) {
        registered.set(id, accel)
        taken.add(accel)
      } else {
        refused.add(id)
        log('windows', 'key taken by another app', { id, accel })
      }
    } catch (e) {
      refused.add(id)
      log('windows', 'could not take key', { id, accel, message: (e as Error).message })
    }
  }
}

export function pauseDesktopKeys(pause: boolean): void {
  paused = pause
  updateDesktopKeys()
}

export function desktopKeysStatus(): { id: string; combo: string; registered: boolean }[] {
  const s = getSettings()
  return [
    ...Object.entries(s.windowKeys ?? {}).filter(([, c]) => c).map(([id, combo]) => ({ id: `window:${id}`, combo, registered: registered.has(`window:${id}`) })),
    ...(s.appHotkeys ?? []).filter((h) => h.combo).map((h) => ({ id: `app:${h.id}`, combo: h.combo, registered: registered.has(`app:${h.id}`) }))
  ]
}

export function closeDesktopKeys(): void {
  for (const accel of registered.values()) globalShortcut.unregister(accel)
  registered.clear()
}

export const openPrivacy = (pane: 'accessibility' | 'calendars'): Promise<void> =>
  shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?Privacy_${pane === 'accessibility' ? 'Accessibility' : 'Calendars'}`)

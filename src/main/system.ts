import { execFile } from 'node:child_process'
import type { SystemAction } from '@shared/launcher'
import { host } from './host'

/**
 * The launcher's Mac commands: a fixed list, each one program and its arguments (never text from the page). The ones
 * that end work or delete files ask first. Finder and System Events ask macOS for permission the first time
 * (Automation); Sleep and Lock Screen do not.
 */
const COMMANDS: Record<SystemAction, { cmd: string; args: string[]; ask?: { message: string; detail: string; button: string } }> = {
  sleep: { cmd: 'pmset', args: ['sleepnow'] },
  // Sleeping the displays locks the Mac when it asks for the password right away (System Settings → Lock Screen).
  lock: { cmd: 'pmset', args: ['displaysleepnow'] },
  darkMode: { cmd: 'osascript', args: ['-e', 'tell application "System Events" to tell appearance preferences to set dark mode to not dark mode'] },
  mute: { cmd: 'osascript', args: ['-e', 'set volume output muted (not (output muted of (get volume settings)))'] },
  emptyTrash: { cmd: 'osascript', args: ['-e', 'tell application "Finder" to empty trash'], ask: { message: 'Empty the Trash?', detail: 'The files in it are deleted for good.', button: 'Empty Trash' } },
  restart: { cmd: 'osascript', args: ['-e', 'tell application "System Events" to restart'], ask: { message: 'Restart the Mac?', detail: 'Open sessions close; apps ask to save their work first.', button: 'Restart' } },
  shutdown: { cmd: 'osascript', args: ['-e', 'tell application "System Events" to shut down'], ask: { message: 'Shut down the Mac?', detail: 'Open sessions close; apps ask to save their work first.', button: 'Shut Down' } }
}

export async function runSystemAction(action: SystemAction): Promise<void> {
  const c = Object.hasOwn(COMMANDS, action) ? COMMANDS[action] : undefined
  if (!c || process.platform !== 'darwin') throw new Error('That command is not available here.')
  host().launcher?.hide()
  if (c.ask && !(await host().launcher?.confirm(c.ask.message, c.ask.detail, c.ask.button))) return
  await new Promise<void>((resolve, reject) => execFile(c.cmd, c.args, { timeout: 15000 }, (err) => (err ? reject(new Error(`${c.cmd} failed: ${err.message}`)) : resolve())))
}

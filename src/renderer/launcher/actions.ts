import type { AppCommand } from '@shared/types'
import type { SystemAction } from '@shared/launcher'

/** What the launcher's results do: put it away, count a use, hand a command to the app's window, open, copy. */

export const hide = (): void => void window.api.invoke('launcher:hide')
export const used = (id: string): void => void window.api.invoke('launcher:used', id).catch(() => undefined)
/** Has the app's window do `c` (it comes to the front), counting a use of `id`. */
export const inApp = (id: string, c: AppCommand) => (): void => {
  used(id)
  void window.api.invoke('launcher:command', c)
}
export const openPath = (id: string, path: string) => (): void => void window.api.invoke('launcher:open', path, id).catch(() => undefined)
export const copy = (text: string) => (): void => {
  void window.api.invoke('clipboard:write', text)
  hide()
}
export const external = (url: string) => (): void => {
  void window.api.invoke('shell:open', url)
  hide()
}
export const reveal = (path: string) => (): void => {
  void window.api.invoke('local:reveal', path)
  hide()
}
export const quickLook = (path: string) => (): void => void window.api.invoke('launcher:quickLook', path)
export const system = (id: string, action: SystemAction) => (): void => {
  used(id)
  void window.api.invoke('launcher:system', action).catch(() => undefined)
}
/** Copies the file itself (as Finder's ⌘C does), to paste into Finder, Mail or Slack. */
export const copyFile = (path: string) => (): void => {
  void window.api.invoke('finder:copy', [path]).catch(() => undefined)
  hide()
}

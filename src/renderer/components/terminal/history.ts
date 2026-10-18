/**
 * Command history for the Terminal tab's input box, shared by every pane: the shell's history file (read once from
 * main) followed by what was run in the app since, newest last and each command once.
 */
let list: string[] = []
let loading: Promise<void> | null = null

export function loadHistory(): Promise<void> {
  loading ??= window.api.invoke('term:history').then(
    (h) => { list = [...h.filter((c) => !list.includes(c)), ...list] },
    () => undefined
  )
  return loading
}

export function history(): string[] {
  return list
}

export function addHistory(cmd: string): void {
  const c = cmd.trim()
  if (!c) return
  list = [...list.filter((x) => x !== c), c].slice(-5000)
}

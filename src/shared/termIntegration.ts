/**
 * What the Terminal tab reads from its shells, kept free of Electron and the DOM so tests can load it: the shell
 * integration's markers (main/localterm.ts writes the zsh side), the working directory from OSC 7, and the shell's
 * history file.
 *
 *   OSC 133;A        a prompt starts (the previous command, if any, has finished)
 *   OSC 133;C        the command line was accepted; its output follows
 *   OSC 133;D;<n>    the command exited with status n
 *   OSC 633;E;<b64>  the command line, base64 (UTF-8)
 *   OSC 633;P;K=V    a property of the prompt: Git (branch), Aws (AWS_PROFILE)
 *   OSC 7;file://host/path   the working directory
 */

export type ShellMark =
  | { kind: 'prompt' }
  | { kind: 'output' }
  | { kind: 'done'; exit: number }
  | { kind: 'command'; text: string }
  | { kind: 'prop'; key: string; value: string }
  | null

/** Decodes base64 UTF-8 without Buffer (the renderer has no Node). */
export function decodeBase64(b64: string): string {
  try {
    const bin = atob(b64.replace(/\s+/g, ''))
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
  } catch {
    return ''
  }
}

/** Reads the payload of an OSC 133 or 633 sequence (without the number). */
export function parseMark(osc: 133 | 633, data: string): ShellMark {
  if (osc === 133) {
    if (data === 'A' || data.startsWith('A;')) return { kind: 'prompt' }
    if (data === 'C' || data.startsWith('C;')) return { kind: 'output' }
    if (data.startsWith('D')) {
      const n = Number(data.split(';')[1])
      return { kind: 'done', exit: Number.isFinite(n) ? n : 0 }
    }
    return null
  }
  if (data.startsWith('E;')) return { kind: 'command', text: decodeBase64(data.slice(2)) }
  if (data.startsWith('P;')) {
    const kv = data.slice(2)
    const eq = kv.indexOf('=')
    return eq > 0 ? { kind: 'prop', key: kv.slice(0, eq), value: kv.slice(eq + 1) } : null
  }
  return null
}

/** The directory in an OSC 7 report ("file://host/Users/me/my%20dir" → "/Users/me/my dir"). */
export function parseOsc7(data: string): string | null {
  const m = /^file:\/\/[^/]*(\/.*)$/.exec(data)
  if (!m) return null
  try {
    return decodeURIComponent(m[1])
  } catch {
    return m[1]
  }
}

/** "~/code/app" for a directory under home, else the path itself. */
export function tildify(path: string, home: string | undefined): string {
  if (!home) return path
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/** A tab title from the folder: its last part ("~" for home). */
export function folderName(path: string | undefined, home: string | undefined): string {
  if (!path) return ''
  const t = tildify(path, home)
  return t === '~' || t === '/' ? t : t.split('/').filter(Boolean).pop() ?? t
}

/**
 * Commands from a zsh (": 1700000000:0;cmd", lines ending in "\" continue) or bash (one per line) history file,
 * oldest first, each once (its latest use), at most `limit`.
 */
export function parseHistory(text: string, limit: number): string[] {
  const cmds: string[] = []
  let cur: string | null = null
  for (const raw of text.split('\n')) {
    let line = raw
    if (cur === null) {
      const m = /^: \d+:\d+;(.*)$/.exec(line)
      if (m) line = m[1]
      else if (line.startsWith('#')) continue
    }
    if (line.endsWith('\\')) {
      cur = (cur === null ? '' : `${cur}\n`) + line.slice(0, -1)
      continue
    }
    const cmd = cur === null ? line : `${cur}\n${line}`
    cur = null
    if (cmd.trim()) cmds.push(cmd.trim())
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (let i = cmds.length - 1; i >= 0 && out.length < limit; i--) {
    if (seen.has(cmds[i])) continue
    seen.add(cmds[i])
    out.push(cmds[i])
  }
  return out.reverse()
}

/** The history entry the input box suggests for what is typed: the latest that starts with it and is longer. */
export function suggestFromHistory(history: string[], typed: string): string | null {
  if (!typed.trim()) return null
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i]
    if (h.length > typed.length && h.startsWith(typed) && !h.includes('\n')) return h
  }
  return null
}

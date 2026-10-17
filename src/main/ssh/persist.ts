/**
 * Persistent shells. Each SSH tab's shell runs inside tmux on the host, on a private server socket (`-L ec2ra`) so the
 * user's own tmux sessions are never listed or touched. When the connection drops, sshd only takes the tmux client
 * down; the shell (after `sudo su`, in its directory, with a job still running) lives on and Reconnect attaches to it.
 *
 * tmux is set up to be invisible: no status line, no prefix key (Ctrl-B reaches the shell), mouse off (tmux 3.8 turns
 * it on by default) and no alternate screen, so wheel scrolling, selection, Find and Save output keep working on the
 * app's own scrollback. Kept free of ssh2 and Electron so tests can load it.
 */
import type { DetachedShell, HostShell } from '@shared/types'

export const SHELL_PREFIX = 'ec2ra-'
const TMUX = 'tmux -L ec2ra -f /dev/null'

/** Server options, one tmux call each: an option an older tmux lacks must not stop the rest. */
const OPTIONS = [
  'set -g status off',
  'set -g mouse off',
  'set -g prefix None',
  'unbind-key C-b',
  'set -g escape-time 0',
  // Without smcup/rmcup tmux draws into the normal screen, so lines scrolling off land in the app's scrollback.
  "set -ga terminal-overrides ',*:smcup@:rmcup@'"
]

/** Single-quotes for sh; the same `'\''` splice also works when the login shell is csh or fish. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** sshd hands exec requests to the user's login shell, which may not be POSIX; run the script with sh explicitly. */
function viaSh(script: string): string {
  return `sh -c ${shq(script)}`
}

/** tmux session name for a tab: stable for the tab's life, so every reconnect finds the same shell. */
export function shellNameFor(tabId: string): string {
  return SHELL_PREFIX + tabId.replace(/^ssh-/, '').replace(/[^A-Za-z0-9]/g, '')
}

export function isShellName(name: string): boolean {
  return name.startsWith(SHELL_PREFIX) && /^[A-Za-z0-9-]+$/.test(name)
}

export interface ProbeSession { name: string; attached: boolean; activity: number | null; command: string; path: string; created: number | null }
export interface TmuxProbe { available: boolean; now: number | null; sessions: ProbeSession[] }

/** Lists the shells on the private socket, or reports that tmux is missing. */
export function probeCommand(): string {
  return viaSh(
    [
      'command -v tmux >/dev/null 2>&1 || { echo ec2ra:none; exit 0; }',
      'echo "ec2ra:now $(date +%s)"',
      `${TMUX} list-sessions -F 'ec2ra:s #{session_name}\t#{session_attached}\t#{session_activity}\t#{pane_current_command}\t#{pane_current_path}\t#{session_created}' 2>/dev/null`,
      'exit 0'
    ].join('\n')
  )
}

/** null when the output is not the probe's (a Windows OpenSSH host, a broken shell): fall back to a plain shell. */
export function parseProbe(out: string): TmuxProbe | null {
  const lines = out.split(/\r?\n/).map((l) => l.trim())
  if (lines.includes('ec2ra:none')) return { available: false, now: null, sessions: [] }
  const nowLine = lines.find((l) => l.startsWith('ec2ra:now '))
  if (!nowLine) return null
  const now = Number(nowLine.slice('ec2ra:now '.length)) || null
  const sessions: ProbeSession[] = []
  for (const l of out.split(/\r?\n/)) {
    if (!l.startsWith('ec2ra:s ')) continue
    const [name, attached, activity, command = '', path = '', created] = l.slice('ec2ra:s '.length).replace(/\r$/, '').split('\t')
    if (!name) continue
    sessions.push({ name, attached: Number(attached) > 0, activity: Number(activity) || null, command, path, created: Number(created) || null })
  }
  return { available: true, now, sessions }
}

/** Shells of ours that no client is showing, most recently used first. */
export function detachedShells(probe: TmuxProbe, except: string): DetachedShell[] {
  return probe.sessions
    .filter((s) => !s.attached && s.name !== except && isShellName(s.name))
    .sort((a, b) => (b.activity ?? 0) - (a.activity ?? 0))
    .map((s) => ({ name: s.name, command: s.command, path: s.path, idleSec: probe.now && s.activity ? Math.max(0, probe.now - s.activity) : null }))
}

/** Every shell of ours on the host, oldest first, for a tab's session list. */
export function hostShells(probe: TmuxProbe, current: string): HostShell[] {
  const ago = (t: number | null): number | null => (probe.now && t ? Math.max(0, probe.now - t) : null)
  return probe.sessions
    .filter((s) => isShellName(s.name))
    .sort((a, b) => (a.created ?? 0) - (b.created ?? 0))
    .map((s) => ({ name: s.name, command: s.command, path: s.path, idleSec: ago(s.activity), ageSec: ago(s.created), current: s.name === current, attached: s.attached }))
}

/** A further shell started from a tab: the tab's own name plus a suffix, unique on the host. */
export function newShellName(sessionId: string): string {
  return `${shellNameFor(sessionId)}-${Date.now().toString(36)}`
}

/** The earlier output of a shell (above its screen), replayed into the terminal before switching to it. */
export function historyCommand(name: string): string {
  return viaSh(`${TMUX} capture-pane -p -J -e -t ${shq(name)} -S -10000 -E -1 2>/dev/null; exit 0`)
}

export interface SwitchPlan {
  /** The shell the tab's tmux client shows now. */
  from: string
  to: string
  create: boolean
  cols: number
  rows: number
}

/**
 * Moves the tab's tmux client from one shell to another (tmux switch-client, on the connection the tab already has,
 * so nothing reconnects and the shell it leaves keeps running). A client showing `to` elsewhere is detached first, so
 * a shell is never shown in two tabs at once. Prints ec2ra:switched, or why not.
 */
export function switchCommand(p: SwitchPlan): string {
  const to = shq(p.to)
  const lines = [
    `C=$(${TMUX} list-clients -t ${shq(p.from)} -F '#{client_tty}' 2>/dev/null | head -n 1)`,
    '[ -n "$C" ] || { echo ec2ra:noclient; exit 0; }'
  ]
  if (p.create) lines.push(`${TMUX} new-session -d -s ${to} -x ${Math.max(20, p.cols | 0)} -y ${Math.max(5, p.rows | 0)} || { echo ec2ra:failed; exit 0; }`)
  // A shell that ended meanwhile: redraw the current one over the replayed history and say so.
  lines.push(`${TMUX} has-session -t ${to} 2>/dev/null || { ${TMUX} refresh-client -t "$C"; echo ec2ra:gone; exit 0; }`)
  lines.push(`${TMUX} detach-client -s ${to} 2>/dev/null`)
  lines.push(`${TMUX} switch-client -c "$C" -t ${to} && echo ec2ra:switched`)
  return viaSh(lines.join('\n'))
}

export interface AttachPlan {
  name: string
  /** No session by this name yet: create it. */
  create: boolean
  /** No server on the socket yet: start it with our options before the first window exists. */
  startServer: boolean
  cols: number
  rows: number
}

/** The exec command for an interactive channel (with a pty) that creates and/or attaches the tab's shell. */
export function attachCommand(p: AttachPlan): string {
  const n = shq(p.name)
  const size = `-x ${Math.max(20, p.cols | 0)} -y ${Math.max(5, p.rows | 0)}`
  const lines: string[] = []
  if (p.create && p.startServer) {
    // default-terminal and history-limit only apply to windows created after they are set, hence one call that
    // starts the server, configures it and creates the first session.
    lines.push('TERMV=screen; infocmp screen-256color >/dev/null 2>&1 && TERMV=screen-256color')
    lines.push(`${TMUX} start-server \\; set -g default-terminal "$TERMV" \\; set -g history-limit 10000 \\; new-session -d -s ${n} ${size}`)
    for (const o of OPTIONS) lines.push(`${TMUX} ${o} >/dev/null 2>&1`)
  } else if (p.create) {
    lines.push(`${TMUX} new-session -d -s ${n} ${size}`)
  }
  lines.push(`if ${TMUX} has-session -t ${n} 2>/dev/null; then`)
  // -d detaches a client left over from the dropped connection, which sshd may not have noticed yet.
  lines.push(`  exec ${TMUX} attach-session -d -t ${n}`)
  lines.push('fi')
  lines.push("echo '[tmux could not start a session, so this is a plain shell that ends if the connection drops]'")
  lines.push('exec "${SHELL:-/bin/sh}" -l')
  return viaSh(lines.join('\n'))
}

export function killCommand(name: string): string {
  return viaSh(`${TMUX} kill-session -t ${shq(name)} 2>/dev/null; exit 0`)
}

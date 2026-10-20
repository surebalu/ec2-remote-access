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
/**
 * The name a user gives a shell ("debug", "indexing") is a tmux user option on the session itself, so it lives on the
 * host with the shell: every device and every later app run sees it, and the session's own name stays our stable id.
 */
const LABEL = '@ec2ra_label'
const LABEL_MAX = 40

/** A session name as stored and shown: one line, no control characters, short enough for a tab. */
export function cleanLabel(label: string | undefined): string {
  return (label ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX)
}

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

/**
 * tmux drops output a terminal falls behind on (about eight screens' worth waiting, which SSM reaches with any long
 * listing) and redraws only the final screen, so those lines never reach the app's scrollback; its own history keeps
 * them. The title is how it tells us: tmux sends it with the redraw, and it counts the bytes dropped for this client
 * (tmux 2.5+; older ones never drop, and leave the count empty). Set on every attach, since a server an earlier
 * version started lacks it.
 */
const TITLE_OPTIONS = ['set -g set-titles on', `set -g set-titles-string ${shq('ec2ra:#{client_discarded}')}`]
const TITLE = /\x1b\][02];ec2ra:(\d+)(?:\x07|\x1b\\)/g

/** Follows that count through the output of a tab's tmux client, whose chunks may split a title in two. */
export class DropWatch {
  private seen = 0
  private carry = ''
  /** True when tmux has dropped output since the previous chunk. */
  feed(data: string): boolean {
    const text = this.carry + data
    let dropped = false
    for (const m of text.matchAll(TITLE)) {
      const n = Number(m[1])
      if (n > this.seen) dropped = true
      this.seen = n
    }
    const open = text.lastIndexOf('\x1b]')
    this.carry = open >= 0 && text.length - open < 64 && !/\x07|\x1b\\/.test(text.slice(open)) ? text.slice(open) : ''
    return dropped
  }
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

export interface ProbeSession {
  name: string
  attached: boolean
  activity: number | null
  command: string
  path: string
  created: number | null
  /** The name the user gave it ('' = none). */
  label: string
  /** Owner and command line of the pane's foreground process: who and what is really running after sudo su / su. */
  user: string
  args: string
  /** Last non-blank line on its screen: usually the prompt (user@host:dir) or the latest output. */
  preview: string
}
export interface TmuxProbe { available: boolean; now: number | null; sessions: ProbeSession[] }

/**
 * Lists the shells on the private socket, or reports that tmux is missing. Besides tmux's own view, each of ours gets
 * its name, the foreground process found through the pane's terminal (tpgid), so a shell after sudo su / su shows its
 * real user and a running job its real command line rather than "bash", and the last line on its screen. All of it
 * is read-only.
 */
export function probeCommand(): string {
  return viaSh(
    [
      'command -v tmux >/dev/null 2>&1 || { echo ec2ra:none; exit 0; }',
      'echo "ec2ra:now $(date +%s)"',
      `${TMUX} list-sessions -F 'ec2ra:s #{session_name}\t#{session_attached}\t#{session_activity}\t#{pane_current_command}\t#{pane_current_path}\t#{session_created}' 2>/dev/null`,
      `for n in $(${TMUX} list-sessions -F '#{session_name}' 2>/dev/null); do`,
      `  case "$n" in ${SHELL_PREFIX}*) ;; *) continue ;; esac`,
      `  l=$(${TMUX} show-options -qv -t "$n" ${LABEL} 2>/dev/null)`,
      `  [ -n "$l" ] && printf 'ec2ra:l %s\t%s\n' "$n" "$l"`,
      `  p=$(${TMUX} display-message -p -t "$n" '#{pane_pid}' 2>/dev/null)`,
      '  f=$(ps -o tpgid= -p "$p" 2>/dev/null | tr -d " ")',
      // user:32 keeps procps from cutting long user names to 8 characters. BSD ps (macOS) rejects it yet still prints the
      // other column, so the fallback replaces the output rather than adding to it; separate -o flags suit both.
      '  if [ "${f:-0}" -gt 0 ] 2>/dev/null; then',
      '    x=$(ps -o user:32= -o args= -p "$f" 2>/dev/null) || x=$(ps -o user= -o args= -p "$f" 2>/dev/null)',
      '    printf \'ec2ra:x %s\\t%s\\n\' "$n" "$(printf %s "$x" | head -n 1)"',
      '  fi',
      `  printf 'ec2ra:p %s\t%s\n' "$n" "$(${TMUX} capture-pane -p -t "$n" 2>/dev/null | grep -v '^[[:space:]]*$' | tail -n 1 | cut -c1-200)"`,
      'done',
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
  // Per-session extras: "ec2ra:<kind> <name>\t<value>", where the value may itself contain tabs.
  const extra = { l: new Map<string, string>(), x: new Map<string, string>(), p: new Map<string, string>() }
  for (const raw of out.split(/\r?\n/)) {
    const l = raw.replace(/\r$/, '')
    const m = /^ec2ra:([lxp]) ([^\t]+)\t(.*)$/.exec(l)
    if (m) extra[m[1] as 'l' | 'x' | 'p'].set(m[2], m[3])
    if (!l.startsWith('ec2ra:s ')) continue
    const [name, attached, activity, command = '', path = '', created] = l.slice('ec2ra:s '.length).split('\t')
    if (!name) continue
    sessions.push({ name, attached: Number(attached) > 0, activity: Number(activity) || null, command, path, created: Number(created) || null, label: '', user: '', args: '', preview: '' })
  }
  for (const s of sessions) {
    s.label = cleanLabel(extra.l.get(s.name))
    const fg = (extra.x.get(s.name) ?? '').trim()
    const sp = fg.search(/\s/)
    s.user = sp > 0 ? fg.slice(0, sp) : fg
    s.args = sp > 0 ? fg.slice(sp).trim().replace(/^-/, '') : ''
    s.preview = (extra.p.get(s.name) ?? '').replace(/\s+$/, '')
  }
  return { available: true, now, sessions }
}

/** Shells of ours that no client is showing, most recently used first. */
export function detachedShells(probe: TmuxProbe, except: string): DetachedShell[] {
  return probe.sessions
    .filter((s) => !s.attached && s.name !== except && isShellName(s.name))
    .sort((a, b) => (b.activity ?? 0) - (a.activity ?? 0))
    .map((s) => describe(s, probe.now))
}

function describe(s: ProbeSession, now: number | null): DetachedShell {
  return { name: s.name, label: s.label, command: s.command, path: s.path, user: s.user, args: s.args, preview: s.preview, idleSec: now && s.activity ? Math.max(0, now - s.activity) : null }
}

/** Every shell of ours on the host, oldest first, for a tab's session list. */
export function hostShells(probe: TmuxProbe, current: string): HostShell[] {
  const ago = (t: number | null): number | null => (probe.now && t ? Math.max(0, probe.now - t) : null)
  return probe.sessions
    .filter((s) => isShellName(s.name))
    .sort((a, b) => (a.created ?? 0) - (b.created ?? 0))
    .map((s) => ({ ...describe(s, probe.now), ageSec: ago(s.created), current: s.name === current, attached: s.attached }))
}

/** A further shell started from a tab: the tab's own name plus a suffix, unique on the host. */
export function newShellName(sessionId: string): string {
  return `${shellNameFor(sessionId)}-${Date.now().toString(36)}`
}

/**
 * The earlier output of a shell (above its screen), replayed into the terminal before switching to it or to refill
 * the scrollback. Gzipped when the host has gzip: 10,000 lines with their colours are megabytes over SSM.
 */
export function historyCommand(name: string): string {
  const capture = `${TMUX} capture-pane -p -J -e -t ${shq(name)} -S -10000 -E -1 2>/dev/null`
  return viaSh(`if command -v gzip >/dev/null 2>&1; then ${capture} | gzip -c; else ${capture}; fi; exit 0`)
}

/** Redraws the screen of the client showing a shell, over scrollback the app has just replaced. */
export function refreshCommand(name: string): string {
  return viaSh(`C=$(${TMUX} list-clients -t ${shq(name)} -F '#{client_tty}' 2>/dev/null | head -n 1); [ -n "$C" ] && ${TMUX} refresh-client -t "$C"; exit 0`)
}

/** Names a shell, or clears its name when `label` is empty. Prints ec2ra:ok. */
export function labelCommand(name: string, label: string): string {
  const l = cleanLabel(label)
  const set = l ? `set-option -t ${shq(name)} ${LABEL} ${shq(l)}` : `set-option -u -t ${shq(name)} ${LABEL}`
  return viaSh(`${TMUX} ${set} 2>/dev/null && echo ec2ra:ok; exit 0`)
}

export interface SwitchPlan {
  /** The shell the tab's tmux client shows now. */
  from: string
  to: string
  create: boolean
  /** Name for a shell being created. */
  label?: string
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
  if (p.create && cleanLabel(p.label)) lines.push(`${TMUX} set-option -t ${to} ${LABEL} ${shq(cleanLabel(p.label))} >/dev/null 2>&1`)
  // A shell that ended meanwhile: redraw the current one over the replayed history and say so.
  lines.push(`${TMUX} has-session -t ${to} 2>/dev/null || { ${TMUX} refresh-client -t "$C"; echo ec2ra:gone; exit 0; }`)
  lines.push(`${TMUX} detach-client -s ${to} 2>/dev/null`)
  lines.push(`${TMUX} switch-client -c "$C" -t ${to} || exit 0`)
  lines.push(`printf 'ec2ra:switched\\nec2ra:label %s\\n' "$(${TMUX} show-options -qv -t ${to} ${LABEL} 2>/dev/null)"`)
  return viaSh(lines.join('\n'))
}

export interface AttachPlan {
  name: string
  /** No session by this name yet: create it. */
  create: boolean
  /** No server on the socket yet: start it with our options before the first window exists. */
  startServer: boolean
  /** Name for a shell being created. */
  label?: string
  /** Print the shell's earlier output first: a new tab opening a shell that is already running. */
  history?: boolean
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
  if (p.create && cleanLabel(p.label)) lines.push(`${TMUX} set-option -t ${n} ${LABEL} ${shq(cleanLabel(p.label))} >/dev/null 2>&1`)
  for (const o of TITLE_OPTIONS) lines.push(`${TMUX} ${o} >/dev/null 2>&1`)
  lines.push(`if ${TMUX} has-session -t ${n} 2>/dev/null; then`)
  if (p.history) {
    lines.push(`  ${TMUX} capture-pane -p -J -e -t ${n} -S -10000 -E -1 2>/dev/null`)
    // tmux clears the screen when it attaches; push the replayed lines up into the scrollback first.
    lines.push(`  i=0; while [ $i -lt ${Math.max(5, p.rows | 0)} ]; do echo; i=$((i+1)); done`)
  }
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

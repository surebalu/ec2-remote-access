/**
 * Local terminals for the Terminal tab: the user's login shell in a pty (node-pty), streamed to the renderer as
 * term:event. For zsh a small shell integration marks prompts, commands, exit codes, the directory and the Git
 * branch (see src/shared/termIntegration.ts for the sequences), which the renderer turns into Warp-style blocks and
 * its input box. It is loaded through ZDOTDIR and sources the user's own .zshenv/.zprofile/.zshrc/.zlogin first, so
 * their setup is unchanged. Desktop only: the gateway refuses term:* calls, never forwards term:* events, and
 * never loads node-pty (it is imported on first use).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, userInfo } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { IPty } from 'node-pty'
import type { LocalTermInfo, LocalTermOpen, TerminalState } from '@shared/types'
import { parseHistory } from '@shared/termIntegration'
import { host } from './host'

type PtyModule = typeof import('node-pty')

interface Session {
  pty: IPty
  buf: string
  timer: ReturnType<typeof setTimeout> | null
}

const sessions = new Map<string, Session>()
let ptyModule: Promise<PtyModule> | null = null

/** node-pty 1.1.0's prebuilt spawn-helper ships without the execute bit; packaged apps fix it in build/afterPack.cjs. */
function ensureSpawnHelper(): void {
  if (process.platform === 'win32') return
  try {
    const dir = dirname(createRequire(import.meta.url).resolve('node-pty/package.json')).replace('app.asar', 'app.asar.unpacked')
    const helper = join(dir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
    if (existsSync(helper) && !(statSync(helper).mode & 0o111)) chmodSync(helper, 0o755)
  } catch {
    /* a helper built from source is executable already */
  }
}

const unwrap = (m: unknown): PtyModule => ((m as { default?: PtyModule }).default ?? m) as PtyModule

/**
 * node-pty ships prebuilt binaries for macOS only; on Linux (the Pi gateway, installed without build scripts) its
 * native module is missing, so the API-identical @lydell/node-pty with prebuilt Linux binaries stands in.
 */
function pty(): Promise<PtyModule> {
  ptyModule ??= import('node-pty')
    .then((m) => {
      ensureSpawnHelper()
      return unwrap(m)
    })
    .catch(() => import('@lydell/node-pty').then(unwrap))
  ptyModule.catch(() => { ptyModule = null })
  return ptyModule
}

// zsh reads $ZDOTDIR/.zshenv, .zprofile, .zshrc, .zlogin in that order for a login shell. Each of ours sources the
// user's file with ZDOTDIR set back to theirs (their files may move it), and .zlogin hands ZDOTDIR back for good.
const load = (file: string): string =>
  `ZDOTDIR="$__ec2ra_zd"\n[[ -f "$ZDOTDIR/${file}" ]] && source "$ZDOTDIR/${file}"\n__ec2ra_zd="$ZDOTDIR"\nZDOTDIR="$__ec2ra_dir"\n`

const ZSH_FILES: Record<string, string> = {
  '.zshenv': `# EC2 Remote Access shell integration (Terminal tab). Your own zsh files are loaded first.
__ec2ra_dir="$ZDOTDIR"
__ec2ra_zd="\${EC2RA_USER_ZDOTDIR:-$HOME}"
${load('.zshenv')}`,
  '.zprofile': load('.zprofile'),
  '.zshrc': `${load('.zshrc')}
if [[ -z "$__ec2ra_hooked" ]]; then
  __ec2ra_hooked=1
  __ec2ra_ran=
  __ec2ra_precmd() {
    local s=$?
    [[ -n "$__ec2ra_ran" ]] && printf '\\e]133;D;%s\\a' "$s"
    __ec2ra_ran=
    local d="\${PWD//\\%/%25}"
    printf '\\e]7;file://%s%s\\a' "$HOST" "\${d// /%20}"
    printf '\\e]633;P;Git=%s\\a' "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
    printf '\\e]633;P;Aws=%s\\a' "$AWS_PROFILE"
    printf '\\e]133;A\\a'
  }
  __ec2ra_preexec() {
    __ec2ra_ran=1
    printf '\\e]633;E;%s\\a' "$(printf '%s' "$1" | base64 | tr -d '\\n')"
    printf '\\e]133;C\\a'
  }
  # First, so it reads the exit status before other prompt hooks run.
  precmd_functions=(__ec2ra_precmd $precmd_functions)
  preexec_functions+=(__ec2ra_preexec)
fi
`,
  '.zlogin': `ZDOTDIR="$__ec2ra_zd"
[[ -f "$ZDOTDIR/.zlogin" ]] && source "$ZDOTDIR/.zlogin"
# From here on (subshells, exec zsh) the user's own files apply.
if [[ "$ZDOTDIR" == "$HOME" && -z "$EC2RA_USER_ZDOTDIR" ]]; then unset ZDOTDIR; else export ZDOTDIR; fi
unset __ec2ra_dir __ec2ra_zd EC2RA_USER_ZDOTDIR
`
}

let integrationWritten: string | null = null

function zshIntegration(): string {
  if (integrationWritten) return integrationWritten
  const dir = join(host().userDataDir(), 'shell-integration', 'zsh')
  mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(ZSH_FILES)) writeFileSync(join(dir, name), body)
  integrationWritten = dir
  return dir
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** The app's environment for a shell, minus what only concerns the app (Electron, npm scripts in development). */
function shellEnv(extra: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(ELECTRON_|npm_|VITE_|PNPM_)/i.test(k) || k === 'INIT_CWD' || k === 'NODE_ENV') continue
    env[k] = v
  }
  Object.assign(env, extra)
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.TERM_PROGRAM = 'EC2RemoteAccess'
  env.LANG ??= 'en_US.UTF-8'
  return env
}

function flush(id: string): void {
  const s = sessions.get(id)
  if (!s) return
  if (s.timer) clearTimeout(s.timer)
  s.timer = null
  if (!s.buf) return
  const data = s.buf
  s.buf = ''
  host().broadcast('term:event', { id, type: 'data', data })
}

export async function openLocal(req: LocalTermOpen): Promise<LocalTermInfo> {
  if (sessions.has(req.id)) throw new Error('That terminal is already open.')
  const { spawn } = await pty()
  const shell = process.env.SHELL || userInfo().shell || '/bin/zsh'
  const cwd = req.cwd && isDir(req.cwd) ? req.cwd : homedir()
  const env = shellEnv(req.env)
  const integration = basename(shell) === 'zsh'
  if (integration) {
    env.EC2RA_USER_ZDOTDIR = process.env.ZDOTDIR ?? ''
    env.ZDOTDIR = zshIntegration()
    // Kiro CLI / Amazon Q re-launch the shell inside their own pty wrapper, whose inner zsh reads the user's files
    // directly and so loses the integration. They skip that for shells they launched (this variable), and their
    // suggestions only work in terminals their Mac app supports, which this is not.
    env.PROCESS_LAUNCHED_BY_Q = '1'
  }
  const p = spawn(shell, ['-l'], { name: 'xterm-256color', cols: Math.max(2, req.cols), rows: Math.max(1, req.rows), cwd, env })
  const s: Session = { pty: p, buf: '', timer: null }
  sessions.set(req.id, s)
  // Output is coalesced for a few milliseconds: a chatty command otherwise means thousands of tiny messages.
  p.onData((d) => {
    s.buf += d
    s.timer ??= setTimeout(() => flush(req.id), 5)
  })
  p.onExit(({ exitCode }) => {
    flush(req.id)
    sessions.delete(req.id)
    host().broadcast('term:event', { id: req.id, type: 'exit', code: exitCode })
  })
  return { shell, integration, cwd }
}

export function writeLocal(id: string, data: string): void {
  sessions.get(id)?.pty.write(data)
}

export function resizeLocal(id: string, cols: number, rows: number): void {
  try {
    sessions.get(id)?.pty.resize(Math.max(2, cols), Math.max(1, rows))
  } catch {
    /* the shell is exiting */
  }
}

export function closeLocal(id: string): void {
  const s = sessions.get(id)
  if (!s) return
  sessions.delete(id)
  try {
    s.pty.kill()
  } catch {
    /* already gone */
  }
}

export function closeAllLocal(): void {
  for (const id of [...sessions.keys()]) closeLocal(id)
}

/** The tail of the shell's history file (HISTFILE, else ~/.zsh_history or ~/.bash_history). */
export function shellHistory(): string[] {
  const shell = basename(process.env.SHELL || userInfo().shell || 'zsh')
  const file = process.env.HISTFILE || join(homedir(), shell === 'bash' ? '.bash_history' : '.zsh_history')
  try {
    const size = statSync(file).size
    const len = Math.min(size, 1024 * 1024)
    const buf = Buffer.alloc(len)
    const fd = openSync(file, 'r')
    readSync(fd, buf, 0, len, size - len)
    closeSync(fd)
    const text = buf.toString('utf8')
    // Starting mid-file, the first line may be a fragment.
    return parseHistory(len < size ? text.slice(text.indexOf('\n') + 1) : text, 3000)
  } catch {
    return []
  }
}

const stateFile = (): string => join(host().userDataDir(), 'terminal.json')

export function loadTerminalState(): TerminalState | null {
  try {
    return JSON.parse(readFileSync(stateFile(), 'utf8')) as TerminalState
  } catch {
    return null
  }
}

export async function saveTerminalState(state: TerminalState): Promise<void> {
  const tmp = `${stateFile()}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(state), 'utf8')
  await rename(tmp, stateFile())
}

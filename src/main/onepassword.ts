/**
 * Logins from 1Password for the built-in browser, through the 1Password CLI (`op`) and its integration with the
 * 1Password app, which asks the user to approve (Touch ID). Listing returns no secrets; one item's username, password
 * and one-time code are read only when the user picks it to fill a page.
 *
 * 1Password ties an approval to the terminal it was given in (its tty and start time) and to one account. Run with no
 * terminal, as an app runs it, `op` had none to reuse, so every call asked again, once per account. So every call runs
 * in one pseudo-terminal kept for the app's run: an approval per account then covers the calls after it, until
 * 1Password's own limits (ten minutes without use, twelve hours at most).
 */
import { homedir } from 'node:os'
import type { IPty } from 'node-pty'
import type { WebLogin } from '@shared/types'
import { loadPty } from './pty'
import { findBinary, shellQuote } from './util'

type Login = Omit<WebLogin, 'matches'>

/**
 * The list holds names, usernames and addresses, no secrets, and stays until the panel's Reload (or half a day), so
 * opening the panel needs no approval; only filling one login asks, and only for its account.
 */
let cache: { at: number; logins: Login[] } | null = null
const CACHE_MS = 12 * 60 * 60_000

function friendly(text: string): string {
  const m = text.replace(/^\[ERROR\]\s*\S+\s+\S+\s*/, '').trim()
  if (/dismiss|denied|cancel/i.test(m)) return '1Password did not approve the request.'
  if (/not currently signed in|no accounts|integration|connect/i.test(m)) return `1Password: ${m}. In the 1Password app, turn on Settings → Developer → Integrate with 1Password CLI.`
  return `1Password: ${m}`
}

// Each call comes back as one line: its id, exit status, stdout and stderr (base64). Nothing is written to disk but
// op's stderr, for the moment it runs; history is off so no command line is kept.
const SETUP = [
  'stty -echo',
  'set +o history',
  `r() { local id="$1"; shift; local e out s; e=$(mktemp -t ec2ra-op) || return; out=$(set -o pipefail; "$@" 2>"$e" | base64 | tr -d '\\n'); s=$?; printf '\\n@@%s %s %s %s\\n' "$id" "$s" "$out" "$(base64 < "$e" | tr -d '\\n')"; rm -f "$e"; }`,
  // Arithmetic so the marker appears only when the line runs, not in its echo.
  'echo "__ec2ra_$((40 + 2))__"'
].join('; ')

interface Terminal { pty: IPty; buf: string; wait: ((buf: string) => boolean) | null }
let term: Terminal | null = null
let queue: Promise<unknown> = Promise.resolve()
let seq = 0

/** Waits until `match` finds what it needs in the terminal's output; the terminal is dropped on a timeout. */
function expect<T>(t: Terminal, match: (buf: string) => { value: T; end: number } | null, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { t.wait = null; closeOnePassword(); reject(new Error('1Password did not answer in time. Approve the request in the 1Password app, then try again.')) }, ms)
    const check = (): boolean => {
      const m = match(t.buf)
      if (!m) return false
      clearTimeout(timer)
      t.buf = t.buf.slice(m.end)
      t.wait = null
      resolve(m.value)
      return true
    }
    if (!check()) t.wait = check
  })
}

async function terminal(): Promise<Terminal> {
  if (term) return term
  const { spawn } = await loadPty()
  const pty = spawn('/bin/bash', ['--noprofile', '--norc'], {
    name: 'dumb',
    cols: 200,
    rows: 24,
    cwd: homedir(),
    env: { ...process.env, TERM: 'dumb', PS1: '', PS2: '', PROMPT_COMMAND: '', HISTFILE: '/dev/null', BASH_SILENCE_DEPRECATION_WARNING: '1' } as Record<string, string>
  })
  const t: Terminal = { pty, buf: '', wait: null }
  pty.onData((d) => {
    t.buf += d.replace(/\r/g, '')
    if (t.buf.length > 256 * 1024 * 1024) t.buf = ''
    t.wait?.(t.buf)
  })
  pty.onExit(() => { if (term === t) term = null })
  term = t
  pty.write(`${SETUP}\n`)
  try {
    await expect(t, (b) => { const i = b.indexOf('__ec2ra_42__\n'); return i < 0 ? null : { value: true, end: i + 13 } }, 10_000)
  } catch (e) {
    closeOnePassword()
    throw e
  }
  return t
}

/** Runs a command in the terminal, one at a time; resolves with its stdout, or rejects with its stderr. */
export function runInTerminal(argv: string[], ms = 120_000): Promise<string> {
  const run = async (): Promise<string> => {
    const t = await terminal()
    const id = `c${++seq}`
    t.pty.write(`r ${id} ${argv.map(shellQuote).join(' ')}\n`)
    const re = new RegExp(`@@${id} (\\d+) ([A-Za-z0-9+/=]*) ([A-Za-z0-9+/=]*)\\n`)
    const r = await expect(t, (b) => {
      const m = re.exec(b)
      return m ? { value: { status: Number(m[1]), out: Buffer.from(m[2], 'base64').toString(), err: Buffer.from(m[3], 'base64').toString() }, end: m.index + m[0].length } : null
    }, ms)
    if (r.status !== 0) throw new Error(r.err.trim() || `exit ${r.status}`)
    return r.out
  }
  const p = queue.then(run, run)
  queue = p.catch(() => undefined)
  return p
}

/** Ends the terminal (on quit, or when a call hung). */
export function closeOnePassword(): void {
  const t = term
  term = null
  try { t?.pty.kill() } catch { /* already gone */ }
}

function op(args: string[]): Promise<string> {
  const bin = findBinary('op')
  if (!bin) return Promise.reject(new Error('The 1Password CLI is not installed. Install it ("brew install 1password-cli"), then turn on 1Password → Settings → Developer → Integrate with 1Password CLI.'))
  // Long timeout: a call may wait for the user to approve in the 1Password app.
  return runInTerminal([bin, ...args]).catch((e: Error) => { throw new Error(friendly(e.message)) })
}

export async function opLogins(refresh = false): Promise<Login[]> {
  if (!refresh && cache && Date.now() - cache.at < CACHE_MS) return cache.logins
  const accounts = JSON.parse(await op(['account', 'list', '--format', 'json'])) as { user_uuid: string; url: string }[]
  const logins: Login[] = []
  for (const a of accounts) {
    type Item = { id: string; title: string; additional_information?: string; vault?: { name?: string }; urls?: { href: string }[] }
    const items = JSON.parse(await op(['item', 'list', '--categories', 'Login', '--format', 'json', '--account', a.user_uuid])) as Item[]
    for (const i of items) {
      logins.push({ id: i.id, account: a.user_uuid, accountName: a.url, title: i.title, username: i.additional_information ?? '', vault: i.vault?.name ?? '', urls: (i.urls ?? []).map((u) => u.href) })
    }
  }
  cache = { at: Date.now(), logins }
  return logins
}

export interface LoginSecrets {
  username?: string
  password?: string
  otp?: string
}

export async function opSecrets(account: string, id: string): Promise<LoginSecrets> {
  type Field = { purpose?: string; type?: string; value?: string; totp?: string }
  const item = JSON.parse(await op(['item', 'get', id, '--account', account, '--format', 'json', '--reveal'])) as { fields?: Field[] }
  const fields = item.fields ?? []
  const otpField = fields.find((f) => f.type === 'OTP')
  // The current code comes with the item as `totp`; if this CLI version leaves it out, ask for it directly.
  const otp = otpField ? otpField.totp ?? (await op(['item', 'get', id, '--account', account, '--otp']).then((s) => s.trim(), () => undefined)) : undefined
  return {
    username: fields.find((f) => f.purpose === 'USERNAME')?.value,
    password: fields.find((f) => f.purpose === 'PASSWORD')?.value,
    otp
  }
}

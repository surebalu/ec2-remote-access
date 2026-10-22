/**
 * Logins from 1Password for the built-in browser, through the 1Password CLI (`op`) and its integration with the
 * 1Password app, which asks the user to approve (Touch ID). Listing returns no secrets; one item's username, password
 * and one-time code are read only when the user picks it to fill a page.
 *
 * 1Password ties an approval to the terminal it was given in (its tty and start time) and to one account, renews it on
 * each use, and ends it after ten minutes without use or twelve hours at most. Run with no terminal, as an app runs it,
 * `op` had none to reuse, so every call asked again, once per account. So every call runs in one pseudo-terminal kept
 * for the app's run, and:
 * - the list of logins (no secrets) is kept on disk, sealed, so opening the panel never asks, even after a restart:
 *   listing asked once per account (twice, with two accounts) on every start. Only filling asks, for its own account,
 *   and that account's list is then brought up to date in the background on the approval just given;
 * - with Settings.onePasswordStayApproved (the default; the panel's switch), an account approved in this run is used
 *   lightly every eight minutes so its approval does not lapse, until 1Password's twelve hours. It never asks by
 *   itself: an approval that may already have lapsed (the Mac slept, the app was busy) is let go instead of renewed.
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { IPty } from 'node-pty'
import type { WebLogin } from '@shared/types'
import { loadPty } from './pty'
import { findBinary, shellQuote } from './util'
import { host } from './host'
import { getSettings } from './store'
import { log } from './log'

type Login = Omit<WebLogin, 'matches'>

interface AccountList { name: string; at: number; logins: Login[] }
let lists: Record<string, AccountList> | null = null
const listFile = (): string => join(host().userDataDir(), 'onepassword-logins.bin')
/** An account's list is brought up to date after a fill when it is older than this. */
const FRESH_MS = 5 * 60_000

/** When each account was last used in this terminal: its approval holds while that is under ten minutes ago. */
const approved = new Map<string, number>()
/** When each account's approval in this terminal began, for 1Password's twelve-hour limit. */
const since = new Map<string, number>()
const KEEP_EVERY_MS = 8 * 60_000
/** Past this the approval may have lapsed, and using it would ask again: let it go. */
const LAPSE_MS = 9 * 60_000
/** 1Password ends every approval at twelve hours; stop renewing a little before. */
const HARD_MS = 11.5 * 60 * 60_000
let keeper: ReturnType<typeof setInterval> | null = null

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
  pty.onExit(() => { if (term === t) { term = null; approved.clear() } })
  term = t
  approved.clear()
  since.clear()
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
  approved.clear()
  try { t?.pty.kill() } catch { /* already gone */ }
}

function op(args: string[]): Promise<string> {
  const bin = findBinary('op')
  if (!bin) return Promise.reject(new Error('The 1Password CLI is not installed. Install it ("brew install 1password-cli"), then turn on 1Password → Settings → Developer → Integrate with 1Password CLI.'))
  // Long timeout: a call may wait for the user to approve in the 1Password app.
  return runInTerminal([bin, ...args]).catch((e: Error) => { throw new Error(friendly(e.message)) })
}

/** A call on one account; success means the account is approved in this terminal now. */
async function opOn(account: string, args: string[]): Promise<string> {
  const out = await op([...args, '--account', account])
  if (!approved.has(account)) since.set(account, Date.now())
  approved.set(account, Date.now())
  startKeeping()
  return out
}

function loadLists(): Record<string, AccountList> | null {
  if (lists) return lists
  try {
    if (!existsSync(listFile())) return null
    lists = JSON.parse(host().decrypt(readFileSync(listFile()))) as Record<string, AccountList>
    return lists
  } catch (e) {
    log('1password', 'saved list unreadable', { error: (e as Error).message })
    return null
  }
}

function saveLists(next: Record<string, AccountList>): void {
  lists = next
  // Names, usernames and addresses only, sealed like saved passwords; kept in memory alone without a secure store.
  const sealed = host().encrypt(JSON.stringify(next))
  if (!sealed) return
  try {
    const tmp = `${listFile()}.tmp`
    writeFileSync(tmp, sealed, { mode: 0o600 })
    renameSync(tmp, listFile())
  } catch (e) { log('1password', 'could not save the list', { error: (e as Error).message }) }
}

async function listAccount(account: string, name: string): Promise<AccountList> {
  type Item = { id: string; title: string; additional_information?: string; vault?: { name?: string }; urls?: { href: string }[] }
  const items = JSON.parse(await opOn(account, ['item', 'list', '--categories', 'Login', '--format', 'json'])) as Item[]
  return {
    name, at: Date.now(),
    logins: items.map((i) => ({ id: i.id, account, accountName: name, title: i.title, username: i.additional_information ?? '', vault: i.vault?.name ?? '', urls: (i.urls ?? []).map((u) => u.href) }))
  }
}

const flat = (l: Record<string, AccountList>): Login[] => Object.values(l).flatMap((a) => a.logins)

/**
 * The logins of every account: the saved list unless `refresh` (the panel's Reload) or there is none yet, which asks
 * 1Password once per account it has not approved in this run.
 */
export async function opLogins(refresh = false): Promise<Login[]> {
  const saved = loadLists()
  if (!refresh && saved) return flat(saved)
  const accounts = JSON.parse(await op(['account', 'list', '--format', 'json'])) as { user_uuid: string; url: string }[]
  const next: Record<string, AccountList> = {}
  for (const a of accounts) next[a.user_uuid] = await listAccount(a.user_uuid, a.url)
  saveLists(next)
  return flat(next)
}

/** After a fill: the account was just approved, so its list is read again at no extra prompt if it is getting old. */
function refreshSoon(account: string): void {
  const have = loadLists()
  const cur = have?.[account]
  if (!have || !cur || Date.now() - cur.at < FRESH_MS) return
  void listAccount(account, cur.name).then((l) => saveLists({ ...loadLists(), [account]: l }), (e: Error) => log('1password', 'background refresh failed', { error: e.message }))
}

/** Renews the approvals given in this run before they lapse, without ever asking (see the top of the file). */
function startKeeping(): void {
  if (keeper) return
  keeper = setInterval(() => {
    if (!getSettings().onePasswordStayApproved || !term) return
    const now = Date.now()
    for (const [account, last] of [...approved]) {
      if (now - last < KEEP_EVERY_MS) continue
      if (now - last > LAPSE_MS || now - (since.get(account) ?? now) > HARD_MS) { approved.delete(account); continue }
      // The lightest call that uses the approval: the account's vault names.
      void opOn(account, ['vault', 'list', '--format', 'json']).catch(() => approved.delete(account))
    }
  }, 30_000)
  keeper.unref?.()
}

export interface LoginSecrets {
  username?: string
  password?: string
  otp?: string
}

export async function opSecrets(account: string, id: string): Promise<LoginSecrets> {
  type Field = { purpose?: string; type?: string; value?: string; totp?: string }
  const item = JSON.parse(await opOn(account, ['item', 'get', id, '--format', 'json', '--reveal'])) as { fields?: Field[] }
  const fields = item.fields ?? []
  const otpField = fields.find((f) => f.type === 'OTP')
  // The current code comes with the item as `totp`; if this CLI version leaves it out, ask for it directly.
  const otp = otpField ? otpField.totp ?? (await opOn(account, ['item', 'get', id, '--otp']).then((s) => s.trim(), () => undefined)) : undefined
  refreshSoon(account)
  return {
    username: fields.find((f) => f.purpose === 'USERNAME')?.value,
    password: fields.find((f) => f.purpose === 'PASSWORD')?.value,
    otp
  }
}

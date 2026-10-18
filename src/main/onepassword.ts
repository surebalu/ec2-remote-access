/**
 * Logins from 1Password for the built-in browser, through the 1Password CLI (`op`) and its integration with the
 * 1Password app, which asks the user to approve (Touch ID) the first time. Listing returns no secrets; one item's
 * username, password and one-time code are read only when the user picks it to fill a page.
 */
import { execFile } from 'node:child_process'
import type { WebLogin } from '@shared/types'
import { findBinary } from './util'

type Login = Omit<WebLogin, 'matches'>

let cache: { at: number; logins: Login[] } | null = null
const CACHE_MS = 2 * 60_000

function friendly(text: string): string {
  const m = text.replace(/^\[ERROR\]\s*\S+\s+\S+\s*/, '').trim()
  if (/dismiss|denied|cancel/i.test(m)) return '1Password did not approve the request.'
  if (/not currently signed in|no accounts|integration|connect/i.test(m)) return `1Password: ${m}. In the 1Password app, turn on Settings → Developer → Integrate with 1Password CLI.`
  return `1Password: ${m}`
}

function op(args: string[]): Promise<string> {
  const bin = findBinary('op')
  if (!bin) return Promise.reject(new Error('The 1Password CLI is not installed. Install it ("brew install 1password-cli"), then turn on 1Password → Settings → Developer → Integrate with 1Password CLI.'))
  // Long timeout: the first call waits for the user to approve in the 1Password app.
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error(friendly(stderr || err.message))) : resolve(stdout)))
  })
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

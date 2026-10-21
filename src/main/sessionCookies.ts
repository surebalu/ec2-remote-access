import { session, type Cookie, type Session } from 'electron'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cookieSet, KEEP_DAYS, restorable, type CookieLike } from '@shared/sessionCookies'
import { host } from './host'
import { log } from './log'

/**
 * Keeps the built-in browser's spaces signed in across restarts (Electron-only, from index.ts and webviews.ts). Sign-in
 * services keep their session in session cookies (JumpCloud's SSO, Quickbase's ticket), which Chromium holds in memory
 * only, so every quit (an update, a restart) sent the next page back to the login however long the service allows.
 * Each space's session cookies are saved a moment after they change and on quit, encrypted with the Keychain
 * (safeStorage, as saved passwords are; never in the clear), and set again before any page loads.
 */

const file = (): string => join(host().userDataDir(), 'browser-session-cookies.bin')
const watched = new Map<string, Session>()
let timer: ReturnType<typeof setTimeout> | null = null
let saving: Promise<void> | null = null

interface Saved { at: number; partitions: Record<string, CookieLike[]> }

/** Puts back the spaces' session cookies from the last run. Call before the window opens. */
export async function restoreSessionCookies(): Promise<void> {
  if (!existsSync(file())) return
  let saved: Saved
  try {
    saved = JSON.parse(host().decrypt(readFileSync(file()))) as Saved
  } catch (e) {
    log('browser', 'saved session cookies unreadable', { error: (e as Error).message })
    return
  }
  if (!saved?.partitions || Date.now() - saved.at > KEEP_DAYS * 86_400_000) return
  let n = 0
  await Promise.all(Object.entries(saved.partitions).map(async ([partition, cookies]) => {
    if (!partition.startsWith('persist:web-')) return
    const ses = session.fromPartition(partition)
    await Promise.all(cookies.filter(restorable).map((c) => ses.cookies.set(cookieSet(c)).then(() => { n++ }, () => undefined)))
    track(partition)
  }))
  log('browser', 'session cookies restored', { spaces: Object.keys(saved.partitions).length, cookies: n })
}

/** Watches a space's cookies from now on (every webview's partition passes through here when it attaches). */
export function track(partition: string): void {
  if (watched.has(partition) || !partition.startsWith('persist:web-')) return
  const ses = session.fromPartition(partition)
  watched.set(partition, ses)
  ses.cookies.on('changed', (_e, cookie: Cookie) => { if (cookie.session) schedule() })
}

function schedule(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { timer = null; void saveSessionCookies() }, 2000)
}

/** Saves every watched space's session cookies now (also on quit). */
export function saveSessionCookies(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null }
  if (saving) return saving.then(() => saveSessionCookies())
  saving = (async () => {
    const partitions: Record<string, CookieLike[]> = {}
    for (const [partition, ses] of watched) {
      const keep = (await ses.cookies.get({}).catch(() => [] as Cookie[])).filter(restorable)
      if (keep.length) partitions[partition] = keep.map((c) => ({ name: c.name, value: c.value, domain: c.domain, hostOnly: c.hostOnly, path: c.path, secure: c.secure, httpOnly: c.httpOnly, session: true, sameSite: c.sameSite }))
    }
    const path = file()
    if (!Object.keys(partitions).length) { rmSync(path, { force: true }); return }
    const sealed = host().encrypt(JSON.stringify({ at: Date.now(), partitions } satisfies Saved))
    // No Keychain to seal them with: rather lose them on quit than leave sign-in cookies on disk in the clear.
    if (!sealed) return
    writeFileSync(`${path}.tmp`, sealed, { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
  })().catch((e: Error) => log('browser', 'saving session cookies failed', { error: e.message })).finally(() => { saving = null })
  return saving
}

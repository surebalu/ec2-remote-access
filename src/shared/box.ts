/**
 * Box as the shared copy of what the app makes (main/box.ts, main/boxSync.ts): Tasks, Calendar, Links and CAD
 * reviews (records), whiteboards, and the files Links keeps. Every computer works from its own copy and syncs with a
 * folder in the person's Box through Box's API, so no computer needs Box Drive (the Raspberry Pi gateway cannot run
 * it) and nothing depends on an employer's account. Pure, for tests/box.test.ts.
 *
 * Sign-in is Box's OAuth 2.0 for a Box app the person made (build/box.json: its client id and secret, shipped like
 * company.json). The Mac app gets Box's answer on a loopback address; the gateway on its own address, which the Box
 * app must list as a redirect URI too. Each computer signs in once and keeps its own tokens (Box's refresh tokens are
 * used once each), sealed like saved passwords.
 */
import { mergeDocs, pruneDeleted, type RecordDoc } from './records.ts'

/** `loopback`: the Mac's redirect as the Box app lists it, when Box took `localhost` rather than 127.0.0.1. */
export interface BoxApp { clientId: string; clientSecret: string; loopback?: string }

/** The folder at the top of the person's Box that holds the app's copy. */
export const BOX_FOLDER = 'Remote Access Tool'
/** The Mac app's redirect: a server of its own on this address while a sign-in waits. */
export const BOX_LOOPBACK_PORT = 53682
export const BOX_LOOPBACK = `http://127.0.0.1:${BOX_LOOPBACK_PORT}/box/callback`
/** The two forms of the Mac's redirect a Box app may list; anything else would wait on an address the app never serves. */
export const BOX_LOOPBACKS = [BOX_LOOPBACK, `http://localhost:${BOX_LOOPBACK_PORT}/box/callback`]
/** Box's simple upload takes files up to 50 MB; larger ones go up in parts through an upload session (uploadLarge). */
export const BOX_SIMPLE_UPLOAD_MAX = 50 * 1024 * 1024

/** The byte ranges (inclusive) an upload session's parts cover: Box's part size each, the last one shorter. */
export function partRanges(size: number, partSize: number): [number, number][] {
  if (size <= 0 || partSize <= 0) return []
  const out: [number, number][] = []
  for (let start = 0; start < size; start += partSize) out.push([start, Math.min(size, start + partSize) - 1])
  return out
}

export interface BoxTokens { accessToken: string; refreshToken: string; expiresAt: number; refreshExpiresAt: number }

export interface BoxStatus {
  /** This build carries a Box app (box.json); without one there is nothing to sign in to. */
  available: boolean
  signedIn: boolean
  user?: { name: string; login: string }
  folder?: { id: string; name: string }
  syncing: boolean
  lastSync?: number
  lastError?: string
  /** Links files sent to Box so far, and those Box would not take (over the account's upload limit). */
  files?: { done: number; total: number; tooLarge: number }
}

export function parseBoxApp(text: string): BoxApp {
  let v: unknown
  try { v = JSON.parse(text) } catch { throw new Error('box.json is not JSON: save it as plain text, {"clientId": "…", "clientSecret": "…"}.') }
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const id = typeof o.clientId === 'string' ? o.clientId.trim() : ''
  const secret = typeof o.clientSecret === 'string' ? o.clientSecret.trim() : ''
  if (!/^[A-Za-z0-9]{16,64}$/.test(id) || !/^[A-Za-z0-9]{16,64}$/.test(secret)) throw new Error('box.json needs the Box app\'s clientId and clientSecret.')
  if (o.loopback !== undefined && !BOX_LOOPBACKS.includes(String(o.loopback))) throw new Error(`box.json's loopback must be one of ${BOX_LOOPBACKS.join(' or ')}.`)
  return { clientId: id, clientSecret: secret, ...(typeof o.loopback === 'string' ? { loopback: o.loopback } : {}) }
}

/**
 * Where Box sends the browser back: the Mac app's loopback address, or the gateway's own page (its https address
 * behind tailscale serve, which the Box app must list). Anything else would let a sign-in end somewhere the app does
 * not control.
 */
export function redirectFor(origin: string | undefined, onMac: boolean, loopback = BOX_LOOPBACK): string {
  if (onMac) return loopback
  const o = (origin ?? '').replace(/\/+$/, '')
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(o)) {
    throw new Error('Box signs in only over https: open this page through its https address (tailscale serve), then try again.')
  }
  return `${o}/box/callback`
}

export function authorizeUrl(app: BoxApp, redirectUri: string, state: string): string {
  const q = new URLSearchParams({ response_type: 'code', client_id: app.clientId, redirect_uri: redirectUri, state })
  return `https://account.box.com/api/oauth2/authorize?${q.toString()}`
}

/** Box's refresh tokens last 60 days unused; each use gives a new one. */
const REFRESH_LIFE_MS = 60 * 24 * 3600 * 1000

export function tokensFrom(res: unknown, now = Date.now()): BoxTokens {
  const o = (res && typeof res === 'object' ? res : {}) as Record<string, unknown>
  if (typeof o.access_token !== 'string' || typeof o.refresh_token !== 'string') {
    const why = typeof o.error_description === 'string' ? o.error_description : typeof o.error === 'string' ? o.error : 'no tokens in the answer'
    throw new Error(`Box did not sign in: ${why}.`)
  }
  const life = typeof o.expires_in === 'number' && o.expires_in > 0 ? o.expires_in : 3600
  return { accessToken: o.access_token, refreshToken: o.refresh_token, expiresAt: now + life * 1000, refreshExpiresAt: now + REFRESH_LIFE_MS }
}

/** Refreshed a few minutes early, so a call never starts with a token about to lapse. */
export const needsRefresh = (t: BoxTokens, now = Date.now()): boolean => now >= t.expiresAt - 5 * 60_000

/** A failed Box call in words the app can show. */
export function boxError(status: number, body: unknown): string {
  const o = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const msg = typeof o.message === 'string' ? o.message : typeof o.error_description === 'string' ? o.error_description : ''
  if (status === 401) return 'Box signed this computer out. Sign in to Box again (Settings → Data).'
  if (status === 403) return `Box refused${msg ? `: ${msg}` : ''}. The Box app may lack "Read and write all files and folders".`
  if (status === 404) return 'Box could not find the app\'s folder or a file in it.'
  if (status === 429) return 'Box asked to slow down; the next sync tries again.'
  if (status >= 500) return 'Box is having trouble; the next sync tries again.'
  return `Box answered ${status}${msg ? `: ${msg}` : ''}.`
}

// ----- one shared document, merged item by item -----

/** A file in Box as the sync sees it: its text and the version tag a write must name (If-Match). */
export interface RemoteDoc {
  read(): Promise<{ text: string; etag: string } | null>
  /** Writes when the file is still at `etag` (null: when it does not exist yet); 'conflict' when someone wrote first. */
  write(text: string, etag: string | null): Promise<'ok' | 'conflict'>
}

/**
 * Merges this computer's copy with Box's: theirs into mine first (adopt: saved and shown here at once), then whatever
 * only this computer has back to Box, written only over the version just read. When another computer wrote in
 * between, it reads again and merges again, so no change from either side is lost.
 */
export async function syncDoc(remote: RemoteDoc, mine: () => RecordDoc, adopt: (theirs: RecordDoc) => Promise<void>, tries = 4): Promise<'created' | 'pushed' | 'pulled' | 'same'> {
  for (let n = 0; n < tries; n++) {
    const r = await remote.read()
    if (!r) {
      if (await remote.write(JSON.stringify(mine()), null) === 'ok') return 'created'
      continue
    }
    let theirs: RecordDoc
    try {
      const raw = JSON.parse(r.text) as RecordDoc
      if (!raw || typeof raw.rev !== 'number' || !raw.items || typeof raw.items !== 'object') throw new Error('bad')
      theirs = pruneDeleted(raw)
    } catch {
      throw new Error('A records file in Box could not be read, so it was left as it is.')
    }
    await adopt(theirs)
    const merged = mine()
    if (!mergeDocs(theirs, merged).changed) return 'pulled'
    if (await remote.write(JSON.stringify(merged), r.etag) === 'ok') return 'pushed'
  }
  throw new Error('Box kept changing while this computer synced; the next sync tries again.')
}

/** The name a Links file gets in Box: its path below the Links files' folder, else just its name under "Other". */
export function linkFileKey(path: string, root: string): string[] {
  const r = root.replace(/\/+$/, '')
  const rel = path.startsWith(`${r}/`) ? path.slice(r.length + 1) : `Other/${path.split('/').pop() ?? 'file'}`
  return rel.split('/').filter(Boolean)
}

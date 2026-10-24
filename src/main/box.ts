import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { authorizeUrl, BOX_LOOPBACK, BOX_LOOPBACK_PORT, boxError, needsRefresh, parseBoxApp, partRanges, redirectFor, tokensFrom, type BoxApp, type BoxTokens } from '@shared/box'
import { host } from './host'
import { log } from './log'

/**
 * Box's API for the sync (boxSync.ts): signing in with the Box app in box.json, keeping this computer's tokens sealed
 * (host().encrypt: the Keychain on the Mac, gateway.key on the gateway), refreshing them, and the few calls the sync
 * needs (folders, listing, download, upload with If-Match, delete). The rules are src/shared/box.ts.
 */

export class BoxHttpError extends Error {
  constructor(readonly status: number, message: string, readonly body: unknown) { super(message) }
}

export interface BoxItem { type: 'file' | 'folder' | 'web_link'; id: string; name: string; etag?: string; sha1?: string; size?: number }

let app: BoxApp | null | undefined
/** The Box app: Resources/box.json in the Mac app, box-app.json in the gateway's data folder (deploy-pi.sh), build/box.json under pnpm dev. */
export function boxApp(): BoxApp | null {
  if (app !== undefined) return app
  app = null
  const resources = (process as { resourcesPath?: string }).resourcesPath
  const files = [resources ? join(resources, 'box.json') : '', join(host().userDataDir(), 'box-app.json'), process.versions.electron ? join(process.cwd(), 'build', 'box.json') : '']
  for (const f of files) {
    if (!f || !existsSync(f)) continue
    try {
      app = parseBoxApp(readFileSync(f, 'utf8'))
      break
    } catch (e) {
      log('box', `ignoring ${f}: ${(e as Error).message}`)
    }
  }
  return app
}

// ----- tokens -----

const tokenFile = (): string => join(host().userDataDir(), 'box-tokens.bin')
let tokens: BoxTokens | null | undefined

function loadTokens(): BoxTokens | null {
  if (tokens !== undefined) return tokens
  tokens = null
  try {
    if (existsSync(tokenFile())) tokens = JSON.parse(host().decrypt(readFileSync(tokenFile()))) as BoxTokens
  } catch (e) {
    log('box', `the saved sign-in could not be read: ${(e as Error).message}`)
  }
  return tokens
}

function saveTokens(t: BoxTokens | null): void {
  tokens = t
  if (!t) { rmSync(tokenFile(), { force: true }); return }
  const sealed = host().encrypt(JSON.stringify(t))
  if (!sealed) throw new Error('This computer has no secure place for the Box sign-in.')
  const tmp = `${tokenFile()}.tmp`
  writeFileSync(tmp, sealed, { mode: 0o600 })
  renameSync(tmp, tokenFile())
}

export const boxSignedIn = (): boolean => !!loadTokens()

/** Told when the sign-in changes (signed in, refreshed into nothing, signed out), so the sync can start or stop. */
const changes = new Set<() => void>()
export function onBoxSignIn(cb: () => void): () => void { changes.add(cb); return () => changes.delete(cb) }
const changed = (): void => { for (const cb of changes) cb() }

async function tokenCall(form: Record<string, string>): Promise<BoxTokens> {
  const a = boxApp()
  if (!a) throw new Error('This build has no Box app (build/box.json).')
  const res = await fetch('https://api.box.com/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...form, client_id: a.clientId, client_secret: a.clientSecret })
  })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    if (body.error === 'invalid_grant' && form.grant_type === 'refresh_token') {
      saveTokens(null)
      changed()
      throw new Error('The Box sign-in on this computer has run out. Sign in to Box again (Settings → Data).')
    }
    throw new Error(`Box did not sign in: ${String(body.error_description ?? body.error ?? res.status)}.`)
  }
  return tokensFrom(body)
}

let refreshing: Promise<string> | null = null
async function accessToken(force = false): Promise<string> {
  const t = loadTokens()
  if (!t) throw new Error('Not signed in to Box.')
  if (!force && !needsRefresh(t)) return t.accessToken
  // One refresh at a time: Box's refresh tokens are used once, so two at once would sign this computer out.
  refreshing ??= tokenCall({ grant_type: 'refresh_token', refresh_token: t.refreshToken })
    .then((next) => { saveTokens(next); return next.accessToken })
    .finally(() => { refreshing = null })
  return refreshing
}

// ----- calls -----

export async function boxFetch(path: string, init: RequestInit = {}, again = true): Promise<Response> {
  const token = await accessToken()
  const url = path.startsWith('https://') ? path : `https://api.box.com/2.0${path}`
  // A connection that stops answering would hold up the sync for good: two minutes is ample for a 50 MB upload.
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000), ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` } })
  if (res.status === 401 && again) { await accessToken(true); return boxFetch(path, init, false) }
  if (res.status === 429 && again) {
    const wait = Math.min(10, Number(res.headers.get('retry-after')) || 2)
    await new Promise((r) => setTimeout(r, wait * 1000))
    return boxFetch(path, init, false)
  }
  return res
}

export async function boxJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await boxFetch(path, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new BoxHttpError(res.status, boxError(res.status, body), body)
  return body as T
}

const FIELDS = 'name,type,etag,sha1,size'

export async function listFolder(id: string): Promise<BoxItem[]> {
  const out: BoxItem[] = []
  for (let offset = 0; ; offset += 1000) {
    const page = await boxJson<{ entries: BoxItem[]; total_count: number }>(`/folders/${id}/items?fields=${FIELDS}&limit=1000&offset=${offset}`)
    out.push(...page.entries)
    if (!page.entries.length || out.length >= page.total_count) return out
  }
}

/** The folder by that name in `parentId` (Box compares names without case), made when there is none. */
export async function folderIn(parentId: string, name: string): Promise<string> {
  const hit = (await listFolder(parentId)).find((e) => e.type === 'folder' && e.name.toLowerCase() === name.toLowerCase())
  if (hit) return hit.id
  const res = await boxFetch('/folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, parent: { id: parentId } }) })
  const body = (await res.json().catch(() => ({}))) as { id?: string; context_info?: { conflicts?: { id: string }[] } }
  // Made meanwhile by another computer: that one.
  if (res.status === 409 && body.context_info?.conflicts?.[0]?.id) return body.context_info.conflicts[0].id
  if (!res.ok || !body.id) throw new BoxHttpError(res.status, boxError(res.status, body), body)
  return body.id
}

export async function fileInfo(id: string): Promise<BoxItem> {
  return boxJson<BoxItem>(`/files/${id}?fields=${FIELDS}`)
}

export async function download(id: string): Promise<Buffer> {
  const res = await boxFetch(`/files/${id}/content`)
  if (!res.ok) throw new BoxHttpError(res.status, boxError(res.status, await res.json().catch(() => ({}))), null)
  return Buffer.from(await res.arrayBuffer())
}

/**
 * A new file in `parentId`, or a new version of `existing` written only if it is still at `existing.etag`. 'conflict'
 * when someone else wrote first (412), or a file by that name appeared (409): the caller reads again.
 */
export async function upload(parentId: string, name: string, bytes: Buffer, existing?: { id: string; etag?: string }): Promise<BoxItem | 'conflict'> {
  // Box wants the attributes before the file.
  const form = new FormData()
  form.append('attributes', JSON.stringify(existing ? { name } : { name, parent: { id: parentId } }))
  form.append('file', new Blob([new Uint8Array(bytes)]), name)
  const url = existing ? `https://upload.box.com/api/2.0/files/${existing.id}/content?fields=${FIELDS}` : `https://upload.box.com/api/2.0/files/content?fields=${FIELDS}`
  const res = await boxFetch(url, { method: 'POST', body: form, headers: existing?.etag ? { 'if-match': existing.etag } : {} })
  if (res.status === 412 || res.status === 409) return 'conflict'
  const body = (await res.json().catch(() => ({}))) as { entries?: BoxItem[] }
  if (!res.ok || !body.entries?.[0]) throw new BoxHttpError(res.status, boxError(res.status, body), body)
  return body.entries[0]
}

interface UploadSession { id: string; part_size: number; session_endpoints: { upload_part: string; commit: string; abort: string } }
interface UploadedPart { part_id: string; offset: number; size: number; sha1: string }

/**
 * A new file over the simple upload's 50 MB, sent in parts through an upload session: each part with its SHA-1, read
 * from disk one part at a time (never the whole file in memory), then committed with the whole file's SHA-1. A failed
 * part ends the session (abort) so Box keeps nothing half-made. 'conflict' when a file by that name is already there;
 * 'too-large' when the person's Box plan does not take a file that size.
 */
export async function uploadLarge(parentId: string, name: string, path: string, size: number): Promise<BoxItem | 'conflict' | 'too-large'> {
  const res = await boxFetch('https://upload.box.com/api/2.0/files/upload_sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folder_id: parentId, file_size: size, file_name: name })
  })
  const body = (await res.json().catch(() => ({}))) as UploadSession & { code?: string }
  if (res.status === 409) return 'conflict'
  if (res.status === 413 || body.code === 'file_size_limit_exceeded' || body.code === 'storage_limit_exceeded') return 'too-large'
  if (!res.ok) throw new BoxHttpError(res.status, boxError(res.status, body), body)
  const whole = createHash('sha1')
  const parts: UploadedPart[] = []
  const file = await open(path, 'r')
  try {
    for (const [start, end] of partRanges(size, body.part_size)) {
      const buf = Buffer.alloc(end - start + 1)
      await file.read(buf, 0, buf.length, start)
      whole.update(buf)
      const digest = `sha=${createHash('sha1').update(buf).digest('base64')}`
      // A part Box fails to take (5xx) is sent again, up to three times, before the whole upload is given up.
      for (let attempt = 1; ; attempt++) {
        const r = await boxFetch(body.session_endpoints.upload_part, {
          method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'content-range': `bytes ${start}-${end}/${size}`, digest }, body: buf
        })
        const part = (await r.json().catch(() => ({}))) as { part?: UploadedPart }
        if (r.ok && part.part) { parts.push(part.part); break }
        if (r.status < 500 || attempt >= 3) throw new BoxHttpError(r.status, boxError(r.status, part), part)
        await new Promise((res) => setTimeout(res, attempt * 1000))
      }
    }
  } catch (e) {
    await boxFetch(body.session_endpoints.abort, { method: 'DELETE' }).catch(() => undefined)
    throw e
  } finally {
    await file.close()
  }
  const digest = `sha=${whole.digest('base64')}`
  // Box may still be putting the parts together: 202 with Retry-After, then the same commit again.
  for (let n = 0; n < 30; n++) {
    const c = await boxFetch(body.session_endpoints.commit, { method: 'POST', headers: { 'content-type': 'application/json', digest }, body: JSON.stringify({ parts }) })
    if (c.status === 202) { await new Promise((r) => setTimeout(r, Math.min(10, Number(c.headers.get('retry-after')) || 2) * 1000)); continue }
    const done = (await c.json().catch(() => ({}))) as { entries?: BoxItem[] }
    if (!c.ok || !done.entries?.[0]) throw new BoxHttpError(c.status, boxError(c.status, done), done)
    return done.entries[0]
  }
  throw new Error(`Box did not finish putting ${name} together; the next sync tries again.`)
}

export async function removeFile(id: string): Promise<void> {
  const res = await boxFetch(`/files/${id}`, { method: 'DELETE' })
  if (!res.ok && res.status !== 404) throw new BoxHttpError(res.status, boxError(res.status, await res.json().catch(() => ({}))), null)
}

// ----- signing in -----

interface Pending { redirectUri: string; at: number }
const pending = new Map<string, Pending>()
let loopback: Server | null = null
let loopback6: Server | null = null
let loopbackTimer: NodeJS.Timeout | null = null
/** After a sign-in: the person's name, for the status. */
let signedInHook: ((user: { name: string; login: string }) => Promise<void>) | null = null
export function onBoxConnected(cb: (user: { name: string; login: string }) => Promise<void>): void { signedInHook = cb }

/**
 * Where to approve the app in Box. The Mac app (Electron) waits for the answer on its loopback address and opens the
 * browser itself; the gateway hands the address to the page, which opens it, and gets the answer on /box/callback.
 */
export async function boxSignIn(origin?: string): Promise<{ url: string; opened: boolean }> {
  const a = boxApp()
  if (!a) throw new Error('This build has no Box app: add build/box.json and build again.')
  const onMac = !!process.versions.electron
  // A phone paired with the Mac asks with its own origin: the Mac signs in on its own screen (its loopback address).
  if (onMac && origin) throw new Error('This Mac signs in to Box on its own screen: Settings → Data on the Mac.')
  const redirectUri = redirectFor(origin, onMac, a.loopback)
  const state = randomBytes(24).toString('base64url')
  for (const [k, p] of pending) if (Date.now() - p.at > 10 * 60_000) pending.delete(k)
  pending.set(state, { redirectUri, at: Date.now() })
  const url = authorizeUrl(a, redirectUri, state)
  if (!onMac) return { url, opened: false }
  await listenLoopback(redirectUri)
  await host().openExternal(url)
  return { url, opened: true }
}

function listenLoopback(redirectUri: string): Promise<void> {
  if (loopbackTimer) clearTimeout(loopbackTimer)
  loopbackTimer = setTimeout(stopLoopback, 10 * 60_000)
  loopbackTimer.unref?.()
  if (loopback) return Promise.resolve()
  // "localhost" may reach the IPv6 loopback first: answer there too (a second listener, best effort).
  if (redirectUri.includes('//localhost:')) {
    const v6 = createServer((req, res) => void answer(req.url, res))
    v6.on('error', () => undefined)
    v6.listen(BOX_LOOPBACK_PORT, '::1')
    loopback6 = v6
  }
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => void answer(req.url, res))
    server.once('error', (e: NodeJS.ErrnoException) => {
      reject(new Error(e.code === 'EADDRINUSE'
        ? `Port ${BOX_LOOPBACK_PORT} is in use by another program (rclone uses it too); quit it and sign in again.`
        : `Could not wait for Box's answer: ${e.message}`))
    })
    server.listen(BOX_LOOPBACK_PORT, '127.0.0.1', () => { loopback = server; resolve() })
  })
}

async function answer(path: string | undefined, res: import('node:http').ServerResponse): Promise<void> {
  const u = new URL(path ?? '/', BOX_LOOPBACK)
  if (u.pathname !== '/box/callback') { res.writeHead(404).end(); return }
  const html = await boxCallback(u.searchParams)
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html)
  if (!pending.size) stopLoopback()
}

function stopLoopback(): void {
  loopback?.close()
  loopback6?.close()
  loopback = loopback6 = null
  if (loopbackTimer) clearTimeout(loopbackTimer)
  loopbackTimer = null
}

const page = (title: string, text: string): string =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<body style="font:15px -apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#1d1d1f;background:#f5f5f7">` +
  `<div style="max-width:420px;padding:28px;border-radius:16px;background:#fff;box-shadow:0 8px 30px rgba(0,0,0,.08);text-align:center"><h2 style="margin:0 0 8px">${title}</h2><p style="margin:0;color:#6e6e73">${text}</p></div>`

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/** Box's answer (on the loopback address, or the gateway's /box/callback): the code becomes this computer's tokens. */
export async function boxCallback(q: URLSearchParams): Promise<string> {
  const state = q.get('state') ?? ''
  const p = pending.get(state)
  if (!p) return page('Not signed in', 'This sign-in is not one this computer started, or it is more than ten minutes old. Start it again from Settings → Data.')
  pending.delete(state)
  if (q.get('error')) return page('Not signed in', esc(q.get('error_description') ?? 'Box was not allowed to connect.'))
  const code = q.get('code')
  if (!code) return page('Not signed in', 'Box sent no code back.')
  try {
    saveTokens(await tokenCall({ grant_type: 'authorization_code', code, redirect_uri: p.redirectUri }))
    const user = await boxJson<{ name: string; login: string }>('/users/me?fields=name,login')
    log('box', 'signed in', { login: user.login })
    await signedInHook?.({ name: user.name, login: user.login })
    changed()
    return page('Box is connected', `Signed in as ${esc(user.name)} (${esc(user.login)}). You can close this tab; the app syncs now.`)
  } catch (e) {
    log('box', `sign-in failed: ${(e as Error).message}`)
    return page('Not signed in', esc((e as Error).message))
  }
}

export async function boxSignOut(): Promise<void> {
  const t = loadTokens()
  const a = boxApp()
  saveTokens(null)
  changed()
  if (t && a) {
    // Box forgets the token too, so it cannot be used from a copy of this computer's data.
    await fetch('https://api.box.com/oauth2/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: a.clientId, client_secret: a.clientSecret, token: t.refreshToken }) }).catch(() => undefined)
  }
}

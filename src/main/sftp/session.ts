/**
 * SFTP sessions for the "Files" tab.
 *
 * Reuses the SSH stack: same route decision (direct TCP or SSM AWS-StartSSHSession stream), same identity/agent
 * configuration, one ssh2 Client per tab with a single SFTP channel. Transfers run one at a time per session
 * (SFTP throughput does not improve with parallel files over one channel) and report progress to the renderer.
 */
import ssh2, { type ConnectConfig, type SFTPWrapper } from 'ssh2'
const { Client } = ssh2
type Client = InstanceType<typeof ssh2.Client>
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join as joinLocal } from 'node:path'
import { posix } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { SftpEntry, SftpEvent, SftpOpenRequest, SftpSessionInfo, SftpTransfer } from '@shared/types'
import { host } from '../host'
import { findInstance } from '../aws/inventory'
import { decideRoute, defaultSshUser } from '../connect/route'
import { authConfig } from '../ssh/session'
import { lookupClient, registerClient, unregisterClient } from '../ssh/clients'
import { startSshStream, type SsmHandle } from '../ssm/session'
import { getSettings } from '../store'
import { uid } from '../util'
import { transferSafely, type ConflictChoice } from './safeTransfer'
import { localDestination, remoteDestination } from './destinations'

interface Live {
  info: SftpSessionInfo
  client: Client
  sftp: SFTPWrapper
  ssm?: SsmHandle
  queue: Transfer[]
  running?: Transfer
  /** True when the client belongs to another session (SSH tab) and must not be ended here. */
  shared?: boolean
}

interface Transfer {
  state: SftpTransfer
  cancelled?: boolean
  /** Called to abort the in-flight stream. */
  abort?: () => void
}

const sessions = new Map<string, Live>()
/** Finished transfers are kept per session until cleared so the panel can show history. */
const history = new Map<string, SftpTransfer[]>()

function send<T>(channel: string, payload: T): void {
  host().broadcast(channel, payload)
}
const emitEvent = (ev: SftpEvent): void => send('sftp:event', ev)
const emitTransfer = (t: SftpTransfer): void => send('sftp:transfer', { ...t })

/* ---------------------------------------------------------------- connect */

export async function openSftp(req: SftpOpenRequest): Promise<SftpSessionInfo> {
  const inst = findInstance(req.instanceKey)
  const route = decideRoute(inst, req.forceRoute)
  if (route.route === 'unreachable' || route.route === 'not-running') throw new Error(route.reason)
  const s = getSettings()
  const ov = s.overrides[inst.key]
  const user = req.user || defaultSshUser(inst)
  const port = req.port ?? ov?.sshPort ?? 22
  if (sessions.has(req.sessionId)) await closeSftp(req.sessionId)
  const title = `${inst.name} @ ${inst.profile}`

  // Reuse an authenticated connection from another tab to the same host and user when offered.
  const sharedClient = lookupClient(req.reuseSessionId, inst.key, user)
  if (sharedClient) {
    try {
      const sftp = await new Promise<SFTPWrapper>((resolve, reject) => sharedClient.client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp))))
      const home = await new Promise<string>((resolve, reject) => sftp.realpath('.', (err, p) => (err ? reject(err) : resolve(p))))
      const info: SftpSessionInfo = { sessionId: req.sessionId, instanceKey: inst.key, title, route: route.route, host: route.host ?? inst.instanceId, user, home }
      const live: Live = { info, client: sharedClient.client, sftp, queue: [], shared: true }
      sessions.set(req.sessionId, live)
      sharedClient.users.add(req.sessionId)
      sharedClient.client.once('close', () => {
        if (sessions.get(req.sessionId) === live) {
          emitEvent({ sessionId: req.sessionId, type: 'closed', message: 'Disconnected (the shared SSH session ended)' })
          void closeSftp(req.sessionId)
        }
      })
      return info
    } catch (e) {
      console.warn('[sftp] could not reuse connection, logging in:', (e as Error).message)
    }
  }

  const base: ConnectConfig = {
    username: user,
    readyTimeout: s.connectTimeoutSec * 1000,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 4,
    tryKeyboard: false,
    ...(await authConfig(req, inst))
  }
  let ssm: SsmHandle | undefined
  if (route.route === 'ssm') {
    const r = await startSshStream(inst, port)
    ssm = r.handle
    base.sock = r.stream
  } else {
    base.host = route.host
    base.port = port
  }

  const client = new Client()
  try {
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      client.once('ready', () => client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp))))
      client.once('error', reject)
      client.connect(base)
    })
    const home = await new Promise<string>((resolve, reject) => sftp.realpath('.', (err, p) => (err ? reject(err) : resolve(p))))
    const info: SftpSessionInfo = { sessionId: req.sessionId, instanceKey: inst.key, title, route: route.route, host: route.host ?? inst.instanceId, user, home }
    const live: Live = { info, client, sftp, ssm, queue: [] }
    sessions.set(req.sessionId, live)
    registerClient(req.sessionId, { client, instanceKey: inst.key, user })
    client.on('error', (e) => emitEvent({ sessionId: req.sessionId, type: 'error', message: e.message }))
    client.on('close', () => {
      if (sessions.get(req.sessionId) === live) {
        emitEvent({ sessionId: req.sessionId, type: 'closed', message: 'Disconnected' })
        void closeSftp(req.sessionId)
      }
    })
    return info
  } catch (e) {
    client.destroy()
    await ssm?.terminate()
    throw friendly(e as Error)
  }
}

function friendly(e: Error): Error {
  if (/All configured authentication methods failed/.test(e.message)) return new Error('SSH authentication failed: check the username, identity file, or agent.')
  if (/ECONNREFUSED/.test(e.message)) return new Error('Connection refused: no SSH server on that port. Windows hosts need the OpenSSH Server feature for file transfer.')
  if (/Timed out|ETIMEDOUT/.test(e.message))
    return new Error(
      'No SSH server answered on the SFTP port. On a Windows host, enable Settings › Optional features › "OpenSSH Server", start the sshd service and allow port 22 in its firewall; the tool then signs in with your saved RDP credentials. If the host is Linux, check that it is reachable from this Mac (VPN?).'
    )
  return e
}

function live(sessionId: string): Live {
  const l = sessions.get(sessionId)
  if (!l) throw new Error('File session is not connected.')
  return l
}

export async function closeSftp(sessionId: string): Promise<void> {
  const l = sessions.get(sessionId)
  if (!l) return
  sessions.delete(sessionId)
  for (const t of [l.running, ...l.queue]) {
    if (!t) continue
    t.cancelled = true
    t.abort?.()
    if (t.state.status === 'queued' || t.state.status === 'running') {
      t.state.status = 'cancelled'
      emitTransfer(t.state)
    }
  }
  try {
    l.sftp.end()
  } catch {
    /* ignore */
  }
  if (l.shared) return // the connection belongs to another tab
  unregisterClient(sessionId)
  l.client.end()
  l.client.destroy()
  await l.ssm?.terminate()
}

export async function closeAllSftp(): Promise<void> {
  await Promise.all(Array.from(sessions.keys()).map((id) => closeSftp(id)))
}

/* ---------------------------------------------------------------- browse */

const S_IFMT = 0o170000
function typeOf(mode: number): SftpEntry['type'] {
  const t = mode & S_IFMT
  return t === 0o040000 ? 'dir' : t === 0o100000 ? 'file' : t === 0o120000 ? 'link' : 'other'
}

function readdirP(sftp: SFTPWrapper, path: string): Promise<SftpEntry[]> {
  return new Promise((resolve, reject) =>
    sftp.readdir(path, (err, list) => {
      if (err) return reject(err)
      resolve(
        list
          .filter((f) => f.filename !== '.' && f.filename !== '..')
          .map((f) => ({
            name: f.filename,
            path: posix.join(path, f.filename),
            type: typeOf(f.attrs.mode),
            size: f.attrs.size,
            mtime: f.attrs.mtime * 1000,
            mode: f.attrs.mode
          }))
      )
    })
  )
}
const statP = (sftp: SFTPWrapper, path: string): Promise<{ mode: number; size: number }> =>
  new Promise((resolve, reject) => sftp.stat(path, (err, st) => (err ? reject(err) : resolve({ mode: st.mode, size: st.size }))))
/** mkdir that tolerates an existing directory (SFTP status 4 = FAILURE is what most servers return for EEXIST). */
const mkdirP = (sftp: SFTPWrapper, path: string): Promise<void> =>
  new Promise((resolve, reject) =>
    sftp.mkdir(path, (err) => {
      if (!err) return resolve()
      sftp.stat(path, (e2, st) => (!e2 && typeOf(st.mode) === 'dir' ? resolve() : reject(err)))
    })
  )
const unlinkP = (sftp: SFTPWrapper, path: string): Promise<void> => new Promise((resolve, reject) => sftp.unlink(path, (err) => (err ? reject(err) : resolve())))
const rmdirP = (sftp: SFTPWrapper, path: string): Promise<void> => new Promise((resolve, reject) => sftp.rmdir(path, (err) => (err ? reject(err) : resolve())))

export async function listSftp(sessionId: string, path: string): Promise<SftpEntry[]> {
  const { sftp } = live(sessionId)
  const entries = await readdirP(sftp, path)
  // Symlinks: resolve so the UI can navigate into linked directories.
  await Promise.all(
    entries
      .filter((e) => e.type === 'link')
      .map(async (e) => {
        try {
          const st = await statP(sftp, e.path)
          if (typeOf(st.mode) === 'dir') e.type = 'dir'
          else e.size = st.size
        } catch {
          /* dangling link */
        }
      })
  )
  return entries.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

export function realpathSftp(sessionId: string, path: string): Promise<string> {
  const { sftp } = live(sessionId)
  return new Promise((resolve, reject) => sftp.realpath(path, (err, p) => (err ? reject(err) : resolve(p))))
}

export async function mkdirSftp(sessionId: string, path: string): Promise<void> {
  const { sftp } = live(sessionId)
  await new Promise<void>((resolve, reject) => sftp.mkdir(path, (err) => (err ? reject(err) : resolve())))
}

export function renameSftp(sessionId: string, from: string, to: string): Promise<void> {
  const { sftp } = live(sessionId)
  return new Promise((resolve, reject) => sftp.rename(from, to, (err) => (err ? reject(err) : resolve())))
}

export async function deleteSftp(sessionId: string, entries: SftpEntry[]): Promise<void> {
  const { sftp } = live(sessionId)
  const rm = async (e: SftpEntry): Promise<void> => {
    if (e.type === 'dir') {
      for (const child of await readdirP(sftp, e.path)) await rm(child)
      await rmdirP(sftp, e.path)
    } else await unlinkP(sftp, e.path)
  }
  for (const e of entries) await rm(e)
}

/* ---------------------------------------------------------------- transfers */

export function listTransfers(sessionId: string): SftpTransfer[] {
  const l = sessions.get(sessionId)
  const active = l ? [l.running, ...l.queue].filter((t): t is Transfer => !!t).map((t) => t.state) : []
  return [...(history.get(sessionId) ?? []), ...active]
}

export function clearTransfers(sessionId: string): void {
  history.set(sessionId, [])
}

export function cancelTransfer(transferId: string): void {
  for (const l of sessions.values()) {
    const queued = l.queue.findIndex((t) => t.state.id === transferId)
    if (queued >= 0) {
      const [t] = l.queue.splice(queued, 1)
      t.state.status = 'cancelled'
      remember(t.state)
      emitTransfer(t.state)
      return
    }
    if (l.running?.state.id === transferId) {
      l.running.cancelled = true
      l.running.abort?.()
      return
    }
  }
}

function remember(t: SftpTransfer): void {
  const h = history.get(t.sessionId) ?? []
  h.push(t)
  if (h.length > 200) h.splice(0, h.length - 200)
  history.set(t.sessionId, h)
}

function enqueue(l: Live, kind: SftpTransfer['kind'], localPath: string, remotePath: string, total: number): void {
  const state: SftpTransfer = { id: uid('xfer'), sessionId: l.info.sessionId, kind, name: kind === 'upload' ? basename(localPath) : posix.basename(remotePath), localPath, remotePath, total, done: 0, status: 'queued' }
  l.queue.push({ state })
  emitTransfer(state)
  void pump(l)
}

async function pump(l: Live): Promise<void> {
  if (l.running) return
  const next = l.queue.shift()
  if (!next) return
  l.running = next
  const st = next.state
  st.status = 'running'
  emitTransfer(st)
  let lastEmit = 0
  const progress = (n: number): void => {
    st.done = n
    const now = Date.now()
    if (now - lastEmit > 100) {
      lastEmit = now
      emitTransfer(st)
    }
  }
  try {
    st.status = st.kind === 'upload' ? await uploadFile(l, next, progress) : await downloadFile(l, next, progress)
    if (st.status === 'done') st.done = st.total
  } catch (e) {
    st.status = /cancelled/.test((e as Error).message) ? 'cancelled' : 'error'
    st.message = (e as Error).message
  } finally {
    remember(st)
    emitTransfer(st)
    l.running = undefined
    if (sessions.get(l.info.sessionId) === l) void pump(l)
  }
}

/** Counts bytes flowing through so progress is stream-agnostic. */
function counter(onBytes: (n: number) => void): Transform {
  let n = 0
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      n += chunk.length
      onBytes(n)
      cb(null, chunk)
    }
  })
}

async function chooseConflict(l: Live, t: Transfer, path: string): Promise<ConflictChoice> {
  if (t.cancelled || sessions.get(l.info.sessionId) !== l) return 'cancel'
  const response = await host().askQuestion({
    title: 'File already exists', message: `A file named “${posix.basename(path)}” already exists.`,
    detail: `${t.state.kind === 'upload' ? `Upload to ${l.info.title}` : 'Download to this Mac'}\nDestination: ${path}\nSource: ${t.state.kind === 'upload' ? t.state.localPath : t.state.remotePath}\n\nReplace updates this file only after the transfer completes. Keep both creates a numbered copy.`,
    buttons: ['Keep both', 'Skip', 'Replace', 'Cancel transfer'], defaultId: 0, cancelId: 3
  })
  return (['keep-both', 'skip', 'replace', 'cancel'] as const)[response] ?? 'cancel'
}

async function uploadFile(l: Live, t: Transfer, progress: (n: number) => void): Promise<'done' | 'skipped'> {
  return transferSafely(t.state.remotePath, remoteDestination(l.sftp, async (temp) => {
    const src = createReadStream(t.state.localPath, { highWaterMark: 256 * 1024 })
    const dst = l.sftp.createWriteStream(temp, { flags: 'wx', highWaterMark: 256 * 1024 } as never)
    t.abort = () => src.destroy(new Error('cancelled'))
    await pipeline(src, counter(progress), dst)
  }), (path) => chooseConflict(l, t, path), () => !!t.cancelled || sessions.get(l.info.sessionId) !== l, (path) => {
    t.state.remotePath = path
    t.state.name = posix.basename(path)
    emitTransfer(t.state)
  })
}

async function downloadFile(l: Live, t: Transfer, progress: (n: number) => void): Promise<'done' | 'skipped'> {
  await mkdir(dirname(t.state.localPath), { recursive: true })
  return transferSafely(t.state.localPath, localDestination(async (temp) => {
    const src = l.sftp.createReadStream(t.state.remotePath, { highWaterMark: 256 * 1024 } as never)
    const dst = createWriteStream(temp, { flags: 'wx' })
    t.abort = () => src.destroy(new Error('cancelled'))
    await pipeline(src, counter(progress), dst)
  }), (path) => chooseConflict(l, t, path), () => !!t.cancelled || sessions.get(l.info.sessionId) !== l, (path) => {
    t.state.localPath = path
    t.state.name = basename(path)
    emitTransfer(t.state)
  })
}

/** Queues uploads for local files and folders (recursively) into remoteDir. Returns the number of files queued. */
export async function uploadSftp(sessionId: string, localPaths: string[], remoteDir: string): Promise<number> {
  const l = live(sessionId)
  let n = 0
  const walk = async (local: string, remote: string): Promise<void> => {
    const st = await stat(local)
    if (st.isDirectory()) {
      await mkdirP(l.sftp, remote)
      for (const name of await readdir(local)) await walk(joinLocal(local, name), posix.join(remote, name))
    } else if (st.isFile()) {
      enqueue(l, 'upload', local, remote, st.size)
      n += 1
    }
  }
  for (const p of localPaths) await walk(p, posix.join(remoteDir, basename(p)))
  return n
}

export async function pickUploads(sessionId: string, remoteDir: string): Promise<number> {
  const paths = await host().pickPaths({ title: 'Upload to ' + remoteDir, kind: 'any', multiple: true, buttonLabel: 'Upload' })
  if (!paths || paths.length === 0) return 0
  return uploadSftp(sessionId, paths, remoteDir)
}

/** Queues downloads of entries (directories recursively) so that each lands at `localFor(entry)`. */
async function queueDownloads(l: Live, entries: SftpEntry[], localFor: (e: SftpEntry) => string): Promise<number> {
  let n = 0
  const walk = async (e: SftpEntry, local: string): Promise<void> => {
    if (e.type === 'dir') {
      await mkdir(local, { recursive: true })
      for (const child of await readdirP(l.sftp, e.path)) await walk(child, joinLocal(local, child.name))
    } else if (e.type === 'file' || e.type === 'link') {
      enqueue(l, 'download', local, e.path, e.size)
      n += 1
    }
  }
  for (const e of entries) await walk(e, localFor(e))
  return n
}

/** Asks for a destination, then queues downloads. Returns the number of files queued (0 if cancelled). */
export async function downloadSftp(sessionId: string, entries: SftpEntry[]): Promise<number> {
  const l = live(sessionId)
  if (entries.length === 0) return 0
  if (entries.length === 1 && entries[0].type !== 'dir') {
    const file = await host().pickSavePath({ title: 'Save file', defaultPath: entries[0].name, buttonLabel: 'Download' })
    if (!file) return 0
    return queueDownloads(l, entries, () => file)
  }
  const dirs = await host().pickPaths({ title: 'Download into folder', kind: 'directory', buttonLabel: 'Download here' })
  if (!dirs || dirs.length === 0) return 0
  return queueDownloads(l, entries, (e) => joinLocal(dirs[0], e.name))
}

/** Queues downloads straight into localDir, keeping the remote names. */
export async function downloadSftpTo(sessionId: string, entries: SftpEntry[], localDir: string): Promise<number> {
  const l = live(sessionId)
  await mkdir(localDir, { recursive: true })
  return queueDownloads(l, entries, (e) => joinLocal(localDir, e.name))
}

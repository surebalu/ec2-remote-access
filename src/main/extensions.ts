import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { app, session, webContents, type ServiceWorkerMain, type Session, type WebFrameMain } from 'electron'
import { crxZipOffset, hasWorker, iconPathOf, isExtensionPage, localized, missingFeatures, optionsOf, popupOf, siteAccess, storeIdOf, type ExtensionInfo } from '@shared/extensions'
import { isWebUrl, partitionFor } from '@shared/browser'
import type { ExtensionFrame } from '@shared/extensionApis'
import { host } from './host'
import { loadBrowserState } from './browser'
import { log } from './log'
import { mainWindow } from './windows'

/**
 * Browser extensions (Electron-only; Host.extensions): Chrome extensions installed from the Chrome Web Store (the
 * signed package Chrome itself downloads, unpacked into <userData>/extensions/<id>) or loaded from a folder, and loaded
 * with Electron's own `session.extensions` into every Browser space and the Claude/ChatGPT tabs: each is its own
 * session, so an extension keeps its settings per space. A session is caught as it is created ('session-created'),
 * and the known ones are created at start, so the first page a space shows already has its extensions. Each session
 * also gets the service-worker preload (src/preload/extensionWorker.ts) that fills in the Chrome APIs Electron lacks,
 * without which an extension like 1Password dies at start-up. See src/shared/extensions.ts for what Electron does and
 * does not give them.
 */

interface Saved { id: string; source: 'store' | 'folder'; path: string; enabled: boolean; installedAt: number }

const root = (): string => join(host().userDataDir(), 'extensions')
const listFile = (): string => join(root(), 'extensions.json')
const webSessions = new Set<Session>()
/** Our id → the id Electron gave it (the same in every session: it comes from the folder's path). */
const runtimeIds = new Map<string, string>()

function readSaved(): Saved[] {
  try { return existsSync(listFile()) ? (JSON.parse(readFileSync(listFile(), 'utf8')) as Saved[]) : [] } catch { return [] }
}
function writeSaved(list: Saved[]): void {
  mkdirSync(root(), { recursive: true })
  const tmp = `${listFile()}.tmp`
  writeFileSync(tmp, JSON.stringify(list, null, 2))
  renameSync(tmp, listFile())
}

/** A Browser space's or a chat tab's partition (persist:web-*), by where its session keeps its data; null for others. */
function partitionOf(ses: Session): string | null {
  const m = /[/\\]Partitions[/\\](web-[^/\\]+)$/.exec(ses.storagePath ?? '')
  return m ? `persist:${m[1]}` : null
}

/** Call before any Browser session exists (index.ts, ahead of restoring sign-ins). */
export function initExtensions(): void {
  app.on('session-created', (ses) => {
    if (!partitionOf(ses)) return
    webSessions.add(ses)
    // Before any extension loads: the preload must be there when its worker starts.
    ses.registerPreloadScript({ type: 'service-worker', id: 'ec2ra-extension-worker', filePath: join(__dirname, '../preload/extensionWorker.cjs') })
    ses.serviceWorkers.on('running-status-changed', ({ versionId, runningStatus }) => {
      if (runningStatus === 'starting' || runningStatus === 'running') listen(ses, versionId)
    })
    void loadAll(ses)
  })
  if (!readSaved().some((s) => s.enabled)) return
  // The spaces and chat tabs this Mac has used: creating their sessions now loads the extensions before a page shows.
  const b = loadBrowserState()
  const spaces = new Set([...(b?.spaces ?? []).map((s) => s.id), ...(b?.tabs ?? []).map((t) => t.spaceId)])
  for (const id of spaces) session.fromPartition(partitionFor(id))
  for (const p of ['persist:web-app-claude', 'persist:web-app-chatgpt']) session.fromPartition(p)
}

async function loadInto(ses: Session, s: Saved): Promise<void> {
  try {
    const have = ses.extensions.getAllExtensions().find((e) => e.path === s.path)
    const e = have ?? await ses.extensions.loadExtension(s.path, { allowFileAccess: false })
    runtimeIds.set(s.id, e.id)
  } catch (e) {
    log('extensions', 'load failed', { id: s.id, error: (e as Error).message })
  }
}

async function loadAll(ses: Session): Promise<void> {
  for (const s of readSaved().filter((x) => x.enabled && existsSync(x.path))) await loadInto(ses, s)
}

function unload(id: string): void {
  const rid = runtimeIds.get(id)
  if (!rid) return
  for (const ses of webSessions) { try { if (ses.extensions.getExtension(rid)) ses.extensions.removeExtension(rid) } catch { /* already gone */ } }
}

function manifestOf(path: string): Record<string, unknown> & { manifest_version?: number } {
  return JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8').replace(/^﻿/, '')) as Record<string, unknown> & { manifest_version?: number }
}

function messagesOf(path: string, m: Record<string, unknown>): Record<string, { message?: string }> | null {
  const loc = typeof m.default_locale === 'string' ? m.default_locale : 'en'
  for (const l of [loc, 'en', 'en_US']) {
    const f = join(path, '_locales', l, 'messages.json')
    if (existsSync(f)) { try { return JSON.parse(readFileSync(f, 'utf8').replace(/^﻿/, '')) as Record<string, { message?: string }> } catch { /* unreadable */ } }
  }
  return null
}

function infoOf(s: Saved): ExtensionInfo | null {
  try {
    const m = manifestOf(s.path)
    const msg = messagesOf(s.path, m)
    const iconFile = iconPathOf(m, 48)
    let icon = ''
    if (iconFile && existsSync(join(s.path, iconFile))) {
      const type = { '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[extname(iconFile).toLowerCase()]
      if (type) icon = `data:${type};base64,${readFileSync(join(s.path, iconFile)).toString('base64')}`
    }
    return {
      id: s.id, runtimeId: runtimeIds.get(s.id) ?? null, name: localized(String(m.name ?? s.id), msg), version: String(m.version ?? ''),
      description: localized(String(m.description ?? ''), msg), icon, popup: popupOf(m), options: optionsOf(m), worker: hasWorker(m), enabled: s.enabled, source: s.source, path: s.path,
      manifestVersion: Number(m.manifest_version ?? 2), access: siteAccess(m), missing: missingFeatures(m), installedAt: s.installedAt
    }
  } catch (e) {
    log('extensions', 'unreadable', { id: s.id, error: (e as Error).message })
    return null
  }
}

export function listExtensions(): ExtensionInfo[] {
  return readSaved().map(infoOf).filter((x): x is ExtensionInfo => !!x)
}

async function addAndLoad(s: Saved): Promise<ExtensionInfo> {
  unload(s.id)
  writeSaved([...readSaved().filter((x) => x.id !== s.id), s])
  // A Browser space may not have been opened yet in this run; the first one will load it when it is.
  for (const ses of webSessions) await loadInto(ses, s)
  const info = infoOf(s)
  if (!info) throw new Error('The extension was saved but its manifest could not be read.')
  log('extensions', 'installed', { id: s.id, name: info.name, version: info.version, source: s.source })
  return info
}

const unzip = (zip: string, dir: string): Promise<void> => new Promise((resolve, reject) => {
  // unzip warns (exit 1) about the bytes before the zip in a CRX; only a missing manifest is a failure.
  execFile('/usr/bin/unzip', ['-o', '-q', zip, '-d', dir], { timeout: 60_000 }, (err) => (err && (err as { code?: number }).code !== 1 ? reject(err) : resolve()))
})

/** Downloads and installs (or updates) an extension from the Chrome Web Store: a link or its id. */
export async function installFromStore(input: string): Promise<ExtensionInfo> {
  const id = storeIdOf(input)
  if (!id) throw new Error('Paste the extension\'s Chrome Web Store link (chromewebstore.google.com/detail/…) or its 32-letter id.')
  // The address Chrome itself updates extensions from; prodversion is this Electron's Chromium.
  const url = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${process.versions.chrome}&acceptformat=crx2,crx3&x=id%3D${id}%26uc`
  const r = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!r.ok) throw new Error(`The Chrome Web Store answered ${r.status}${r.status === 204 ? ': no such extension, or it is not offered for this browser' : ''}.`)
  const buf = Buffer.from(await r.arrayBuffer())
  const off = crxZipOffset(buf)
  mkdirSync(root(), { recursive: true })
  const zip = join(root(), `${id}.zip`)
  const next = join(root(), `${id}.new`)
  const dest = join(root(), id)
  rmSync(next, { recursive: true, force: true })
  writeFileSync(zip, buf.subarray(off))
  try {
    await unzip(zip, next)
    if (!existsSync(join(next, 'manifest.json'))) throw new Error('The package has no manifest.json.')
    // Chrome strips this folder when it installs; Electron refuses to load an extension that still has it.
    rmSync(join(next, '_metadata'), { recursive: true, force: true })
    unload(id)
    rmSync(dest, { recursive: true, force: true })
    renameSync(next, dest)
  } finally {
    rmSync(zip, { force: true })
    rmSync(next, { recursive: true, force: true })
  }
  const was = readSaved().find((s) => s.id === id)
  return addAndLoad({ id, source: 'store', path: dest, enabled: true, installedAt: was?.installedAt ?? Date.now() })
}

/** Loads an unpacked extension from a folder the user picks (left where it is, so edits to it apply on reload). */
export async function addExtensionFolder(): Promise<ExtensionInfo | null> {
  const picked = (await host().pickPaths({ title: 'Choose the extension\'s folder (the one with manifest.json)', kind: 'directory' }))?.[0]
  if (!picked) return null
  if (!existsSync(join(picked, 'manifest.json'))) throw new Error('That folder has no manifest.json. Choose the folder the extension\'s manifest is in.')
  const id = `local-${createHash('sha256').update(picked).digest('hex').slice(0, 12)}`
  return addAndLoad({ id, source: 'folder', path: picked, enabled: true, installedAt: Date.now() })
}

export async function setExtensionEnabled(id: string, on: boolean): Promise<ExtensionInfo[]> {
  const list = readSaved()
  const s = list.find((x) => x.id === id)
  if (!s) throw new Error('That extension is no longer installed.')
  s.enabled = on
  writeSaved(list)
  if (on) for (const ses of webSessions) await loadInto(ses, s)
  else unload(id)
  return listExtensions()
}

export function removeExtension(id: string): ExtensionInfo[] {
  const s = readSaved().find((x) => x.id === id)
  if (!s) return listExtensions()
  unload(id)
  runtimeIds.delete(id)
  writeSaved(readSaved().filter((x) => x.id !== id))
  // A store extension's files are ours; a folder is the user's and stays.
  if (s.source === 'store' && s.path.startsWith(root())) rmSync(s.path, { recursive: true, force: true })
  log('extensions', 'removed', { id })
  return listExtensions()
}

/** Toolbar clicks waiting for the extension's worker to say what it did with them. */
const clicks = new Map<number, (popup: string | null) => void>()
let clickSeq = 0
const listening = new WeakSet<ServiceWorkerMain>()

/** Takes requests from an extension's worker (the preload's side of it), once per worker. */
function listen(ses: Session, versionId: number): ServiceWorkerMain | undefined {
  const w = ses.serviceWorkers.getWorkerFromVersionID(versionId)
  if (!w || listening.has(w) || !w.scope.startsWith('chrome-extension://')) return w
  listening.add(w)
  w.ipc.on('ext-worker:open', (_e, url: unknown, active: unknown) => openFromExtension(ses, w.scope, String(url), active !== false))
  w.ipc.handle('ext-worker:frames', (_e, tabId: unknown) => framesOf(ses, Number(tabId)))
  w.ipc.on('ext-worker:clicked', (_e, n: unknown, popup: unknown) => {
    const done = clicks.get(Number(n))
    clicks.delete(Number(n))
    done?.(typeof popup === 'string' ? popup : null)
  })
  return w
}

/**
 * webNavigation.getAllFrames, which Electron does not have: the page's frames with the ids Chromium gives extensions
 * (the tab is the page's webContents id; frame 0 is the top frame, the others go by their frame tree node id, as
 * `sender.frameId` does). Only pages in the asking worker's own space.
 */
function framesOf(ses: Session, tabId: number): ExtensionFrame[] | null {
  const wc = Number.isInteger(tabId) && tabId > 0 ? webContents.fromId(tabId) : undefined
  if (!wc || wc.isDestroyed() || !partitionOf(ses) || partitionOf(wc.session) !== partitionOf(ses)) return null
  const top = wc.mainFrame.frameTreeNodeId
  const idOf = (f: WebFrameMain | null): number => (!f ? -1 : f.frameTreeNodeId === top ? 0 : f.frameTreeNodeId)
  return wc.mainFrame.framesInSubtree.filter((f) => !f.detached).map((f) => ({
    frameId: idOf(f), parentFrameId: idOf(f.parent), url: f.url, processId: f.processId, errorOccurred: false,
    documentLifecycle: 'active', frameType: f.parent ? 'sub_frame' : 'outermost_frame'
  }))
}

/**
 * Opens a page an extension asked for (tabs.create or windows.create in its worker, a link or window.open in one of
 * its pages) as a Browser tab in the space it runs in: its sign-in and settings pages need that space's session.
 * Only web pages and the extension's own pages, and only for an enabled extension.
 */
export function openFromExtension(ses: Session, extensionUrl: string, url: string, active: boolean): void {
  const rid = /^chrome-extension:\/\/([a-p]{32})\//.exec(extensionUrl)?.[1]
  const partition = partitionOf(ses)
  if (!rid || !partition || !isAllowedExtensionPage(`chrome-extension://${rid}/`)) return
  if (!isWebUrl(url) && !isExtensionPage(url, [rid])) {
    log('extensions', 'refused to open', { extension: rid, url: url.slice(0, 120) })
    return
  }
  // The Mac's own window only: phones have no Browser.
  mainWindow()?.webContents.send('ext:openTab', { partition, url, background: !active })
}

/**
 * The extension's toolbar button, pressed in a space (on the page `tabId`, a webContents id): the popup page to show,
 * or null when it has no popup set and was handed the click instead (action.onClicked). 1Password clears its popup
 * until an account is signed in and opens its sign-in page on the click.
 */
export async function clickExtension(id: string, partition: string, tabId: number | null): Promise<string | null> {
  const s = readSaved().find((x) => x.id === id && x.enabled)
  const rid = runtimeIds.get(id)
  if (!s || !rid || !partition.startsWith('persist:web-')) throw new Error('That extension is not loaded. Turn it on, then try again.')
  const m = manifestOf(s.path)
  const page = popupOf(m)
  const declared = page ? `chrome-extension://${rid}/${page.replace(/^\//, '')}` : null
  if (!hasWorker(m)) return declared
  const ses = session.fromPartition(partition)
  let w: ServiceWorkerMain | undefined
  try { w = listen(ses, (await ses.serviceWorkers.startWorkerForScope(`chrome-extension://${rid}/`)).versionId) } catch { return declared }
  if (!w) return declared
  const n = ++clickSeq
  const popup = await new Promise<string | null>((resolve) => {
    clicks.set(n, resolve)
    setTimeout(() => { if (clicks.delete(n)) resolve(null) }, 3000)
    w.send('ext-worker:click', n, tabId)
  })
  log('extensions', 'click', { id, answer: popup === null ? 'none' : popup ? 'popup' : 'taken' })
  // No answer (the worker failed to start, or runs without the preload): show the popup its manifest names.
  if (popup === null) return declared
  return popup === '' ? null : isExtensionPage(popup, [rid]) ? popup : declared
}

/** A popup or options page of an enabled extension, which a Browser webview may show (main/webviews.ts). */
export function isAllowedExtensionPage(url: string | undefined): boolean {
  const on = new Set(readSaved().filter((s) => s.enabled).map((s) => s.id))
  return isExtensionPage(url, [...runtimeIds].filter(([id]) => on.has(id)).map(([, rid]) => rid))
}

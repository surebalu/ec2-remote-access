/**
 * The Computers library (renderer/components/computers): the last picture of each computer's screen, kept where the
 * engine runs so the Mac and a paired phone show the same cards, and whether each computer answers on the port its
 * card opens (screen sharing, Remote Desktop or SSH) right now.
 */
import { connect } from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ComputerReach } from '@shared/types'
import type { DisplayInfo, DisplayLayout } from '@shared/displays'
import { defaultSessionFor } from '@shared/tailnet'
import { host } from './host'
import { findInstance } from './aws/inventory'
import { decideRoute } from './connect/route'
import { getSettings } from './store'

/** A thumbnail is a small JPEG; anything bigger than this is not one. */
const MAX_THUMB = 400_000
const PROBE_MS = 2500

const file = (): string => join(host().userDataDir(), 'computer-thumbnails.json')
let thumbs: Record<string, { image: string; at: number }> | null = null

function loadThumbs(): Record<string, { image: string; at: number }> {
  if (thumbs) return thumbs
  try {
    thumbs = existsSync(file()) ? (JSON.parse(readFileSync(file(), 'utf8')) as typeof thumbs) ?? {} : {}
  } catch {
    thumbs = {}
  }
  return thumbs!
}

export function computerThumbs(): Record<string, { image: string; at: number }> {
  return loadThumbs()
}

let writing: Promise<void> = Promise.resolve()

export async function saveComputerThumb(key: string, image: string): Promise<void> {
  if (typeof key !== 'string' || key.length > 300) throw new Error('Not a host key.')
  if (typeof image !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image) || image.length > MAX_THUMB) throw new Error('A thumbnail must be a small JPEG.')
  loadThumbs()[key] = { image, at: Date.now() }
  // One write at a time; each writes the whole (small) set through a temp file.
  writing = writing.then(async () => {
    const tmp = `${file()}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(thumbs), 'utf8')
    await rename(tmp, file())
  }).catch((e) => console.warn(`[computers] thumbnail not saved: ${(e as Error).message}`))
  await writing
}

/** Whether host:port accepts a TCP connection within the probe time. */
function answers(hostName: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: hostName, port })
    const done = (ok: boolean): void => { sock.destroy(); resolve(ok) }
    sock.setTimeout(PROBE_MS, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

/**
 * Each card's state: `open` (its port answers), `closed` (reachable but nothing listening, or no answer), `offline`
 * (Tailscale says so, or the instance is not running), `tunnel` (reached through SSM, which is not probed).
 */
export async function probeComputers(keys: string[]): Promise<Record<string, ComputerReach>> {
  const out: Record<string, ComputerReach> = {}
  const overrides = getSettings().overrides
  await Promise.all(keys.slice(0, 64).map(async (key) => {
    let inst
    try { inst = findInstance(key) } catch { out[key] = 'offline'; return }
    const route = decideRoute(inst)
    if (route.route === 'not-running' || route.route === 'unreachable') { out[key] = 'offline'; return }
    if (route.route === 'ssm' || !route.host) { out[key] = 'tunnel'; return }
    const kind = defaultSessionFor(inst)
    const ov = overrides[key]
    const port = kind === 'vnc' ? ov?.vncPort ?? 5900 : kind === 'rdp' ? ov?.rdpPort ?? 3389 : ov?.sshPort ?? 22
    out[key] = (await answers(route.host, port)) ? 'open' : 'closed'
  }))
  return out
}

/** A layout someone typed: a few sizes and how they sit, nothing else. */
function cleanLayout(l: unknown): DisplayLayout | null {
  const v = l as Partial<DisplayLayout> | null
  if (!v || !Array.isArray(v.sizes) || v.sizes.length < 1 || v.sizes.length > 8) return null
  const sizes = v.sizes.map((s) => ({ width: Math.round(Number(s?.width)), height: Math.round(Number(s?.height)) }))
  if (sizes.some((s) => !(s.width >= 100 && s.width <= 30_000 && s.height >= 100 && s.height <= 30_000))) return null
  return { sizes, direction: v.direction === 'column' ? 'column' : 'row', align: v.align === 'start' || v.align === 'end' ? v.align : 'center' }
}

const layoutsFile = (): string => join(host().userDataDir(), 'computer-displays.json')
let layouts: Record<string, DisplayLayout> | null = null
let layoutWrite: Promise<void> = Promise.resolve()

function loadLayouts(): Record<string, DisplayLayout> {
  if (layouts) return layouts
  layouts = {}
  try {
    if (existsSync(layoutsFile())) {
      const raw = JSON.parse(readFileSync(layoutsFile(), 'utf8')) as Record<string, unknown>
      for (const [k, v] of Object.entries(raw)) { const l = cleanLayout(v); if (l) layouts[k] = l }
    }
  } catch { /* an unreadable file is the same as none */ }
  return layouts
}

/**
 * Where a computer's displays are: its own list when the app runs on that very computer (the tailnet's `self`, on a
 * Mac with a desktop), and what was typed for it once. The page checks either against the picture's real size.
 */
export function displaysFor(key: string): DisplayInfo {
  let auto: DisplayInfo['auto'] = null
  try {
    if (findInstance(key).tailnet?.self) auto = host().displays?.() ?? null
  } catch { /* a host that is gone has no displays to place */ }
  return { auto, saved: loadLayouts()[key] ?? null }
}

export async function saveDisplays(key: string, layout: unknown): Promise<void> {
  if (typeof key !== 'string' || key.length > 300) throw new Error('Not a host key.')
  const all = loadLayouts()
  if (layout === null) delete all[key]
  else {
    const clean = cleanLayout(layout)
    if (!clean) throw new Error('Describe each display as its width×height in points, for example 1800×1169.')
    all[key] = clean
  }
  layoutWrite = layoutWrite.then(async () => {
    const tmp = `${layoutsFile()}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(all), 'utf8')
    await rename(tmp, layoutsFile())
  }).catch((e) => console.warn(`[computers] displays not saved: ${(e as Error).message}`))
  await layoutWrite
}

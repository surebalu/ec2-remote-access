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

/**
 * The machines on this computer's Tailscale network, for the hosts list (`tailnet:list`). Read from the local
 * Tailscale CLI on demand and kept for `findInstance`, which resolves `tailnet/<node id>` keys from the last reading.
 */
import type { Instance } from '@shared/types'
import { parseTailnetStatus, type TailnetState, type TailnetStatusJson } from '@shared/tailnet'
import { tailscaleCli, tailscaleStatus } from './tailscale'
import { getSettings } from './store'

/** A reading this fresh is answered from memory: the renderer asks on focus and every minute, phones as well. */
const FRESH_MS = 10_000

let last: TailnetState = { installed: false, running: false, devices: [] }
let readAt = 0
let reading: Promise<TailnetState> | null = null

export async function tailnetHosts(refresh = false): Promise<TailnetState> {
  if (!getSettings().tailscaleHosts) return { installed: !!tailscaleCli(), running: false, devices: [] }
  if (!refresh && Date.now() - readAt < FRESH_MS) return last
  reading ??= (async () => {
    const cli = tailscaleCli()
    if (!cli) {
      last = { installed: false, running: false, devices: [] }
    } else {
      try {
        last = parseTailnetStatus((await tailscaleStatus(cli)) as TailnetStatusJson)
      } catch (e) {
        // Keep the machines already known (marked as before), so a hiccup does not empty the list.
        last = { ...last, installed: true, error: `Tailscale did not answer: ${(e as Error).message}` }
      }
    }
    readAt = Date.now()
    return last
  })().finally(() => { reading = null })
  return reading
}

export function findTailnetInstance(key: string): Instance {
  const inst = last.devices.find((d) => d.key === key)
  if (!inst) throw new Error('That Tailscale machine is not in the tailnet list any more. Refresh the hosts list and try again.')
  return inst
}

/**
 * The launcher's Mac tools (channels launcher:processes, kill, network, speedTest, downloads, quitAll, paste), with
 * macOS's own programs, none of which asks for a permission: ps, networkQuality, route, networksetup, mdls. Quit All
 * Apps asks first; Kill Process ends only what the user picked. The gateway refuses launcher:* (desktopOnly).
 */
import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { homedir, networkInterfaces, userInfo } from 'node:os'
import { join } from 'node:path'
import {
  interfaceLabel, isFinishedDownload, parseProcesses, parseSpeedTest, quitAllPlan, sortProcesses,
  type AddressRow, type DownloadItem, type NetworkInfo, type ProcessInfo, type SpeedResult
} from '@shared/macTools'
import { host } from './host'
import { control, ControlError } from './macControl'
import { quitApps } from './storage/macApps'
import { runningApps } from './storage/running'

function run(cmd: string, args: string[], timeout = 10_000): Promise<string> {
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => (err && !stdout ? reject(err) : resolve(String(stdout ?? '')))))
}

export async function processes(): Promise<ProcessInfo[]> {
  const me = userInfo().username
  const list = parseProcesses(await run('ps', ['-axo', 'pid=,ppid=,user=,%cpu=,rss=,comm=']))
  // Not the app's own processes: ending one from its own launcher would take the launcher with it.
  const own = new Set([process.pid, process.ppid])
  return sortProcesses(list.filter((p) => p.pid > 1 && !own.has(p.pid)), me).slice(0, 400)
}

export function killProcess(pid: number, force: boolean): void {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || pid === process.ppid) throw new Error('That process cannot be ended from here.')
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ESRCH') throw new Error('It has already ended.')
    if (code === 'EPERM') throw new Error('It belongs to another user (often root): only an administrator can end it, in Activity Monitor or with sudo kill.')
    throw e
  }
}

let wifiDevice: string | null | undefined

async function wifi(): Promise<string | null> {
  if (wifiDevice !== undefined) return wifiDevice
  const text = await run('networksetup', ['-listallhardwareports'], 5000).catch(() => '')
  wifiDevice = /Hardware Port: Wi-Fi\s*\nDevice: (\S+)/.exec(text)?.[1] ?? null
  return wifiDevice
}

async function lookup(url: string, ms: number): Promise<string> {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'user-agent': 'EC2RemoteAccess' } })
  if (!r.ok) throw new Error(`${r.status}`)
  return (await r.text()).trim()
}

/** This Mac's addresses: public (asked of AWS's checkip and ipify's IPv6-only name), each interface's, and the router. */
export async function networkInfo(): Promise<NetworkInfo> {
  const [wifiName, route, dns, v4, v6] = await Promise.all([
    wifi(),
    run('route', ['-n', 'get', 'default'], 4000).catch(() => ''),
    run('scutil', ['--dns'], 4000).catch(() => ''),
    lookup('https://checkip.amazonaws.com', 5000).then((a) => ({ a }), (e: Error) => ({ e: e.name === 'TimeoutError' ? 'timed out' : e.message })),
    lookup('https://api6.ipify.org', 3000).catch(() => '')
  ])
  const rows: AddressRow[] = []
  let publicError: string | undefined
  if ('a' in v4 && /^\d+\.\d+\.\d+\.\d+$/.test(v4.a)) rows.push({ label: 'Public IPv4', address: v4.a, note: 'How websites and AWS security groups see this Mac' })
  else publicError = `The public address could not be read (${'e' in v4 ? v4.e : 'no answer'}).`
  if (v6 && v6.includes(':')) rows.push({ label: 'Public IPv6', address: v6 })
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.internal || (a.family === 'IPv6' && /^fe80:/i.test(a.address))) continue
      rows.push({ label: interfaceLabel(name, a.address, wifiName), address: a.address, note: a.family === 'IPv6' ? 'IPv6' : a.cidr ?? undefined })
    }
  }
  const gateway = /gateway:\s*(\S+)/.exec(route)?.[1]
  const via = /interface:\s*(\S+)/.exec(route)?.[1]
  if (gateway) rows.push({ label: 'Router', address: gateway, note: via ? `Default route through ${via}` : undefined })
  const servers = [...new Set([...dns.matchAll(/nameserver\[\d+\]\s*:\s*(\S+)/g)].map((m) => m[1]))].slice(0, 3)
  for (const d of servers) rows.push({ label: 'DNS server', address: d })
  return { addresses: rows, publicError }
}

let speed: Promise<SpeedResult> | null = null

/** One speed test at a time (about twenty seconds); asking again while it runs joins it. */
export function speedTest(): Promise<SpeedResult> {
  speed ??= run('networkQuality', ['-c', '-M', '25'], 60_000)
    .then((out) => {
      const r = parseSpeedTest(out)
      if (!r) throw new Error('networkQuality gave no result. Are you online?')
      return r
    }, (e: Error) => { throw new Error(`The speed test failed: ${e.message.split('\n')[0]}`) })
    .finally(() => { speed = null })
  return speed
}

/** The Downloads folder, newest arrival first (Spotlight's date added, which a download's own dates do not tell). */
export async function downloads(limit = 150): Promise<DownloadItem[]> {
  const dir = join(homedir(), 'Downloads')
  const names = (await readdir(dir).catch(() => [] as string[])).filter(isFinishedDownload)
  const items: DownloadItem[] = []
  for (const name of names) {
    const path = join(dir, name)
    const st = await stat(path).catch(() => null)
    if (st) items.push({ name, path, size: st.size, dir: st.isDirectory(), added: st.birthtimeMs || st.mtimeMs })
  }
  if (items.length) {
    const raw = await run('mdls', ['-name', 'kMDItemDateAdded', '-raw', ...items.map((i) => i.path)], 8000).catch(() => '')
    raw.split('\0').forEach((v, i) => {
      const t = Date.parse(v.replace(' +0000', 'Z').replace(' ', 'T'))
      if (items[i] && Number.isFinite(t)) items[i].added = t
    })
  }
  return items.sort((a, b) => b.added - a.added).slice(0, limit)
}

/** Asks every open app (with a Dock icon) but Finder and this one to quit, after saying which. */
export async function quitAllApps(): Promise<number> {
  const plan = quitAllPlan(await runningApps())
  if (!plan.apps.length) return 0
  const names = plan.apps.map((a) => a.name)
  const ok = await host().launcher?.confirm(
    `Quit ${names.length} app${names.length === 1 ? '' : 's'}?`,
    `${names.join(', ')}.\n\nEach app asks to save unsaved work first. ${plan.kept.join(', ')} stay${plan.kept.length === 1 ? 's' : ''} open.`,
    'Quit All'
  )
  if (!ok) return 0
  return quitApps(plan.apps.map((a) => a.pid))
}

/**
 * Puts `text` on the clipboard and presses ⌘V in the app in front (the launcher's emoji). Without the Accessibility
 * permission the text stays on the clipboard and the answer says so.
 */
export async function pasteText(text: string): Promise<'pasted' | 'copied'> {
  host().launcher?.hide()
  host().clipboardWrite(text)
  // The launcher's panel gives the keyboard back to the app in front as it hides; wait until it has.
  await new Promise((r) => setTimeout(r, 120))
  try {
    await control('paste')
    return 'pasted'
  } catch (e) {
    if (e instanceof ControlError && e.code === 'accessibility') return 'copied'
    if (!host().mac?.controlPath()) return 'copied'
    throw e
  }
}

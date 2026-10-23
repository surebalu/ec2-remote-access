/**
 * The launcher's Mac tools (channels launcher:processes, kill, network, speedTest, downloads, quitAll, paste), with
 * macOS's own programs, none of which asks for a permission: ps, networkQuality, route, networksetup, mdls. Quit All
 * Apps asks first; Kill Process ends only what the user picked. The gateway refuses launcher:* (desktopOnly).
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { homedir, networkInterfaces, userInfo } from 'node:os'
import { join } from 'node:path'
import {
  interfaceLabel, ispName, isFinishedDownload, parseProcesses, parseSpeedProgress, parseSpeedSummary, parseSpeedTest, quitAllPlan, sortProcesses,
  type AddressRow, type DownloadItem, type NetworkInfo, type ProcessInfo, type SpeedResult, type SpeedRun
} from '@shared/macTools'
import { loadPty } from './pty'
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

let speed: SpeedRun | null = null

/** Who carries the connection, where, and this Mac's addresses: asked while the test runs (ipinfo.io sees the address anyway). */
async function connectionFacts(): Promise<Pick<SpeedResult, 'isp' | 'location' | 'externalIp' | 'internalIp'>> {
  const [info, route] = await Promise.all([
    fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(6000), headers: { accept: 'application/json' } })
      .then(async (r): Promise<Record<string, string>> => (r.ok ? await r.json() as Record<string, string> : {}), (): Record<string, string> => ({})),
    run('route', ['-n', 'get', 'default'], 4000).catch(() => '')
  ])
  const iface = /interface:\s*(\S+)/.exec(route)?.[1] ?? ''
  const internalIp = (networkInterfaces()[iface] ?? []).find((a) => a.family === 'IPv4' && !a.internal)?.address
  return {
    isp: info.org ? ispName(info.org) : undefined,
    location: [info.city, info.region, info.country].filter(Boolean).join(', ') || undefined,
    externalIp: info.ip, internalIp
  }
}

/**
 * Starts a speed test (or joins the one running): macOS's networkQuality, which writes its live readings only to a
 * terminal, so it runs in a pseudo-terminal and each "Downlink: … Mbps - Uplink: … Mbps" line becomes a sample; the
 * summary it ends with is the result. The launcher reads speedStatus() a few times a second. Without node-pty it runs
 * plainly (-c) and only the result comes.
 */
export async function startSpeedTest(): Promise<{ id: string }> {
  if (speed && !speed.ended) return { id: speed.id }
  const r: SpeedRun = { id: randomUUID(), started: Date.now(), samples: [], live: true }
  speed = r
  const facts = connectionFacts()
  const finish = async (result: SpeedResult | null, error?: string): Promise<void> => {
    if (result) r.result = { ...result, ...(await facts) }
    else r.error = error ?? 'networkQuality gave no result. Are you online?'
    r.ended = Date.now()
  }
  try {
    const pty = await loadPty()
    let all = ''
    const p = pty.spawn('/usr/bin/networkQuality', ['-v', '-M', '25'], { name: 'xterm', cols: 220, rows: 40, cwd: homedir(), env: process.env as Record<string, string> })
    const timer = setTimeout(() => p.kill(), 60_000)
    p.onData((d) => {
      all += d
      const readings = parseSpeedProgress(all)
      for (let i = r.samples.length; i < readings.length; i++) r.samples.push({ t: Date.now() - r.started, ...readings[i] })
    })
    p.onExit(() => {
      clearTimeout(timer)
      void finish(parseSpeedSummary(all))
    })
  } catch {
    r.live = false
    run('networkQuality', ['-c', '-M', '25'], 60_000).then((out) => finish(parseSpeedTest(out)), (e: Error) => finish(null, `The speed test failed: ${e.message.split('\n')[0]}`))
  }
  return { id: r.id }
}

export const speedStatus = (): SpeedRun | null => speed

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

/** Asks one open app to quit (as its Quit menu item would), by its bundle path. */
export async function quitApp(path: string): Promise<void> {
  const want = path.replace(/\/+$/, '')
  const app = (await runningApps()).find((a) => a.path.replace(/\/+$/, '') === want)
  if (!app) throw new Error(`${want.split('/').pop()?.replace(/\.app$/, '')} is not open.`)
  host().launcher?.hide()
  if (!(await quitApps([app.pid]))) throw new Error(`${app.name} did not quit.`)
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

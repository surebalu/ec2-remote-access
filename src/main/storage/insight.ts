import { execFile } from 'node:child_process'
import { lstat, readdir, statfs } from 'node:fs/promises'
import { totalmem } from 'node:os'
import { join } from 'node:path'
import type { DiskTarget, MacInfo } from '@shared/storage'

/**
 * Small facts the Storage tool shows around its rooms (Mac app only): this Mac in words for the Overview's footer, the
 * drives the disk picker offers, and one item's dates for the Space Map's inspector.
 */

const out = (cmd: string, args: string[], timeout = 10_000): Promise<string> =>
  new Promise((resolve) => execFile(cmd, args, { timeout }, (_err, stdout) => resolve((stdout ?? '').trim())))

let info: MacInfo | null = null

/** macOS and its build, the model as About This Mac names it, the chip, the memory and the startup disk. */
export async function macInfo(): Promise<MacInfo> {
  if (info) return info
  const [name, version, build, chip, cores, model, names, disk] = await Promise.all([
    out('sw_vers', ['-productName']), out('sw_vers', ['-productVersion']), out('sw_vers', ['-buildVersion']),
    out('sysctl', ['-n', 'machdep.cpu.brand_string']), out('sysctl', ['-n', 'hw.ncpu']), out('sysctl', ['-n', 'hw.model']),
    // About This Mac keeps the model's marketing name here ("MacBook Pro (14-inch, Nov 2023)").
    out('defaults', ['read', `${process.env.HOME}/Library/Preferences/com.apple.SystemProfiler.plist`, 'CPU Names']),
    out('diskutil', ['info', '/'])
  ])
  const marketing = /=\s*"([^"]+)"/.exec(names)?.[1]
  const volume = /Volume Name:\s*(.+)/.exec(disk)?.[1]?.trim() ?? 'Macintosh HD'
  const fs = /File System Personality:\s*(.+)/.exec(disk)?.[1]?.trim() ?? ''
  info = {
    os: `${name} ${version}${build ? ` (${build})` : ''}`,
    model: marketing ?? model,
    chip: `${chip}${cores ? ` (${cores} cores)` : ''}`,
    memory: totalmem(),
    disk: `${volume}${fs ? ` (${fs.replace(/^Case-sensitive /, '')})` : ''}`
  }
  return info
}

/** What the disk picker offers: the startup disk, the home folder, and each other drive that is mounted. */
export async function scanTargets(): Promise<DiskTarget[]> {
  const root = await statfs('/')
  const targets: DiskTarget[] = [
    { kind: 'mac', label: (await macInfo()).disk.replace(/ \(.*\)$/, ''), total: root.blocks * root.bsize, free: root.bavail * root.bsize },
    { kind: 'home', label: 'Your home folder', path: process.env.HOME }
  ]
  const rootDev = (await lstat('/')).dev
  for (const name of await readdir('/Volumes').catch(() => [] as string[])) {
    const path = join('/Volumes', name)
    try {
      const st = await lstat(path)
      // The startup disk appears in /Volumes as a link to '/'.
      if (st.isSymbolicLink() || st.dev === rootDev) continue
      const fs = await statfs(path)
      targets.push({ kind: 'path', label: name, path, total: fs.blocks * fs.bsize, free: fs.bavail * fs.bsize })
    } catch { /* gone or asleep */ }
  }
  return targets
}

/** When an item was made, changed and last opened (Spotlight's record), for the inspector. */
export async function itemDates(path: string): Promise<{ created: number; modified: number; opened: number }> {
  let created = 0
  let modified = 0
  try { const st = await lstat(path); created = st.birthtimeMs; modified = st.mtimeMs } catch { /* gone */ }
  const raw = await out('mdls', ['-name', 'kMDItemLastUsedDate', '-raw', '-nullMarker', '', path], 5000)
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{4})$/.exec(raw)
  const opened = m ? Date.parse(`${m[1]}T${m[2]}${m[3].slice(0, 3)}:${m[3].slice(3)}`) || 0 : 0
  return { created, modified, opened }
}

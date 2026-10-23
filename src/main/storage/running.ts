import { execFile } from 'node:child_process'

/** The apps running now (lsappinfo, which needs no permission): the Cleanup, Apps and This Mac rooms all ask. */

const out = (cmd: string, args: string[], timeout = 10_000): Promise<string> =>
  new Promise((resolve) => execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (_err, stdout) => resolve(stdout ?? '')))

/** The apps running now, with their bundle ids (lsappinfo needs no permission). */
export async function runningApps(): Promise<{ id: string; name: string; pid: number; type: string; path: string }[]> {
  const text = await out('lsappinfo', ['list'], 10_000)
  const apps: { id: string; name: string; pid: number; type: string; path: string }[] = []
  for (const block of text.split(/\n(?=\s*\d+\) ")/)) {
    const name = /^\s*\d+\) "([^"]*)"/.exec(block)?.[1]
    if (!name) continue
    apps.push({
      name,
      id: /bundleID="([^"]*)"/.exec(block)?.[1] ?? '',
      pid: Number(/pid = (\d+)/.exec(block)?.[1] ?? 0),
      type: /type="([^"]*)"/.exec(block)?.[1] ?? '',
      path: /bundle path="([^"]*)"/.exec(block)?.[1] ?? ''
    })
  }
  return apps
}


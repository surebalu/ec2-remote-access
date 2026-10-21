/**
 * node-pty, imported on first use (the gateway never loads it unless terminals are allowed), for the Terminal tab and
 * for running the 1Password CLI in a terminal of its own (onepassword.ts).
 */
import { chmodSync, existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

type PtyModule = typeof import('node-pty')

let ptyModule: Promise<PtyModule> | null = null

/** node-pty 1.1.0's prebuilt spawn-helper ships without the execute bit; packaged apps fix it in build/afterPack.cjs. */
function ensureSpawnHelper(): void {
  if (process.platform === 'win32') return
  try {
    const dir = dirname(createRequire(import.meta.url).resolve('node-pty/package.json')).replace('app.asar', 'app.asar.unpacked')
    const helper = join(dir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
    if (existsSync(helper) && !(statSync(helper).mode & 0o111)) chmodSync(helper, 0o755)
  } catch {
    /* a helper built from source is executable already */
  }
}

const unwrap = (m: unknown): PtyModule => ((m as { default?: PtyModule }).default ?? m) as PtyModule

/**
 * node-pty ships prebuilt binaries for macOS only; on Linux (the Pi gateway, installed without build scripts) its
 * native module is missing, so the API-identical @lydell/node-pty with prebuilt Linux binaries stands in.
 */
export function loadPty(): Promise<PtyModule> {
  ptyModule ??= import('node-pty')
    .then((m) => {
      ensureSpawnHelper()
      return unwrap(m)
    })
    .catch(() => import('@lydell/node-pty').then(unwrap))
  ptyModule.catch(() => { ptyModule = null })
  return ptyModule
}

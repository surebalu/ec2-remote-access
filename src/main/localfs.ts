/** Local filesystem browsing for the left pane of the Files tab. Same entry shape as the SFTP side. */
import { shell } from 'electron'
import { lstat, mkdir, readdir, realpath, rename, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SftpEntry } from '@shared/types'

export function localHome(): string {
  return homedir()
}

export async function localRealpath(p: string): Promise<string> {
  return realpath(p.replace(/^~(?=$|\/)/, homedir()))
}

export async function localList(dir: string): Promise<SftpEntry[]> {
  const dirents = await readdir(dir, { withFileTypes: true })
  const entries = await Promise.all(
    dirents.map(async (d): Promise<SftpEntry | null> => {
      const p = join(dir, d.name)
      try {
        const ls = await lstat(p)
        let type: SftpEntry['type'] = ls.isDirectory() ? 'dir' : ls.isSymbolicLink() ? 'link' : ls.isFile() ? 'file' : 'other'
        let size = ls.size
        if (type === 'link') {
          try {
            const st = await stat(p)
            if (st.isDirectory()) type = 'dir'
            else size = st.size
          } catch {
            /* dangling link */
          }
        }
        return { name: d.name, path: p, type, size, mtime: ls.mtimeMs, mode: ls.mode }
      } catch {
        return null
      }
    })
  )
  return entries
    .filter((e): e is SftpEntry => e !== null)
    .sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

export async function localMkdir(p: string): Promise<void> {
  await mkdir(p)
}

export async function localRename(from: string, to: string): Promise<void> {
  await rename(from, to)
}

/** Moves to the Trash rather than deleting outright. */
export async function localTrash(paths: string[]): Promise<void> {
  for (const p of paths) await shell.trashItem(p)
}

export function localReveal(p: string): void {
  shell.showItemInFolder(p)
}

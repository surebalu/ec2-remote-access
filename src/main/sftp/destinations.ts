import { chmod, link, lstat, rename, unlink } from 'node:fs/promises'
import type { SFTPWrapper } from 'ssh2'
import type { TransferDestination } from './safeTransfer'

export function localDestination(write: TransferDestination['write']): TransferDestination {
  return {
    exists: async (path) => {
      try { await lstat(path); return true }
      catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false; throw err }
    },
    write,
    commit: async (temp, destination, replace) => {
      if (replace) {
        const previous = await lstat(destination).catch((err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return null; throw err })
        if (previous?.isFile()) await chmod(temp, previous.mode & 0o777)
        await rename(temp, destination)
      } else await link(temp, destination)
    },
    remove: unlink
  }
}

export function remoteDestination(sftp: SFTPWrapper, write: TransferDestination['write']): TransferDestination {
  return {
    exists: (path) => new Promise((resolve, reject) => sftp.lstat(path, (err) => {
      if (!err) resolve(true)
      else if ((err as Error & { code?: number }).code === 2) resolve(false)
      else reject(err)
    })),
    write,
    commit: async (temp, destination, replace) => {
      if (replace) {
        const previous = await new Promise<{ mode: number } | null>((resolve, reject) => sftp.lstat(destination, (err, info) => {
          if (!err) resolve(info)
          else if ((err as Error & { code?: number }).code === 2) resolve(null)
          else reject(err)
        }))
        if (previous && (previous.mode & 0o170000) === 0o100000) {
          await new Promise<void>((resolve, reject) => sftp.chmod(temp, previous.mode & 0o777, (err) => err ? reject(err) : resolve()))
        }
      }
      await new Promise<void>((resolve, reject) => {
        const done = (err?: Error | null): void => {
          if (err && replace && (err as Error & { code?: number }).code === 8) reject(new Error('This server does not support safe replacement. Transfer again and choose Keep both.'))
          else if (err) reject(err)
          else resolve()
        }
        if (!replace) sftp.rename(temp, destination, done)
        else {
          try { sftp.ext_openssh_rename(temp, destination, done) }
          catch { reject(new Error('This server does not support safe replacement. Transfer again and choose Keep both.')) }
        }
      })
    },
    remove: (temp) => new Promise<void>((resolve, reject) => sftp.unlink(temp, (err) => err ? reject(err) : resolve()))
  }
}

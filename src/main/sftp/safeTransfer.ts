import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'

export type ConflictChoice = 'replace' | 'skip' | 'keep-both' | 'cancel'
export interface TransferDestination {
  exists: (path: string) => Promise<boolean>
  write: (temporaryPath: string) => Promise<void>
  /** Must refuse an existing destination unless replace was explicitly chosen. */
  commit: (temporaryPath: string, destination: string, replace: boolean) => Promise<void>
  remove: (temporaryPath: string) => Promise<void>
}

/** Complete the temporary sibling before touching the destination, including on cancellation. */
export async function transferSafely(
  path: string, io: TransferDestination, choose: (path: string) => Promise<ConflictChoice>,
  cancelled: () => boolean, onDestination: (path: string) => void
): Promise<'done' | 'skipped'> {
  const check = (): void => { if (cancelled()) throw new Error('cancelled') }
  check()
  let destination = path
  let replace = false
  if (await io.exists(path)) {
    const choice = await choose(path)
    check()
    if (choice === 'cancel') throw new Error('cancelled')
    if (choice === 'skip') return 'skipped'
    replace = choice === 'replace'
    if (choice === 'keep-both') {
      const { dir, name, ext } = posix.parse(path)
      let n = 1
      do { destination = posix.join(dir, `${name} (${n++})${ext}`) } while (await io.exists(destination))
    }
  }
  check()
  onDestination(destination)
  const temp = posix.join(posix.dirname(destination), `.${posix.basename(destination)}.${randomUUID()}.part`)
  try {
    await io.write(temp)
    check()
    await io.commit(temp, destination, replace)
    return 'done'
  } finally {
    // A broken connection may prevent cleanup; never fall back to deleting the destination.
    await io.remove(temp).catch(() => undefined)
  }
}

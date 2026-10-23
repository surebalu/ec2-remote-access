/**
 * Whiteboards: one JSON file per board in <userData>/boards, written atomically. Kept with the app's data (not the
 * notes folder), so the gateway serves the same boards to an iPad; a data folder (main/dataFolder.ts) gets a copy of
 * each, and <userData>/boards-deleted.json remembers deleted ones so a copy elsewhere does not bring them back.
 */
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Board, BoardSummary } from '@shared/types'
import { host } from './host'

const dir = (): string => {
  const d = join(host().userDataDir(), 'boards')
  mkdirSync(d, { recursive: true })
  return d
}
/** Where boards are kept, for Settings → Data and the data folder. */
export const boardsDir = (): string => dir()
export const isBoardId = (id: string): boolean => /^[A-Za-z0-9_-]{1,64}$/.test(id)

const listeners = new Set<() => void>()
/** Calls `cb` after a board is saved or deleted here, so the data folder can follow. */
export function onBoardsChanged(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
const changed = (): void => { for (const l of listeners) l() }

/** Deleted boards by id, with when; read and written by the data folder's sync too. */
export const deletedBoardsFile = (): string => join(host().userDataDir(), 'boards-deleted.json')
export function deletedBoards(): Record<string, number> {
  try {
    const raw = JSON.parse(readFileSync(deletedBoardsFile(), 'utf8')) as Record<string, unknown>
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, number] => isBoardId(e[0]) && typeof e[1] === 'number'))
  } catch {
    return {}
  }
}
/** Board ids come from the renderer; only safe file names are used. */
const fileFor = (id: string): string => {
  if (!isBoardId(id)) throw new Error('Not a board id.')
  return join(dir(), `${id}.json`)
}

export function listBoards(): BoardSummary[] {
  const out: BoardSummary[] = []
  for (const f of readdirSync(dir())) {
    if (!f.endsWith('.json')) continue
    try {
      const b = JSON.parse(readFileSync(join(dir(), f), 'utf8')) as Board
      out.push({ id: b.id, name: b.name, updatedAt: b.updatedAt, items: b.items.length })
    } catch {
      /* a half-written or foreign file */
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function loadBoard(id: string): Board | null {
  try {
    return JSON.parse(readFileSync(fileFor(id), 'utf8')) as Board
  } catch {
    return null
  }
}

export async function saveBoard(board: Board): Promise<void> {
  const file = fileFor(board.id)
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(board), 'utf8')
  await rename(tmp, file)
  changed()
}

export async function deleteBoard(id: string): Promise<void> {
  await rm(fileFor(id), { force: true })
  const file = deletedBoardsFile()
  await writeFile(`${file}.${process.pid}.tmp`, JSON.stringify({ ...deletedBoards(), [id]: Date.now() }), 'utf8')
  await rename(`${file}.${process.pid}.tmp`, file)
  changed()
}

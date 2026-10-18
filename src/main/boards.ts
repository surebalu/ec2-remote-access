/**
 * Whiteboards: one JSON file per board in <userData>/boards, written atomically. Kept with the app's data (not the
 * notes folder), so the gateway serves the same boards to an iPad.
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
/** Board ids come from the renderer; only safe file names are used. */
const fileFor = (id: string): string => {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('Not a board id.')
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
}

export async function deleteBoard(id: string): Promise<void> {
  await rm(fileFor(id), { force: true })
}

/**
 * The Terminal ribbon's Git chips: what `git status --porcelain=v2 --branch -z` and `git diff --numstat -z HEAD`
 * print, read without Electron or the DOM so tests can load it (main/localgit.ts runs the commands).
 */

/** One letter per file, as Git and Warp show it: Modified, Added, Deleted, Renamed, Copied, Type change, Unmerged (a conflict), ? untracked. */
export type GitFileStatus = 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '?'

export interface GitFile {
  path: string
  status: GitFileStatus
  /** The change is in the index (git add); untracked and unmerged files never are. */
  staged: boolean
  /** A rename's or copy's source. */
  from?: string
}

export interface GitStatus {
  /** The branch, or the short commit id when HEAD is detached; null in a repository without commits on no branch. */
  branch: string | null
  detached: boolean
  upstream?: string
  /** Commits not on the upstream yet, and upstream commits not here yet (0 without an upstream). */
  ahead: number
  behind: number
  /** At most MAX_GIT_FILES of them; `changed` counts all. */
  files: GitFile[]
  changed: number
  /** Lines added and removed in tracked files against HEAD (staged and not); untracked files are not counted. */
  insertions: number
  deletions: number
}

export const MAX_GIT_FILES = 500

const LETTERS = new Set(['M', 'A', 'D', 'R', 'C', 'T'])

/** The letter for a porcelain v2 XY pair: the working tree's change when there is one, else the index's. */
function letter(xy: string): GitFileStatus {
  const y = xy[1]
  const x = xy[0]
  if (LETTERS.has(y)) return y as GitFileStatus
  if (LETTERS.has(x)) return x as GitFileStatus
  return 'M'
}

/** Splits off `n` space-separated fields; the rest of the record (a path may contain spaces) is the last item. */
function fields(record: string, n: number): string[] | null {
  const out: string[] = []
  let at = 0
  for (let i = 0; i < n; i++) {
    const sp = record.indexOf(' ', at)
    if (sp < 0) return null
    out.push(record.slice(at, sp))
    at = sp + 1
  }
  out.push(record.slice(at))
  return out
}

/** Reads `git status --porcelain=v2 --branch -z`. Insertions and deletions come from parseNumstat. */
export function parseStatus(out: string): GitStatus {
  const st: GitStatus = { branch: null, detached: false, ahead: 0, behind: 0, files: [], changed: 0, insertions: 0, deletions: 0 }
  let oid = ''
  const records = out.split('\0')
  const add = (f: GitFile): void => {
    st.changed++
    if (st.files.length < MAX_GIT_FILES) st.files.push(f)
  }
  for (let i = 0; i < records.length; i++) {
    const r = records[i]
    if (!r) continue
    if (r.startsWith('# ')) {
      const [key, ...rest] = r.slice(2).split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') oid = value === '(initial)' ? '' : value
      else if (key === 'branch.head') {
        if (value === '(detached)') st.detached = true
        else st.branch = value
      } else if (key === 'branch.upstream') st.upstream = value
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value)
        if (m) { st.ahead = Number(m[1]); st.behind = Number(m[2]) }
      }
      continue
    }
    const kind = r[0]
    if (kind === '1') {
      const f = fields(r, 8)
      if (f) add({ path: f[8], status: letter(f[1]), staged: f[1][0] !== '.' })
    } else if (kind === '2') {
      // With -z a rename's source is the next record, not after a tab.
      const f = fields(r, 9)
      const from = records[++i]
      if (f) add({ path: f[9], status: letter(f[1]), staged: f[1][0] !== '.', from: from || undefined })
    } else if (kind === 'u') {
      const f = fields(r, 10)
      if (f) add({ path: f[10], status: 'U', staged: false })
    } else if (kind === '?') {
      add({ path: r.slice(2), status: '?', staged: false })
    }
  }
  if (st.detached) st.branch = oid ? oid.slice(0, 7) : null
  return st
}

/** Sums `git diff --numstat -z` (binary files, shown as "-", count no lines). */
export function parseNumstat(out: string): { insertions: number; deletions: number } {
  let insertions = 0
  let deletions = 0
  const records = out.split('\0')
  for (let i = 0; i < records.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(records[i])
    if (!m) continue
    if (m[1] !== '-') insertions += Number(m[1])
    if (m[2] !== '-') deletions += Number(m[2])
    // A rename has an empty path here, then its source and destination as two more records.
    if (m[3] === '') i += 2
  }
  return { insertions, deletions }
}

/** The chip's tooltip: "6 changed files · +31 −8 · 1 ahead, 2 behind origin/main". */
export function describeGit(st: GitStatus): string {
  const parts = [st.changed === 0 ? 'No changes' : `${st.changed} changed file${st.changed === 1 ? '' : 's'}`]
  if (st.insertions || st.deletions) parts.push(`+${st.insertions} −${st.deletions}`)
  if (st.upstream) {
    const ab = [st.ahead ? `${st.ahead} ahead` : '', st.behind ? `${st.behind} behind` : ''].filter(Boolean).join(', ')
    parts.push(ab ? `${ab} ${st.upstream}` : `up to date with ${st.upstream}`)
  }
  return parts.join(' · ')
}

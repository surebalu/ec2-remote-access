/**
 * Git status of a local terminal's folder for the Terminal ribbon (term:git): branch, ahead/behind, changed files
 * and line counts. The renderer asks only when the shell's prompt reported a branch, after a command, on a folder
 * change and when the window comes back, so this never polls.
 */
import { execFile } from 'node:child_process'
import type { GitStatus } from '@shared/gitStatus'
import { parseNumstat, parseStatus } from '@shared/gitStatus'

const TIMEOUT_MS = 1500
const MAX_OUTPUT = 4 * 1024 * 1024

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // --no-optional-locks: a status in the background must not take index.lock and fail the user's own git command.
    execFile('git', ['--no-optional-locks', '-C', cwd, ...args], {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT,
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' }
    }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  })
}

/** null when `cwd` is not in a repository, git is missing, or the repository is too big to read in time. */
export async function localGitStatus(cwd: string): Promise<GitStatus | null> {
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) return null
  let st: GitStatus
  try {
    st = parseStatus(await git(cwd, ['status', '--porcelain=v2', '--branch', '-z']))
  } catch {
    return null
  }
  if (st.changed) {
    try {
      Object.assign(st, parseNumstat(await git(cwd, ['diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv', 'HEAD'])))
    } catch {
      /* no commits yet (no HEAD), or too slow: the file count still stands */
    }
  }
  return st
}

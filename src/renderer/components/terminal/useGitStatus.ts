import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitStatus } from '@shared/gitStatus'

// Long enough to take a prompt's folder, branch and "command finished" as one refresh.
const DEBOUNCE_MS = 80

/**
 * Git status of a pane's folder for its ribbon. Asked of main only where the shell's prompt reported a branch (so
 * never outside a repository), and again when a command finishes, the folder or branch changes, the pane comes into
 * view or the window gets focus back (a commit made in another app); never on a timer, and one call at a time.
 */
export function useGitStatus(cwd: string | undefined, branch: string | undefined, visible: boolean, idle: boolean): GitStatus | null {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const want = useRef({ cwd, branch, visible })
  want.current = { cwd, branch, visible }
  const busy = useRef(false)
  const again = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const schedule = useCallback((): void => {
    if (!want.current.visible) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(function run() {
      timer.current = null
      const { cwd: dir, branch: br } = want.current
      if (!dir || !br) { setStatus(null); return }
      if (busy.current) { again.current = true; return }
      busy.current = true
      window.api.invoke('term:git', dir).then(
        (st) => { if (want.current.cwd === dir) setStatus(st) },
        () => { if (want.current.cwd === dir) setStatus(null) }
      ).finally(() => {
        busy.current = false
        if (again.current) { again.current = false; schedule() }
      })
    }, DEBOUNCE_MS)
  }, [])

  useEffect(() => {
    if (!cwd || !branch) setStatus(null)
    else schedule()
  }, [cwd, branch, schedule])
  useEffect(() => { if (idle) schedule() }, [idle, schedule])
  useEffect(() => { if (visible) schedule() }, [visible, schedule])
  useEffect(() => {
    window.addEventListener('focus', schedule)
    return () => {
      window.removeEventListener('focus', schedule)
      if (timer.current) clearTimeout(timer.current)
    }
  }, [schedule])

  return cwd && branch ? status : null
}

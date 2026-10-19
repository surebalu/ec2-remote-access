import type { MouseEvent as ReactMouseEvent, ReactElement, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import type { Snippet } from '@shared/types'
import { describeGit, type GitFileStatus, type GitStatus } from '@shared/gitStatus'
import { shortPath, tildify } from '@shared/termIntegration'
import { useStore } from '../../store'
import { Icon } from '../icons'
import Popover, { MenuItem, MenuLabel, MenuSep } from '../Popover'

/**
 * The slim bar along the bottom of a terminal pane, as in Warp: on the left a new tab, voice input, the folder's Git
 * changes, workflows, history, Finder and the input-box switch; on the right the AWS profile, the folder and the
 * branch. It stays put whether the input box shows, a program runs, or typing goes straight to the shell. Labels
 * fold away to icons when the pane is narrow (container queries in styles.css), so it never wraps or scrolls.
 */

const inElectron = /\bElectron\//.test(navigator.userAgent)
const EMPTY: Snippet[] = []
const FILES_SHOWN = 40
const STATUS_NAME: Record<GitFileStatus, string> = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Conflict', '?': 'Untracked' }

type Menu = { kind: 'git' | 'folder' | 'flows'; anchor: HTMLElement }

/** Ribbon buttons keep the keyboard where it was (the input box or the terminal). */
const keepFocus = (e: ReactMouseEvent): void => e.preventDefault()

function Chip({ icon, label, title, on, className = '', onClick, children }: {
  icon?: ReactNode
  label?: string
  title: string
  on?: boolean
  className?: string
  onClick?: (e: ReactMouseEvent<HTMLButtonElement>) => void
  children?: ReactNode
}): ReactElement {
  return (
    <button type="button" className={`trib-chip ${on ? 'on' : ''} ${className}`} title={title} aria-label={label ?? title} aria-pressed={on} onMouseDown={keepFocus} onClick={onClick}>
      {icon}
      {label && <span className="trib-label">{label}</span>}
      {children}
    </button>
  )
}

export default function Ribbon({ cwd, home, branch, aws, git, inputMode, editorShowing, onNewTab, onToggleInput, onHistory, onWorkflow, onRun }: {
  cwd?: string
  home?: string
  /** The branch the shell's prompt reported (the Git status, once read, has the same or a detached commit). */
  branch?: string
  aws?: string
  git: GitStatus | null
  inputMode: 'editor' | 'shell'
  /** The input box is up: History applies, and a Git command can be run from the menu. */
  editorShowing: boolean
  onNewTab: (cwd?: string) => void
  onToggleInput: () => void
  onHistory: () => void
  onWorkflow: (s: Snippet) => void
  onRun: (command: string) => void
}): ReactElement {
  const toast = useStore((s) => s.toast)
  const snippets = useStore((s) => s.settings?.snippets ?? EMPTY)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [dictating, setDictating] = useState(false)

  // Dictation reports itself on window (voice.ts); the mic shows pressed while it listens.
  useEffect(() => {
    const on = (e: Event): void => setDictating((e as CustomEvent<{ active?: boolean }>).detail?.active === true)
    window.addEventListener('ec2ra:dictation', on)
    return () => window.removeEventListener('ec2ra:dictation', on)
  }, [])

  const copy = (value: string, what: string): void => {
    void window.api.invoke('clipboard:write', value).then(() => toast('success', `${what} copied`), (e: Error) => toast('error', e.message))
  }
  const reveal = (path: string): void => void window.api.invoke('local:reveal', path).catch((e: Error) => toast('error', e.message))
  const toggle = (kind: Menu['kind'], e: ReactMouseEvent<HTMLElement>): void => {
    const anchor = e.currentTarget
    setMenu((m) => (m?.kind === kind ? null : { kind, anchor }))
  }

  const shownBranch = git?.branch ?? branch
  const flows = snippets.filter((s) => !s.hostKey)
  const changed = git?.changed ?? 0

  return (
    <div className="tribbon" role="toolbar" aria-label="Terminal ribbon">
      <div className="trib-side">
        <Chip icon={<Icon.plus />} className="square" title="New tab in this folder (⌘T)" label={undefined} onClick={() => onNewTab(cwd)} />
        {inElectron && (
          <Chip
            icon={<Icon.mic />}
            className={`square mic ${dictating ? 'rec' : ''}`}
            title="Voice input (hold Right ⌥)"
            on={dictating}
            onClick={(e) => window.dispatchEvent(new CustomEvent('ec2ra:dictate', { detail: { action: 'toggle', target: e.currentTarget.closest('.tpane') ?? undefined } }))}
          />
        )}
        {git && (
          <Chip className="git" title={`${describeGit(git)}\nClick for the changed files`} label={undefined} on={menu?.kind === 'git'} onClick={(e) => toggle('git', e)}>
            <span className="trib-pm">±</span>
            <span className="trib-count">{changed}</span>
            {(git.insertions > 0 || git.deletions > 0) && (
              <span className="trib-lines"><span className="trib-add">+{git.insertions}</span> <span className="trib-del">−{git.deletions}</span></span>
            )}
          </Chip>
        )}
        <Chip icon={<Icon.snippet />} label="Workflows" title="Workflows (saved commands)" on={menu?.kind === 'flows'} onClick={(e) => toggle('flows', e)} />
        {editorShowing && <Chip icon={<Icon.history />} label="History" title="Search command history (⌃R)" onClick={onHistory} />}
        {inElectron && cwd && <Chip icon={<Icon.finder />} label="Finder" title={`Show ${tildify(cwd, home)} in Finder`} onClick={() => reveal(cwd)} />}
        <Chip
          icon={<Icon.textInput />}
          label="Rich input"
          className="rich"
          title={inputMode === 'editor' ? 'Rich input is on: commands are typed in the input box. ⌃G at the prompt types straight into the shell.' : 'Typing goes straight to the shell. ⌃G at the prompt brings back the input box.'}
          on={inputMode === 'editor'}
          onClick={onToggleInput}
        >
          <kbd className="trib-kbd">⌃G</kbd>
        </Chip>
      </div>
      <span className="trib-gap" />
      <div className="trib-side right">
        {aws && (
          <span className="trib-chip static aws" title={`AWS_PROFILE=${aws}`}>
            <Icon.cloud />
            <span className="trib-text">{aws}</span>
          </span>
        )}
        {cwd && (
          <Chip icon={<Icon.folder />} className="folder" title={`${cwd}\nClick for folder actions`} on={menu?.kind === 'folder'} onClick={(e) => toggle('folder', e)}>
            <span className="trib-text trib-path-long">{shortPath(cwd, home, 3)}</span>
            <span className="trib-text trib-path-short">{shortPath(cwd, home, 1)}</span>
          </Chip>
        )}
        {shownBranch && (
          <Chip icon={<Icon.branch />} className="branch" title={`Branch ${shownBranch}${git?.upstream ? ` (${git.upstream})` : ''}${git?.ahead || git?.behind ? `\n${git.ahead} ahead, ${git.behind} behind` : ''}\nClick to copy the name`} onClick={() => copy(shownBranch, 'Branch name')}>
            <span className="trib-text">{shownBranch}</span>
            {!!git?.ahead && <span className="trib-ab">↑{git.ahead}</span>}
            {!!git?.behind && <span className="trib-ab">↓{git.behind}</span>}
          </Chip>
        )}
      </div>

      {menu?.kind === 'git' && git && (
        <Popover anchor={menu.anchor} width={340} onClose={() => setMenu(null)}>
          <div className="trib-pop-head">
            <span className="trib-pop-title">{changed === 0 ? 'No changes' : `${changed} changed file${changed === 1 ? '' : 's'}`}</span>
            {(git.insertions > 0 || git.deletions > 0) && <span className="trib-pop-lines"><span className="add">+{git.insertions}</span> <span className="del">−{git.deletions}</span></span>}
          </div>
          {git.branch && <div className="trib-pop-sub muted">{git.detached ? 'Detached at ' : 'On '}{git.branch}{git.upstream ? ` · ${git.ahead || git.behind ? `${git.ahead} ahead, ${git.behind} behind ${git.upstream}` : `up to date with ${git.upstream}`}` : ''}</div>}
          {git.files.length > 0 && <MenuSep />}
          <div className="trib-files">
            {git.files.slice(0, FILES_SHOWN).map((f) => (
              <MenuItem key={`${f.status}${f.path}`} title={`${STATUS_NAME[f.status]}${f.staged ? ' (staged)' : ''}: ${f.from ? `${f.from} → ` : ''}${f.path}\nClick to copy the path`} onClick={() => { setMenu(null); copy(f.path, 'Path') }}>
                <span className="trib-file">
                  <span className={`trib-st st-${f.status === '?' ? 'new' : f.status.toLowerCase()} ${f.staged ? 'staged' : ''}`}>{f.status}</span>
                  <span className="trib-file-path">{f.path}</span>
                </span>
              </MenuItem>
            ))}
          </div>
          {changed > FILES_SHOWN && <div className="muted px-3 pb-1 pt-0.5 text-[10.5px]">and {changed - FILES_SHOWN} more</div>}
          {editorShowing && (
            <>
              <MenuSep />
              <MenuItem onClick={() => { setMenu(null); onRun('git status') }}>Run git status</MenuItem>
              <MenuItem onClick={() => { setMenu(null); onRun('git diff') }}>Run git diff</MenuItem>
            </>
          )}
        </Popover>
      )}

      {menu?.kind === 'folder' && cwd && (
        <Popover anchor={menu.anchor} align="right" width={260} onClose={() => setMenu(null)}>
          <MenuLabel>{tildify(cwd, home)}</MenuLabel>
          <MenuItem onClick={() => { setMenu(null); copy(cwd, 'Path') }}>Copy path</MenuItem>
          {inElectron && <MenuItem onClick={() => { setMenu(null); reveal(cwd) }}>Show in Finder</MenuItem>}
          <MenuItem onClick={() => { setMenu(null); onNewTab(cwd) }} hint="⌘T">New tab here</MenuItem>
        </Popover>
      )}

      {menu?.kind === 'flows' && (
        <Popover anchor={menu.anchor} width={300} onClose={() => setMenu(null)}>
          <MenuLabel>Workflows</MenuLabel>
          {flows.map((s) => (
            <MenuItem key={s.id} title={s.command} hint={s.run ? 'runs' : undefined} onClick={() => { setMenu(null); onWorkflow(s) }}>
              <span className="trib-flow"><span className="trib-flow-name">{s.name}</span><span className="trib-flow-cmd">{s.command}</span></span>
            </MenuItem>
          ))}
          {!flows.length && <div className="muted px-3 py-1.5 text-[11.5px] leading-snug">Saved commands (snippets) show up here.</div>}
          <MenuSep />
          <MenuItem onClick={() => { setMenu(null); useStore.getState().set({ snippetsOpen: {} }) }}>Edit workflows…</MenuItem>
        </Popover>
      )}
    </div>
  )
}

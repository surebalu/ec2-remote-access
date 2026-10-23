import type { ReactNode } from 'react'
import type { Instance } from '@shared/types'
import type { Quicklink } from '@shared/quicklinks'

/** What the launcher lists (Launcher.tsx) and its modes (modes.tsx) build: rows in groups, each with its actions. */

export interface Action {
  title: string
  /** A combination as keyCombos.ts writes them: 'enter' for the first action, 'cmd+enter' for the second. */
  key?: string
  run: () => void
}

/** What the side pane shows for a result. */
export type Detail =
  | { kind: 'path'; path: string }
  | { kind: 'host'; host: Instance }
  | { kind: 'note'; path: string; text: string }
  | { kind: 'web'; url: string; space: string; favicon?: string }
  | { kind: 'calc'; value: number; expr: string; unit?: string }
  | { kind: 'quicklink'; link: Quicklink; url: string }
  | { kind: 'emoji'; char: string; name: string; words: string[] }
  /** A heading, a big figure or picture, facts, and a sentence: the modes' results (a process, an address, a layout). */
  | { kind: 'facts'; title: string; big?: ReactNode; facts: [string, ReactNode][]; note?: ReactNode }

export interface Row {
  id: string
  title: string
  subtitle?: string
  /** Words it is also found by. */
  keywords?: string
  icon: ReactNode
  /** A file or app whose icon (the app that opens it, for a file) replaces `icon` once it has loaded. */
  iconPath?: string
  accessory?: ReactNode
  /** What it is, on the right of the row (Application, Command…); found from its id when not given. */
  type?: string
  detail?: Detail
  actions: Action[]
}

export interface Group {
  title: string
  rows: Row[]
  /** How well its first row matches, which orders the groups between the calculator and web search. */
  best?: number
}

/** A part of the launcher with a list of its own, entered from a command (Raycast's commands with a view). */
export type LauncherMode = 'emoji' | 'processes' | 'network' | 'speed' | 'monitor' | 'downloads' | 'capture'

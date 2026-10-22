import type { ToolKind } from './store'

/** Stable categories shared by navigation and the tool directory. Usage never moves the user's navigation. */
export const TOOL_GROUPS: { id: string; label: string; tools: ToolKind[] }[] = [
  { id: 'operate', label: 'Operate', tools: ['health'] },
  { id: 'work', label: 'Work', tools: ['local', 'finder', 'browser'] },
  { id: 'create', label: 'Create', tools: ['notes', 'board'] },
  { id: 'assist', label: 'Assist', tools: ['claude', 'chatgpt'] }
]

export const TOOL_DESCRIPTIONS: Record<ToolKind, string> = {
  health: 'Service health across environments', local: 'Local shells, splits and command history',
  finder: 'Browse and preview local files', browser: 'Web pages and AWS account spaces',
  notes: 'Runbooks and notes in your vault', board: 'Sketch ideas and system diagrams',
  claude: 'Keep Claude beside your work', chatgpt: 'Keep ChatGPT beside your work'
}

import type { ToolKind } from './store'

/** Stable categories shared by navigation and the tool directory. Usage never moves the user's navigation. */
export const TOOL_GROUPS: { id: string; label: string; tools: ToolKind[] }[] = [
  { id: 'operate', label: 'Operate', tools: ['computers', 'health'] },
  { id: 'work', label: 'Work', tools: ['local', 'finder', 'storage', 'cad', 'browser', 'devtools'] },
  { id: 'plan', label: 'Plan', tools: ['tasks', 'calendar', 'links'] },
  { id: 'create', label: 'Create', tools: ['notes', 'board'] },
  { id: 'assist', label: 'Assist', tools: ['claude', 'chatgpt'] }
]

export const TOOL_DESCRIPTIONS: Record<ToolKind, string> = {
  computers: 'Your Tailscale machines and their screens',
  devtools: 'JSON, encoding, tokens, timestamps and hashes',
  tasks: 'To-dos for today, upcoming and someday', calendar: 'Your days, events and subscribed calendars', links: 'Bookmarks and notes, like Anybox',
  health: 'Service health across environments', local: 'Local shells, splits and command history',
  finder: 'Browse and preview local files', storage: 'Disk space, junk, apps and how this Mac is doing', cad: 'STEP files in 3D, with design reviews', browser: 'Web pages and AWS account spaces',
  notes: 'Runbooks and notes in your vault', board: 'Sketch ideas and system diagrams',
  claude: 'Keep Claude beside your work', chatgpt: 'Keep ChatGPT beside your work'
}

import type { ReactElement } from 'react'

const base = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

export const Icon = {
  linux: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <path d="M12 3c-2.5 0-4 2-4 5v3c0 1-.5 2-1.5 3.5S5 17 5 18.5c0 1.5 1 2.5 2.5 2.5h9c1.5 0 2.5-1 2.5-2.5 0-1.5-.5-2.5-1.5-4S16 12 16 11V8c0-3-1.5-5-4-5z" />
      <circle cx="10" cy="9" r=".6" fill="currentColor" />
      <circle cx="14" cy="9" r=".6" fill="currentColor" />
      <path d="M10.5 11.5h3L12 13z" />
    </svg>
  ),
  windows: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <path d="M3 5.5 11 4.3v7.2H3zM13 4l8-1.2V11.5h-8zM3 13h8v7.2L3 19zM13 13h8v8.2L13 20z" />
    </svg>
  ),
  terminal: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <path d="M4 17l6-5-6-5M12 19h8" />
    </svg>
  ),
  monitor: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  ),
  key: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <circle cx="8" cy="15" r="4" />
      <path d="M10.8 12.2 20 3M15 8l3 3M17 6l2 2" />
    </svg>
  ),
  refresh: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" />
    </svg>
  ),
  search: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-3.8-3.8" />
    </svg>
  ),
  settings: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  ),
  play: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <path d="M7 5v14l11-7z" />
    </svg>
  ),
  cloud: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <path d="M7 18a4 4 0 0 1-.5-8 6 6 0 0 1 11.3 1.5A3.5 3.5 0 0 1 17.5 18z" />
    </svg>
  ),
  shield: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6z" />
    </svg>
  ),
  star: (p: { className?: string; filled?: boolean }): ReactElement => (
    <svg {...base} className={p.className} fill={p.filled ? 'currentColor' : 'none'}>
      <path d="m12 3 2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.4 6.3 20.5l1.2-6.4L2.8 9.7l6.4-.8z" />
    </svg>
  ),
  sun: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  ),
  moon: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
    </svg>
  ),
  auto: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none" />
    </svg>
  ),
  plus: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  server: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <rect x="3" y="4" width="18" height="6" rx="1.5" />
      <rect x="3" y="14" width="18" height="6" rx="1.5" />
      <path d="M7 7h.01M7 17h.01" />
    </svg>
  ),
  edit: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <path d="M4 20h4l10.5-10.5a2 2 0 0 0-2.8-2.8L5 17.2z" />
    </svg>
  ),
  chevron: (p: { className?: string; open?: boolean }): ReactElement => (
    <svg {...base} className={p.className} style={{ transform: p.open ? 'rotate(90deg)' : undefined, transition: 'transform .15s' }}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  ),
  folder: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  ),
  layers: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <path d="m12 3 9 5-9 5-9-5z" />
      <path d="m3 12 9 5 9-5M3 16l9 5 9-5" />
    </svg>
  ),
  /** Horizontal ellipsis: overflow menus. */
  more: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <circle cx="5" cy="12" r="1.2" fill="currentColor" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
      <circle cx="19" cy="12" r="1.2" fill="currentColor" />
    </svg>
  ),
  caret: (p: { className?: string }): ReactElement => (
    <svg {...base} width={10} height={10} className={p.className}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  ),
  /** Two panes side by side. */
  split: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M12 5v14" />
    </svg>
  ),
  /** Input fanned out to several panes. */
  broadcast: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <circle cx="12" cy="12" r="2" />
      <path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14" />
    </svg>
  ),
  download: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
    </svg>
  ),
  /** Braces: saved command snippets. */
  snippet: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <path d="M8 4c-2 0-3 1-3 3v2c0 1-1 2-2 3 1 1 2 2 2 3v2c0 2 1 3 3 3M16 4c2 0 3 1 3 3v2c0 1 1 2 2 3-1 1-2 2-2 3v2c0 2-1 3-3 3" />
    </svg>
  ),
  splitRows: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 12h18" />
    </svg>
  ),
  splitMain: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M14 5v14M14 12h7" />
    </svg>
  ),
  restore: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
    </svg>
  ),
  grip: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <circle cx="9" cy="6" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="6" r="1" fill="currentColor" stroke="none" />
      <circle cx="9" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="9" cy="18" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="18" r="1" fill="currentColor" stroke="none" />
    </svg>
  ),
  maximize: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </svg>
  ),
  /** Plug: port forwards. */
  plug: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4" />
    </svg>
  ),
  /** Grid of panes: workspaces. */
  grid: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
    </svg>
  ),
  /** Clipboard board: paste. */
  clipboard: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <path d="M9 4H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2" />
      <rect x="9" y="2.5" width="6" height="3.5" rx="1" />
    </svg>
  ),
  minus: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <path d="M6 12h12" />
    </svg>
  ),
  /** Curved arrow back: return a pinned tab to its saved page. */
  undo: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  ),
  share: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <path d="M12 3v12M8 7l4-4 4 4" />
      <path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" />
    </svg>
  ),
  /** Window with a prompt: the Terminal tab (local shells). */
  console: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M7 9l3 3-3 3M12.5 15H17" />
    </svg>
  ),
  branch: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <circle cx="6" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="7" r="2" />
      <path d="M6 8v8M18 9c0 5-6 4-11 8" />
    </svg>
  ),
  /** Globe: the built-in browser. */
  globe: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.6 2.6 3.9 5.6 3.9 9s-1.3 6.4-3.9 9c-2.6-2.6-3.9-5.6-3.9-9S9.4 5.6 12 3z" />
    </svg>
  ),
  back: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <path d="M15 5l-7 7 7 7" />
    </svg>
  ),
  forward: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <path d="M9 5l7 7-7 7" />
    </svg>
  ),
  lock: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  ),
  external: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </svg>
  ),
  pin: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <path d="M9 4h6l-1 6 3 3v2H7v-2l3-3zM12 15v6" />
    </svg>
  ),
  sidebar: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M9 4v16" />
    </svg>
  ),
  /** Page with lines: a note. */
  note: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M14 3v5h5M9 12h7M9 16h5" />
    </svg>
  ),
  /** Painter's palette: colour themes. */
  palette: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <path d="M12 3a9 9 0 1 0 0 18c1.2 0 1.8-.8 1.8-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.7 1.8-1.7H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z" />
      <circle cx="7.5" cy="11" r="1" fill="currentColor" /><circle cx="10" cy="7.3" r="1" fill="currentColor" /><circle cx="14.5" cy="7.3" r="1" fill="currentColor" /><circle cx="17" cy="11" r="1" fill="currentColor" />
    </svg>
  ),
  /** Phone with a tablet behind it: paired devices. */
  phone: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
      <path d="M11 18.5h2" />
    </svg>
  ),
  /** Circled i: about and information. */
  info: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5M12 7.6v.1" />
    </svg>
  ),
  /** Check in a circle: a requirement that is met. */
  check: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  ),
  /** Easel with a squiggle: the whiteboard. */
  board: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M7 12c1.5-3 3-3 4-1s2.5 2 4-2M9 20l3-4 3 4" />
    </svg>
  ),
  /** Page with a plus: add to a note. */
  noteAdd: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <path d="M13 21H6V3h9l4 4v6" />
      <path d="M14 3v5h5M18 15v6M15 18h6" />
    </svg>
  ),
  /** Window with a plus: open in a new tab. */
  openTab: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M12 9v6M9 12h6" />
    </svg>
  ),
  /** Two sheets: copy. */
  copy: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" />
    </svg>
  ),
  keyboard: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
    </svg>
  ),
  /** Voice dictation (mic buttons, Settings → Voice). */
  mic: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6" />
    </svg>
  ),
  arrowUp: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <path d="M12 19V5M6 11l6-6 6 6" />
    </svg>
  ),
  arrowDown: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <path d="M12 5v14M6 13l6 6 6-6" />
    </svg>
  ),
  alert: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <path d="M12 4 2.5 20h19zM12 10v4M12 17h.01" />
    </svg>
  ),
  activity: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <path d="M3 12h4l3-8 4 16 3-8h4" />
    </svg>
  ),
  x: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  ),
  /** Window with a right-hand side panel; the appearance-pane toggle. */
  panelRight: (p: { className?: string; filled?: boolean }): ReactElement => (
    <svg {...base} className={p.className}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M15 5v14" />
      {p.filled && <rect x="15" y="5" width="6" height="14" rx="1" fill="currentColor" stroke="none" />}
    </svg>
  ),
  /** A search glass in a key cap: the launcher. */
  launcher: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="11" cy="11" r="3.6" />
      <path d="M13.7 13.7 16.5 16.5" />
    </svg>
  ),
  /** Claude's spark: the Claude tool on the rail. */
  claude: (p: { className?: string }): ReactElement => (
    <svg {...base} strokeWidth={2.1} className={p.className}>
      <path d="M12.19 10.41L13.15 2.67M13.02 10.77L17.11 5.85M13.53 11.52L20.58 9.29M13.54 12.42L19.14 13.94M13.07 13.19L18.43 19.12M12.26 13.58L13.33 20.09M11.37 13.47L8.51 20.08M10.67 12.89L5.69 16.24M10.40 12.03L2.80 12.19M10.64 11.16L5.18 7.81M11.31 10.56L8.27 4.25" />
    </svg>
  ),
  /** The ChatGPT knot: six links turned about the middle. */
  chatgpt: (p: { className?: string }): ReactElement => (
    <svg {...base} strokeWidth={1.4} className={p.className}>
      {[0, 60, 120, 180, 240, 300].map((a) => <rect key={a} x="9.1" y="3" width="5.8" height="10.4" rx="2.9" transform={`rotate(${a} 12 12) translate(-1.6 0)`} />)}
    </svg>
  ),
  /** Finder's face: show a folder in Finder. */
  finder: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <rect x="3" y="4" width="18" height="16" rx="3.5" />
      <path d="M12.6 4c-1.3 3-1.8 6-1.5 9h1.6c-.2 2.4 0 4.7.5 7M8 9v1.5M16 9v1.5M7.5 15.3c2.9 1.6 6.1 1.6 9 0" />
    </svg>
  ),
  /** A text box with a cursor: the terminal's input box (rich input). */
  textInput: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <rect x="3" y="6" width="18" height="12" rx="2.5" />
      <path d="M7.5 9.5v5M11 12h6" />
    </svg>
  ),
  /** A clock turning back: command history. */
  history: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3.5 4v4h4M12 8v4.2l2.8 1.8" />
    </svg>
  )
}

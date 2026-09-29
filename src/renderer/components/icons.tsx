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
  keyboard: (p: { className?: string }): ReactElement => (
    <svg {...base} className={p.className}>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
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
  )
}

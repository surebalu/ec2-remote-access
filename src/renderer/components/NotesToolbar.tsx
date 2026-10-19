import type { ReactElement, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { EditorView } from '@codemirror/view'
import { activeFormats, clearFormatting, insertBlock, insertLink, setColor, setHeading, TEXT_COLORS, toggleInline, toggleLinePrefix, type InlineMark, type LineKind, type Result, type Sel } from '../notesFormat'
import Popover from './Popover'
import MicButton from './MicButton'
import { CAN_DICTATE } from '../voice'

/** Fonts for the Notes editor and preview; Monaco by default. */
export const NOTE_FONTS: { id: string; label: string; stack: string }[] = [
  { id: 'Monaco', label: 'Monaco', stack: 'Monaco, Menlo, monospace' },
  { id: 'Menlo', label: 'Menlo', stack: 'Menlo, Monaco, monospace' },
  { id: 'SF Mono', label: 'SF Mono', stack: "'SF Mono', ui-monospace, Menlo, monospace" },
  { id: 'JetBrains Mono', label: 'JetBrains Mono', stack: "'JetBrains Mono', Menlo, monospace" },
  { id: 'System', label: 'San Francisco', stack: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif" },
  { id: 'Helvetica Neue', label: 'Helvetica Neue', stack: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
  { id: 'Avenir Next', label: 'Avenir Next', stack: "'Avenir Next', Avenir, sans-serif" },
  { id: 'New York', label: 'New York (serif)', stack: "ui-serif, 'New York', Georgia, serif" },
  { id: 'Georgia', label: 'Georgia', stack: 'Georgia, serif' }
]
export const DEFAULT_NOTE_FONT = 'Monaco'
export const DEFAULT_NOTE_SIZE = 14
export const noteFontStack = (id: string | undefined): string => (NOTE_FONTS.find((f) => f.id === id) ?? NOTE_FONTS[0]).stack

/** Applies a formatting command to the editor's main selection, as one undoable step. */
export function runFormat(view: EditorView, fn: (doc: string, sel: Sel) => Result): void {
  const main = view.state.selection.main
  const r = fn(view.state.doc.toString(), { from: main.from, to: main.to })
  if (r.edits.length || r.selection.from !== main.from || r.selection.to !== main.to) {
    view.dispatch({
      changes: [...r.edits].sort((a, b) => a.from - b.from),
      selection: { anchor: r.selection.from, head: r.selection.to },
      scrollIntoView: true,
      userEvent: 'input.format'
    })
  }
  view.focus()
}

const inline = (mark: InlineMark) => (d: string, s: Sel) => toggleInline(d, s, mark)
const lineKind = (kind: LineKind) => (d: string, s: Sel) => toggleLinePrefix(d, s, kind)

/** Keyboard shortcuts for formatting, for the editor's keymap. */
export const FORMAT_KEYS: { key: string; fn: (d: string, s: Sel) => Result }[] = [
  { key: 'Mod-b', fn: inline('**') },
  { key: 'Mod-i', fn: inline('*') },
  { key: 'Mod-Shift-x', fn: inline('~~') },
  { key: 'Mod-e', fn: inline('`') },
  { key: 'Mod-Shift-h', fn: inline('==') },
  { key: 'Mod-Alt-0', fn: (d, s) => setHeading(d, s, 0) },
  { key: 'Mod-Alt-1', fn: (d, s) => setHeading(d, s, 1) },
  { key: 'Mod-Alt-2', fn: (d, s) => setHeading(d, s, 2) },
  { key: 'Mod-Alt-3', fn: (d, s) => setHeading(d, s, 3) },
  { key: 'Mod-Shift-8', fn: lineKind('bullet') },
  { key: 'Mod-Shift-7', fn: lineKind('number') },
  { key: 'Mod-Shift-9', fn: lineKind('task') },
  { key: 'Mod-Shift-.', fn: lineKind('quote') }
]

const svg = (path: ReactNode): ReactElement => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{path}</svg>
)
const ICONS = {
  bullets: svg(<><circle cx="5" cy="7" r="1.2" fill="currentColor" /><circle cx="5" cy="12" r="1.2" fill="currentColor" /><circle cx="5" cy="17" r="1.2" fill="currentColor" /><path d="M10 7h10M10 12h10M10 17h10" /></>),
  numbers: svg(<><path d="M4 5h1.5v4M4 9h3M4 13.5c0-.8.7-1.5 1.5-1.5S7 12.7 7 13.3c0 1.2-3 1.7-3 3.2h3" /><path d="M11 7h9M11 12h9M11 17h9" /></>),
  tasks: svg(<><rect x="3.5" y="4.5" width="5" height="5" rx="1" /><path d="M4.8 15.6l1.4 1.4 2.5-3" /><path d="M12 7h8M12 16h8" /></>),
  quote: svg(<><path d="M6 6v12" strokeWidth="2.6" /><path d="M11 8h9M11 12h9M11 16h6" /></>),
  link: svg(<><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" /><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" /></>),
  codeBlock: svg(<><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M9 10l-2 2 2 2M15 10l2 2-2 2" /></>),
  table: svg(<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18M9.5 5v14" /></>),
  divider: svg(<path d="M3 12h18" />),
  clear: svg(<><path d="M16 4l4 4-9.5 9.5H6.5v-4z" /><path d="M4 20h16" /></>),
  highlight: svg(<><path d="M9 15l-2 4h4l1-2" /><path d="M14.5 4.5l5 5-7.5 7.5-5-5z" /></>)
}

function Btn({ on, title, onClick, children, wide }: { on?: boolean; title: string; onClick: () => void; children: ReactNode; wide?: boolean }): ReactElement {
  return (
    <button
      type="button"
      className={`nt-btn ${on ? 'on' : ''} ${wide ? 'wide' : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={on}
      // Keep the editor's selection: the button acts on it.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/**
 * The Notes formatting bar: font and size (for every note), heading level, inline styles, text colour, lists,
 * quote, link and blocks, clear formatting, and showing the raw Markdown. Buttons light up for what the cursor is in.
 */
export default function NotesToolbar({ view, subscribe, font, size, live, onFont, onSize, onLive }: {
  view: EditorView | null
  /** Calls back on every selection or text change, so the pressed buttons follow the cursor. */
  subscribe: (fn: () => void) => () => void
  font: string
  size: number
  live: boolean
  onFont: (id: string) => void
  onSize: (n: number) => void
  onLive: (on: boolean) => void
}): ReactElement {
  const [, tick] = useState(0)
  const [colors, setColors] = useState<HTMLElement | null>(null)
  const frame = useRef(0)
  useEffect(() => subscribe(() => {
    if (!frame.current) frame.current = requestAnimationFrame(() => { frame.current = 0; tick((n) => n + 1) })
  }), [subscribe])

  const state = view?.state
  const f = state ? activeFormats(state.doc.toString(), state.selection.main.head) : null
  const has = (m: InlineMark): boolean => !!f?.marks.includes(m)
  const run = (fn: (d: string, s: Sel) => Result): void => { if (view) runFormat(view, fn) }

  return (
    <div className="notes-tools" role="toolbar" aria-label="Formatting">
      {/* First, so a narrow pane (the toolbar scrolls sideways) never hides it. */}
      {CAN_DICTATE && <><MicButton className="nt-btn" target={() => view?.contentDOM ?? null} /><span className="nt-sep" /></>}
      <select className="nt-select font" value={font} title="Font (every note)" aria-label="Font" onChange={(e) => { onFont(e.target.value); view?.focus() }}>
        {NOTE_FONTS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
      </select>
      <div className="nt-size" title="Text size (every note)">
        <button type="button" className="nt-btn" aria-label="Smaller text" onMouseDown={(e) => e.preventDefault()} onClick={() => onSize(Math.max(10, size - 1))}>A<sup>−</sup></button>
        <span className="nt-size-value">{size}</span>
        <button type="button" className="nt-btn" aria-label="Bigger text" onMouseDown={(e) => e.preventDefault()} onClick={() => onSize(Math.min(28, size + 1))}>A<sup>+</sup></button>
      </div>
      <span className="nt-sep" />
      <select className="nt-select" value={f?.heading ?? 0} title="Paragraph style (⌥⌘0–3)" aria-label="Paragraph style" onChange={(e) => run((d, s) => setHeading(d, s, Number(e.target.value)))}>
        <option value={0}>Body</option>
        <option value={1}>Heading 1</option>
        <option value={2}>Heading 2</option>
        <option value={3}>Heading 3</option>
        <option value={4}>Heading 4</option>
      </select>
      <span className="nt-sep" />
      <Btn on={has('**')} title="Bold (⌘B)" onClick={() => run(inline('**'))}><b>B</b></Btn>
      <Btn on={has('*')} title="Italic (⌘I)" onClick={() => run(inline('*'))}><i className="nt-i">I</i></Btn>
      <Btn on={has('~~')} title="Strikethrough (⌘⇧X)" onClick={() => run(inline('~~'))}><s>S</s></Btn>
      <Btn on={has('==')} title="Highlight (⌘⇧H)" onClick={() => run(inline('=='))}>{ICONS.highlight}</Btn>
      <Btn on={has('`')} title="Inline code (⌘E)" onClick={() => run(inline('`'))}><span className="nt-code">{'</>'}</span></Btn>
      <button
        type="button"
        className={`nt-btn ${f?.color ? 'on' : ''}`}
        title="Text colour"
        aria-label="Text colour"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => setColors(colors ? null : e.currentTarget)}
      >
        <span className="nt-color"><span>A</span><span className="nt-color-bar" style={{ background: f?.color ?? 'var(--accent)' }} /></span>
      </button>
      <span className="nt-sep" />
      <Btn on={f?.line === 'bullet'} title="Bulleted list (⌘⇧8)" onClick={() => run(lineKind('bullet'))}>{ICONS.bullets}</Btn>
      <Btn on={f?.line === 'number'} title="Numbered list (⌘⇧7)" onClick={() => run(lineKind('number'))}>{ICONS.numbers}</Btn>
      <Btn on={f?.line === 'task'} title="Checklist (⌘⇧9)" onClick={() => run(lineKind('task'))}>{ICONS.tasks}</Btn>
      <Btn on={f?.line === 'quote'} title="Quote (⌘⇧.)" onClick={() => run(lineKind('quote'))}>{ICONS.quote}</Btn>
      <span className="nt-sep" />
      <Btn title="Link" onClick={() => run(insertLink)}>{ICONS.link}</Btn>
      <Btn title="Code block" onClick={() => run((d, s) => insertBlock(d, s, 'code'))}>{ICONS.codeBlock}</Btn>
      <Btn title="Table" onClick={() => run((d, s) => insertBlock(d, s, 'table'))}>{ICONS.table}</Btn>
      <Btn title="Divider" onClick={() => run((d, s) => insertBlock(d, s, 'hr'))}>{ICONS.divider}</Btn>
      <span className="nt-sep" />
      <Btn title="Clear formatting" onClick={() => run(clearFormatting)}>{ICONS.clear}</Btn>
      <span className="flex-1" />
      <Btn on={!live} wide title={live ? 'Show the Markdown on every line' : 'Hide the Markdown except on the line you are editing'} onClick={() => onLive(!live)}>
        <span className="nt-md">M↓</span>
      </Btn>

      {colors && (
        <Popover anchor={colors} width={208} onClose={() => setColors(null)}>
          <div className="nt-swatches">
            {TEXT_COLORS.map((c) => (
              <button
                key={c.value}
                type="button"
                className={`nt-swatch ${f?.color === c.value ? 'on' : ''}`}
                style={{ background: c.value }}
                title={c.name}
                aria-label={`${c.name} text`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { setColors(null); run((d, s) => setColor(d, s, c.value)) }}
              />
            ))}
          </div>
          <button type="button" className="menu-item" onMouseDown={(e) => e.preventDefault()} onClick={() => { setColors(null); run((d, s) => setColor(d, s, null)) }}>
            <span className="min-w-0 flex-1 truncate text-left">No colour</span>
          </button>
        </Popover>
      )}
    </div>
  )
}

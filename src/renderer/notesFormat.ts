/**
 * Formatting commands of the Notes editor as plain text edits, free of CodeMirror and the DOM so tests can load them.
 * Everything stays Markdown that Obsidian reads: **bold**, *italic*, ~~strikethrough~~, `code`, ==highlight==,
 * headings, lists, task lists and quotes; text colour is an inline <span style="color:…">, which Obsidian renders.
 * Each command takes the document and a selection and returns the edits plus where the selection ends up.
 */

export interface Sel {
  from: number
  to: number
}

export interface Edit {
  from: number
  to: number
  insert: string
}

export interface Result {
  edits: Edit[]
  /** The selection in the edited document. */
  selection: Sel
}

export type InlineMark = '**' | '*' | '~~' | '`' | '=='
export type LineKind = 'bullet' | 'number' | 'task' | 'quote'

/** Text colours offered by the toolbar (readable on light and dark backgrounds). */
export const TEXT_COLORS: { name: string; value: string }[] = [
  { name: 'Red', value: '#e5484d' },
  { name: 'Orange', value: '#f76b15' },
  { name: 'Amber', value: '#d4a017' },
  { name: 'Green', value: '#30a46c' },
  { name: 'Teal', value: '#12a594' },
  { name: 'Blue', value: '#0090ff' },
  { name: 'Purple', value: '#8e4ec6' },
  { name: 'Pink', value: '#d6409f' },
  { name: 'Grey', value: '#8b8d98' }
]

/** Applies edits (non-overlapping, any order) to a document; tests and callers without CodeMirror use it. */
export function applyEdits(doc: string, edits: Edit[]): string {
  return [...edits].sort((a, b) => b.from - a.from).reduce((d, e) => d.slice(0, e.from) + e.insert + d.slice(e.to), doc)
}

const isWord = (c: string | undefined): boolean => !!c && /[\p{L}\p{N}_'-]/u.test(c)

/** How many times `ch` repeats right before `at` / from `at` on. */
const runBefore = (doc: string, at: number, ch: string): number => { let n = 0; while (at - n - 1 >= 0 && doc[at - n - 1] === ch) n++; return n }
const runAfter = (doc: string, at: number, ch: string): number => { let n = 0; while (doc[at + n] === ch) n++; return n }

/** Whether the text at [from, to) is wrapped in `mark` just outside it (telling *italic* from **bold**). */
function wrappedBy(doc: string, from: number, to: number, mark: InlineMark): boolean {
  if (mark === '*' || mark === '**') {
    const before = runBefore(doc, from, '*')
    const after = runAfter(doc, to, '*')
    return mark === '*' ? before % 2 === 1 && after % 2 === 1 : before >= 2 && after >= 2
  }
  return doc.slice(from - mark.length, from) === mark && doc.slice(to, to + mark.length) === mark
}

/**
 * Bold, italic, strikethrough, inline code, highlight: wraps the selection (trimmed of spaces, which Markdown does not
 * allow inside the marks) or unwraps it when it already is. With nothing selected it works on the word at the cursor,
 * or leaves the cursor between a new pair of marks. A selection over several lines is done line by line.
 */
export function toggleInline(doc: string, sel: Sel, mark: InlineMark): Result {
  let { from, to } = sel
  if (from === to) {
    let a = from
    let b = to
    while (isWord(doc[a - 1])) a--
    while (isWord(doc[b])) b++
    if (a === b) return { edits: [{ from, to, insert: mark + mark }], selection: { from: from + mark.length, to: from + mark.length } }
    from = a
    to = b
  }
  // The marks themselves selected too: "**bold**" → "bold".
  const text = doc.slice(from, to)
  if (text.length > 2 * mark.length && text.startsWith(mark) && text.endsWith(mark) && (mark !== '*' || !text.startsWith('**') || text.startsWith('***'))) {
    const inner = text.slice(mark.length, -mark.length)
    return { edits: [{ from, to, insert: inner }], selection: { from, to: from + inner.length } }
  }
  if (wrappedBy(doc, from, to, mark)) {
    const edits = [{ from: from - mark.length, to: from, insert: '' }, { from: to, to: to + mark.length, insert: '' }]
    return { edits, selection: { from: from - mark.length, to: to - mark.length } }
  }
  if (text.includes('\n')) {
    const edits: Edit[] = []
    let at = from
    let shift = 0
    for (const line of text.split('\n')) {
      const lead = line.length - line.trimStart().length
      const body = line.trim()
      if (body) {
        edits.push({ from: at + lead, to: at + lead, insert: mark })
        edits.push({ from: at + lead + body.length, to: at + lead + body.length, insert: mark })
        shift += 2 * mark.length
      }
      at += line.length + 1
    }
    return { edits, selection: { from, to: to + shift } }
  }
  const lead = text.length - text.trimStart().length
  const trail = text.length - text.trimEnd().length
  const a = from + lead
  const b = to - trail
  if (a >= b) return { edits: [], selection: sel }
  return { edits: [{ from: a, to: a, insert: mark }, { from: b, to: b, insert: mark }], selection: { from: a + mark.length, to: b + mark.length } }
}

/** The lines a selection touches: their start offsets and text. */
function linesOf(doc: string, sel: Sel): { start: number; text: string }[] {
  const start = doc.lastIndexOf('\n', sel.from - 1) + 1
  let end = doc.indexOf('\n', Math.max(sel.to - (sel.to > sel.from && doc[sel.to - 1] === '\n' ? 1 : 0), sel.from))
  if (end < 0) end = doc.length
  const out: { start: number; text: string }[] = []
  let at = start
  for (const text of doc.slice(start, end).split('\n')) {
    out.push({ start: at, text })
    at += text.length + 1
  }
  return out
}

/** Maps a position through edits made at or before it (all the line commands only insert/delete at line starts). */
function shiftThrough(pos: number, edits: Edit[], bias: 'start' | 'end'): number {
  let p = pos
  for (const e of edits) {
    if (e.from > pos || (e.from === pos && bias === 'start' && e.insert && e.to === e.from)) continue
    const removed = Math.min(e.to, pos) - e.from
    p += e.insert.length - Math.max(0, removed)
  }
  return Math.max(0, p)
}

const finish = (doc: string, sel: Sel, edits: Edit[]): Result => {
  const lines = linesOf(doc, sel)
  const firstStart = lines[0].start
  const from = sel.from === firstStart && sel.from === sel.to ? shiftThrough(sel.from, edits, 'end') : shiftThrough(sel.from, edits, 'end')
  return { edits, selection: { from: Math.max(from, firstStart), to: shiftThrough(sel.to, edits, 'end') } }
}

const PREFIX = /^(\s*)(?:(?:[-*+]) \[[ xX]\] |[-*+] |\d+[.)] |> ?)?/

/** Headings: sets the lines to `level` (0 = body text), replacing any heading or list marks they had. */
export function setHeading(doc: string, sel: Sel, level: number): Result {
  const edits: Edit[] = []
  for (const { start, text } of linesOf(doc, sel)) {
    const m = /^(\s*)(#{1,6} +)?/.exec(text)!
    const insert = level > 0 ? `${'#'.repeat(level)} ` : ''
    const from = start + m[1].length
    const to = from + (m[2]?.length ?? 0)
    if (doc.slice(from, to) !== insert) edits.push({ from, to, insert })
  }
  return finish(doc, sel, edits)
}

/**
 * Bullets, numbers, tasks, quotes: turns the lines into that kind (renumbering 1, 2, 3…), replacing another kind's
 * mark, or back to plain lines when they all are that kind already. Indentation is kept, so nested lists stay nested.
 */
export function toggleLinePrefix(doc: string, sel: Sel, kind: LineKind): Result {
  const lines = linesOf(doc, sel)
  const is = (t: string): boolean => {
    const rest = t.trimStart()
    return kind === 'task' ? /^[-*+] \[[ xX]\] /.test(rest)
      : kind === 'bullet' ? /^[-*+] (?!\[[ xX]\] )/.test(rest)
        : kind === 'number' ? /^\d+[.)] /.test(rest)
          : /^>/.test(rest)
  }
  const content = lines.filter((l) => l.text.trim())
  const all = content.length > 0 && content.every((l) => is(l.text))
  const edits: Edit[] = []
  let n = 0
  for (const { start, text } of lines) {
    if (!text.trim() && lines.length > 1) continue
    const m = PREFIX.exec(text)!
    const from = start + m[1].length
    const to = start + m[0].length
    n++
    const insert = all ? '' : kind === 'bullet' ? '- ' : kind === 'number' ? `${n}. ` : kind === 'task' ? '- [ ] ' : '> '
    if (doc.slice(from, to) !== insert) edits.push({ from, to, insert })
  }
  return finish(doc, sel, edits)
}

const SPAN = /<span style="color:\s*([^";]+);?">([\s\S]*?)<\/span>/g

/**
 * Text colour: wraps the selection in <span style="color:…">, or changes / removes (null) the colour of a coloured
 * span the selection is in or covers.
 */
export function setColor(doc: string, sel: Sel, color: string | null): Result {
  // A coloured span around or under the selection.
  SPAN.lastIndex = 0
  for (let m = SPAN.exec(doc); m; m = SPAN.exec(doc)) {
    const open = m.index
    const close = open + m[0].length
    const innerFrom = open + m[0].indexOf('>') + 1
    const innerTo = close - '</span>'.length
    if (sel.from >= open && sel.to <= close && (sel.from <= innerTo && sel.to >= innerFrom)) {
      if (!color) {
        return { edits: [{ from: innerTo, to: close, insert: '' }, { from: open, to: innerFrom, insert: '' }], selection: { from: open, to: open + (innerTo - innerFrom) } }
      }
      const tag = `<span style="color:${color}">`
      return { edits: [{ from: open, to: innerFrom, insert: tag }], selection: { from: open + tag.length, to: open + tag.length + (innerTo - innerFrom) } }
    }
  }
  if (!color) return { edits: [], selection: sel }
  let { from, to } = sel
  if (from === to) {
    while (isWord(doc[from - 1])) from--
    while (isWord(doc[to])) to++
  }
  const text = doc.slice(from, to)
  const a = from + (text.length - text.trimStart().length)
  const b = to - (text.length - text.trimEnd().length)
  const tag = `<span style="color:${color}">`
  if (a >= b) return { edits: [{ from: sel.from, to: sel.to, insert: `${tag}</span>` }], selection: { from: sel.from + tag.length, to: sel.from + tag.length } }
  return { edits: [{ from: a, to: a, insert: tag }, { from: b, to: b, insert: '</span>' }], selection: { from: a + tag.length, to: b + tag.length } }
}

/** A link: [selected text](url) with "url" selected to type over; a selected address becomes [](address). */
export function insertLink(doc: string, sel: Sel): Result {
  const text = doc.slice(sel.from, sel.to)
  if (/^https?:\/\/\S+$/.test(text)) {
    return { edits: [{ from: sel.from, to: sel.to, insert: `[](${text})` }], selection: { from: sel.from + 1, to: sel.from + 1 } }
  }
  const label = text || 'link'
  const insert = `[${label}](url)`
  const urlAt = sel.from + label.length + 3
  return { edits: [{ from: sel.from, to: sel.to, insert }], selection: text ? { from: urlAt, to: urlAt + 3 } : { from: sel.from + 1, to: sel.from + 1 + label.length } }
}

/** Code block, divider or table, on lines of their own. */
export function insertBlock(doc: string, sel: Sel, kind: 'code' | 'hr' | 'table'): Result {
  const lines = linesOf(doc, sel)
  const start = lines[0].start
  const end = lines[lines.length - 1].start + lines[lines.length - 1].text.length
  const before = start > 0 && doc[start - 1] === '\n' && start > 1 && doc[start - 2] !== '\n' ? '\n' : ''
  if (kind === 'code') {
    const body = doc.slice(start, end)
    const insert = `${before}\`\`\`\n${body}\n\`\`\``
    const at = start + before.length + 4
    return { edits: [{ from: start, to: end, insert }], selection: body ? { from: at, to: at + body.length } : { from: at, to: at } }
  }
  const lineEmpty = !doc.slice(start, end).trim()
  const block = kind === 'hr' ? '---' : '| Column | Column |\n| --- | --- |\n|  |  |'
  const at = lineEmpty ? start : end
  const lead = lineEmpty ? before : '\n\n'
  const insert = `${lead}${block}\n`
  const caret = kind === 'table' ? at + lead.length + 2 : at + insert.length
  return { edits: [{ from: lineEmpty ? start : end, to: lineEmpty ? end : end, insert }], selection: kind === 'table' ? { from: caret, to: caret + 6 } : { from: caret, to: caret } }
}

/** Clear formatting: removes the marks, colours and line styles (headings, lists, quotes) from the selected lines. */
export function clearFormatting(doc: string, sel: Sel): Result {
  const lines = linesOf(doc, sel)
  const start = lines[0].start
  const end = lines[lines.length - 1].start + lines[lines.length - 1].text.length
  const cleaned = doc.slice(start, end).split('\n').map((line) => line
    .replace(/^(\s*)#{1,6} +/, '$1')
    .replace(PREFIX, '$1')
    .replace(SPAN, '$2')
    .replace(/\*\*((?:[^*\n]|\*(?!\*))+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/==([^=\n]+)==/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
  ).join('\n')
  if (cleaned === doc.slice(start, end)) return { edits: [], selection: sel }
  return { edits: [{ from: start, to: end, insert: cleaned }], selection: { from: start, to: start + cleaned.length } }
}

/** Which inline marks and line style the cursor is in, for the toolbar's pressed buttons. */
export function activeFormats(doc: string, pos: number): { marks: InlineMark[]; heading: number; line: LineKind | null; color: string | null } {
  const lineStart = doc.lastIndexOf('\n', pos - 1) + 1
  let lineEnd = doc.indexOf('\n', pos)
  if (lineEnd < 0) lineEnd = doc.length
  const line = doc.slice(lineStart, lineEnd)
  const col = pos - lineStart
  const inside = (re: RegExp): boolean => {
    re.lastIndex = 0
    for (let m = re.exec(line); m; m = re.exec(line)) if (col > m.index && col < m.index + m[0].length) return true
    return false
  }
  const marks: InlineMark[] = []
  if (inside(/\*\*(?:[^*\n]|\*(?!\*))+\*\*/g)) marks.push('**')
  if (inside(/(?<!\*)\*[^*\n]+\*(?!\*)/g) || inside(/\*\*\*[^*\n]+\*\*\*/g)) marks.push('*')
  if (inside(/~~[^~\n]+~~/g)) marks.push('~~')
  if (inside(/`[^`\n]+`/g)) marks.push('`')
  if (inside(/==[^=\n]+==/g)) marks.push('==')
  const h = /^\s*(#{1,6}) /.exec(line)
  const rest = line.trimStart()
  const kind: LineKind | null = /^[-*+] \[[ xX]\] /.test(rest) ? 'task' : /^[-*+] /.test(rest) ? 'bullet' : /^\d+[.)] /.test(rest) ? 'number' : /^>/.test(rest) ? 'quote' : null
  let color: string | null = null
  SPAN.lastIndex = 0
  for (let m = SPAN.exec(line); m; m = SPAN.exec(line)) if (col > m.index && col < m.index + m[0].length) color = m[1].trim()
  return { marks, heading: h ? h[1].length : 0, line: kind, color }
}

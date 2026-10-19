/**
 * The Notes editor's live mode, like Obsidian's Live Preview: Markdown marks (**, #, -, [ ], > …) are hidden except
 * on the line being edited, so text shows as it will look; task markers are checkboxes, bullets are dots, coloured
 * spans show their colour, dividers are lines, and ⌘-click opens links. The text itself stays plain Markdown.
 */
import { syntaxTree } from '@codemirror/language'
import type { Extension, Range } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view'
import { Tag, tags } from '@lezer/highlight'
import type { MarkdownConfig } from '@lezer/markdown'

/** Obsidian's ==highlight== as a syntax node, so both editor modes can style it. */
export const highlightTag = Tag.define()
const HighlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' }
export const Highlight: MarkdownConfig = {
  defineNodes: [
    { name: 'Highlight', style: { 'Highlight/...': highlightTag } },
    { name: 'HighlightMark', style: tags.processingInstruction }
  ],
  parseInline: [{
    name: 'Highlight',
    parse(cx, next, pos) {
      if (next !== 61 || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1
      const before = cx.slice(pos - 1, pos)
      const after = cx.slice(pos + 2, pos + 3)
      return cx.addDelimiter(HighlightDelim, pos, pos + 2, !/\s|^$/.test(after), !/\s|^$/.test(before))
    },
    after: 'Emphasis'
  }]
}

class Bullet extends WidgetType {
  eq(): boolean { return true }
  toDOM(): HTMLElement {
    const s = document.createElement('span')
    s.className = 'cm-live-bullet'
    s.textContent = '•'
    return s
  }
}

class Checkbox extends WidgetType {
  constructor(readonly checked: boolean) { super() }
  eq(other: Checkbox): boolean { return other.checked === this.checked }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'cm-live-task'
    box.checked = this.checked
    box.setAttribute('aria-label', this.checked ? 'Mark as not done' : 'Mark as done')
    box.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const pos = view.posAtDOM(box)
      if (/^\[[ xX]\]$/.test(view.state.sliceDoc(pos, pos + 3))) view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: this.checked ? ' ' : 'x' }, userEvent: 'input.check' })
    })
    return box
  }
  ignoreEvent(): boolean { return false }
}

class Rule extends WidgetType {
  eq(): boolean { return true }
  toDOM(): HTMLElement {
    const hr = document.createElement('span')
    hr.className = 'cm-live-hr'
    return hr
  }
}

const hide = Decoration.replace({})
const SPAN = /<span style="color:\s*([^";]+);?">([^<]*)<\/span>/g
const WIKI = /\[\[([^\]\n]+)\]\]/g
/** Colours as written by the toolbar or by hand: hex, rgb()/hsl(), or a colour name; never anything else in style. */
const SAFE_COLOR = /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([\d\s.,%]+\)|[a-z]{3,20})$/i

function build(view: EditorView): DecorationSet {
  const { state } = view
  const doc = state.doc
  // Lines with a cursor or selection show their raw Markdown, so it can be edited.
  const active = new Set<number>()
  for (const r of state.selection.ranges) {
    for (let l = doc.lineAt(r.from).number; l <= doc.lineAt(r.to).number; l++) active.add(l)
  }
  const isActive = (pos: number): boolean => active.has(doc.lineAt(pos).number)
  const out: Range<Decoration>[] = []
  const lines = (from: number, to: number, cls: string): void => {
    for (let l = doc.lineAt(from).number; l <= doc.lineAt(to).number; l++) out.push(Decoration.line({ class: cls }).range(doc.line(l).from))
  }
  const spaceAfter = (pos: number): number => (doc.sliceString(pos, pos + 1) === ' ' ? 1 : 0)

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        switch (node.name) {
          case 'FencedCode':
            lines(node.from, node.to, 'cm-live-codeblock')
            return false
          case 'Blockquote':
            lines(node.from, node.to, 'cm-live-quote')
            return
          case 'InlineCode':
            out.push(Decoration.mark({ class: 'cm-live-code' }).range(node.from, node.to))
            return
        }
        if (isActive(node.from)) return
        switch (node.name) {
          case 'HeaderMark':
            if (node.node.parent?.name.startsWith('ATXHeading')) out.push(hide.range(node.from, node.to + spaceAfter(node.to)))
            break
          case 'EmphasisMark':
          case 'StrikethroughMark':
          case 'HighlightMark':
            out.push(hide.range(node.from, node.to))
            break
          case 'CodeMark':
            if (node.node.parent?.name === 'InlineCode') out.push(hide.range(node.from, node.to))
            break
          case 'QuoteMark':
            out.push(hide.range(node.from, node.to + spaceAfter(node.to)))
            break
          case 'ListMark': {
            const item = node.node.parent
            if (item?.getChild('Task')) out.push(hide.range(node.from, node.to + spaceAfter(node.to)))
            else if (item?.parent?.name === 'BulletList') out.push(Decoration.replace({ widget: new Bullet() }).range(node.from, node.to))
            break
          }
          case 'TaskMarker': {
            const checked = /x/i.test(doc.sliceString(node.from, node.to))
            out.push(Decoration.replace({ widget: new Checkbox(checked) }).range(node.from, node.to))
            const end = doc.lineAt(node.to).to
            if (checked && end > node.to + 1) out.push(Decoration.mark({ class: 'cm-live-done' }).range(node.to + 1, end))
            break
          }
          case 'HorizontalRule':
            out.push(Decoration.replace({ widget: new Rule() }).range(node.from, node.to))
            break
          case 'Link': {
            // [text](url): the text, styled as a link; the brackets and the address hidden.
            const marks = node.node.getChildren('LinkMark')
            if (marks.length >= 3 && doc.sliceString(marks[0].from, marks[0].to) === '[') {
              out.push(hide.range(marks[0].from, marks[0].to))
              out.push(Decoration.mark({ class: 'cm-live-link' }).range(marks[0].to, marks[1].from))
              out.push(hide.range(marks[1].from, node.to))
            }
            return false
          }
        }
      }
    })
    // Coloured spans and [[wiki links]] are found by pattern, line by line.
    for (let pos = from; pos <= to;) {
      const line = doc.lineAt(pos)
      const lineActive = active.has(line.number)
      for (const m of line.text.matchAll(SPAN)) {
        const start = line.from + m.index
        const open = m[0].indexOf('>') + 1
        const innerFrom = start + open
        const innerTo = start + m[0].length - '</span>'.length
        const color = m[1].trim()
        if (SAFE_COLOR.test(color) && innerTo > innerFrom) out.push(Decoration.mark({ attributes: { style: `color: ${color}` } }).range(innerFrom, innerTo))
        if (!lineActive) {
          out.push(hide.range(start, innerFrom))
          out.push(hide.range(innerTo, start + m[0].length))
        }
      }
      for (const m of line.text.matchAll(WIKI)) {
        const start = line.from + m.index
        out.push(Decoration.mark({ class: 'cm-live-wikilink' }).range(start + 2, start + m[0].length - 2))
        if (!lineActive) {
          out.push(hide.range(start, start + 2))
          out.push(hide.range(start + m[0].length - 2, start + m[0].length))
        }
      }
      pos = line.to + 1
    }
  }
  return Decoration.set(out, true)
}

/** The link under a position: a note ([[name]]) or a web address ([text](url) or a bare URL). */
function linkAt(view: EditorView, pos: number): { note?: string; url?: string } | null {
  const line = view.state.doc.lineAt(pos)
  const col = pos - line.from
  for (const m of line.text.matchAll(WIKI)) if (col >= m.index && col <= m.index + m[0].length) return { note: m[1].split('|')[0].split('#')[0].trim() }
  for (let n: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null = syntaxTree(view.state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === 'Link' || n.name === 'URL') {
      const url = n.name === 'URL' ? n : n.getChild('URL')
      if (url) return { url: view.state.sliceDoc(url.from, url.to) }
    }
  }
  for (const m of line.text.matchAll(/https?:\/\/[^\s)>\]]+/g)) if (col >= m.index && col <= m.index + m[0].length) return { url: m[0] }
  return null
}

const liveTheme = EditorView.baseTheme({
  '.cm-live-bullet': { color: 'var(--accent)', fontWeight: '700', padding: '0 .35em 0 .1em' },
  '.cm-live-task': { margin: '0 .5em 0 0', verticalAlign: '-0.1em', cursor: 'pointer', accentColor: 'var(--accent)' },
  '.cm-live-done': { color: 'var(--muted)', textDecoration: 'line-through' },
  '.cm-live-quote': { borderLeft: '3px solid var(--border-strong)', paddingLeft: '12px !important', color: 'var(--text-2)' },
  '.cm-live-codeblock': { background: 'var(--panel-2)', fontFamily: 'var(--mono-font)', fontSize: '.92em' },
  '.cm-live-code': { background: 'var(--panel-2)', borderRadius: '4px', padding: '0 .2em' },
  '.cm-live-link, .cm-live-wikilink': { color: 'var(--accent)', textDecoration: 'underline', textDecorationColor: 'color-mix(in srgb, var(--accent) 45%, transparent)', textUnderlineOffset: '2px' },
  '.cm-live-hr': { display: 'inline-block', width: '100%', verticalAlign: 'middle', borderTop: '1px solid var(--border-strong)' }
})

/**
 * Live mode for the Notes editor. `onLink` opens what a ⌘-click lands on (a plain click places the cursor, showing
 * that line's Markdown for editing).
 */
export function livePreview(onLink: (link: { note?: string; url?: string }) => void): Extension {
  return [
    ViewPlugin.fromClass(class {
      decorations: DecorationSet
      constructor(view: EditorView) { this.decorations = build(view) }
      update(u: ViewUpdate): void {
        if (u.docChanged || u.viewportChanged || u.selectionSet || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = build(u.view)
      }
    }, { decorations: (v) => v.decorations }),
    EditorView.domEventHandlers({
      mousedown(e, view) {
        if (!e.metaKey) return false
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
        const link = pos === null ? null : linkAt(view, pos)
        if (!link) return false
        e.preventDefault()
        onLink(link)
        return true
      }
    }),
    liveTheme
  ]
}

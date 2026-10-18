/**
 * Markdown for the Notes tab: GitHub-flavoured Markdown plus Obsidian's [[wiki links]] ([[Note]], [[Note|alias]],
 * [[Note#Heading]]; ![[embeds]] become plain links). Free of the DOM so tests can load it; the tab sanitises the HTML
 * with DOMPurify before showing it. Links become anchors the tab intercepts: data-note for notes, href for the web.
 */
import { Marked, type TokenizerAndRendererExtension } from 'marked'

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

interface WikiToken { type: 'wikilink'; raw: string; target: string; label: string }

const wikilink: TokenizerAndRendererExtension = {
  name: 'wikilink',
  level: 'inline',
  start: (src) => src.match(/!?\[\[/)?.index,
  tokenizer(src) {
    const m = /^!?\[\[([^\]|#\n]+)(#[^\]|\n]*)?(?:\|([^\]\n]+))?\]\]/.exec(src)
    if (!m) return undefined
    const target = m[1].trim()
    return { type: 'wikilink', raw: m[0], target, label: (m[3] ?? `${target}${m[2] ?? ''}`).trim() } satisfies WikiToken
  },
  renderer(token) {
    const t = token as unknown as WikiToken
    return `<a class="wikilink" href="#" data-note="${escapeHtml(t.target)}">${escapeHtml(t.label)}</a>`
  }
}

/** Obsidian's ==highlight==. */
const highlight: TokenizerAndRendererExtension = {
  name: 'highlight',
  level: 'inline',
  start: (src) => src.match(/==/)?.index,
  tokenizer(src) {
    const m = /^==(?![\s=])([^=\n]*?[^\s=])==(?!=)/.exec(src)
    if (!m) return undefined
    return { type: 'highlight', raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) }
  },
  renderer(token) {
    return `<mark>${this.parser.parseInline(token.tokens ?? [])}</mark>`
  }
}

const md = new Marked({ gfm: true, breaks: false }, { extensions: [wikilink, highlight] })

/** HTML for a note (not yet sanitised). */
export function noteToHtml(text: string): string {
  // Frontmatter is metadata (the host key, tags), not prose; Obsidian shows it as properties rather than text.
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
  return md.parse(body, { async: false }) as string
}

/** The note a [[link]] points at: same path, or same file name anywhere (Obsidian's shortest-path links). */
export function resolveWikiLink(target: string, paths: string[]): string | null {
  const t = target.trim().replace(/\.md$/i, '').toLowerCase()
  const exact = paths.find((p) => p.replace(/\.md$/i, '').toLowerCase() === t)
  if (exact) return exact
  return paths.find((p) => (p.split('/').pop() ?? '').replace(/\.md$/i, '').toLowerCase() === t.split('/').pop()) ?? null
}

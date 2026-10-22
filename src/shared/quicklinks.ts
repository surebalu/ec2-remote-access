/**
 * Launcher quicklinks (Raycast's): a keyword that opens a page, "aws" → the AWS sign-in portal. A link's URL may hold
 * `{query}`, filled with what is typed after the keyword ("jira ABC-1" → …/browse/ABC-1). It opens in a Browser space
 * of the app, or in the Mac's own browser (`space: 'external'`). Settings.quicklinks; Settings → Launcher and the
 * launcher's Create Quicklink edit them. tests/quicklinks.test.ts.
 */

export interface Quicklink {
  id: string
  name: string
  /** One word typed in the launcher to open it ("aws"); '' to find it by name only. */
  keyword: string
  url: string
  /** A Browser space id, or 'external' for the Mac's default browser. */
  space: string
}

export const EXTERNAL = 'external'
/** The Browser's first space, which every install has. */
export const DEFAULT_SPACE = 'general'

const PLACEHOLDER = /\{query\}/gi

export const takesQuery = (l: Pick<Quicklink, 'url'>): boolean => /\{query\}/i.test(l.url)

/**
 * The quicklink a launcher query names: its keyword as the first word (any case), and the rest as its query. A link
 * without `{query}` matches only its keyword alone, so "aws console" still searches.
 */
export function quicklinkFor(query: string, links: Quicklink[]): { link: Quicklink; rest: string } | null {
  const q = query.trim()
  if (!q) return null
  const sp = q.search(/\s/)
  const head = (sp < 0 ? q : q.slice(0, sp)).toLowerCase()
  const rest = sp < 0 ? '' : q.slice(sp + 1).trim()
  const link = links.find((l) => l.keyword && l.keyword.toLowerCase() === head && (!rest || takesQuery(l)))
  return link ? { link, rest } : null
}

/** The page to open: `{query}` replaced (encoded), or the URL as it is. */
export function quicklinkUrl(l: Pick<Quicklink, 'url'>, rest = ''): string {
  return l.url.replace(PLACEHOLDER, encodeURIComponent(rest))
}

/** What is wrong with a link as typed, or null. `others` are the other links, for a keyword already used. */
export function checkQuicklink(l: Pick<Quicklink, 'name' | 'keyword' | 'url'>, others: Quicklink[]): string | null {
  if (!l.name.trim()) return 'Give it a name.'
  if (l.keyword && !/^[^\s]{1,32}$/.test(l.keyword)) return 'The keyword is one word, with no spaces.'
  if (l.keyword && others.some((o) => o.keyword.toLowerCase() === l.keyword.toLowerCase())) return `“${l.keyword}” already opens another quicklink.`
  let u: URL
  try { u = new URL(quicklinkUrl(l, 'x')) } catch { return 'Enter a full address, starting with https://.' }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'Only web addresses (https://) can be quicklinks.'
  return null
}

/** A link as typed: trimmed, and an address without a scheme given https://. A keyword with a space is left for checkQuicklink to refuse. */
export function cleanQuicklink(l: Omit<Quicklink, 'id'> & { id?: string }): Quicklink {
  const url = l.url.trim()
  return {
    id: l.id || `ql-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: l.name.trim(),
    keyword: l.keyword.trim(),
    url: url && !/^[a-z][a-z0-9+.-]*:/i.test(url) ? `https://${url}` : url,
    space: l.space || DEFAULT_SPACE
  }
}

/**
 * The launcher's emoji search, as Raycast's: every emoji with its Unicode name and the words people search it by
 * (emojilib), found by the start of any of them, recently used first. The data is loaded by the launcher only when
 * the search opens (it is about 600 kB); this part is pure, for tests/emoji.test.ts.
 */

export interface EmojiEntry {
  char: string
  name: string
  group: string
  /** Search words: the name's words and emojilib's keywords, lower case. */
  words: string[]
}

type ByEmoji = Record<string, { name: string; group: string }>

/** In Unicode's order (the order of `byEmoji`), with emojilib's keywords added where it has them. */
export function buildEmojiList(byEmoji: ByEmoji, keywords: Record<string, string[]>): EmojiEntry[] {
  return Object.entries(byEmoji).map(([char, e]) => {
    const words = new Set(e.name.toLowerCase().split(/[\s_:-]+/).filter(Boolean))
    for (const k of keywords[char] ?? []) for (const w of k.toLowerCase().split(/[\s_]+/)) if (w && !/^[:;]/.test(w)) words.add(w)
    return { char, name: e.name, group: e.group, words: [...words] }
  })
}

const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
export const emojiTitle = (e: EmojiEntry): string => capitalise(e.name)

function score(e: EmojiEntry, terms: string[], whole: string): number {
  const name = e.name.toLowerCase()
  if (name === whole) return 100
  let total = 0
  for (const t of terms) {
    let best = 0
    for (const w of e.words) {
      if (w === t) best = Math.max(best, 30)
      else if (w.startsWith(t)) best = Math.max(best, 20)
    }
    if (!best) return 0
    total += best
  }
  // A name that starts with what was typed beats one that only has the words.
  if (name.startsWith(whole)) total += 25
  return total / terms.length
}

/** Matching emoji, best first; with nothing typed, the recent ones and then all of them in Unicode's order. */
export function searchEmoji(list: EmojiEntry[], query: string, recent: string[] = [], limit = 240): EmojiEntry[] {
  const whole = query.trim().toLowerCase()
  const rank = (c: string): number => { const i = recent.indexOf(c); return i < 0 ? 0 : 12 - Math.min(10, i) }
  if (!whole) {
    const byChar = new Map(list.map((e) => [e.char, e]))
    const first = recent.map((c) => byChar.get(c)).filter((e): e is EmojiEntry => !!e)
    const seen = new Set(first.map((e) => e.char))
    return [...first, ...list.filter((e) => !seen.has(e.char))].slice(0, limit)
  }
  const terms = whole.split(/\s+/)
  return list
    .map((e, i) => ({ e, i, s: score(e, terms, whole) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s + rank(b.e.char) - (a.s + rank(a.e.char)) || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.e)
}

/** Most recent first, without repeats, at most `keep`. */
export const noteRecentEmoji = (recent: string[], char: string, keep = 24): string[] => [char, ...recent.filter((c) => c !== char)].slice(0, keep)

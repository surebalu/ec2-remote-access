/**
 * The launcher (src/renderer/launcher, a Raycast-style search bar over any app): how a query ranks apps, files, hosts
 * and commands, how what you open often rises, and its calculator. Pure, so tests/launcher.test.ts covers it.
 */

/** An app on this Mac. */
export interface LauncherApp {
  name: string
  path: string
}

/** How often and how lately the launcher opened something, by result id ('app:/Applications/Safari.app'). */
export type LauncherUsage = Record<string, { count: number; last: number }>

/** The words of a name, camelCase humps included ("OneDrive" → one, drive). */
function words(text: string): string[] {
  return text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s\-_.()/·]+/).filter(Boolean)
}

/**
 * How well `text` matches what was typed, 0 for not at all: the whole name, then its start (shorter names first),
 * the start of a word, its initials ("vsc" for Visual Studio Code), anywhere, then its letters in order. Several typed
 * words must each match.
 */
export function matchScore(query: string, text: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 1
  const t = text.toLowerCase()
  if (t === q) return 100
  if (t.startsWith(q)) return 90 - Math.min(20, t.length - q.length) / 2
  const ws = words(text)
  const parts = q.split(/\s+/)
  if (parts.length > 1) {
    if (parts.every((p) => ws.some((w) => w.startsWith(p)))) return 72
    return parts.every((p) => t.includes(p)) ? 45 : 0
  }
  if (ws.some((w) => w.startsWith(q))) return 70
  if (q.length >= 2 && ws.map((w) => w[0]).join('').startsWith(q)) return 66
  if (t.includes(q)) return 50
  let i = 0
  for (const ch of t) if (ch === q[i]) i++
  return i === q.length && q.length >= 2 ? 20 : 0
}

/** Up to 30 points for what was opened often and lately; nothing for what never was. */
export function usageBoost(u: { count: number; last: number } | undefined, now: number): number {
  if (!u || u.count <= 0) return 0
  const age = now - u.last
  const day = 86_400_000
  const recency = age < day ? 1 : age < 7 * day ? 0.6 : age < 30 * day ? 0.3 : 0.1
  return Math.min(30, Math.log2(1 + u.count) * 8) * recency
}

/** The items matching `query`, best first: how well the name matches, plus how often and lately it was opened. */
export function rank<T>(items: T[], query: string, opts: { text: (x: T) => string; id: (x: T) => string; usage?: LauncherUsage; now?: number }): T[] {
  const now = opts.now ?? Date.now()
  return items
    .map((x) => {
      const m = matchScore(query, opts.text(x))
      return { x, s: m ? m + usageBoost(opts.usage?.[opts.id(x)], now) : 0 }
    })
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s || opts.text(a.x).localeCompare(opts.text(b.x)))
    .map((r) => r.x)
}

/** The ids opened most lately and most often, for the launcher's suggestions before anything is typed. */
export function recentIds(usage: LauncherUsage, now: number, limit: number): string[] {
  return Object.entries(usage)
    .map(([id, u]) => ({ id, s: usageBoost(u, now) + u.last / 1e15 }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((r) => r.id)
}

/** One more use of `id`, keeping the 400 most recent. */
export function recordUse(usage: LauncherUsage, id: string, now: number): LauncherUsage {
  const next = { ...usage, [id]: { count: (usage[id]?.count ?? 0) + 1, last: now } }
  const ids = Object.keys(next)
  if (ids.length <= 400) return next
  return Object.fromEntries(Object.entries(next).sort((a, b) => b[1].last - a[1].last).slice(0, 400))
}

const FUNCTIONS: Record<string, (x: number) => number> = {
  sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil, ln: Math.log, log: Math.log10, sin: Math.sin, cos: Math.cos, tan: Math.tan
}
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E }

/**
 * The value of an arithmetic expression ("2*(3+4)", "1.5^2", "sqrt(2)", "200 * 15%", "1,250 / 4"), or null when the
 * text is not one. A bare number is not a calculation. Parsed by hand: nothing typed is ever evaluated as code.
 */
export function calculate(input: string): number | null {
  const src = input.trim().replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-')
  if (!src || src.length > 200) return null
  const tokens = src.match(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d*\.\d+|\d+|[a-z]+|\*\*|[-+*/^%()]|\S/gi)
  if (!tokens) return null
  if (!tokens.some((t) => /^(\*\*|[-+*/^%])$/.test(t) || FUNCTIONS[t.toLowerCase()])) return null
  let i = 0
  const peek = (): string | undefined => tokens[i]
  const take = (): string | undefined => tokens[i++]
  const fail = (): never => { throw new Error('not arithmetic') }

  const primary = (): number => {
    const t = take()
    if (t === undefined) return fail()
    let v: number
    if (t === '(') {
      v = expr()
      if (take() !== ')') fail()
    } else if (/^[\d.,]+$/.test(t)) {
      v = Number(t.replace(/,/g, ''))
    } else if (FUNCTIONS[t.toLowerCase()]) {
      if (take() !== '(') fail()
      v = FUNCTIONS[t.toLowerCase()](expr())
      if (take() !== ')') fail()
    } else if (CONSTANTS[t.toLowerCase()] !== undefined) {
      v = CONSTANTS[t.toLowerCase()]
    } else {
      return fail()
    }
    // A percent sign after a value is that many hundredths ("15%" is 0.15).
    while (peek() === '%') { take(); v /= 100 }
    return v
  }
  // Powers bind tighter than a leading minus (-2^2 is -4) and group to the right (2^3^2 is 2^9).
  const power = (): number => {
    const base = primary()
    if (peek() === '^' || peek() === '**') { take(); return base ** unary() }
    return base
  }
  const unary = (): number => {
    if (peek() === '-') { take(); return -unary() }
    if (peek() === '+') { take(); return unary() }
    return power()
  }
  const term = (): number => {
    let v = unary()
    while (peek() === '*' || peek() === '/') v = take() === '*' ? v * unary() : v / unary()
    return v
  }
  const expr = (): number => {
    let v = term()
    while (peek() === '+' || peek() === '-') v = take() === '+' ? v + term() : v - term()
    return v
  }
  try {
    const v = expr()
    return i === tokens.length && Number.isFinite(v) ? Number(v.toPrecision(12)) : null
  } catch {
    return null
  }
}

/** A result as the launcher shows it: grouped thousands, at most 10 decimals ("1,234.5"). */
export function formatNumber(n: number): string {
  if (Math.abs(n) >= 1e21 || (n !== 0 && Math.abs(n) < 1e-10)) return n.toExponential(6)
  return n.toLocaleString('en-US', { maximumFractionDigits: 10 })
}

/**
 * How often and how lately each tool is opened, for the home page's Tools (the ones you use most first). Frecency: every
 * use counts one, halving each week, so a tool used daily this week outranks one used a lot a month ago. Pure, so
 * tests/usage.test.ts covers it; the renderer keeps the counts in localStorage (toolUsage.ts).
 */

export interface Use { n: number; at: number }

export const HALF_LIFE_MS = 7 * 86_400_000

const decay = (ms: number): number => Math.pow(0.5, Math.max(0, ms) / HALF_LIFE_MS)

/** One more use at `now`. */
export const bump = (u: Use | undefined, now: number): Use => ({ n: (u ? u.n * decay(now - u.at) : 0) + 1, at: now })

/** What a tool's uses are worth now. */
export const score = (u: Use | undefined, now: number): number => (u ? u.n * decay(now - u.at) : 0)

/** The tools in order, most used first; ties (and tools never used) keep the given order. */
export function rank<T extends string>(tools: readonly T[], usage: Partial<Record<T, Use>>, now: number): T[] {
  return tools
    .map((t, i) => ({ t, i, s: score(usage[t], now) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.t)
}

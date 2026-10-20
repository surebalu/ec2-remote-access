/**
 * The launcher (src/renderer/launcher, a Raycast-style search bar over any app): how a query ranks apps, files, hosts
 * and commands, how what you open often rises, and its calculator. Pure, so tests/launcher.test.ts covers it.
 */

/** An app on this Mac. */
export interface LauncherApp {
  name: string
  path: string
}

/** The Mac commands the launcher offers (main/system.ts). */
export type SystemAction = 'sleep' | 'lock' | 'darkMode' | 'mute' | 'emptyTrash' | 'restart' | 'shutdown'

/** What the launcher's side pane shows for a file, folder or app. */
export interface LauncherPreview {
  path: string
  isDir: boolean
  /** Spotlight's kind ("PDF document", "Folder", "Application"). */
  kind: string
  size: number
  created: number
  modified: number
  lastOpened: number | null
  /** A Quick Look thumbnail (an app's icon, a document's first page) as a data URL, '' when there is none. */
  thumbnail: string
}

/**
 * Whether a Spotlight hit is one of your files, anywhere on the Mac (other disks included): not macOS's own folders,
 * not ~/Library (except cloud drives and iCloud Drive, where most documents live), not hidden, not inside an app,
 * package, Git or node_modules folder, and not an app itself (the launcher lists those as apps).
 */
export function wantedFile(path: string, home: string): boolean {
  if (/^\/(System|Library|private|usr|bin|sbin|cores|opt)\//.test(path)) return false
  const lib = `${home}/Library/`
  if (path.startsWith(lib) && !path.startsWith(`${lib}CloudStorage/`) && !path.startsWith(`${lib}Mobile Documents/`)) return false
  if (/\.app\/?$/i.test(path)) return false
  return !/\/\.|\/node_modules\/|\.(app|bundle|framework|photoslibrary|pkg|xcodeproj|xcassets)\//i.test(path)
}

/** A Spotlight query for file names holding every word typed, in any order, ignoring case and accents. */
export function nameQuery(query: string): string {
  const words = query.trim().split(/\s+/).map((w) => w.replace(/[\\"*?]/g, '')).filter(Boolean).slice(0, 6)
  return words.map((w) => `kMDItemFSName == "*${w}*"cd`).join(' && ')
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

interface Unit { dim: 'length' | 'mass' | 'temp' | 'data' | 'time' | 'volume'; factor: number; label: string }

/** Units by what you might type, each as a factor of its dimension's base (metre, gram, byte, second, litre). */
const UNITS: Record<string, Unit> = {}
const unit = (names: string[], dim: Unit['dim'], factor: number, label: string): void => { for (const n of names) UNITS[n] = { dim, factor, label } }
unit(['mm', 'millimeter', 'millimeters', 'millimetre', 'millimetres'], 'length', 0.001, 'mm')
unit(['cm', 'centimeter', 'centimeters', 'centimetre', 'centimetres'], 'length', 0.01, 'cm')
unit(['m', 'meter', 'meters', 'metre', 'metres'], 'length', 1, 'm')
unit(['km', 'kilometer', 'kilometers', 'kilometre', 'kilometres'], 'length', 1000, 'km')
unit(['in', 'inch', 'inches', '"'], 'length', 0.0254, 'in')
unit(['ft', 'foot', 'feet', "'"], 'length', 0.3048, 'ft')
unit(['yd', 'yard', 'yards'], 'length', 0.9144, 'yd')
unit(['mi', 'mile', 'miles'], 'length', 1609.344, 'mi')
unit(['mg', 'milligram', 'milligrams'], 'mass', 0.001, 'mg')
unit(['g', 'gram', 'grams'], 'mass', 1, 'g')
unit(['kg', 'kilo', 'kilos', 'kilogram', 'kilograms'], 'mass', 1000, 'kg')
unit(['t', 'tonne', 'tonnes'], 'mass', 1e6, 't')
unit(['oz', 'ounce', 'ounces'], 'mass', 28.349523125, 'oz')
unit(['lb', 'lbs', 'pound', 'pounds'], 'mass', 453.59237, 'lb')
unit(['c', '°c', 'celsius'], 'temp', 0, '°C')
unit(['f', '°f', 'fahrenheit'], 'temp', 0, '°F')
unit(['k', 'kelvin'], 'temp', 0, 'K')
unit(['b', 'byte', 'bytes'], 'data', 1, 'B')
unit(['kb', 'kilobyte', 'kilobytes'], 'data', 1e3, 'KB')
unit(['mb', 'megabyte', 'megabytes'], 'data', 1e6, 'MB')
unit(['gb', 'gigabyte', 'gigabytes'], 'data', 1e9, 'GB')
unit(['tb', 'terabyte', 'terabytes'], 'data', 1e12, 'TB')
unit(['pb', 'petabyte', 'petabytes'], 'data', 1e15, 'PB')
unit(['kib', 'kibibyte', 'kibibytes'], 'data', 1024, 'KiB')
unit(['mib', 'mebibyte', 'mebibytes'], 'data', 1024 ** 2, 'MiB')
unit(['gib', 'gibibyte', 'gibibytes'], 'data', 1024 ** 3, 'GiB')
unit(['tib', 'tebibyte', 'tebibytes'], 'data', 1024 ** 4, 'TiB')
unit(['bit', 'bits'], 'data', 1 / 8, 'bit')
unit(['ms', 'millisecond', 'milliseconds'], 'time', 0.001, 'ms')
unit(['s', 'sec', 'secs', 'second', 'seconds'], 'time', 1, 's')
unit(['min', 'mins', 'minute', 'minutes'], 'time', 60, 'min')
unit(['h', 'hr', 'hrs', 'hour', 'hours'], 'time', 3600, 'h')
unit(['d', 'day', 'days'], 'time', 86400, 'days')
unit(['wk', 'week', 'weeks'], 'time', 604800, 'weeks')
unit(['ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres'], 'volume', 0.001, 'ml')
unit(['l', 'liter', 'liters', 'litre', 'litres'], 'volume', 1, 'l')
unit(['gal', 'gallon', 'gallons'], 'volume', 3.785411784, 'gal')

const toKelvin = (v: number, u: string): number => (u === '°C' ? v + 273.15 : u === '°F' ? (v - 32) * 5 / 9 + 273.15 : v)
const fromKelvin = (v: number, u: string): number => (u === '°C' ? v - 273.15 : u === '°F' ? (v - 273.15) * 9 / 5 + 32 : v)

/**
 * A unit conversion: "5 GB to MiB", "100f in c", "90 min as h", "3.5 ft = cm". Null when the text is not one (or
 * the units measure different things). The number may itself be a sum ("2*1.5 km to mi").
 */
export function convert(input: string): { value: number; unit: string; from: string } | null {
  const m = /^\s*(.+?)\s*([a-z°'"]+)\s+(?:to|in|as|=)\s+([a-z°'"]+)\s*$/i.exec(input) ?? /^\s*(.+?)\s*([a-z°'"]+)\s*=\s*([a-z°'"]+)\s*$/i.exec(input)
  if (!m) return null
  const from = UNITS[m[2].toLowerCase()]
  const to = UNITS[m[3].toLowerCase()]
  if (!from || !to || from.dim !== to.dim) return null
  const n = /^-?\d*\.?\d+$/.test(m[1].replace(/,/g, '')) ? Number(m[1].replace(/,/g, '')) : calculate(m[1])
  if (n === null || !Number.isFinite(n)) return null
  const value = from.dim === 'temp' ? fromKelvin(toKelvin(n, from.label), to.label) : (n * from.factor) / to.factor
  return { value: Number(value.toPrecision(12)), unit: to.label, from: `${formatNumber(n)} ${from.label}` }
}

/** "PLM-123" or "inc-4211": a Jira issue key, upper-cased, or null. */
export function issueKey(input: string): string | null {
  const t = input.trim()
  return /^[a-z][a-z0-9]{1,9}-\d{1,7}$/i.test(t) ? t.toUpperCase() : null
}

/**
 * Where your Jira lives, from pages you opened in the Browser ("https://acme.atlassian.net/browse/PLM-1"): the most
 * recent site that showed an issue, and the space it was opened in. Null when there is none.
 */
export function jiraSite(pages: { url: string; space: string; at: number }[]): { base: string; space: string } | null {
  let best: { base: string; space: string; at: number } | null = null
  for (const p of pages) {
    const m = /^(https:\/\/[^/?#]+)\/(?:browse\/[A-Z][A-Z0-9]+-\d+|jira\/software\/)/.exec(p.url)
    if (m && (!best || p.at > best.at)) best = { base: m[1], space: p.space, at: p.at }
  }
  return best && { base: best.base, space: best.space }
}

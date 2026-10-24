/**
 * Plain-language commands for the launcher and the quick switcher: "open mainspringenergy.com", "ssh to 3dspace1 in
 * qa", "rdp into mse-sbalu", "restart tomee on 3dspace 2", "put slack on the left third", "remind me to renew the cert
 * friday". Read on this Mac with rules, never sent anywhere, and fitted to dictation too ("3D space one", "dot com").
 * readIntent() returns what a sentence could mean, best first, each with the words a row shows; the launcher and the
 * switcher turn them into rows that ↩ runs, so nothing happens on a guess. Pure, for tests/intent.test.ts.
 */
import type { SystemAction } from './launcher'
import { matchScore } from './launcher.ts'
import { WINDOW_LAYOUTS, type WindowLayout } from './windowLayouts.ts'

export interface IntentHost {
  key: string
  name: string
  /** 'windows' for remote desktop. */
  platform?: string
  profile: string
  /** The account's label ("Production", "QA"). */
  account: string
  region?: string
  state?: string
  privateIp?: string
  publicIp?: string
  instanceId?: string
  /** Tag values, other names it goes by. */
  tags?: string[]
}

export interface IntentApp { name: string; path: string }
export interface IntentSite { id: string; title: string; url: string; space: string }
export interface IntentSpace { id: string; name: string }
export interface IntentService { id: string; name: string; units: string[] }
export interface IntentAccount { profile: string; label: string }

export interface IntentContext {
  hosts: IntentHost[]
  apps?: IntentApp[]
  /** The Browser's favorites and open tabs. */
  sites?: IntentSite[]
  spaces?: IntentSpace[]
  services?: IntentService[]
  accounts?: IntentAccount[]
  /** The app's sections, by id and name ("notes" → "Notes"). */
  sections?: { id: string; name: string; words?: string }[]
}

export type IntentTool = 'emoji' | 'speed' | 'network' | 'monitor' | 'downloads' | 'processes'

export type Intent =
  | { kind: 'connect'; via: 'ssh' | 'rdp' | 'any'; host: IntentHost }
  | { kind: 'files'; host: IntentHost }
  | { kind: 'power'; action: 'start' | 'stop'; host: IntentHost }
  | { kind: 'forward'; host: IntentHost; port?: number }
  | { kind: 'service'; action: 'start' | 'stop' | 'restart' | 'status'; service: IntentService; host: IntentHost }
  | { kind: 'run'; host: IntentHost; command: string }
  | { kind: 'details'; host: IntentHost }
  | { kind: 'url'; url: string; space?: IntentSpace; external?: boolean }
  | { kind: 'site'; site: IntentSite }
  | { kind: 'console'; account?: IntentAccount }
  | { kind: 'app'; action: 'open' | 'quit'; app: IntentApp }
  | { kind: 'section'; section: string; name: string }
  | { kind: 'today' }
  | { kind: 'layout'; layout: WindowLayout; app?: IntentApp }
  | { kind: 'ask'; to: 'claude' | 'chatgpt'; text: string }
  | { kind: 'search'; text: string }
  | { kind: 'capture'; text: string; task: boolean }
  | { kind: 'task'; text: string }
  | { kind: 'kill'; name: string }
  | { kind: 'quitAll' }
  | { kind: 'system'; action: SystemAction }
  | { kind: 'tool'; tool: IntentTool; query?: string }

export interface IntentMatch {
  intent: Intent
  /** What the row says it will do: "SSH to MSQA-3DSpace-01". */
  title: string
  subtitle?: string
  /** 0–100: how sure the reading is. */
  score: number
}

// ----- the sentence -----

const FILLERS = /^(?:(?:hey|ok|okay|so|um+|uh+)[,\s]+|(?:please|pls|can you|could you|would you|will you|i want to|i'd like to|i would like to|i need to|let's|lets|go ahead and|just|quickly)\s+)/i
const NUMBER_WORDS: Record<string, string> = {
  zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11',
  twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20'
}

/** Drops what people (and dictation) put around a command: "Hey, could you please SSH to web 1?" → "SSH to web 1". */
export function cleanSentence(text: string): string {
  let s = text.trim().replace(/\s+/g, ' ')
  for (let i = 0; i < 4; i++) {
    const next = s.replace(FILLERS, '')
    if (next === s) break
    s = next
  }
  // Dictation spells an address out: "mainspring energy dot com", "jira slash browse".
  s = s.replace(/\s+dot\s+(?=[a-z])/gi, '.').replace(/\s+slash\s+/gi, '/')
  return s.replace(/[\s.!?,;]+$/, '').replace(/\s+please$/i, '')
}

/** Spoken numbers as digits, for names and ports: "three d space one" → "3 d space 1". */
const digits = (s: string): string => s.replace(/\b[a-z]+\b/gi, (w) => NUMBER_WORDS[w.toLowerCase()] ?? w)

/** A name as one run of letters and digits without leading zeros: "MSQA-3DSpace-01" → "msqa3dspace1", "3d space one" → "3dspace1". */
export function squash(s: string): string {
  return digits(s).toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/(^|[a-z])0+(?=\d)/g, '$1')
}

// ----- hosts -----

const HOST_NOISE = /\b(?:the|a|an|server|host|box|machine|instance|vm|my|our|node)\b/gi
const ENV_WORDS: Record<string, string[]> = {
  prod: ['prod', 'production', 'prd', 'pplm'], production: ['prod', 'production', 'prd', 'pplm'], qa: ['qa', 'qplm', 'test'], test: ['test', 'qa'],
  dev: ['dev', 'development', 'dplm'], development: ['dev', 'development', 'dplm'], staging: ['staging', 'stage', 'stg'], stage: ['staging', 'stage', 'stg']
}

/** A trailing (or leading) "in qa", "on production": the account to look in, when it names one. */
function splitQualifier(phrase: string, ctx: IntentContext): { rest: string; envs: string[] } {
  const known = new Set<string>()
  for (const h of ctx.hosts) for (const w of `${h.account} ${h.profile}`.toLowerCase().split(/[^a-z0-9]+/)) if (w) known.add(w)
  for (const a of ctx.accounts ?? []) for (const w of `${a.label} ${a.profile}`.toLowerCase().split(/[^a-z0-9]+/)) if (w) known.add(w)
  const envs: string[] = []
  let rest = phrase
  const take = (w: string): boolean => {
    const word = w.toLowerCase()
    if (!known.has(word) && !ENV_WORDS[word]) return false
    envs.push(word)
    return true
  }
  const tail = /\s+(?:in|on|from|at|for)\s+(?:the\s+)?([a-z0-9-]+)(?:\s+(?:account|environment|env))?$/i.exec(rest)
  if (tail && take(tail[1])) rest = rest.slice(0, tail.index)
  const head = /^([a-z0-9-]+)\s+(.+)$/i.exec(rest)
  if (head && rest.split(/\s+/).length > 1 && (ENV_WORDS[head[1].toLowerCase()] || (known.has(head[1].toLowerCase()) && !/\d/.test(head[1]))) && take(head[1])) rest = head[2]
  return { rest: rest.trim(), envs }
}

function inEnv(h: IntentHost, envs: string[]): boolean {
  if (!envs.length) return true
  const account = `${h.account} ${h.profile}`.toLowerCase()
  // A name's own parts may carry it too: "MSQA-3DSpace-01" is in QA.
  const parts = h.name.toLowerCase().split(/[^a-z0-9]+/)
  return envs.every((e) => (ENV_WORDS[e] ?? [e]).some((w) => new RegExp(`(^|[^a-z])${w}([^a-z]|$)`).test(account) || parts.some((p) => p === w || ((p.endsWith(w) || p.startsWith(w)) && p.length <= w.length + 3))))
}

/** Hosts a phrase names, best first: "3dspace1 in qa", "mse-sbalu", "10.0.2.15". `prefer` favours one kind of host. */
export function findHosts(phrase: string, ctx: IntentContext, prefer?: 'windows' | 'linux'): { host: IntentHost; score: number }[] {
  const { rest, envs } = splitQualifier(phrase.replace(HOST_NOISE, ' ').replace(/\s+/g, ' ').trim(), ctx)
  const raw = rest.trim().toLowerCase()
  const q = squash(rest)
  if (!q) return []
  const scored = ctx.hosts.filter((h) => inEnv(h, envs)).map((h) => {
    const names = [h.name, ...(h.tags ?? [])]
    let s = 0
    if ([h.instanceId, h.privateIp, h.publicIp].some((x) => x && x.toLowerCase() === raw)) s = 98
    for (const n of names) {
      const sq = squash(n)
      if (!sq) continue
      if (sq === q) s = Math.max(s, 100)
      else if (q.length >= 3 && (sq.endsWith(q) || sq.startsWith(q))) s = Math.max(s, 86)
      else if (q.length >= 3 && sq.includes(q)) s = Math.max(s, 78)
      else {
        const words = digits(rest).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(squash)
        if (words.length > 1 && words.every((w) => sq.includes(w))) s = Math.max(s, 64)
      }
    }
    if (s && prefer) s += (h.platform === 'windows') === (prefer === 'windows') ? 4 : -6
    if (s && h.state && h.state !== 'running') s -= 2
    return { host: h, score: s }
  }).filter((x) => x.score >= 60).sort((a, b) => b.score - a.score || a.host.name.localeCompare(b.host.name))
  if (!scored.length) return []
  // Close seconds stay (prod and qa both have a 3DSpace 01): a row each, never a guess.
  return scored.filter((x) => x.score >= scored[0].score - 8).slice(0, 6)
}

const where = (h: IntentHost): string => [h.account, h.region, h.privateIp ?? h.publicIp].filter(Boolean).join(' · ')

// ----- other things a sentence can name -----

/** Ends like a file, not a site ("bracket.step", "notes.md"): never read as an address. */
const FILE_ENDING = /\.(step|stp|iges|igs|brep|stl|glb|gltf|obj|3mf|sldprt|sldasm|slddrw|pdf|docx?|xlsx?|pptx?|txt|md|csv|json|ya?ml|png|jpe?g|gif|zip|tar|gz|dmg|pkg|log|sh|py|ts|js)$/i

export function looksLikeUrl(s: string): boolean {
  if (FILE_ENDING.test(s)) return false
  return /^(https?:\/\/)?(localhost|(\d{1,3}\.){3}\d{1,3}|([a-z0-9-]+\.)+[a-z]{2,})(:\d+)?(\/\S*)?$/i.test(s)
}

/** "mainspring energy.com" (dictation) → "mainspringenergy.com"; anything else as typed. */
function joinAddress(s: string): string {
  return /^[a-z0-9 -]+\.[a-z]{2,}(\/\S*)?$/i.test(s) && s.includes(' ') ? s.replace(/\s+/g, '') : s
}

function findSpace(word: string, ctx: IntentContext): IntentSpace | undefined {
  const w = word.toLowerCase()
  return (ctx.spaces ?? []).find((s) => s.name.toLowerCase() === w) ?? (ctx.spaces ?? []).find((s) => s.name.toLowerCase().startsWith(w))
}

/** "… in personal" (a Browser space), "… in safari" (the Mac's browser). */
function splitWhere(phrase: string, ctx: IntentContext): { rest: string; space?: IntentSpace; external?: boolean } {
  const m = /^(.+?)\s+(?:in|on|with|using)\s+(?:the\s+|my\s+)?(.+?)(?:\s+(?:space|profile|browser))?$/i.exec(phrase)
  if (!m) return { rest: phrase }
  if (/^(?:safari|chrome|arc|dia|firefox|default browser|mac'?s browser|external(?:ly)?|browser)$/i.test(m[2])) return { rest: m[1], external: true }
  const space = findSpace(m[2], ctx)
  return space ? { rest: m[1], space } : { rest: phrase }
}

const LAYOUT_ALIASES: Record<string, string> = {
  'left side': 'left-half', 'right side': 'right-half', left: 'left-half', right: 'right-half', top: 'top-half', bottom: 'bottom-half',
  'left third': 'first-third', 'right third': 'last-third', 'middle third': 'center-third', 'center third': 'center-third',
  'left two thirds': 'first-two-thirds', 'right two thirds': 'last-two-thirds', 'left quarter': 'first-fourth', 'right quarter': 'last-fourth',
  'top left': 'top-left-quarter', 'top right': 'top-right-quarter', 'bottom left': 'bottom-left-quarter', 'bottom right': 'bottom-right-quarter',
  'top left corner': 'top-left-quarter', 'top right corner': 'top-right-quarter', 'bottom left corner': 'bottom-left-quarter', 'bottom right corner': 'bottom-right-quarter',
  max: 'maximize', maximise: 'maximize', 'full size': 'maximize', 'fill the screen': 'maximize', fill: 'maximize', 'whole screen': 'maximize',
  'full screen': 'toggle-fullscreen', fullscreen: 'toggle-fullscreen', middle: 'center', centre: 'center', 'the middle': 'center',
  bigger: 'make-larger', larger: 'make-larger', smaller: 'make-smaller', 'next screen': 'next-display', 'next monitor': 'next-display',
  'other screen': 'next-display', 'other monitor': 'next-display', 'other display': 'next-display', 'previous screen': 'previous-display',
  'previous monitor': 'previous-display'
}
/** One word alone is too common to move a window ("top", "max"): these need a verb first ("snap left", "make it bigger"). */
const NEEDS_VERB = new Set(['left', 'right', 'top', 'bottom', 'max', 'fill', 'middle', 'bigger', 'larger', 'smaller', 'center', 'centre'])

function findLayout(phrase: string): WindowLayout | undefined {
  const p = phrase.toLowerCase().replace(/^(?:the|a)\s+/, '').replace(/\s+(?:of the screen|of the display|of the monitor|side of the screen)$/, '').replace(/-/g, ' ').trim()
  if (!p) return undefined
  const alias = LAYOUT_ALIASES[p]
  if (alias) return WINDOW_LAYOUTS.find((l) => l.id === alias)
  return WINDOW_LAYOUTS.find((l) => l.name.toLowerCase() === p) ?? WINDOW_LAYOUTS.find((l) => l.id.replace(/-/g, ' ') === p)
}

/**
 * Whether each typed word is the start of the name's next word, or the initials of the next few ("vs code" for
 * Visual Studio Code, "ms teams" for Microsoft Teams).
 */
function wordsMatch(phrase: string, name: string): boolean {
  const words = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  let i = 0
  for (const t of phrase.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    if (i < words.length && words[i].startsWith(t)) { i++; continue }
    const run = words.slice(i, i + t.length)
    if (t.length > 1 && run.length === t.length && run.every((w, k) => w[0] === t[k])) { i += t.length; continue }
    return false
  }
  return i > 0
}

function findApps(phrase: string, ctx: IntentContext): { app: IntentApp; score: number }[] {
  const p = phrase.trim()
  if (!p) return []
  return (ctx.apps ?? []).map((app) => ({ app, score: Math.min(95, Math.max(matchScore(p, app.name), wordsMatch(p, app.name) ? 80 : 0, squash(p) === squash(app.name) ? 95 : 0)) }))
    .filter((x) => x.score >= 60).sort((a, b) => b.score - a.score).slice(0, 3)
}

const TOOLS: [RegExp, IntentTool, string][] = [
  [/^(?:run (?:a )?)?speed ?test$|^test (?:my |the )?(?:internet|connection|network|speed|bandwidth)(?: speed)?$|^how fast is (?:my |the )?(?:internet|connection)$|^internet speed$/, 'speed', 'Speed Test'],
  [/^(?:what(?:'s| is) )?my (?:public )?ip(?: address)?$|^(?:show )?ip address(?:es)?$|^what(?:'s| is) my address$/, 'network', 'My IP Address'],
  [/^(?:system monitor|activity monitor|cpu(?: usage)?|memory(?: usage)?|ram(?: usage)?|system (?:load|usage|stats))$/, 'monitor', 'System Monitor'],
  [/^(?:my |the )?(?:latest |recent )?downloads?(?: folder)?$/, 'downloads', 'Downloads'],
  [/^(?:kill|end) (?:a )?process(?:es)?$|^processes$/, 'processes', 'Kill Process']
]

const SYSTEM: [RegExp, SystemAction, string][] = [
  [/^lock(?: (?:the |my )?(?:screen|mac|computer))?$/, 'lock', 'Lock Screen'],
  [/^(?:go to )?sleep$|^put (?:the |my )?(?:mac|computer) to sleep$|^sleep (?:the )?(?:mac|computer)$/, 'sleep', 'Sleep'],
  [/^(?:mute|unmute)(?: (?:the )?(?:sound|volume|audio|mac))?$/, 'mute', 'Mute or Unmute Sound'],
  [/^(?:toggle |switch to |turn on |turn off )?(?:dark|light) mode$/, 'darkMode', 'Toggle Dark Mode'],
  [/^empty (?:the )?trash$/, 'emptyTrash', 'Empty Trash…'],
  [/^(?:restart|reboot) (?:the |my )?(?:mac|computer)$/, 'restart', 'Restart…'],
  [/^(?:shut ?down|power off|turn off)(?: (?:the |my )?(?:mac|computer))?$/, 'shutdown', 'Shut Down…']
]

// ----- reading a sentence -----

/** Everything `text` could be asking for, best first; [] when it reads as a plain search. */
export function readIntent(text: string, ctx: IntentContext): IntentMatch[] {
  const sentence = cleanSentence(text)
  const low = sentence.toLowerCase()
  if (low.length < 2) return []
  const out: IntentMatch[] = []
  // The same words may mean two things (the app's Notes, Apple's Notes): a row each, told apart by their type.
  const add = (m: IntentMatch): void => { if (!out.some((x) => x.title === m.title && x.intent.kind === m.intent.kind)) out.push(m) }
  const hostRows = (phrase: string, make: (h: IntentHost) => Omit<IntentMatch, 'score'>, prefer?: 'windows' | 'linux', base = 0): void => {
    for (const { host, score } of findHosts(phrase, ctx, prefer)) add({ ...make(host), score: Math.min(100, score + base) })
  }
  let m: RegExpExecArray | null

  for (const [re, tool, name] of TOOLS) if (re.test(low)) add({ intent: { kind: 'tool', tool }, title: name, score: 96 })
  if ((m = /^(?:search |find |show |type )?emojis?(?: for)?\s*(.*)$/.exec(low))) add({ intent: { kind: 'tool', tool: 'emoji', query: m[1] }, title: m[1] ? `Emoji: ${m[1]}` : 'Search Emoji', score: 95 })
  for (const [re, action, name] of SYSTEM) if (re.test(low)) add({ intent: { kind: 'system', action }, title: name, score: 94 })
  if (/^(?:quit|close) (?:all|every|everything)(?: (?:apps|applications|windows))?$/.test(low)) add({ intent: { kind: 'quitAll' }, title: 'Quit All Apps…', subtitle: 'Asks first', score: 95 })
  if (/^(?:open |show )?(?:today'?s|the daily|my daily) note$|^daily note$/.test(low)) add({ intent: { kind: 'today' }, title: 'Open Today’s Note', score: 95 })

  // Connections: "ssh to X", "rdp into X", "remote desktop X", "connect to X", "files on X".
  if ((m = /^(?:ssh|shell|open (?:an? )?ssh(?: session)?|start (?:an? )?ssh(?: session)?|terminal|log ?in|login|sign in)(?:\s+(?:in)?to|\s+into|\s+on|\s+with)?\s+(.+)$/i.exec(sentence))) {
    hostRows(m[1], (h) => ({ intent: { kind: 'connect', via: 'ssh', host: h }, title: `SSH to ${h.name}`, subtitle: where(h) }), 'linux')
  }
  if ((m = /^(?:rdp|remote desktop|remote|desktop|open (?:an? )?(?:rdp|remote desktop)(?: session)?|start (?:an? )?(?:rdp|remote desktop)(?: session)?|screen ?share|vnc)(?:\s+(?:in)?to|\s+into|\s+on|\s+with)?\s+(.+)$/i.exec(sentence))) {
    hostRows(m[1], (h) => ({ intent: { kind: 'connect', via: 'rdp', host: h }, title: `Remote Desktop to ${h.name}`, subtitle: where(h) }), 'windows')
  }
  if ((m = /^(?:connect|jump|hop)(?:\s+(?:in)?to|\s+into|\s+on)?\s+(.+)$/i.exec(sentence))) {
    hostRows(m[1], (h) => ({ intent: { kind: 'connect', via: 'any', host: h }, title: `Connect to ${h.name}`, subtitle: `${h.platform === 'windows' ? 'Remote Desktop' : 'SSH'} · ${where(h)}` }))
  }
  if ((m = /^(?:files?|sftp|browse(?: (?:the )?files)?|list files|open files)(?:\s+(?:on|of|for|in|to|from|into))?\s+(.+)$/i.exec(sentence))) {
    hostRows(m[1], (h) => ({ intent: { kind: 'files', host: h }, title: `Browse Files on ${h.name}`, subtitle: `SFTP · ${where(h)}` }), 'linux')
  }

  // Services before power: "restart tomee on 3dspace 1" names a service and a host.
  if ((m = /^(start|stop|restart|reload|bounce|check|status of|is)\s+(?:the\s+)?(.+?)(?:\s+service)?\s+(?:on|at|in)\s+(.+?)(?:\s+(?:running|up|down))?$/i.exec(sentence))) {
    const svc = findService(m[2], ctx)
    if (svc) {
      const verb = m[1].toLowerCase()
      const action = verb === 'stop' ? 'stop' : verb === 'start' ? 'start' : /^(check|status of|is)$/.test(verb) ? 'status' : 'restart'
      const word = { start: 'Start', stop: 'Stop', restart: 'Restart', status: 'Check' }[action]
      hostRows(m[3], (h) => ({ intent: { kind: 'service', action, service: svc, host: h }, title: `${word} ${svc.name} on ${h.name}`, subtitle: `Opens Services, where you confirm · ${where(h)}` }), 'linux', 2)
    }
  }
  if ((m = /^(start|stop|boot|power on|power off|turn on|turn off|shut ?down)\s+(?:the\s+)?(?:instance|server|host|vm|machine)?\s*(.+)$/i.exec(sentence))) {
    const action = /^(start|boot|power on|turn on)$/i.test(m[1]) ? 'start' : 'stop'
    hostRows(m[2], (h) => ({ intent: { kind: 'power', action, host: h }, title: `${action === 'start' ? 'Start' : 'Stop'} ${h.name}…`, subtitle: `EC2 instance, asks first · ${h.state ?? ''}` }), undefined, -6)
  }
  if ((m = /^(?:forward|tunnel|port ?forward|open (?:a )?(?:tunnel|port forward))(?:\s+(?:to|for))?\s+(?:port\s+)?(\d{2,5})?\s*(?:(?:on|to|from|through|via|at|of|for)\s+)?(.*)$/i.exec(sentence)) && m[2]) {
    const port = m[1] ? Number(m[1]) : undefined
    hostRows(m[2], (h) => ({ intent: { kind: 'forward', host: h, port }, title: `Forward ${port ? `Port ${port}` : 'a Port'} on ${h.name}…`, subtitle: where(h) }))
  }
  if ((m = /^run\s+(.+?)\s+on\s+(.+)$/i.exec(sentence))) {
    const command = m[1].replace(/^["'`](.*)["'`]$/, '$1')
    const blank = /^(?:a )?command$/i.test(command)
    hostRows(m[2], (h) => ({ intent: { kind: 'run', host: h, command: blank ? '' : command }, title: blank ? `Run a Command on ${h.name}…` : `Run “${command}” on ${h.name}…`, subtitle: 'Opens Run Command, where you send it' }))
  }
  if ((m = /^(?:show|details?|info|inspect|describe|look at)\s+(?:(?:of|for|about|on)\s+)?(.+)$/i.exec(sentence))) {
    hostRows(m[1], (h) => ({ intent: { kind: 'details', host: h }, title: `Show ${h.name}`, subtitle: `Host details · ${where(h)}` }), undefined, -10)
  }

  // Windows: "left half", "put slack on the right third", "move this to the next screen".
  const verbless = low.replace(/^(?:window|snap|make it|make (?:the )?window|move (?:the )?window|move it|tile)\s+/, '').replace(/^(?:to|on)\s+(?:the\s+)?/, '')
  const bare = verbless !== low || !NEEDS_VERB.has(low) ? findLayout(verbless) : undefined
  if (bare) add({ intent: { kind: 'layout', layout: bare }, title: bare.name, subtitle: 'Window · the app you were in', score: 93 })
  if ((m = /^(?:move|put|snap|place|send|throw|tile)\s+(.+?)\s+(?:to|on|in|into|onto)\s+(.+)$/i.exec(sentence))) {
    const layout = findLayout(m[2])
    if (layout) {
      const who = m[1].toLowerCase()
      if (/^(?:this|it|the window|this window|window|that)$/.test(who)) add({ intent: { kind: 'layout', layout }, title: layout.name, subtitle: 'Window · the app you were in', score: 94 })
      else for (const { app, score } of findApps(m[1], ctx)) add({ intent: { kind: 'layout', layout, app }, title: `${app.name}: ${layout.name}`, subtitle: 'Opens it, then moves its window', score: Math.min(97, score + 6) })
    }
  }

  // Asking and writing down.
  if ((m = /^(?:ask\s+)?(claude|chat ?gpt|gpt)\s*[,:]?\s+(?:about\s+)?(.+)$/i.exec(sentence)) && (/^ask\s/i.test(sentence) || /^(claude|chat ?gpt|gpt)\s*[,:]/i.test(sentence))) {
    const to = /claude/i.test(m[1]) ? 'claude' : 'chatgpt'
    add({ intent: { kind: 'ask', to, text: m[2] }, title: `Ask ${to === 'claude' ? 'Claude' : 'ChatGPT'}: “${m[2]}”`, score: 92 })
  } else if ((m = /^ask\s+(.+)$/i.exec(sentence))) add({ intent: { kind: 'ask', to: 'claude', text: m[1] }, title: `Ask Claude: “${m[1]}”`, score: 88 })
  if ((m = /^(?:search(?: the web| google| online)?(?: for)?|google|look up|lookup)\s+(.+)$/i.exec(sentence)) && !/^search emoji/i.test(sentence)) add({ intent: { kind: 'search', text: m[1] }, title: `Search Google for “${m[1]}”`, score: 85 })
  if ((m = /^(?:note|jot(?: down)?|capture|add (?:a )?note|write down)\s*:?\s+(?:that\s+)?(.+)$/i.exec(sentence))) add({ intent: { kind: 'capture', text: m[1], task: false }, title: `Add to Today’s Note: “${m[1]}”`, score: 90 })
  if ((m = /^(?:remind me to|remind me|todo|to do|add (?:a )?task(?: to)?|new task|add (?:a )?to-?do)\s*:?\s+(.+)$/i.exec(sentence))) add({ intent: { kind: 'task', text: m[1] }, title: `Add Task: “${m[1]}”`, subtitle: 'In Tasks; a date or time in it schedules it', score: 91 })

  // Apps: "quit slack", "kill chrome".
  if ((m = /^(?:quit|close|exit)\s+(.+)$/i.exec(sentence)) && !/^(?:quit|close) (?:all|every)/i.test(low)) {
    for (const { app, score } of findApps(m[1], ctx)) add({ intent: { kind: 'app', action: 'quit', app }, title: `Quit ${app.name}`, score })
  }
  if ((m = /^(?:kill|force quit|force-quit|end process|terminate)\s+(.+)$/i.exec(sentence)) && !/^(?:kill|end) (?:a )?process(?:es)?$/i.test(low)) add({ intent: { kind: 'kill', name: m[1] }, title: `Kill “${m[1]}”…`, subtitle: 'Kill Process, showing what matches; you pick', score: 88 })

  // "open X" / "go to X" / "launch X": an address, a console, a section, a site, an app, a host.
  if ((m = /^(?:open|launch|start|go to|goto|visit|browse to|navigate to|show me|show|switch to|bring up|pull up|take me to|load)\s+(?:the\s+|my\s+)?(.+)$/i.exec(sentence))) openRows(m[1], ctx, add)
  // A bare address, said or typed, is an open too.
  else if (looksLikeUrl(joinAddress(low))) openRows(sentence, ctx, add)

  return out.sort((a, b) => b.score - a.score)
}

function findService(phrase: string, ctx: IntentContext): IntentService | undefined {
  const p = squash(phrase.replace(/\.service$/i, ''))
  if (!p) return undefined
  const list = ctx.services ?? []
  return list.find((s) => squash(s.name) === p || s.units.some((u) => squash(u.replace(/\.service$/, '')) === p))
    ?? list.find((s) => p.length >= 3 && (squash(s.name).includes(p) || s.units.some((u) => squash(u).includes(p))))
}

function openRows(object: string, ctx: IntentContext, add: (m: IntentMatch) => void): void {
  const { rest, space, external } = splitWhere(object.trim(), ctx)
  const thing = joinAddress(rest.trim())
  const low = thing.toLowerCase()
  for (const [re, tool, name] of TOOLS) if (re.test(low)) add({ intent: { kind: 'tool', tool }, title: name, score: 95 })
  if (/^(?:today'?s|the daily|my daily|daily) note$/.test(low)) add({ intent: { kind: 'today' }, title: 'Open Today’s Note', score: 95 })
  if (looksLikeUrl(thing)) {
    const url = /^https?:\/\//i.test(thing) ? thing : `https://${thing}`
    add({ intent: { kind: 'url', url, space, external }, title: `Open ${thing}`, subtitle: external ? 'In your Mac’s browser' : space ? `In the Browser · ${space.name}` : 'In the Browser', score: 97 })
    return
  }
  let m: RegExpExecArray | null
  if ((m = /^(?:aws )?console(?:\s+(?:for|in|of|on)\s+(.+))?$|^aws(?:\s+(?:for|in|of|on)\s+(.+))?$/.exec(low))) {
    const name = (m[1] ?? m[2] ?? '').trim()
    const account = name ? (ctx.accounts ?? []).find((a) => a.label.toLowerCase() === name || a.profile.toLowerCase() === name || a.label.toLowerCase().startsWith(name)) : undefined
    if (!name || account) add({ intent: { kind: 'console', account }, title: account ? `AWS Console: ${account.label}` : 'AWS Console', subtitle: 'Signed in, in the Browser', score: 93 })
  }
  for (const s of ctx.sections ?? []) {
    const sc = matchScore(low, s.name)
    if (sc >= 80 || low === s.id) add({ intent: { kind: 'section', section: s.id, name: s.name }, title: `Open ${s.name}`, subtitle: 'In the app', score: Math.min(92, sc) })
  }
  for (const site of ctx.sites ?? []) {
    if (space && site.space !== space.id) continue
    const sc = Math.max(matchScore(low, site.title), low.length >= 3 && site.url.toLowerCase().includes(low.replace(/\s+/g, '')) ? 70 : 0)
    if (sc >= 70) add({ intent: { kind: 'site', site }, title: `Switch to ${site.title}`, subtitle: `Browser · ${(ctx.spaces ?? []).find((x) => x.id === site.space)?.name ?? ''} · ${site.url.replace(/^https?:\/\//, '').slice(0, 60)}`, score: Math.min(90, sc) })
  }
  for (const { app, score } of findApps(thing, ctx)) add({ intent: { kind: 'app', action: 'open', app }, title: `Open ${app.name}`, subtitle: 'Application', score: Math.min(91, score) })
  for (const { host, score } of findHosts(thing, ctx)) add({ intent: { kind: 'connect', via: 'any', host }, title: `Connect to ${host.name}`, subtitle: `${host.platform === 'windows' ? 'Remote Desktop' : 'SSH'} · ${where(host)}`, score: score - 12 })
}

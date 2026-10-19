/**
 * Rules for the built-in browser shared by main and renderer, kept free of Electron and the DOM so tests can load
 * them: what counts as a web address, how typed text becomes one, the cookie container (partition) of a space, and
 * the AWS console addresses a space opens.
 */
import type { WebHistoryEntry } from './types'

/** Pages a web tab may load: the web, plus the blank page a new tab starts on. */
export function isWebUrl(url: string | undefined): boolean {
  return !!url && (/^https?:\/\//i.test(url) || url === 'about:blank')
}

/** Address bar text to a URL: an address as typed (https assumed), otherwise a web search. */
export function normalizeInput(text: string): string {
  const t = text.trim()
  if (!t) return ''
  if (/^https?:\/\//i.test(t)) return t
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/.*)?$/i.test(t)) return `http://${t}`
  if (!/\s/.test(t) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(t)) return `https://${t}`
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`
}

/** Each space is its own cookie container, so accounts in different spaces never share a login. */
export function partitionFor(spaceId: string): string {
  return `persist:web-${spaceId.replace(/[^a-z0-9_-]/gi, '_')}`
}

export function spaceIdForProfile(profile: string): string {
  return `aws-${profile}`
}

/** "console.aws.amazon.com" style label for a URL, for the sidebar and suggestions. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}

export interface AwsService {
  id: string
  name: string
  /** Words the command bar matches besides the name. */
  keywords: string
  url: (region: string) => string
}

const regional = (region: string, path: string): string => `https://${region}.console.aws.amazon.com/${path}`

/** The services an AWS space offers one click away (and the command bar suggests as "<account> EC2"). */
export const AWS_SERVICES: AwsService[] = [
  { id: 'ec2', name: 'EC2', keywords: 'instances servers ec2', url: (r) => regional(r, `ec2/home?region=${r}#Instances:`) },
  { id: 'cloudwatch', name: 'CloudWatch', keywords: 'metrics alarms logs monitoring', url: (r) => regional(r, `cloudwatch/home?region=${r}#home:`) },
  { id: 'ssm', name: 'Systems Manager', keywords: 'ssm fleet session manager patch', url: (r) => regional(r, `systems-manager/home?region=${r}`) },
  { id: 's3', name: 'S3', keywords: 'buckets storage', url: (r) => `https://s3.console.aws.amazon.com/s3/buckets?region=${r}` },
  { id: 'iam', name: 'IAM', keywords: 'users roles policies identity', url: () => 'https://us-east-1.console.aws.amazon.com/iam/home#/home' },
  { id: 'billing', name: 'Billing', keywords: 'cost explorer budgets spend', url: () => 'https://us-east-1.console.aws.amazon.com/costmanagement/home#/home' }
]

export function consoleHome(region: string): string {
  return regional(region, `console/home?region=${region}`)
}

export function ec2InstanceUrl(region: string, instanceId: string): string {
  return regional(region, `ec2/home?region=${region}#InstanceDetails:instanceId=${encodeURIComponent(instanceId)}`)
}

export function isAwsConsoleUrl(url: string): boolean {
  return /^https:\/\/([a-z0-9-]+\.)*console\.aws\.amazon\.com(\/|$)/i.test(url)
}

/**
 * The AWS sign-in page a console request lands on when the space has no (or an expired) console session: the cue
 * to sign the space in again with the account's SSO credentials. The federation endpoint itself does not count.
 */
export function isAwsSignInPage(url: string): boolean {
  try {
    const u = new URL(url)
    return /(^|\.)signin\.aws\.amazon\.com$/i.test(u.host) && !u.pathname.startsWith('/federation')
  } catch {
    return false
  }
}

/** Where a sign-in page would have sent the user afterwards (its redirect_uri), when that is a console page. */
export function signInDestination(url: string): string | null {
  try {
    const target = new URL(url).searchParams.get('redirect_uri')
    return target && isAwsConsoleUrl(target) ? target : null
  } catch {
    return null
  }
}

/** The federation endpoint's two steps (getSigninToken, then login) for a set of temporary credentials. */
export function federationTokenUrl(creds: { accessKeyId: string; secretAccessKey: string; sessionToken: string }): string {
  const session = JSON.stringify({ sessionId: creds.accessKeyId, sessionKey: creds.secretAccessKey, sessionToken: creds.sessionToken })
  return `https://signin.aws.amazon.com/federation?Action=getSigninToken&Session=${encodeURIComponent(session)}`
}

export function federationLoginUrl(signinToken: string, destination: string): string {
  return `https://signin.aws.amazon.com/federation?Action=login&Destination=${encodeURIComponent(destination)}&SigninToken=${encodeURIComponent(signinToken)}`
}

export function isFederationUrl(url: string): boolean {
  return /^https:\/\/signin\.aws\.amazon\.com\/federation/i.test(url)
}

/**
 * The address to keep for a tab or history entry. A federation login link holds a one-time token that is useless
 * (and should not sit on disk) once used, so it is kept as the console page it was taking the user to.
 */
export function restorableUrl(url: string): string {
  if (!isFederationUrl(url)) return url
  try {
    return new URL(url).searchParams.get('Destination') ?? ''
  } catch {
    return ''
  }
}

/** True when every word of `query` appears (ignoring case) somewhere in `texts`. */
export function matchesWords(query: string, ...texts: (string | undefined)[]): boolean {
  const hay = texts.filter(Boolean).join(' ').toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))
}

/** History entries matching `query` (all of them when it is empty), newest first, one per address. */
export function searchHistory(history: WebHistoryEntry[], query: string, limit: number, spaceId?: string): WebHistoryEntry[] {
  const seen = new Set<string>()
  const out: WebHistoryEntry[] = []
  for (let i = history.length - 1; i >= 0 && out.length < limit; i--) {
    const h = history[i]
    if (seen.has(h.url) || (spaceId && h.spaceId !== spaceId)) continue
    seen.add(h.url)
    if (matchesWords(query, h.title, h.url)) out.push(h)
  }
  return out
}

export interface FrequentSite {
  host: string
  /** The site's front page in the scheme it was visited with. */
  url: string
  visits: number
}

/** A space's most visited sites, by host: the start page's tiles. */
export function frequentSites(history: WebHistoryEntry[], spaceId: string, limit: number): FrequentSite[] {
  const by = new Map<string, FrequentSite>()
  for (const h of history) {
    if (h.spaceId !== spaceId) continue
    let u: URL
    try {
      u = new URL(h.url)
    } catch {
      continue
    }
    if (!/^https?:$/.test(u.protocol) || isFederationUrl(h.url) || isAwsSignInPage(h.url)) continue
    const host = hostOf(h.url)
    const site = by.get(host) ?? { host, url: `${u.protocol}//${u.host}/`, visits: 0 }
    site.visits++
    by.set(host, site)
  }
  return [...by.values()].sort((a, b) => b.visits - a.visits).slice(0, limit)
}

const hostname = (url: string): string => {
  try {
    return new URL(url.includes('://') ? url : `https://${url}`).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * The registrable part of a host, which password managers match logins by: "jira.example.com" → "example.com",
 * "a.example.co.uk" → "example.co.uk". IP addresses and single-label hosts (localhost) stay whole.
 */
export function siteOf(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, '')
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || !h.includes('.')) return h
  const parts = h.split('.')
  const secondLevel = parts.length > 2 && parts.at(-1)!.length === 2 && /^(co|com|net|org|gov|edu|ac|or|ne)$/.test(parts.at(-2)!)
  return parts.slice(secondLevel ? -3 : -2).join('.')
}

/** Whether a saved login (its website addresses) belongs to the page at `pageUrl`. */
export function loginMatches(urls: string[], pageUrl: string): boolean {
  const page = hostname(pageUrl)
  return !!page && urls.some((u) => {
    const h = hostname(u)
    return !!h && siteOf(h) === siteOf(page)
  })
}

/** A space's own colour must be #rrggbb: it is written into a style attribute. */
export const isHexColor = (c: unknown): c is string => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)

/**
 * The last character in a text box, counting an emoji made of several code points (👩‍💻, 🏳️‍🌈, a flag) as one, or ''.
 * The icon field keeps only what was typed or picked last, so picking another emoji replaces the one there.
 */
export function lastGrapheme(text: string): string {
  const parts = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text.trim())]
  return parts.at(-1)?.segment ?? ''
}

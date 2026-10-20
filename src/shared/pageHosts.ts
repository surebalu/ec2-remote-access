/**
 * Which known hosts a web page mentions (a Jira ticket, a runbook, the AWS console): instance IDs, IP addresses, EC2
 * host names (ip-10-0-1-23…) and Name tags written as a word of their own. The browser lists them so a host in a
 * ticket opens beside it in one click. Pure, so tests load it directly.
 */
import type { Instance } from './types'

export interface PageHost {
  key: string
  /** The text on the page that matched (the instance ID, the address, or the name as written). */
  match: string
  via: 'instance ID' | 'IP address' | 'host name' | 'name'
  /** Where it first appears, so hosts are listed in the order the page mentions them. */
  at: number
}

const MAX_HOSTS = 30

/**
 * A Name tag counts only when it is unlikely to be an ordinary word: it has a digit, a dash, a dot or an underscore
 * ("web-01", "db2"), or at least six letters ("jenkins"). "prod" or "test" alone would match half of every ticket.
 */
function distinctive(name: string): boolean {
  return name.length >= 4 && (/[\d._-]/.test(name) || name.length >= 6)
}

export function hostsInText(text: string, instances: Instance[]): PageHost[] {
  const index = (pairs: [string | undefined, Instance][]): Map<string, Instance[]> => {
    const m = new Map<string, Instance[]>()
    for (const [k, i] of pairs) if (k) m.set(k, [...(m.get(k) ?? []), i])
    return m
  }
  const byId = index(instances.map((i) => [i.instanceId?.toLowerCase(), i]))
  const byIp = index(instances.flatMap((i): [string | undefined, Instance][] => [[i.privateIp, i], [i.publicIp, i]]))
  const byName = index(instances.filter((i) => distinctive(i.name.trim())).map((i) => [i.name.trim().toLowerCase(), i]))

  const found = new Map<string, PageHost>()
  const add = (list: Instance[] | undefined, match: string, via: PageHost['via'], at: number): void => {
    for (const i of list ?? []) {
      const prev = found.get(i.key)
      // The first (strongest) kind of match names it; a later mention earlier on the page only moves it up.
      if (!prev) found.set(i.key, { key: i.key, match, via, at })
      else if (at < prev.at) found.set(i.key, { ...prev, at })
    }
  }
  for (const m of text.matchAll(/\bi-(?:[0-9a-f]{17}|[0-9a-f]{8})\b/gi)) add(byId.get(m[0].toLowerCase()), m[0], 'instance ID', m.index)
  for (const m of text.matchAll(/\bip-(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})\b/gi)) add(byIp.get(m.slice(1, 5).join('.')), m[0], 'host name', m.index)
  for (const m of text.matchAll(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.]*\d)/g)) add(byIp.get(m[0]), m[0], 'IP address', m.index)
  // Names: every word-like run (letters, digits, . _ -) looked up whole, so "web-01" never matches inside "web-010".
  // A trailing dot or dash is punctuation ("…on web-01.").
  for (const m of text.matchAll(/[\w.-]+/g)) {
    const word = m[0].replace(/[.-]+$/, '').toLowerCase()
    if (word.length >= 4) add(byName.get(word), m[0].replace(/[.-]+$/, ''), 'name', m.index)
  }
  // Names with spaces in them cannot be single words; they are searched for as phrases.
  for (const [name, list] of byName) {
    if (!/\s/.test(name)) continue
    const re = new RegExp(`(?<![\\w.-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}(?![\\w-])`, 'i')
    const m = re.exec(text)
    if (m) add(list, m[0], 'name', m.index)
  }
  return [...found.values()].sort((a, b) => a.at - b.at).slice(0, MAX_HOSTS)
}

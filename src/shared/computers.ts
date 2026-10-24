import type { Instance } from './types'

/**
 * Rules of the Computers library (renderer/components/computers): how a card is named and coloured. Pure, unit-tested
 * in tests/computers.test.ts.
 */

/** A machine name as people read it: "ec2amaz-ehoft35" → "Ec2amaz Ehoft35"; names someone typed with capitals stay. */
export function computerLabel(name: string): string {
  const n = name.trim()
  if (!n || /[A-Z]/.test(n) && /[a-z]/.test(n)) return n
  return n.replace(/[-_.]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase().replace(/(^|\s)(\p{L})/gu, (_m, sp: string, ch: string) => sp + ch.toUpperCase())
}

export type CardTone = 'violet' | 'orange' | 'teal' | 'slate'

/** A card without a picture yet is coloured by what the machine is: Windows violet, Linux orange, Mac teal. */
export function cardTone(i: Pick<Instance, 'platform' | 'tailnet' | 'osHint'>): CardTone {
  if (i.tailnet?.os === 'macOS' || /mac ?os/i.test(i.osHint)) return 'teal'
  if (i.platform === 'windows') return 'violet'
  if (i.platform === 'linux') return 'orange'
  return 'slate'
}

/** The machines the library shows: the tailnet's, then hand-added servers and starred hosts, each once, by name. */
export function libraryGroups(hosts: Instance[], favorites: string[]): { id: string; title: string; hosts: Instance[] }[] {
  const byName = (a: Instance, b: Instance): number => computerLabel(a.name).localeCompare(computerLabel(b.name), undefined, { numeric: true })
  const tailnet = hosts.filter((h) => h.tailnet).sort(byName)
  const servers = hosts.filter((h) => h.manual && !h.tailnet).sort(byName)
  const fav = new Set(favorites)
  const starred = hosts.filter((h) => !h.manual && fav.has(h.key)).sort(byName)
  return [
    { id: 'tailscale', title: 'Tailscale', hosts: tailnet },
    { id: 'servers', title: 'Servers', hosts: servers },
    { id: 'favorites', title: 'Favorites', hosts: starred }
  ].filter((g) => g.hosts.length > 0)
}

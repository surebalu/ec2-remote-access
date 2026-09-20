import type { Instance } from './types'

export function matchesHost(i: Instance, query: string): boolean {
  const haystack = [i.name, i.instanceId, i.publicIp, i.privateIp, i.publicDns, i.osHint,
    i.profile, i.accountId, i.region, i.instanceType, ...Object.entries(i.tags).flat()].join(' ').toLowerCase()
  return query.trim().toLowerCase().split(/\s+/).every((word) => haystack.includes(word))
}

export const clearHostFilters = {
  search: '', osFilter: 'all', stateFilter: 'all', reachFilter: 'all', profileFilter: null, favoritesOnly: false
} as const

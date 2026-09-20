import type { Instance, ManualHost } from './types'

export const MANUAL_PROFILE = 'servers'

export function manualKey(id: string): string {
  return `manual/${id}`
}

/** Presents a hand-added server as an Instance so every table/route/connect path treats it uniformly. */
export function manualToInstance(h: ManualHost): Instance {
  return {
    key: manualKey(h.id),
    profile: MANUAL_PROFILE,
    accountId: undefined,
    region: h.group || 'Other servers',
    instanceId: h.host,
    name: h.name,
    platform: h.platform,
    platformDetails: h.platform === 'windows' ? 'Windows' : 'Linux',
    osHint: h.platform === 'windows' ? 'Windows' : 'Linux',
    state: 'running',
    instanceType: '',
    publicIp: h.host,
    privateIp: undefined,
    ssmOnline: false,
    tags: h.notes ? { Notes: h.notes } : {},
    manual: true
  }
}

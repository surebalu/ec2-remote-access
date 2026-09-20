import type { Instance, RouteDecision } from '@shared/types'
import { getSettings } from '../store'

export function decideRoute(inst: Instance, force?: 'direct' | 'ssm'): RouteDecision {
  const ov = getSettings().overrides[inst.key]
  const pref = force ?? ov?.forceRoute
  if (inst.manual) return { route: 'direct', reason: 'Manually added server', host: inst.publicIp }
  if (inst.state !== 'running') return { route: 'not-running', reason: `Instance is ${inst.state}` }
  if (pref === 'ssm') {
    return inst.ssmOnline
      ? { route: 'ssm', reason: 'Forced SSM Session Manager', host: inst.instanceId }
      : { route: 'unreachable', reason: 'SSM forced but agent is not online' }
  }
  if (pref === 'direct') {
    const host = inst.publicIp ?? inst.privateIp
    return host ? { route: 'direct', reason: 'Forced direct', host } : { route: 'unreachable', reason: 'No IP address' }
  }
  const preferDirect = getSettings().preferDirect
  if (preferDirect && inst.publicIp) return { route: 'direct', reason: 'Public IP', host: inst.publicIp }
  if (inst.ssmOnline) return { route: 'ssm', reason: 'SSM agent online', host: inst.instanceId }
  if (inst.publicIp) return { route: 'direct', reason: 'Public IP (SSM agent not online)', host: inst.publicIp }
  return {
    route: 'unreachable',
    reason: inst.ssmPingStatus
      ? `Private IP only; SSM agent is ${inst.ssmPingStatus}`
      : 'Private IP only and not SSM-managed. Attach AmazonSSMManagedInstanceCore role + SSM agent.'
  }
}

export function defaultSshUser(inst: Instance): string {
  const s = getSettings()
  const ov = s.overrides[inst.key]
  if (ov?.sshUser) return ov.sshUser
  const pd = s.profileDefaults[inst.profile]
  if (pd?.sshUser) return pd.sshUser
  if (s.defaultLinuxUser) return s.defaultLinuxUser
  const hint = `${inst.osHint} ${inst.platformDetails} ${inst.tags.OS ?? ''}`.toLowerCase()
  if (/ubuntu/.test(hint)) return 'ubuntu'
  if (/debian/.test(hint)) return 'admin'
  if (/centos/.test(hint)) return 'centos'
  if (/suse/.test(hint)) return 'ec2-user'
  if (/bitnami/.test(hint)) return 'bitnami'
  if (inst.platform === 'windows') return 'Administrator'
  return 'ec2-user'
}

export function defaultRdpUser(inst: Instance): string {
  const s = getSettings()
  return s.overrides[inst.key]?.rdpUser || s.defaultWindowsUser || 'Administrator'
}

/** Identity file precedence: explicit > host override > account default > global default. */
export function defaultIdentityFile(inst: Instance, explicit?: string): string | undefined {
  const s = getSettings()
  return explicit || s.overrides[inst.key]?.identityFile || s.profileDefaults[inst.profile]?.identityFile || s.defaultIdentityFile || undefined
}

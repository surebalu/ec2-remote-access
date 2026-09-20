import { EC2Client, paginateDescribeInstances, DescribeRegionsCommand, StartInstancesCommand, StopInstancesCommand } from '@aws-sdk/client-ec2'
import type { Instance as Ec2Instance } from '@aws-sdk/client-ec2'
import { SSMClient, paginateDescribeInstanceInformation } from '@aws-sdk/client-ssm'
import type { Instance, InstanceState, Platform, ScanProgress, ScanResult, ScanTarget } from '@shared/types'
import { mergeInventoryScan } from '@shared/inventoryMerge'
import { listProfiles } from './profiles'
import { credentialsFor } from './credentials'
import { getSettings, setCachedInventory, getCachedInventory } from '../store'
import { manualToInstance } from '@shared/manual'

export type ProgressFn = (p: ScanProgress) => void

function platformOf(i: Ec2Instance): { platform: Platform; osHint: string } {
  const details = i.PlatformDetails ?? ''
  if (/windows/i.test(i.Platform ?? '') || /windows/i.test(details)) return { platform: 'windows', osHint: 'Windows' }
  if (/red hat|rhel/i.test(details)) return { platform: 'linux', osHint: 'RHEL' }
  if (/suse/i.test(details)) return { platform: 'linux', osHint: 'SUSE' }
  if (/linux/i.test(details)) return { platform: 'linux', osHint: 'Linux' }
  return { platform: 'unknown', osHint: details || 'Unknown' }
}

function toInstance(profile: string, accountId: string | undefined, region: string, i: Ec2Instance): Instance {
  const tags: Record<string, string> = {}
  for (const t of i.Tags ?? []) if (t.Key) tags[t.Key] = t.Value ?? ''
  const { platform, osHint } = platformOf(i)
  return {
    key: `${profile}/${region}/${i.InstanceId}`,
    profile,
    accountId,
    region,
    instanceId: i.InstanceId!,
    name: tags.Name || i.InstanceId!,
    platform,
    platformDetails: i.PlatformDetails ?? '',
    osHint,
    state: (i.State?.Name ?? 'pending') as InstanceState,
    instanceType: i.InstanceType ?? '',
    publicIp: i.PublicIpAddress ?? undefined,
    privateIp: i.PrivateIpAddress ?? undefined,
    publicDns: i.PublicDnsName || undefined,
    keyName: i.KeyName ?? undefined,
    imageId: i.ImageId ?? undefined,
    vpcId: i.VpcId ?? undefined,
    subnetId: i.SubnetId ?? undefined,
    az: i.Placement?.AvailabilityZone ?? undefined,
    launchTime: i.LaunchTime?.toISOString(),
    ssmOnline: false,
    tags
  }
}

async function scanOne(profile: string, region: string, accountId: string | undefined): Promise<Instance[]> {
  const creds = credentialsFor(profile)
  const ec2 = new EC2Client({ region, credentials: creds })
  const ssm = new SSMClient({ region, credentials: creds })
  try {
    const out: Instance[] = []
    for await (const page of paginateDescribeInstances({ client: ec2 }, {})) {
      for (const r of page.Reservations ?? []) {
        accountId ??= r.OwnerId ?? undefined
        for (const i of r.Instances ?? []) out.push(toInstance(profile, accountId ?? r.OwnerId ?? undefined, region, i))
      }
    }
    // SSM reachability. Failure here (no permission) must not fail the EC2 scan.
    try {
      const byId = new Map(out.map((x) => [x.instanceId, x]))
      for await (const page of paginateDescribeInstanceInformation({ client: ssm }, {})) {
        for (const info of page.InstanceInformationList ?? []) {
          const inst = info.InstanceId ? byId.get(info.InstanceId) : undefined
          if (!inst) continue
          inst.ssmPingStatus = info.PingStatus
          inst.ssmOnline = info.PingStatus === 'Online'
          inst.ssmAgentVersion = info.AgentVersion
          if (inst.platform === 'linux' && info.PlatformName) {
            inst.osHint = /red hat/i.test(info.PlatformName) ? 'RHEL' : info.PlatformName.replace(/ Linux$/, ' Linux').trim()
          }
        }
      }
    } catch (err) {
      for (const inst of out) inst.ssmError = (err as Error).message
    }
    return out
  } finally {
    ec2.destroy()
    ssm.destroy()
  }
}

export async function enabledRegions(profile: string, region: string): Promise<string[]> {
  const ec2 = new EC2Client({ region, credentials: credentialsFor(profile) })
  try {
    const r = await ec2.send(new DescribeRegionsCommand({ AllRegions: false }))
    return (r.Regions ?? []).map((x) => x.RegionName!).filter(Boolean).sort()
  } finally {
    ec2.destroy()
  }
}

export async function scanAll(onProgress: ProgressFn, onlyProfiles?: string[], retryTargets?: ScanTarget[]): Promise<ScanResult> {
  const settings = getSettings()
  const profiles = (await listProfiles()).filter((p) => p.enabled && (!onlyProfiles || onlyProfiles.includes(p.name)) && (!retryTargets || retryTargets.some((t) => t.profile === p.name)))
  const targets = profiles.map((p) => retryTargets?.find((t) => t.profile === p.name) ?? { profile: p.name })
  const errors: ScanResult['errors'] = []
  const instances: Instance[] = []

  await Promise.all(
    profiles.map(async (p) => {
      const requested = retryTargets?.find((t) => t.profile === p.name)?.regions
      let regions = requested ?? Array.from(new Set([p.region, ...settings.extraRegions]))
      if (settings.scanAllRegions && !requested) {
        try {
          regions = await enabledRegions(p.name, p.region)
        } catch (err) {
          errors.push({ profile: p.name, region: p.region, message: (err as Error).message, allRegions: true })
          onProgress({ profile: p.name, region: p.region, status: 'error', message: (err as Error).message })
          return
        }
      }
      await Promise.all(
        regions.map(async (region) => {
          onProgress({ profile: p.name, region, status: 'running' })
          try {
            const found = await scanOne(p.name, region, p.accountId)
            instances.push(...found)
            onProgress({ profile: p.name, region, status: 'done', count: found.length })
          } catch (err) {
            const message = (err as Error).message
            errors.push({ profile: p.name, region, message })
            onProgress({ profile: p.name, region, status: 'error', message })
          }
        })
      )
    })
  )

  const result = mergeInventoryScan(instances, getCachedInventory(), targets, errors, !!onlyProfiles || !!retryTargets, Date.now())
  setCachedInventory(result)
  return result
}

export function findInstance(key: string): Instance {
  if (key.startsWith('manual/')) {
    const h = getSettings().manualHosts.find((m) => `manual/${m.id}` === key)
    if (!h) throw new Error(`Server not found: ${key}`)
    return manualToInstance(h)
  }
  const inst = getCachedInventory()?.instances.find((i) => i.key === key)
  if (!inst) throw new Error(`Instance not in inventory: ${key}. Rescan first.`)
  return inst
}

export async function setInstanceState(key: string, action: 'start' | 'stop'): Promise<void> {
  const inst = findInstance(key)
  const ec2 = new EC2Client({ region: inst.region, credentials: credentialsFor(inst.profile) })
  try {
    if (action === 'start') await ec2.send(new StartInstancesCommand({ InstanceIds: [inst.instanceId] }))
    else await ec2.send(new StopInstancesCommand({ InstanceIds: [inst.instanceId] }))
  } finally {
    ec2.destroy()
  }
}

import { EC2Client, DescribeInstanceStatusCommand } from '@aws-sdk/client-ec2'
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch'
import type { HostHealth } from '@shared/types'
import { credentialsFor } from './credentials'
import { findInstance } from './inventory'

const WINDOW_MS = 3 * 60 * 60 * 1000

/**
 * Status checks and recent CPU for one instance, fetched on demand when its details open. Each half fails on its own
 * so a role without cloudwatch:GetMetricData still sees the status checks.
 */
export async function hostHealth(key: string): Promise<HostHealth> {
  const inst = findInstance(key)
  const out: HostHealth = { events: [], cpu: [], ssmLastPing: inst.ssmLastPing, fetchedAt: Date.now(), errors: [] }
  if (inst.manual) return out
  const credentials = credentialsFor(inst.profile)
  const ec2 = new EC2Client({ region: inst.region, credentials })
  const cw = new CloudWatchClient({ region: inst.region, credentials })
  const end = new Date()
  try {
    await Promise.all([
      ec2
        .send(new DescribeInstanceStatusCommand({ InstanceIds: [inst.instanceId], IncludeAllInstances: true }))
        .then((r) => {
          const st = r.InstanceStatuses?.[0]
          out.instanceStatus = st?.InstanceStatus?.Status
          out.systemStatus = st?.SystemStatus?.Status
          out.events = (st?.Events ?? [])
            .filter((e) => !e.Description?.startsWith('[Completed]'))
            .map((e) => ({ code: e.Code ?? 'event', description: e.Description ?? '', notBefore: e.NotBefore?.toISOString() }))
        })
        .catch((e: Error) => void out.errors.push(`Status checks: ${e.message}`)),
      inst.state !== 'running'
        ? Promise.resolve()
        : cw
            .send(
              new GetMetricDataCommand({
                StartTime: new Date(end.getTime() - WINDOW_MS),
                EndTime: end,
                ScanBy: 'TimestampAscending',
                MetricDataQueries: [
                  {
                    Id: 'cpu',
                    MetricStat: {
                      Metric: { Namespace: 'AWS/EC2', MetricName: 'CPUUtilization', Dimensions: [{ Name: 'InstanceId', Value: inst.instanceId }] },
                      Period: 300,
                      Stat: 'Average'
                    }
                  }
                ]
              })
            )
            .then((r) => {
              const m = r.MetricDataResults?.[0]
              out.cpu = (m?.Timestamps ?? []).map((t, n) => ({ t: t.getTime(), v: m?.Values?.[n] ?? 0 }))
            })
            .catch((e: Error) => void out.errors.push(`CPU metrics: ${e.message}`))
    ])
  } finally {
    ec2.destroy()
    cw.destroy()
  }
  return out
}

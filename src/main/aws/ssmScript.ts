import { GetCommandInvocationCommand, SendCommandCommand, SSMClient } from '@aws-sdk/client-ssm'
import type { Instance } from '@shared/types'
import { credentialsFor } from './credentials'
import { friendly } from './runCommand'

/**
 * Runs a few shell lines on Linux instances through SSM (AWS-RunShellScript, as root) and waits for each to finish:
 * the plumbing under service control (main/services.ts), where Run Command's runs are for people to read. One
 * SendCommand per account and region (up to 50 instances), then each invocation is polled until it ends.
 */

export interface ScriptResult { ok: boolean; status: string; exitCode: number | null; stdout: string; stderr: string; error?: string }

const BATCH = 50
const DONE = new Set(['Success', 'Failed', 'TimedOut', 'Cancelled', 'Undeliverable', 'Terminated', 'InvalidPlatform', 'AccessDenied', 'DeliveryTimedOut', 'ExecutionTimedOut'])

/** Why an instance cannot take a command, or null when it can. */
export function cannotRun(inst: Instance): string | null {
  if (inst.manual) return 'Not an AWS instance: service control goes through the SSM agent.'
  if (inst.platform === 'windows') return 'A Windows server: its services are not systemd units.'
  if (inst.state !== 'running') return `The instance is ${inst.state}.`
  if (!inst.ssmOnline) return 'The SSM agent is not online on this instance.'
  return null
}

export async function runScript(insts: Instance[], lines: string[], opts: { timeoutSec: number; comment: string }): Promise<Map<string, ScriptResult>> {
  const out = new Map<string, ScriptResult>()
  const groups = new Map<string, Instance[]>()
  for (const i of insts) groups.set(`${i.profile}|${i.region}`, [...(groups.get(`${i.profile}|${i.region}`) ?? []), i])
  const deadline = Date.now() + (opts.timeoutSec + 90) * 1000
  await Promise.all([...groups].map(async ([g, list]) => {
    const [profile, region] = g.split('|')
    const ssm = new SSMClient({ region, credentials: credentialsFor(profile) })
    try {
      for (let b = 0; b < list.length; b += BATCH) {
        const batch = list.slice(b, b + BATCH)
        let commandId: string | undefined
        try {
          const r = await ssm.send(new SendCommandCommand({
            InstanceIds: batch.map((i) => i.instanceId),
            DocumentName: 'AWS-RunShellScript',
            Parameters: { commands: lines, executionTimeout: [String(opts.timeoutSec)] },
            Comment: opts.comment.slice(0, 100)
          }))
          commandId = r.Command?.CommandId
        } catch (e) {
          for (const i of batch) out.set(i.key, { ok: false, status: 'Error', exitCode: null, stdout: '', stderr: '', error: friendly(e) })
          continue
        }
        await Promise.all(batch.map(async (i) => {
          await new Promise((r) => setTimeout(r, 700))
          for (;;) {
            try {
              const r = await ssm.send(new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: i.instanceId }))
              if (DONE.has(r.Status ?? '') || DONE.has(r.StatusDetails ?? '')) {
                out.set(i.key, {
                  ok: r.Status === 'Success', status: r.StatusDetails ?? r.Status ?? '', exitCode: r.ResponseCode !== undefined && r.ResponseCode >= 0 ? r.ResponseCode : null,
                  stdout: r.StandardOutputContent ?? '', stderr: r.StandardErrorContent ?? ''
                })
                return
              }
            } catch (e) {
              // Right after SendCommand the invocation may not exist yet.
              if ((e as { name?: string }).name !== 'InvocationDoesNotExist') { out.set(i.key, { ok: false, status: 'Error', exitCode: null, stdout: '', stderr: '', error: friendly(e) }); return }
            }
            if (Date.now() > deadline) { out.set(i.key, { ok: false, status: 'TimedOut', exitCode: null, stdout: '', stderr: '', error: 'No result from SSM in time.' }); return }
            await new Promise((r) => setTimeout(r, 1500))
          }
        }))
      }
    } finally {
      ssm.destroy()
    }
  }))
  return out
}

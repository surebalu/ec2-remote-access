import { SSMClient, SendCommandCommand, GetCommandInvocationCommand, CancelCommandCommand } from '@aws-sdk/client-ssm'
import type { Instance, RunCommandRequest, RunState, RunStatus, RunTarget } from '@shared/types'
import { findInstance } from './inventory'
import { credentialsFor } from './credentials'

/**
 * Run Command across hosts: one command or script, sent with SSM SendCommand to every chosen host whose agent is
 * online (AWS-RunShellScript on Linux, AWS-RunPowerShellScript on Windows), in batches of 50 per account, region and
 * OS. Main polls each invocation until it ends and keeps the run; the renderer asks for it with run:status rather than
 * waiting for pushed events, which a phone that went to sleep would miss.
 */

const POLL_MS = 2000
const KEEP_RUNS = 20
const BATCH = 50
const DONE: RunStatus[] = ['success', 'failed', 'timed-out', 'cancelled', 'skipped', 'error']

const runs = new Map<string, RunState>()

const done = (t: RunTarget): boolean => DONE.includes(t.status)

function skipReason(inst: Instance): string | null {
  if (inst.manual) return 'Not an AWS instance (Run Command needs the SSM agent).'
  if (inst.state !== 'running') return `The instance is ${inst.state}.`
  if (!inst.ssmOnline) return 'The SSM agent is not online on this instance.'
  return null
}

/** An SSM error in words (shared with ssmScript.ts). */
export function friendly(e: unknown): string {
  const err = e as { name?: string; message?: string }
  const msg = err.message ?? String(e)
  if (err.name === 'AccessDeniedException' || /not authorized|AccessDenied/i.test(msg)) return 'This account’s role may not run commands (it needs ssm:SendCommand and ssm:GetCommandInvocation).'
  if (/ExpiredToken|expired|SSO/i.test(msg)) return 'The AWS sign-in has expired. Sign in again and retry.'
  if (err.name === 'InvalidInstanceId') return 'SSM does not know this instance right now (agent offline or the instance changed).'
  return msg
}

function statusOf(aws: string | undefined): RunStatus {
  switch (aws) {
    case 'Success': return 'success'
    case 'Failed': return 'failed'
    case 'TimedOut': return 'timed-out'
    case 'Cancelled': case 'Cancelling': return 'cancelled'
    case 'InProgress': case 'Delayed': return 'running'
    default: return 'pending'
  }
}

export async function startRun(req: RunCommandRequest): Promise<RunState> {
  const command = req.command.replace(/\r\n/g, '\n').trimEnd()
  if (!command.trim()) throw new Error('Type a command to run.')
  const timeoutSec = Math.min(48 * 3600, Math.max(30, Math.round(req.timeoutSec ?? 600)))
  const targets: RunTarget[] = []
  for (const key of [...new Set(req.keys)]) {
    let inst: Instance
    try { inst = findInstance(key) } catch (e) { targets.push({ key, name: key, profile: '', region: '', instanceId: '', platform: 'unknown', status: 'skipped', message: (e as Error).message }); continue }
    const why = skipReason(inst)
    targets.push({ key, name: inst.name, profile: inst.profile, region: inst.region, instanceId: inst.instanceId, platform: inst.platform, status: why ? 'skipped' : 'pending', message: why ?? undefined })
  }
  if (!targets.some((t) => t.status === 'pending')) throw new Error(targets.length === 1 ? targets[0].message ?? 'This host cannot run commands.' : 'None of these hosts can run commands right now (they need to be running with the SSM agent online).')

  const run: RunState = { id: `run-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, command, timeoutSec, startedAt: Date.now(), targets }
  runs.set(run.id, run)
  for (const old of [...runs.keys()].slice(0, Math.max(0, runs.size - KEEP_RUNS))) runs.delete(old)

  const groups = new Map<string, RunTarget[]>()
  for (const t of targets) {
    if (t.status !== 'pending') continue
    const g = `${t.profile}|${t.region}|${t.platform === 'windows' ? 'windows' : 'linux'}`
    groups.set(g, [...(groups.get(g) ?? []), t])
  }
  await Promise.all([...groups].map(async ([g, list]) => {
    const [profile, region, os] = g.split('|')
    const ssm = new SSMClient({ region, credentials: credentialsFor(profile) })
    try {
      for (let i = 0; i < list.length; i += BATCH) {
        const batch = list.slice(i, i + BATCH)
        try {
          const r = await ssm.send(new SendCommandCommand({
            InstanceIds: batch.map((t) => t.instanceId),
            DocumentName: os === 'windows' ? 'AWS-RunPowerShellScript' : 'AWS-RunShellScript',
            Parameters: { commands: command.split('\n'), executionTimeout: [String(timeoutSec)] },
            Comment: `EC2 Remote Access: ${command.split('\n')[0].slice(0, 80)}`
          }))
          const at = Date.now()
          for (const t of batch) Object.assign(t, { commandId: r.Command?.CommandId, startedAt: at })
        } catch (e) {
          for (const t of batch) Object.assign(t, { status: 'error', message: friendly(e), endedAt: Date.now() })
        }
      }
    } finally {
      ssm.destroy()
    }
  }))
  poll(run)
  return run
}

/** Polls the run's open invocations until each ends, or until well past its timeout. */
function poll(run: RunState): void {
  const deadline = run.startedAt + (run.timeoutSec + 180) * 1000
  const clients = new Map<string, SSMClient>()
  const client = (t: RunTarget): SSMClient => {
    const k = `${t.profile}|${t.region}`
    let c = clients.get(k)
    if (!c) { c = new SSMClient({ region: t.region, credentials: credentialsFor(t.profile) }); clients.set(k, c) }
    return c
  }
  const finish = (): void => {
    run.finishedAt = Date.now()
    for (const c of clients.values()) c.destroy()
    clients.clear()
  }
  const tick = async (): Promise<void> => {
    const open = run.targets.filter((t) => !done(t) && t.commandId)
    if (!open.length) { finish(); return }
    if (Date.now() > deadline) {
      for (const t of open) Object.assign(t, { status: 'timed-out', message: 'No result from SSM in time.', endedAt: Date.now() })
      finish()
      return
    }
    await Promise.all(open.map(async (t) => {
      try {
        const r = await client(t).send(new GetCommandInvocationCommand({ CommandId: t.commandId, InstanceId: t.instanceId }))
        const status = statusOf(r.Status)
        Object.assign(t, {
          status,
          exitCode: r.ResponseCode !== undefined && r.ResponseCode >= 0 ? r.ResponseCode : undefined,
          stdout: r.StandardOutputContent ?? t.stdout,
          stderr: r.StandardErrorContent ?? t.stderr,
          endedAt: DONE.includes(status) ? Date.now() : undefined
        })
      } catch (e) {
        // Right after SendCommand the invocation may not exist yet; keep waiting for it.
        if ((e as { name?: string }).name !== 'InvocationDoesNotExist') Object.assign(t, { status: 'error', message: friendly(e), endedAt: Date.now() })
      }
    }))
    setTimeout(() => void tick(), POLL_MS)
  }
  setTimeout(() => void tick(), 800)
}

export function runStatus(id: string): RunState | null {
  return runs.get(id) ?? null
}

export function listRuns(): RunState[] {
  return [...runs.values()].reverse()
}

export async function cancelRun(id: string): Promise<void> {
  const run = runs.get(id)
  if (!run) return
  const open = run.targets.filter((t) => !done(t) && t.commandId)
  const byCommand = new Map<string, RunTarget>()
  for (const t of open) if (!byCommand.has(t.commandId!)) byCommand.set(t.commandId!, t)
  await Promise.all([...byCommand.values()].map(async (t) => {
    const ssm = new SSMClient({ region: t.region, credentials: credentialsFor(t.profile) })
    try { await ssm.send(new CancelCommandCommand({ CommandId: t.commandId })) } catch { /* it may have just finished */ } finally { ssm.destroy() }
  }))
}

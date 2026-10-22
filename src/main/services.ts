import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { userInfo } from 'node:os'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import {
  actionScript, catalogOf, logsScript, parseStatus, statusScript,
  type HostServices, type ServiceAudit, type ServiceJob, type ServiceJobRequest, type ServiceStep, type UnitStatus
} from '@shared/services'
import type { Instance } from '@shared/types'
import { findInstance } from './aws/inventory'
import { credentialsFor } from './aws/credentials'
import { cannotRun, runScript } from './aws/ssmScript'
import { checksFor, probeSince } from './plmHealth'
import { getSettings } from './store'
import { host } from './host'
import { log } from './log'

/**
 * Service control (channels services:*): the 3DEXPERIENCE services' systemd units on a server, read and started,
 * stopped or restarted through SSM as root. Which units a server has is asked of the server, from the catalog in
 * Settings → Services, so a new service needs no code. An action is a job kept here, polled by the renderer (a phone
 * that slept still sees it finish): a rolling one runs one server at a time and stops at the first failure, and with
 * `verify` a step only counts once the unit is active again and the server's own health check (the probe Grafana
 * runs) has passed since. One action per unit at a time; every finished step goes into the audit history.
 */

const ACTION_TIMEOUT_S = 900
const VERIFY_MS = 10 * 60_000
const POLL_MS = 10_000
const KEEP_JOBS = 30

const jobs = new Map<string, ServiceJob & { cancel?: boolean }>()
const busy = new Map<string, string>()
const who = new Map<string, Promise<string>>()

const auditFile = (): string => join(host().userDataDir(), 'service-actions.jsonl')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The units each server has, with their state. */
export async function serviceStatus(keys: string[]): Promise<HostServices[]> {
  const units = catalogOf(getSettings().serviceCatalog).flatMap((d) => d.units)
  const out: HostServices[] = []
  const ready: Instance[] = []
  for (const key of [...new Set(keys)]) {
    let inst: Instance
    try { inst = findInstance(key) } catch (e) { out.push({ key, name: key, ip: null, error: (e as Error).message, units: [] }); continue }
    const why = cannotRun(inst)
    if (why) out.push({ key, name: inst.name, ip: inst.privateIp ?? null, error: why, units: [] })
    else ready.push(inst)
  }
  const res = ready.length ? await runScript(ready, statusScript(units), { timeoutSec: 60, comment: 'EC2 Remote Access: read service states' }) : new Map()
  for (const inst of ready) {
    const r = res.get(inst.key)
    const parsed = r?.stdout ? parseStatus(r.stdout, Date.now()) : null
    out.push({ key: inst.key, name: inst.name, ip: inst.privateIp ?? null, error: parsed ? undefined : r?.error ?? (r?.stderr.trim() || 'No answer from the server.'), units: parsed?.units ?? [] })
  }
  return out
}

/** A unit's recent log (journalctl). */
export async function serviceLogs(key: string, unit: string, lines = 200): Promise<string> {
  const inst = findInstance(key)
  const why = cannotRun(inst)
  if (why) throw new Error(why)
  const r = (await runScript([inst], logsScript(unit, lines), { timeoutSec: 60, comment: `EC2 Remote Access: read ${unit} log` })).get(key)
  if (!r?.stdout && r?.error) throw new Error(r.error)
  return r?.stdout || r?.stderr || '(no log lines)'
}

export function startServiceJob(req: ServiceJobRequest): ServiceJob {
  if (!['start', 'stop', 'restart'].includes(req.action)) throw new Error('Unknown action.')
  if (!req.targets.length) throw new Error('Choose a service to act on.')
  const catalog = catalogOf(getSettings().serviceCatalog)
  const steps: ServiceStep[] = req.targets.map((t) => {
    // Only units the catalog names: the renderer cannot ask for an arbitrary one.
    if (!catalog.some((d) => d.units.includes(t.unit))) throw new Error(`${t.unit} is not in Settings → Services.`)
    const b = busy.get(`${t.key}|${t.unit}`)
    if (b) throw new Error(`${t.unit} on ${t.label ?? t.key} is already being changed.`)
    const inst = findInstance(t.key)
    const why = cannotRun(inst)
    if (why) throw new Error(`${inst.name}: ${why}`)
    return { key: t.key, name: inst.name, label: t.label ?? inst.name, serviceId: t.serviceId, unit: t.unit, phase: 'waiting' }
  })
  const job: ServiceJob & { cancel?: boolean } = {
    id: `svc-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, action: req.action, rolling: req.rolling && steps.length > 1, verify: req.verify, startedAt: Date.now(), steps
  }
  for (const st of steps) busy.set(`${st.key}|${st.unit}`, job.id)
  jobs.set(job.id, job)
  for (const old of [...jobs.keys()].slice(0, Math.max(0, jobs.size - KEEP_JOBS))) if (jobs.get(old)?.finishedAt) jobs.delete(old)
  void run(job)
  return job
}

export const serviceJob = (id: string): ServiceJob | null => jobs.get(id) ?? null
export const serviceJobs = (): ServiceJob[] => [...jobs.values()].reverse()

export function cancelServiceJob(id: string): void {
  const j = jobs.get(id)
  if (j && !j.finishedAt) j.cancel = true
}

async function run(job: ServiceJob & { cancel?: boolean }): Promise<void> {
  try {
    if (job.rolling) {
      for (const st of job.steps) {
        if (job.cancel) { finish(job, st, 'cancelled', 'Cancelled before it started.'); continue }
        await step(job, st)
        if (st.phase === 'failed') {
          for (const rest of job.steps.filter((s) => s.phase === 'waiting')) finish(job, rest, 'skipped', `Not started: ${st.label} failed, so the rest wait.`)
          break
        }
      }
    } else {
      await Promise.all(job.steps.map((st) => step(job, st)))
    }
  } finally {
    job.finishedAt = Date.now()
    for (const st of job.steps) busy.delete(`${st.key}|${st.unit}`)
  }
}

async function step(job: ServiceJob & { cancel?: boolean }, st: ServiceStep): Promise<void> {
  st.phase = 'running'
  st.startedAt = Date.now()
  let inst: Instance
  try { inst = findInstance(st.key) } catch (e) { return finish(job, st, 'failed', (e as Error).message) }
  const r = (await runScript([inst], actionScript(job.action, st.unit, ACTION_TIMEOUT_S), { timeoutSec: ACTION_TIMEOUT_S + 60, comment: `EC2 Remote Access: ${job.action} ${st.unit}` })).get(st.key)
  const parsed = r?.stdout ? parseStatus(r.stdout, Date.now()) : null
  st.after = parsed?.units.find((u) => u.unit === st.unit)
  if (!parsed) return finish(job, st, 'failed', r?.error ?? (r?.stderr.trim() || 'No answer from the server.'))
  if (parsed.rc !== 0) {
    const why = parsed.rc === 124 ? `systemctl ${job.action} did not finish within ${ACTION_TIMEOUT_S / 60} minutes.` : `systemctl ${job.action} exited with ${parsed.rc}.`
    return finish(job, st, 'failed', `${why}${r?.stderr.trim() ? ` ${r.stderr.trim().split('\n').slice(-2).join(' ')}` : ''}`)
  }
  const doneAt = Date.now()
  if (job.action === 'stop') {
    const ok = !st.after || st.after.active === 'inactive' || st.after.active === 'failed'
    return finish(job, st, ok ? 'done' : 'failed', ok ? 'Stopped.' : `Still ${st.after?.active} after systemctl stop.`)
  }
  if (!job.verify) return finish(job, st, 'done', `${job.action === 'start' ? 'Started' : 'Restarted'}; not checked further.`)

  // The unit active again (TomEE services report active while they still deploy, so the health check follows).
  st.phase = 'verifying'
  const until = Date.now() + VERIFY_MS
  while (st.after?.active !== 'active') {
    if (st.after?.active === 'failed') return finish(job, st, 'failed', 'The unit failed after starting. Its log says why.')
    if (job.cancel) return finish(job, st, 'cancelled', 'Stopped waiting for it to come up (the action itself was done).')
    if (Date.now() > until) return finish(job, st, 'failed', `Not active ${VERIFY_MS / 60_000} minutes after the ${job.action}.`)
    await sleep(POLL_MS)
    const s = (await runScript([inst], statusScript([st.unit]), { timeoutSec: 60, comment: `EC2 Remote Access: read ${st.unit}` })).get(st.key)
    st.after = s?.stdout ? parseStatus(s.stdout, Date.now()).units.find((u) => u.unit === st.unit) ?? st.after : st.after
  }
  const urls = await checksFor(st.serviceId, inst.privateIp ?? null).catch(() => [] as string[])
  if (!urls.length) return finish(job, st, 'done', `${job.action === 'start' ? 'Started' : 'Restarted'} and active. No health check watches this server, so that is as far as it can be checked.`)
  st.phase = 'checking'
  st.message = `Waiting for ${urls.length === 1 ? 'its health check' : `its ${urls.length} health checks`} to pass…`
  const passed = new Set<string>()
  while (passed.size < urls.length) {
    if (job.cancel) return finish(job, st, 'cancelled', 'Stopped waiting for the health check (the action itself was done).')
    if (Date.now() > until) return finish(job, st, 'failed', `Active, but its health check had not passed ${VERIFY_MS / 60_000} minutes after the ${job.action}.`)
    for (const u of urls.filter((x) => !passed.has(x))) {
      const p = await probeSince(u, doneAt).catch(() => null)
      if (p?.ok) passed.add(u)
    }
    if (passed.size < urls.length) await sleep(POLL_MS)
  }
  finish(job, st, 'done', `${job.action === 'start' ? 'Started' : 'Restarted'}; active and its health check passes.`)
}

function finish(job: ServiceJob, st: ServiceStep, phase: ServiceStep['phase'], message: string): void {
  st.phase = phase
  st.message = message
  st.endedAt = Date.now()
  if (phase === 'skipped' || (phase === 'cancelled' && !st.startedAt)) return
  void record(job, st)
}

async function identity(profile: string): Promise<string> {
  let p = who.get(profile)
  if (!p) {
    p = (async () => {
      const sts = new STSClient({ region: 'us-east-1', credentials: credentialsFor(profile) })
      try {
        const arn = (await sts.send(new GetCallerIdentityCommand({}))).Arn ?? ''
        return arn.split('/').pop() || arn
      } catch { return userInfo().username } finally { sts.destroy() }
    })()
    who.set(profile, p)
  }
  return p
}

async function record(job: ServiceJob, st: ServiceStep): Promise<void> {
  let profile = ''
  try { profile = findInstance(st.key).profile } catch { /* gone from the inventory */ }
  const entry: ServiceAudit = {
    at: st.endedAt ?? Date.now(), by: profile ? await identity(profile) : userInfo().username, action: job.action, key: st.key, name: st.name, unit: st.unit,
    result: st.phase === 'done' ? 'done' : st.phase === 'cancelled' ? 'cancelled' : 'failed', message: st.message,
    seconds: Math.round(((st.endedAt ?? Date.now()) - (st.startedAt ?? job.startedAt)) / 1000)
  }
  log('services', `${job.action} ${st.unit} on ${st.name}: ${entry.result}`, { by: entry.by, seconds: entry.seconds, message: st.message })
  try { appendFileSync(auditFile(), `${JSON.stringify(entry)}\n`, { mode: 0o600 }) } catch (e) { log('services', 'audit write failed', { error: (e as Error).message }) }
}

/** The last actions, newest first. */
export function serviceHistory(limit = 100): ServiceAudit[] {
  if (!existsSync(auditFile())) return []
  const lines = readFileSync(auditFile(), 'utf8').trim().split('\n').slice(-limit)
  return lines.map((l) => { try { return JSON.parse(l) as ServiceAudit } catch { return null } }).filter((x): x is ServiceAudit => !!x).reverse()
}

export type { UnitStatus }

/**
 * Service control: start, stop and restart the 3DEXPERIENCE services' systemd units on a server, through SSM. This is
 * the pure part: the catalog of services and their units (Settings → Services; these defaults come from the
 * platform's install sheet), which unit names are safe to put in a shell command, the scripts sent to a server, and
 * reading `systemctl show` back. main/services.ts runs them; tests/services.test.ts covers this.
 */

/** A service and the systemd units that run it. `id` matches the Health tab's roles, to find its health checks. */
export interface ServiceDef { id: string; name: string; units: string[] }

/** From the install sheet: only services with a Linux unit (the script-started ones are left out). */
export const DEFAULT_SERVICES: ServiceDef[] = [
  { id: 'space', name: '3DSpace', units: ['3dspace.service'] },
  { id: 'passport', name: '3DPassport', units: ['3dpassport.service'] },
  { id: 'dashboard', name: '3DDashboard', units: ['3ddashboard.service'] },
  { id: 'search', name: 'Federated Search', units: ['federated.service'] },
  { id: 'fcs', name: 'File Collaboration Server', units: ['fcs.service'] },
  { id: 'swym', name: '3DSwym', units: ['3dswym.service'] },
  { id: 'comment', name: '3DComment', units: ['3dcomment.service'] },
  { id: 'notification', name: '3DNotification', units: ['3dnotification.service'] },
  { id: 'converter', name: 'Derived Objects Server', units: ['thbtasklist.service', '3dspaceDerivedconverter.service'] },
  { id: 'tif', name: 'TIF Server', units: ['tif.service'] }
]

export type ServiceAction = 'start' | 'stop' | 'restart'

/**
 * A unit name that is safe in a shell command as it is: letters, digits and @ _ . : - only, ending in .service. Names
 * come from Settings, so anything else (a space, a quote, a semicolon) is refused rather than escaped.
 */
export const isUnitName = (u: string): boolean => /^[A-Za-z0-9@_.:-]{1,120}\.service$/.test(u)

/** The catalog to use: the saved one with bad unit names dropped, or the defaults. */
export function catalogOf(saved: ServiceDef[] | undefined): ServiceDef[] {
  const list = saved?.length ? saved : DEFAULT_SERVICES
  return list.map((d) => ({ ...d, units: d.units.map((u) => u.trim()).filter(isUnitName) })).filter((d) => d.name.trim() && d.units.length)
}

/** What a unit reported (systemctl show), plus how long it has been in its state. */
export interface UnitStatus {
  unit: string
  description: string
  /** loaded, not-found, masked… */
  load: string
  /** active, inactive, failed, activating, deactivating, reloading */
  active: string
  /** running, exited, dead, start-pre… */
  sub: string
  /** Enabled at boot: enabled, disabled, static… */
  enabled: string
  pid: number | null
  memBytes: number | null
  /** When it entered its current active/inactive state (ms), or null when unknown. */
  since: number | null
}

const PROPS = ['Id', 'Description', 'LoadState', 'ActiveState', 'SubState', 'UnitFileState', 'MainPID', 'MemoryCurrent', 'ActiveEnterTimestampMonotonic', 'InactiveEnterTimestampMonotonic']

/** Shell lines that print the units' state, with the uptime first (timestamps are read against it, never a clock). */
export function statusScript(units: string[]): string[] {
  const safe = units.filter(isUnitName)
  if (!safe.length) throw new Error('No valid unit names to read.')
  return ['echo "UPTIME=$(cut -d\' \' -f1 /proc/uptime)"', `systemctl show --no-pager ${PROPS.map((p) => `-p ${p}`).join(' ')} ${safe.join(' ')}`]
}

/**
 * Shell lines that run the action and then print the unit's state. `timeout` stops a start that hangs (a 3DSpace
 * start can take minutes); the exit code is printed rather than failing the command, so the state still comes back.
 */
export function actionScript(action: ServiceAction, unit: string, timeoutSec = 900): string[] {
  if (!isUnitName(unit)) throw new Error(`${unit} is not a unit name this app will run.`)
  if (!['start', 'stop', 'restart'].includes(action)) throw new Error(`Unknown action ${action}.`)
  return [`timeout ${Math.round(timeoutSec)} systemctl ${action} ${unit}; echo "RC=$?"`, ...statusScript([unit])]
}

/** Lines that print a unit's recent log. */
export function logsScript(unit: string, lines = 200): string[] {
  if (!isUnitName(unit)) throw new Error(`${unit} is not a unit name this app will read.`)
  return [`journalctl -u ${unit} -n ${Math.max(10, Math.min(2000, Math.round(lines)))} --no-pager -o short-iso 2>&1 | tail -c 60000`]
}

/** Reads statusScript's output: the units that exist on the server (not-found ones are left out). */
export function parseStatus(out: string, now: number): { units: UnitStatus[]; rc: number | null } {
  const uptime = Number(/^UPTIME=([\d.]+)/m.exec(out)?.[1] ?? NaN)
  const rc = /^RC=(\d+)/m.exec(out)
  const blocks = out.split(/\n\s*\n/).map((b) => Object.fromEntries(b.split('\n').map((l) => { const i = l.indexOf('='); return i > 0 ? [l.slice(0, i), l.slice(i + 1)] : null }).filter((x): x is [string, string] => !!x)))
  const units: UnitStatus[] = []
  for (const b of blocks) {
    if (!b.Id || !b.LoadState || b.LoadState === 'not-found') continue
    const active = b.ActiveState ?? ''
    const mono = Number(active === 'active' || active === 'reloading' ? b.ActiveEnterTimestampMonotonic : b.InactiveEnterTimestampMonotonic)
    const pid = Number(b.MainPID)
    const mem = Number(b.MemoryCurrent)
    units.push({
      unit: b.Id, description: b.Description ?? '', load: b.LoadState, active, sub: b.SubState ?? '', enabled: b.UnitFileState ?? '',
      pid: pid > 0 ? pid : null,
      // [not set] and the "infinity" value (2^64-1) both mean no accounting.
      memBytes: Number.isFinite(mem) && mem > 0 && mem < 2 ** 60 ? mem : null,
      since: Number.isFinite(uptime) && mono > 0 ? Math.round(now - (uptime * 1000 - mono / 1000)) : null
    })
  }
  return { units, rc: rc ? Number(rc[1]) : null }
}

/** The state in a word, for a pill. */
export function unitWord(u: Pick<UnitStatus, 'active' | 'sub'>): { word: string; level: 'ok' | 'warn' | 'crit' | 'off' } {
  // Active and exited: a unit whose start script ran and left its processes running (thbtasklist does this).
  if (u.active === 'active') return { word: u.sub === 'exited' ? 'Active' : 'Running', level: 'ok' }
  if (u.active === 'failed') return { word: 'Failed', level: 'crit' }
  if (u.active === 'activating') return { word: 'Starting', level: 'warn' }
  if (u.active === 'deactivating') return { word: 'Stopping', level: 'warn' }
  if (u.active === 'reloading') return { word: 'Reloading', level: 'warn' }
  return { word: 'Stopped', level: 'off' }
}

/** One server and unit in a job. */
export interface ServiceStep {
  key: string
  name: string
  /** "3DSpace 01" when the Health tab knows the server, else its name. */
  label: string
  serviceId: string
  unit: string
  phase: 'waiting' | 'running' | 'verifying' | 'checking' | 'done' | 'failed' | 'skipped' | 'cancelled'
  message?: string
  startedAt?: number
  endedAt?: number
  /** The unit's state once the action finished. */
  after?: UnitStatus
}

/** An action on one or more units; a rolling one runs them one at a time and stops at the first failure. */
export interface ServiceJob {
  id: string
  action: ServiceAction
  rolling: boolean
  /** Wait for the unit to be active and its health check to pass before calling a step done. */
  verify: boolean
  startedAt: number
  finishedAt?: number
  steps: ServiceStep[]
}

export interface ServiceJobRequest {
  action: ServiceAction
  targets: { key: string; unit: string; serviceId: string; label?: string }[]
  rolling: boolean
  verify: boolean
}

/** One finished action, as the audit history keeps it. */
export interface ServiceAudit {
  at: number
  by: string
  action: ServiceAction
  key: string
  name: string
  unit: string
  result: 'done' | 'failed' | 'cancelled'
  message?: string
  seconds: number
}

/** One server's units for the dialog (services:status). */
export interface HostServices {
  key: string
  name: string
  ip: string | null
  error?: string
  units: UnitStatus[]
}

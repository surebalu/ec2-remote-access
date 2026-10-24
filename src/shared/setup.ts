/**
 * Moving a setup to another Mac, and the organization's sign-in baked into a build. Pure, for tests/setup.test.ts.
 *
 * A setup file (Settings → Data → Export setup…) carries this Mac's settings and the IAM Identity Center part of
 * ~/.aws/config: the sso-session sections and the profiles that use them. It never carries credentials: profiles with
 * access keys are only named, so the other Mac can add them by hand, and nothing from ~/.aws/credentials is read.
 * Favorites, host settings and saved views are keyed by profile name (`profile/region/instance`), so the profiles
 * keep their names; paths under the old home folder move to the new one.
 *
 * A company file (build/company.json, made by scripts/make-company-config.mjs, shipped as Resources/company.json)
 * holds only the sign-in: the session, the profiles' names, accounts and roles, and their labels. A first run with
 * it signs in and offers exactly those profiles, so every Mac (and every teammate) names the accounts alike.
 */
import type { AccentColor, Settings, SsoAccount } from './types'

export interface SsoSessionSetup { name: string; startUrl: string; region: string; scopes?: string }
export interface SsoProfileSetup { name: string; session: string; accountId: string; roleName: string; region?: string; output?: string }
export interface AwsSetup { sessions: SsoSessionSetup[]; profiles: SsoProfileSetup[] }
/** ~/.aws/config as section header → its keys. */
export type ConfigSections = Record<string, Record<string, string>>

export interface CompanySetup {
  /** What the sign-in calls the organization: "Sign in to Mainspring AWS". */
  name: string
  aws: AwsSetup
  /** Each profile's label and colour, as Settings' accountMeta has them. */
  accountMeta?: Record<string, { label?: string; color?: AccentColor }>
}

export interface SetupFile {
  kind: 'ec2ra-setup'
  version: 1
  exportedAt: number
  from: { computer: string; home: string; appVersion?: string }
  aws: AwsSetup
  settings: Partial<Settings>
  /** What the file does not carry: profiles that are not Identity Center ones, and the data folder, set by hand. */
  left: { profiles: { name: string; why: string }[]; dataDir?: string }
}

/** What an import would do, for the dialog that asks first. */
export interface SetupPreview {
  id: string
  fileName: string
  from: SetupFile['from']
  exportedAt: number
  sessions: { name: string; status: SectionStatus }[]
  profiles: { name: string; accountId: string; status: SectionStatus }[]
  settings: string[]
  left: SetupFile['left']
}
/** A Mac's setup kept in Box (boxSync.ts), offered to a new Mac after it signs in to Box. */
export interface BoxSetup { id: string; computer: string; exportedAt: number; /** This computer's own. */ mine: boolean }

/** add: written; same: already there as it is in the file; kept: a different one by that name stays as it is. */
export type SectionStatus = 'add' | 'same' | 'kept'

/**
 * Settings that stay with each Mac: Phone access (its port, its pairing, whether paired devices get terminals, which
 * only the Mac's own window may turn on), the data folder (set through its own check that it can be written), and
 * paths to tools this Mac found for itself.
 */
export const LOCAL_SETTINGS: readonly (keyof Settings)[] = ['phoneAccessEnabled', 'phoneAccessPort', 'phoneAccessBind', 'phoneTerminals', 'dataDir', 'sessionManagerPluginPath', 'awsCliPath']

// ----- ~/.aws/config -----

const header = (name: string): string => (name === 'default' ? 'default' : `profile ${name}`)
const profileName = (h: string): string | null => (h === 'default' ? 'default' : h.startsWith('profile ') ? h.slice(8).trim() : null)

/** The Identity Center sessions and profiles in a config, and the profiles left out (with access keys, or older SSO). */
export function awsSetupFrom(config: ConfigSections, credentialProfiles: string[] = []): { aws: AwsSetup; left: { name: string; why: string }[] } {
  const sessions: SsoSessionSetup[] = []
  for (const [h, kv] of Object.entries(config)) {
    if (!h.startsWith('sso-session ') || !kv.sso_start_url || !kv.sso_region) continue
    sessions.push({ name: h.slice(12).trim(), startUrl: kv.sso_start_url, region: kv.sso_region, ...(kv.sso_registration_scopes ? { scopes: kv.sso_registration_scopes } : {}) })
  }
  const known = new Set(sessions.map((s) => s.name))
  const profiles: SsoProfileSetup[] = []
  const left: { name: string; why: string }[] = []
  for (const [h, kv] of Object.entries(config)) {
    const name = profileName(h)
    if (!name) continue
    if (kv.sso_session && known.has(kv.sso_session) && kv.sso_account_id && kv.sso_role_name) {
      profiles.push({ name, session: kv.sso_session, accountId: kv.sso_account_id, roleName: kv.sso_role_name, ...(kv.region ? { region: kv.region } : {}), ...(kv.output ? { output: kv.output } : {}) })
    } else if (kv.sso_start_url) {
      left.push({ name, why: 'an older single sign-on profile: add it again with Add AWS account' })
    } else if (!kv.sso_session) {
      left.push({ name, why: 'uses access keys, which are never exported' })
    }
  }
  for (const name of credentialProfiles) {
    if (!profiles.some((p) => p.name === name) && !left.some((l) => l.name === name)) left.push({ name, why: 'uses access keys, which are never exported' })
  }
  return { aws: { sessions, profiles }, left }
}

/** The config sections an AWS setup writes, as the app's own sign-in writes them (sso.ts saveSsoProfiles). */
export function sectionsFor(aws: AwsSetup): [string, Record<string, string>][] {
  return [
    ...aws.sessions.map((s): [string, Record<string, string>] => [`sso-session ${s.name}`, { sso_start_url: s.startUrl, sso_region: s.region, sso_registration_scopes: s.scopes ?? 'sso:account:access' }]),
    ...aws.profiles.map((p): [string, Record<string, string>] => [header(p.name), {
      sso_session: p.session, sso_account_id: p.accountId, sso_role_name: p.roleName, ...(p.region ? { region: p.region } : {}), output: p.output ?? 'json'
    }])
  ]
}

/** What writing the sections would do: a section already there is never overwritten, only reported. */
export function planSections(aws: AwsSetup, config: ConfigSections): { write: [string, Record<string, string>][]; status: Record<string, SectionStatus> } {
  const write: [string, Record<string, string>][] = []
  const status: Record<string, SectionStatus> = {}
  for (const [h, kv] of sectionsFor(aws)) {
    const have = config[h]
    if (!have) { write.push([h, kv]); status[h] = 'add' } else status[h] = Object.entries(kv).every(([k, v]) => have[k] === v || (k === 'output' && !have[k])) ? 'same' : 'kept'
  }
  return { write, status }
}

// ----- settings -----

export function exportSettings(settings: Settings): Partial<Settings> {
  const out: Partial<Settings> = { ...settings }
  for (const k of LOCAL_SETTINGS) delete out[k]
  return out
}

/** Every string that is a path under `from` (the old home folder) moved under `to`. */
export function rehome<T>(value: T, from: string, to: string): T {
  if (!from || from === to) return value
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v === from || v.startsWith(`${from}/`) ? to + v.slice(from.length) : v
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(value) as T
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * The settings after an import. The file's win, but nothing this Mac already has is lost: lists of things with an id
 * (servers, workspaces, snippets…) and plain lists (favorites, regions…) are joined, keyed maps (host settings,
 * account labels, shortcuts) merged. This Mac's own settings (LOCAL_SETTINGS) are never touched.
 */
export function mergeSettings(current: Settings, imported: Partial<Settings>): Settings {
  const out: Record<string, unknown> = { ...current }
  for (const [k, v] of Object.entries(imported)) {
    if ((LOCAL_SETTINGS as readonly string[]).includes(k) || v === undefined) continue
    const have = out[k]
    if (Array.isArray(have) && Array.isArray(v)) {
      const mine: unknown[] = have
      const theirs: unknown[] = v
      const idOf = (x: unknown): string | null => (isRecord(x) && typeof x.id === 'string' ? x.id : null)
      if (theirs.every((x) => idOf(x) !== null) && mine.every((x) => idOf(x) !== null)) {
        const ids = new Set(theirs.map(idOf))
        out[k] = [...mine.filter((x) => !ids.has(idOf(x))), ...theirs]
      } else {
        const seen = new Set(mine.map((x) => JSON.stringify(x)))
        out[k] = [...mine, ...theirs.filter((x) => !seen.has(JSON.stringify(x)))]
      }
    } else if (isRecord(have) && isRecord(v)) out[k] = { ...have, ...v }
    else out[k] = v
  }
  return out as unknown as Settings
}

/** The settings an import brings, in words: "3 favorites", "12 host settings". */
export function settingsSummary(s: Partial<Settings>): string[] {
  const n = (v: unknown): number => (Array.isArray(v) ? v.length : isRecord(v) ? Object.keys(v).length : 0)
  const parts: [unknown, string, string][] = [
    [s.favorites, 'favorite', 'favorites'], [s.overrides, 'host setting', 'host settings'], [s.manualHosts, 'server', 'servers'],
    [s.accountMeta, 'account label', 'account labels'], [s.workspaces, 'workspace', 'workspaces'], [s.hostViews, 'saved view', 'saved views'],
    [s.portForwards, 'port forward', 'port forwards'], [s.snippets, 'snippet', 'snippets'], [s.quicklinks, 'quicklink', 'quicklinks'],
    [s.shortcuts, 'keyboard shortcut', 'keyboard shortcuts']
  ]
  const out = parts.filter(([v]) => n(v) > 0).map(([v, one, many]) => `${n(v)} ${n(v) === 1 ? one : many}`)
  const rest = Object.keys(s).length
  if (rest) out.push('appearance, terminal, Notes and other preferences')
  return out
}

// ----- reading files -----

const NAME = /^[\w.-]{1,64}$/
const REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/
const fail = (why: string): never => { throw new Error(why) }

/** Every value goes into ~/.aws/config, so each is checked: a newline or a bracket could add a section of its own. */
function checkAws(v: unknown): AwsSetup {
  if (!isRecord(v) || !Array.isArray(v.sessions) || !Array.isArray(v.profiles)) fail('The file has no AWS sign-in in it.')
  const a = v as unknown as AwsSetup
  for (const s of a.sessions) {
    if (!isRecord(s) || !NAME.test(String(s.name)) || !/^https:\/\/[^\s[\]]+$/.test(String(s.startUrl)) || !REGION.test(String(s.region))) fail(`The sign-in "${String((s as { name?: unknown }).name)}" in the file is not valid.`)
    if (s.scopes !== undefined && !/^[\w:,.-]+$/.test(String(s.scopes))) fail(`The sign-in "${s.name}" has scopes that are not valid.`)
  }
  for (const p of a.profiles) {
    if (!isRecord(p) || !NAME.test(String(p.name)) || !NAME.test(String(p.session)) || !/^\d{12}$/.test(String(p.accountId)) || !/^[\w+=,.@-]{1,64}$/.test(String(p.roleName))) fail(`The profile "${String((p as { name?: unknown }).name)}" in the file is not valid.`)
    if (p.region !== undefined && !REGION.test(String(p.region))) fail(`The profile "${p.name}" has a region that is not valid.`)
    if (p.output !== undefined && !/^(json|text|table|yaml|yaml-stream)$/.test(String(p.output))) fail(`The profile "${p.name}" has an output format that is not valid.`)
    if (!a.sessions.some((s) => s.name === p.session)) fail(`The profile "${p.name}" names a sign-in the file does not have.`)
  }
  return { sessions: a.sessions.map((s) => ({ name: s.name, startUrl: s.startUrl, region: s.region, ...(s.scopes ? { scopes: s.scopes } : {}) })), profiles: a.profiles.map((p) => ({ name: p.name, session: p.session, accountId: p.accountId, roleName: p.roleName, ...(p.region ? { region: p.region } : {}), ...(p.output ? { output: p.output } : {}) })) }
}

export function parseSetupFile(text: string): SetupFile {
  let v: unknown
  try { v = JSON.parse(text) } catch { fail('This is not a setup file exported by EC2 Remote Access.') }
  if (!isRecord(v) || v.kind !== 'ec2ra-setup') fail('This is not a setup file exported by EC2 Remote Access.')
  const f = v as Record<string, unknown>
  if (f.version !== 1) fail('This setup file was made by a newer version of the app. Update the app and try again.')
  if (!isRecord(f.settings)) fail('The file has no settings in it.')
  const from = isRecord(f.from) ? f.from : {}
  const left = isRecord(f.left) ? f.left : {}
  return {
    kind: 'ec2ra-setup', version: 1,
    exportedAt: typeof f.exportedAt === 'number' ? f.exportedAt : 0,
    from: { computer: String(from.computer ?? 'another Mac'), home: typeof from.home === 'string' ? from.home : '', ...(typeof from.appVersion === 'string' ? { appVersion: from.appVersion } : {}) },
    aws: checkAws(f.aws),
    settings: f.settings as Partial<Settings>,
    left: {
      profiles: Array.isArray(left.profiles) ? left.profiles.filter(isRecord).map((p) => ({ name: String(p.name), why: String(p.why ?? '') })) : [],
      ...(typeof left.dataDir === 'string' && left.dataDir ? { dataDir: left.dataDir } : {})
    }
  }
}

export function parseCompanySetup(text: string): CompanySetup {
  const v: unknown = JSON.parse(text)
  if (!isRecord(v) || typeof v.name !== 'string' || !v.name.trim()) fail('company.json needs a "name".')
  const c = v as Record<string, unknown>
  const aws = checkAws(c.aws)
  if (aws.sessions.length !== 1) fail('company.json needs exactly one sign-in (sso-session).')
  const meta = isRecord(c.accountMeta) ? c.accountMeta : {}
  return {
    name: String(c.name).trim(),
    aws,
    accountMeta: Object.fromEntries(Object.entries(meta).filter(([k, m]) => NAME.test(k) && isRecord(m)).map(([k, m]) => {
      const x = m as Record<string, unknown>
      return [k, { ...(typeof x.label === 'string' ? { label: x.label } : {}), ...(typeof x.color === 'string' ? { color: x.color as AccentColor } : {}) }]
    }))
  }
}

// ----- the first-run sign-in -----

export interface CompanyPick { on: boolean; role: string; profile: string; label: string; color?: AccentColor; region?: string }

/**
 * After signing in with the company's start URL: each account the person can use that the company file names, as the
 * file names it (profile, role, label, colour), ticked unless a profile by that name is already set up. Accounts the
 * file does not name are left to the dialog's own guesses, unticked; a role the person lacks falls back to theirs.
 */
export function companyPicks(company: CompanySetup, accounts: SsoAccount[], existing: { name: string }[]): Record<string, CompanyPick> {
  const out: Record<string, CompanyPick> = {}
  for (const a of accounts) {
    const named = company.aws.profiles.filter((p) => p.accountId === a.accountId)
    const p = named.find((x) => a.roles.includes(x.roleName)) ?? named[0]
    if (!p) continue
    const meta = company.accountMeta?.[p.name]
    out[a.accountId] = {
      on: !existing.some((e) => e.name === p.name),
      role: a.roles.includes(p.roleName) ? p.roleName : (a.roles[0] ?? p.roleName),
      profile: p.name,
      label: meta?.label ?? a.accountName,
      ...(meta?.color ? { color: meta.color } : {}),
      ...(p.region ? { region: p.region } : {})
    }
  }
  return out
}

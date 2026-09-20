import { loadSharedConfigFiles, loadSsoSessionData } from '@aws-sdk/shared-ini-file-loader'
import type { AwsProfile } from '@shared/types'
import { getSettings } from '../store'

export interface ProfileMeta extends AwsProfile {
  ssoStartUrl?: string
  ssoRegion?: string
}

let cache: ProfileMeta[] | null = null

export async function listProfiles(force = false): Promise<ProfileMeta[]> {
  if (cache && !force) return cache
  const { configFile, credentialsFile } = await loadSharedConfigFiles({ ignoreCache: true })
  const ssoSessions = await loadSsoSessionData()
  const names = new Set<string>([...Object.keys(configFile), ...Object.keys(credentialsFile)])
  const settings = getSettings()
  const disabled = new Set(settings.disabledProfiles)
  const hidden = new Set(settings.hiddenProfiles)
  const out: ProfileMeta[] = []
  for (const name of names) {
    if (hidden.has(name)) continue
    const cfg = { ...(credentialsFile[name] ?? {}), ...(configFile[name] ?? {}) }
    let kind: AwsProfile['kind'] = 'other'
    let ssoSession: string | undefined
    let ssoStartUrl: string | undefined
    let ssoRegion: string | undefined
    if (cfg.sso_session || cfg.sso_start_url) {
      kind = 'sso'
      ssoSession = cfg.sso_session
      const sess = ssoSession ? ssoSessions[ssoSession] : undefined
      ssoStartUrl = cfg.sso_start_url ?? sess?.sso_start_url
      ssoRegion = cfg.sso_region ?? sess?.sso_region
    } else if (cfg.aws_access_key_id) {
      kind = 'static'
    }
    out.push({
      name,
      region: cfg.region ?? ssoRegion ?? 'us-east-1',
      kind,
      ssoSession,
      ssoStartUrl,
      ssoRegion,
      accountId: cfg.sso_account_id,
      enabled: !disabled.has(name)
    })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  cache = out
  return out
}

/** Synchronous lookup from the last listProfiles() result (populated at startup). */
export function getProfileSync(name: string): ProfileMeta | undefined {
  return cache?.find((x) => x.name === name)
}

export async function getProfile(name: string): Promise<ProfileMeta> {
  const p = (await listProfiles()).find((x) => x.name === name)
  if (!p) throw new Error(`Unknown AWS profile: ${name}`)
  return p
}

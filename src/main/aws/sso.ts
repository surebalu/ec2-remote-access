/**
 * AWS IAM Identity Center (SSO) onboarding without the AWS CLI:
 * device-code login via SSO-OIDC, account/role discovery via the SSO portal API, and writing standard
 * `[sso-session]` / `[profile]` blocks plus a CLI-compatible token cache so both this app and the CLI work.
 */
import { SSOOIDCClient, RegisterClientCommand, StartDeviceAuthorizationCommand, CreateTokenCommand } from '@aws-sdk/client-sso-oidc'
import { SSOClient, paginateListAccounts, paginateListAccountRoles } from '@aws-sdk/client-sso'
import { getSSOTokenFilepath } from '@aws-sdk/shared-ini-file-loader'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { SsoDeviceFlow, SsoAccount, SsoSaveRequest, SsoStartRequest } from '@shared/types'
import { CONFIG_FILE, CREDENTIALS_FILE, upsertSection, removeSection, renameSection, readSection, listSectionHeaders } from './awsfiles'
import { listProfiles } from './profiles'
import { resetCredentials } from './credentials'
import { uid } from '../util'
import { host } from '../host'

interface Flow {
  id: string
  startUrl: string
  region: string
  clientId: string
  clientSecret: string
  registrationExpiresAt: string
  deviceCode: string
  interval: number
  expiresAt: number
  token?: { accessToken: string; refreshToken?: string; expiresAt: string }
}
const flows = new Map<string, Flow>()

function oidc(region: string): SSOOIDCClient {
  return new SSOOIDCClient({ region })
}

export async function startDeviceFlow(req: SsoStartRequest): Promise<SsoDeviceFlow> {
  const client = oidc(req.region)
  try {
    const reg = await client.send(
      new RegisterClientCommand({ clientName: 'ec2-remote-access', clientType: 'public', scopes: ['sso:account:access'] })
    )
    const auth = await client.send(
      new StartDeviceAuthorizationCommand({ clientId: reg.clientId!, clientSecret: reg.clientSecret!, startUrl: req.startUrl })
    )
    const flow: Flow = {
      id: uid('sso'),
      startUrl: req.startUrl,
      region: req.region,
      clientId: reg.clientId!,
      clientSecret: reg.clientSecret!,
      registrationExpiresAt: new Date((reg.clientSecretExpiresAt ?? 0) * 1000).toISOString(),
      deviceCode: auth.deviceCode!,
      interval: auth.interval ?? 5,
      expiresAt: Date.now() + (auth.expiresIn ?? 600) * 1000
    }
    flows.set(flow.id, flow)
    if (req.openBrowser !== false && auth.verificationUriComplete) void host().openExternal(auth.verificationUriComplete)
    return { flowId: flow.id, userCode: auth.userCode!, verificationUri: auth.verificationUri!, verificationUriComplete: auth.verificationUriComplete!, expiresIn: auth.expiresIn ?? 600 }
  } finally {
    client.destroy()
  }
}

/** Polls until the user completes the browser login. Resolves with the accounts and roles the token can access. */
export async function waitForDeviceFlow(flowId: string): Promise<SsoAccount[]> {
  const flow = flows.get(flowId)
  if (!flow) throw new Error('Login flow expired; start again.')
  const client = oidc(flow.region)
  try {
    while (!flow.token) {
      if (Date.now() > flow.expiresAt) throw new Error('The login code expired. Start again.')
      await new Promise((r) => setTimeout(r, flow.interval * 1000))
      try {
        const t = await client.send(
          new CreateTokenCommand({
            clientId: flow.clientId,
            clientSecret: flow.clientSecret,
            grantType: 'urn:ietf:params:oauth:grant-type:device_code',
            deviceCode: flow.deviceCode
          })
        )
        flow.token = {
          accessToken: t.accessToken!,
          refreshToken: t.refreshToken,
          expiresAt: new Date(Date.now() + (t.expiresIn ?? 3600) * 1000).toISOString()
        }
      } catch (e) {
        const name = (e as { name?: string }).name ?? ''
        if (name === 'AuthorizationPendingException') continue
        if (name === 'SlowDownException') {
          flow.interval += 5
          continue
        }
        if (name === 'ExpiredTokenException') throw new Error('The login code expired. Start again.')
        if (name === 'AccessDeniedException') throw new Error('Login was denied in the browser.')
        throw e
      }
    }
  } finally {
    client.destroy()
  }
  return listAccounts(flow)
}

async function listAccounts(flow: Flow): Promise<SsoAccount[]> {
  const sso = new SSOClient({ region: flow.region })
  try {
    const out: SsoAccount[] = []
    for await (const page of paginateListAccounts({ client: sso }, { accessToken: flow.token!.accessToken })) {
      for (const a of page.accountList ?? []) {
        const roles: string[] = []
        for await (const rp of paginateListAccountRoles({ client: sso }, { accessToken: flow.token!.accessToken, accountId: a.accountId! })) {
          for (const r of rp.roleList ?? []) if (r.roleName) roles.push(r.roleName)
        }
        out.push({ accountId: a.accountId!, accountName: a.accountName ?? a.accountId!, email: a.emailAddress, roles: roles.sort() })
      }
    }
    out.sort((a, b) => a.accountName.localeCompare(b.accountName))
    return out
  } finally {
    sso.destroy()
  }
}

/** Writes the token where both the AWS SDK and CLI look for it (keyed by session name, and by start URL for legacy profiles). */
function writeTokenCache(flow: Flow, sessionName: string): void {
  const body = {
    startUrl: flow.startUrl,
    region: flow.region,
    accessToken: flow.token!.accessToken,
    expiresAt: flow.token!.expiresAt,
    clientId: flow.clientId,
    clientSecret: flow.clientSecret,
    registrationExpiresAt: flow.registrationExpiresAt,
    refreshToken: flow.token!.refreshToken
  }
  for (const key of [sessionName, flow.startUrl]) {
    const file = getSSOTokenFilepath(key)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(body, null, 2), { mode: 0o600 })
  }
}

export async function saveSsoProfiles(req: SsoSaveRequest): Promise<string[]> {
  const flow = flows.get(req.flowId)
  if (!flow?.token) throw new Error('Login flow not completed.')
  const session = req.sessionName.trim().replace(/[^\w.-]/g, '-')
  if (!session) throw new Error('Session name is required')
  upsertSection(CONFIG_FILE, `sso-session ${session}`, {
    sso_start_url: flow.startUrl,
    sso_region: flow.region,
    sso_registration_scopes: 'sso:account:access'
  })
  const written: string[] = []
  for (const sel of req.selections) {
    const name = sel.profileName.trim().replace(/[^\w.-]/g, '-')
    if (!name) continue
    upsertSection(CONFIG_FILE, `profile ${name}`, {
      sso_session: session,
      sso_account_id: sel.accountId,
      sso_role_name: sel.roleName,
      region: sel.region || req.defaultRegion,
      output: 'json'
    })
    written.push(name)
  }
  writeTokenCache(flow, session)
  flows.delete(req.flowId)
  resetCredentials()
  await listProfiles(true)
  return written
}

/** Re-authenticates an existing sso-session by name (what the Refresh token button does). */
export async function loginExistingSession(sessionName: string): Promise<SsoDeviceFlow & { done: Promise<void> }> {
  const sec = readSection(CONFIG_FILE, `sso-session ${sessionName}`)
  if (!sec?.sso_start_url || !sec.sso_region) throw new Error(`sso-session "${sessionName}" is missing sso_start_url / sso_region`)
  const dev = await startDeviceFlow({ startUrl: sec.sso_start_url, region: sec.sso_region, openBrowser: true })
  const done = (async () => {
    const flow = flows.get(dev.flowId)!
    await waitForDeviceFlow(dev.flowId)
    writeTokenCache(flow, sessionName)
    flows.delete(dev.flowId)
    resetCredentials()
  })()
  return { ...dev, done }
}

export function cancelDeviceFlow(flowId: string): void {
  flows.delete(flowId)
}

export async function addStaticProfile(req: { profileName: string; accessKeyId: string; secretAccessKey: string; sessionToken?: string; region: string }): Promise<void> {
  const name = req.profileName.trim().replace(/[^\w.-]/g, '-')
  if (!name) throw new Error('Profile name is required')
  upsertSection(CREDENTIALS_FILE, name, {
    aws_access_key_id: req.accessKeyId.trim(),
    aws_secret_access_key: req.secretAccessKey.trim(),
    aws_session_token: req.sessionToken?.trim() || undefined
  })
  upsertSection(CONFIG_FILE, name === 'default' ? 'default' : `profile ${name}`, { region: req.region, output: 'json' })
  resetCredentials()
  await listProfiles(true)
}

export async function removeProfile(name: string): Promise<void> {
  removeSection(CONFIG_FILE, name === 'default' ? 'default' : `profile ${name}`)
  removeSection(CREDENTIALS_FILE, name)
  resetCredentials()
  await listProfiles(true)
}

export async function renameProfile(from: string, to: string): Promise<void> {
  const target = to.trim().replace(/[^\w.-]/g, '-')
  if (!target) throw new Error('New name is required')
  if (listSectionHeaders(CONFIG_FILE).includes(`profile ${target}`) || listSectionHeaders(CREDENTIALS_FILE).includes(target)) {
    throw new Error(`A profile named "${target}" already exists`)
  }
  renameSection(CONFIG_FILE, `profile ${from}`, `profile ${target}`)
  renameSection(CREDENTIALS_FILE, from, target)
  resetCredentials()
  await listProfiles(true)
}

export function ssoSessionsInConfig(): { name: string; startUrl?: string; region?: string }[] {
  return listSectionHeaders(CONFIG_FILE)
    .filter((h) => h.startsWith('sso-session '))
    .map((h) => {
      const sec = readSection(CONFIG_FILE, h) ?? {}
      return { name: h.slice('sso-session '.length), startUrl: sec.sso_start_url, region: sec.sso_region }
    })
}

/** State of the CLI-compatible token cache for a session. */
export function sessionTokenInfo(sessionName: string): { valid: boolean; expiresAt?: string; hasRefreshToken: boolean } {
  const file = getSSOTokenFilepath(sessionName)
  if (!existsSync(file)) return { valid: false, hasRefreshToken: false }
  try {
    const t = JSON.parse(readFileSync(file, 'utf8')) as { expiresAt?: string; refreshToken?: string; registrationExpiresAt?: string }
    const exp = t.expiresAt ? new Date(t.expiresAt).getTime() : 0
    const regOk = !t.registrationExpiresAt || new Date(t.registrationExpiresAt).getTime() > Date.now()
    return { valid: exp > Date.now() + 60_000, expiresAt: t.expiresAt, hasRefreshToken: !!t.refreshToken && regOk }
  } catch {
    return { valid: false, hasRefreshToken: false }
  }
}
export function sessionTokenValid(sessionName: string): boolean {
  return sessionTokenInfo(sessionName).valid
}

export { join }

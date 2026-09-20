import { fromIni, fromSSO } from '@aws-sdk/credential-providers'
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts'

import { spawn } from 'node:child_process'
import type { ProfileStatus } from '@shared/types'
import { getProfile, getProfileSync, listProfiles } from './profiles'
import { findBinary } from '../util'
import { getSettings } from '../store'

type CredProvider = ReturnType<typeof fromIni>
const providers = new Map<string, CredProvider>()

export function credentialsFor(profile: string): CredProvider {
  let p = providers.get(profile)
  if (!p) {
    // The AWS CLI resolves SSO before static keys; the JS SDK's fromIni does the opposite. Match the CLI so a
    // stale [profile] block in ~/.aws/credentials cannot shadow a working SSO profile of the same name.
    const meta = getProfileSync(profile)
    p = meta?.kind === 'sso' ? fromSSO({ profile }) : fromIni({ profile, ignoreCache: true })
    providers.set(profile, p)
  }
  return p
}

export function resetCredentials(profile?: string): void {
  if (profile) providers.delete(profile)
  else providers.clear()
}

function classify(err: unknown): { state: ProfileStatus['state']; message: string } {
  const e = err as { name?: string; message?: string; Code?: string }
  const msg = e?.message ?? String(err)
  const name = e?.name ?? ''
  if (
    /SSOTokenProviderFailure|Token is expired|refresh|sso|The SSO session/i.test(name + ' ' + msg) ||
    /ExpiredToken|InvalidClientTokenId|UnrecognizedClientException/i.test(name)
  ) {
    return { state: 'login-required', message: msg }
  }
  return { state: 'error', message: msg }
}

export async function checkProfile(profile: string): Promise<ProfileStatus> {
  const meta = await getProfile(profile)
  resetCredentials(profile)
  const sts = new STSClient({ region: meta.region, credentials: credentialsFor(profile) })
  try {
    const r = await sts.send(new GetCallerIdentityCommand({}))
    return { profile, state: 'ok', accountId: r.Account, arn: r.Arn, checkedAt: Date.now() }
  } catch (err) {
    const c = classify(err)
    return { profile, state: c.state, message: c.message, checkedAt: Date.now() }
  } finally {
    sts.destroy()
  }
}

export async function checkAllProfiles(): Promise<ProfileStatus[]> {
  const profiles = (await listProfiles()).filter((p) => p.enabled)
  return Promise.all(profiles.map((p) => checkProfile(p.name)))
}

/** SSO login: SDK device flow when the profile uses an sso-session (no CLI needed), else `aws sso login`. */
export async function ssoLogin(profile: string): Promise<ProfileStatus> {
  const meta = await getProfile(profile)
  if (meta.kind !== 'sso') {
    return { profile, state: 'error', message: 'Profile does not use SSO; refresh credentials in ~/.aws/credentials.' }
  }
  if (meta.ssoSession) {
    try {
      const { loginExistingSession } = await import('./sso')
      const r = await loginExistingSession(meta.ssoSession)
      await r.done
      return checkProfile(profile)
    } catch (e) {
      return { profile, state: 'error', message: (e as Error).message, checkedAt: Date.now() }
    }
  }
  const aws = getSettings().awsCliPath || findBinary('aws')
  if (!aws) return { profile, state: 'error', message: 'aws CLI not found; install it (brew install awscli) to log in.' }
  const args = meta.ssoSession ? ['sso', 'login', '--sso-session', meta.ssoSession] : ['sso', 'login', '--profile', profile]
  await new Promise<void>((resolve, reject) => {
    const child = spawn(aws, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(out.trim() || `aws sso login exited ${code}`))))
  })
  resetCredentials()
  return checkProfile(profile)
}

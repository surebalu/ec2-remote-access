/**
 * The built-in browser's main-process side that works in any host: its saved state (browser.json beside the
 * settings), and signing an AWS account's space in to the console. Electron-only parts (webview hardening, page menus,
 * shortcuts) live in ./webviews.ts.
 */
import { readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserState } from '@shared/types'
import { federationLoginUrl, federationTokenUrl, isAwsConsoleUrl, isFederationUrl, restorableUrl } from '@shared/browser'
import { credentialsFor } from './aws/credentials'
import { host } from './host'

const file = (): string => join(host().userDataDir(), 'browser.json')
const MAX_HISTORY = 1500

export function loadBrowserState(): BrowserState | null {
  try {
    return JSON.parse(readFileSync(file(), 'utf8')) as BrowserState
  } catch {
    return null
  }
}

export async function saveBrowserState(state: BrowserState): Promise<void> {
  // Never write a one-time console sign-in link to disk.
  const tidy: BrowserState = {
    ...state,
    tabs: state.tabs.map((t) => ({ ...t, url: restorableUrl(t.url) })),
    history: state.history.filter((h) => !isFederationUrl(h.url)).slice(-MAX_HISTORY)
  }
  const tmp = `${file()}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(tidy), 'utf8')
  await rename(tmp, file())
}

/**
 * A one-time link that opens the AWS console of `profile`, already signed in, at `destination`. It trades the
 * profile's temporary (SSO role) credentials for a sign-in token at the federation endpoint, the same way the AWS CLI
 * console plugins do; the link is valid for 15 minutes and never logged. Static access keys cannot be used this way.
 */
export async function consoleSignInUrl(profile: string, destination: string): Promise<string> {
  if (!isAwsConsoleUrl(destination)) throw new Error('Only AWS console pages can be opened signed in.')
  let creds
  try {
    creds = await credentialsFor(profile)()
  } catch (e) {
    throw new Error(`AWS sign-in needed for ${profile}: ${(e as Error).message}`)
  }
  if (!creds.sessionToken) throw new Error(`${profile} uses long-lived access keys; console sign-in needs an SSO profile.`)
  const res = await fetch(federationTokenUrl({ accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey, sessionToken: creds.sessionToken }))
  if (!res.ok) throw new Error(`AWS refused the console sign-in for ${profile} (HTTP ${res.status}). Sign in to AWS again and retry.`)
  const body = (await res.json()) as { SigninToken?: string }
  if (!body.SigninToken) throw new Error(`AWS returned no console sign-in token for ${profile}.`)
  return federationLoginUrl(body.SigninToken, destination)
}

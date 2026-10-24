import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, join } from 'node:path'
import type { Settings } from '@shared/types'
import {
  awsSetupFrom, exportSettings, mergeSettings, parseCompanySetup, parseSetupFile, planSections, rehome, settingsSummary,
  type CompanySetup, type ConfigSections, type SetupFile, type SetupPreview
} from '@shared/setup'
import { ymd } from '@shared/naturalDate'
import { version as APP_VERSION } from '../../package.json'
import { CONFIG_FILE, CREDENTIALS_FILE, listSectionHeaders, readSection, upsertSection } from './aws/awsfiles'
import { listProfiles } from './aws/profiles'
import { resetCredentials } from './aws/credentials'
import { getSettings } from './store'
import { host } from './host'
import { log } from './log'

/**
 * Settings → Data → Export setup / Import setup, and the organization's sign-in baked into a build (channels setup:*,
 * app:company). The rules are src/shared/setup.ts; this side reads and writes ~/.aws/config (never credentials) and
 * the files. An import is shown first (pickImport) and applied only when confirmed (applyImport); the merged settings
 * go back to the page, which saves them through settings:set like any other change.
 */

function configSections(): ConfigSections {
  return Object.fromEntries(listSectionHeaders(CONFIG_FILE).map((h) => [h, readSection(CONFIG_FILE, h) ?? {}]))
}

let company: CompanySetup | null | undefined
/** Resources/company.json in the Mac app (build/company.json while developing); null in a generic build or the gateway. */
export function companySetup(): CompanySetup | null {
  if (company !== undefined) return company
  company = null
  if (!process.versions.electron) return company
  const resources = (process as { resourcesPath?: string }).resourcesPath
  for (const file of [resources ? join(resources, 'company.json') : '', join(process.cwd(), 'build', 'company.json')]) {
    if (!file || !existsSync(file)) continue
    try {
      company = parseCompanySetup(readFileSync(file, 'utf8'))
      break
    } catch (e) {
      log('setup', `ignoring ${file}: ${(e as Error).message}`)
    }
  }
  return company
}

let name: string | undefined
/**
 * This computer's name as a setup file gives it: the Mac's own name (System Settings → General → About), which the
 * network hostname ("Surendras-MBP-2.localdomain") only approximates; elsewhere (the gateway) its hostname.
 */
export function computerName(): string {
  if (name) return name
  if (process.platform === 'darwin') {
    try { name = execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2000 }).trim() } catch { /* the hostname below */ }
  }
  name ||= hostname().replace(/\.(local|localdomain|lan)$/i, '')
  return name
}

/** This Mac's setup as a file: for Export setup, and the copy kept in Box (boxSync.ts). */
export function buildSetupFile(exportedAt = Date.now()): SetupFile {
  // Only the credentials file's section names are used, to say which profiles were left out.
  const { aws, left } = awsSetupFrom(configSections(), listSectionHeaders(CREDENTIALS_FILE))
  const settings = getSettings()
  return {
    kind: 'ec2ra-setup', version: 1, exportedAt,
    from: { computer: computerName(), home: homedir(), appVersion: APP_VERSION },
    aws,
    settings: exportSettings(settings),
    left: { profiles: left, ...(settings.dataDir ? { dataDir: settings.dataDir } : {}) }
  }
}

export async function exportSetup(): Promise<string | null> {
  const file = buildSetupFile()
  const path = await host().pickSavePath({ title: 'Export setup', defaultPath: join(homedir(), 'Desktop', `EC2 Remote Access setup ${ymd(new Date())}.json`), buttonLabel: 'Export' })
  if (!path) return null
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  log('setup', 'exported', { profiles: file.aws.profiles.length, left: file.left.profiles.length })
  return path
}

const pending = new Map<string, SetupFile>()

export async function pickImport(): Promise<SetupPreview | null> {
  const path = (await host().pickPaths({ title: 'Import setup', kind: 'file', extensions: ['json'] }))?.[0]
  if (!path) return null
  if (statSync(path).size > 5 * 1024 * 1024) throw new Error(`${basename(path)} is too large to be a setup file.`)
  return previewSetup(readFileSync(path, 'utf8'), basename(path))
}

/** What importing a setup file would do, kept until applyImport (or the next preview) so nothing is written yet. */
export function previewSetup(text: string, fileName: string): SetupPreview {
  const file = parseSetupFile(text)
  const { status } = planSections(file.aws, configSections())
  const id = randomUUID()
  pending.clear()
  pending.set(id, file)
  return {
    id, fileName, from: file.from, exportedAt: file.exportedAt,
    sessions: file.aws.sessions.map((s) => ({ name: s.name, status: status[`sso-session ${s.name}`] })),
    profiles: file.aws.profiles.map((p) => ({ name: p.name, accountId: p.accountId, status: status[p.name === 'default' ? 'default' : `profile ${p.name}`] })),
    settings: settingsSummary(file.settings),
    left: file.left
  }
}

export async function applyImport(id: string): Promise<{ settings: Settings; profiles: string[]; dataDir?: string }> {
  const file = pending.get(id)
  if (!file) throw new Error('That import is no longer open. Choose the file again.')
  pending.delete(id)
  // Planned again against the config as it is now: a section that appeared meanwhile is still never overwritten.
  const { write } = planSections(file.aws, configSections())
  for (const [h, kv] of write) upsertSection(CONFIG_FILE, h, kv)
  if (write.length) {
    resetCredentials()
    await listProfiles(true)
  }
  const settings = mergeSettings(getSettings(), rehome(file.settings, file.from.home, homedir()))
  log('setup', 'imported', { from: file.from.computer, sections: write.length })
  return {
    settings,
    profiles: write.map(([h]) => h).filter((h) => !h.startsWith('sso-session ')).map((h) => h.replace(/^profile /, '')),
    ...(file.left.dataDir ? { dataDir: file.left.dataDir } : {})
  }
}

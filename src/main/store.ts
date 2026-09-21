import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import type { Settings, ScanResult } from '@shared/types'
import { host } from './host'

const onePasswordSock = join(homedir(), 'Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock')

function guessPem(): string {
  for (const f of ['.ssh/id_ec2', '.ssh/id_ec2.pem', '.ssh/ec2.pem']) {
    const full = join(homedir(), f)
    try {
      if (existsSync(full) && /PRIVATE KEY/.test(readFileSync(full, 'utf8'))) return full
    } catch {
      /* ignore */
    }
  }
  return ''
}

export const defaultSettings: Settings = {
  profileDefaults: {},
  favorites: [],
  manualHosts: [],
  manualFolders: [],
  theme: 'system',
  terminalTheme: 'auto',
  terminalFont: 'Monaco',
  terminalFontSize: 13,
  accountMeta: {},
  groupBy: 'account',
  collapsedGroups: [],
  extraRegions: [],
  scanAllRegions: false,
  disabledProfiles: [],
  hiddenProfiles: [],
  defaultLinuxUser: '',
  defaultWindowsUser: 'Administrator',
  sshInitCommand: '',
  sshAgentSock: existsSync(onePasswordSock) ? onePasswordSock : (process.env.SSH_AUTH_SOCK ?? ''),
  defaultIdentityFile: '',
  pemFile: guessPem(),
  externalTerminal: 'Warp',
  sessionManagerPluginPath: '',
  awsCliPath: '',
  connectTimeoutSec: 20,
  preferDirect: false,
  overrides: {}
}

interface Schema {
  settings: Settings
  inventory: ScanResult | null
  /** Encrypted RDP credentials, see creds.ts. */
  credentials: Record<string, string>
}

/**
 * Plain JSON file store, format-compatible with the electron-store file earlier versions wrote
 * (`<userData>/ec2-remote-access.json`), so upgrading keeps settings. Loaded lazily because the data directory
 * comes from the host, which is only known after startup; writes are atomic (temp file + rename).
 */
class JsonStore {
  private data: Partial<Schema> | null = null
  private get file(): string {
    return join(host().userDataDir(), 'ec2-remote-access.json')
  }
  private load(): Partial<Schema> {
    if (this.data) return this.data
    try {
      this.data = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Schema>
    } catch {
      this.data = {}
    }
    return this.data
  }
  get<K extends keyof Schema>(key: K): Schema[K] | undefined {
    return this.load()[key]
  }
  set<K extends keyof Schema>(key: K, value: Schema[K]): void {
    const d = this.load()
    d[key] = value
    mkdirSync(join(this.file, '..'), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(d, null, '\t'), { mode: 0o600 })
    renameSync(tmp, this.file)
  }
}

export const store = new JsonStore()

export function getSettings(): Settings {
  return { ...defaultSettings, ...store.get('settings') }
}

export function setSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch }
  store.set('settings', next)
  return next
}

export function getCachedInventory(): ScanResult | null {
  return store.get('inventory') ?? null
}

export function setCachedInventory(r: ScanResult): void {
  store.set('inventory', r)
}

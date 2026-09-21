import Store from 'electron-store'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import type { Settings, ScanResult } from '@shared/types'

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
}

export const store = new Store<Schema>({
  name: 'ec2-remote-access',
  defaults: { settings: defaultSettings, inventory: null }
})

export function getSettings(): Settings {
  return { ...defaultSettings, ...store.get('settings') }
}

export function setSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch }
  store.set('settings', next)
  return next
}

export function getCachedInventory(): ScanResult | null {
  return store.get('inventory')
}

export function setCachedInventory(r: ScanResult): void {
  store.set('inventory', r)
}

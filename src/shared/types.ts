export type Platform = 'linux' | 'windows' | 'unknown'
export type InstanceState = 'pending' | 'running' | 'stopping' | 'stopped' | 'shutting-down' | 'terminated'

export interface AwsProfile {
  name: string
  region: string
  /** 'sso' when the profile uses an sso-session / sso_start_url; 'static' for credentials file; 'other' for role/process */
  kind: 'sso' | 'static' | 'other'
  ssoSession?: string
  accountId?: string
  enabled: boolean
}

export type AuthState = 'unknown' | 'checking' | 'ok' | 'login-required' | 'error'

export interface ProfileStatus {
  profile: string
  state: AuthState
  accountId?: string
  arn?: string
  message?: string
  checkedAt?: number
}

export interface Instance {
  /** unique key: `${profile}/${region}/${instanceId}` */
  key: string
  profile: string
  accountId?: string
  region: string
  instanceId: string
  name: string
  platform: Platform
  platformDetails: string
  osHint: string
  state: InstanceState
  instanceType: string
  publicIp?: string
  privateIp?: string
  publicDns?: string
  keyName?: string
  imageId?: string
  vpcId?: string
  subnetId?: string
  az?: string
  launchTime?: string
  ssmOnline: boolean
  ssmPingStatus?: string
  ssmAgentVersion?: string
  ssmError?: string
  /** Last successful EC2 scan, retained when a refresh fails. */
  lastSeenAt?: number
  staleReason?: string
  tags: Record<string, string>
  /** true for servers added by hand (not from AWS) */
  manual?: boolean
}

/** A server outside AWS, added by the user. Connection settings live in Settings.overrides[key]. */
export interface ManualHost {
  id: string
  name: string
  /** hostname or IP */
  host: string
  platform: 'linux' | 'windows'
  group: string
  notes?: string
}

export type Theme = 'system' | 'light' | 'dark'

/** Environment label and color for an account (or a manual-host group). */
export interface AccountMeta {
  label?: string
  color?: AccentColor
}
export type AccentColor = 'emerald' | 'amber' | 'rose' | 'violet' | 'sky' | 'teal' | 'orange' | 'slate'
export type GroupBy = 'account' | 'os' | 'none'

export type Route = 'direct' | 'ssm' | 'unreachable' | 'not-running'

export interface RouteDecision {
  route: Route
  reason: string
  host?: string
}

export interface HostOverride {
  sshUser?: string
  sshPort?: number
  rdpUser?: string
  rdpPort?: number
  forceRoute?: 'direct' | 'ssm'
  identityFile?: string
  useAgent?: boolean
}

/** Per-AWS-account SSH defaults. When set, the SSH button connects immediately without the dialog. */
export interface ProfileDefaults {
  sshUser?: string
  identityFile?: string
}

export interface Settings {
  /** keyed by AWS profile name */
  profileDefaults: Record<string, ProfileDefaults>
  /** instance keys pinned to the top of the list */
  favorites: string[]
  manualHosts: ManualHost[]
  /** user-created folders for non-AWS servers (a folder may be empty); color/label live in accountMeta['group:<name>'] */
  manualFolders: string[]
  theme: Theme
  /** keyed by profile name, or `group:<name>` for manual-host groups */
  accountMeta: Record<string, AccountMeta>
  groupBy: GroupBy
  collapsedGroups: string[]
  extraRegions: string[]
  scanAllRegions: boolean
  disabledProfiles: string[]
  /** Profiles removed from the sidebar entirely (stale entries in ~/.aws). */
  hiddenProfiles: string[]
  defaultLinuxUser: string
  defaultWindowsUser: string
  sshAgentSock: string
  defaultIdentityFile: string
  pemFile: string
  externalTerminal: 'Warp' | 'Terminal' | 'iTerm'
  sessionManagerPluginPath: string
  awsCliPath: string
  connectTimeoutSec: number
  /** Auto-route: when true and a public IP exists, use it even if SSM is online. Default false (SSM first). */
  preferDirect: boolean
  overrides: Record<string, HostOverride>
}

export interface ScanProgress {
  profile: string
  region: string
  status: 'running' | 'done' | 'error'
  count?: number
  message?: string
}

export interface ScanResult {
  instances: Instance[]
  errors: { profile: string; region: string; message: string; allRegions?: boolean }[]
  scannedAt: number
}

export interface ScanTarget {
  profile: string
  /** Omitted to refresh the profile's configured regions. */
  regions?: string[]
}

export interface SshOpenRequest {
  /** Renderer-chosen id so events emitted during connect are not lost. */
  sessionId?: string
  instanceKey: string
  user?: string
  port?: number
  identityFile?: string
  useAgent?: boolean
  forceRoute?: 'direct' | 'ssm'
  /** Open the shell on the connection of this existing SSH/SFTP session (same host and user) instead of logging in again. */
  reuseSessionId?: string
  cols: number
  rows: number
}

export interface SshSessionInfo {
  sessionId: string
  instanceKey: string
  title: string
  route: Route
  host: string
  user: string
}

export interface SshEvent {
  sessionId: string
  type: 'data' | 'status' | 'closed' | 'error'
  data?: string
  message?: string
}

export interface Tunnel {
  id: string
  instanceKey: string
  title: string
  kind: 'rdp' | 'ssh' | 'port'
  localPort: number
  remotePort: number
  status: 'starting' | 'ready' | 'closed' | 'error'
  message?: string
  startedAt: number
}

export interface RdpOpenRequest {
  instanceKey: string
  user?: string
  port?: number
  forceRoute?: 'direct' | 'ssm'
}

export interface WindowsPasswordResult {
  password?: string
  error?: string
}

export interface RdpPrepareRequest {
  /** Renderer-chosen id, shared with the tab. */
  sessionId: string
  instanceKey: string
  user?: string
  port?: number
  forceRoute?: 'direct' | 'ssm'
}

export interface RdpPrepared {
  sessionId: string
  /** One-time token the web client presents to the local RDCleanPath proxy. */
  token: string
  proxyUrl: string
  destination: string
  route: Route
  title: string
  user: string
}

export interface StoredCredential {
  user: string
  password: string
  domain?: string
}

export interface SsoStartRequest {
  startUrl: string
  region: string
  openBrowser?: boolean
}
export interface SsoDeviceFlow {
  flowId: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresIn: number
}
export interface SsoAccount {
  accountId: string
  accountName: string
  email?: string
  roles: string[]
}
export interface SsoSelection {
  accountId: string
  roleName: string
  profileName: string
  region?: string
}
export interface SsoSaveRequest {
  flowId: string
  sessionName: string
  defaultRegion: string
  selections: SsoSelection[]
}
export interface StaticProfileRequest {
  profileName: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  region: string
}
export interface SsoSessionInfo {
  name: string
  startUrl?: string
  region?: string
  tokenValid: boolean
  /** ISO time the cached access token expires (the SDK may silently renew it via refresh token) */
  expiresAt?: string
  hasRefreshToken: boolean
  /** profiles that use this session */
  profiles: string[]
}

/* ---------- SFTP ---------- */

export interface SftpOpenRequest {
  /** Renderer-chosen id, shared with the tab. */
  sessionId: string
  instanceKey: string
  user?: string
  port?: number
  identityFile?: string
  useAgent?: boolean
  forceRoute?: 'direct' | 'ssm'
  /** Open the SFTP channel on the connection of this existing SSH/SFTP session (same host and user) instead of logging in again. */
  reuseSessionId?: string
}

export interface SftpSessionInfo {
  sessionId: string
  instanceKey: string
  title: string
  route: Route
  host: string
  user: string
  /** Absolute path of the login directory. */
  home: string
}

export interface SftpEntry {
  name: string
  /** Absolute remote path. */
  path: string
  type: 'file' | 'dir' | 'link' | 'other'
  size: number
  /** Unix epoch milliseconds. */
  mtime: number
  mode: number
}

export interface SftpTransfer {
  id: string
  sessionId: string
  kind: 'upload' | 'download'
  name: string
  localPath: string
  remotePath: string
  total: number
  done: number
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled' | 'skipped'
  message?: string
}

export interface SftpEvent {
  sessionId: string
  type: 'closed' | 'error'
  message?: string
}

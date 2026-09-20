import type {
  AwsProfile, ProfileStatus, ScanResult, ScanProgress, Settings, Instance,
  SshOpenRequest, SshSessionInfo, SshEvent, Tunnel, RdpOpenRequest, WindowsPasswordResult, RouteDecision,
  RdpPrepareRequest, RdpPrepared, StoredCredential, Theme,
  SsoStartRequest, SsoDeviceFlow, SsoAccount, SsoSaveRequest, StaticProfileRequest, SsoSessionInfo,
  SftpOpenRequest, SftpSessionInfo, SftpEntry, SftpTransfer, SftpEvent
} from './types'

/** Request/response channels (ipcRenderer.invoke) */
export interface IpcApi {
  'profiles:list': () => Promise<AwsProfile[]>
  'profiles:check': (profile?: string) => Promise<ProfileStatus[]>
  'profiles:login': (profile: string) => Promise<ProfileStatus>
  'profiles:addStatic': (req: StaticProfileRequest) => Promise<void>
  'profiles:remove': (name: string) => Promise<void>
  'profiles:rename': (from: string, to: string) => Promise<void>
  'sso:sessions': () => Promise<SsoSessionInfo[]>
  'sso:start': (req: SsoStartRequest) => Promise<SsoDeviceFlow>
  'sso:wait': (flowId: string) => Promise<SsoAccount[]>
  'sso:save': (req: SsoSaveRequest) => Promise<string[]>
  'sso:cancel': (flowId: string) => Promise<void>
  'sso:loginSession': (sessionName: string) => Promise<SsoDeviceFlow>
  'shell:open': (url: string) => Promise<void>
  'inventory:cached': () => Promise<ScanResult | null>
  'inventory:scan': (profiles?: string[]) => Promise<ScanResult>
  'settings:get': () => Promise<Settings>
  'settings:set': (patch: Partial<Settings>) => Promise<Settings>
  'route:decide': (instanceKey: string, kind: 'ssh' | 'rdp', force?: 'direct' | 'ssm') => Promise<RouteDecision>
  'ssh:open': (req: SshOpenRequest) => Promise<SshSessionInfo>
  'ssh:write': (sessionId: string, data: string) => Promise<void>
  'ssh:resize': (sessionId: string, cols: number, rows: number) => Promise<void>
  'ssh:close': (sessionId: string) => Promise<void>
  'ssh:external': (req: SshOpenRequest) => Promise<void>
  'sftp:open': (req: SftpOpenRequest) => Promise<SftpSessionInfo>
  'sftp:list': (sessionId: string, path: string) => Promise<SftpEntry[]>
  'sftp:realpath': (sessionId: string, path: string) => Promise<string>
  'sftp:mkdir': (sessionId: string, path: string) => Promise<void>
  'sftp:rename': (sessionId: string, from: string, to: string) => Promise<void>
  'sftp:delete': (sessionId: string, entries: SftpEntry[]) => Promise<void>
  /** Opens the file/folder picker and queues uploads into remoteDir. Returns the number of files queued. */
  'sftp:pickUploads': (sessionId: string, remoteDir: string) => Promise<number>
  /** Queues uploads of the given local paths (files or folders) into remoteDir. */
  'sftp:upload': (sessionId: string, localPaths: string[], remoteDir: string) => Promise<number>
  /** Asks where to save, then queues downloads. Returns the number of files queued (0 if cancelled). */
  'sftp:download': (sessionId: string, entries: SftpEntry[]) => Promise<number>
  /** Queues downloads straight into a local folder (no dialog). */
  'sftp:downloadTo': (sessionId: string, entries: SftpEntry[], localDir: string) => Promise<number>
  'local:home': () => Promise<string>
  'local:list': (path: string) => Promise<SftpEntry[]>
  'local:realpath': (path: string) => Promise<string>
  'local:mkdir': (path: string) => Promise<void>
  'local:rename': (from: string, to: string) => Promise<void>
  'local:trash': (paths: string[]) => Promise<void>
  'local:reveal': (path: string) => Promise<void>
  'sftp:cancel': (transferId: string) => Promise<void>
  'sftp:transfers': (sessionId: string) => Promise<SftpTransfer[]>
  'sftp:clearTransfers': (sessionId: string) => Promise<void>
  'sftp:close': (sessionId: string) => Promise<void>
  'rdp:open': (req: RdpOpenRequest) => Promise<Tunnel | null>
  'rdp:prepare': (req: RdpPrepareRequest) => Promise<RdpPrepared>
  'rdp:release': (sessionId: string) => Promise<void>
  'rdp:lastError': (sessionId: string) => Promise<string | undefined>
  'creds:get': (instanceKey: string) => Promise<StoredCredential | null>
  'creds:set': (instanceKey: string, cred: StoredCredential) => Promise<void>
  'creds:delete': (instanceKey: string) => Promise<void>
  'creds:keys': () => Promise<string[]>
  'tunnels:list': () => Promise<Tunnel[]>
  'tunnels:close': (id: string) => Promise<void>
  'ec2:password': (instanceKey: string, pemFile?: string) => Promise<WindowsPasswordResult>
  'ec2:start': (instanceKey: string) => Promise<void>
  'ec2:stop': (instanceKey: string) => Promise<void>
  'ec2:regions': (profile: string) => Promise<string[]>
  'clipboard:write': (text: string) => Promise<void>
  'theme:set': (theme: Theme) => Promise<void>
  'dialog:pickFile': (title: string) => Promise<string | null>
  'app:paths': () => Promise<{ sessionManagerPlugin: string | null; awsCli: string | null; windowsApp: boolean }>
}

/** Push channels (main -> renderer) */
export interface IpcEvents {
  'scan:progress': ScanProgress
  'ssh:event': SshEvent
  'sftp:transfer': SftpTransfer
  'sftp:event': SftpEvent
  'tunnels:changed': Tunnel[]
  'profiles:status': ProfileStatus
  'instances:updated': Instance[]
}

export type IpcChannel = keyof IpcApi
export type IpcEventChannel = keyof IpcEvents

import { startDeviceFlow, waitForDeviceFlow, saveSsoProfiles, cancelDeviceFlow, addStaticProfile, removeProfile, renameProfile, ssoSessionsInConfig, sessionTokenInfo, loginExistingSession } from './aws/sso'
import type { IpcApi } from '@shared/ipc'
import { host } from './host'
import { listProfiles } from './aws/profiles'
import { checkAllProfiles, checkProfile, ssoLogin } from './aws/credentials'
import { enabledRegions, scanAll, setInstanceState, findInstance } from './aws/inventory'
import { windowsPassword } from './aws/passwords'
import { decideRoute } from './connect/route'
import { getCachedInventory, getSettings, setSettings } from './store'
import { openSsh, writeSsh, resizeSsh, closeSsh, openExternalSsh } from './ssh/session'
import { openRdp, hasWindowsApp } from './rdp/launcher'
import { openSftp, listSftp, realpathSftp, mkdirSftp, renameSftp, deleteSftp, pickUploads, uploadSftp, downloadSftp, downloadSftpTo, cancelTransfer, listTransfers, clearTransfers, closeSftp } from './sftp/session'
import { localHome, localList, localRealpath, localMkdir, localRename, localTrash, localReveal } from './localfs'
import { prepareRdp, releaseRdp, rdpLastError } from './rdp/sessions'
import { getCredential, setCredential, deleteCredential, credentialKeys } from './creds'
import { listTunnels, closeTunnel } from './tunnels'
import { findBinary } from './util'

type Handler<K extends keyof IpcApi> = (...args: Parameters<IpcApi[K]>) => ReturnType<IpcApi[K]>
export type Handlers = { [K in keyof IpcApi]: Handler<K> }

/** Push an IpcEvents message to every connected UI. */
export function send<T>(channel: string, payload: T): void {
  host().broadcast(channel, payload)
}

/**
 * The complete request/response surface of the connection engine, keyed by IpcApi channel. Electron registers each
 * entry with ipcMain (ipc.ts); the gateway dispatches WebSocket RPC calls to the same object.
 */
export const handlers: Handlers = {
  'profiles:list': () => listProfiles(true),
  'profiles:check': async (profile) => (profile ? [await checkProfile(profile)] : checkAllProfiles()),
  'profiles:login': (profile) => ssoLogin(profile),
  'profiles:addStatic': (req) => addStaticProfile(req),
  'profiles:remove': (name) => removeProfile(name),
  'profiles:rename': (from, to) => renameProfile(from, to),
  'sso:sessions': async () => {
    const profiles = await listProfiles()
    return ssoSessionsInConfig().map((x) => {
      const t = sessionTokenInfo(x.name)
      return { ...x, tokenValid: t.valid, expiresAt: t.expiresAt, hasRefreshToken: t.hasRefreshToken, profiles: profiles.filter((p) => p.ssoSession === x.name).map((p) => p.name) }
    })
  },
  'sso:start': (req) => startDeviceFlow(req),
  'sso:wait': (flowId) => waitForDeviceFlow(flowId),
  'sso:save': (req) => saveSsoProfiles(req),
  'sso:cancel': async (flowId) => cancelDeviceFlow(flowId),
  'sso:loginSession': async (name) => {
    const r = await loginExistingSession(name)
    // Completion is reported via profiles:status once the token lands.
    void r.done
      .then(async () => {
        for (const st of await checkAllProfiles()) send('profiles:status', st)
      })
      .catch((e: Error) => send('profiles:status', { profile: `sso-session:${name}`, state: 'error', message: e.message }))
    return { flowId: r.flowId, userCode: r.userCode, verificationUri: r.verificationUri, verificationUriComplete: r.verificationUriComplete, expiresIn: r.expiresIn }
  },
  'shell:open': async (url) => {
    if (/^https?:\/\//.test(url)) await host().openExternal(url)
  },
  'inventory:cached': async () => getCachedInventory(),
  'inventory:scan': (profiles, targets) => scanAll((p) => send('scan:progress', p), profiles, targets),
  'settings:get': async () => getSettings(),
  'settings:set': async (patch) => setSettings(patch),
  'route:decide': async (key, _kind, force) => decideRoute(findInstance(key), force),
  'ssh:open': (req) => openSsh(req),
  'ssh:write': async (id, data) => writeSsh(id, data),
  'ssh:resize': async (id, cols, rows) => resizeSsh(id, cols, rows),
  'ssh:close': (id) => closeSsh(id),
  'ssh:external': (req) => openExternalSsh(req),
  'sftp:open': (req) => openSftp(req),
  'sftp:list': (id, path) => listSftp(id, path),
  'sftp:realpath': (id, path) => realpathSftp(id, path),
  'sftp:mkdir': (id, path) => mkdirSftp(id, path),
  'sftp:rename': (id, from, to) => renameSftp(id, from, to),
  'sftp:delete': (id, entries) => deleteSftp(id, entries),
  'sftp:pickUploads': (id, dir) => pickUploads(id, dir),
  'sftp:upload': (id, paths, dir) => uploadSftp(id, paths, dir),
  'sftp:download': (id, entries) => downloadSftp(id, entries),
  'sftp:downloadTo': (id, entries, dir) => downloadSftpTo(id, entries, dir),
  'local:home': async () => localHome(),
  'local:list': (path) => localList(path),
  'local:realpath': (path) => localRealpath(path),
  'local:mkdir': (path) => localMkdir(path),
  'local:rename': (from, to) => localRename(from, to),
  'local:trash': (paths) => localTrash(paths),
  'local:reveal': async (path) => localReveal(path),
  'sftp:cancel': async (tid) => cancelTransfer(tid),
  'sftp:transfers': async (id) => listTransfers(id),
  'sftp:clearTransfers': async (id) => clearTransfers(id),
  'sftp:close': (id) => closeSftp(id),
  'rdp:open': (req) => openRdp(req),
  'rdp:prepare': (req) => prepareRdp(req),
  'rdp:release': (id) => releaseRdp(id),
  'rdp:lastError': async (id) => rdpLastError(id),
  'creds:get': async (key) => getCredential(key),
  'creds:set': async (key, cred) => setCredential(key, cred),
  'creds:delete': async (key) => deleteCredential(key),
  'creds:keys': async () => credentialKeys(),
  'tunnels:list': async () => listTunnels(),
  'tunnels:close': (id) => closeTunnel(id),
  'ec2:password': (key, pem) => windowsPassword(key, pem),
  'ec2:start': (key) => setInstanceState(key, 'start'),
  'ec2:stop': (key) => setInstanceState(key, 'stop'),
  'ec2:regions': async (profile) => {
    const p = (await listProfiles()).find((x) => x.name === profile)
    if (!p) throw new Error(`Unknown profile ${profile}`)
    return enabledRegions(profile, p.region)
  },
  'clipboard:write': async (text) => {
    if (!host().clipboardWrite(text)) throw new Error('No clipboard on this host')
  },
  'theme:set': async (theme) => host().setThemeSource(theme),
  'dialog:pickFile': async (title) => (await host().pickPaths({ title, kind: 'file' }))?.[0] ?? null,
  'app:paths': async () => ({
    sessionManagerPlugin: getSettings().sessionManagerPluginPath || findBinary('session-manager-plugin'),
    awsCli: getSettings().awsCliPath || findBinary('aws'),
    windowsApp: hasWindowsApp()
  }),
}

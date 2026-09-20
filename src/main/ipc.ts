import { ipcMain, clipboard, dialog, BrowserWindow, nativeTheme, shell } from 'electron'
import { startDeviceFlow, waitForDeviceFlow, saveSsoProfiles, cancelDeviceFlow, addStaticProfile, removeProfile, renameProfile, ssoSessionsInConfig, sessionTokenInfo, loginExistingSession } from './aws/sso'
import type { IpcApi } from '@shared/ipc'
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

function handle<K extends keyof IpcApi>(channel: K, fn: Handler<K>): void {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return await (fn as (...a: unknown[]) => unknown)(...args)
    } catch (e) {
      // Expected when a renderer remount supersedes an in-flight connect; not worth a stack trace.
      if ((e as Error).message === 'cancelled') throw e
      console.error(`[ipc ${channel}]`, (e as Error).message)
      throw e
    }
  })
}

function send<T>(channel: string, payload: T): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload)
}

export function registerIpc(): void {
  handle('profiles:list', () => listProfiles(true))
  handle('profiles:check', async (profile) => (profile ? [await checkProfile(profile)] : checkAllProfiles()))
  handle('profiles:login', (profile) => ssoLogin(profile))
  handle('profiles:addStatic', (req) => addStaticProfile(req))
  handle('profiles:remove', (name) => removeProfile(name))
  handle('profiles:rename', (from, to) => renameProfile(from, to))
  handle('sso:sessions', async () => {
    const profiles = await listProfiles()
    return ssoSessionsInConfig().map((x) => {
      const t = sessionTokenInfo(x.name)
      return { ...x, tokenValid: t.valid, expiresAt: t.expiresAt, hasRefreshToken: t.hasRefreshToken, profiles: profiles.filter((p) => p.ssoSession === x.name).map((p) => p.name) }
    })
  })
  handle('sso:start', (req) => startDeviceFlow(req))
  handle('sso:wait', (flowId) => waitForDeviceFlow(flowId))
  handle('sso:save', (req) => saveSsoProfiles(req))
  handle('sso:cancel', async (flowId) => cancelDeviceFlow(flowId))
  handle('sso:loginSession', async (name) => {
    const r = await loginExistingSession(name)
    // Completion is reported via profiles:status once the token lands.
    void r.done
      .then(async () => {
        for (const st of await checkAllProfiles()) send('profiles:status', st)
      })
      .catch((e: Error) => send('profiles:status', { profile: `sso-session:${name}`, state: 'error', message: e.message }))
    return { flowId: r.flowId, userCode: r.userCode, verificationUri: r.verificationUri, verificationUriComplete: r.verificationUriComplete, expiresIn: r.expiresIn }
  })
  handle('shell:open', async (url) => {
    if (/^https?:\/\//.test(url)) await shell.openExternal(url)
  })
  handle('inventory:cached', async () => getCachedInventory())
  handle('inventory:scan', (profiles, targets) => scanAll((p) => send('scan:progress', p), profiles, targets))
  handle('settings:get', async () => getSettings())
  handle('settings:set', async (patch) => setSettings(patch))
  handle('route:decide', async (key, _kind, force) => decideRoute(findInstance(key), force))
  handle('ssh:open', (req) => openSsh(req))
  handle('ssh:write', async (id, data) => writeSsh(id, data))
  handle('ssh:resize', async (id, cols, rows) => resizeSsh(id, cols, rows))
  handle('ssh:close', (id) => closeSsh(id))
  handle('ssh:external', (req) => openExternalSsh(req))
  handle('sftp:open', (req) => openSftp(req))
  handle('sftp:list', (id, path) => listSftp(id, path))
  handle('sftp:realpath', (id, path) => realpathSftp(id, path))
  handle('sftp:mkdir', (id, path) => mkdirSftp(id, path))
  handle('sftp:rename', (id, from, to) => renameSftp(id, from, to))
  handle('sftp:delete', (id, entries) => deleteSftp(id, entries))
  handle('sftp:pickUploads', (id, dir) => pickUploads(id, dir))
  handle('sftp:upload', (id, paths, dir) => uploadSftp(id, paths, dir))
  handle('sftp:download', (id, entries) => downloadSftp(id, entries))
  handle('sftp:downloadTo', (id, entries, dir) => downloadSftpTo(id, entries, dir))
  handle('local:home', async () => localHome())
  handle('local:list', (path) => localList(path))
  handle('local:realpath', (path) => localRealpath(path))
  handle('local:mkdir', (path) => localMkdir(path))
  handle('local:rename', (from, to) => localRename(from, to))
  handle('local:trash', (paths) => localTrash(paths))
  handle('local:reveal', async (path) => localReveal(path))
  handle('sftp:cancel', async (tid) => cancelTransfer(tid))
  handle('sftp:transfers', async (id) => listTransfers(id))
  handle('sftp:clearTransfers', async (id) => clearTransfers(id))
  handle('sftp:close', (id) => closeSftp(id))
  handle('rdp:open', (req) => openRdp(req))
  handle('rdp:prepare', (req) => prepareRdp(req))
  handle('rdp:release', (id) => releaseRdp(id))
  handle('rdp:lastError', async (id) => rdpLastError(id))
  handle('creds:get', async (key) => getCredential(key))
  handle('creds:set', async (key, cred) => setCredential(key, cred))
  handle('creds:delete', async (key) => deleteCredential(key))
  handle('creds:keys', async () => credentialKeys())
  handle('tunnels:list', async () => listTunnels())
  handle('tunnels:close', (id) => closeTunnel(id))
  handle('ec2:password', (key, pem) => windowsPassword(key, pem))
  handle('ec2:start', (key) => setInstanceState(key, 'start'))
  handle('ec2:stop', (key) => setInstanceState(key, 'stop'))
  handle('ec2:regions', async (profile) => {
    const p = (await listProfiles()).find((x) => x.name === profile)
    if (!p) throw new Error(`Unknown profile ${profile}`)
    return enabledRegions(profile, p.region)
  })
  handle('clipboard:write', async (text) => clipboard.writeText(text))
  handle('theme:set', async (theme) => {
    nativeTheme.themeSource = theme
  })
  handle('dialog:pickFile', async (title) => {
    const r = await dialog.showOpenDialog({ title, properties: ['openFile', 'showHiddenFiles'] })
    return r.canceled ? null : r.filePaths[0]
  })
  handle('app:paths', async () => ({
    sessionManagerPlugin: getSettings().sessionManagerPluginPath || findBinary('session-manager-plugin'),
    awsCli: getSettings().awsCliPath || findBinary('aws'),
    windowsApp: hasWindowsApp()
  }))
}

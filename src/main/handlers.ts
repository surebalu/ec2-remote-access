import { existsSync } from 'node:fs'
import { basename, resolve, sep } from 'node:path'
import { startDeviceFlow, waitForDeviceFlow, saveSsoProfiles, cancelDeviceFlow, addStaticProfile, removeProfile, renameProfile, ssoSessionsInConfig, sessionTokenInfo, loginExistingSession } from './aws/sso'
import type { IpcApi } from '@shared/ipc'
import { host } from './host'
import { listProfiles } from './aws/profiles'
import { checkAllProfiles, checkProfile, ssoLogin } from './aws/credentials'
import { enabledRegions, scanAll, setInstanceState, findInstance } from './aws/inventory'
import { windowsPassword } from './aws/passwords'
import { decideRoute } from './connect/route'
import { getCachedInventory, getSettings, setSettings } from './store'
import { consoleSignInUrl, loadBrowserState, saveBrowserState } from './browser'
import { opLogins, opSecrets } from './onepassword'
import { closeLocal, loadTerminalState, openLocal, resizeLocal, saveTerminalState, shellHistory, writeLocal } from './localterm'
import { localGitStatus } from './localgit'
import { loginMatches } from '@shared/browser'
import { appendNote, createFolder, createNote, dailyNote, deleteEntry, hostNote, listNotes, notesInfo, openInObsidian, pickNotesFolder, readNote, renameEntry, saveImage, searchNotes, statNote, writeNote } from './notes'
import { deleteBoard, listBoards, loadBoard, saveBoard } from './boards'
import { openSsh, writeSsh, resizeSsh, closeSsh, endDetachedShell, listShells, switchShell, renameShell, openExternalSsh } from './ssh/session'
import { openRdp, hasWindowsApp } from './rdp/launcher'
import { openSftp, listSftp, realpathSftp, mkdirSftp, renameSftp, deleteSftp, pickUploads, uploadSftp, downloadSftp, downloadSftpTo, cancelTransfer, listTransfers, clearTransfers, closeSftp } from './sftp/session'
import { localHome, localList, localRealpath, localMkdir, localRename, localTrash, localReveal } from './localfs'
import { prepareRdp, releaseRdp, rdpLastError } from './rdp/sessions'
import { getCredential, setCredential, deleteCredential, credentialKeys } from './creds'
import { listTunnels, closeTunnel } from './tunnels'
import { openPortForward } from './portForward'
import { hostHealth } from './aws/health'
import { startRun, runStatus, cancelRun, listRuns } from './aws/runCommand'
import { findBinary } from './util'
import { phoneStatus, configurePhoneAccess, rotatePhoneToken, setPhoneTerminals } from './phoneAccess'
import { recentLog } from './log'
import { cancelVoice, openPrivacyPane, startVoice, stopVoice, voiceStatus } from './voice'
import { version as APP_VERSION } from '../../package.json'

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
  'sso:loginSession': async (name, opts) => {
    const r = await loginExistingSession(name, opts?.openBrowser !== false)
    // Completion is reported via profiles:status once the token lands.
    void r.done
      .then(async () => {
        for (const st of await checkAllProfiles()) send('profiles:status', st)
      })
      .catch((e: Error) => send('profiles:status', { profile: `sso-session:${name}`, state: 'error', message: e.message }))
    return { flowId: r.flowId, userCode: r.userCode, verificationUri: r.verificationUri, verificationUriComplete: r.verificationUriComplete, expiresIn: r.expiresIn }
  },
  'notes:openInObsidian': (path) => openInObsidian(path),
  'notes:saveImage': (name, dataUrl) => saveImage(name, dataUrl),
  'boards:list': async () => listBoards(),
  'boards:load': async (id) => loadBoard(id),
  'boards:save': (board) => saveBoard(board),
  'boards:delete': (id) => deleteBoard(id),
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
  'ssh:close': (id, opts) => closeSsh(id, opts),
  'ssh:endShell': (id, name) => endDetachedShell(id, name),
  'ssh:listShells': (id) => listShells(id),
  'ssh:switchShell': (id, name, opts) => switchShell(id, name, opts),
  'ssh:renameShell': (id, name, label) => renameShell(id, name, label),
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
  'tunnels:open': (req) => openPortForward(req),
  'ec2:health': (key) => hostHealth(key),
  'ec2:password': (key, pem) => windowsPassword(key, pem),
  'ec2:start': (key) => setInstanceState(key, 'start'),
  'ec2:stop': (key) => setInstanceState(key, 'stop'),
  'ec2:regions': async (profile) => {
    const p = (await listProfiles()).find((x) => x.name === profile)
    if (!p) throw new Error(`Unknown profile ${profile}`)
    return enabledRegions(profile, p.region)
  },
  'notes:info': async () => notesInfo(),
  'notes:list': () => listNotes(),
  'notes:read': (path) => readNote(path),
  'notes:write': (path, text, baseMtime) => writeNote(path, text, baseMtime),
  'notes:stat': (path) => statNote(path),
  'notes:create': (path) => createNote(path),
  'notes:hostNote': (key) => hostNote(key),
  'notes:daily': () => dailyNote(),
  'notes:append': (path, text) => appendNote(path, text),
  'notes:search': (query) => searchNotes(query),
  'notes:pickFolder': () => pickNotesFolder(),
  'notes:mkdir': (path) => createFolder(path),
  'notes:rename': (from, to) => renameEntry(from, to),
  'notes:delete': (path) => deleteEntry(path),
  'browser:load': async () => loadBrowserState(),
  'browser:save': (state) => saveBrowserState(state),
  'browser:consoleUrl': (profile, destination) => consoleSignInUrl(profile, destination),
  'browser:share': async (url) => /^https?:\/\//.test(url) && host().shareUrl(url),
  'browser:openDownload': async (path, how) => {
    const dir = host().downloadsDir()
    if (!dir) return
    // Only what the browser put in Downloads: the renderer never gets to open arbitrary files.
    const target = path ? resolve(path) : dir
    if (target !== dir && !target.startsWith(dir + sep)) throw new Error('Only files in your Downloads folder can be opened from here.')
    if (path && !existsSync(target)) throw new Error(`${basename(target)} is no longer in your Downloads folder.`)
    if (how === 'reveal' && path) host().revealPath(target)
    else await host().openPath(target)
  },
  'browser:cancelDownload': async (id) => host().cancelDownload(id),
  'term:available': async () => true,
  'term:open': (req) => openLocal(req),
  'term:write': async (id, data) => writeLocal(id, data),
  'term:resize': async (id, cols, rows) => resizeLocal(id, cols, rows),
  'term:close': async (id) => closeLocal(id),
  'term:history': async () => shellHistory(),
  'term:loadState': async () => loadTerminalState(),
  'term:saveState': (state) => saveTerminalState(state),
  'term:git': (cwd) => localGitStatus(cwd),
  'browser:logins': async (pageUrl, refresh) => (await opLogins(refresh)).map((l) => ({ ...l, matches: loginMatches(l.urls, pageUrl) })),
  'browser:fill': async (webContentsId, account, itemId, anySite) => {
    const login = (await opLogins()).find((l) => l.id === itemId && l.account === account)
    if (!login) throw new Error('That 1Password item is no longer there.')
    return host().fillWebPage(webContentsId, await opSecrets(account, itemId), anySite ? null : login.urls)
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
  'run:start': (req) => startRun(req),
  'run:status': async (id) => runStatus(id),
  'run:cancel': (id) => cancelRun(id),
  'run:list': async () => listRuns(),
  'app:about': async () => ({
    version: APP_VERSION,
    electron: process.versions.electron ?? null,
    chrome: process.versions.chrome ?? null,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    dataDir: host().userDataDir(),
    logsDir: host().logsDir()
  }),
  'app:reveal': async (which) => host().revealPath(which === 'logs' ? host().logsDir() : host().userDataDir()),
  'phone:status': async () => phoneStatus(),
  'phone:configure': (patch) => configurePhoneAccess(patch),
  'phone:terminals': async (allow) => setPhoneTerminals(allow),
  'phone:rotateToken': () => rotatePhoneToken(),
  'voice:status': (opts) => voiceStatus(opts),
  'voice:start': (opts) => startVoice(opts),
  'voice:stop': async (id) => stopVoice(id),
  'voice:cancel': async (id) => cancelVoice(id),
  'voice:openPrivacy': (pane) => openPrivacyPane(pane),
  'diag:log': async (opts) => {
    const r = recentLog(opts?.lines, opts?.filter)
    // Main-process memory next to the renderer's, to tell which process is growing when the app slows down.
    const m = process.memoryUsage()
    const mb = (n: number): number => Math.round(n / 1048576)
    const mem = `[main] up ${Math.round(process.uptime() / 3600)} h · rss ${mb(m.rss)} MB · heap ${mb(m.heapUsed)}/${mb(m.heapTotal)} MB · arrayBuffers ${mb(m.arrayBuffers)} MB`
    return { ...r, text: `${mem}\n${r.text}` }
  }
}

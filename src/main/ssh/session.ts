import ssh2, { type ClientChannel, type ConnectConfig } from 'ssh2'
const { Client } = ssh2
type Client = InstanceType<typeof ssh2.Client>
import { readFileSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SshOpenRequest, SshSessionInfo, SshEvent } from '@shared/types'
import { findInstance } from '../aws/inventory'
import { decideRoute, defaultSshUser, defaultIdentityFile, defaultInitCommand } from '../connect/route'
import type { Instance } from '@shared/types'
import { startSshStream, type SsmHandle } from '../ssm/session'
import { getSettings } from '../store'
import { host } from '../host'
import { findBinary, shellQuote, uid } from '../util'
import { getCredential } from '../creds'
import { lookupClient, registerClient, unregisterClient } from './clients'

interface Live {
  info: SshSessionInfo
  client: Client
  channel?: ClientChannel
  ssm?: SsmHandle
  /** True when the client belongs to another session (SFTP tab) and must not be ended here. */
  shared?: boolean
}

const sessions = new Map<string, Live>()

function emit(ev: SshEvent): void {
  host().broadcast('ssh:event', ev)
}

/**
 * Key/agent configuration, plus the password saved for RDP on this host (if any) as a fallback. ssh2 tries public
 * key first and then password, which is what Windows OpenSSH Server usually needs since it rarely has authorized keys.
 */
export async function authConfig(req: Pick<SshOpenRequest, 'identityFile' | 'useAgent' | 'user'>, inst: Instance): Promise<Partial<ConnectConfig>> {
  const s = getSettings()
  const ov = s.overrides[inst.key]
  const cfg: Partial<ConnectConfig> = {}
  let saved: ReturnType<typeof getCredential> = null
  try {
    saved = getCredential(inst.key)
  } catch {
    /* keychain unavailable */
  }
  if (saved?.password && (!req.user || req.user.toLowerCase() === saved.user.toLowerCase())) cfg.password = saved.password
  const identity = defaultIdentityFile(inst, req.identityFile)
  if (identity) {
    try {
      cfg.privateKey = readFileSync(identity.replace(/^~/, process.env.HOME ?? ''))
    } catch (e) {
      throw new Error(`Cannot read identity file ${identity}: ${(e as Error).message}`)
    }
  }
  const useAgent = req.useAgent ?? ov?.useAgent ?? true
  if (useAgent && s.sshAgentSock) cfg.agent = s.sshAgentSock
  if (!cfg.privateKey && !cfg.agent && !cfg.password) throw new Error('No SSH identity: configure an SSH agent socket or identity file in Settings, or save credentials for this host via RDP.')
  return cfg
}

export async function openSsh(req: SshOpenRequest): Promise<SshSessionInfo> {
  const inst = findInstance(req.instanceKey)
  const route = decideRoute(inst, req.forceRoute)
  if (route.route === 'unreachable' || route.route === 'not-running') throw new Error(route.reason)
  const s = getSettings()
  const ov = s.overrides[inst.key]
  const user = req.user || defaultSshUser(inst)
  const port = req.port ?? ov?.sshPort ?? 22
  const sessionId = req.sessionId ?? uid('ssh')
  const info: SshSessionInfo = {
    sessionId,
    instanceKey: inst.key,
    title: `${inst.name} @ ${inst.profile}`,
    route: route.route,
    host: route.host!,
    user
  }

  // A re-open with the same id (e.g. React StrictMode remounting) replaces the previous attempt.
  if (sessions.has(sessionId)) await closeSsh(sessionId)

  // Reuse an authenticated connection from another tab to the same host and user when offered.
  const sharedClient = lookupClient(req.reuseSessionId, inst.key, user)
  if (sharedClient) {
    const live: Live = { info, client: sharedClient.client, shared: true }
    sessions.set(sessionId, live)
    sharedClient.users.add(sessionId)
    emit({ sessionId, type: 'status', message: `Reusing the connection of your open session as ${user}...` })
    try {
      await openShell(live, req)
      sharedClient.client.once('close', () => {
        if (sessions.get(sessionId) === live) {
          emit({ sessionId, type: 'closed', message: 'Disconnected' })
          void closeSsh(sessionId)
        }
      })
      return info
    } catch (e) {
      // Fall through to a fresh login below.
      sessions.delete(sessionId)
      sharedClient.users.delete(sessionId)
      emit({ sessionId, type: 'status', message: `Could not reuse the connection (${(e as Error).message}); logging in...` })
    }
  }

  const client = new Client()
  const live: Live = { info, client }
  sessions.set(sessionId, live)
  const cancelled = (): boolean => sessions.get(sessionId) !== live

  const base: ConnectConfig = {
    username: user,
    readyTimeout: s.connectTimeoutSec * 1000,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 4,
    tryKeyboard: false,
    ...(await authConfig(req, inst))
  }

  emit({ sessionId, type: 'status', message: `Connecting via ${route.route === 'ssm' ? 'SSM Session Manager' : route.host} as ${user}...` })

  if (route.route === 'ssm') {
    const { handle, stream } = await startSshStream(inst, port)
    if (cancelled()) {
      await handle.terminate()
      throw new Error('cancelled')
    }
    live.ssm = handle
    handle.child.stderr.on('data', (d) => emit({ sessionId, type: 'status', message: d.toString().trim() }))
    base.sock = stream
  } else {
    base.host = route.host
    base.port = port
  }

  await new Promise<void>((resolve, reject) => {
    let done = false
    client.on('ready', () => {
      if (cancelled()) {
        client.end()
        reject(new Error('cancelled'))
        return
      }
      registerClient(sessionId, { client, instanceKey: inst.key, user })
      openShell(live, req).then(
        () => {
          if (cancelled()) {
            live.channel?.close()
            client.end()
            reject(new Error('cancelled'))
            return
          }
          done = true
          resolve()
        },
        (err: Error) => reject(err)
      )
    })
    client.on('error', (err) => {
      if (cancelled()) { if (!done) reject(new Error('cancelled')); return }
      emit({ sessionId, type: 'error', message: err.message })
      if (!done) {
        void closeSsh(sessionId)
        reject(err)
      }
    })
    client.on('close', () => {
      // A previous client may finish closing after this ID has been reconnected.
      if (cancelled()) { if (!done) reject(new Error('cancelled')); return }
      if (done) {
        emit({ sessionId, type: 'closed', message: 'Disconnected' })
      } else reject(new Error('SSH connection closed before the session was ready.'))
      void closeSsh(sessionId)
    })
    client.connect(base)
  })
  return info
}

/** Opens the interactive shell channel on a ready client and wires its output to the renderer. */
function openShell(live: Live, req: SshOpenRequest): Promise<void> {
  const { sessionId } = live.info
  return new Promise((resolve, reject) => {
    live.client.shell({ term: 'xterm-256color', cols: req.cols, rows: req.rows }, (err, channel) => {
      if (err) return reject(err)
      if (sessions.get(sessionId) !== live) { channel.close(); reject(new Error('cancelled')); return }
      live.channel = channel
      const dec = new StringDecoder('utf8')
      channel.on('data', (d: Buffer) => { if (sessions.get(sessionId) === live) emit({ sessionId, type: 'data', data: dec.write(d) }) })
      channel.stderr.on('data', (d: Buffer) => { if (sessions.get(sessionId) === live) emit({ sessionId, type: 'data', data: d.toString() }) })
      channel.on('close', () => {
        if (sessions.get(sessionId) === live) {
          emit({ sessionId, type: 'closed', message: 'Connection closed' })
          void closeSsh(sessionId)
        }
      })
      // sshd queues stdin until the shell reads it, so this runs as the first command of the session.
      const init = defaultInitCommand(findInstance(req.instanceKey), req.initCommand)
      if (init) channel.write(init.replace(/\r?\n/g, '\n').replace(/\n?$/, '\n'))
      resolve()
    })
  })
}

export function writeSsh(sessionId: string, data: string): void {
  sessions.get(sessionId)?.channel?.write(data)
}

export function resizeSsh(sessionId: string, cols: number, rows: number): void {
  sessions.get(sessionId)?.channel?.setWindow(rows, cols, 0, 0)
}

export async function closeSsh(sessionId: string): Promise<void> {
  const live = sessions.get(sessionId)
  if (!live) return
  sessions.delete(sessionId)
  try {
    live.channel?.close()
  } catch {
    /* ignore */
  }
  if (live.shared) return // the connection belongs to another tab
  unregisterClient(sessionId)
  live.client.end()
  live.client.destroy()
  await live.ssm?.terminate()
}

export async function closeAllSsh(): Promise<void> {
  await Promise.all(Array.from(sessions.keys()).map((id) => closeSsh(id)))
}

/** Builds an equivalent `ssh` command line and opens it in the user's terminal of choice. */
export async function openExternalSsh(req: SshOpenRequest): Promise<void> {
  const inst = findInstance(req.instanceKey)
  const route = decideRoute(inst, req.forceRoute)
  if (route.route === 'unreachable' || route.route === 'not-running') throw new Error(route.reason)
  const s = getSettings()
  const ov = s.overrides[inst.key]
  const user = req.user || defaultSshUser(inst)
  const port = req.port ?? ov?.sshPort ?? 22
  const identity = defaultIdentityFile(inst, req.identityFile)
  const parts = ['ssh', '-o', 'StrictHostKeyChecking=accept-new']
  if (identity) parts.push('-i', shellQuote(identity))
  if (s.sshAgentSock) parts.push('-o', shellQuote(`IdentityAgent=${s.sshAgentSock}`))
  if (route.route === 'ssm') {
    const aws = s.awsCliPath || findBinary('aws') || 'aws'
    const proxy = `${aws} ssm start-session --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p --profile ${inst.profile} --region ${inst.region}`
    parts.push('-o', shellQuote(`ProxyCommand=${proxy}`), '-p', String(port), `${user}@${inst.instanceId}`)
  } else {
    parts.push('-p', String(port), `${user}@${route.host}`)
  }
  const cmd = parts.join(' ')
  await launchInTerminal(cmd, `${inst.name} @ ${inst.profile}`)
}

async function launchInTerminal(cmd: string, title: string): Promise<void> {
  const term = getSettings().externalTerminal
  if (term === 'Warp') {
    // Warp launch configurations: https://docs.warp.dev/features/sessions/launch-configurations
    const dir = join(homedir(), '.warp/launch_configurations')
    mkdirSync(dir, { recursive: true })
    const name = 'ec2-remote-access'
    const yaml = [
      `name: ${name}`,
      'windows:',
      '  - tabs:',
      `      - title: ${JSON.stringify(title)}`,
      '        layout:',
      `          cwd: ${JSON.stringify(homedir())}`,
      '          commands:',
      `            - exec: ${JSON.stringify(cmd)}`,
      ''
    ].join('\n')
    writeFileSync(join(dir, `${name}.yaml`), yaml)
    await run('open', [`warp://launch/${name}`])
    return
  }
  const app = term === 'iTerm' ? 'iTerm' : 'Terminal'
  const escaped = cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const script =
    app === 'iTerm'
      ? `tell application "iTerm"\n activate\n set w to (create window with default profile)\n tell current session of w to write text "${escaped}"\nend tell`
      : `tell application "Terminal"\n activate\n do script "${escaped}"\nend tell`
  await run('osascript', ['-e', script])
}

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    c.stderr.on('data', (d) => (err += d))
    c.on('error', reject)
    c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `${bin} exited ${code}`))))
  })
}

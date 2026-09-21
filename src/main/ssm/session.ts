import { SSMClient, StartSessionCommand, TerminateSessionCommand } from '@aws-sdk/client-ssm'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Duplex } from 'node:stream'
import type { Instance } from '@shared/types'
import { credentialsFor } from '../aws/credentials'
import { getSettings } from '../store'
import { findBinary } from '../util'
import { log } from '../log'

/** Duplex over a child process: reads from stdout, writes to stdin (what ssh's ProxyCommand does). */
class ChildDuplex extends Duplex {
  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    super()
    child.stdout.on('data', (d: Buffer) => {
      if (!this.push(d)) child.stdout.pause()
    })
    child.stdout.on('end', () => this.push(null))
    child.on('exit', () => this.destroy())
    child.on('error', (e) => this.destroy(e))
    child.stdin.on('error', (e) => this.destroy(e))
  }
  _read(): void {
    this.child.stdout.resume()
  }
  _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.child.stdin.write(chunk, cb)
  }
  _final(cb: (err?: Error | null) => void): void {
    this.child.stdin.end(cb)
  }
  _destroy(err: Error | null, cb: (err: Error | null) => void): void {
    if (this.child.exitCode === null) this.child.kill('SIGTERM')
    cb(err)
  }
}

export interface SsmHandle {
  sessionId: string
  child: ChildProcessWithoutNullStreams
  terminate: () => Promise<void>
}

export function pluginPath(): string {
  const p = getSettings().sessionManagerPluginPath || findBinary('session-manager-plugin')
  if (!p) {
    throw new Error(
      'session-manager-plugin not found. Install: brew install --cask session-manager-plugin, or set the path in Settings.'
    )
  }
  return p
}

/**
 * Starts an SSM session via the SDK and hands it to session-manager-plugin exactly the way the AWS CLI does:
 *   session-manager-plugin <StartSessionResponse JSON> <region> StartSession <profile> <request JSON> <endpoint>
 */
async function start(inst: Instance, documentName: string, parameters: Record<string, string[]>): Promise<SsmHandle> {
  const plugin = pluginPath()
  const ssm = new SSMClient({ region: inst.region, credentials: credentialsFor(inst.profile) })
  const request = { Target: inst.instanceId, DocumentName: documentName, Parameters: parameters }
  const resp = await ssm.send(new StartSessionCommand(request))
  const endpoint = `https://ssm.${inst.region}.amazonaws.com`
  const child = spawn(
    plugin,
    [
      JSON.stringify({ SessionId: resp.SessionId, TokenValue: resp.TokenValue, StreamUrl: resp.StreamUrl }),
      inst.region,
      'StartSession',
      inst.profile,
      JSON.stringify(request),
      endpoint
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AWS_PROFILE: inst.profile } }
  )
  let terminated = false
  const terminate = async (): Promise<void> => {
    if (terminated) return
    terminated = true
    if (child.exitCode === null) {
      try {
        child.stdin.end()
      } catch {
        /* ignore */
      }
      child.kill('SIGTERM')
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
      }, 2000).unref()
    }
    try {
      await ssm.send(new TerminateSessionCommand({ SessionId: resp.SessionId }))
    } catch {
      /* already gone */
    } finally {
      ssm.destroy()
    }
  }
  log('ssm', 'session started', { ssmSessionId: resp.SessionId, instance: inst.key, document: documentName, pid: child.pid })
  child.on('exit', (code, signal) => {
    log('ssm', 'plugin exited', { ssmSessionId: resp.SessionId, code, signal, terminatedByUs: terminated })
    if (!terminated) void terminate()
  })
  return { sessionId: resp.SessionId!, child, terminate }
}

/** SSH-over-SSM: the plugin's stdin/stdout carry the raw SSH byte stream (like ProxyCommand). */
export async function startSshStream(inst: Instance, remotePort = 22): Promise<{ handle: SsmHandle; stream: Duplex }> {
  const handle = await start(inst, 'AWS-StartSSHSession', { portNumber: [String(remotePort)] })
  return { handle, stream: new ChildDuplex(handle.child) }
}

/** Local port forwarding: resolves once the plugin reports it is listening. */
export async function startPortForward(
  inst: Instance,
  remotePort: number,
  localPort: number,
  onLog?: (line: string) => void
): Promise<SsmHandle> {
  const handle = await start(inst, 'AWS-StartPortForwardingSession', {
    portNumber: [String(remotePort)],
    localPortNumber: [String(localPort)]
  })
  await new Promise<void>((resolve, reject) => {
    let buf = ''
    let settled = false
    const timer = setTimeout(() => finish(new Error('Timed out waiting for the SSM port-forward to become ready')), 30_000)
    const finish = (err?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) {
        void handle.terminate()
        reject(err)
      } else resolve()
    }
    const onData = (d: Buffer): void => {
      buf += d.toString()
      for (const line of d.toString().split('\n')) if (line.trim()) log('ssm', 'plugin', { ssmSessionId: handle.sessionId, line: line.trim() })
      for (const line of buf.split('\n')) if (line.trim()) onLog?.(line.trim())
      if (/Waiting for connections/i.test(buf)) finish()
      if (/(error|failed|Cannot perform)/i.test(buf) && !/Waiting for connections/i.test(buf)) finish(new Error(buf.trim()))
    }
    handle.child.stdout.on('data', onData)
    handle.child.stderr.on('data', onData)
    handle.child.on('exit', (code) => finish(new Error(`session-manager-plugin exited (${code}): ${buf.trim()}`)))
    handle.child.on('error', (e) => finish(e))
  })
  return handle
}

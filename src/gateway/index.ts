/**
 * Headless gateway: runs the connection engine as a Node service and serves the same UI to a browser.
 *
 *   node out/gateway/index.js [--host 0.0.0.0] [--port 8321] [--data-dir DIR] [--token T] [--static DIR]
 *
 * Environment equivalents: EC2RA_GATEWAY_HOST, EC2RA_GATEWAY_PORT, EC2RA_DATA_DIR, EC2RA_GATEWAY_TOKEN.
 * Defaults bind 127.0.0.1 only; use --host 0.0.0.0 (or your Tailscale IP) to reach it from a phone.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, networkInterfaces, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setHost } from '../main/host'
import { handlers } from '../main/handlers'
import { closeAllSsh } from '../main/ssh/session'
import { closeAllSftp } from '../main/sftp/session'
import { closeAllTunnels } from '../main/tunnels'
import { releaseAllRdp } from '../main/rdp/sessions'
import { ensureProxy, stopProxy } from '../main/rdp/cleanpath'
import { createGatewayHost } from './host'
import { initLog } from '../main/log'
import { createGatewayServer } from './server'

function arg(name: string, env: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  return process.env[env] ?? fallback
}

function defaultDataDir(): string {
  // Same directory as the desktop app on macOS so a gateway on your Mac shares its settings and inventory cache.
  if (platform() === 'darwin') return join(homedir(), 'Library/Application Support/EC2 Remote Access')
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'ec2-remote-access')
}

function loadToken(dataDir: string): string {
  const explicit = arg('token', 'EC2RA_GATEWAY_TOKEN', '')
  if (explicit) return explicit
  const file = join(dataDir, 'gateway.token')
  if (!existsSync(file)) {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(file, randomBytes(24).toString('base64url'), { mode: 0o600 })
  }
  return readFileSync(file, 'utf8').trim()
}

async function main(): Promise<void> {
  const dataDir = resolve(arg('data-dir', 'EC2RA_DATA_DIR', defaultDataDir()))
  const host = arg('host', 'EC2RA_GATEWAY_HOST', '127.0.0.1')
  const port = Number(arg('port', 'EC2RA_GATEWAY_PORT', '8321'))
  const staticDir = resolve(arg('static', 'EC2RA_STATIC_DIR', join(dirname(fileURLToPath(import.meta.url)), '..', 'renderer')))
  const token = loadToken(dataDir)
  initLog(join(dataDir, 'logs'))
  const log = (l: string): void => console.log(l)

  const gateway = createGatewayServer({ handlers, token, staticDir, rdpTarget: ensureProxy, log })
  setHost(createGatewayHost(dataDir, gateway.broadcast, log))

  if (!existsSync(join(staticDir, 'index.html'))) log(`[gateway] warning: no built UI at ${staticDir}; run \`pnpm build\` first (API only until then)`)
  const bound = await gateway.listen(port, host)
  log(`[gateway] data dir ${dataDir}`)
  log(`[gateway] listening on ${bound.host}:${bound.port}`)
  const hosts = bound.host === '0.0.0.0' || bound.host === '::'
    ? Object.values(networkInterfaces()).flat().filter((i) => i && !i.internal && i.family === 'IPv4').map((i) => i!.address)
    : [bound.host]
  for (const h of hosts) log(`[gateway] open  http://${h}:${bound.port}/#token=${token}`)
  log('[gateway] the token is in the URL fragment; the page stores it and drops it from the address bar')

  let closing = false
  const shutdown = (): void => {
    if (closing) return
    closing = true
    log('[gateway] shutting down')
    Promise.all([closeAllSsh(), closeAllSftp(), releaseAllRdp(), closeAllTunnels()])
      .then(() => stopProxy())
      .catch(() => undefined)
      .then(() => gateway.close())
      .finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((e: Error) => {
  console.error(`[gateway] failed to start: ${e.message}`)
  process.exit(1)
})

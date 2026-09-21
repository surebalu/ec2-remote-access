/**
 * Thin wrapper over the Tailscale CLI for "HTTPS via Tailscale" phone access: `tailscale serve` terminates TLS with
 * a Let's Encrypt certificate for this machine's tailnet name and forwards to the gateway on loopback.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { findBinary } from './util'

export interface TailscaleInfo {
  cli: string
  running: boolean
  /** MagicDNS name without the trailing dot, e.g. my-mac.tail1234.ts.net */
  dnsName?: string
  ips: string[]
  /** Domains the tailnet can issue certificates for; empty when HTTPS is not enabled in the admin console. */
  certDomains: string[]
}

const CANDIDATES = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/usr/bin/tailscale']

export function tailscaleCli(): string | null {
  return CANDIDATES.find((p) => existsSync(p)) ?? findBinary('tailscale')
}

function run(cli: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cli, args, { timeout: 20_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()))
      else resolve({ stdout, stderr })
    })
  })
}

export async function tailscaleInfo(): Promise<TailscaleInfo | null> {
  const cli = tailscaleCli()
  if (!cli) return null
  try {
    const { stdout } = await run(cli, ['status', '--json'])
    const st = JSON.parse(stdout) as { BackendState?: string; CertDomains?: string[] | null; Self?: { DNSName?: string; TailscaleIPs?: string[] } }
    return {
      cli,
      running: st.BackendState === 'Running',
      dnsName: st.Self?.DNSName?.replace(/\.$/, '') || undefined,
      ips: st.Self?.TailscaleIPs ?? [],
      certDomains: st.CertDomains ?? []
    }
  } catch {
    return { cli, running: false, ips: [], certDomains: [] }
  }
}

/** Publishes https://<dnsName>/ -> http://127.0.0.1:<port> on the tailnet (persistent until turned off). */
export async function serveEnable(cli: string, port: number): Promise<void> {
  try {
    await run(cli, ['serve', '--bg', '--yes', String(port)])
  } catch (e) {
    const msg = (e as Error).message
    if (/https|cert|MagicDNS|not enabled/i.test(msg)) {
      throw new Error(`Tailscale could not enable HTTPS: ${msg}. In the Tailscale admin console open DNS → HTTPS Certificates → Enable HTTPS, then try again.`)
    }
    throw new Error(`tailscale serve failed: ${msg}`)
  }
}

export async function serveDisable(cli: string): Promise<void> {
  try { await run(cli, ['serve', '--https=443', 'off']) } catch { /* nothing was served */ }
}

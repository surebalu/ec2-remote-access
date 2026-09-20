import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'

const candidates: Record<string, string[]> = {
  'session-manager-plugin': [
    '/usr/local/bin/session-manager-plugin',
    '/opt/homebrew/bin/session-manager-plugin',
    '/usr/local/sessionmanagerplugin/bin/session-manager-plugin'
  ],
  aws: ['/usr/local/bin/aws', '/opt/homebrew/bin/aws']
}

/** Packaged Electron apps get a minimal PATH, so probe well-known locations first, then the login shell. */
export function findBinary(name: string): string | null {
  for (const c of candidates[name] ?? []) if (existsSync(c)) return c
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const out = execFileSync(shell, ['-lic', `command -v ${name}`], { encoding: 'utf8', timeout: 5000 }).trim()
    if (out && existsSync(out.split('\n').pop()!)) return out.split('\n').pop()!
  } catch {
    /* ignore */
  }
  return null
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

let counter = 0
export function uid(prefix: string): string {
  counter += 1
  return `${prefix}-${Date.now().toString(36)}-${counter}`
}

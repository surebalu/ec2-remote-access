import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Host } from '../main/host'

/**
 * Host for the headless gateway: no windows, no dialogs, no clipboard. Broadcasts go to WebSocket clients, saved
 * passwords are sealed with AES-256-GCM under a key file in the data directory (mode 0600), and anything that would
 * need a native picker reports "cancelled" so the UI falls back gracefully.
 */
export function createGatewayHost(dataDir: string, broadcast: (channel: string, payload: unknown) => void, log: (l: string) => void): Host {
  mkdirSync(dataDir, { recursive: true })
  const keyFile = join(dataDir, 'gateway.key')
  const key = (): Buffer => {
    if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32), { mode: 0o600 })
    return readFileSync(keyFile)
  }
  return {
    broadcast,
    userDataDir: () => dataDir,
    async openExternal(url) {
      // The phone's browser is not on this machine; the UI shows the URL (SSO device code) so the user opens it there.
      log(`[gateway] open in your browser: ${url}`)
    },
    revealPath: () => undefined,
    async trashPaths(paths) {
      const trash = join(dataDir, 'trash')
      mkdirSync(trash, { recursive: true })
      for (const p of paths) renameSync(p, join(trash, `${Date.now()}-${basename(p)}`))
    },
    clipboardWrite: () => false,
    setThemeSource: () => undefined,
    pickPaths: async () => null,
    pickSavePath: async () => null,
    askQuestion: async (opts) => opts.defaultId ?? 0,
    encrypt(plain) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key(), iv)
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      return Buffer.concat([Buffer.from('gw1'), iv, cipher.getAuthTag(), body])
    },
    decrypt(buf) {
      if (buf.subarray(0, 3).toString() !== 'gw1') throw new Error('Not a gateway-encrypted credential')
      const decipher = createDecipheriv('aes-256-gcm', key(), buf.subarray(3, 15))
      decipher.setAuthTag(buf.subarray(15, 31))
      return Buffer.concat([decipher.update(buf.subarray(31)), decipher.final()]).toString('utf8')
    }
  }
}

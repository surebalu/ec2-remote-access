import { store } from './store'
import { host } from './host'
import type { StoredCredential } from '@shared/types'

/**
 * Per-instance RDP credentials, encrypted by the host (Electron safeStorage = macOS Keychain key; the gateway uses
 * its own key file). An entry another host wrote fails to decrypt and reads as "no saved password".
 */
type Blob = Record<string, string>

function all(): Blob {
  return store.get('credentials') ?? {}
}
function save(b: Blob): void {
  store.set('credentials', b)
}

export function getCredential(instanceKey: string): StoredCredential | null {
  const enc = all()[instanceKey]
  if (!enc) return null
  try {
    const json = host().decrypt(Buffer.from(enc, 'base64'))
    return JSON.parse(json) as StoredCredential
  } catch {
    return null
  }
}

export function setCredential(instanceKey: string, cred: StoredCredential): void {
  const enc = host().encrypt(JSON.stringify(cred))
  if (!enc) throw new Error('Secure storage is not available; password not saved.')
  const b = all()
  b[instanceKey] = enc.toString('base64')
  save(b)
}

export function deleteCredential(instanceKey: string): void {
  const b = all()
  delete b[instanceKey]
  save(b)
}

export function credentialKeys(): string[] {
  return Object.keys(all())
}

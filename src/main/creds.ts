import { safeStorage } from 'electron'
import { store } from './store'
import type { StoredCredential } from '@shared/types'

/** Per-instance RDP credentials, encrypted with the macOS Keychain-backed key via Electron safeStorage. */
type Blob = Record<string, string>

function all(): Blob {
  return (store.get('credentials' as never) as Blob | undefined) ?? {}
}
function save(b: Blob): void {
  store.set('credentials' as never, b as never)
}

export function getCredential(instanceKey: string): StoredCredential | null {
  const enc = all()[instanceKey]
  if (!enc) return null
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    const json = safeStorage.decryptString(Buffer.from(enc, 'base64'))
    return JSON.parse(json) as StoredCredential
  } catch {
    return null
  }
}

export function setCredential(instanceKey: string, cred: StoredCredential): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Keychain encryption is not available; password not saved.')
  const b = all()
  b[instanceKey] = safeStorage.encryptString(JSON.stringify(cred)).toString('base64')
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

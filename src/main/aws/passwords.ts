import { EC2Client, GetPasswordDataCommand } from '@aws-sdk/client-ec2'
import { privateDecrypt, constants } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { WindowsPasswordResult } from '@shared/types'
import ssh2 from 'ssh2'
const sshUtils = ssh2.utils
import { credentialsFor } from './credentials'
import { findInstance } from './inventory'
import { getSettings } from '../store'

export async function windowsPassword(instanceKey: string, pemFile?: string): Promise<WindowsPasswordResult> {
  const inst = findInstance(instanceKey)
  const pem = pemFile || getSettings().pemFile
  if (!pem) return { error: 'No key pair (.pem) file configured. Set it in Settings or pick one.' }
  let key: string
  try {
    key = readFileSync(pem, 'utf8')
  } catch (e) {
    return { error: `Cannot read ${pem}: ${(e as Error).message}` }
  }
  if (!/PRIVATE KEY/.test(key)) {
    return { error: `${pem} is not a private key (it looks like a ${/PUBLIC KEY/.test(key) ? 'public key' : 'non-key file'}). Choose the .pem downloaded when the key pair "${inst.keyName ?? '?'}" was created.` }
  }
  // Accept OpenSSH-format RSA keys too (ssh-keygen default) by converting to PEM.
  if (/OPENSSH PRIVATE KEY/.test(key)) {
    const parsed = sshUtils.parseKey(key)
    if (parsed instanceof Error) return { error: `Cannot parse ${pem}: ${parsed.message}` }
    const k = Array.isArray(parsed) ? parsed[0] : parsed
    if (k.type !== 'ssh-rsa') return { error: `EC2 password data is RSA-encrypted; ${pem} is ${k.type}.` }
    const pemOut = k.getPrivatePEM()
    if (!pemOut) return { error: `Cannot convert ${pem} to PEM (is it passphrase-protected?).` }
    key = pemOut
  }
  const ec2 = new EC2Client({ region: inst.region, credentials: credentialsFor(inst.profile) })
  try {
    const r = await ec2.send(new GetPasswordDataCommand({ InstanceId: inst.instanceId }))
    if (!r.PasswordData) {
      return { error: 'No password data available. The instance may use a custom AMI/domain login or the password was reset.' }
    }
    const plain = privateDecrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(r.PasswordData, 'base64'))
    return { password: plain.toString('utf8') }
  } catch (e) {
    const msg = (e as Error).message
    if (/decrypt|oaep|padding|key/i.test(msg)) {
      return { error: `Decrypt failed. Key pair for this instance is "${inst.keyName ?? 'unknown'}"; the selected .pem does not match. (${msg})` }
    }
    return { error: msg }
  } finally {
    ec2.destroy()
  }
}

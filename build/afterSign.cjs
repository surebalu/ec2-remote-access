/**
 * electron-builder afterSign hook.
 * With a Developer ID (CSC_LINK / CSC_NAME set) electron-builder signs and notarizes on its own.
 * Without one, sign locally: with the one "Apple Development" certificate in the keychain when there is one, else
 * ad-hoc. A certificate gives every build the same designated requirement, so macOS keeps what it was allowed
 * (the Keychain item behind saved passwords and sign-ins, Automation for reading a browser's page, the microphone)
 * across updates; an ad-hoc signature is new with every build, and macOS asked again after each install, holding
 * the app at start-up until someone answered. LOCAL_SIGN_IDENTITY names another identity, or '-' for ad-hoc.
 * Neither turns on the hardened runtime, so the app runs exactly as before.
 */
const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const path = require('node:path')

function localIdentity() {
  if (process.env.LOCAL_SIGN_IDENTITY) return process.env.LOCAL_SIGN_IDENTITY
  try {
    const out = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' })
    const names = [...new Set([...out.matchAll(/"(Apple Development: [^"]+)"/g)].map((m) => m[1]))]
    return names.length === 1 ? names[0] : '-'
  } catch {
    return '-'
  }
}

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const signed = !!(process.env.CSC_LINK || process.env.CSC_NAME || process.env.CSC_KEY_PASSWORD)
  if (signed) return
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const identity = localIdentity()
  // No timestamp: a development signature does not need Apple's timestamp server, and the build stays offline.
  const sign = (args) => execFileSync('codesign', ['--force', '--timestamp=none', '--sign', identity, ...args], { stdio: 'inherit' })
  // --deep signs nested bundles and helpers, not a bare executable in Contents/Resources: sign the native helpers
  // first, so the app's seal below covers their signed form. (With a Developer ID, electron-builder signs every Mach-O.)
  const helpers = [['dictation', 'ec2ra-dictate', 'dictate'], ['control', 'ec2ra-control', 'control']]
  for (const [dir, name, id] of helpers) {
    const bin = path.join(appPath, 'Contents', 'Resources', dir, name)
    if (existsSync(bin)) sign(['--identifier', `com.mainspring.ec2-remote-access.${id}`, bin])
  }
  console.log(`  • ${identity === '-' ? 'ad-hoc signing (no Developer ID or Apple Development certificate)' : `signing with ${identity}`}  app=${appPath}`)
  sign(['--deep', appPath])
}

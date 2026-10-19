/**
 * electron-builder afterSign hook.
 * With a Developer ID (CSC_LINK / CSC_NAME set) electron-builder signs and notarizes on its own.
 * Without one, apply an ad-hoc signature so the app launches cleanly on Apple Silicon after the user
 * clears Gatekeeper's quarantine (see README "Install").
 */
const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const path = require('node:path')

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const signed = !!(process.env.CSC_LINK || process.env.CSC_NAME || process.env.CSC_KEY_PASSWORD)
  if (signed) return
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  // --deep signs nested bundles and helpers, not a bare executable in Contents/Resources: sign the dictation helper
  // first, so the app's seal below covers its signed form. (With a Developer ID, electron-builder signs every Mach-O.)
  const dictation = path.join(appPath, 'Contents', 'Resources', 'dictation', 'ec2ra-dictate')
  if (existsSync(dictation)) execFileSync('codesign', ['--force', '--sign', '-', '--identifier', 'com.mainspring.ec2-remote-access.dictate', dictation], { stdio: 'inherit' })
  console.log(`  • ad-hoc signing (no Developer ID configured)  app=${appPath}`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
}

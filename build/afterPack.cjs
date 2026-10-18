/**
 * electron-builder afterPack hook (before signing): node-pty 1.1.0's prebuilt spawn-helper is published without the
 * execute bit, and without it no local terminal can start. main/localterm.ts fixes it at runtime too (development).
 */
const { chmodSync, existsSync, readdirSync } = require('node:fs')
const path = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const prebuilds = path.join(app, 'Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds')
  if (!existsSync(prebuilds)) return
  for (const dir of readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, dir, 'spawn-helper')
    if (existsSync(helper)) chmodSync(helper, 0o755)
  }
}

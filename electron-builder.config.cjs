/* eslint-disable @typescript-eslint/no-require-imports */
// Signing/notarization switch on automatically when the standard electron-builder env vars are present:
//   CSC_LINK (base64 or path to the Developer ID .p12), CSC_KEY_PASSWORD,
//   APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID   (for notarization)
// Auto-update feed: set UPDATE_URL (https://… where the release script uploads latest-mac.yml + zips).
const signed = !!(process.env.CSC_LINK || process.env.CSC_NAME)
const notarize = signed && !!(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID)
const updateUrl = process.env.UPDATE_URL

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.mainspring.ec2-remote-access',
  productName: 'EC2 Remote Access',
  copyright: `Copyright © ${new Date().getFullYear()} Surendra Balu`,
  directories: { buildResources: 'resources', output: 'dist' },
  files: ['out/**', 'package.json', '!**/*.map'],
  npmRebuild: false,
  asarUnpack: ['node_modules/ssh2/**'],
  afterSign: 'build/afterSign.cjs',
  mac: {
    category: 'public.app-category.developer-tools',
    icon: 'resources/icon.png',
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] }
    ],
    artifactName: '${productName}-${version}-${arch}.${ext}',
    hardenedRuntime: signed,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    notarize,
    ...(signed ? {} : { identity: null }),
    extendInfo: {
      NSAppleEventsUsageDescription: 'Used to launch Windows App and your terminal.',
      LSMinimumSystemVersion: '12.0'
    }
  },
  dmg: {
    sign: false,
    contents: [
      { x: 140, y: 190, type: 'file' },
      { x: 410, y: 190, type: 'link', path: '/Applications' }
    ],
    window: { width: 560, height: 380 }
  },
  publish: updateUrl ? [{ provider: 'generic', url: updateUrl, channel: 'latest' }] : undefined
}

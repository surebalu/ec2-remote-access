/* eslint-disable @typescript-eslint/no-require-imports */
// Signing/notarization switch on automatically when the standard electron-builder env vars are present:
//   CSC_LINK (base64 or path to the Developer ID .p12), CSC_KEY_PASSWORD,
//   APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID   (for notarization)
// Auto-update feed: set UPDATE_URL (https://… where the release script uploads latest-mac.yml + zips).
const signed = !!(process.env.CSC_LINK || process.env.CSC_NAME)
const notarize = signed && !!(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID)
const updateUrl = process.env.UPDATE_URL
const { existsSync } = require('node:fs')
// Built by scripts/build-native.sh; without Xcode's Swift compiler the app ships without dictation or window layouts.
const dictationHelper = 'build/native/ec2ra-dictate'
const controlHelper = 'build/native/ec2ra-control'
if (!existsSync(dictationHelper)) console.warn(`  • ${dictationHelper} is missing: packaging without voice dictation (run scripts/build-native.sh)`)
if (!existsSync(controlHelper)) console.warn(`  • ${controlHelper} is missing: packaging without window layouts or Mac calendars (run scripts/build-native.sh)`)
// AWS's Session Manager plugin per architecture (scripts/fetch-ssm-plugin.sh), used when none is installed.
const ssmPlugin = ['arm64', 'x64'].every((a) => existsSync(`build/native/ssm-${a}/session-manager-plugin`))
if (!ssmPlugin) console.warn('  • build/native/ssm-<arch> is missing: packaging without the Session Manager plugin (run scripts/fetch-ssm-plugin.sh)')
// The organization's AWS sign-in (start URL, session and profile names), made by scripts/make-company-config.mjs and
// never committed; with it the first run offers to sign in and set up the accounts. Without it the build is generic.
const company = 'build/company.json'
if (existsSync(company)) console.log(`  • including ${company} (first-run AWS sign-in)`)

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.mainspring.ec2-remote-access',
  productName: 'EC2 Remote Access',
  copyright: `Copyright © ${new Date().getFullYear()} Surendra Balu`,
  directories: { buildResources: 'resources', output: 'dist' },
  files: ['out/**', 'package.json', '!**/*.map'],
  npmRebuild: false,
  // node-pty's native module and its spawn-helper must be real files for the local terminals.
  asarUnpack: ['node_modules/ssh2/**', 'node_modules/node-pty/**'],
  // The menu-bar icon is read at run time (src/main/tray.ts), so it ships beside the app's resources, as does the
  // native helpers (src/main/electronHost.ts) that `pnpm dist` builds first with scripts/build-native.sh.
  extraResources: [
    { from: 'resources/trayTemplate.png', to: 'trayTemplate.png' },
    { from: 'resources/trayTemplate@2x.png', to: 'trayTemplate@2x.png' },
    ...(existsSync(dictationHelper) ? [{ from: dictationHelper, to: 'dictation/ec2ra-dictate' }] : []),
    ...(existsSync(controlHelper) ? [{ from: controlHelper, to: 'control/ec2ra-control' }] : []),
    ...(ssmPlugin ? [{ from: 'build/native/ssm-${arch}', to: 'ssm' }] : []),
    ...(existsSync(company) ? [{ from: company, to: 'company.json' }] : [])
  ],
  afterPack: 'build/afterPack.cjs',
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
      NSAppleEventsUsageDescription: 'Used to launch Windows App and your terminal, and to read the address of the page your browser shows when you save it to Links.',
      // Voice dictation: macOS shows these when it first asks; the helper's access counts as the app's.
      NSMicrophoneUsageDescription: 'Voice dictation listens to the microphone only while you hold the dictation key or a mic button is on.',
      NSSpeechRecognitionUsageDescription: 'Voice dictation turns what you say into text, on this Mac when macOS supports your language.',
      // The Calendar's "Calendars on this Mac" (the ec2ra-control helper reads them; its access counts as the app's).
      NSCalendarsFullAccessUsageDescription: 'Shows the events of the calendars on this Mac (Google Workspace, iCloud, Exchange) in the app’s Calendar.',
      NSCalendarsUsageDescription: 'Shows the events of the calendars on this Mac (Google Workspace, iCloud, Exchange) in the app’s Calendar.',
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

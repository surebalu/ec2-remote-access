# Releasing to the public: checklist

The app already builds signed-ready DMGs for Apple silicon and Intel, updates itself from an HTTPS feed, sends no telemetry, and explains itself on first launch. These are the decisions and chores left before strangers download it, roughly in the order they block a release.

## 1. Name and identity (decide first; changing later costs a data migration)

- **The name contains "EC2".** "Amazon EC2" and "AWS" are Amazon trademarks. AWS's trademark guidelines allow describing compatibility ("for Amazon EC2", "works with AWS"), but not using its marks as or inside a product name. A public release should have its own name, with "for Amazon EC2" in the subtitle and on the website.
- **Bundle ID** is `com.mainspring.ec2-remote-access` (`electron-builder.config.cjs` → `appId`). Use an ID under a domain you own, e.g. `me.surendrabalu.<name>`, which matches the iOS app (`me.surendrabalu.EC2Remote`). Notifications permission, the Dock and auto-update all key off it, so set it once before the first public build.
- **Data folder.** Electron stores everything under `~/Library/Application Support/<productName>`. Renaming the product moves that folder, so existing users (your team) would lose settings, saved boards, terminal layouts and favorites unless the first launch copies the old folder across. Add that copy step (in `src/main/index.ts`, before `initLog`) in the same release as the rename.
- **Keychain.** Saved RDP passwords use Electron `safeStorage`, which ties a Keychain item to the app name and code signature. After a rename or the first Developer ID-signed build, macOS asks once to allow access; that is expected.

## 2. Signing and notarization (required: unsigned downloads are blocked by Gatekeeper)

- Your paid Apple Developer Program team (the one used for the iOS app) can create a **Developer ID Application** certificate (developer.apple.com → Certificates → +). Export it as `.p12`.
- Set `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` (appleid.apple.com → App-Specific Passwords) and `APPLE_TEAM_ID`, then `pnpm dist`. `electron-builder.config.cjs` turns on the hardened runtime and notarization automatically. See README → Release / distribution.
- Check the result: `spctl -a -vvv -t install "dist/<name>-<version>-arm64.dmg"` should say *accepted, source=Notarized Developer ID*. The native pieces (`node-pty`'s `spawn-helper`, `ssh2`) are signed with the app because electron-builder signs every Mach-O file in the bundle, unpacked ones included.
- The Mac App Store is not a realistic channel: its sandbox forbids running `session-manager-plugin`, reading `~/.aws`, and the local shells. Ship a direct download.

## 3. Updates and downloads

- **Feed:** `UPDATE_URL` + `scripts/release.sh --publish` already upload `latest-mac.yml` and the zips to S3. For the public, put CloudFront (or Cloudflare) in front of the bucket so the URL is stable, cached and HTTPS. GitHub Releases also works (`publish: { provider: 'github' }`) if the repository becomes public.
- **Download page:** a page on your site (surendrabalu.me already runs on Cloudflare Pages) with the DMG links for Apple silicon and Intel, the requirements (macOS 12+, the Session Manager plugin for private instances), screenshots, and the privacy statement.
- **Release notes:** electron-updater shows nothing by itself; keep a CHANGELOG and link it from the update dialog (`src/main/updater.ts`).

## 4. Legal

- **License.** `package.json` says `MIT` and `private: true`, and there is no LICENSE file. Decide: open source (add `LICENSE` with MIT or Apache-2.0 text) or closed source (change the field to `UNLICENSED` and write terms of use).
- **Third-party notices.** The app bundles Electron (MIT, includes Chromium's licenses), IronRDP (MIT/Apache-2.0), xterm.js, node-pty, ssh2, CodeMirror, React, zustand, marked, perfect-freehand (all MIT), DOMPurify (MPL-2.0 or Apache-2.0) and the AWS SDK (Apache-2.0). Generate a notices file (e.g. `npx license-checker --production --plainVertical > THIRD_PARTY_NOTICES.txt`) and ship it in the app (Settings → About can link to it).
- **Privacy policy.** Settings → About already states the facts: no analytics or crash reporting; network traffic only to AWS, the hosts you connect to, pages opened in the built-in browser, and the update server; credentials stay in `~/.aws`. Publish the same text as the privacy policy on the download page, and keep it true when adding features.

## 5. Product polish still worth doing

- **Crash reports:** none today. If you want them, make them opt-in (an off-by-default switch in Settings → About) and say so in the privacy policy; Electron's `crashReporter` can post minidumps to a self-hosted endpoint.
- **Accessibility:** most controls have labels, the rail and dialogs work from the keyboard, and focus rings follow the accent. Run VoiceOver over the hosts table, the connect dialog and Settings before release.
- **Localization:** English only. Strings are inline in the components; extracting them is a separate project.
- **Support:** an issue tracker or support address on the download page, and tell users to attach logs from Settings → About → Logs.
- **Company-specific bits:** none are user-facing anymore; `scripts/install-ssm-agent.sh` is an internal ops helper and can stay out of public builds (it is not packaged).

## 6. iPhone and iPad app

- It pairs with a Mac running the app (or a self-hosted gateway), which App Review will ask about: provide a demo gateway and pairing link in the review notes, and explain that the app is a remote client for the user's own computer.
- It needs its own name and screenshots consistent with the Mac app's, and the same privacy statement. `ios/archive.sh` uploads to App Store Connect; switch off `INTERNAL_ONLY` for external TestFlight or release.

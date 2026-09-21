# EC2 Remote Access

A macOS (Apple Silicon) desktop app that scans all of your AWS accounts for EC2 instances and opens **SSH** (embedded terminal) or **RDP** (Windows App) sessions to them. Everything talks to AWS directly: public IP when reachable, otherwise **AWS Systems Manager Session Manager**. No third-party relay.

## Features

- Reads every profile from `~/.aws/config` / `~/.aws/credentials` (SSO and static). One-click `aws sso login` when a token has expired.
- Scans each profile's region (optionally extra regions or all enabled regions) in parallel; inventory is cached so the app opens instantly.
- Shows name, account, OS, state, IPs, type and a **route badge**: `SSM`, `Direct`, or `Unreachable` (private IP and no online SSM agent).
- **SSH** in an embedded xterm.js terminal, authenticating with your SSH agent (1Password by default) or a key file. Or open the same session in Warp / Terminal / iTerm.
- **Terminal colour schemes and font**: the panel button at the right of an SSH tab's toolbar opens an appearance pane with theme cards (click to apply live) and a font section; the same options are in Settings → Terminal. Offers Dracula, One Dark, Tokyo Night, Catppuccin Mocha, Nord, Gruvbox, Monokai, Solarized (dark/light), GitHub (dark/light) and One Light, plus any installed monospace font (Monaco by default) and size. Changes apply to open tabs immediately. A colour scheme only sets the palette; servers with a plain prompt still print plain text, so **Settings → Run after connect** can send a line to every new SSH shell (a one-click preset sets a green/blue `PS1` and `ls --color`), overridable per host in the connect dialog.
- **RDP inside the app**: desktops open as tabs next to your SSH tabs (Royal TSX style), rendered by the IronRDP web client (the engine behind Devolutions Remote Desktop Manager). A tiny local proxy in the app's main process speaks IronRDP's RDCleanPath handshake and relays bytes over TLS straight to the instance, through an SSM port-forward when the host is private. Passwords can be pulled from EC2 (`GetPasswordData`) and saved per instance in the macOS Keychain via Electron `safeStorage`. "Windows App" remains available as a hand-off to Microsoft's client.
- **Refresh token** button runs `aws sso login --sso-session <name>` (same as an `aws-login` alias), then re-checks every account and rescans.
- **Windows password**: fetches `GetPasswordData` and decrypts it locally with your key pair `.pem`.
- Start / stop instances, copy IPs and SSM CLI commands, per-host overrides (user, port, forced route, key).
- **Quick switcher (`⌘K`)**: search hosts and open sessions by name, IP, account, region or tag. Recent successful connections and favorites appear first. Use arrow keys and Enter to connect/switch, or Shift+Enter for host details.
- **Host details**: click a host name to inspect tags, network identifiers, AMI, SSM status, connection options, and the last successful scan. Click a value to copy it.
- Filters stay above the host table when the sidebar is collapsed. Selecting a host in the sidebar clears conflicting filters and reveals its group.
- Failed account/region scans preserve the last known hosts with a **Cached** badge and a retry action. Successful empty scans still remove hosts that are no longer present.
- Disconnected SSH tabs retain their output and offer **Reconnect**, **Edit connection**, and **Copy message**.
- SFTP transfers offer **Keep both / Skip / Replace** when the destination exists. Files are transferred to temporary siblings and published only after completion; cancellation leaves existing destination files intact. Replacing remote files requires the server's OpenSSH atomic-rename extension. If unavailable, use Keep both. A lost connection can leave a hidden `.part` file for later cleanup.

## Adding AWS accounts (for teammates)

Click **+** next to *Accounts* (or the welcome screen on a fresh install):

- **IAM Identity Center (SSO)** — enter the organization start URL and SSO region, approve the device code in the browser, then tick the accounts/roles you want. The app writes standard `[sso-session]` / `[profile]` blocks to `~/.aws/config` and a CLI-compatible token cache, so the AWS CLI works with the same profiles. No AWS CLI needed.
- **Access keys** — for an IAM user; written to `~/.aws/credentials`.

The pencil on an account row renames it, sets its environment label/color and one-click SSH defaults, or removes it from `~/.aws`.

### Session expiry

The login stores a refresh token, so the SDK silently renews the access token for as long as Identity Center allows. When renewal is no longer possible, the app shows a banner at launch ("AWS session expired") and, mid-session, warns ten minutes before expiry or as soon as an operation fails with an auth error. **Sign in** / **Refresh token** runs the device flow again and shows the code in-app. Open SSH and RDP sessions are not affected by token expiry.

## Requirements

- macOS on Apple Silicon.
- [session-manager-plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html) (`brew install --cask session-manager-plugin`).
- AWS CLI v2 is optional (only used as a fallback for legacy SSO profiles without an `sso-session`).
- [Windows App](https://apps.apple.com/app/windows-app/id1295203466) for RDP.
- For private instances: the instance needs the SSM agent running and an instance profile with `AmazonSSMManagedInstanceCore`. Instances without this show as **Unreachable**.

## Development

```bash
pnpm install
pnpm dev          # hot-reloading Electron app
pnpm typecheck
pnpm test         # inventory/transfer regression tests; Node with TypeScript stripping support
pnpm build
pnpm test:ui      # isolated Electron renderer checks and screenshots; run after build
```

The UI smoke test uses synthetic hosts, temporary app data, and blocked network requests. It does not load your AWS configuration or open real remote sessions. Screenshots are saved to a temporary directory printed by the test.

## Install (teammates)

1. Download `EC2 Remote Access-<version>-arm64.dmg` (Apple Silicon) or `-x64.dmg` (Intel Mac).
2. Open the DMG and drag **EC2 Remote Access** to Applications.
3. First launch. If the build is **not notarized** (no Developer ID yet), macOS will refuse to open it because it was downloaded. Either:
   - open **System Settings → Privacy & Security**, scroll down and click **Open Anyway**, or
   - run once in Terminal: `xattr -dr com.apple.quarantine "/Applications/EC2 Remote Access.app"`
   A notarized build opens without either step.
4. Install the [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html) (`brew install --cask session-manager-plugin`) for private instances. The welcome screen checks for it.
5. Click **Add AWS account** → **IAM Identity Center** and sign in with the company start URL. Done.

## Release / distribution

```bash
pnpm dist                      # DMG + zip for arm64 and x64 in dist/ (ad-hoc signed if no Developer ID)
scripts/release.sh --bump patch    # bump version, typecheck, build
```

**Signing & notarization** switch on automatically when the standard electron-builder variables are present:

```bash
export CSC_LINK=~/certs/developer-id.p12  CSC_KEY_PASSWORD=…          # Developer ID Application certificate
export APPLE_ID=you@company.com APPLE_APP_SPECIFIC_PASSWORD=… APPLE_TEAM_ID=XXXXXXXXXX
pnpm dist
```

With those set the app is signed with the hardened runtime (`build/entitlements.mac.plist`), notarized by Apple, and opens on any Mac without warnings. This needs an Apple Developer Program membership ($99/year).

**Auto-update** (requires a signed build): host the artifacts on any HTTPS location, e.g. an S3 bucket:

```bash
UPDATE_URL=https://<bucket>.s3.us-west-1.amazonaws.com/ec2-remote-access \
S3_URI=s3://<bucket>/ec2-remote-access AWS_PROFILE=<profile> \
scripts/release.sh --bump minor --publish
```

The app built with `UPDATE_URL` checks that feed at launch and every six hours, downloads in the background, and offers a restart. Builds made without `UPDATE_URL` never phone home.

## Phone access

The same UI can be used from a phone or tablet browser while the Mac app is running, without a relay service.

1. Install [Tailscale](https://tailscale.com/download) on the Mac and the phone and sign both into your tailnet (optional but recommended; Wi-Fi works too).
2. **Settings → Phone access → Let my phone use this app while it is running.** The app starts a small server (port 8321 by default) and shows a QR code.
3. Scan the QR code with the iPhone camera and add the page to the Home Screen. The link carries the access token and the Home Screen bookmark keeps it, so treat the link like a password; **Rotate token** invalidates every paired phone.

**Reachable from** picks how the phone connects:

- **HTTPS via Tailscale (recommended)**: the app listens on loopback only and runs `tailscale serve` so the phone opens `https://<your-mac>.<tailnet>.ts.net` with a real certificate. One-time prerequisite: in the Tailscale admin console, DNS tab, enable MagicDNS and **HTTPS Certificates**; the app tells you if that is missing. Turning phone access off withdraws the serve entry.
- **Tailscale IP, plain HTTP**: binds the 100.x address only. Traffic is still WireGuard-encrypted between tailnet devices.
- **Any network this Mac is on, plain HTTP**: also reachable over Wi-Fi. Use only on networks you trust, since the token travels in clear text there.

Security model: only devices in your tailnet can reach the port at all, every WebSocket needs the token, browser upgrades must come from the gateway's own origin, and the Settings row lists connected client addresses. A phone holding the token can do everything the app can, so treat the link like your AWS password. The switch is remembered and the server starts with the app. AWS credentials and SSO tokens never leave the Mac. Sessions a phone opened are closed when it disconnects. Limitations: file pickers and the SFTP overwrite prompt appear on the Mac, not the phone, and Windows App hand-off is desktop-only.

### Standalone gateway (always-on host)

The same server also runs without Electron, e.g. on a small EC2 instance, for access when the Mac is asleep:

```bash
pnpm build:gateway                       # builds the UI and out/gateway/index.js
pnpm gateway -- --host 0.0.0.0           # listens on :8321; prints a URL with the access token
```

Open the printed `http://<ip>:8321/#token=…` on the phone. On a Mac it shares the desktop app's settings, inventory cache and token; on Linux it uses `~/.config/ec2-remote-access` (or `--data-dir`). Options: `--host`, `--port`, `--data-dir`, `--token`, `--static` (or `EC2RA_GATEWAY_HOST/PORT/TOKEN`, `EC2RA_DATA_DIR`). Headless differences: pickers report cancelled, SFTP conflicts default to *Keep both*, "local" file browsing shows the gateway machine, and saved RDP passwords are sealed with a key file in the data dir rather than the Keychain.

## How connections work

| Situation | SSH | RDP |
|---|---|---|
| SSM agent online | SDK `StartSession` (`AWS-StartSSHSession`) → `session-manager-plugin` stdio → ssh2 | `AWS-StartPortForwardingSession` → `localhost:<random>` → local RDCleanPath proxy → IronRDP tab (or Windows App) |
| Public IP, no SSM | direct TCP :22 | direct :3389 → local RDCleanPath proxy → IronRDP tab (or Windows App) |
| Private IP, no SSM | Unreachable (onboard SSM) | Unreachable |

By default SSM is preferred when both exist because public IPs are usually behind security groups that don't allow your IP. Flip **Settings → Auto route** to prefer public IPs.

## Troubleshooting

- **Log file**: `~/Library/Logs/EC2 Remote Access/main.log` (the standalone gateway writes `<data-dir>/logs/main.log`). It records SSM plugin output and exits, tunnel lifecycle, and for every embedded RDP connection the open/close with bytes transferred and how long the server had been silent.
- **Copy diagnostics** in an RDP tab's toolbar copies that tab's events plus the matching log lines, ready to paste into an issue.
- **RDP freezes after being idle**: Session Manager ends port-forwarding sessions after its *idle session timeout* (Systems Manager → Session Manager → Preferences). The proxy keeps TCP keepalive on the tunnel and cuts a relay after 30 seconds of unanswered input, so the tab's automatic reconnect opens a fresh tunnel instead of leaving a frozen desktop. If the SSO token also expired during the session, the RDP tab shows **Sign in** and reconnects on its own once you have signed in, rather than giving up. Raising the idle timeout (up to 60 minutes) reduces how often this happens.

## Data locations

- Settings, inventory cache, per-host overrides: `~/Library/Application Support/EC2 Remote Access/ec2-remote-access.json`
- Generated `.rdp` files: `~/Library/Application Support/EC2 Remote Access/rdp/`
- Warp launch config used for "Open in Warp": `~/.warp/launch_configurations/ec2-remote-access.yaml`

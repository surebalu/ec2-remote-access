# EC2 Remote Access

A macOS (Apple Silicon) desktop app that scans all of your AWS accounts for EC2 instances and opens **SSH** (embedded terminal) or **RDP** (Windows App) sessions to them. Everything talks to AWS directly: public IP when reachable, otherwise **AWS Systems Manager Session Manager**. No third-party relay.

## Features

- Reads every profile from `~/.aws/config` / `~/.aws/credentials` (SSO and static). One-click `aws sso login` when a token has expired.
- Scans each profile's region (optionally extra regions or all enabled regions) in parallel; inventory is cached so the app opens instantly.
- Shows name, account, OS, state, IPs, type and a **route badge**: `SSM`, `Direct`, or `Unreachable` (private IP and no online SSM agent).
- **SSH** in an embedded xterm.js terminal, authenticating with your SSH agent (1Password by default) or a key file. Or open the same session in Warp / Terminal / iTerm.
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

## How connections work

| Situation | SSH | RDP |
|---|---|---|
| SSM agent online | SDK `StartSession` (`AWS-StartSSHSession`) → `session-manager-plugin` stdio → ssh2 | `AWS-StartPortForwardingSession` → `localhost:<random>` → local RDCleanPath proxy → IronRDP tab (or Windows App) |
| Public IP, no SSM | direct TCP :22 | direct :3389 → local RDCleanPath proxy → IronRDP tab (or Windows App) |
| Private IP, no SSM | Unreachable (onboard SSM) | Unreachable |

By default SSM is preferred when both exist because public IPs are usually behind security groups that don't allow your IP. Flip **Settings → Auto route** to prefer public IPs.

## Data locations

- Settings, inventory cache, per-host overrides: `~/Library/Application Support/EC2 Remote Access/ec2-remote-access.json`
- Generated `.rdp` files: `~/Library/Application Support/EC2 Remote Access/rdp/`
- Warp launch config used for "Open in Warp": `~/.warp/launch_configurations/ec2-remote-access.yaml`

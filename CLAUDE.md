# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**EC2 Remote Access**: a macOS Electron app that scans every AWS profile in `~/.aws` for EC2 instances and opens SSH (embedded xterm.js), SFTP, and RDP (embedded IronRDP web client) sessions to them. Connections go to AWS directly, either to a public IP or through **SSM Session Manager**; there is no relay service. See `README.md` for the user-facing feature list, install steps, and the routing table.

## Commands

```bash
pnpm install                 # pnpm 11 workspace; native builds gated by pnpm-workspace.yaml allowBuilds
pnpm dev                     # electron-vite dev with HMR (main/preload rebuild + renderer hot reload)
pnpm typecheck               # tsc -p tsconfig.node.json && tsc -p tsconfig.web.json (two separate projects)
pnpm test                    # node --test over tests/*.test.ts (runs .ts directly via --experimental-strip-types)
node --experimental-strip-types --test tests/transfers.test.ts   # a single test file
pnpm build                   # electron-vite build -> out/
pnpm test:ui                 # Electron smoke test of the built renderer with synthetic hosts; run after pnpm build
pnpm dist                    # build + electron-builder DMG/zip for arm64 and x64 -> dist/
pnpm dist:arm64              # arm64 only (faster local packaging)
scripts/release.sh --bump patch [--publish]   # bump, typecheck, build; --publish uploads to S3 (needs UPDATE_URL, S3_URI)
```

No linter is configured. `pnpm typecheck` is the gate `scripts/release.sh` runs before building; run it after touching `src/shared/` since both tsconfig projects include that directory.

Tests live in `tests/` and use Node's built-in runner with no transpile step, so test files import source as `../src/.../file.ts` (explicit `.ts` extension) and can only cover code with no Electron or DOM imports: currently `src/shared/inventoryMerge.ts` and the SFTP `safeTransfer`/`destinations` modules. `tests/ui-smoke.cjs` launches Electron against `out/renderer` with a stub preload (`tests/ui-preload.cjs`), blocks network requests, uses a temp app-data dir, and writes screenshots to a temp directory it prints. It never reads `~/.aws` or opens real sessions.

Dev-only env vars read in `src/main/index.ts`: `RDP_DEBUG_PORT` enables Chromium remote debugging when running under `pnpm dev`.

## Build layout and constraints

- **electron-vite** with three entries: `src/main` (ESM output), `src/preload` (CJS output, loaded as `out/preload/index.cjs`), `src/renderer` (React 19 + Tailwind 4 via `@tailwindcss/vite`).
- **Every runtime dependency is externalized** in `electron.vite.config.ts` (the whole `dependencies` list plus `cpu-features` and `electron-updater`), so main/preload never bundle node_modules. A new runtime dep must go in `dependencies`, not `devDependencies`, or the packaged app won't find it.
- `ssh2` is unpacked from asar (`asarUnpack` in `electron-builder.config.cjs`) and its optional native `cpu-features` build is disabled in `pnpm-workspace.yaml`. Keep it that way; `npmRebuild` is off.
- Path aliases: `@shared/*` → `src/shared/*` (all three entries), `@/*` → `src/renderer/*` (renderer only). Both tsconfigs mirror these.
- TypeScript 7 with `moduleResolution: Bundler`. `tsconfig.node.json` covers main + preload + shared + the vite config; `tsconfig.web.json` covers renderer + shared + `src/preload/index.d.ts`.
- Signing/notarization/auto-update switch on purely from env vars (`CSC_LINK`, `APPLE_ID`, `APPLE_TEAM_ID`, `UPDATE_URL`); with none set, `build/afterSign.cjs` ad-hoc signs and the updater stays inert.

## Architecture

### Process boundary and the IPC contract

`src/shared/ipc.ts` is the single source of truth for main ↔ renderer communication:

- `IpcApi`: request/response channels (`ipcRenderer.invoke`). Naming is `domain:verb` (`ssh:open`, `sftp:list`, `rdp:prepare`, `creds:get`, ...).
- `IpcEvents`: push channels main → renderer (`scan:progress`, `ssh:event`, `sftp:transfer`, `tunnels:changed`, `profiles:status`, `instances:updated`).

The preload (`src/preload/index.ts`) exposes exactly two typed functions on `window.api`: `invoke(channel, ...args)` and `on(channel, cb)` (returns an unsubscribe), plus `pathForFile` for Finder drops. The main side registers every handler in `src/main/ipc.ts` through a typed `handle()` wrapper that logs and rethrows errors, and pushes events with a `send()` helper that broadcasts to all windows.

**To add a channel**: declare it in `IpcApi`/`IpcEvents`, add the handler in `src/main/ipc.ts`, call it from the renderer via `window.api.invoke(...)`. Types in `src/shared/types.ts` are shared by both sides; the renderer never imports from `src/main`.

### Main process (`src/main`)

- `aws/`: `profiles.ts` parses `~/.aws/config` + `credentials`; `awsfiles.ts` does INI section read/write for those files; `credentials.ts` caches a per-profile SDK credential provider (SSO profiles resolve via `fromSSO`, static via `fromIni`, deliberately matching AWS CLI precedence, not the JS SDK default) and classifies auth errors into `login-required` vs `error`; `sso.ts` implements the IAM Identity Center device-code flow without the AWS CLI and writes a CLI-compatible token cache; `inventory.ts` scans EC2 + SSM `DescribeInstanceInformation` per profile/region and keeps the in-memory instance list (`findInstance(key)`); results are folded in through `src/shared/inventoryMerge.ts`, which keeps the last known hosts for a profile/region whose scan failed (marked `staleReason`/`lastSeenAt`, shown as a Cached badge) while a successful empty scan still removes vanished hosts; `inventory:scan` accepts `retryTargets` to rescan just the failed profile/regions; `passwords.ts` decrypts `GetPasswordData` with a local `.pem`.
- `store.ts`: `electron-store` with `settings` and `inventory` keys. `defaultSettings` is merged over stored settings on every `getSettings()`, so adding a setting means adding a default there and a field in `Settings`.
- `connect/route.ts`: `decideRoute(inst, force)` picks `ssm | direct | unreachable | not-running` from per-host overrides, the `preferDirect` setting, `ssmOnline`, and IPs. Also resolves default SSH/RDP user and identity file with precedence explicit > host override > account (`profileDefaults`) > global. All connect paths (SSH, SFTP, RDP, external terminal) funnel through this.
- `ssm/session.ts`: starts an SSM session with the SDK, then spawns `session-manager-plugin` with the same argv the AWS CLI uses and wraps its stdio in a `Duplex`. `startSshStream` (document `AWS-StartSSHSession`) feeds ssh2's `sock` option; `startPortForward` (`AWS-StartPortForwardingSession`) backs RDP tunnels.
- `ssh/session.ts` + `ssh/clients.ts`: ssh2 shell sessions keyed by session id, streaming to the renderer via `ssh:event`. `clients.ts` is a registry of live ssh2 clients so an SFTP tab can reuse an already-authenticated SSH connection to the same host/user (and vice versa) instead of logging in again.
- `sftp/session.ts` + `localfs.ts`: SFTP browsing and a transfer queue (progress pushed via `sftp:transfer`), plus the local-filesystem half of the dual-pane Files tab. `sftp/safeTransfer.ts` writes every transfer to a temporary sibling and publishes it only on completion, refusing an existing destination unless the user chose Replace (Keep both / Skip / Replace conflict flow); `sftp/destinations.ts` provides the local and remote `TransferDestination` implementations. Remote Replace needs the OpenSSH `posix-rename` extension and fails without unlinking otherwise.
- `rdp/`: `cleanpath.ts` is a localhost WebSocket gateway implementing IronRDP's **RDCleanPath** handshake (X.224 forward, TLS to the target, hand the cert chain back, then relay bytes). `sessions.ts` (`prepareRdp`) resolves the route, opens an SSM port-forward if needed, registers a one-time token with the proxy, and returns a `ws://` URL the renderer's IronRDP component connects to. `launcher.ts` is the alternative hand-off to Microsoft Windows App via a generated `.rdp` file. `der.ts` is minimal ASN.1 DER helpers for the handshake.
- `tunnels.ts`: registry of SSM port-forward tunnels shown in the renderer's `TunnelBar`; broadcasts `tunnels:changed`.
- `creds.ts`: per-instance RDP credentials encrypted with Electron `safeStorage` (Keychain-backed).
- `index.ts`: window creation, and a `before-quit` hook that closes all SSH/SFTP/RDP sessions and tunnels and stops the proxy before actually quitting. Any new long-lived resource type needs a `closeAll*` added there.

### Renderer (`src/renderer`)

- One zustand store, `store.ts` (`useStore`), holds all app state: profiles/statuses, instances, scan progress, tunnels, open `tabs` (kind `ssh | rdp | sftp`), filters, and which dialog is open. Actions that touch main live on the store and call `window.api.invoke`. `allInstances(state)` merges AWS instances with manual hosts.
- The store's `init()` subscribes to `IpcEvents` (`window.api.on`) and maps them into state; `quickConnect.ts` holds the one-click openers (double-click → RDP for Windows, SSH otherwise) that skip the connect dialog when overrides/saved creds make the parameters known.
- `QuickSwitcher` (⌘K) searches hosts with `src/shared/hostSearch.ts` (`matchesHost` covers name, IPs, account, region, tags), lists recent successful connections and favorites first, and either opens a session via `quickConnect.ts` or switches to an already-open tab. `HostFilters` and `HostDetails` are the filter bar and the per-host inspector; `clearHostFilters` in `hostSearch.ts` is the patch applied when selecting a host that current filters would hide.
- Terminal appearance comes from `Settings.terminalTheme` / `terminalFont` / `terminalFontSize`, resolved by `src/renderer/terminalThemes.ts` (`TERMINAL_THEMES` catalog of xterm `ITheme` palettes; `'auto'` follows the app light/dark mode). `TerminalTab` applies changes to a live terminal through `term.options`, so a new scheme only needs an entry in the catalog.
- Session tabs: `TerminalTab` (xterm.js over `ssh:*`; on disconnect it keeps the buffer and offers Reconnect, which re-runs the same connect parameters, plus Edit connection), `SftpTab`, `RdpTab` (the `@devolutions/iron-remote-desktop` web component + wasm backend; wasm is initialized once, with auto-reconnect back-off and a fatal-error table for IronRDP error kinds).
- Manual (non-AWS) hosts are modelled as `Instance` objects via `src/shared/manual.ts` (`manualToInstance`, key `manual/<id>`, profile `servers`) so tables, routing and connect dialogs treat them uniformly; their connection settings live in `Settings.overrides[key]`.

### Identity keys

An instance's `key` is `${profile}/${region}/${instanceId}` (or `manual/<id>`). It indexes `Settings.overrides`, `favorites`, saved credentials, and every IPC call that names a host. Don't use `instanceId` alone; the same instance can appear under two profiles.

## Conventions worth knowing

- Comments in the code explain *why* a non-obvious choice was made (CLI-vs-SDK credential precedence, why ssh2 is externalized, IronRDP error kinds). Keep that style; skip comments that restate the code.
- Errors thrown from main handlers reject the renderer's `invoke` and are shown via `toast('error', ...)` by the calling action; throw `Error` with a user-readable message (see the `session-manager-plugin not found` message in `ssm/session.ts` for the tone).
- The special error message `'cancelled'` is treated as expected by the IPC wrapper (a superseded in-flight connect) and is not logged.
- `scripts/install-ssm-agent.sh` is an ops helper for onboarding private RHEL hosts onto SSM through a bastion; it is unrelated to the app build.

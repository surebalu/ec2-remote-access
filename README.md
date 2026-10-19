# EC2 Remote Access

A macOS (Apple Silicon) desktop app that scans all of your AWS accounts for EC2 instances and opens **SSH** (embedded terminal) or **RDP** (Windows App) sessions to them. Everything talks to AWS directly: public IP when reachable, otherwise **AWS Systems Manager Session Manager**. No third-party relay.

## Features

- **Layout**: a rail down the left holds the app's sections (**Hosts**, **Overview** of all open sessions, and the built-in **Terminal**, **Browser**, **Notes** and **Whiteboard**, each with a dot while open), with Shortcuts, Light / Dark / Auto and **Settings** (`⌘,`) at the bottom. The title bar holds only your remote session tabs, a sidebar toggle (`⌘B` hides the hosts sidebar) and a search field for `⌘K`.
- **Text size** of the hosts sidebar and the hosts list, each on its own: point at one and press `⌘+` / `⌘−`, or use **Aa** at the bottom of the sidebar (or Settings → General). The whole window still zooms from View → Zoom.
- **App font** (Settings → General): Monaco by default for every label, menu and list; SF Mono, Menlo, San Francisco, Helvetica Neue or Avenir Next instead. Notes and terminals keep their own font settings; whiteboard text uses the app font.
- **Colour themes** (Settings → General → Colour theme, the Theme button at the bottom of the rail, or `⌘K` → Theme): repaint the whole app in Cyber Wave, Dracula, Tokyo Night, Catppuccin Mocha, Nord, One Dark, Gruvbox, Monokai, Solarized, GitHub or One Light, or keep the default colours with Auto / Light / Dark. A theme sets light or dark by itself and the terminals switch to its colour scheme (choosing any main theme, Auto / Light / Dark included, puts the terminal scheme back on *Match app*; pick another scheme under Settings → Terminal afterwards if you want them to differ), and Cyber Wave's teal-to-black fade runs down the rail and side panels too. Every theme keeps body text at 7.5:1 contrast or better.
- Reads every profile from `~/.aws/config` / `~/.aws/credentials` (SSO and static). One-click `aws sso login` when a token has expired.
- Scans each profile's region (optionally extra regions or all enabled regions) in parallel; inventory is cached so the app opens instantly.
- Shows name, account, OS, state, IPs, type and a **route badge**: `SSM`, `Direct`, or `Unreachable` (private IP and no online SSM agent).
- **SSH** in an embedded xterm.js terminal, authenticating with your SSH agent (1Password by default) or a key file. Or open the same session in Warp / Terminal / iTerm.
- **Terminal colour schemes and font**: the panel button at the right of an SSH tab's toolbar opens an appearance pane with theme cards (click to apply live) and a font section; the same options are in Settings → Terminal. Offers Dracula, One Dark, Tokyo Night, Catppuccin Mocha, Nord, Gruvbox, Monokai, Solarized (dark/light), GitHub (dark/light) and One Light, plus any installed monospace font (Monaco by default) and size. Changes apply to open tabs immediately. A colour scheme only sets the palette; servers with a plain prompt still print plain text, so **Settings → Run after connect** can send a line to every new SSH shell (a one-click preset sets a green/blue `PS1` and `ls --color`), overridable per host in the connect dialog.
- **RDP inside the app**: desktops open as tabs next to your SSH tabs (Royal TSX style), rendered by the IronRDP web client (the engine behind Devolutions Remote Desktop Manager). A tiny local proxy in the app's main process speaks IronRDP's RDCleanPath handshake and relays bytes over TLS straight to the instance, through an SSM port-forward when the host is private. Passwords can be pulled from EC2 (`GetPasswordData`) and saved per instance in the macOS Keychain via Electron `safeStorage`. "Windows App" remains available as a hand-off to Microsoft's client.
- **Sign in again** (the key at the bottom of the hosts sidebar) runs the SSO sign-in for your accounts, then re-checks every account and rescans. When a sign-in is about to expire the app shows a banner, and the Mac app also posts a notification if it is in the background.
- **Windows password**: fetches `GetPasswordData` and decrypts it locally with your key pair `.pem`.
- Start / stop instances, copy IPs and SSM CLI commands, per-host overrides (user, port, forced route, key).
- **Quick switcher (`⌘K`)**: search hosts and open sessions by name, IP, account, region or tag. Recent successful connections and favorites appear first. Use arrow keys and Enter to connect/switch, or Shift+Enter for host details.
- **Host details**: click a host name to inspect tags, network identifiers, AMI, SSM status, connection options, and the last successful scan. Click a value to copy it.
- Filters stay above the host table when the sidebar is collapsed. Selecting a host in the sidebar clears conflicting filters and reveals its group.
- Failed account/region scans preserve the last known hosts with a **Cached** badge and a retry action. Successful empty scans still remove hosts that are no longer present.
- Disconnected SSH tabs retain their output and offer **Reconnect**, **Edit connection**, and **Copy message**.
- **Shells that survive disconnects** (Settings → Keep shells running, on by default): on Linux hosts each SSH tab's shell runs inside `tmux` on the host, so a dropped connection, a sleeping laptop or a phone that went away leaves it running, and **Reconnect** continues exactly where you were: same user after `sudo su`, same directory, jobs still running, without re-running "Run after connect". tmux is hidden (no status bar, Ctrl-B goes to the shell, scrolling, selection and Find still work in the app). Closing a tab ends its shell; **Detach** closes the tab but leaves the shell running. When you open a host that has shells left running (the app quit, a tab was closed while disconnected), the new tab lists them with **Resume** and **End**. The tab's **Sessions** button (••• → Sessions on this host on a phone) lists every shell kept on that host and switches the tab between them instantly over the same connection, or starts a **New session in this tab**; the one you leave keeps running, and the terminal shows the chosen shell's own scrollback. Sessions can be **named** ("debug", "indexing"): every brand-new session opens with a *Name this session* field at the top of its tab (it never takes the terminal's focus; × dismisses it), and names can also be given in the connect dialog's *Session name*, when starting a new session from the list, or with the pencil in the list. The name is stored on the host with the session (a tmux user option), so every device sees it, and it shows on the tab, the grid tile and the phone header. Unnamed sessions are told apart by who and what runs in them (after `sudo su`/`su` the real user, e.g. *3dxadmin · tail -f catalina.out*) and their last screen line, usually the prompt. **Open in a new tab** shows a session in a tab of its own, for example to watch two side by side, and **All N sessions on one screen** (top of the list, on the desktop and on tablets) tiles every session of that machine live, each tile usable, with a header strip and **Done**. Its extra tiles are temporary tabs on the same connection, kept out of the tab bar and closed with the grid (the sessions keep running); **Open** on a tile keeps it as a normal tab. Sessions open on another device are left alone. Closing a tile in either grid never ends a persistent session. Hosts without tmux get a plain shell and a one-line hint to install it (`sudo dnf install -y tmux`); turn it off per host in the connect dialog. The shells use their own tmux socket (`tmux -L ec2ra ls` on the host), separate from your own tmux sessions.
- **Port forwarding** over SSM: forward any port on an instance (or a host it can reach, such as an RDS endpoint) to `localhost`, from the host's ⋯ menu, host details, the tunnel bar or `⌘K` (`forward <host>`). Presets are saved for one-click reuse; web ports get an **open** link.
- **Notes** (Notes in the rail, or `⌘⇧N`): Markdown notes kept in your **Obsidian vault** (the one Obsidian has open, found automatically), so both apps edit the same files with no import or sync; *Settings → Notes folder* moves them anywhere (a NAS share, say). The Notes tab has the vault as a tree (click a folder to make new notes and folders go there; drag a note or folder onto a folder, or onto empty space for the top level, to move it; each row's ⋯ or right-click menu renames, moves (Move to…, also for touch screens), moves to the Trash, or adds a note or folder inside) with name filter and full-text search, today's note (in Obsidian's daily-notes folder), and an editor with Edit / Split / Preview, `[[wiki links]]`, autosave, and a reload or keep-mine choice when Obsidian changed the same note. Every session toolbar has **Note**, which opens that host's note (`EC2 Remote/Hosts/<host> (<account>).md`, created on first use and found again by its `ec2_key` if the host is renamed) beside the session; a terminal's **Add to note** button appends the selection, or the last 50 lines, with a timestamp. On a phone: More → Notes, and Host note in a session's ••• menu. Notes live on the computer running the app, so the Pi gateway has its own folder unless it points at the same share. Notes are edited **live**, as in Obsidian: the Markdown marks show only on the line you are editing, so text looks as it will (bold, headings, coloured text, bullets, clickable checkboxes, dividers); the **M↓** button shows the Markdown everywhere, and Split keeps it raw beside the preview. The **formatting bar** sets the font (Monaco by default) and text size for every note, the paragraph style (body, headings), bold `⌘B`, italic `⌘I`, strikethrough `⌘⇧X`, ==highlight== `⌘⇧H`, inline code `⌘E`, text colour, bulleted `⌘⇧8` / numbered `⌘⇧7` lists and checklists `⌘⇧9`, quotes, links, code blocks, tables, dividers and Clear formatting; Enter continues a list. Everything is saved as Markdown Obsidian shows the same way (colour as an inline `<span style="color:…">`); `⌘`-click opens a link or `[[note]]`.
- **Terminal** (Terminal in the rail, `` ⌃` ``, or `⌘K` → New terminal tab): shells on your Mac, laid out like Warp. Tabs down the left side, each with its folder or running command (or across the top: gear menu → Tabs; drag the list's edge to resize it) (`⌘T` opens one in the same folder, `⌘1`…`⌘9`, `⌃Tab`, double-click to rename, right-click for a colour, drag to reorder, `⌘⇧T` reopens a closed one), and the **▾** next to **+** opens a tab with an AWS profile (`AWS_PROFILE` set, tab in the account's colour). Split a tab with `⌘D` / `⌘⇧D`, or pick a layout (two side by side, two stacked, one big and two, or four in a grid) with the grid button next to Split, move between panes with `⌥⌘` + arrows or `⌘[` / `⌘]`, drag the borders, and `⌘⇧↵` shows one pane alone. With zsh, every command becomes a **block**: a green or red edge for its exit status, and on hover its status and time plus Copy command, Copy output, Run again and Add to today's note; a long output keeps its command pinned at the top, `⌘↑` / `⌘↓` jump between commands, and a command that ran 10 s or more notifies you when it finishes while you are elsewhere. Commands are typed in an **input box** at the bottom: `⇧↩` for a new line, `↑` / `↓` for history (your zsh history file plus what you ran), a suggestion from history in grey that `→` accepts, `⌃R` to search history, and `Tab` hands the line to your shell for its own completion; while a command runs, typing goes to the program (and a bar shows its time with a Stop button). Along the very bottom of every pane runs a slim **ribbon**, as in Warp: **+** (a new tab in the pane's folder), a mic for voice input (Mac app), the folder's **Git changes** (`± 6` changed files and `+31 −8` lines; click for the files with their status letters and to run `git status` / `git diff`), **Workflows** (your saved snippets: insert, or run those marked to run), History, **Finder**, and **Rich input** (`⌃G` while the shell is at its prompt) to switch between the input box and typing straight into the shell (also in the gear menu); on the right the AWS profile, the folder (click: Copy path, Show in Finder, New tab here) and the branch with commits ahead/behind (click to copy its name). In a narrow pane the ribbon shows icons only. Links open in the app's browser, `⌘F` finds, `⌘+`/`⌘−` change the text size, and the theme and font are Settings → Terminal's. Tabs, splits and each pane's folder come back after a restart (the shells start again there). Your own zsh setup loads as usual (the app's integration is added after your `.zshrc`); with another shell it is a plain terminal. From a paired iPhone or iPad (More → Terminal) it works only when the computer allows it: on the Mac, Settings → Phone access → **Terminals** (off by default, and only the Mac's own window can turn it on); on the Pi gateway, deploy once with `ALLOW_TERMINALS=1 scripts/deploy-pi.sh user@host` (later deploys keep the setting; `ALLOW_TERMINALS=0` turns it off). The Pi's shells are plain terminals unless its login shell is zsh (blocks and the input box need zsh). A device only ever sees the shells it opened, its layout is not saved over the computer's, and turning the switch off closes its shells.
- **Browser** (Browser in the rail, `⌘K` → Open browser): an Arc-style browser built in, with vertical tabs in a sidebar tinted by the current **space**. A space is its own cookie container, so the same site can be signed in differently in each. Every SSO account gets a space automatically that **signs itself in to that account's AWS console** with the profile's SSO credentials (no AWS sign-in page, several accounts side by side, signed in again when the console session runs out); add your own spaces (Jira, Personal…) with the **+** under the sidebar, each with one of eight colours or **a colour of your own** (the macOS colour picker, optionally a two-colour **gradient**, or one of eight ready-made gradients) and an **emoji** in place of its initials (a quick grid, or More… for the macOS emoji picker); right-click a space → *Rename or recolour…* to change them. Each account space has one-click Console Home, EC2, CloudWatch, Systems Manager, S3, IAM and Billing, and hosts get **AWS console** (details panel, right-click menu, the globe in a session toolbar) to open that instance's console page. The **command bar** (`⌘T` new tab, `⌘L` edit the address) mixes open tabs, every account's console services (`pplm ec2`), history, spaces and actions. **Favorites** (`⌘⇧D`, or drag a tab to the icon grid at the top) are shown in every space and keep the logins of the space they came from (a dot in that space's colour says so), so a pplm console favorite stays pplm wherever you open it; **pinned** tabs (`⌘D`) sit at the top of their own space. `⌘W` on a favorite or pinned tab only unloads it and returns it to its saved page (right-click → *Back to …* / *Keep this page as its address*). Right-click a favorite or pinned tab → *Edit name and address…* to rename it or change where it opens. `⌘1`…`⌘8` switch to the spaces in the order of the avatars along the bottom of the sidebar and `⌘9` to the last one while the browser is in front (`⌘⇧[` / `⌘⇧]` still move between app tabs). Drag the sidebar's edge to resize it (double-click for the default; Favorites fit three a row by default and more as it widens), and swipe sideways on it with two fingers to switch space. Drag tabs to reorder, between Favorites, Pinned and Today, or onto another space's avatar, `⌃Tab` cycles tabs, `⌥⌘↓/↑` switches space, `⌘S` hides the sidebar (hover the left edge to peek), `⌘F` finds in the page, `⌘+`/`⌘−`/`⌘0` zoom every page at once (the browser's sidebar and new-tab page follow the zoom, so both sides stay in proportion), `⌘⇧C` copies the address, `⌘⇧T` reopens a closed tab, *Share…* opens the macOS Share menu (AirDrop, Messages, Notes, or Anybox's share extension), and *Add to today's note* (page menu or right-click) puts a link in your daily note. New tabs show the time, the account's console services and your most visited sites. Tabs, spaces and history are kept between runs (`browser.json`); only the 12 most recent tabs stay loaded and the rest wake up when you open them. Pages are sandboxed with no access to the app, and can't ask for camera, location or notifications. The browser itself is Mac-only; on a phone or tablet, More → **AWS console** and a host's **AWS console** action open that account's console already signed in, in Safari (a one-time link from the computer; Safari keeps one set of AWS logins, so the last account opened is the signed-in one). **Fill from 1Password** (the key in the address pill, `⌘⇧L`, or right-click a form field) lists the 1Password logins saved for the page's site (search for any other) and types the username, password, or one-time code into the page; it uses the 1Password CLI (`brew install 1password-cli`, then 1Password → Settings → Developer → *Integrate with 1Password CLI*), so 1Password asks you to approve the first time. The app checks the page is still on the login's site before filling, and the secrets never reach the app's window. **Downloads** (the arrow button at the top of the sidebar) go straight to your Downloads folder; the button shows progress and a dot when something finished, and its list opens a file, shows it in Finder, cancels a download, or opens the folder. Chrome Web Store extensions are not supported: Electron loads only unpacked extensions and only a subset of the extension APIs (no toolbar popups, side panel or native messaging, which password managers, VPN and assistant extensions depend on). Their Mac apps cover most of it: 1Password (Fill from 1Password above), Grammarly for Mac, ExpressVPN's app (which routes this browser's traffic too), and Anybox through Share.
- **Whiteboard** (Whiteboard in the rail, `⌘K` → Open whiteboard, or More → Whiteboard on a phone or iPad): an infinite scratch pad for brainstorming, with Presentify's drawing tools and single-key shortcuts: pen `P` (pressure from an Apple Pencil), highlighter `M`, line `L`, arrow `A`, rectangle `R`, ellipse `O`, diamond `D` (`⇧` keeps 45° or a square; fill and dashed in the toolbar), text `T`, sticky notes `N`, eraser `E`, laser pointer `K` and a spotlight `F` (`[` `]` resize it). Five palette colours `1`–`5` (right-click a swatch to change it) plus a gradient `6`, three widths (`[` `]`), and **auto-erase** (the timer button), which fades new drawings after 3, 5 or 10 seconds and never saves them, for presenting. `V` selects (drag a box, `⇧`-click to add), drags and resizes with the handles, `⌘D` duplicates, `⌘]`/`⌘[` brings to front or sends back, arrows nudge, `⌫` deletes, `⌘Z`/`⌘⇧Z` undo and redo. Paste or drop a screenshot to mark it up, scroll to pan (or hold Space, or `H`), pinch or `⌘+`/`⌘−` to zoom, `⌘0` fits everything. The left list keeps several boards (double-click to rename; right-click to duplicate or delete); ••• sets dots, grid or plain paper and exports the board, or just the selection, as a PNG, copies it as an image, or adds it to today's note (the image is saved in the vault under `EC2 Remote/Boards`). Boards are saved on the computer running the app, so the iPad works on the same boards.
- **Run a command on many hosts** (**Run command** above the hosts table for the hosts listed, a group's header, a host's ⋯ menu or details, `⌘K`, or More on a phone): one shell command sent through **SSM Run Command** to every chosen host whose agent is online, bash on Linux and PowerShell on Windows. Pick hosts with a filter, insert a snippet, set a timeout; production or more than ten hosts asks first. Each host's status, exit code, duration and output arrive live; retry the failed ones, edit and run again, copy all output, or reopen a run from **Recent**. Needs `ssm:SendCommand` and `ssm:GetCommandInvocation`.
- **Voice dictation**, wherever you type in the Mac app: **hold Right Option (⌥)** by itself, speak, and let go to type what you said where the cursor is, or click a **mic button** (Notes formatting bar, Run Command, an SSH tab's toolbar, the Terminal's bar) and click again or **Done** to insert. A pill at the bottom shows a live waveform and the words as they are recognised; `Esc` cancels and leaves the text as it was. Search fields, dialogs, the Terminal's input box and Notes show the words live and get spacing and capitals that fit the sentence; terminals (including a program running in one, such as Claude Code) receive the finished words as one paste with no Enter, remote desktops as typed keys, and web pages in the built-in browser as typed text. Recognition is Apple's: on the Mac itself when macOS has an on-device model for the language (English does), otherwise Apple's speech service, and the pill says which. Settings → **Voice** picks the hold key (Right Option, Right Command, Fn if your keyboard reports it, or off), the language, and shows the microphone and speech-recognition permissions macOS asks for the first time you dictate. ⌥ combinations keep working: the key starts dictation only when held alone for a moment. In a remote desktop Right Option belongs to dictation (a lone Alt would open Windows' menu bar). On an iPhone or iPad use the keyboard's own microphone key; a paired device can never turn on the Mac's microphone.
- **Menu-bar icon** (Settings → General, on by default): your favorite hosts one click away (connects as a double-click would), plus Find a Host, Rescan and Quit.
- **All sessions on one page** (**Overview** in the rail, or `⌘0`): every open terminal, remote desktop and file browser as a live tile with its host, account, route and status. Click a tile to work in it (terminals and remote desktops alike); **Open** (or double-clicking the tile's header) shows one session full size again. Desktops are scaled down to the tile rather than resized, so Windows apps keep their layout. On an iPad or unfolded phone, **All sessions on one screen** (Sessions list or the session header) does the same, and a tap opens a tile. Nothing reconnects when the grid opens or closes.
- **Terminal tools**: find in scrollback (`⌘F`), saved **snippets** (per host or global), **split view** (`⌘D`) with **broadcast input** (`⌘⇧I`) to every pane, **Save output** of the whole scrollback, and optional **session logs** (Settings → Session logs; a REC badge marks recorded tabs).
- **Command palette**: type `>` in `⌘K` (or `⌘⇧P`) for rescan, sign-in, theme, port forwards, workspaces, snippets; `start`/`stop`/`ssh`/`files <host>` act directly on a host.
- **Workspaces**: save the open tabs under a name and reopen them together from the sidebar or `⌘K` (RDP passwords are not stored; the Keychain credential is used).
- **Keyboard shortcuts** (`⌘/` lists them): `⌘1`–`⌘9` switch tabs, `⌘,` Settings, `⌘B` the hosts sidebar, `⌘W` closes a tab (`⌘⇧W` closes the window), `⌘T` new session, `⌘⇧]`/`⌘⇧[` next/previous, hold Right `⌥` to dictate. Tabs can be dragged to reorder and show their route and uptime.
- **Host health** in host details: EC2 status checks, scheduled events, SSM check-in time and a 3-hour CPU chart (needs `ec2:DescribeInstanceStatus` and `cloudwatch:GetMetricData`).
- **RDP** tabs add full screen (Keyboard Lock sends Esc/⌘Tab to Windows; hold Esc to leave) and fixed resolution presets. SSM-tunnelled desktops are probed for liveness so a dead tunnel reconnects in about a minute instead of freezing.
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
pnpm build:native # the voice-dictation helper (needs Xcode or its Command Line Tools); `pnpm dist` runs it first
```

Dictation in `pnpm dev` uses `build/native/ec2ra-dictate`, so run `pnpm build:native` once. Under `pnpm dev` macOS attributes the microphone and speech permissions to Electron (or the terminal that started it), not to the installed app.

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

Both build the dictation helper first (`scripts/build-dictation.sh`, a universal Swift binary shipped in `Contents/Resources/dictation`); without the Swift compiler they warn and package the app without dictation.

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

### The phone app

On a phone the page opens in a layout built for touch, and the Home Screen icon launches it full screen like an installed app (no App Store needed).

- **Hosts**: search, filter chips (running, favorites, Linux/Windows, account), hosts grouped by account. Tap a host for Remote desktop, SSH terminal, Files, or connection options.
- **Terminal**: a key bar above the iOS keyboard with Esc, Tab, arrows, Home/End/PgUp/PgDn and common symbols. **ctrl** and **alt** are one-shot: tap ctrl, then `c` on the keyboard, to send Ctrl+C. The clipboard key pastes: iOS shows its own **Paste** bubble to confirm, a single line goes straight in, and text with line breaks opens a paste box to check first (the box also opens when the bubble is dismissed or the page is plain http; long-press in it and choose Paste). To copy, press and hold the terminal (or ••• → **Select text to copy**) for the scrollback in a selectable view. The ••• menu also has snippets, text size (kept per phone, separate from the Mac), save output, and disconnect.
- **Remote desktop**: the desktop is sized to the phone screen (Retina sharpness on by default). Tap to click, press and hold to right-click, drag to select or move windows, two fingers to scroll, two-finger tap to right-click. **R-click** makes the next tap a right click. The keyboard button raises the iOS keyboard; the key bar adds Ctrl, Alt, Win, Esc, Tab, arrows, Delete and F-keys. The clipboard key types the phone's clipboard into the desktop as keystrokes, so it works at the Windows sign-in screen too. When something is copied on the desktop a **Copy desktop clipboard here** button appears (iOS only lets a page write the clipboard from a tap). The ••• menu sends Ctrl+Alt+Del and can also put the phone's clipboard on the desktop's clipboard.
- **Sessions**: every open terminal, desktop and file browser. Going back to the host list leaves them connected.

The layout is chosen when the page loads: phones, and phones in landscape, get the phone layout, larger screens get the desktop one. Add `?layout=desktop` or `?layout=mobile` to the URL to force one (More → **Use desktop layout** saves that choice; `?layout=auto` clears it).

### iPhone and iPad app (`ios/`)

A native app, **EC2 Remote**, wraps the same phone interface with things a web page can't do: it pairs by scanning the QR code, stores paired computers in the Keychain, locks with Face ID, shows a clear "can't reach your Mac" screen with retry, opens AWS sign-in pages in Safari, saves downloads through the share sheet, and keeps the screen on while sessions are open. It runs natively on iPhone and iPad; on a wide screen (an iPad in either orientation or in Split View, an unfolded foldable) the host list and the session sit side by side and re-lay out live. An iPad with a keyboard uses the same ⌘ shortcuts as the Mac app.

```bash
ios/install.sh    # build and install on the iPhone or iPad connected to this Mac
ios/archive.sh    # archive and upload to App Store Connect (TestFlight)
```

Needs Xcode signed in to an Apple ID (Settings → Accounts) and Developer Mode on the device. With a free Apple ID the app must be reinstalled every 7 days; a paid developer account extends that to a year. The app talks to the Mac app's Phone access (or a standalone gateway), so the Mac side must be set up as below.

**Sharing it with a few people.** With the paid Apple Developer Program, `ios/archive.sh` signs the app for distribution and uploads it to App Store Connect. Testers install it through TestFlight: *internal* testers (up to 100 people you add under Users and Access) get a build as soon as it finishes processing with no App Review, while *external* testers (an invite by email or public link) need a one-time Beta App Review per version. TestFlight builds expire after 90 days, so upload again before then. A one-time setup in App Store Connect is needed first: create the app with bundle ID `me.surendrabalu.EC2Remote`. `INTERNAL_ONLY=1 ios/archive.sh` locks a build to internal testers. Every tester also needs a Mac running EC2 Remote Access (or a gateway) to pair with.

Sessions survive switching apps: iOS pauses the app's connection within seconds, so the gateway keeps a disconnected page's SSH, SFTP and RDP sessions for 10 minutes and hands them back when the same page reconnects (output printed while away is not replayed).

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

#### On a Raspberry Pi (or any always-on arm64 Linux box)

```bash
scripts/deploy-pi.sh user@raspberrypi.local   # first install, and every later update
```

It builds the gateway, copies it over, installs Node (checksum-verified, in the user's home) and AWS's `session-manager-plugin`, and runs the gateway as a systemd service that starts at boot and restarts on failure. The gateway listens on `127.0.0.1` only; `tailscale serve` (set up for you unless the machine already serves something else) puts HTTPS in front of it inside your tailnet, so nothing is exposed on the LAN. It prints the pairing link at the end; paste it into the iPhone/iPad app (**Pair another computer**), which can hold the Pi and your Mac side by side. Tested on a Raspberry Pi 5 running Debian 13 (arm64).

Once, by hand: copy `~/.aws/config` to the Pi (it holds no secrets), then tap **Sign in to AWS** in the app, since the Pi keeps its own SSO tokens. SSH needs key files the Pi can read: the Mac's 1Password agent does not travel. Copy the `.pem` files the app uses (`scp`, owner-only permissions) and point **Settings** at the new paths: per-account and per-host key files take precedence over the default identity file, so any that still name a Mac path must be changed. The app cannot prompt for a passphrase, so a passphrase-protected key will not work (check with `ssh-keygen -y -f <key>`). Saved RDP passwords are sealed with the Mac's Keychain and must be entered again. Logs: `journalctl -u ec2-remote-gateway`.

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
- **RDP freezes after being idle**: Session Manager ends port-forwarding sessions after its *idle session timeout* (Systems Manager → Session Manager → Preferences). The proxy keeps TCP keepalive on the tunnel, which surfaces a genuinely dead tunnel as a socket error within about a minute and triggers the tab's automatic reconnect. (A slow 3-minute input backstop covers the rare half-open socket keepalive misses; it is deliberately long so a healthy but momentarily static desktop is never cut.) If the SSO token also expired during the session, the RDP tab shows **Sign in** and reconnects on its own once you have signed in, rather than giving up. Raising the idle timeout (up to 60 minutes) reduces how often this happens.

## Data locations

- Settings, inventory cache, per-host overrides: `~/Library/Application Support/EC2 Remote Access/ec2-remote-access.json`
- Browser tabs, spaces and history: `~/Library/Application Support/EC2 Remote Access/browser.json`; each space's cookies and site data under `Partitions/web-<space>` in the same folder
- Whiteboards: `~/Library/Application Support/EC2 Remote Access/boards/<id>.json`
- Generated `.rdp` files: `~/Library/Application Support/EC2 Remote Access/rdp/`
- Warp launch config used for "Open in Warp": `~/.warp/launch_configurations/ec2-remote-access.yaml`

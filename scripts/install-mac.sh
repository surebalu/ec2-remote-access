#!/bin/zsh
# Installs the app built by `pnpm dist` / `pnpm dist:arm64` into /Applications and restarts it.
#
#   scripts/install-mac.sh            # quit the running app, swap in dist/mac-<arch>/, open it
#
# Safe to start from the app's own Terminal tab: it first moves itself into a new session (so quitting the app,
# which closes its terminals, does not stop it), then waits for the app to finish quitting on its own: the app
# closes its SSH, RDP and file sessions on the way out, which can take a while. It never force-quits. The previous
# version is kept in ~/Library/Caches/EC2 Remote Access (previous).app. Afterwards, `claude --continue` in the
# project folder picks a Claude conversation up where it was.
set -euo pipefail

APP_NAME='EC2 Remote Access'
DEST="/Applications/$APP_NAME.app"
BACKUP="$HOME/Library/Caches/$APP_NAME (previous).app"
LOG="$HOME/Library/Logs/$APP_NAME/install.log"
ROOT="${0:A:h:h}"

if [[ -z "${EC2RA_INSTALL_DETACHED:-}" ]]; then
  arch=$(uname -m)
  src="$ROOT/dist/mac-arm64/$APP_NAME.app"
  [[ $arch == x86_64 ]] && src="$ROOT/dist/mac/$APP_NAME.app"
  if [[ ! -d $src ]]; then
    echo "No build at $src. Run: pnpm dist$([[ $arch == arm64 ]] && echo ':arm64')" >&2
    exit 1
  fi
  mkdir -p "${LOG:h}"
  # A new session (setsid) is immune to the hang-up the app sends its terminals when it quits.
  EC2RA_INSTALL_DETACHED=1 EC2RA_INSTALL_SRC="$src" nohup python3 -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' "$0" >"$LOG" 2>&1 &
  echo "Installing $APP_NAME in the background: it will quit, update and reopen. Log: $LOG"
  exit 0
fi

src="$EC2RA_INSTALL_SRC"
echo "[$(date '+%F %T')] installing from $src"
sleep 2
running() { pgrep -f "$DEST/Contents/MacOS/" >/dev/null 2>&1 }
if running; then
  osascript -e "tell application \"$APP_NAME\" to quit" || true
  for _ in {1..180}; do running || break; sleep 1; done
  if running; then
    echo "The app is still running after 3 minutes; not touching it. Quit it and run this script again."
    exit 1
  fi
fi
rm -rf "$BACKUP"
[[ -d $DEST ]] && mv "$DEST" "$BACKUP"
ditto "$src" "$DEST"
echo "[$(date '+%F %T')] installed $(defaults read "$DEST/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo '?'); previous version in $BACKUP"
open "$DEST"

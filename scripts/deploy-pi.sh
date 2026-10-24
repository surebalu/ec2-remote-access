#!/bin/sh
# Deploys the headless gateway to an always-on Linux machine (written for a Raspberry Pi 5, Debian 13, arm64) and keeps
# it running as a systemd service, so the phone and iPad no longer depend on a Mac being awake.
#
#   scripts/deploy-pi.sh user@host        # first install, and every later update (restarts the service)
#   SKIP_BUILD=1 scripts/deploy-pi.sh …   # reuse the existing out/ build
#   NODE_MAJOR=24 PORT=8321               # Node line to install on the machine, local port of the gateway
#   ALLOW_TERMINALS=1 | 0                 # let paired devices open shells on this machine (the Terminal tab), or stop that;
#                                         # unset keeps what the machine has (off on a first install)
#
# Everything lives in the user's home directory (Node in ~/.local/node, the app in ~/ec2-remote-access, data in
# ~/.config/ec2-remote-access) except the systemd unit and AWS's session-manager-plugin package, which need sudo.
# The gateway listens on 127.0.0.1 only; HTTPS comes from `tailscale serve`, so nothing is exposed on the LAN.
# A restart closes sessions that are open on the gateway.
set -eu
cd "$(dirname "$0")/.."

TARGET="${1:-}"
[ -n "$TARGET" ] || { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 1; }
PORT="${PORT:-8321}"
NODE_MAJOR="${NODE_MAJOR:-24}"
ALLOW_TERMINALS="${ALLOW_TERMINALS:-keep}"
PNPM_VERSION="${PNPM_VERSION:-$(pnpm -v)}"
SERVICE=ec2-remote-gateway

[ -n "${SKIP_BUILD:-}" ] || pnpm build:gateway
[ -f out/gateway/index.js ] && [ -f out/renderer/index.html ] || { echo "No build in out/. Run pnpm build:gateway first." >&2; exit 1; }

REMOTE_HOME="$(ssh "$TARGET" 'printf %s "$HOME"')"
APP="$REMOTE_HOME/ec2-remote-access"

echo "Copying the build to ${TARGET}:${APP}…"
ssh "$TARGET" "mkdir -p '$APP/out'"
rsync -a --delete out/gateway/ "$TARGET:$APP/out/gateway/"
rsync -a --delete out/renderer/ "$TARGET:$APP/out/renderer/"
rsync -a package.json pnpm-lock.yaml pnpm-workspace.yaml "$TARGET:$APP/"
# The Box app's keys (build/box.json, never in git), for the gateway's Box sync: readable by its user only.
if [ -f build/box.json ]; then
  ssh "$TARGET" 'mkdir -p "$HOME/.config/ec2-remote-access" && umask 077 && cat > "$HOME/.config/ec2-remote-access/box-app.json"' < build/box.json
fi

echo "Setting up the machine…"
ssh "$TARGET" "APP='$APP' PORT='$PORT' NODE_MAJOR='$NODE_MAJOR' PNPM_VERSION='$PNPM_VERSION' SERVICE='$SERVICE' ALLOW_TERMINALS='$ALLOW_TERMINALS' sh -s" <<'REMOTE'
set -eu
case "$(uname -m)" in
  aarch64) NODE_ARCH=arm64; PLUGIN_DIR=ubuntu_arm64 ;;
  *) echo "Only tested on arm64 (aarch64) machines." >&2; exit 1 ;;
esac

# Node: the official tarball, checked against the published SHA-256, in the user's home (no apt changes).
NODE_HOME="$HOME/.local/node"
DIST="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
LINE="$(curl -fsSL "$DIST/SHASUMS256.txt" | grep "node-v.*-linux-${NODE_ARCH}.tar.xz\$")"
SUM="$(echo "$LINE" | awk '{print $1}')"; FILE="$(echo "$LINE" | awk '{print $2}')"
VER="${FILE#node-}"; VER="${VER%-linux-*}"
if [ ! -x "$NODE_HOME/$VER/bin/node" ]; then
  echo "Installing Node $VER…"
  curl -fsSL -o "/tmp/$FILE" "$DIST/$FILE"
  echo "$SUM  /tmp/$FILE" | sha256sum -c - >/dev/null
  mkdir -p "$NODE_HOME"
  tar -xJf "/tmp/$FILE" -C "$NODE_HOME"
  rm -rf "$NODE_HOME/$VER"; mv "$NODE_HOME/${FILE%.tar.xz}" "$NODE_HOME/$VER"
  rm -f "/tmp/$FILE"
fi
ln -sfn "$NODE_HOME/$VER" "$NODE_HOME/current"
export PATH="$NODE_HOME/current/bin:$PATH"

[ "$(pnpm -v 2>/dev/null || true)" = "$PNPM_VERSION" ] || npm install -g "pnpm@$PNPM_VERSION" >/dev/null 2>&1
echo "Installing dependencies (production only)…"
cd "$APP"
pnpm install --prod --frozen-lockfile --ignore-scripts >/dev/null

# AWS's own package: the gateway starts it for every SSM session, exactly like the AWS CLI does.
if [ ! -x /usr/local/bin/session-manager-plugin ]; then
  echo "Installing session-manager-plugin…"
  curl -fsSL -o /tmp/session-manager-plugin.deb "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/$PLUGIN_DIR/session-manager-plugin.deb"
  sudo dpkg -i /tmp/session-manager-plugin.deb >/dev/null
  rm -f /tmp/session-manager-plugin.deb
fi

DATA="$HOME/.config/ec2-remote-access"
mkdir -p "$DATA"
# An update keeps the machine's terminal setting unless ALLOW_TERMINALS says otherwise.
if [ "$ALLOW_TERMINALS" = keep ]; then
  if grep -q -- '--allow-terminals' "/etc/systemd/system/$SERVICE.service" 2>/dev/null; then ALLOW_TERMINALS=1; else ALLOW_TERMINALS=0; fi
fi
sudo tee "/etc/systemd/system/$SERVICE.service" >/dev/null <<UNIT
[Unit]
Description=EC2 Remote Access gateway
After=network-online.target
Wants=network-online.target

[Service]
User=$(id -un)
WorkingDirectory=$APP
Environment=HOME=$HOME
ExecStart=$NODE_HOME/current/bin/node $APP/out/gateway/index.js --host 127.0.0.1 --port $PORT --data-dir $DATA$( [ "$ALLOW_TERMINALS" = 1 ] && echo ' --allow-terminals' )
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE" >/dev/null 2>&1
sudo systemctl restart "$SERVICE"

TOKEN_FILE="$DATA/gateway.token"
for _ in $(seq 1 30); do
  [ -s "$TOKEN_FILE" ] && [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/auth?token=$(cat "$TOKEN_FILE")")" = 204 ] && break
  sleep 1
done
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/auth?token=$(cat "$TOKEN_FILE")")" = 204 ] || {
  echo "The gateway did not come up. Last log lines:" >&2; sudo journalctl -u "$SERVICE" -n 15 --no-pager >&2; exit 1; }

# HTTPS inside the tailnet. Never replace a serve config someone else set up.
if command -v tailscale >/dev/null 2>&1; then
  CURRENT="$(sudo tailscale serve status 2>&1 || true)"
  if echo "$CURRENT" | grep -q "127.0.0.1:$PORT"; then
    :
  elif echo "$CURRENT" | grep -q 'No serve config'; then
    sudo tailscale serve --bg --https=443 "http://127.0.0.1:$PORT" >/dev/null
  else
    echo "tailscale serve is already configured for something else; left it alone. Add the gateway yourself with:" >&2
    echo "  sudo tailscale serve --bg --https=8443 http://127.0.0.1:$PORT" >&2
  fi
  NAME="$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' || true)"
fi
echo "Gateway running (Node $VER). Pairing link, treat it like a password:"
echo "  https://${NAME:-<tailscale name>}/#token=$(cat "$TOKEN_FILE")"
REMOTE

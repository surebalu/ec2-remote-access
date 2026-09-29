#!/bin/sh
# Builds EC2 Remote and installs it on the iPhone connected to this Mac (cable or same Wi-Fi after first pairing).
#
#   ios/install.sh                 # uses the first Apple development team Xcode knows about
#   TEAM=ABCDE12345 ios/install.sh # or a specific team ID (Xcode → Settings → Accounts)
#
# Needs: Xcode signed in to an Apple ID, and Developer Mode on the iPhone. With a free Apple ID the app stops
# launching after 7 days; run this again to renew it.
set -eu
cd "$(dirname "$0")"

# The team ID is the certificate's OU; the "(XXXXXXXXXX)" in its name is the member ID, which signing rejects.
TEAM="${TEAM:-$(security find-certificate -c "Apple Development" -p 2>/dev/null | openssl x509 -noout -subject 2>/dev/null | sed -n 's/.*OU *= *\([A-Z0-9]\{10\}\).*/\1/p' | head -1)}"
if [ -z "$TEAM" ]; then
  # No certificate yet (first build creates it): use the team Xcode has for the signed-in account.
  TEAM="$(defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier 2>/dev/null | sed -n 's/.*teamID = \([A-Z0-9]\{10\}\);.*/\1/p' | head -1)"
fi
if [ -z "$TEAM" ]; then
  echo "No Apple development team found. Open Xcode → Settings → Accounts, add your Apple ID, then run this again." >&2
  exit 1
fi

# devicectl also lists simulators; take the first physical iPhone/iPad that is plugged in or reachable.
DEVICE="${DEVICE:-$(xcrun devicectl list devices 2>/dev/null | awk '/physical/ && /connected|available/ { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9A-F]{8}-[0-9A-F]{16}$|^[0-9A-F]{8}-([0-9A-F]{4}-){3}[0-9A-F]{12}$/) { print $i; exit } }')}"
if [ -z "$DEVICE" ]; then
  echo "No iPhone found. Connect it with a cable, unlock it, tap Trust, and turn on Settings → Privacy & Security → Developer Mode." >&2
  exit 1
fi

DD="${TMPDIR:-/tmp}/ec2remote-build"
echo "Building for team ${TEAM}…"
APP="$DD/Build/Products/Release-iphoneos/EC2 Remote.app"
# Never install a leftover build if this one fails.
rm -rf "$APP"
if ! xcodebuild -project EC2Remote.xcodeproj -scheme EC2Remote -configuration Release \
  -destination "id=$DEVICE" -derivedDataPath "$DD" \
  -allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM" build > "$DD.log" 2>&1; then
  grep -E "error:" "$DD.log" | sort -u >&2
  echo "Build failed (full log: $DD.log). Check Xcode → Settings → Accounts is signed in, or set TEAM=<your team ID>." >&2
  exit 1
fi
[ -d "$APP" ] || { echo "Build produced no app; see $DD.log" >&2; exit 1; }

echo "Installing on ${DEVICE}…"
xcrun devicectl device install app --device "$DEVICE" "$APP"
echo "Installed. First launch: if iOS says the developer is untrusted, open Settings → General → VPN & Device Management and trust your Apple ID."

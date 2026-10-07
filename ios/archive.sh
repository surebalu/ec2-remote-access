#!/bin/sh
# Archives EC2 Remote and uploads it to App Store Connect, where it shows up in TestFlight after a few minutes of
# processing (and can later be submitted for the App Store).
#
#   ios/archive.sh                 # archive, then upload with the paid team Xcode is signed in to
#   TEAM=ABCDE12345 ios/archive.sh # or name the team (Xcode → Settings → Accounts → Team ID)
#   ios/archive.sh --no-upload     # stop after the .xcarchive; open it with `open <path>` to use Xcode's Organizer
#
#   VERSION=1.1                    # marketing version (default: the project's)
#   BUILD=…                        # build number; default is the current time, so every upload is higher than the last
#   INTERNAL_ONLY=1                # lock the build to TestFlight internal testers (the team's App Store Connect users);
#                                  # such a build can never go to external testers or the store
#
# Needs: the paid Apple Developer Program team added to Xcode (Settings → Accounts), the app record created in App Store
# Connect with bundle ID me.surendrabalu.EC2Remote, and the Apple Distribution certificate, which -allowProvisioningUpdates
# creates on first use.
set -eu
cd "$(dirname "$0")"

UPLOAD=1
[ "${1:-}" = "--no-upload" ] && UPLOAD=0

# The free "Personal Team" cannot distribute, so a team is only picked automatically when it is a paid one.
if [ -z "${TEAM:-}" ]; then
  # Extract just this key: the rest of Xcode's preferences holds binary data that cannot be converted to JSON.
  TEAM="$(defaults export com.apple.dt.Xcode - 2>/dev/null | plutil -extract IDEProvisioningTeamByIdentifier json -o - - 2>/dev/null | python3 -c '
import json, sys
try: teams = [t for v in json.load(sys.stdin).values() for t in v]
except Exception: teams = []
paid = [t["teamID"] for t in teams if not t.get("isFreeProvisioningTeam")]
print(paid[0] if len(paid) == 1 else "")
')"
fi
if [ -z "$TEAM" ]; then
  echo "No single paid Apple Developer team found in Xcode. Add it in Xcode → Settings → Accounts, or run: TEAM=<Team ID> ios/archive.sh" >&2
  exit 1
fi

OUT="${TMPDIR:-/tmp}/ec2remote-archive"
BUILD="${BUILD:-$(date +%y%m%d.%H%M)}"
ARCHIVE="$OUT/EC2Remote.xcarchive"
# Never upload a leftover archive if this one fails.
rm -rf "$OUT"
mkdir -p "$OUT"

echo "Archiving build ${BUILD} for team ${TEAM}…"
if ! xcodebuild -project EC2Remote.xcodeproj -scheme EC2Remote -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM" CURRENT_PROJECT_VERSION="$BUILD" ${VERSION:+MARKETING_VERSION="$VERSION"} \
  archive > "$OUT/archive.log" 2>&1; then
  grep -E "error:" "$OUT/archive.log" | sort -u >&2
  echo "Archive failed (full log: $OUT/archive.log)." >&2
  exit 1
fi

if [ "$UPLOAD" = 0 ]; then
  echo "Archive ready: $ARCHIVE"
  exit 0
fi

INTERNAL=false
[ -n "${INTERNAL_ONLY:-}" ] && INTERNAL=true

cat > "$OUT/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key><string>app-store-connect</string>
	<key>destination</key><string>upload</string>
	<key>teamID</key><string>${TEAM}</string>
	<key>signingStyle</key><string>automatic</string>
	<key>uploadSymbols</key><true/>
	<!-- The build number is set above; don't let Xcode renumber it. -->
	<key>manageAppVersionAndBuildNumber</key><false/>
	<key>testFlightInternalTestingOnly</key><${INTERNAL}/>
</dict>
</plist>
EOF

echo "Uploading to App Store Connect…"
if ! xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportOptionsPlist "$OUT/ExportOptions.plist" \
  -exportPath "$OUT/export" -allowProvisioningUpdates > "$OUT/upload.log" 2>&1; then
  grep -E "error:|ERROR" "$OUT/upload.log" | sort -u >&2
  echo "Upload failed (full log: $OUT/upload.log). If it says the app record is missing, create it in App Store Connect first." >&2
  exit 1
fi
echo "Uploaded build ${BUILD}. App Store Connect processes it for a few minutes; then it appears under TestFlight."

#!/usr/bin/env bash
# Build release artifacts (DMG + zip for arm64 and x64) and optionally upload them to an S3 update feed.
#
#   scripts/release.sh                 # build only -> dist/
#   scripts/release.sh --bump patch    # bump version (patch|minor|major) then build
#   UPDATE_URL=https://bucket.s3.amazonaws.com/ec2-remote-access S3_URI=s3://bucket/ec2-remote-access AWS_PROFILE=pdm \
#   scripts/release.sh --publish       # build with an update feed and upload artifacts + latest-mac.yml
#
# Signing/notarization happen automatically when these are set (see electron-builder.config.cjs):
#   CSC_LINK, CSC_KEY_PASSWORD, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
set -euo pipefail
cd "$(dirname "$0")/.."
BUMP=""; PUBLISH=0
while [ $# -gt 0 ]; do case "$1" in --bump) BUMP=$2; shift 2;; --publish) PUBLISH=1; shift;; *) echo "unknown arg $1"; exit 1;; esac; done
if [ -n "$BUMP" ]; then pnpm version "$BUMP" --no-git-tag-version >/dev/null; fi
VERSION=$(node -p "require('./package.json').version")
echo "▶ Building EC2 Remote Access $VERSION"
if [ -z "${CSC_LINK:-}${CSC_NAME:-}" ]; then echo "  (no Developer ID configured: producing ad-hoc signed, un-notarized build)"; fi
if [ $PUBLISH -eq 1 ] && [ -z "${UPDATE_URL:-}" ]; then echo "--publish requires UPDATE_URL"; exit 1; fi
pnpm typecheck
pnpm exec electron-vite build
pnpm exec electron-builder --config electron-builder.config.cjs --mac --publish never
echo; echo "▶ Artifacts:"; ls -1 dist/*.dmg dist/*.zip dist/latest-mac.yml 2>/dev/null || true
if [ $PUBLISH -eq 1 ]; then
  : "${S3_URI:?S3_URI (s3://bucket/prefix) is required with --publish}"
  echo "▶ Uploading to $S3_URI"
  for f in dist/*.dmg dist/*.zip dist/*.blockmap dist/latest-mac.yml; do [ -f "$f" ] && aws s3 cp "$f" "$S3_URI/$(basename "$f")"; done
  echo "Done. Teammates download: $UPDATE_URL/EC2%20Remote%20Access-$VERSION-arm64.dmg"
fi

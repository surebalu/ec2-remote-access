#!/usr/bin/env bash
# AWS's Session Manager plugin, shipped inside the app (Contents/Resources/ssm) so a new Mac needs no Homebrew step;
# src/main/ssm/session.ts runs it when no plugin is installed. Pinned three ways: the version, each bundle's SHA-256,
# and Amazon's Developer ID signature on the binary (team 94KV3E626L), which stays as Amazon made it. It is
# Apache-2.0: LICENSE, NOTICE and THIRD-PARTY ship beside it.
#
# To move to a newer release: set VERSION (https://s3.amazonaws.com/session-manager-downloads/plugin/latest/VERSION),
# run `scripts/fetch-ssm-plugin.sh --print-sums`, check the printed signatures, and paste the sums below.
#
# Offline, a build without a fetched copy packages without it (the app then asks for Homebrew's, as before); a wrong
# checksum or signature stops the build.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=1.2.896.0
SUM_arm64=05c5ef53fb262de2fa1b46cf457890ee4152ec1dd8b2fdd94d028fa9b885ff36
SUM_x64=66e826fd48a6a6d06ad06b0892805986f7c455295b61974f99cb2a43d29624d7
TEAM=94KV3E626L
out=build/native

print_sums=false
[ "${1:-}" = "--print-sums" ] && print_sums=true

for arch in arm64 x64; do
  dest="$out/ssm-$arch"
  if ! $print_sums && [ -f "$dest/VERSION" ] && [ "$(cat "$dest/VERSION")" = "$VERSION" ] && [ -x "$dest/session-manager-plugin" ]; then
    echo "fetch-ssm-plugin: $dest has $VERSION"
    continue
  fi
  [ "$arch" = arm64 ] && dir=mac_arm64 || dir=mac
  [ "$arch" = arm64 ] && want=$SUM_arm64 || want=$SUM_x64
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  url="https://s3.amazonaws.com/session-manager-downloads/plugin/$VERSION/$dir/sessionmanager-bundle.zip"
  if ! curl -fsSL --retry 2 -o "$tmp/bundle.zip" "$url"; then
    echo "fetch-ssm-plugin: could not download $url; packaging without the bundled plugin for $arch" >&2
    rm -rf "$tmp"
    continue
  fi
  sum=$(shasum -a 256 "$tmp/bundle.zip" | awk '{print $1}')
  if $print_sums; then
    echo "SUM_$arch=$sum"
  elif [ "$sum" != "$want" ]; then
    echo "fetch-ssm-plugin: $dir bundle has SHA-256 $sum, expected $want; not packaging it" >&2
    exit 1
  fi
  unzip -q "$tmp/bundle.zip" -d "$tmp"
  bin="$tmp/sessionmanager-bundle/bin/session-manager-plugin"
  codesign --verify --strict "$bin"
  # Read first: grep -q stopping early would break codesign's pipe, which pipefail reports as a failure.
  signer=$(codesign -dv --verbose=2 "$bin" 2>&1)
  if ! grep -qx "TeamIdentifier=$TEAM" <<<"$signer"; then
    echo "fetch-ssm-plugin: $bin is not signed by Amazon (team $TEAM)" >&2
    exit 1
  fi
  if $print_sums; then
    grep -E '^(Authority=Developer ID Application|TeamIdentifier)' <<<"$signer"
    rm -rf "$tmp"
    continue
  fi
  rm -rf "$dest"
  mkdir -p "$dest"
  cp "$bin" "$dest/session-manager-plugin"
  for f in LICENSE NOTICE THIRD-PARTY; do cp "$tmp/sessionmanager-bundle/$f" "$dest/$f"; done
  echo "$VERSION" > "$dest/VERSION"
  rm -rf "$tmp"
  echo "fetch-ssm-plugin: $dest has $VERSION ($(lipo -archs "$dest/session-manager-plugin"))"
done

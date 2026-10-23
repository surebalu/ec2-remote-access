#!/usr/bin/env bash
# Builds the app's native helpers as universal macOS binaries (arm64 + x86_64, macOS 12 or later):
#   build/native/ec2ra-dictate   voice dictation (native/dictation/main.swift)
#   build/native/ec2ra-control   window layouts, app hotkeys, pasting, and the Mac's calendars (native/control/main.swift)
# electron-builder ships them in the app's Resources (extraResources, see electron-builder.config.cjs) and
# src/main/electronHost.ts runs them from there, or from build/native under `pnpm dev`.
# Off macOS, or without the Swift compiler (Xcode or its Command Line Tools), it warns and builds nothing: the app
# then reports dictation and window layouts as unavailable instead of failing to package.
set -euo pipefail
cd "$(dirname "$0")/.."

out=build/native

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-native: not on macOS; skipping the native helpers" >&2
  exit 0
fi
if ! command -v swiftc >/dev/null 2>&1; then
  echo "build-native: warning: swiftc not found (xcode-select --install); the app will ship without dictation or window layouts" >&2
  exit 0
fi

mkdir -p "$out"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# build <name> <source dir> <bundle id> <frameworks…>
build() {
  local name=$1 dir=$2 id=$3
  shift 3
  local frameworks=()
  for f in "$@"; do frameworks+=(-framework "$f"); done
  for arch in arm64 x86_64; do
    # The Info.plist goes into the binary itself (a command-line tool has no bundle) so macOS finds its usage strings.
    swiftc -O -swift-version 5 -target "$arch-apple-macos12" "${frameworks[@]}" \
      -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$dir/Info.plist" \
      -o "$tmp/$name-$arch" "$dir/main.swift"
  done
  lipo -create -output "$out/$name" "$tmp/$name-arm64" "$tmp/$name-x86_64"
  # An ad-hoc signature so it runs on Apple Silicon; packaging signs it again with the app (build/afterSign.cjs).
  codesign --force --sign - --identifier "$id" "$out/$name" >/dev/null 2>&1 || true
  echo "build-native: built $out/$name ($(lipo -archs "$out/$name"))"
}

build ec2ra-dictate native/dictation com.mainspring.ec2-remote-access.dictate Speech AVFoundation
build ec2ra-control native/control com.mainspring.ec2-remote-access.control AppKit ApplicationServices EventKit

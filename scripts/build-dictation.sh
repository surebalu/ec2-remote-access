#!/usr/bin/env bash
# Builds the voice-dictation helper (native/dictation/main.swift) as a universal macOS binary:
#   build/native/ec2ra-dictate   (arm64 + x86_64, macOS 12 or later)
# electron-builder ships it in the app's Resources (extraResources, see electron-builder.config.cjs) and
# src/main/electronHost.ts runs it from there, or from build/native under `pnpm dev`.
# Off macOS, or without the Swift compiler (Xcode or its Command Line Tools), it warns and builds nothing: the app
# then reports dictation as unavailable instead of failing to package.
set -euo pipefail
cd "$(dirname "$0")/.."

src=native/dictation/main.swift
plist=native/dictation/Info.plist
out=build/native
bin=$out/ec2ra-dictate

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-dictation: not on macOS; skipping the dictation helper" >&2
  exit 0
fi
if ! command -v swiftc >/dev/null 2>&1; then
  echo "build-dictation: warning: swiftc not found (xcode-select --install); the app will ship without dictation" >&2
  exit 0
fi

mkdir -p "$out"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
for arch in arm64 x86_64; do
  # The Info.plist goes into the binary itself (a command-line tool has no bundle) so macOS finds its usage strings.
  swiftc -O -swift-version 5 -target "$arch-apple-macos12" \
    -framework Speech -framework AVFoundation \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$plist" \
    -o "$tmp/ec2ra-dictate-$arch" "$src"
done
lipo -create -output "$bin" "$tmp/ec2ra-dictate-arm64" "$tmp/ec2ra-dictate-x86_64"
# An ad-hoc signature so it runs on Apple Silicon; packaging signs it again with the app (build/afterSign.cjs).
codesign --force --sign - --identifier com.mainspring.ec2-remote-access.dictate "$bin" >/dev/null 2>&1 || true
echo "build-dictation: built $bin ($(lipo -archs "$bin"))"

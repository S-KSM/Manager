#!/bin/sh
# Stop, swap /Applications/Dispatch.app with the local Debug build, and open it.
# Needs sudo because /Applications writes are root-only.
set -eu
SRC="/Users/shobeir/Code/Manager/client-macos/build/Build/Products/Debug/Dispatch.app"
DST="/Applications/Dispatch.app"

if [ ! -d "$SRC" ]; then
  echo "error: $SRC not found — build first with:" >&2
  echo "  cd /Users/shobeir/Code/Manager/client-macos && rm -rf build && xcodebuild -project Dispatch.xcodeproj -scheme Dispatch -configuration Debug -derivedDataPath build build" >&2
  exit 1
fi

sudo rm -rf "$DST" /Applications/Manager.app
sudo cp -R "$SRC" "$DST"
sudo chown -R "$(id -un)":staff "$DST"
open "$DST"
echo "ok: redeployed $DST"

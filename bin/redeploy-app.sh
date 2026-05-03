#!/bin/sh
# Stop the daemon, fully remove every installed copy of the app
# (Dispatch.app + legacy Manager.app), swap in the local Debug build,
# restart the daemon, and open the app.
#
# Needs sudo because /Applications writes are root-only. The daemon
# bootout/bootstrap is per-user (gui/<uid>) so it does NOT need sudo.
set -eu

REPO="/Users/shobeir/Code/Manager"
SRC="$REPO/client-macos/build/Build/Products/Debug/Dispatch.app"
DST="/Applications/Dispatch.app"
LEGACY="/Applications/Manager.app"
LABEL="com.dispatch.daemon"
UID_NUM="$(id -u)"
DOMAIN="gui/$UID_NUM"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ ! -d "$SRC" ]; then
  echo "error: $SRC not found — build first with:" >&2
  echo "  cd $REPO/client-macos && rm -rf build && xcodebuild -project Dispatch.xcodeproj -scheme Dispatch -configuration Debug -derivedDataPath build build" >&2
  exit 1
fi

echo "→ stopping daemon ($LABEL)"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
# Also clear the legacy label if it ever got loaded (defensive).
launchctl bootout "$DOMAIN/com.manager.daemon" 2>/dev/null || true

echo "→ killing any running app instances"
pkill -x Dispatch 2>/dev/null || true
pkill -x Manager 2>/dev/null || true

echo "→ removing every installed copy"
sudo rm -rf "$DST" "$LEGACY"

echo "→ installing fresh build to $DST"
sudo cp -R "$SRC" "$DST"
sudo chown -R "$(id -un)":staff "$DST"

echo "→ restarting daemon"
if [ -f "$PLIST" ]; then
  launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null || \
    launchctl kickstart -k "$DOMAIN/$LABEL"
else
  echo "warning: $PLIST missing — run bin/install.sh to lay it down" >&2
fi

echo "→ opening app"
open "$DST"
echo "ok: redeployed $DST"

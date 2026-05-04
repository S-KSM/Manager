#!/bin/sh
# Stop the daemon, fully remove every installed copy of the app
# (Dispatch.app + legacy Manager.app), swap in the local Debug build,
# restart the daemon, and open the app.
#
# /Applications writes need root; launchctl bootstrap targets the per-user
# GUI domain (gui/<uid>). The script supports both invocations:
#   bash redeploy-app.sh        — runs as you, the rm/cp/chown lines sudo
#   sudo bash redeploy-app.sh   — runs as root, but we resolve UID/HOME/USER
#                                 from SUDO_* so launchctl + open still hit
#                                 your session, not root's.
set -eu

if [ "$(id -u)" = "0" ] && [ -n "${SUDO_UID:-}" ]; then
  TARGET_UID="$SUDO_UID"
  TARGET_USER="${SUDO_USER:-$(id -un "$SUDO_UID")}"
  TARGET_HOME="$(/usr/bin/dscl . -read "/Users/$TARGET_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
  if [ -z "$TARGET_HOME" ]; then TARGET_HOME="/Users/$TARGET_USER"; fi
  SUDO=""                               # already root
  AS_USER="sudo -u $TARGET_USER"        # for launchctl + open
else
  TARGET_UID="$(id -u)"
  TARGET_USER="$(id -un)"
  TARGET_HOME="$HOME"
  SUDO="sudo"
  AS_USER=""
fi

REPO="/Users/shobeir/Code/Manager"
SRC="$REPO/client-macos/build/Build/Products/Debug/Dispatch.app"
DST="/Applications/Dispatch.app"
LEGACY="/Applications/Manager.app"
LABEL="com.dispatch.daemon"
DOMAIN="gui/$TARGET_UID"
PLIST="$TARGET_HOME/Library/LaunchAgents/$LABEL.plist"

if [ ! -d "$SRC" ]; then
  echo "error: $SRC not found — build first with:" >&2
  echo "  cd $REPO/client-macos && rm -rf build && xcodebuild -project Dispatch.xcodeproj -scheme Dispatch -configuration Debug -derivedDataPath build build" >&2
  exit 1
fi

echo "→ stopping daemon ($LABEL) in $DOMAIN"
$AS_USER launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
# Also clear the legacy label if it ever got loaded (defensive).
$AS_USER launchctl bootout "$DOMAIN/com.manager.daemon" 2>/dev/null || true

echo "→ killing any running app instances"
pkill -x Dispatch 2>/dev/null || true
pkill -x Manager 2>/dev/null || true

echo "→ removing every installed copy"
$SUDO rm -rf "$DST" "$LEGACY"

echo "→ installing fresh build to $DST"
$SUDO cp -R "$SRC" "$DST"
$SUDO chown -R "$TARGET_USER":staff "$DST"

echo "→ restarting daemon"
if [ -f "$PLIST" ]; then
  $AS_USER launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null || \
    $AS_USER launchctl kickstart -k "$DOMAIN/$LABEL"
else
  echo "warning: $PLIST missing — run bin/install.sh to lay it down" >&2
fi

echo "→ opening app"
$AS_USER open "$DST"
echo "ok: redeployed $DST"

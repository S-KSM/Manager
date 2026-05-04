#!/bin/sh
# Xcode build-phase script: stamp CFBundleVersion + CFBundleShortVersionString
# of the built Dispatch.app with current git short SHA + ISO date so the
# About Dispatch menu reflects the actual build, not the static plist defaults.
#
# Runs after Resources copy, before code-sign. Edits the COPIED plist inside
# the .app bundle — the source plist in the repo is never touched.
set -eu

PLIST="${TARGET_BUILD_DIR}/${INFOPLIST_PATH}"
if [ ! -f "$PLIST" ]; then
  echo "stamp-app-version: $PLIST not found — skipping" >&2
  exit 0
fi

REPO_ROOT="${SRCROOT}/.."
SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo nogit)"
DIRTY=""
# Refresh the index first — Xcode's build environment can touch tracked
# files' mtimes (causing stat-dirty entries) without changing content.
# Without --refresh, diff-index would falsely report "dirty" right after a
# clean commit + immediate package run.
git -C "$REPO_ROOT" update-index --refresh >/dev/null 2>&1 || true
if ! git -C "$REPO_ROOT" diff-index --quiet HEAD -- 2>/dev/null; then
  DIRTY="-dirty"
fi
DATE="$(date -u +%Y.%m.%d.%H%M)"
BUILD="${DATE}.${SHA}${DIRTY}"

BASE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PLIST" 2>/dev/null || echo 0.0.0)"
SHORT="${BASE}+${SHA}${DIRTY}"

/usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${BUILD}" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString ${SHORT}" "$PLIST"

echo "stamp-app-version: ${SHORT} (${BUILD})"

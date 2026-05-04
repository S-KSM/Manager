#!/usr/bin/env bash
# Build a distributable Dispatch.app + DMG for Apple Silicon.
#
# Output:
#   dist/Dispatch-<version>-arm64.dmg     (drag-to-Applications installer)
#   dist/Dispatch-<version>-arm64.app.zip (zipped .app, for sideload)
#
# Notes:
# - arm64 only. Intel users would need a separate run with -arch x86_64
#   AND a x86_64 build of better-sqlite3. Not supported here.
# - Ad-hoc codesigned (`--sign -`). Gatekeeper will warn the user on first
#   launch — they must right-click → Open to bypass. Real notarization
#   needs an Apple Developer account; out of scope for v1.
# - No prereq install; user must already have Node 20+. The .app spawns
#   `node` from PATH at runtime via the launchd plist.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLIENT_DIR="$REPO_ROOT/client-macos"
DAEMON_DIR="$REPO_ROOT/daemon"
DIST_DIR="$REPO_ROOT/dist"
BUILD_DIR="$CLIENT_DIR/build-release"

if [ "$(uname -m)" != "arm64" ]; then
  echo "package.sh: must run on Apple Silicon (arm64). Detected $(uname -m)." >&2
  exit 1
fi

# 0. Cleanup
rm -rf "$BUILD_DIR" "$DIST_DIR"
mkdir -p "$DIST_DIR"

# 1a. Bundle the daemon (esbuild → dist/bundle.cjs).
echo "==> Bundling daemon"
(cd "$DAEMON_DIR" && npm install --silent && npm run --silent bundle)

# 1b. Vendor a Node arm64 binary into vendor/node/ (idempotent — skips if
#     the right version is already present). Embedding Node into the .app
#     means the user doesn't need it on PATH.
echo "==> Fetching vendored Node"
"$REPO_ROOT/bin/fetch-node.sh"

# 1c. Rebuild native deps against the vendored Node's ABI in a side
#     workspace, then graft the rebuilt better-sqlite3 + bindings into
#     daemon/node_modules so the .app picks them up. We cannot just `npm
#     rebuild` in daemon/ — that would break the dev's local daemon if
#     they're on a different Node version (e.g. system Node 24 vs
#     vendored Node 22). The side workspace keeps the two ABIs separate.
echo "==> Rebuilding native deps for vendored Node ABI"
SIDE_DEPS="$REPO_ROOT/vendor/daemon-deps"
rm -rf "$SIDE_DEPS"
mkdir -p "$SIDE_DEPS"
cp "$DAEMON_DIR/package.json" "$DAEMON_DIR/package-lock.json" "$SIDE_DEPS/"
PATH="$REPO_ROOT/vendor/node/bin:$PATH" \
  npm --prefix "$SIDE_DEPS" install --omit=dev --no-audit --no-fund --silent

# Verify the rebuild produced an arm64 binary that matches our Node ABI.
SIDE_SQLITE="$SIDE_DEPS/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
if [ ! -f "$SIDE_SQLITE" ]; then
  echo "package.sh: rebuild did not produce $SIDE_SQLITE" >&2
  exit 1
fi
SIDE_ARCH="$(file "$SIDE_SQLITE" | grep -oE 'arm64|x86_64' | head -n1)"
if [ "$SIDE_ARCH" != "arm64" ]; then
  echo "package.sh: rebuilt better-sqlite3 is $SIDE_ARCH, expected arm64" >&2
  exit 1
fi
echo "package.sh: rebuilt better-sqlite3 OK"

# Verify better-sqlite3 native binary is arm64 — embed-daemon.sh checks
# again at Xcode build time but failing here is faster + cleaner.
SQLITE_BIN="$DAEMON_DIR/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
if [ ! -f "$SQLITE_BIN" ]; then
  echo "package.sh: $SQLITE_BIN missing — run 'npm install' in daemon/" >&2
  exit 1
fi
SQLITE_ARCH="$(file "$SQLITE_BIN" | grep -oE 'arm64|x86_64' | head -n1)"
if [ "$SQLITE_ARCH" != "arm64" ]; then
  echo "package.sh: better-sqlite3 is $SQLITE_ARCH, expected arm64" >&2
  exit 1
fi

# 2. Release build of the .app (arm64). The Embed Daemon build phase
#    pulls bundle.cjs + the sqlite sidecar into Contents/Resources/.
echo "==> Building Dispatch.app (Release, arm64)"
xcodebuild \
  -project "$CLIENT_DIR/Dispatch.xcodeproj" \
  -scheme Dispatch \
  -configuration Release \
  -destination 'platform=macOS,arch=arm64' \
  -derivedDataPath "$BUILD_DIR" \
  ARCHS=arm64 \
  ONLY_ACTIVE_ARCH=NO \
  build

APP_SRC="$BUILD_DIR/Build/Products/Release/Dispatch.app"
if [ ! -d "$APP_SRC" ]; then
  echo "package.sh: build did not produce $APP_SRC" >&2
  exit 1
fi

# 3. Re-sign the bundle. The Embed Daemon phase wrote new files into
#    Resources/ AFTER Xcode's automatic sign step, so the on-disk hashes
#    no longer match the signature. `--deep --force` resigns everything,
#    including the sqlite .node binary inside Resources/daemon/.
echo "==> Re-signing (ad-hoc)"
codesign --remove-signature "$APP_SRC" 2>/dev/null || true
codesign \
  --force \
  --deep \
  --sign - \
  --options runtime \
  --entitlements "$CLIENT_DIR/Dispatch/Resources/Dispatch.entitlements" \
  "$APP_SRC"

# Verify Gatekeeper is satisfied (modulo notarization, which we don't have).
codesign --verify --deep --strict --verbose=2 "$APP_SRC" || {
  echo "package.sh: codesign verification failed" >&2
  exit 1
}

# 4. Pull version string straight from the Info.plist that stamp-app-version.sh
#    wrote during the build.
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_SRC/Contents/Info.plist")"
SAFE_VERSION="$(printf '%s' "$VERSION" | tr '+/ ' '___')"
echo "==> Packaging Dispatch $VERSION"

# 5. Zip — handy for direct downloads / GitHub release attachments.
ZIP_OUT="$DIST_DIR/Dispatch-${SAFE_VERSION}-arm64.app.zip"
(cd "$(dirname "$APP_SRC")" && /usr/bin/zip -qry "$ZIP_OUT" "$(basename "$APP_SRC")")
echo "wrote $ZIP_OUT ($(/usr/bin/du -sh "$ZIP_OUT" | awk '{print $1}'))"

# 6. DMG with /Applications symlink so users can drag straight in.
DMG_OUT="$DIST_DIR/Dispatch-${SAFE_VERSION}-arm64.dmg"
DMG_STAGE="$(mktemp -d)/dmg"
mkdir -p "$DMG_STAGE"
cp -R "$APP_SRC" "$DMG_STAGE/"
ln -s /Applications "$DMG_STAGE/Applications"

hdiutil create \
  -volname "Dispatch $VERSION" \
  -srcfolder "$DMG_STAGE" \
  -ov \
  -format UDZO \
  -fs HFS+ \
  "$DMG_OUT" >/dev/null

rm -rf "$(dirname "$DMG_STAGE")"
echo "wrote $DMG_OUT ($(/usr/bin/du -sh "$DMG_OUT" | awk '{print $1}'))"

echo ""
echo "==> Done"
echo ""
echo "Install on this machine:"
echo "  open '$DMG_OUT'"
echo "  # then drag Dispatch.app → Applications"
echo ""
echo "Distribute:"
echo "  - DMG: $DMG_OUT"
echo "  - ZIP: $ZIP_OUT"
echo ""
echo "Note: ad-hoc signed; Gatekeeper warns on first launch."
echo "  Workaround: right-click Dispatch.app → Open → Open."

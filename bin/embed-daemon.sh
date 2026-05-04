#!/bin/sh
# Xcode build-phase script: embed the daemon bundle + bundled docs into
# Dispatch.app/Contents/Resources/. Lets the .app run as a self-contained
# unit — first launch writes a launchd plist that points at the bundled
# daemon, no external `bin/install.sh` required.
#
# Layout produced inside the .app:
#   Contents/Resources/daemon/bundle.cjs
#   Contents/Resources/daemon/node_modules/better-sqlite3/...   (arm64 native)
#   Contents/Resources/docs/{TUTORIAL,LOCAL_MODELS,ARCHITECTURE}.md
#
# Re-runs every build (alwaysOutOfDate=1 in pbxproj). Cheap: rsync skips
# unchanged files.
set -eu

REPO_ROOT="${SRCROOT}/.."
DAEMON_SRC="${REPO_ROOT}/daemon"
DAEMON_BUNDLE="${DAEMON_SRC}/dist/bundle.cjs"
DOCS_SRC="${REPO_ROOT}/docs"
NODE_VENDOR="${REPO_ROOT}/vendor/node"

# Prefer the side-rebuilt deps (compiled against the vendored Node ABI)
# when present — package.sh populates vendor/daemon-deps/. Falls back to
# daemon/node_modules/ for plain xcodebuild Debug runs where the dev's
# local Node ABI happens to match the vendored one.
SIDE_DEPS="${REPO_ROOT}/vendor/daemon-deps/node_modules"
if [ -d "$SIDE_DEPS/better-sqlite3" ]; then
  DEPS_SRC="$SIDE_DEPS"
  echo "embed-daemon: using side-rebuilt native deps from $SIDE_DEPS"
else
  DEPS_SRC="${DAEMON_SRC}/node_modules"
  echo "embed-daemon: using daemon/node_modules native deps (Debug build)"
fi
SQLITE_DIR="${DEPS_SRC}/better-sqlite3"

DEST_RESOURCES="${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}"
DEST_DAEMON="${DEST_RESOURCES}/daemon"
DEST_DOCS="${DEST_RESOURCES}/docs"
DEST_NODE="${DEST_RESOURCES}/node"

# 1. Bundle the daemon if dist/bundle.cjs is missing or stale.
if [ ! -f "$DAEMON_BUNDLE" ] || [ -n "$(find "$DAEMON_SRC/src" -type f -name '*.ts' -newer "$DAEMON_BUNDLE" 2>/dev/null | head -n1)" ]; then
  echo "embed-daemon: rebuilding daemon bundle"
  (cd "$DAEMON_SRC" && npm run --silent bundle)
fi

# 2. Daemon bundle + native sqlite sidecar.
mkdir -p "$DEST_DAEMON/node_modules/better-sqlite3"
/usr/bin/rsync -a --delete \
  "$DAEMON_BUNDLE" "$DEST_DAEMON/bundle.cjs"

# better-sqlite3 needs: package.json, lib/, build/Release/better_sqlite3.node.
# Skip docs / .ts / test fixtures — they bloat the .app for no runtime value.
/usr/bin/rsync -a --delete \
  --include='/package.json' \
  --include='/lib/***' \
  --include='/build/' \
  --include='/build/Release/' \
  --include='/build/Release/better_sqlite3.node' \
  --exclude='*' \
  "$SQLITE_DIR/" "$DEST_DAEMON/node_modules/better-sqlite3/"

# better-sqlite3 require()s the `bindings` package at runtime to locate
# its native .node file. `bindings` in turn require()s `file-uri-to-path`.
# Both are pure JS — small, no native code — so we ship the whole package
# directories (skipping README/test bloat).
for dep in bindings file-uri-to-path; do
  src="${DEPS_SRC}/${dep}"
  if [ ! -d "$src" ]; then
    echo "embed-daemon: error: $src missing — better-sqlite3 won't load without it" >&2
    exit 1
  fi
  mkdir -p "$DEST_DAEMON/node_modules/${dep}"
  /usr/bin/rsync -a --delete \
    --include='*.js' \
    --include='package.json' \
    --include='LICENSE*' \
    --exclude='*' \
    "$src/" "$DEST_DAEMON/node_modules/${dep}/"
done

# Verify arm64. Fail the build loud if the wrong arch slipped in — we ship
# arm64-only and a silent x86_64 binary would crash on launch under Rosetta.
NODE_BIN="$DEST_DAEMON/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
if [ ! -f "$NODE_BIN" ]; then
  echo "embed-daemon: error: $NODE_BIN missing — better-sqlite3 not installed in daemon/node_modules" >&2
  exit 1
fi
ARCH="$(/usr/bin/file "$NODE_BIN" | grep -oE 'arm64|x86_64' | head -n1)"
if [ "$ARCH" != "arm64" ]; then
  echo "embed-daemon: error: $NODE_BIN is $ARCH, expected arm64. Reinstall daemon deps on Apple Silicon." >&2
  exit 1
fi

# 3. Docs that the in-app Help menu opens (Tutorial / Local model setup /
#    Architecture). Bundling sidesteps the v1.1.x hardcoded repo path.
mkdir -p "$DEST_DOCS"
for f in TUTORIAL.md LOCAL_MODELS.md ARCHITECTURE.md; do
  if [ -f "$DOCS_SRC/$f" ]; then
    /usr/bin/rsync -a "$DOCS_SRC/$f" "$DEST_DOCS/$f"
  fi
done

# 4. Vendored Node arm64 — the user shouldn't have to install Node. The
#    launchd plist invokes this binary directly instead of `/usr/bin/env
#    node`, so the daemon comes up cleanly even on a bare macOS install.
#    fetch-node.sh populates vendor/node/ at package time.
if [ ! -x "$NODE_VENDOR/bin/node" ]; then
  echo "embed-daemon: $NODE_VENDOR/bin/node missing — run bin/fetch-node.sh" >&2
  exit 1
fi
mkdir -p "$DEST_NODE/bin"
/usr/bin/rsync -a --delete "$NODE_VENDOR/bin/node" "$DEST_NODE/bin/node"
chmod +x "$DEST_NODE/bin/node"

NODE_ARCH="$(/usr/bin/file "$DEST_NODE/bin/node" | grep -oE 'arm64|x86_64' | head -n1)"
if [ "$NODE_ARCH" != "arm64" ]; then
  echo "embed-daemon: bundled node is $NODE_ARCH, expected arm64" >&2
  exit 1
fi

echo "embed-daemon: ok (daemon $(/usr/bin/du -sh "$DEST_DAEMON" | awk '{print $1}'), docs $(/usr/bin/du -sh "$DEST_DOCS" | awk '{print $1}'), node $(/usr/bin/du -sh "$DEST_NODE" | awk '{print $1}'))"

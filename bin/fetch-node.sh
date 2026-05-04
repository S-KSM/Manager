#!/bin/sh
# Download a vendored Node arm64 binary into vendor/node/. Idempotent — does
# nothing if the right version is already present. Called by package.sh
# before the Xcode build so embed-daemon.sh can copy it into the .app.
#
# Why bundle Node: the user shouldn't need to `brew install node`. This is
# the difference between "drag to Applications, double-click, it works" and
# "drag, double-click, broken, debug PATH issues."
#
# arm64-only on purpose; package.sh refuses to build on Intel.
set -eu

NODE_VERSION="22.11.0"   # LTS as of build
ARCH="arm64"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR_DIR="$REPO_ROOT/vendor/node"
STAMP="$VENDOR_DIR/.node-version"

if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$NODE_VERSION-$ARCH" ] && [ -x "$VENDOR_DIR/bin/node" ]; then
  echo "fetch-node: vendor/node already at $NODE_VERSION-$ARCH"
  exit 0
fi

URL="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-${ARCH}.tar.xz"
TARBALL="$(mktemp -t dispatch-node-XXXXXX).tar.xz"
echo "fetch-node: downloading $URL"
/usr/bin/curl -fsSL -o "$TARBALL" "$URL"

TMP="$(mktemp -d -t dispatch-node-extract-XXXXXX)"
/usr/bin/tar -xf "$TARBALL" -C "$TMP"
EXTRACTED="$TMP/node-v${NODE_VERSION}-darwin-${ARCH}"
if [ ! -d "$EXTRACTED" ]; then
  echo "fetch-node: extracted dir missing: $EXTRACTED" >&2
  exit 1
fi

rm -rf "$VENDOR_DIR"
mkdir -p "$VENDOR_DIR"
# Keep bin/ + lib/node_modules/npm so package.sh can `npm rebuild` native
# deps against this exact Node ABI. The .app bundle only ships bin/node;
# npm lives in vendor/ for build-time only (not in the .app).
cp -R "$EXTRACTED/bin" "$VENDOR_DIR/bin"
cp -R "$EXTRACTED/lib" "$VENDOR_DIR/lib"

printf '%s-%s' "$NODE_VERSION" "$ARCH" > "$STAMP"

rm -rf "$TMP" "$TARBALL"

ARCH_CHECK=$(/usr/bin/file "$VENDOR_DIR/bin/node" | grep -oE 'arm64|x86_64' | head -n1)
if [ "$ARCH_CHECK" != "arm64" ]; then
  echo "fetch-node: downloaded node is $ARCH_CHECK, expected arm64" >&2
  exit 1
fi

SIZE=$(/usr/bin/du -sh "$VENDOR_DIR" | awk '{print $1}')
echo "fetch-node: ok — $VENDOR_DIR ($SIZE)"

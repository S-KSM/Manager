#!/usr/bin/env sh
# Dispatch — one-command install.
#
# Idempotent. Builds the daemon and the macOS app, copies the app to
# /Applications, installs lifecycle hooks into ~/.claude/settings.json, wires
# the dispatch MCP into Claude Code (user scope), and registers a launchd agent
# so the daemon starts at login.
#
# Migrates legacy v1.1.x state (`~/.claude/manager/`, `com.manager.daemon`,
# `claude mcp add manager`) to the v1.2 names. The MANAGER_* env vars are
# still honored at runtime for one release (v1.3 removes them).
#
# Usage:
#   bash bin/install.sh           # interactive (confirms each step)
#   bash bin/install.sh --yes     # skip confirmations
#   bash bin/install.sh --force   # rebuild even if dist is newer than src
#   bash bin/install.sh --skip-app    # skip the macOS app build/copy
#   bash bin/install.sh --app-dest /tmp/Dispatch.app   # override copy target
#
# Never sudoes. If a step needs elevated permissions (e.g. /Applications)
# the script prints a clear error and instructs the user.

set -u

# ---------------- helpers ---------------------------------------------------

ASSUME_YES=0
FORCE_BUILD=0
SKIP_APP=0
CHECK_ONLY=0
APP_DEST="/Applications/Dispatch.app"

for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    --force) FORCE_BUILD=1 ;;
    --skip-app) SKIP_APP=1 ;;
    --check-only) CHECK_ONLY=1 ;;
    --app-dest=*) APP_DEST="${arg#--app-dest=}" ;;
    --app-dest)
      echo "error: --app-dest requires =PATH form, e.g. --app-dest=/tmp/Dispatch.app" >&2
      exit 2 ;;
    -h|--help)
      sed -n '2,22p' "$0"
      exit 0 ;;
    *)
      echo "unknown arg: $arg (use --help)" >&2
      exit 2 ;;
  esac
done

# Color-ish output. No emoji. Skip when stdout isn't a tty.
if [ -t 1 ]; then
  C_BOLD=$(printf '\033[1m')
  C_DIM=$(printf '\033[2m')
  C_RED=$(printf '\033[31m')
  C_YELLOW=$(printf '\033[33m')
  C_GREEN=$(printf '\033[32m')
  C_RESET=$(printf '\033[0m')
else
  C_BOLD=""; C_DIM=""; C_RED=""; C_YELLOW=""; C_GREEN=""; C_RESET=""
fi

step() { printf '\n%s== %s ==%s\n' "$C_BOLD" "$1" "$C_RESET"; }
info() { printf '%s%s%s\n' "$C_DIM" "$1" "$C_RESET"; }
warn() { printf '%swarn:%s %s\n' "$C_YELLOW" "$C_RESET" "$1" >&2; }
ok()   { printf '%sok:%s %s\n' "$C_GREEN" "$C_RESET" "$1"; }
die()  { printf '%serror:%s %s\n' "$C_RED" "$C_RESET" "$1" >&2; exit 1; }

confirm() {
  prompt="$1"
  if [ "$ASSUME_YES" = "1" ]; then
    return 0
  fi
  printf '%s [y/N] ' "$prompt"
  read -r reply || return 1
  case "$reply" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

require_cmd() {
  cmd="$1"
  hint="${2:-}"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    if [ -n "$hint" ]; then
      die "missing required command: $cmd ($hint)"
    else
      die "missing required command: $cmd"
    fi
  fi
}

# Resolve repo root from this script's path: $REPO/bin/install.sh
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$SCRIPT_DIR/.." && pwd)
USER_NAME="$(id -un)"
HOME_DIR="${HOME:-/Users/$USER_NAME}"

# ---------------- v1.2 state migration --------------------------------------

# migrate_state_dir — move legacy ~/.claude/manager → ~/.claude/dispatch on
# upgrade from v1.1.x. Idempotent: silent no-op if already migrated.
#  - both dirs exist  → warn and leave alone (user resolves manually)
#  - only legacy dir  → atomic rename
#  - only new dir     → no-op
#  - neither          → no-op (fresh install)
migrate_state_dir() {
  legacy="$HOME_DIR/.claude/manager"
  current="$HOME_DIR/.claude/dispatch"
  if [ -d "$legacy" ] && [ -d "$current" ]; then
    warn "both $legacy and $current exist — leaving in place. Resolve manually:"
    warn "  - if dispatch is the live one, rm -rf '$legacy'"
    warn "  - otherwise, merge events/memory/queues from manager into dispatch then rm -rf '$legacy'"
    return 0
  fi
  if [ -d "$legacy" ] && [ ! -d "$current" ]; then
    if mv "$legacy" "$current"; then
      ok "migrated state $legacy → $current"
    else
      warn "could not migrate $legacy → $current; daemon will start with empty state"
    fi
    return 0
  fi
  # Either only $current exists, or neither — nothing to do.
  return 0
}

# ---------------- preflight -------------------------------------------------

# Detailed prereq check. Returns 0 if everything required is present, non-zero
# if anything blocking is missing. Prints a one-line install hint per missing
# tool. claude CLI is informational (we fall back to direct settings.json merge).
check_prereqs() {
  pre_fail=0

  if [ "$(uname -s 2>/dev/null)" != "Darwin" ]; then
    warn "Dispatch only supports macOS for v1; current uname=$(uname -s)"
    pre_fail=1
  else
    ok "macOS detected"
  fi

  if command -v node >/dev/null 2>&1; then
    nv=$(node --version 2>/dev/null | sed 's/^v//')
    nmajor=$(printf '%s' "$nv" | cut -d. -f1)
    if [ "${nmajor:-0}" -lt 20 ] 2>/dev/null; then
      warn "node $nv found but Dispatch needs Node 20+. Upgrade with: brew install node"
      pre_fail=1
    else
      ok "node $nv"
    fi
  else
    warn "node missing. Install with: brew install node"
    pre_fail=1
  fi

  if command -v npm >/dev/null 2>&1; then
    ok "npm $(npm --version 2>/dev/null)"
  else
    warn "npm missing (usually bundled with node). Install with: brew install node"
    pre_fail=1
  fi

  if xcode-select -p >/dev/null 2>&1; then
    ok "xcode CLT at $(xcode-select -p)"
  else
    warn "xcode command line tools missing. Install with: xcode-select --install"
    pre_fail=1
  fi

  if command -v jq >/dev/null 2>&1; then
    ok "jq $(jq --version 2>/dev/null)"
  else
    warn "jq missing. Install with: brew install jq"
    pre_fail=1
  fi

  if command -v launchctl >/dev/null 2>&1; then
    ok "launchctl"
  else
    warn "launchctl missing — required to register the daemon at login"
    pre_fail=1
  fi

  if command -v curl >/dev/null 2>&1; then
    ok "curl"
  else
    warn "curl missing"
    pre_fail=1
  fi

  if command -v claude >/dev/null 2>&1; then
    ok "claude CLI on PATH"
  else
    info "claude CLI not on PATH — install will fall back to direct ~/.claude/settings.json merge for the MCP wiring"
  fi

  return $pre_fail
}

step "Preflight"
info "repo: $REPO"
info "user: $USER_NAME"
if ! check_prereqs; then
  if [ "$CHECK_ONLY" = "1" ]; then
    die "prereq check failed — install the missing tools above and re-run"
  fi
  die "missing prerequisites — install the tools listed above (with the hinted commands) and re-run. Use --check-only to re-check without installing."
fi
if [ "$CHECK_ONLY" = "1" ]; then
  ok "all prerequisites satisfied"
  exit 0
fi
ok "preflight"

# ---------------- 0. migrate v1.1.x state -----------------------------------

step "Migrate legacy state (v1.1.x → v1.2)"
migrate_state_dir

# ---------------- 1. build daemon ------------------------------------------

step "Build daemon"
DAEMON_DIST="$REPO/daemon/dist/index.js"
NEEDS_BUILD=1
if [ "$FORCE_BUILD" != "1" ] && [ -f "$DAEMON_DIST" ]; then
  # Cheap mtime check: rebuild only if any src/*.ts is newer than dist/index.js.
  newer=$(find "$REPO/daemon/src" -type f -name '*.ts' -newer "$DAEMON_DIST" 2>/dev/null | head -n 1)
  if [ -z "$newer" ]; then
    NEEDS_BUILD=0
    info "daemon/dist is up to date (use --force to rebuild)"
  fi
fi
if [ "$NEEDS_BUILD" = "1" ]; then
  if confirm "Run 'npm install && npm run build' in daemon/?"; then
    (cd "$REPO/daemon" && npm install && npm run build) || die "daemon build failed"
    ok "daemon built"
  else
    warn "skipped daemon build"
  fi
else
  ok "daemon already built"
fi

# ---------------- 2. build macOS app ----------------------------------------

if [ "$SKIP_APP" = "1" ]; then
  step "macOS app (skipped via --skip-app)"
else
  step "Build macOS app"
  if [ ! -d "$REPO/client-macos" ]; then
    warn "client-macos/ not found; skipping app build"
  elif ! command -v xcodebuild >/dev/null 2>&1; then
    warn "xcodebuild not found; skipping app build (install Xcode command-line tools)"
  else
    if confirm "Build client-macos via xcodebuild and copy to $APP_DEST?"; then
      # Track 2 owns the Xcode rename; it produces a Dispatch.app from
      # Dispatch.xcodeproj. Until that lands, fall back to the legacy Manager
      # project name so the install path keeps working on user machines.
      if [ -d "$REPO/client-macos/Dispatch.xcodeproj" ]; then
        XCODE_PROJ="Dispatch.xcodeproj"
        XCODE_SCHEME="Dispatch"
        XCODE_PRODUCT="Dispatch.app"
      else
        XCODE_PROJ="Manager.xcodeproj"
        XCODE_SCHEME="Manager"
        XCODE_PRODUCT="Manager.app"
      fi
      (cd "$REPO/client-macos" && xcodebuild \
          -project "$XCODE_PROJ" \
          -scheme "$XCODE_SCHEME" \
          -destination 'platform=macOS' \
          -derivedDataPath build/ \
          build) || die "xcodebuild failed"
      APP_SRC="$REPO/client-macos/build/Build/Products/Debug/$XCODE_PRODUCT"
      if [ ! -d "$APP_SRC" ]; then
        die "built app not found at $APP_SRC"
      fi
      if [ -e "$APP_DEST" ]; then
        if ! confirm "Overwrite existing $APP_DEST?"; then
          warn "leaving existing $APP_DEST in place"
          APP_SRC=""
        fi
      fi
      if [ -n "$APP_SRC" ]; then
        # Try cp first; if it fails on /Applications surface a clear error.
        if rm -rf "$APP_DEST" 2>/dev/null && cp -R "$APP_SRC" "$APP_DEST" 2>/dev/null; then
          ok "installed app to $APP_DEST"
        else
          warn "could not write to $APP_DEST (permission denied)."
          warn "manually copy with: sudo cp -R '$APP_SRC' '$APP_DEST'"
        fi
      fi
    else
      warn "skipped macOS app build"
    fi
  fi
fi

# ---------------- 3. install hooks ------------------------------------------

step "Install lifecycle hooks"
if [ ! -f "$REPO/hooks/install.sh" ]; then
  die "hooks/install.sh missing"
fi
if confirm "Run hooks/install.sh (merges into ~/.claude/settings.json)?"; then
  # The child script asks its own y/N. Auto-confirm for a smooth parent flow.
  if printf 'y\n' | sh "$REPO/hooks/install.sh"; then
    ok "hooks installed"
  else
    warn "hooks/install.sh exited non-zero"
  fi
else
  warn "skipped hook install"
fi

# ---------------- 4. wire MCP -----------------------------------------------

step "Wire Dispatch MCP into Claude Code"
SETTINGS_FILE="$HOME_DIR/.claude/settings.json"
MCP_INSTALLED=0

# Best-effort: drop legacy `manager` MCP entry before installing `dispatch`.
if command -v claude >/dev/null 2>&1; then
  if claude mcp list 2>/dev/null | grep -qE '^manager(\s|:|$)'; then
    info "removing legacy 'manager' MCP entry from claude"
    claude mcp remove manager >/dev/null 2>&1 || warn "'claude mcp remove manager' failed; continuing"
  fi
fi

if command -v claude >/dev/null 2>&1; then
  # Claude Code CLI is on PATH; prefer its declarative API.
  if claude mcp list 2>/dev/null | grep -qE '^dispatch(\s|:|$)'; then
    info "dispatch MCP already registered in claude (skipping)"
    MCP_INSTALLED=1
  else
    if confirm "Run 'claude mcp add dispatch --scope user -- node $REPO/daemon/dist/index.js mcp'?"; then
      if claude mcp add dispatch --scope user -- node "$REPO/daemon/dist/index.js" mcp; then
        ok "dispatch MCP added via claude CLI"
        MCP_INSTALLED=1
      else
        warn "claude mcp add failed; will fall back to settings.json merge"
      fi
    else
      warn "skipped claude mcp add"
    fi
  fi
fi

if [ "$MCP_INSTALLED" = "0" ]; then
  if confirm "Merge dispatch MCP entry into $SETTINGS_FILE directly?"; then
    mkdir -p "$(dirname "$SETTINGS_FILE")"
    [ -f "$SETTINGS_FILE" ] || echo "{}" > "$SETTINGS_FILE"
    TMP=$(mktemp)
    # Drop legacy 'manager' MCP entry in the same write so jq isn't run twice.
    jq \
      --arg cmd "node" \
      --arg arg0 "$REPO/daemon/dist/index.js" \
      --arg arg1 "mcp" \
      '.mcpServers = ((.mcpServers // {}) | del(.manager) + {
         "dispatch": {
           "type": "stdio",
           "command": $cmd,
           "args": [$arg0, $arg1]
         }
       })' "$SETTINGS_FILE" > "$TMP" || { rm -f "$TMP"; die "jq merge failed"; }
    mv "$TMP" "$SETTINGS_FILE"
    ok "wrote MCP entry to $SETTINGS_FILE"
  else
    warn "skipped MCP wiring"
  fi
fi

# ---------------- 5. launchd plist ------------------------------------------

step "Generate launchd plist"
PLIST_TPL="$REPO/bin/com.dispatch.daemon.plist.template"
PLIST_DEST="$HOME_DIR/Library/LaunchAgents/com.dispatch.daemon.plist"
LEGACY_LABEL="com.manager.daemon"
LEGACY_PLIST="$HOME_DIR/Library/LaunchAgents/com.manager.daemon.plist"
if [ ! -f "$PLIST_TPL" ]; then
  die "missing plist template: $PLIST_TPL"
fi
mkdir -p "$(dirname "$PLIST_DEST")"
mkdir -p "$HOME_DIR/Library/Logs"

# v1.2: tear down the legacy manager launchd agent BEFORE writing the new one,
# so the freshly-installed daemon owns port 9876 alone.
UID_VAL=$(id -u)
DOMAIN="gui/$UID_VAL"
if launchctl print "$DOMAIN/$LEGACY_LABEL" >/dev/null 2>&1; then
  info "booting out legacy $LEGACY_LABEL"
  launchctl bootout "$DOMAIN/$LEGACY_LABEL" 2>/dev/null || warn "bootout legacy agent failed (continuing)"
fi
if [ -f "$LEGACY_PLIST" ]; then
  rm -f "$LEGACY_PLIST" && ok "removed legacy $LEGACY_PLIST"
fi

# sed escape: REPO and USER_NAME must not contain unescaped slashes/ampersands
# in plain English contexts. Use a `|` delimiter to dodge typical macOS paths.
sed \
  -e "s|__REPO__|$REPO|g" \
  -e "s|__USER__|$USER_NAME|g" \
  "$PLIST_TPL" > "$PLIST_DEST.tmp"
mv "$PLIST_DEST.tmp" "$PLIST_DEST"
ok "wrote $PLIST_DEST"

# ---------------- 6. load launchd -------------------------------------------

step "Load launchd agent"
LABEL="com.dispatch.daemon"

# If already loaded, bootout first (idempotent reinstall).
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  info "agent already loaded; booting out before reload"
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
fi

if confirm "Bootstrap $LABEL into $DOMAIN now?"; then
  if launchctl bootstrap "$DOMAIN" "$PLIST_DEST"; then
    ok "agent loaded"
    # Health probe.
    sleep 2
    PORT="${DISPATCH_PORT:-${MANAGER_PORT:-9876}}"
    if curl -s --max-time 2 "http://127.0.0.1:$PORT/health" | grep -q '"ok":true'; then
      ok "daemon healthy on port $PORT"
    else
      warn "could not reach daemon /health on port $PORT (may still be starting; check ~/Library/Logs/dispatch.daemon.err.log)"
    fi
  else
    warn "launchctl bootstrap failed (run 'launchctl print $DOMAIN/$LABEL' to inspect)"
  fi
else
  warn "skipped launchd load"
fi

# ---------------- 7. summary ------------------------------------------------

step "Done"
cat <<EOF
Logs:
  $HOME_DIR/Library/Logs/dispatch.daemon.out.log
  $HOME_DIR/Library/Logs/dispatch.daemon.err.log

App:
  $APP_DEST

To register a workstream and launch a Claude Code session under it:

  node "$REPO/daemon/dist/index.js" register my-proj "My Project"
  cd /path/to/my-proj && DISPATCH_WORKSTREAM=my-proj claude

Uninstall:

  bash "$REPO/bin/uninstall.sh"
EOF

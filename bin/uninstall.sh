#!/usr/bin/env sh
# Manager — uninstall.
#
# Reverses bin/install.sh. Idempotent: missing pieces are skipped, not errors.
# Always exits 0 unless something genuinely fails.
#
# Usage:
#   bash bin/uninstall.sh
#   bash bin/uninstall.sh --yes    # skip confirmation prompts (still asks about
#                                  # /Applications/Manager.app and ~/.claude/manager)
#   bash bin/uninstall.sh --purge  # also remove the app and on-disk state
#                                  # without prompting

set -u

ASSUME_YES=0
PURGE=0
APP_DEST="/Applications/Manager.app"

for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    --purge) PURGE=1; ASSUME_YES=1 ;;
    --app-dest=*) APP_DEST="${arg#--app-dest=}" ;;
    -h|--help)
      sed -n '2,15p' "$0"
      exit 0 ;;
    *)
      echo "unknown arg: $arg (use --help)" >&2
      exit 2 ;;
  esac
done

if [ -t 1 ]; then
  C_BOLD=$(printf '\033[1m')
  C_DIM=$(printf '\033[2m')
  C_YELLOW=$(printf '\033[33m')
  C_GREEN=$(printf '\033[32m')
  C_RESET=$(printf '\033[0m')
else
  C_BOLD=""; C_DIM=""; C_YELLOW=""; C_GREEN=""; C_RESET=""
fi

step() { printf '\n%s== %s ==%s\n' "$C_BOLD" "$1" "$C_RESET"; }
info() { printf '%s%s%s\n' "$C_DIM" "$1" "$C_RESET"; }
warn() { printf '%swarn:%s %s\n' "$C_YELLOW" "$C_RESET" "$1" >&2; }
ok()   { printf '%sok:%s %s\n' "$C_GREEN" "$C_RESET" "$1"; }

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

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$SCRIPT_DIR/.." && pwd)
HOME_DIR="${HOME:-/Users/$(id -un)}"
SETTINGS_FILE="$HOME_DIR/.claude/settings.json"

# ---------------- 1. unload launchd ----------------------------------------

step "Unload launchd agent"
UID_VAL=$(id -u)
DOMAIN="gui/$UID_VAL"
LABEL="com.manager.daemon"
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  ok "booted out $LABEL"
else
  info "$LABEL not loaded; skipping bootout"
fi

PLIST="$HOME_DIR/Library/LaunchAgents/com.manager.daemon.plist"
if [ -f "$PLIST" ]; then
  rm -f "$PLIST" && ok "removed $PLIST"
else
  info "no plist at $PLIST; skipping"
fi

# ---------------- 2. remove MCP entry ---------------------------------------

step "Remove manager MCP entry"
MCP_REMOVED=0
if command -v claude >/dev/null 2>&1; then
  if claude mcp list 2>/dev/null | grep -qE '^manager(\s|:|$)'; then
    if claude mcp remove manager 2>/dev/null; then
      ok "removed manager from claude mcp"
      MCP_REMOVED=1
    else
      warn "'claude mcp remove manager' failed; will try jq fallback"
    fi
  else
    info "manager not registered with claude mcp"
    MCP_REMOVED=1
  fi
fi

if [ "$MCP_REMOVED" = "0" ] && [ -f "$SETTINGS_FILE" ] && command -v jq >/dev/null 2>&1; then
  if jq -e '.mcpServers.manager' "$SETTINGS_FILE" >/dev/null 2>&1; then
    TMP=$(mktemp)
    jq 'if .mcpServers then (.mcpServers |= del(.manager)) else . end
        | if (.mcpServers | length // 0) == 0 then del(.mcpServers) else . end' \
      "$SETTINGS_FILE" > "$TMP" && mv "$TMP" "$SETTINGS_FILE"
    ok "removed mcpServers.manager from $SETTINGS_FILE"
  else
    info "no mcpServers.manager in $SETTINGS_FILE"
  fi
fi

# ---------------- 3. remove hook entries ------------------------------------

step "Remove manager hook entries"
if [ -f "$SETTINGS_FILE" ] && command -v jq >/dev/null 2>&1; then
  # Drop each hook entry whose .hooks[].command points into this repo.
  TMP=$(mktemp)
  jq --arg prefix "$REPO/hooks/" '
    if .hooks then
      .hooks |= with_entries(
        .value |= map(
          .hooks |= map(select((.command // "") | startswith($prefix) | not))
        ) | .value |= map(select((.hooks // []) | length > 0))
      )
      | .hooks |= with_entries(select((.value // []) | length > 0))
      | if (.hooks | length // 0) == 0 then del(.hooks) else . end
    else . end
  ' "$SETTINGS_FILE" > "$TMP" && mv "$TMP" "$SETTINGS_FILE"
  ok "scrubbed manager hooks from $SETTINGS_FILE"
else
  info "no $SETTINGS_FILE or jq; skipping hook scrub"
fi

# ---------------- 4. macOS app ---------------------------------------------

step "Remove $APP_DEST"
if [ -e "$APP_DEST" ]; then
  if confirm "Remove $APP_DEST?"; then
    rm -rf "$APP_DEST" 2>/dev/null \
      && ok "removed $APP_DEST" \
      || warn "could not remove $APP_DEST (permission denied — try sudo rm -rf '$APP_DEST')"
  else
    info "leaving $APP_DEST in place"
  fi
else
  info "$APP_DEST not present"
fi

# ---------------- 5. on-disk state -----------------------------------------

step "Remove ~/.claude/manager state"
STATE_DIR="$HOME_DIR/.claude/manager"
if [ -d "$STATE_DIR" ]; then
  if [ "$PURGE" = "1" ] || confirm "Remove $STATE_DIR (events, memory, db.sqlite)?"; then
    rm -rf "$STATE_DIR" && ok "removed $STATE_DIR"
  else
    info "leaving $STATE_DIR in place"
  fi
else
  info "$STATE_DIR not present"
fi

step "Done"
exit 0

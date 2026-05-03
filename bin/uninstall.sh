#!/usr/bin/env sh
# Dispatch — uninstall.
#
# Reverses bin/install.sh. Idempotent: missing pieces are skipped, not errors.
# Always exits 0 unless something genuinely fails. Cleans up both the v1.2
# canonical names (com.dispatch.daemon, ~/.claude/dispatch) AND the legacy
# v1.1.x names (com.manager.daemon, ~/.claude/manager) so an upgrade-then-
# uninstall doesn't leave junk on disk.
#
# Usage:
#   bash bin/uninstall.sh
#   bash bin/uninstall.sh --yes    # skip confirmation prompts (still asks about
#                                  # /Applications/Dispatch.app and ~/.claude/dispatch)
#   bash bin/uninstall.sh --purge  # also remove the app and on-disk state
#                                  # without prompting

set -u

ASSUME_YES=0
PURGE=0
APP_DEST="/Applications/Dispatch.app"
LEGACY_APP_DEST="/Applications/Manager.app"

for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    --purge) PURGE=1; ASSUME_YES=1 ;;
    --app-dest=*) APP_DEST="${arg#--app-dest=}" ;;
    -h|--help)
      sed -n '2,17p' "$0"
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

# Both labels — current + legacy. Boot out and delete each plist if present.
for LABEL in com.dispatch.daemon com.manager.daemon; do
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    ok "booted out $LABEL"
  else
    info "$LABEL not loaded; skipping bootout"
  fi
done

for PLIST in \
    "$HOME_DIR/Library/LaunchAgents/com.dispatch.daemon.plist" \
    "$HOME_DIR/Library/LaunchAgents/com.manager.daemon.plist"; do
  if [ -f "$PLIST" ]; then
    rm -f "$PLIST" && ok "removed $PLIST"
  else
    info "no plist at $PLIST; skipping"
  fi
done

# ---------------- 2. remove MCP entry ---------------------------------------

step "Remove MCP entries (dispatch + legacy manager)"
MCP_REMOVED_DISPATCH=0
MCP_REMOVED_LEGACY=0
if command -v claude >/dev/null 2>&1; then
  for MCP_NAME in dispatch manager; do
    if claude mcp list 2>/dev/null | grep -qE "^${MCP_NAME}(\s|:|$)"; then
      if claude mcp remove "$MCP_NAME" 2>/dev/null; then
        ok "removed $MCP_NAME from claude mcp"
        if [ "$MCP_NAME" = "dispatch" ]; then MCP_REMOVED_DISPATCH=1; else MCP_REMOVED_LEGACY=1; fi
      else
        warn "'claude mcp remove $MCP_NAME' failed; will try jq fallback"
      fi
    else
      info "$MCP_NAME not registered with claude mcp"
      if [ "$MCP_NAME" = "dispatch" ]; then MCP_REMOVED_DISPATCH=1; else MCP_REMOVED_LEGACY=1; fi
    fi
  done
fi

if [ -f "$SETTINGS_FILE" ] && command -v jq >/dev/null 2>&1; then
  if [ "$MCP_REMOVED_DISPATCH" = "0" ] || [ "$MCP_REMOVED_LEGACY" = "0" ]; then
    if jq -e '.mcpServers.dispatch // .mcpServers.manager' "$SETTINGS_FILE" >/dev/null 2>&1; then
      TMP=$(mktemp)
      jq 'if .mcpServers then (.mcpServers |= (del(.dispatch) | del(.manager))) else . end
          | if (.mcpServers | length // 0) == 0 then del(.mcpServers) else . end' \
        "$SETTINGS_FILE" > "$TMP" && mv "$TMP" "$SETTINGS_FILE"
      ok "scrubbed mcpServers.dispatch / mcpServers.manager from $SETTINGS_FILE"
    else
      info "no mcpServers.dispatch or mcpServers.manager in $SETTINGS_FILE"
    fi
  fi
fi

# ---------------- 3. remove hook entries ------------------------------------

step "Remove dispatch hook entries"
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
  ok "scrubbed dispatch hooks from $SETTINGS_FILE"
else
  info "no $SETTINGS_FILE or jq; skipping hook scrub"
fi

# ---------------- 4. macOS app ---------------------------------------------

step "Remove $APP_DEST"
for APP in "$APP_DEST" "$LEGACY_APP_DEST"; do
  if [ -e "$APP" ]; then
    if confirm "Remove $APP?"; then
      rm -rf "$APP" 2>/dev/null \
        && ok "removed $APP" \
        || warn "could not remove $APP (permission denied — try sudo rm -rf '$APP')"
    else
      info "leaving $APP in place"
    fi
  else
    info "$APP not present"
  fi
done

# ---------------- 5. on-disk state -----------------------------------------

step "Remove ~/.claude/dispatch state (and legacy ~/.claude/manager if present)"
for STATE_DIR in "$HOME_DIR/.claude/dispatch" "$HOME_DIR/.claude/manager"; do
  if [ -d "$STATE_DIR" ]; then
    if [ "$PURGE" = "1" ] || confirm "Remove $STATE_DIR (events, memory, db.sqlite)?"; then
      rm -rf "$STATE_DIR" && ok "removed $STATE_DIR"
    else
      info "leaving $STATE_DIR in place"
    fi
  else
    info "$STATE_DIR not present"
  fi
done

step "Done"
exit 0

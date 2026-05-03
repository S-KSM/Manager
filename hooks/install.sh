#!/usr/bin/env sh
# install.sh — register Dispatch's lifecycle hooks in ~/.claude/settings.json.
#
# Idempotent: re-running won't duplicate entries. Asks for confirmation before
# writing. Requires `jq` for safe JSON merging.

set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
SETTINGS_FILE="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
SETTINGS_DIR=$(dirname "$SETTINGS_FILE")

if ! command -v jq >/dev/null 2>&1; then
  echo "install.sh requires jq. Install it (e.g. 'brew install jq') and retry." >&2
  exit 1
fi

mkdir -p "$SETTINGS_DIR"
if [ ! -f "$SETTINGS_FILE" ]; then
  echo "{}" > "$SETTINGS_FILE"
fi

# Hook scripts and the Claude Code hook event names they bind to.
hook_pairs="
SessionStart:$SCRIPT_DIR/session-start.sh
Stop:$SCRIPT_DIR/stop.sh
PreToolUse:$SCRIPT_DIR/pre-tool-use.sh
PostToolUse:$SCRIPT_DIR/post-tool-use.sh
UserPromptSubmit:$SCRIPT_DIR/user-prompt-submit.sh
"

# Build the desired hooks fragment with jq, then merge into settings.
HOOK_FRAGMENT=$(jq -n '{}')
for pair in $hook_pairs; do
  event=$(printf '%s' "$pair" | cut -d: -f1)
  cmd=$(printf '%s' "$pair" | cut -d: -f2-)
  HOOK_FRAGMENT=$(jq -c \
    --arg event "$event" \
    --arg cmd "$cmd" \
    '. + {($event): [{matcher: ".*", hooks: [{type: "command", command: $cmd}]}]}' \
    <<< "$HOOK_FRAGMENT")
done

# Show a preview and confirm.
echo "About to merge the following into $SETTINGS_FILE:"
printf '%s\n' "$HOOK_FRAGMENT" | jq .
echo
printf 'Proceed? [y/N] '
read -r reply
case "$reply" in
  y|Y|yes|YES) ;;
  *) echo "aborted." ; exit 0 ;;
esac

# Make sure each hook script is executable.
for pair in $hook_pairs; do
  cmd=$(printf '%s' "$pair" | cut -d: -f2-)
  if [ -f "$cmd" ]; then chmod +x "$cmd"; fi
done

# Idempotent merge: replace each event entry, leaving other keys untouched.
TMP=$(mktemp)
jq --argjson hooks "$HOOK_FRAGMENT" \
   '.hooks = ((.hooks // {}) + $hooks)' \
   "$SETTINGS_FILE" > "$TMP"
mv "$TMP" "$SETTINGS_FILE"

echo "wrote $SETTINGS_FILE"
echo "remember to set DISPATCH_WORKSTREAM (and optionally DISPATCH_PORT) in your shell."

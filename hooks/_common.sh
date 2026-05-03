#!/usr/bin/env sh
# _common.sh — shared fail-soft POSTer for Manager hook scripts.
#
# Usage from a hook script:
#   . "$(dirname "$0")/_common.sh"
#   manager_post session-start
#
# Reads the JSON payload Claude Code passes on stdin, augments it with the
# workstream/session env vars, and POSTs to the daemon. Errors never propagate
# out — hooks must never break the agent's loop.

MANAGER_PORT="${MANAGER_PORT:-9876}"
MANAGER_HOST="${MANAGER_HOST:-127.0.0.1}"

# Escape a string for inclusion in a JSON literal value (no surrounding quotes).
# Handles backslash, double-quote, and a couple of common control chars.
manager__json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e ':a;N;$!ba;s/\n/\\n/g' -e 's/\r/\\r/g' -e 's/\t/\\t/g'
}

manager_post() {
  hook_name="$1"
  if [ -z "$hook_name" ]; then
    echo "[manager-hook] missing hook name" >&2
    return 0
  fi

  # Slurp stdin (Claude Code pipes the hook payload as JSON). May be empty.
  payload=""
  if [ ! -t 0 ]; then
    payload=$(cat || true)
  fi
  if [ -z "$payload" ]; then
    payload="{}"
  fi

  workstream="${MANAGER_WORKSTREAM:-default}"
  session="${MANAGER_SESSION_ID:-}"

  # Enrich the payload. Prefer jq for robust JSON merging; fall back to a
  # minimal shell construction that sends a wrapper object on parse failure.
  enriched=""
  if command -v jq >/dev/null 2>&1; then
    enriched=$(printf '%s' "$payload" | jq -c \
      --arg workstream "$workstream" \
      --arg session "$session" \
      --arg hook "$hook_name" \
      '. as $p | (if (type=="object") then $p else {raw: $p} end)
       | .workstream = (.workstream // $workstream)
       | (if ($session|length) > 0 then .session = (.session // $session) else . end)
       | .hook = $hook' 2>/dev/null)
  fi

  if [ -z "$enriched" ]; then
    # No jq, or jq couldn't parse. Build a wrapper object by hand.
    esc_payload=$(manager__json_escape "$payload")
    esc_workstream=$(manager__json_escape "$workstream")
    esc_session=$(manager__json_escape "$session")
    esc_hook=$(manager__json_escape "$hook_name")
    if [ -n "$esc_session" ]; then
      enriched=$(printf '{"workstream":"%s","session":"%s","hook":"%s","raw":"%s"}' \
        "$esc_workstream" "$esc_session" "$esc_hook" "$esc_payload")
    else
      enriched=$(printf '{"workstream":"%s","hook":"%s","raw":"%s"}' \
        "$esc_workstream" "$esc_hook" "$esc_payload")
    fi
  fi

  url="http://${MANAGER_HOST}:${MANAGER_PORT}/hooks/${hook_name}"
  # Fail-soft: -s silences progress, --max-time 1 prevents hanging the agent
  # if the daemon is down. Errors logged to stderr and swallowed.
  if ! curl -s --max-time 1 -X POST "$url" \
        -H 'content-type: application/json' \
        -d "$enriched" >/dev/null 2>&1; then
    echo "[manager-hook] $hook_name: daemon unreachable at $url" >&2
  fi
  # Always succeed.
  return 0
}

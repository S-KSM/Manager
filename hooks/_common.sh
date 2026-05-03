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

# manager_get <path> — GET against the Manager daemon. Mirrors manager_post's
# fail-soft discipline: curl -s --max-time 1, never blocks the agent. Prints
# the response body on stdout when curl reports success; returns non-zero on
# transport failure (caller should treat that as "no data, do nothing").
manager_get() {
  path="$1"
  if [ -z "$path" ]; then
    echo "[manager-hook] manager_get: missing path" >&2
    return 1
  fi
  url="http://${MANAGER_HOST}:${MANAGER_PORT}${path}"
  body=$(curl -s --max-time 1 "$url" 2>/dev/null) || {
    echo "[manager-hook] GET $url: transport error" >&2
    return 1
  }
  printf '%s' "$body"
  return 0
}

# manager_post_json <path> <body> — POST a pre-built JSON body. Same fail-soft
# discipline as manager_post but skips the stdin/enrichment step. Used for
# small machine-built requests like the intervention ack.
manager_post_json() {
  path="$1"
  body="$2"
  if [ -z "$path" ]; then
    echo "[manager-hook] manager_post_json: missing path" >&2
    return 1
  fi
  url="http://${MANAGER_HOST}:${MANAGER_PORT}${path}"
  if ! curl -s --max-time 1 -X POST "$url" \
        -H 'content-type: application/json' \
        -d "$body" >/dev/null 2>&1; then
    echo "[manager-hook] POST $url: daemon unreachable" >&2
    return 1
  fi
  return 0
}

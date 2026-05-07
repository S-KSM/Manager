#!/usr/bin/env sh
# _common.sh — shared fail-soft POSTer for Dispatch hook scripts.
#
# Usage from a hook script:
#   . "$(dirname "$0")/_common.sh"
#   dispatch_post session-start
#
# Reads the JSON payload Claude Code passes on stdin, augments it with the
# workstream/session env vars, and POSTs to the daemon. Errors never propagate
# out — hooks must never break the agent's loop.

DISPATCH_PORT="${DISPATCH_PORT:-9876}"
DISPATCH_HOST="${DISPATCH_HOST:-127.0.0.1}"

# Escape a string for inclusion in a JSON literal value (no surrounding quotes).
# Handles backslash, double-quote, and a couple of common control chars.
dispatch__json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e ':a;N;$!ba;s/\n/\\n/g' -e 's/\r/\\r/g' -e 's/\t/\\t/g'
}

# Slugify a string into a workstream id: lowercase, non-[a-z0-9-] → '-',
# collapse repeated '-', trim leading/trailing '-'. Empty result → 'default'.
dispatch__slugify() {
  out=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -e 's/[^a-z0-9-]/-/g' -e 's/-\{2,\}/-/g' -e 's/^-//' -e 's/-$//')
  if [ -z "$out" ]; then
    out="default"
  fi
  printf '%s' "$out"
}

# Derive a workstream id when DISPATCH_WORKSTREAM isn't set.
# 1) git repo basename if inside a git work tree, else
# 2) basename of $PWD.
# Slugified per `dispatch__slugify` rules.
derive_workstream() {
  ws="${DISPATCH_WORKSTREAM:-}"
  if [ -n "$ws" ]; then
    printf '%s' "$ws"
    return 0
  fi
  root=$(git rev-parse --show-toplevel 2>/dev/null || true)
  if [ -n "$root" ]; then
    src=$(basename "$root")
    reason="git-root"
  else
    src=$(basename "$PWD")
    reason="cwd"
  fi
  slug=$(dispatch__slugify "$src")
  if [ "${DISPATCH_DEBUG:-}" = "1" ]; then
    echo "[dispatch-hook] workstream auto-derived as '$slug' from $reason ($src)" >&2
  fi
  printf '%s' "$slug"
}

dispatch_post() {
  hook_name="$1"
  if [ -z "$hook_name" ]; then
    echo "[dispatch-hook] missing hook name" >&2
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

  workstream=$(derive_workstream)
  session="${DISPATCH_SESSION_ID:-}"

  # Enrich the payload. Prefer jq for robust JSON merging; fall back to a
  # minimal shell construction that sends a wrapper object on parse failure.
  # Claude Code's hook payload uses `session_id`; honor it first, then `session`,
  # then DISPATCH_SESSION_ID env var.
  enriched=""
  if command -v jq >/dev/null 2>&1; then
    enriched=$(printf '%s' "$payload" | jq -c \
      --arg workstream "$workstream" \
      --arg session "$session" \
      --arg hook "$hook_name" \
      '. as $p | (if (type=="object") then $p else {raw: $p} end)
       | .workstream = (.workstream // $workstream)
       | (.session_id // .session // $session) as $sid
       | (if ($sid|length) > 0 then .session = $sid else . end)
       | .hook = $hook' 2>/dev/null)
  fi

  if [ -z "$enriched" ]; then
    # No jq, or jq couldn't parse. Build a wrapper object by hand.
    esc_payload=$(dispatch__json_escape "$payload")
    esc_workstream=$(dispatch__json_escape "$workstream")
    esc_session=$(dispatch__json_escape "$session")
    esc_hook=$(dispatch__json_escape "$hook_name")
    if [ -n "$esc_session" ]; then
      enriched=$(printf '{"workstream":"%s","session":"%s","hook":"%s","raw":"%s"}' \
        "$esc_workstream" "$esc_session" "$esc_hook" "$esc_payload")
    else
      enriched=$(printf '{"workstream":"%s","hook":"%s","raw":"%s"}' \
        "$esc_workstream" "$esc_hook" "$esc_payload")
    fi
  fi

  url="http://${DISPATCH_HOST}:${DISPATCH_PORT}/hooks/${hook_name}"
  # Fail-soft: -s silences progress, --max-time 1 prevents hanging the agent
  # if the daemon is down. Errors logged to stderr and swallowed.
  if ! curl -s --max-time 1 -X POST "$url" \
        -H 'content-type: application/json' \
        -d "$enriched" >/dev/null 2>&1; then
    echo "[dispatch-hook] $hook_name: daemon unreachable at $url" >&2
  fi
  # Always succeed.
  return 0
}

# dispatch_get <path> — GET against the Dispatch daemon. Mirrors dispatch_post's
# fail-soft discipline: curl -s --max-time 1, never blocks the agent. Prints
# the response body on stdout when curl reports success; returns non-zero on
# transport failure (caller should treat that as "no data, do nothing").
dispatch_get() {
  path="$1"
  if [ -z "$path" ]; then
    echo "[dispatch-hook] dispatch_get: missing path" >&2
    return 1
  fi
  url="http://${DISPATCH_HOST}:${DISPATCH_PORT}${path}"
  body=$(curl -s --max-time 1 "$url" 2>/dev/null) || {
    echo "[dispatch-hook] GET $url: transport error" >&2
    return 1
  }
  printf '%s' "$body"
  return 0
}

# dispatch_post_json <path> <body> — POST a pre-built JSON body. Same fail-soft
# discipline as dispatch_post but skips the stdin/enrichment step. Used for
# small machine-built requests like the intervention ack.
dispatch_post_json() {
  path="$1"
  body="$2"
  if [ -z "$path" ]; then
    echo "[dispatch-hook] dispatch_post_json: missing path" >&2
    return 1
  fi
  url="http://${DISPATCH_HOST}:${DISPATCH_PORT}${path}"
  if ! curl -s --max-time 1 -X POST "$url" \
        -H 'content-type: application/json' \
        -d "$body" >/dev/null 2>&1; then
    echo "[dispatch-hook] POST $url: daemon unreachable" >&2
    return 1
  fi
  return 0
}

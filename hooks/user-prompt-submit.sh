#!/usr/bin/env sh
# Manager hook: UserPromptSubmit.
#
# v0   — POST the hook event to the daemon.
# v0.5 — also drain the per-workstream intervention queue and emit pending
#        nudges/redirects/rollbacks as Claude Code `additionalContext` so the
#        agent sees them on this turn.
#
# Wire contract (see docs/ARCHITECTURE.md, "Intervention" + endpoint table):
#   GET  /workstreams/<id>/interventions/pending   -> array of Intervention
#   POST /workstreams/<id>/interventions/ack       body {"ids":[...]}
#
# Always exits 0. The drain feature requires `jq`; without it the hook
# silently degrades to v0 behavior (notify-only).

set -u
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
. "$SCRIPT_DIR/_common.sh"

# 1. Existing v0 behavior: notify the daemon. manager_post slurps stdin, so
#    the drain logic below must not depend on stdin.
manager_post user-prompt-submit

# 2. Drain pending interventions. Requires jq; degrade gracefully without it.
if ! command -v jq >/dev/null 2>&1; then
  echo "[manager-hook] user-prompt-submit: jq not found; skipping intervention drain" >&2
  exit 0
fi

workstream="${MANAGER_WORKSTREAM:-default}"

# Optional debug knob: feed a canned pending-array via env var instead of
# hitting the daemon. Useful for unit-style smoke tests when Track A's
# endpoints aren't wired up yet.
if [ -n "${MANAGER_TEST_PENDING_JSON:-}" ]; then
  pending="$MANAGER_TEST_PENDING_JSON"
else
  pending=$(manager_get "/workstreams/${workstream}/interventions/pending") || exit 0
fi

# Empty body or non-JSON: nothing to do. jq -e returns non-zero on parse
# error or null/empty array, which is the "no work" signal.
if [ -z "$pending" ]; then
  exit 0
fi

# Reject if not a JSON array. (Daemon returns [] when nothing pending; jq's
# `type` check covers malformed bodies too.)
if ! printf '%s' "$pending" | jq -e 'type == "array" and length > 0' >/dev/null 2>&1; then
  exit 0
fi

# 3. Build the labeled blocks. One block per intervention, separated by a
#    blank line. Rollback adds a framing line referencing the decision id.
combined=$(printf '%s' "$pending" | jq -r '
  def block:
    .kind as $kind
    | (.payload.message // "") as $msg
    | if $kind == "rollback" then
        "## Manager intervention (rollback)\n"
        + "We are returning to decision `\(.payload.rollback_to_decision_id // "?")` and reconsidering from there.\n"
        + (if ($msg | length) > 0 then "Hint from the manager: \($msg)" else "" end)
      else
        "## Manager intervention (\($kind))\n\($msg)"
      end;
  map(block) | join("\n\n")
') || exit 0

if [ -z "$combined" ]; then
  exit 0
fi

# 4. Emit Claude Code's UserPromptSubmit hook output JSON on stdout.
#    Shape (4.x canonical): {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}
emitted=$(printf '%s' "$combined" | jq -Rs '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: .
  }
}')

if [ -z "$emitted" ]; then
  exit 0
fi

printf '%s\n' "$emitted"

# 5. Ack delivery. Best-effort: if this fails the agent has the context this
#    turn already; the next turn may re-emit (acceptable v0.5 trade-off).
ids_body=$(printf '%s' "$pending" | jq -c '{ids: [.[].id]}') || exit 0
manager_post_json "/workstreams/${workstream}/interventions/ack" "$ids_body" || true

# 6. Always succeed.
exit 0

#!/usr/bin/env sh
# Manager hook: UserPromptSubmit.
#
# v0     — POST the hook event to the daemon.
# v0.5   — also drain the per-workstream intervention queue and emit pending
#          nudges/redirects/rollbacks as Claude Code `additionalContext` so the
#          agent sees them on this turn.
# v0.5.1 — for rollback interventions, additionally GET the original decision
#          and inline its `considered` / `choice` / `rationale` / `confidence`
#          into the frame. Lookup miss falls back to the v0.5 thin frame.
#
# Wire contract (see docs/ARCHITECTURE.md, "Intervention" + endpoint table):
#   GET  /workstreams/<id>/interventions/pending     -> array of Intervention
#   POST /workstreams/<id>/interventions/ack         body {"ids":[...]}
#   GET  /workstreams/<id>/decisions/<decisionId>    -> decision event envelope
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

# 3. Pre-pass: for each rollback intervention, look up the original decision
#    via Track A's GET /workstreams/<id>/decisions/<decisionId> endpoint and
#    attach it as a `_decision` field. Lookup failures (transport, 404,
#    malformed body) leave `_decision` absent, which the formatter treats as
#    "fall back to the v0.5 thin frame for this rollback".
augmented=$(printf '%s' "$pending" | jq -c '.[]' 2>/dev/null | (
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    kind=$(printf '%s' "$line" | jq -r '.kind // ""' 2>/dev/null)
    if [ "$kind" = "rollback" ]; then
      dec_id=$(printf '%s' "$line" | jq -r '.payload.rollback_to_decision_id // empty' 2>/dev/null)
      if [ -n "$dec_id" ]; then
        decision=$(manager_get "/workstreams/${workstream}/decisions/${dec_id}" 2>/dev/null) || decision=""
        # Validate: must be a JSON object with at least one of considered/choice/
        # rationale/confidence under .payload. This rejects empty bodies, 404
        # error envelopes like {"error":"..."}, and malformed responses.
        if [ -n "$decision" ] && printf '%s' "$decision" | jq -e '
              type == "object"
              and (.payload // null) != null
              and (
                ((.payload.considered // null) != null)
                or ((.payload.choice // null) != null)
                or ((.payload.rationale // null) != null)
                or ((.payload.confidence // null) != null)
              )
            ' >/dev/null 2>&1; then
          enriched_line=$(printf '%s' "$line" | jq -c --argjson d "$decision" '. + {_decision: $d}' 2>/dev/null)
          if [ -n "$enriched_line" ]; then
            printf '%s\n' "$enriched_line"
          else
            printf '%s\n' "$line"
          fi
        else
          printf '%s\n' "$line"
        fi
      else
        printf '%s\n' "$line"
      fi
    else
      printf '%s\n' "$line"
    fi
  done
) | jq -s '.' 2>/dev/null)

# If pre-pass yielded nothing parseable, fall back to the original pending
# array so we still emit v0.5 thin frames.
if [ -z "$augmented" ] || ! printf '%s' "$augmented" | jq -e 'type == "array"' >/dev/null 2>&1; then
  augmented="$pending"
fi

# 4. Build the labeled blocks. One block per intervention, separated by a
#    blank line. Rollback uses the enriched `_decision` when present, else
#    falls back to the v0.5 thin frame.
combined=$(printf '%s' "$augmented" | jq -r '
  def block:
    .kind as $kind
    | (.payload.message // "") as $msg
    | (._decision // null) as $d
    | if $kind == "rollback" then
        "## Manager intervention (rollback)\n"
        + "We are returning to decision `\(.payload.rollback_to_decision_id // "?")` and reconsidering from there."
        + (if $d != null
              and (($d.payload.considered // []) | type == "array")
              and (($d.payload.considered // []) | length) > 0 then
             "\n\n### Originally considered\n"
             + (
                 ($d.payload.choice // "") as $choice
                 | ($d.payload.considered // [])
                 | map("- " + . + (if . == $choice and ($choice | length) > 0 then " (chosen)" else "" end))
                 | join("\n")
               )
           else "" end)
        + (if $d != null and (($d.payload.rationale // "") | length) > 0 then
             "\n\n### Original rationale\n" + $d.payload.rationale
           else "" end)
        + (if $d != null and ($d.payload.confidence // null) != null then
             "\n\n### Original confidence\n"
             + ((($d.payload.confidence) * 100) | round | tostring) + "%"
           else "" end)
        + (if $d != null then
             (if ($msg | length) > 0 then
                "\n\n### Hint from the manager\n" + $msg
              else "" end)
           else
             # v0.5 thin frame fallback (no decision lookup): preserve the
             # original single-line "Hint from the manager: <msg>" form.
             (if ($msg | length) > 0 then
                "\n" + "Hint from the manager: " + $msg
              else "" end)
           end)
      else
        "## Manager intervention (\($kind))\n\($msg)"
      end;
  map(block) | join("\n\n")
') || exit 0

if [ -z "$combined" ]; then
  exit 0
fi

# 5. Emit Claude Code's UserPromptSubmit hook output JSON on stdout.
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

# 6. Ack delivery. Best-effort: if this fails the agent has the context this
#    turn already; the next turn may re-emit (acceptable v0.5 trade-off).
ids_body=$(printf '%s' "$pending" | jq -c '{ids: [.[].id]}') || exit 0
manager_post_json "/workstreams/${workstream}/interventions/ack" "$ids_body" || true

# 7. Always succeed.
exit 0

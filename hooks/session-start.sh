#!/usr/bin/env sh
# Dispatch hook: SessionStart.
#
# 1. Notifies the daemon that a Claude Code session attached to a workstream.
# 2. v0.5.2 — advertises the dispatch MCP tools (emit_decision, update_memory, …).
# 3. v1   — also inlines the team handbook so promoted skills propagate to every
#           agent on its next session_start. Capped at 8 KB to stay polite to
#           context windows; truncated handbooks get a footer pointing at the
#           full document.
#
# Always exits 0. Skips the system-prompt nudge if DISPATCH_WORKSTREAM
# (or legacy MANAGER_WORKSTREAM) is unset or jq isn't available
# (degrade silently — never break the agent loop).

set -u
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
. "$SCRIPT_DIR/_common.sh"

HANDBOOK_MAX_BYTES=8192

# 1. v0 behavior: notify the daemon. dispatch_post slurps stdin.
dispatch_post session-start

# 2. SessionStart system-prompt nudge. Only emit if we know which workstream
#    the session belongs to AND we have jq for safe JSON encoding.
WS_FOR_NUDGE=$(dispatch__legacy_env DISPATCH_WORKSTREAM MANAGER_WORKSTREAM)
if [ -z "$WS_FOR_NUDGE" ]; then
  exit 0
fi
if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

# Tools section — describes the MCP surface available to the agent.
TOOLS=$(cat <<'EOF'
You are running inside a Dispatch-supervised session.

You have dispatch MCP tools available:
- emit_decision(considered, choice, rationale, confidence, parent_id?) — call at every non-trivial fork. The methodology timeline is built from these.
- emit_subgoal(goal, parent_id?) and (implicit pop on session_end) — push a sub-goal when you start a focused effort.
- emit_confidence(value, note?) — adjust confidence outside a decision.
- flag_blocked(reason) — escalate to the human dispatcher when stuck.
- update_memory(section, content) — write into the workstream Markdown memory whenever you learn something a future session of this workstream should know.
- read_memory(section?) — read it back; call this once early in the session to recover prior context.
- propose_skill(title, body, source_decision_id?) — propose a pattern for promotion to the team handbook. The dispatcher curates which proposals get adopted.

Use these tools liberally. They cost almost nothing and turn opaque transcripts into a methodology the human can review and intervene on.
EOF
)

# Handbook section — pull from the daemon, cap at HANDBOOK_MAX_BYTES, append a
# truncation footer if needed. Soft-fails: if the daemon is unreachable or the
# handbook is empty, this section is omitted entirely.
HANDBOOK_BODY=$(dispatch_get /handbook 2>/dev/null || true)
HANDBOOK_SECTION=""
if [ -n "$HANDBOOK_BODY" ]; then
  HANDBOOK_LEN=$(printf '%s' "$HANDBOOK_BODY" | wc -c | tr -d ' ')
  if [ "${HANDBOOK_LEN:-0}" -gt "$HANDBOOK_MAX_BYTES" ]; then
    HANDBOOK_BODY=$(printf '%s' "$HANDBOOK_BODY" | dd bs=1 count=$HANDBOOK_MAX_BYTES 2>/dev/null)
    HANDBOOK_BODY="${HANDBOOK_BODY}

(…older sections truncated; fetch the full handbook with read_memory or GET /handbook)"
  fi
  HANDBOOK_SECTION="

---

# Team handbook (promoted skills shared across all workstreams)

$HANDBOOK_BODY"
fi

NUDGE="$TOOLS$HANDBOOK_SECTION"

emitted=$(printf '%s' "$NUDGE" | jq -Rs '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: .
  }
}' 2>/dev/null) || exit 0

if [ -n "$emitted" ]; then
  printf '%s\n' "$emitted"
fi

exit 0

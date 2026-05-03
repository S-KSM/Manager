#!/usr/bin/env sh
# Manager hook: SessionStart.
#
# 1. Notifies the daemon that a Claude Code session attached to a workstream.
# 2. v0.5.2 — emits a `hookSpecificOutput.additionalContext` paragraph so the
#    agent learns it has manager MCP tools (emit_decision, update_memory, ...)
#    and when to use them. Mirrors the emit shape used by user-prompt-submit.sh.
#
# Always exits 0. Skips the system-prompt nudge if MANAGER_WORKSTREAM is unset
# or jq isn't available (degrade silently — never break the agent loop).

set -u
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
. "$SCRIPT_DIR/_common.sh"

# 1. v0 behavior: notify the daemon. manager_post slurps stdin.
manager_post session-start

# 2. SessionStart system-prompt nudge. Only emit if we know which workstream
#    the session belongs to AND we have jq for safe JSON encoding.
if [ -z "${MANAGER_WORKSTREAM:-}" ]; then
  exit 0
fi
if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

# Heredoc keeps the prose readable. jq -Rs slurps stdin into a JSON string,
# then wraps it in the canonical Claude Code 4.x hookSpecificOutput envelope.
NUDGE=$(cat <<'EOF'
You are running inside a Manager-supervised session.

You have manager MCP tools available:
- emit_decision(considered, choice, rationale, confidence, parent_id?) — call at every non-trivial fork. The methodology timeline is built from these.
- emit_subgoal(goal, parent_id?) and (implicit pop on session_end) — push a sub-goal when you start a focused effort.
- emit_confidence(value, note?) — adjust confidence outside a decision.
- flag_blocked(reason) — escalate to the human VP when stuck.
- update_memory(section, content) — write into the workstream Markdown memory whenever you learn something a future session of this workstream should know.
- read_memory(section?) — read it back; call this once early in the session to recover prior context.

Use these tools liberally. They cost almost nothing and turn opaque transcripts into a methodology the human can review and intervene on.
EOF
)

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

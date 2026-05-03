# Manager Hooks

POSIX shell hooks that Claude Code runs at session lifecycle events. Each one POSTs the hook payload to the running Manager daemon. They are **fail-soft**: if the daemon isn't running, they log to stderr and exit 0 — they never block the agent's loop.

See [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) for the event contract.

## What each hook captures

| Script | Claude Code event | Daemon event type | What lands in the store |
|---|---|---|---|
| `session-start.sh` | `SessionStart` | `session_start` | Workstream + session id, hook payload (cwd, etc.). Also registers the session in SQLite. |
| `stop.sh` | `Stop` | `session_end` | Marks session ended in SQLite. |
| `pre-tool-use.sh` | `PreToolUse` | `tool_use` | Tool name + inputs (low-fidelity activity). |
| `post-tool-use.sh` | `PostToolUse` | `tool_use` | Tool name + outputs/result. |
| `user-prompt-submit.sh` | `UserPromptSubmit` | `tool_use` (v0); `intervention_delivered` (v0.5) | v0: just records the event. v0.5: also drains the intervention queue (see below). v0.5.1: rollbacks inline the original decision context. |

## Install

```sh
bash hooks/install.sh
```

Requires `jq`. The script:

1. Creates `~/.claude/settings.json` if needed.
2. Shows the JSON it will merge under `.hooks`.
3. Asks for confirmation.
4. `chmod +x` each script and merges idempotently. Re-running replaces the manager entries cleanly without duplicating.

Override the settings file with `CLAUDE_SETTINGS=/path/to/settings.json bash hooks/install.sh` (useful for testing).

## Configure

The hooks read these env vars at runtime — set them in your shell **before** launching Claude Code:

| Var | Default | Purpose |
|---|---|---|
| `MANAGER_WORKSTREAM` | `default` | Which workstream this session belongs to. **Always set this.** |
| `MANAGER_SESSION_ID` | _(absent)_ | Optional explicit session id. |
| `MANAGER_PORT` | `9876` | Daemon HTTP port. |
| `MANAGER_HOST` | `127.0.0.1` | Daemon HTTP host. Useful only if you bind to a non-localhost interface (v1.5). |

### Pointing at a non-default port

```sh
export MANAGER_PORT=9000
export MANAGER_WORKSTREAM=frontend-refactor
```

The hooks pick these up on every invocation. No reinstall needed.

## SessionStart system-prompt nudge

`session-start.sh` does three things:

1. POSTs the SessionStart hook payload to the daemon (v0 behavior — registers the session under the workstream).
2. v0.5.2 — emits Claude Code's `hookSpecificOutput.additionalContext` JSON on stdout. The first part of the additionalContext advertises the manager MCP tools (`emit_decision`, `emit_subgoal`, `emit_confidence`, `flag_blocked`, `update_memory`, `read_memory`, `propose_skill`) and when to use them — turns the MCP wiring from "available" into "actually used".
3. v1 — also fetches the team handbook (`GET /handbook`) and inlines it as a second section of the additionalContext, so promoted skills propagate to every agent on its next session_start. The handbook body is capped at **8 KB**; longer handbooks are truncated with a footer pointing the agent at `read_memory` / `GET /handbook` for the full text.

**When it fires:** every SessionStart that has `MANAGER_WORKSTREAM` set in the environment AND `jq` available. Without either, the hook silently degrades to v0 behavior (notify-only). The handbook section is omitted automatically if the daemon is unreachable or the handbook is empty. Always exits 0.

**Output shape on success** (canonical Claude Code 4.x form):

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "You are running inside a Manager-supervised session.\n\nYou have manager MCP tools available:\n...\n\n---\n\n# Team handbook (promoted skills shared across all workstreams)\n\n# Team handbook\n\n## react-query mutation pattern\n..."
  }
}
```

The full text of the tools advertisement and the handbook formatting live in `session-start.sh`. The 8 KB cap is `HANDBOOK_MAX_BYTES` at the top of the script.

## v0.5 — UserPromptSubmit intervention drain

On every user prompt, after notifying the daemon, `user-prompt-submit.sh` also drains the per-workstream intervention queue so a human nudge / redirect / rollback typed in the macOS app shows up as `additionalContext` on the next agent turn.

**Endpoints called:**

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/workstreams/<MANAGER_WORKSTREAM>/interventions/pending` | Array of pending Intervention rows. Does not mutate. |
| `POST` | `/workstreams/<MANAGER_WORKSTREAM>/interventions/ack` | Body `{"ids":[...]}` — marks the listed interventions delivered. Best-effort. |

**stdout shape on success** (canonical Claude Code 4.x form):

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "## Manager intervention (nudge)\nconsider whether react-query handles offline\n\n## Manager intervention (rollback)\nWe are returning to decision `dec_05` and reconsidering from there.\nHint from the manager: try the SWR path"
  }
}
```

When nothing is pending, when the daemon is unreachable, or when the body isn't a non-empty JSON array, the hook prints nothing on stdout and still exits 0.

In v0.5.1 the rollback block grows additional H3 subsections when the decision lookup hits — see "Enriched rollback frame" below.

**Per-kind block format:**

- `nudge` / `redirect`:
  ```
  ## Manager intervention (<kind>)
  <payload.message>
  ```
- `rollback` (v0.5 thin frame — also used in v0.5.1 when the decision lookup misses):
  ```
  ## Manager intervention (rollback)
  We are returning to decision `<payload.rollback_to_decision_id>` and reconsidering from there.
  Hint from the manager: <payload.message>
  ```

Blocks are concatenated with a blank line between them and the whole thing becomes the `additionalContext` string.

## v0.5.1 — enriched rollback frame

When a `rollback` intervention is in the pending list, `user-prompt-submit.sh` now does an extra fail-soft GET against:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/workstreams/<MANAGER_WORKSTREAM>/decisions/<rollback_to_decision_id>` | Returns the full decision event envelope (`{ts, workstream_id, session_id, type, id, parent_id, payload: {considered, choice, rationale, confidence}}`). |

Uses `manager_get` from `_common.sh` (same `curl -s --max-time 1` discipline as everything else). On lookup hit, the rollback block expands from the v0.5 thin form to:

```
## Manager intervention (rollback)
We are returning to decision `dec_07` and reconsidering from there.

### Originally considered
- option A
- option B (chosen)
- option C

### Original rationale
because Y

### Original confidence
72%

### Hint from the manager
try the SWR path
```

Section rules:

- The `(chosen)` marker is appended to whichever `considered` entry equals `payload.choice` (string match).
- Confidence is rendered as `round(value * 100)%`. Section is omitted entirely when confidence is null/missing.
- `### Originally considered` is omitted when `considered` is missing or empty (older decision events).
- `### Original rationale` is omitted when rationale is empty/missing.
- `### Hint from the manager` is omitted when the rollback intervention's `payload.message` is empty.

**Lookup miss / failure.** If the GET fails for any reason — transport error, 404, or a body that doesn't look like a decision envelope — the hook falls back to the v0.5 thin frame for that one rollback (other interventions in the same pending array are unaffected). Failure is silent on stdout; transport errors land on stderr only.

**Before / after.** Same pending row `{kind:"rollback", payload:{rollback_to_decision_id:"dec_07", message:"try the SWR path"}}`:

- v0.5: 3 lines (`##` header, framing line, `Hint from the manager: …`).
- v0.5.1 with lookup hit: 4 H3 subsections inlined between framing and hint, hint promoted to its own `### Hint from the manager` H3.
- v0.5.1 with lookup miss: identical to v0.5.

Nudge and redirect frames are unchanged in v0.5.1.

**Duplicate context risk.** Pending-list and ack are separate calls. If the GET succeeds but the ack POST fails (rare — daemon flapping mid-turn), the same intervention will be re-emitted on the next turn. We accept this in v0.5: better duplicated context than silently dropped guidance. v1 may add a per-turn idempotency token if it shows up in practice.

**`jq` dependency.** The drain feature shells out to `jq` for safe JSON parsing and emission. Without `jq` the hook logs a warning to stderr and degrades to v0 behavior (notify only). `install.sh` already requires `jq`, so a normally-installed setup has it.

**Debug knob.** Set `MANAGER_TEST_PENDING_JSON='[{"id":"int_1","kind":"nudge","payload":{"message":"hi"}}]'` to bypass the GET and feed canned data — handy for verifying formatting offline.

## Manual smoke test

With the daemon running:

```sh
echo '{"cwd":"/tmp"}' | MANAGER_WORKSTREAM=demo MANAGER_SESSION_ID=sess-1 \
  hooks/session-start.sh
curl -s "http://127.0.0.1:9876/workstreams/demo/events" | jq .
```

For the v0.5 drain:

```sh
# enqueue a nudge against a registered workstream
curl -s -X POST localhost:9876/interventions \
  -H 'content-type: application/json' \
  -d '{"workstream_id":"demo","kind":"nudge","payload":{"message":"check offline case"}}'

# run the hook; stdout should be a single JSON object with additionalContext
MANAGER_WORKSTREAM=demo sh hooks/user-prompt-submit.sh < /dev/null | jq .

# pending is now empty (acked)
curl -s localhost:9876/workstreams/demo/interventions/pending
```

## Uninstall

Easiest path: run the repo-level uninstaller, which scrubs the manager hook entries (and the launchd agent and MCP wiring) in one pass:

```sh
bash bin/uninstall.sh
```

If you want to leave everything else alone and only remove the hook entries, edit `~/.claude/settings.json` by hand and drop any `hooks[].hooks[]` whose `command` points into this repo's `hooks/` directory.

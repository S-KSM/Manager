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
| `user-prompt-submit.sh` | `UserPromptSubmit` | `tool_use` (v0); `intervention_delivered` (v0.5) | v0: just records the event. v0.5: also drains the intervention queue (see below). |

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

**Per-kind block format:**

- `nudge` / `redirect`:
  ```
  ## Manager intervention (<kind>)
  <payload.message>
  ```
- `rollback`:
  ```
  ## Manager intervention (rollback)
  We are returning to decision `<payload.rollback_to_decision_id>` and reconsidering from there.
  Hint from the manager: <payload.message>
  ```

Blocks are concatenated with a blank line between them and the whole thing becomes the `additionalContext` string.

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

Edit `~/.claude/settings.json` and remove the entries under `.hooks`. There is no automated uninstaller in v0.

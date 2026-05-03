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
| `user-prompt-submit.sh` | `UserPromptSubmit` | `tool_use` (v0); `intervention_delivered` (v0.5) | v0: just records the event. v0.5: also drains the intervention queue. |

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

## Manual smoke test

With the daemon running:

```sh
echo '{"cwd":"/tmp"}' | MANAGER_WORKSTREAM=demo MANAGER_SESSION_ID=sess-1 \
  hooks/session-start.sh
curl -s "http://127.0.0.1:9876/workstreams/demo/events" | jq .
```

## Uninstall

Edit `~/.claude/settings.json` and remove the entries under `.hooks`. There is no automated uninstaller in v0.

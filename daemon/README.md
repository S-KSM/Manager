# Manager Daemon

Local long-running process: hosts the MCP server agents call into and the HTTP/WebSocket API clients (the macOS app today, mobile/web later) read from. All persistent state — events, memory, queues — lives here.

See [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) for the full data model and event schema.

## Requirements

- Node.js ≥ 20 (developed against Node 24)
- npm 10+

## Install and build

```sh
cd daemon
npm install
npm run build
```

This produces `dist/index.js`. The package also exposes a `manager` bin once linked.

## Run

Two modes, two processes:

```sh
# Long-running daemon: HTTP/WS API for the macOS client. Started at login by
# the launchd agent that bin/install.sh installs.
node dist/index.js start

# Per-session MCP stdio server. What Claude Code launches each session via
# its `mcpServers` config (see "Wiring MCP to Claude Code" below). Binds NO
# HTTP port — shares on-disk state with the long-running daemon via SQLite
# WAL + JSONL append.
node dist/index.js mcp

# Legacy / testing only: HTTP + MCP in the same process. Will fight for the
# port if a long-running daemon is already up. Prefer `mcp` above.
node dist/index.js start --mcp-stdio
```

State is written to `~/.claude/manager/` by default:

```
~/.claude/manager/
  events/<workstream>.jsonl     append-only event log per workstream
  memory/<workstream>.md        agent-owned markdown memory
  queues/<workstream>.jsonl     intervention queue (v0.5)
  db.sqlite                     workstream + session registry
```

## Configure

| Env var | Default | Purpose |
|---|---|---|
| `MANAGER_PORT` | `9876` | HTTP/WebSocket port. |
| `MANAGER_HOME` | `~/.claude/manager` | State directory. |
| `MANAGER_WORKSTREAM` | `default` | Workstream a Claude Code session belongs to. Hooks and the MCP server read this. |
| `MANAGER_SESSION_ID` | _(unset)_ | Override the session id; otherwise hooks supply one. |

## CLI

```sh
node dist/index.js start                       # boot the long-running daemon (HTTP/WS)
node dist/index.js mcp                         # MCP stdio only (per-session, what Claude Code launches)
node dist/index.js register <id> <title>       # create a workstream
node dist/index.js list                        # tabulate workstreams
node dist/index.js attach <workstream-id>      # print env vars for a session
```

## Wiring MCP to Claude Code

The `manager mcp` subcommand is the production wiring. Register it once, user-scoped, so every Claude Code session gets the manager tools:

```sh
claude mcp add manager --scope user -- node /absolute/path/to/manager/daemon/dist/index.js mcp
```

`bin/install.sh` does this automatically. After it lands, the agent has the following tools available in every session:

| Tool | Purpose |
|---|---|
| `emit_decision(considered, choice, rationale, confidence, parent_id?)` | Structured decision point — the unit the methodology timeline is built from. |
| `emit_subgoal(goal, parent_id?)` | Push a sub-goal. |
| `emit_confidence(value, note?)` | Spot-update confidence outside a decision. |
| `flag_blocked(reason)` | Escalate to the human VP when stuck. |
| `update_memory(section, content)` | Write into the workstream Markdown memory. |
| `read_memory(section?)` | Read it back. |

Before launching `claude` in a project, set `MANAGER_WORKSTREAM` so the MCP server knows which workstream to write into:

```sh
export MANAGER_WORKSTREAM=my-proj
claude
```

The `SessionStart` hook (installed by `hooks/install.sh`) emits an `additionalContext` paragraph each session telling the agent it has these tools and when to use them.

## HTTP API (v0)

| Method | Path | Notes |
|---|---|---|
| GET | `/workstreams` | list all |
| POST | `/workstreams` | `{id, title}` |
| GET | `/workstreams/:id` | detail, includes sessions |
| GET | `/workstreams/:id/memory` | markdown memory |
| GET | `/workstreams/:id/events` | full event log (`?since=<bytes>` for tail) |
| WS | `/workstreams/:id/stream` | live event stream (`?since=<bytes>`) |
| POST | `/hooks/session-start` | hook intake |
| POST | `/hooks/stop` | hook intake |
| POST | `/hooks/pre-tool-use` | hook intake |
| POST | `/hooks/post-tool-use` | hook intake |
| POST | `/hooks/user-prompt-submit` | hook intake |
| POST | `/interventions` | **stub** — 202'd but not delivered until v0.5 |

## MCP tools (v0)

Exposed by `manager mcp` (production) or `manager start --mcp-stdio` (legacy/test). Names and shapes match `docs/ARCHITECTURE.md`:

`emit_decision`, `emit_subgoal`, `emit_confidence`, `flag_blocked`, `update_memory`, `read_memory`.

## Hook installation

The hook scripts live in [`../hooks/`](../hooks/). Install them into Claude Code's settings:

```sh
bash ../hooks/install.sh
```

It merges into `~/.claude/settings.json` under the `hooks` key (idempotent, asks for confirmation).

## Test

```sh
npm test           # vitest
npm run lint       # biome
```

## Smoke test

```sh
node dist/index.js start &
sleep 1
node dist/index.js register demo "Demo workstream"
curl -s -X POST localhost:9876/hooks/session-start \
  -H 'content-type: application/json' \
  -d '{"workstream":"demo","session":"sess-abc"}'
curl -s localhost:9876/workstreams/demo/events | jq .
kill %1
```

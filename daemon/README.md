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

The HTTP/WS API is the always-on surface. The MCP server is opt-in via flag (Claude Code launches it over stdio).

```sh
# HTTP/WS only — what you want for development and the macOS client.
node dist/index.js start

# HTTP/WS + MCP over stdio — what Claude Code launches.
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
node dist/index.js start                       # boot the daemon
node dist/index.js register <id> <title>       # create a workstream
node dist/index.js list                        # tabulate workstreams
node dist/index.js attach <workstream-id>      # print env vars for a session
```

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

Exposed only when started with `--mcp-stdio`. Names and shapes match `docs/ARCHITECTURE.md`:

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

# Manager

Manage AI agents like employees. The human is VP of Engineering / CEO; the agents are the team.

## Quickstart (60 seconds)

```sh
# 1. Clone + install (idempotent; asks before each step)
git clone git@github.com:S-KSM/Manager.git ~/Code/Manager
bash ~/Code/Manager/bin/install.sh

# 2. (Optional) Enable LLM-generated weekly/monthly Updates
export ANTHROPIC_API_KEY=sk-ant-...
# Or use a local model: brew install ollama && ollama serve && ollama pull qwen3:8b

# 3. Use claude in any project — Manager picks up the workstream from the directory
cd ~/Code/some-project
claude
```

A card for `some-project` appears in the Manager macOS app within seconds. Decision events emitted by the agent flow into the methodology timeline live. Send a nudge / redirect / rollback from the app to course-correct mid-flight.

To dry-run prereqs without installing: `bash bin/install.sh --check-only`.
To uninstall: `bash bin/uninstall.sh`.

## What you get

- **Live multi-agent monitoring** — glanceable home view: digest rail at the top, team floor of workstream cards, live ticker on the right.
- **Methodology tracking** — agents emit structured decision events (`considered`, `choice`, `rationale`, `confidence`); the timeline shows the reasoning tree, not a raw transcript.
- **Mid-flight intervention** — nudge (advisory), redirect (hard course-correct), or rollback (rewind to a decision point and re-run with a hint and the original context).
- **Workstream lifecycle in the app** — create / pause / retire from the sidebar; no CLI ritual.
- **Skill broadcast** — agent proposes a pattern via `propose_skill`; manager promotes it to the team handbook; every workstream's next session sees it.
- **Weekly / monthly Updates** — generate audience-tuned summaries (executive, business partner, engineer peer, sponsor, or free-text) via Claude API or a local LLM (Ollama). On-demand or scheduled drafts.
- **Persistent workstreams** — identity survives across many `claude` sessions via a per-workstream Markdown memory file the agent maintains.

## Why this exists

Today's tooling pushes you into one of two modes:

- **Live single-agent supervision** (Cursor, Claude Code in a terminal) — high fidelity, but only one agent at a time.
- **Outcome-based ticket tracking** (Linear, Jira) — scales to many, but you only see results, never *how* the agent got there.

Real human managers do something neither covers: they track *methodology*, intervene mid-flight to course-correct, and propagate newly-learned skills across the team. Manager brings that experience to AI agent teams.

## Shape at a glance

```
Claude Code sessions  ─┐
                       ├─→ Manager Daemon ─→ macOS Client (SwiftUI)
Lifecycle hooks    ────┘    │                ↑
                            │   long-running, HTTP/WebSocket on :9876
MCP server (per session) ───┤
                            ├─ Event log (JSONL per workstream)
                            ├─ Workstream memory (Markdown per workstream)
                            ├─ Intervention queue (SQLite)
                            ├─ Team handbook (Markdown)
                            ├─ Saved reports + scheduler (SQLite + scheduler.json)
                            └─ Skill proposals (SQLite)
```

The daemon is the only stateful piece. Clients (macOS now, iOS / web later in v1.5) are thin views over its API. The daemon-as-brain split is what lets a mobile client land later without a rewrite.

## How it plugs into Claude Code

- **Lifecycle hooks** (zero-touch): `SessionStart`, `Stop`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit` POST to the daemon — installed via the one-command installer into `~/.claude/settings.json`.
- **MCP server** (per-session stdio): `manager mcp` exposes the high-fidelity tools — `emit_decision`, `emit_subgoal`, `emit_confidence`, `flag_blocked`, `update_memory`, `read_memory`, `propose_skill`. Wired automatically by the installer (`claude mcp add manager`).
- **`SessionStart` system-prompt nudge**: tells the agent the manager tools exist and inlines the team handbook (capped at 8 KB) so promoted skills propagate to every session.
- **Auto-workstream**: if `MANAGER_WORKSTREAM` isn't set, the hook derives a workstream id from the project's git-root basename (or `pwd`). Slugified. Override with `MANAGER_WORKSTREAM=other-name claude`.

## Where state lives

Everything local-only, under `~/.claude/manager/`:

```
~/.claude/manager/
├── db.sqlite           # workstream registry, intervention queue, skill proposals, reports
├── events/<id>.jsonl   # append-only event log per workstream
├── memory/<id>.md      # per-workstream Markdown memory (agent-curated)
├── handbook.md         # team-wide promoted skills
└── scheduler.json      # weekly / monthly report cron config
```

Daemon binds to `localhost:9876` only. No auth, no remote access in v1. Both arrive in v1.5 with the iOS client.

## Where to look next

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — components, mermaid diagrams, full HTTP+WebSocket contract, event schema.
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — what's shipped vs. what's coming (v1.2 Kanban, v1.5 mobile, v2 ADK / non-coding workflows).
- [`specs.md`](specs.md) — original vision (now a historical artifact) + a current-state summary.

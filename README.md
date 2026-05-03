# Dispatch

> **Mission Control for the Autonomous Workforce.**

Air-traffic-control for AI agents. Agents are pilots; you're the head dispatcher. Watch the radar, trace methodology, intercept errors, broadcast new protocols across the fleet.

> Originally codenamed **Manager**; rebranded to Dispatch in v1.1.x. Runtime paths (`~/.claude/manager/`, `MANAGER_*` env vars, the `manager` binary) still use the old name until a follow-up code-layer rename — fully working installs are unaffected.

## Quickstart (60 seconds)

```sh
# 1. Clone + install (idempotent; asks before each step)
git clone git@github.com:S-KSM/Manager.git ~/Code/Manager
bash ~/Code/Manager/bin/install.sh

# 2. (Optional) Enable LLM-generated weekly/monthly Updates
export ANTHROPIC_API_KEY=sk-ant-...
# Or use a local model: brew install ollama && ollama serve && ollama pull qwen3:8b

# 3. Use claude in any project — Dispatch picks up the workstream from the directory
cd ~/Code/some-project
claude
```

A card for `some-project` appears on the **Radar** within seconds. Decision events from the agent flow into **The Trace** live. Open an **Intercept** (nudge / redirect / rollback) from the app to course-correct mid-flight.

New here? See [`docs/TUTORIAL.md`](docs/TUTORIAL.md) for a 30-minute walk-through, or [`docs/LOCAL_MODELS.md`](docs/LOCAL_MODELS.md) for local-LLM setup.

To dry-run prereqs without installing: `bash bin/install.sh --check-only`.
To uninstall: `bash bin/uninstall.sh`.

## The Dispatch lexicon

| Capability | Dispatch term | What it is |
|---|---|---|
| Live monitoring | **The Radar** | Glanceable home view — digest rail + team floor of agent cards + live ticker. |
| Methodology tracking | **The Trace** | Forensic trail of *why* — structured decision events (`considered`, `choice`, `rationale`, `confidence`) rendered as a timeline, not a transcript. |
| Mid-flight intervention | **Intercept** | Three modes — nudge (advisory), redirect (hard course-correct), rollback (rewind to a decision and replay with a hint and the original context). |
| Skill broadcast | **The Protocol** | Agent proposes a pattern via `propose_skill`; you promote it to the team handbook; every workstream's next session adopts it. |
| Persistent memory | **The Dossier** | Per-workstream Markdown the agent maintains across sessions — identity that survives `claude` restarts. |

Plus: workstream lifecycle in the app (create / pause / retire from the sidebar) and **Updates** — LLM-generated weekly/monthly summaries (Claude API or local Ollama, audience-tuned, on-demand or scheduled).

## Why this exists

Today's tooling pushes you into one of two modes:

- **Live single-agent supervision** (Cursor, Claude Code in a terminal) — high fidelity, but only one agent at a time.
- **Outcome-based ticket tracking** (Linear, Jira) — scales to many, but you only see results, never *how* the agent got there.

> Jira tells you what happened yesterday. Claude Code tells you what one agent is doing right now. **Dispatch** gives you the high-fidelity oversight to manage an entire department of agents in real-time. Trace their methodology, intercept their errors, and broadcast new protocols across your team. **Don't just run agents. Dispatch them.**

## Shape at a glance

```
Claude Code sessions  ─┐
                       ├─→ Dispatch Daemon ─→ macOS Client (SwiftUI)
Lifecycle hooks    ────┘    │                ↑
                            │   long-running, HTTP/WebSocket on :9876
MCP server (per session) ───┤
                            ├─ Event log (JSONL per workstream)
                            ├─ Workstream Dossier (Markdown per workstream)
                            ├─ Intercept queue (SQLite)
                            ├─ Team Protocol handbook (Markdown)
                            ├─ Saved reports + scheduler (SQLite + scheduler.json)
                            └─ Skill proposals (SQLite)
```

The daemon is the only stateful piece. Clients (macOS now, iOS / web later in v1.5) are thin views over its API. The daemon-as-brain split is what lets a mobile client land later without a rewrite.

## How it plugs into Claude Code

- **Lifecycle hooks** (zero-touch): `SessionStart`, `Stop`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit` POST to the daemon — installed via the one-command installer into `~/.claude/settings.json`.
- **MCP server** (per-session stdio): exposes the high-fidelity tools — `emit_decision`, `emit_subgoal`, `emit_confidence`, `flag_blocked`, `update_memory`, `read_memory`, `propose_skill`. Wired automatically by the installer.
- **`SessionStart` system-prompt nudge**: tells the agent the Dispatch tools exist and inlines the team Protocol handbook (capped at 8 KB) so promoted skills propagate to every session.
- **Auto-workstream**: if `MANAGER_WORKSTREAM` isn't set, the hook derives a workstream id from the project's git-root basename (or `pwd`). Slugified. Override with `MANAGER_WORKSTREAM=other-name claude`.

## Where state lives

Everything local-only, under `~/.claude/manager/` (path renamed in a future code-layer pass):

```
~/.claude/manager/
├── db.sqlite           # workstream registry, intercept queue, skill proposals, reports
├── events/<id>.jsonl   # append-only event log per workstream
├── memory/<id>.md      # per-workstream Dossier (agent-curated Markdown)
├── handbook.md         # team-wide promoted Protocols
└── scheduler.json      # weekly / monthly report cron config
```

Daemon binds to `localhost:9876` only. No auth, no remote access in v1. Both arrive in v1.5 with the iOS client.

## Where to look next

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — components, mermaid diagrams, full HTTP+WebSocket contract, event schema.
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — what's shipped vs. what's coming (v1.2 Kanban, v1.5 mobile, v2 ADK / non-coding workflows).
- [`specs.md`](specs.md) — original vision (now a historical artifact) + a current-state summary.

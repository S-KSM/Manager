# Dispatch

> **Mission Control for the Autonomous Workforce.**

Air-traffic-control for AI agents. Agents are pilots; you're the head dispatcher. Watch the radar, trace methodology, intercept errors, broadcast new protocols across the fleet.

> **New here?** Walk through [`docs/TUTORIAL.md`](docs/TUTORIAL.md) (also available in-app under **Help → Tutorial**, alongside Local model setup, Architecture, and the GitHub repo).

> Originally codenamed **Manager**; rebranded to Dispatch in v1.1.x. Code-layer rename landed in v1.2 (binary `dispatch`, `DISPATCH_*` env vars, state at `~/.claude/dispatch/`). The legacy `MANAGER_*` env-var fallback was removed in v1.3 — `DISPATCH_*` only.

## Quickstart (60 seconds)

**Two install paths — pick one.**

### Path A — DMG (recommended for app users, Apple Silicon only)

```sh
# 1. Build a signed-for-local-use DMG. Apple Silicon (M-series) only.
git clone git@github.com:S-KSM/Manager.git ~/Code/Manager
bash ~/Code/Manager/bin/package.sh
open ~/Code/Manager/dist/Dispatch-*-arm64.dmg

# 2. Drag Dispatch.app → Applications. First launch will prompt:
#    right-click Dispatch.app → Open → Open (ad-hoc signed, no notarization).
#    The app self-installs its launchd agent on first launch — no install.sh.

# 3. (Optional) wire Claude Code lifecycle hooks + MCP server so the daemon
#    sees agent activity. The hooks bit still lives in install.sh:
bash ~/Code/Manager/bin/install.sh --skip-app
```

The .app ships its own daemon at `Dispatch.app/Contents/Resources/daemon/bundle.cjs`. First launch writes a launchd plist that points at it; moving the .app re-points the agent on next launch.

### Path B — Source build (devs / Intel users)

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

While inside `claude`, type **`/dispatcher`** to jump straight to the matching card in the Dispatch app — the slash command derives the workstream slug from the current git root (or `$PWD`) and runs `open dispatch://workstream/<slug>`.

New here? See [`docs/TUTORIAL.md`](docs/TUTORIAL.md) for a 30-minute walk-through, or [`docs/LOCAL_MODELS.md`](docs/LOCAL_MODELS.md) for local-LLM setup.

To dry-run prereqs without installing: `bash bin/install.sh --check-only`.
To uninstall: `bash bin/uninstall.sh`.

## Autonomous mode (optional, v1.4)

By default Dispatch is purely *observational* — you launch `claude`, Dispatch watches. With a `WORKFLOW.md` it also drives: the orchestrator polls a tracker (Linear or a mock JSON file), claims tickets, and spawns `claude` per turn inside a per-issue workspace. The same hooks + MCP server feed the same event store, so Radar / Trace / Intercept work identically for orchestrator-spawned agents.

Minimal `WORKFLOW.md`:

```markdown
---
tracker:
  kind: linear
  project_slug: my-project
  api_key: $LINEAR_TOKEN          # env var indirection
  active_states: [Todo, In Progress]
polling:
  interval_ms: 30000
workspace:
  root: ~/Code/dispatch-workspaces
agent:
  runtime: claude-code
  max_concurrent_agents: 3
---

You are working on {{ issue.identifier }}: {{ issue.title }}.

{% if attempt %}This is attempt #{{ attempt }} after a previous failure.{% endif %}

Description:
{{ issue.description }}
```

Run with the workflow attached:

```sh
export LINEAR_TOKEN=lin_api_...
dispatch start --workflow ~/dispatch/WORKFLOW.md
```

Dry-run (claim/release decisions logged but no agent spawn): add `--dry-run`. Want to drive it from a JSON fixture instead of Linear? Use `tracker.kind: mock` and `--mock-tracker <path-to-issues.json>`. Full schema, error categories, and the WORKFLOW.md renderer surface are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) under "Orchestrator (v1.4 — autonomous mode)".

When an autonomous agent needs human authorization for a destructive action, an `approval_required` intervention surfaces as an Approve / Deny strip in the agent detail view. Approving emits an `intervention_delivered` event with `approved: true` so the agent's next turn knows it was cleared.

## v1.2 highlights

- **Kanban board.** The Radar's home view is now a 4-column kanban (Backlog / Active / Paused / Retired). Drag a card between columns to flip its status server-side. The Active column auto-folds into a "Pod-grouped" disclosure when it goes over 12 cards so the floor stays scannable.
- **Linear-link UI.** Open any agent and use the **Link…** chip in the header to attach a Linear issue (`ENG-123`-style identifier). Once linked, high-confidence decisions auto-post as Markdown comments on the Linear issue, and Linear-side state moves (Done, In Progress, On Hold, …) flow back into the workstream's Dispatch status — provided you haven't manually overridden it. Disable the sync ticker via `DISPATCH_LINEAR_SYNC_ENABLED=0`.

To set this up, open **Dispatch → Settings → Providers → Linear API key** and paste a Linear API key. The same redacted-on-the-wire pattern as the Anthropic key applies — the key is stored in `~/.claude/dispatch/settings.json` (mode `0600`) and `GET /settings` only returns `linearApiKeyConfigured: true`.

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
- **Auto-workstream**: if `DISPATCH_WORKSTREAM` isn't set, the hook derives a workstream id from the project's git-root basename (or `pwd`). Slugified. Override with `DISPATCH_WORKSTREAM=other-name claude`.

## Where state lives

Everything local-only, under `~/.claude/dispatch/` (legacy `~/.claude/manager/` from v1.1.x is migrated automatically by `bin/install.sh`):

```
~/.claude/dispatch/
├── db.sqlite           # workstream registry, intercept queue, skill proposals, reports
├── events/<id>.jsonl   # append-only event log per workstream
├── memory/<id>.md      # per-workstream Dossier (agent-curated Markdown)
├── handbook.md         # team-wide promoted Protocols
└── scheduler.json      # weekly / monthly report cron config
```

Daemon binds to `localhost:9876` only. No auth, no remote access in v1. Both arrive in v1.5 with the iOS client.

## Where to look next

- [`docs/FLEET_WORKFLOW.md`](docs/FLEET_WORKFLOW.md) — step-by-step: plan in team-brain, run agents in claude-fleet worktrees (batch or autonomous), watch/steer/ship/close the loop in Dispatch.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — components, mermaid diagrams, full HTTP+WebSocket contract, event schema.
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — what's shipped vs. what's coming (v1.2 Kanban, v1.5 mobile, v2 ADK / non-coding workflows).
- [`specs.md`](specs.md) — original vision (now a historical artifact) + a current-state summary.

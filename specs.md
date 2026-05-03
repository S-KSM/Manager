# Manager — specs

## Original vision

> I am thinking about building a system that can help us monitor the agents as if they are employees. Currently the approaches are closer to you are either monitoring one agent live as it's coding during the session or you are using Linear or Jira ticketing approach to see what each one is working on by looking at the outcome. In human set up, this is what a manager normally does tracking the updates and writing what is achieved and the ability to track the logic and path or methodology that an outcome was achieved. Sometime you need to micro-manage so that you can intervene and course-correct and employee's approach.
>
> More over we have some knowledge transfer sessions where we can share newly learned "skills" among the team.
>
> My goal is to generate this experience in a visual and native manner for an ai team so that the human engineer can become the VP of engineering or even CEO for a team of agents with various jobs.

That paragraph kicked off the project. The sections below summarize what got built against it.

## Current state (v1.1.x)

Four pieces, all local:

1. **Daemon** (TypeScript / Node, long-running) — owns all state at `~/.claude/manager/`. Hosts an HTTP + WebSocket API on `localhost:9876` for clients and a per-session stdio MCP server (`manager mcp`) for Claude Code.
2. **Lifecycle hooks** (POSIX shell) — installed into `~/.claude/settings.json`. Capture `SessionStart` / `Stop` / `PreToolUse` / `PostToolUse` / `UserPromptSubmit` events, derive a workstream id from `cwd` if `MANAGER_WORKSTREAM` is unset, drain pending interventions on every user prompt, and inline the team handbook on session start.
3. **MCP server** (inside the daemon) — exposes `emit_decision`, `emit_subgoal`, `emit_confidence`, `flag_blocked`, `update_memory`, `read_memory`, `propose_skill` to the agent.
4. **macOS app** (SwiftUI) — thin client over the daemon's API. Sidebar w/ Home, workstreams, Team handbook, Updates. Live ticker + agent-detail timeline subscribe via WebSocket.

What the original vision asked for, mapped to what shipped:

| Vision | Shipped (where) |
|---|---|
| "monitor agents as if they are employees" | macOS home view (digest rail + team floor + ticker) |
| "track the logic and path or methodology" | `decision` events via the MCP `emit_decision` tool → methodology timeline in agent detail |
| "micro-manage … intervene and course-correct" | nudge / redirect / rollback interventions; rollback inlines the original decision context |
| "knowledge transfer … share newly learned skills" | `propose_skill` (agent) → manager promotes via UI → `handbook.md` → injected into every future SessionStart |
| "VP of engineering or CEO for a team of agents" | Team handbook + workstream lifecycle in app + Updates feature for executive / partner / engineer / sponsor audiences |
| "visual and native" | macOS-native SwiftUI app; daemon-as-brain split makes iOS / web future thin clients |

## What's queued

- **v1.2 — Kanban board** for workstreams: 4 columns (Backlog / Active / Paused / Retired) with drag-and-drop status changes. Replaces the team-floor grid for organization-at-scale.
- **v1.5 — Remote / mobile**: daemon binds to non-localhost with token auth; iOS thin client (read-only first, then intervention from mobile).
- **v2 — Runtime expansion**: Anthropic Agent Development Kit (ADK 2.0) integration, then generic non-coding workflows (marketing, research) implementing the same event contract via a shim.

Operational follow-ups also queued: pod auto-grouping when card count > ~12, SQLite index over JSONL events for projection queries at scale, file-locking for cross-process memory MD edits, true session-state rollback if replay-with-hint proves insufficient, vector-similarity skill recall in SessionStart.

## Where to look

- [`README.md`](README.md) — install + how to use day-to-day.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — components, diagrams, the HTTP + WebSocket + MCP contracts, event/memory/intervention/report schemas.
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — the milestone breakdown the codebase was built against.

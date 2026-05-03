# Dispatch — specs

> **Mission Control for the Autonomous Workforce.**

> Originally codenamed **Manager**; rebranded to Dispatch in v1.1.x. The vision below is preserved verbatim from the project's first paragraph — the word "manager" appears in it as a role (the human supervising the agents), not the product.

## Original vision

> I am thinking about building a system that can help us monitor the agents as if they are employees. Currently the approaches are closer to you are either monitoring one agent live as it's coding during the session or you are using Linear or Jira ticketing approach to see what each one is working on by looking at the outcome. In human set up, this is what a manager normally does tracking the updates and writing what is achieved and the ability to track the logic and path or methodology that an outcome was achieved. Sometime you need to micro-manage so that you can intervene and course-correct and employee's approach.
>
> More over we have some knowledge transfer sessions where we can share newly learned "skills" among the team.
>
> My goal is to generate this experience in a visual and native manner for an ai team so that the human engineer can become the VP of engineering or even CEO for a team of agents with various jobs.

That paragraph kicked off the project. The sections below summarize what got built against it.

## Current state (v1.1.x)

Four pieces, all local. Code-layer artifacts (binary name, env vars, state dir) still use the old `manager` codename — a rename is queued, see "What's queued" below.

1. **Daemon** (TypeScript / Node, long-running) — owns all state at `~/.claude/manager/`. Hosts an HTTP + WebSocket API on `localhost:9876` for clients and a per-session stdio MCP server (`manager mcp`) for Claude Code.
2. **Lifecycle hooks** (POSIX shell) — installed into `~/.claude/settings.json`. Capture `SessionStart` / `Stop` / `PreToolUse` / `PostToolUse` / `UserPromptSubmit` events, derive a workstream id from `cwd` if `MANAGER_WORKSTREAM` is unset, drain pending Intercepts on every user prompt, and inline the team Protocol handbook on session start.
3. **MCP server** (inside the daemon) — exposes `emit_decision`, `emit_subgoal`, `emit_confidence`, `flag_blocked`, `update_memory`, `read_memory`, `propose_skill` to the agent.
4. **macOS app** (SwiftUI) — thin client over the daemon's API. Sidebar w/ Radar (home), workstreams, Protocol handbook, Updates. Live ticker + Trace timeline subscribe via WebSocket.

What the original vision asked for, mapped to what shipped:

| Vision | Dispatch term | Shipped (where) |
|---|---|---|
| "monitor agents as if they are employees" | **The Radar** | macOS home view (digest rail + team floor + ticker) |
| "track the logic and path or methodology" | **The Trace** | `decision` events via the MCP `emit_decision` tool → methodology timeline in agent detail |
| "micro-manage … intervene and course-correct" | **Intercept** | nudge / redirect / rollback interventions; rollback inlines the original decision context |
| "knowledge transfer … share newly learned skills" | **The Protocol** | `propose_skill` (agent) → human promotes via UI → `handbook.md` → injected into every future SessionStart |
| "VP of engineering or CEO for a team of agents" | Head Dispatcher | Protocol handbook + workstream lifecycle in app + Updates feature for executive / partner / engineer / sponsor audiences |
| persistent identity across sessions | **The Dossier** | Per-workstream Markdown owned by the agent, read at every SessionStart |
| "visual and native" | — | macOS-native SwiftUI app; daemon-as-brain split makes iOS / web future thin clients |

## What's queued

- **v1.2 — Code-layer Dispatch rename + new icon**: rename the daemon binary `manager` → `dispatch`, env vars `MANAGER_*` → `DISPATCH_*`, state dir `~/.claude/manager/` → `~/.claude/dispatch/`, launchd label `com.manager.daemon` → `com.dispatch.daemon`, Xcode project + Swift module + bundle identifier + `CFBundleDisplayName` from `Manager` to `Dispatch`. Ship the new brutalist "D" app icon (heavy, glitchy, with a pixelated signal trail). Existing installs migrate via a one-shot script invoked by `bin/install.sh` on upgrade. Brand-layer rename in the docs is already done.
- **v1.2 — Kanban board** for workstreams: 4 columns (Backlog / Active / Paused / Retired) with drag-and-drop status changes. Replaces the team-floor grid for organization-at-scale.
- **v1.2 — Linear.app integration**: link a workstream to a Linear issue (`workstream_links` table + GraphQL client). Status changes flow Linear ↔ Dispatch; high-confidence decisions land as comments on the linked issue.
- **v1.5 — Remote / mobile**: daemon binds to non-localhost with token auth; iOS thin client (read-only first, then Intercept from mobile).
- **v2 — Runtime expansion**: Anthropic Agent Development Kit (ADK 2.0) integration, then generic non-coding workflows (marketing, research) implementing the same event contract via a shim.

Operational follow-ups also queued: pod auto-grouping when card count > ~12, SQLite index over JSONL events for projection queries at scale, file-locking for cross-process Dossier MD edits, true session-state rollback if replay-with-hint proves insufficient, vector-similarity Protocol recall in SessionStart.

## Where to look

- [`README.md`](README.md) — install + how to use day-to-day.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — components, diagrams, the HTTP + WebSocket + MCP contracts, event/memory/intervention/report schemas.
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — the milestone breakdown the codebase was built against.

# Roadmap

Each milestone delivers an end-to-end usable slice. We ship the smallest thing that proves the next assumption, then extend. Product brand: **Dispatch** (originally codenamed Manager — see [`../specs.md`](../specs.md) for the rebrand note).

## v0 — Observation only

**Goal:** human can watch one workstream of one Claude Code agent live, with a structured methodology timeline. No interventions yet.

Scope:

- Daemon: MCP server with `emit_decision`, `emit_subgoal`, `emit_confidence`, `flag_blocked`, `update_memory`, `read_memory`. Event store (JSONL). Workstream memory (Markdown). Localhost HTTP+WebSocket API for the client.
- Hooks: `SessionStart`, `Stop`, `PreToolUse`, `PostToolUse` writing to event store.
- Workstream registration: simple CLI — `manager register <workstream-id> <title>` and `manager attach <session>` so a Claude Code session knows which workstream it belongs to.
- macOS client (SwiftUI):
  - Home view with **team floor** (cards) and **live ticker**. Digest rail can be a stub.
  - Agent detail with **methodology timeline** and **memory pane** (read-only).
- One workstream at a time is fine; multi-workstream concurrency in v1.

What this proves: the telemetry contract is sufficient to render a useful timeline; agents will actually emit decision events when prompted; the daemon-as-brain / client-as-thin-view split holds.

## v0.5 — Interventions

**Goal:** human can nudge, redirect, and rollback an agent from the macOS client.

Scope:

- Daemon: intervention queue per workstream, `POST /interventions` endpoint.
- Hooks: `UserPromptSubmit` drains the queue, prepends pending interventions to the next turn.
- Client: intervention controls in the agent detail view — three explicit buttons (nudge / redirect / rollback). Rollback shows the timeline and lets the human pick a decision to rewind to.
- Rollback uses the **replay-with-hint** approach (see ARCHITECTURE.md) — not true state restoration.

What this proves: replay-with-hint is good enough for "rescue scene" rollback; the back-channel design works without disrupting agents that aren't being intervened on.

## v1 — Multi-workstream + skill broadcast + digest

**Goal:** real ambient use — many workstreams running concurrently, skill broadcast loop closed, morning digest worth opening the app for.

Scope:

- Daemon: stable concurrent workstream handling. SQLite index over events for fast cross-workstream queries.
- Daemon: team handbook — shared Markdown the manager curates from agent-proposed skills.
- Client:
  - Pod auto-grouping when card count exceeds the threshold (~12).
  - Digest rail populated with overnight roll-up.
  - Skill broadcast modal — promote a decision/memory snippet to the team handbook.
- Workstream lifecycle: spawn, pause, retire from the UI (not just CLI).

What this proves: solo→scale is a single design move (cards collapse to pods), not a rewrite; the skill loop accelerates the team in measurable ways.

## v1.2 — Code-layer Dispatch rename + Kanban + Linear

**Goal:** finish what v1.1.x's brand-layer rebrand started; tighten organization-at-scale; integrate the issue tracker the human is already using.

Scope:

- **Dispatch rename (code layer)**: rename daemon binary `manager` → `dispatch`; env vars `MANAGER_*` → `DISPATCH_*` (with one release of fallback aliases); state dir `~/.claude/manager/` → `~/.claude/dispatch/` via a one-shot migration in `bin/install.sh` on upgrade; launchd label `com.manager.daemon` → `com.dispatch.daemon`; Xcode project + Swift module + bundle identifier + `CFBundleDisplayName` from `Manager` to `Dispatch`; ship the new brutalist "D" app icon (heavy, glitchy, with a pixelated signal trail) into `Assets.xcassets/AppIcon.appiconset`. Internal contract identifiers (event types, MCP tool names, SQLite columns) stay unchanged — they're already neutral.
- **Kanban board**: replace the team-floor grid with a 4-column board (Backlog / Active / Paused / Retired) + drag-and-drop status changes. Pod auto-grouping moves into the Active column when card count exceeds the threshold.
- **Linear.app integration**: `workstream_links` SQLite table + GraphQL client. Link a workstream to a Linear issue from the agent-detail header. Status changes flow Linear ↔ Dispatch; high-confidence decisions optionally land as comments on the linked issue.

What this proves: the rebrand can land cleanly without breaking installed copies; the daemon-as-brain split makes external integrations (Linear) cheap to add.

## v1.5 — Remote / mobile

**Goal:** check on the team from your phone.

Scope:

- Daemon: bind to non-localhost interface with token auth. Optional cloud relay if NAT traversal is a problem.
- iOS client (SwiftUI, sharing models with the macOS app).
- Read-only first; intervention from mobile in v1.6 once the auth model is proven.

What this proves: the daemon-as-brain split was correct — we can add a thin client without touching the brain.

## v2+ — Runtime expansion

**Goal:** Manager works for non-Claude-Code agents.

Candidates in priority order:

1. **Anthropic Agent Development Kit (ADK 2.0)** — direct integration with the same event contract.
2. **Generic non-coding workflows (marketing, research)** — agents emit decision events through a thin shim. Defines the runtime-agnostic protocol publicly.
3. **Other code agents** (Cursor, OpenAI Codex, etc.) via shim adapters.

What this proves: the original bet — that a structured methodology contract is more general than any one agent runtime — was right.

## Out of scope (for now)

These come up but are explicitly deferred:

- True session-state rollback (KV / model-state restoration) — replay-with-hint until proven insufficient.
- Multi-machine workstreams (laptop + cloud).
- Multi-human teams (more than one VP / CEO).
- Billing, usage analytics, agent cost dashboards — interesting but not the wedge.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

**Dispatch** (originally codenamed **Manager**) — *Mission Control for the Autonomous Workforce.* A tool that lets a human supervise a team of AI agents like an air-traffic controller: live multi-agent monitoring (**The Radar**), methodology tracking (**The Trace**), mid-flight **Intercept** (nudge / redirect / rollback), and **Protocol** broadcast (skill propagation across the team).

Read first:

- [`README.md`](README.md) — product overview + Dispatch lexicon.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — components, mermaid diagrams, telemetry/event schema. Source of truth for the wire contract.
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — milestones (v0 → v2+).
- [`specs.md`](specs.md) — original product vision (preserved verbatim) + current-state mapping.

## Status

v1.1.x shipped. Daemon, hooks, MCP server, and macOS app are all in. Code-layer rename from `manager` → `dispatch` (binary name, env vars `MANAGER_*` → `DISPATCH_*`, state dir `~/.claude/manager/` → `~/.claude/dispatch/`, launchd label, Xcode project + Swift module + bundle identifier + display name, app icon) is queued for v1.2 — until then, runtime artifacts keep the `manager` codename to avoid breaking installed copies. **Brand-layer rebrand is done in the docs only**; the new "D" app icon and display name land with v1.2.

## Locked architectural decisions

These are decided. Do not relitigate without a reason; do propose changes if you find a reason.

- **First runtime: Claude Code.** Future runtimes (ADK 2.0, marketing/non-coding workflows) implement the same event contract.
- **First client surface: macOS native (SwiftUI).** iOS / web are future thin clients over the same daemon API.
- **Daemon-as-brain, client-as-thin-view.** All persistent state (events, memory, queues) lives in the daemon. This is the single design move that makes mobile/remote viable later without a rewrite.
- **Workstream is the unit of identity, not session.** A workstream spans many Claude Code sessions and persists context via a Markdown memory file.
- **Tap, not interrupt.** Observation never blocks the agent. Append-only event log; manager reads projections.
- **Three Intercept modes:** nudge (advisory), redirect (hard course-correct), rollback (replay-with-hint, not session-state restoration).
- **Telemetry channels:** lifecycle hooks (zero-touch, low-fidelity) + MCP tools (`emit_decision`, `emit_subgoal`, `emit_confidence`, `flag_blocked`, `update_memory`, `read_memory`) for high-fidelity structured events.
- **Daemon language: TypeScript / Node.** Chosen for the official MCP SDK and fastest iteration; a Rust port is a future option only if footprint matters.

## Still-open decisions

- **Auth for remote/mobile API access**: deferred to v1.5; localhost-only through v1.

## Working in this repo

- Build/lint/test live per-component: `cd daemon && npm run build|test|lint`; `cd client-macos && xcodebuild -project Manager.xcodeproj`. Hooks are POSIX shell — no build step.
- Local state at runtime lives at `~/.claude/manager/` (events, memory, db, handbook, scheduler). Do not commit — `.gitignore` excludes it.
- When making non-trivial decisions about the build, update `docs/ARCHITECTURE.md` and `docs/ROADMAP.md` rather than letting decisions drift.
- **When writing user-facing copy** (UI strings, README sections, error messages surfaced to the human) prefer the Dispatch lexicon — Radar / Trace / Intercept / Protocol / Dossier. Internal identifiers (event types `decision`, `intervention_delivered`, `skill_proposed`; MCP tool names; SQLite columns) stay as the technical contract — do not rename them on the brand pass.
- **Code-layer rename pending** — when v1.2 ships the rename, every `~/.claude/manager/` / `MANAGER_*` / `manager mcp` / `com.manager.daemon` / Xcode `Manager` reference becomes `dispatch`. Don't introduce new code that hardcodes the old name in places that would break the migration script.

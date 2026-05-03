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

v1.2 code-layer rename shipped. Daemon binary is `dispatch`, env vars are `DISPATCH_*` (with one-release `MANAGER_*` fallback + deprecation breadcrumb, removed in v1.3), state dir is `~/.claude/dispatch/` (one-shot migration in `bin/install.sh` from `~/.claude/manager/`), launchd label `com.dispatch.daemon`, Xcode project `Dispatch.xcodeproj`, bundle id `com.dispatch.app`, app file `/Applications/Dispatch.app`, custom logo shipped. Swift module name is `DispatchApp` (not `Dispatch`) to avoid colliding with system libdispatch.

Kanban + Linear (the other v1.2 deliverables) and MLX-backed local LLM (queued for v1.3) are not yet shipped.

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

- Build/lint/test live per-component: `cd daemon && npm run build|test|lint`; `cd client-macos && xcodebuild -project Dispatch.xcodeproj -scheme Dispatch`. Hooks are POSIX shell — no build step.
- Local state at runtime lives at `~/.claude/dispatch/` (events, memory, db, handbook, scheduler). Do not commit — `.gitignore` excludes it.
- When making non-trivial decisions about the build, update `docs/ARCHITECTURE.md` and `docs/ROADMAP.md` rather than letting decisions drift.
- **When writing user-facing copy** (UI strings, README sections, error messages surfaced to the human) prefer the Dispatch lexicon — Radar / Trace / Intercept / Protocol / Dossier. Internal identifiers (event types `decision`, `intervention_delivered`, `skill_proposed`; MCP tool names; SQLite columns) stay as the technical contract — do not rename them on the brand pass.
- **Backwards-compat env vars** — `MANAGER_*` env vars are honored for one release with a deprecation breadcrumb. The fallback removes in v1.3. Don't add new sites that read the legacy form; new code reads `DISPATCH_*` only.
- **Swift module is `DispatchApp`, not `Dispatch`** — required because `Dispatch` is a system framework (libdispatch / GCD). Bundle id, target name, and `.app` filename are all `Dispatch`; only the Swift module identifier is suffixed. Test imports therefore use `@testable import DispatchApp`.

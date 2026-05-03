# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

**Manager** — a tool that lets a human supervise a team of AI agents like a VP of Engineering: live multi-agent monitoring, methodology (not just outcome) tracking, mid-flight intervention, and skill broadcast across the team.

Read first:

- [`README.md`](README.md) — product overview.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — components, mermaid diagrams, telemetry/event schema. Source of truth for the v0 build.
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — milestones (v0 → v2+).
- [`specs.md`](specs.md) — original product vision.

## Status

Pre-code. Architecture and roadmap are defined; nothing is implemented yet. Directory scaffold exists (`daemon/`, `client-macos/`, `hooks/`) but is empty.

## Locked architectural decisions

These are decided. Do not relitigate without a reason; do propose changes if you find a reason.

- **First runtime: Claude Code.** Future runtimes (ADK 2.0, marketing/non-coding workflows) implement the same event contract.
- **First client surface: macOS native (SwiftUI).** iOS / web are future thin clients over the same daemon API.
- **Daemon-as-brain, client-as-thin-view.** All persistent state (events, memory, queues) lives in the daemon. This is the single design move that makes mobile/remote viable later without a rewrite.
- **Workstream is the unit of identity, not session.** A workstream spans many Claude Code sessions and persists context via a Markdown memory file.
- **Tap, not interrupt.** Observation never blocks the agent. Append-only event log; manager reads projections.
- **Three intervention modes:** nudge (advisory), redirect (hard course-correct), rollback (replay-with-hint, not session-state restoration).
- **Telemetry channels:** lifecycle hooks (zero-touch, low-fidelity) + MCP tools (`emit_decision`, `emit_subgoal`, `emit_confidence`, `flag_blocked`, `update_memory`, `read_memory`) for high-fidelity structured events.
- **Daemon language: TypeScript / Node.** Chosen for the official MCP SDK and fastest iteration; a Rust port is a future option only if footprint matters.

## Still-open decisions

- **Auth for remote/mobile API access**: deferred to v1.5; localhost-only through v1.

## Working in this repo

- No build/lint/test tooling exists yet — these get chosen with the v0 scaffold (per-component: `daemon/`, `client-macos/`).
- Local state at runtime lives at `~/.claude/manager/` (events, memory, db). Do not commit — `.gitignore` excludes it.
- When making non-trivial decisions about the build, update `docs/ARCHITECTURE.md` and `docs/ROADMAP.md` rather than letting decisions drift.

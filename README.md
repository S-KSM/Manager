# Manager

Manage AI agents like employees. The human is VP of Engineering / CEO; the agents are the team.

## Why this exists

Today's tooling pushes you into one of two modes:

- **Live single-agent supervision** (Cursor, Claude Code in a terminal) — high fidelity, but only one agent at a time.
- **Outcome-based ticket tracking** (Linear, Jira) — scales to many, but you only see results, never *how* the agent got there.

Real human managers do something neither covers: they track *methodology*, intervene mid-flight to course-correct, and propagate newly-learned skills across the team. Manager brings that experience to AI agent teams.

## Capabilities

- **Live multi-agent monitoring** — glanceable home view across all active workstreams.
- **Methodology tracking** — agents emit decision points and rationale as they work; manager reads a structured timeline, not a raw transcript.
- **Mid-flight intervention** — nudge (advisory), redirect (hard course-correct), rollback (rewind to a decision point and re-run with a hint).
- **Skill broadcast** — promote a discovered pattern to a team handbook so other agents adopt it on their next task.
- **Persistent workstreams** — an agent identity persists across sessions via a Markdown memory file, not just one CLI invocation.

## Status

Early. Repo just scaffolded. No working code yet — but the architecture, telemetry contract, and roadmap are defined. See:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — components, diagrams, telemetry schema.
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — v0 → v1 milestones.
- [`specs.md`](specs.md) — original product vision.

## Shape at a glance

```
Claude Code sessions ─┐
                      ├─→ Manager Daemon ─→ macOS Client (SwiftUI)
Hooks (lifecycle)  ───┘     │                ↑
                            ├─ Event log    HTTP / WebSocket
                            ├─ Agent memory (MD per workstream)
                            └─ Intervention queue
```

The daemon is the only stateful piece. Clients (macOS now, iOS/web later) are thin views over its API. This is the design move that lets us start macOS-native and add a remote/mobile client later without a rewrite.

## First runtime: Claude Code

Manager v0 instruments Claude Code via hooks (lifecycle events) and an MCP server (decision events, intervention back-channel). Future runtimes — Anthropic's Agent Development Kit, generic non-coding workflows like marketing pipelines — implement the same event contract.

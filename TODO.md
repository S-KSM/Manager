# Project TODO

Substep-level task list for shipped + in-flight milestones. Roadmap context lives in [`docs/ROADMAP.md`](docs/ROADMAP.md).

Conventions: `[x]` shipped, `[~]` in progress, `[ ]` pending, `[-]` deferred. Each top-level group corresponds to a roadmap milestone.

---

## v1.2 — Code-layer Dispatch rename + Kanban + Linear

- [x] Code-layer rename Manager → Dispatch (daemon binary, env vars, state dir, launchd label, Xcode project, bundle id, custom logo, Swift module name workaround for system libdispatch).
- [ ] **Kanban board** — replace team-floor grid with 4 columns (Backlog / Active / Paused / Retired) + drag-and-drop status changes. Pod auto-grouping moves into the Active column when card count exceeds threshold.
- [ ] **Linear.app integration** — `workstream_links` SQLite table + GraphQL client. Link a workstream to a Linear issue from the agent-detail header. Status changes flow Linear ↔ Dispatch; high-confidence decisions optionally land as comments.
  - Note: this work folds into v1.4.3 (Linear adapter for the orchestrator). Ship the link surface first; reuse the GraphQL client for v1.4.

---

## v1.3 — MLX local LLM + `/dispatcher` slash command + tooltip & UX polish

- [ ] **MLX-backed local LLM** — replace Ollama-only path with generic OpenAI-compatible provider (`DISPATCH_LLM_BASE_URL`). Default recommended local: `mlx_lm.server`. Ollama keeps working (same surface).
  - Stretch: pure-Swift MLX inside the macOS app via `mlx-swift-examples`.
- [ ] **`/dispatcher <ws>` slash command + URL scheme** — register `dispatch://workstream/<id>` in macOS Info.plist + URL handler. Ship `~/.claude/commands/dispatcher.md`.
- [ ] **Remove `MANAGER_*` env-var fallbacks** introduced in v1.2 (deprecation breadcrumb has fired for one release).
- [x] **Activity headline (rolling LLM summary)** — shipped ahead of v1.3. Daemon's `Headliner` ticker generates one-sentence "Currently:" line per workstream every ~30s. Falls back gracefully to deterministic `latest_activity` when no LLM provider is configured. macOS app `Workstream.activityHeadline` field; HomeView card + AgentDetailView header prefer headline over `latestActivity`.
- [x] **Story-level subgoal synthesis** — shipped ahead of v1.3. Daemon's `SubgoalSynthesizer` ticker watches each workstream for runs of ≥8 consecutive `post-tool-use` events with no agent narration; calls `qwen3:4b` (default, via Ollama) for a one-line story arc and writes it as a `subgoal_push` event with `payload.source: "synthesized"` + `payload.synth_anchor: "<firstId>..<lastId>"`. Anchor is read back from the log on each tick so synthesis is idempotent across daemon restarts (same window never summarized twice). Disable via `DISPATCH_SUBGOAL_SYNTH_ENABLED=0`. 9 unit tests cover detection, idempotency, multi-run splitting, and LLM-unreachable fallback.
- [x] **Timeline UX — story over tool calls** — AgentDetailView now sorts events newest-on-top, collapses runs of consecutive `tool_use` rows into a single "N actions ▸" pill (tap to expand), and prefixes synthesized sub-goals with 🤖 so the user can tell agent-emitted narration from manager-inferred narration at a glance.
- [x] **App version stamping each build** — new `bin/stamp-app-version.sh` build-phase script writes `CFBundleShortVersionString` (`<MARKETING>+<short-sha>[-dirty]`) and `CFBundleVersion` (`<UTC date>.<HHMM>.<sha>[-dirty]`) into the built `Dispatch.app/Contents/Info.plist` on every Xcode build, so About Dispatch reflects the actual binary instead of the static plist defaults. Required `ENABLE_USER_SCRIPT_SANDBOXING = NO` on the Dispatch target so PlistBuddy can write inside the bundle.

---

## v1.4 — Autonomous dispatch (adopt OpenAI Symphony orchestration)

Detailed design in [`/Users/shobeir/.claude/plans/read-specs-md-and-try-refactored-key.md`](/Users/shobeir/.claude/plans/read-specs-md-and-try-refactored-key.md).

### v1.4.0 — Orchestrator core (dry-run) ✅

- [x] `daemon/src/orchestrator.ts` — Symphony §7 state machine.
- [x] Symphony §8 candidate selection + sort.
- [x] Symphony §8.4 retry/backoff.
- [x] Symphony §8.5 reconciliation tick (tracker state refresh).
- [x] `daemon/src/trackers/index.ts` + `daemon/src/trackers/mock.ts`.
- [x] `daemon/test/orchestrator.test.ts` — 6 cases pass.
- [x] CLI flags `--mock-tracker <path>` + `--dry-run`.
- [x] `GET /orchestrator/state` HTTP snapshot (Symphony §13.7.2).

### v1.4.1 — Workspace Manager ✅

- [x] `daemon/src/workspaces.ts`. Sanitize key, safety invariants, hooks via `bash -lc`, timeout.
- [x] Reuse across runs; `created_now` semantics; `~` expansion.
- [x] `daemon/test/workspaces.test.ts` — 15 cases pass.
- [ ] `dispatch workspaces gc` CLI — deferred to follow-up.

### v1.4.2 — Claude Code agent runner ✅

- [x] `daemon/src/agent-runner.ts` — spawn per turn (option A), stderr capture, exit-code mapping.
- [x] Symphony §10.6 error categories: `turn_timeout`, `turn_failed`, `codex_not_found`, `spawn_error`.
- [x] Sets `DISPATCH_WORKSTREAM` + `DISPATCH_SESSION_ID` so existing hooks route correctly.
- [x] `daemon/test/agent-runner.test.ts` — 4 cases pass.
- [ ] Continuation-turn loop bound by `agent.max_turns` — orchestrator already loops via retry; explicit per-worker turn cap deferred.

### v1.4.3 — Linear adapter + WORKFLOW.md loader ✅

- [x] `daemon/src/workflow-loader.ts` — front matter, body, defaults, env indirection, dynamic reload via `fs.watch` + 60s backstop poll.
- [x] `daemon/src/trackers/linear.ts` — GraphQL client, pagination (page size 50, cap 20 pages, network timeout 30s), normalized error categories.
- [x] CLI flag `--workflow <path>` — full orchestrator + agent-runner wired when present.
- [x] Minimal prompt renderer (`{{ issue.* }}` + `{% if attempt %}`).
- [x] `daemon/test/workflow-loader.test.ts` (6) + `daemon/test/trackers/linear.test.ts` (5) pass.
- [ ] `workstream_links` SQLite table — deferred (folds in when v1.2 Link UI ships; orchestrator currently uses sanitized identifier as workstream id directly).

### v1.4.4 — Approval bridge ✅

- [x] `approval_required` kind added to `daemon/src/intervention-queue.ts` + `InterventionPayload` (`approval_request`, `approval_decision`).
- [x] Removed SQLite CHECK constraint so existing dbs migrate forward.
- [x] `decideApproval(id, approved)` queue method merges decision + sets delivered_at atomically.
- [x] `POST /workstreams/:id/interventions/:intId/decide` HTTP endpoint, emits `intervention_delivered` event with `approved: bool`.
- [x] Swift `InterventionKind.approvalRequired`, `ApprovalRequest`, `ApprovalDecision` types + `DaemonClient.decideApproval` + `MockDaemonClient` impl.
- [x] `AgentDetailView` renders `ApprovalStrip` between header and timeline; polls `/interventions/pending` on every WS event.
- [x] Daemon test (1 new) + Swift test updated; both suites green.
- [ ] Agent-side trigger (MCP tool `request_approval` or hook integration) — deferred to v1.4.5; v1.4.4 ships the queue + API + UI infra so a manager can ack approvals enqueued by any source.
- [ ] macOS notification on enqueue — deferred.

### v1.4 doc updates

- [x] `docs/ARCHITECTURE.md` — new "Orchestrator (v1.4 — autonomous mode)" section covering state machine / tracker adapter / workflow loader / workspace manager / agent runner + telemetry equivalence + approval bridge + minimal WORKFLOW.md schema. Top-level system mermaid replaced with a dual-mode diagram showing observation + autonomous paths sharing the telemetry layer; added `intervention_enqueued` to the event-types list and documented the `subgoal_push.payload.source = "synthesized"` + `synth_anchor` extensions; added a "LLM-driven enrichment (Headliner + SubgoalSynthesizer)" section.
- [x] `CLAUDE.md` — orchestrator/observation duality already lives in the Locked Architectural Decisions list ("Two operational modes share one telemetry path (v1.4+)…"). No change needed.
- [x] `README.md` — Quickstart now links to a new "Autonomous mode (optional, v1.4)" section that shows a minimal WORKFLOW.md, the `dispatch start --workflow` invocation, the `--dry-run` + `--mock-tracker` knobs, and the approval-strip behaviour.

---

## v1.5 — Remote / mobile

- [ ] Daemon binds to non-localhost interface with token auth.
- [ ] Optional cloud relay for NAT traversal.
- [ ] iOS client (SwiftUI), shares models with macOS app.
- [ ] Read-only first; mobile intervention deferred to v1.6.

---

## v2+ — Runtime expansion

- [ ] Anthropic ADK 2.0 — same event contract, direct adapter.
- [ ] Generic non-coding workflows (marketing, research) — agents emit decision events through a thin shim.
- [ ] Codex runtime adapter (alongside ADK 2.0; pairs naturally with Symphony's original target).
- [ ] Cursor adapter.
- [ ] Claude-Code-as-app-server bridge (replaces v1.4.2 option A with the cleaner JSON-RPC stdio shim).

---

## Out of scope (deferred indefinitely)

- True session-state rollback (KV / model-state restoration). Replay-with-hint suffices until proven otherwise.
- Multi-machine workstreams (laptop + cloud).
- Multi-human teams (more than one VP / CEO).
- Billing, usage analytics, cost dashboards.

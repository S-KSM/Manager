# Dispatch ↔ Linear integration

Living design doc for the "Dispatch manages Linear" thread. Captures the current shipped state, the original three-tier escalation, and per-substep plans for what's left. Self-contained — read this and you have everything a fresh session needs to continue the work.

Last touched: 2026-05-09. Authoritative on direction; specific line numbers / file paths may drift — verify against the source.

---

## TL;DR

Dispatch already does **read-side** Linear integration (orchestrator polls candidates, `LinearCommentSyncer` mirrors decisions out + status back). The "manage Linear" thread layers **write-side** integration on top in three escalation tiers, **all shipped:**

1. **Daemon claims existing tickets on dispatch** — DONE in v1.4.10.x. Daemon picks an unassigned (or self-claimed) Linear issue, optionally moves it into a configured state, spawns the agent, releases on terminal. Multi-team, multi-instance recovery, and hot-swap workflow toggles all wired.
2. **Daemon files new tickets** — DONE in v1.4.11. `Tracker.createIssue` + `dispatch__file_ticket` MCP tool. Plumbing complete; a triage-agent prompt template is the only remaining piece (small follow-up).
3. **Linear → Radar full mirror** — DONE in v1.4.12. Every Linear issue surfaces in the Radar as a `status='backlog'` workstream the moment it appears in the tracker; human drags to Active to promote. macOS app needs zero changes.

Tier 1 is the smallest blast radius; each tier opens the next. Future v1.4.13 (`TrackerWriter` abstraction for Jira / GH swap) is **deliberately deferred** — see "When to revisit v1.4.13" below.

---

## Architecture decisions (locked)

These are settled. Don't relitigate without a reason.

- **Tracker is a pure data adapter.** The `Tracker` interface in `daemon/src/trackers/index.ts` only knows about issues + states; it does not orchestrate, spawn, or emit telemetry. Writes are optional methods (`claimIssue?`, `releaseIssue?`, `resolveStateIdByName?`, `createIssue?` planned) — the orchestrator and CLI probe for presence before calling.
- **Default-off for write paths.** Every write knob in `WORKFLOW.md` (`tracker.claim_on_dispatch`, future `tracker.create_on_*`, future `tracker.mirror_on_*`) defaults to `false`. Existing observation-only setups must keep behaving identically when they upgrade — write-back is opt-in, never silent.
- **Single source of truth for write state lives in the tracker.** Dispatch does not maintain a separate "claimed / not-yet-claimed" SQLite table to mirror Linear's assignee — too many places to drift. The CLI eager-resolves what it can at boot (selfUserId, claim_state stateId) and lets per-claim mutations be the canonical write.
- **Hot-swap > restart-required.** Workflow knobs reload via `applyConfig` whenever possible. Only changes that genuinely require state-machine re-init (e.g., swapping the entire `Tracker` instance) need a restart.
- **Telemetry stays unified.** Orchestrator-spawned, triage-agent-spawned, and human-launched `claude` sessions all write to the same event store via the same hooks + MCP server. Whoever fills the work queue, the Radar / Trace / Intercept surfaces don't care.
- **The unit of identity stays the workstream.** Tracker tickets ↔ workstreams is M:1 (a workstream may span many tickets via `workstream_links`), not 1:1. Don't accidentally promote a Linear issue id to be the workstream id — keep the link table.

---

## Shipped — v1.4.10.x

### v1.4.10 — Tracker write-back (`577eeaf`)

- `Tracker` interface gains optional `claimIssue(issueId, { stateId?, assigneeId? })` + `releaseIssue(issueId, opts?)`. New `TrackerError` codes `linear_assignee_taken` + `linear_self_user_failed`.
- `LinearTracker.selfUserId()` resolves `query { viewer { id } }` lazily, cached. `fetchCandidateIssues` accepts `{ assigneeFilter: 'any' | 'unassigned' | 'self' }` (Linear inlines as a string fragment because typed GraphQL variables can't carry "is null").
- `WORKFLOW.md` `tracker.claim_on_dispatch` / `assign_to_self` / `unassigned_only` / `claim_state` knobs. Defaults off; opting in flips the others to safe defaults.
- Orchestrator gains `claimHook` (pre-spawn) + `releaseHook` (terminal-state). Collisions skip-this-issue, other claim errors skip-this-tick. Releases are best-effort fire-and-forget — never block reconciliation.

### v1.4.10.1 — `claim_state` resolver (`e4ddbc5`)

- `Tracker.resolveStateIdByName?(name)` added as optional interface method.
- `LinearTracker` queries `issues(filter: project, first: 1) { team { states } }` once and caches the lowercased name→id map for the project's primary team.
- CLI eager-resolves `cfg.tracker.claim_state` once at boot via `resolveClaimStateId(tracker, name)`. Resolution miss / not-implemented / thrown error all degrade to assignee-only claim with a one-line stderr warning.
- Single Linear `issueUpdate` mutation per claim writes assignee + state together.

### v1.4.10.2 — Stale-claim re-discovery (`1a12076`)

- New `AssigneeFilter` value `'unassigned_or_self'`. Linear inlines `or: [{assignee:{null:{eq:true}}}, {assignee:{id:{eq:"<self>"}}}]`; mock matches `null OR == selfId`.
- CLI's `assigneeFilterFor` defaults to the new variant when `unassigned_only` is on. A daemon that crashed mid-claim re-discovers its own zombie tickets on the next boot (selfUserId is stable across boots).

### v1.4.10.3 — Hot-swap claim hooks (`daa8213`)

- `Orchestrator.applyConfig` swaps `claimHook` / `releaseHook` via `'claimHook' in opts` presence check (passing `null` clears, omitting leaves alone). Class fields made mutable.
- CLI workflow watcher rebuilds `claimConfig` from reloaded `WORKFLOW.md`, re-resolves `claim_state` only when name changed, pipes new hooks + assignee filter through `applyConfig`.
- Toggling `tracker.claim_on_dispatch` in `WORKFLOW.md` now takes effect without daemon restart.

327/327 daemon tests green across the four commits. macOS app + wire schema unchanged.

---

## Shipped — v1.4.10.4 / v1.4.10.5 / v1.4.11 / v1.4.12

### v1.4.10.4 — Per-issue team resolution (`a3854a6`)

`Tracker.resolveStateIdByName(name, opts?: { teamId? })` extended; `LinearTracker.cachedStateIdByNameByTeam` keyed by team.id; `ISSUE_ASSIGNEE_QUERY` peek now also fetches `team.id`. `claimIssue` resolves `stateName` against the issue's actual team in multi-team projects, falls back to caller-supplied `stateId` on miss. `ClaimOptions.stateName` added; CLI passes both.

### v1.4.10.5 — Stale-claim TTL sweeper (`3c2607e`)

`Tracker.fetchStaleSelfClaimedIssues?(activeStates, ttlMs)` optional method. Linear runs `assignee=self AND state in active AND updatedAt < cutoff`; mock returns all self-claimed active. Orchestrator gains `staleClaimTtlMs` option (default 0 = disabled); each tick after dispatch loop, sweeps stale-self issues NOT in `running`/`claimed` and fires `releaseHook` (best-effort). `WORKFLOW.md tracker.stale_claim_ttl_ms` threaded + hot-reloadable. Solves the multi-instance case where two daemons share a Linear API key — daemon A crashes mid-claim, daemon B's sweeper releases the ticket after TTL.

### v1.4.11 — `Tracker.createIssue` + `file_ticket` MCP tool (`c1cfc3c`)

`Tracker.createIssue?(input): Promise<{id, identifier, url}>` interface method (optional). `LinearTracker` runs `issueCreate` mutation against the project's primary team (resolved + cached on first call), with label-name → id resolution (cached). Mock returns synthetic `MOCK-N` identifier and exposes `createdIssues()` for test inspection. New `POST /trackers/issues` HTTP endpoint (404 / 501 / 400 / 502 / 201). New MCP tool `dispatch__file_ticket(title, description?, labels?, priority?)` POSTs to the daemon over `DISPATCH_PORT` and mirrors a `decision` event with `choice='file_ticket'` so the Radar surfaces the action. Tracker late-bound into `buildHttpServer` via the same closure-getter pattern as orchestrator.

### v1.4.12 — Linear → Radar mirror (`1309cb5`)

New `daemon/src/tracker-mirror.ts` ticker — fetches `mirror_states` issues every `mirror_interval_ms` and creates a `status='backlog'` workstream + `workstream_link` for each unlinked issue. Idempotent via new `WorkstreamLinksStore.findByIssueId` (uses existing `idx_links_issue` index). Never demotes existing `active`/`paused` workstreams. `WORKFLOW.md tracker.mirror_to_radar` (default off), `mirror_states` (defaults to `active_states ∪ ['Backlog', 'Triage']`), `mirror_interval_ms` (default 60s), `mirror_max_age_days` (default null/no cutoff). Hot-reloadable; flipping enabled in/out start/stops the ticker. macOS app sees mirrored issues as new backlog cards in the existing Kanban — zero client changes.

351/351 daemon tests green across the four follow-on commits.

---

## When to revisit v1.4.13 (`TrackerWriter` abstraction)

**Skipped.** The current `Tracker` interface mixes read + optional write methods (`claimIssue?`, `releaseIssue?`, `resolveStateIdByName?`, `createIssue?`, `fetchStaleSelfClaimedIssues?`). That shape works fine for one tracker.

Lift the writes into a separate `TrackerWriter` interface only when:

1. A second tracker has a real product ask (Jira / GH Issues / something else) — so the Linear-shaped concepts (`stateId`, `assigneeId`) actually need normalization (Jira `transitionId`, etc.).
2. The cost of refactoring the orchestrator + CLI + workflow loader to switch from `tracker.claimIssue?` to `tracker.writer?.claim` is justified by the second adapter avoiding a copy-paste of the v1.4.10.x logic.

Until both are true, doing this refactor is premature abstraction — the current optional methods are perfectly fine.

---

## Earlier plans (kept for historical context)

These were the pre-shipping plans for v1.4.10.4 / .5 / .11 / .12 — preserved so the design rationale is reviewable next to what actually shipped. Skim these only if you're auditing the design intent.

### v1.4.10.4 (planned) — Per-issue team `resolveStateIdByName` for multi-team projects

**Problem.** Today's `LinearTracker.resolveStateIdByName` only sees one team — the team of the first issue in the project. Linear allows projects to span multiple teams, each with its own workflow-state set. A `claim_state: "In Progress"` that exists on Team A but not Team B will resolve correctly when an issue from A claims, but fail silently when an issue from B claims (state stays put, daemon logs a warning, assignee still flips).

**Fix.** When `claimHook` runs for an issue, pass the issue's `team.id` to the resolver; cache name→id maps keyed by team-id. The current project-level cache stays as a backstop for callers that don't know the team yet.

**Substeps.**
1. `LinearTracker.resolveStateIdByName(name, opts?: { teamId?: string }): Promise<string | null>` — when `teamId` is provided, query that team's `workflowStates` directly and cache by team-id. Without `teamId`, fall back to current project-primary path.
2. New private `cachedStateIdByNameByTeam: Map<string, Map<string, string>>` field. Populate per call.
3. `claimHook` in `cli.ts` needs the `team.id`. Easiest: extend the existing `ISSUE_ASSIGNEE_QUERY` (which already runs inside `claimIssue` to peek the assignee) to also fetch `team.id`, and have `claimIssue` accept an optional `claimStateName` instead of (or in addition to) the pre-resolved `stateId`. Linear's `claimIssue` resolves the name itself when the team is now known.
4. CLI: `claimConfig.claimStateName` carries the raw name; `claimStateId` becomes a fallback for non-Linear trackers. `buildClaimHook` passes name first, id second.
5. Tests: a) team A returns one stateId, team B returns a different stateId for the same name, b) team B with no matching name → null + warning.

**Risk.** Linear's `team` lookup adds one round-trip per claim (the assignee peek already runs, but it currently doesn't fetch the team). Acceptable cost — claims are O(workstreams started), not O(messages).

### v1.4.10.5 (planned) — Stale-claim TTL sweeper for multi-instance recovery

**Problem.** Two daemons running with the same Linear API key + `unassigned_or_self` filter both pass each other's claims as "self" and race. The clean fix is per-instance bot users in Linear, but the org may not want to provision them.

**Fix.** Optional periodic sweeper that releases tickets which:
1. Have `assignee = selfUserId`.
2. Are NOT in the local `running` map.
3. Were last touched (Linear's `updatedAt`) more than `tracker.stale_claim_ttl_ms` ago.

Releases unblock the *other* instance to re-claim normally. If both instances run the sweeper, they coordinate via the timestamp ordering — whoever last touched the ticket holds it.

**Substeps.**
1. New `LinearTracker` method `fetchSelfClaimedIssues(activeStates, ttlMs): Promise<Issue[]>` — filters by `assignee.id = self AND updatedAt < now - ttlMs AND state in active`.
2. Orchestrator gains an optional `staleClaimSweeper` interval timer (configured via new `OrchestratorOptions.staleClaimTtlMs`). On tick, fetches stale-self issues, filters out ones in `running`, calls `releaseHook` on the rest.
3. `WORKFLOW.md` `tracker.stale_claim_ttl_ms` (number, optional, defaults disabled). Threaded through `coerceTracker` + `applyConfig`.
4. Tests: a) a ticket older than TTL not in running gets released, b) a ticket older than TTL but currently running does NOT get released, c) a ticket newer than TTL is left alone.

**Risk.** Race window: instance A is mid-spawn, instance B's sweeper sees A's claim is older than TTL (because A hasn't updated the ticket yet) and releases it. Mitigation: the orchestrator should `addIssueComment` (lightweight heartbeat — already wired) every N minutes to keep `updatedAt` fresh. Defer heartbeat to v1.4.10.6 if needed.

### v1.4.11 (planned) — `Tracker.createIssue` + triage agent (option #2)

**Goal.** Daemon files new tickets, not just operates on existing ones. Two driving use cases:
1. **Triage agent** — a long-running autonomous workstream whose job IS Linear. Grooms backlog, dedupes, labels, estimates. Files new tickets when it finds work that should be tracked.
2. **Mascot bug-reports** — when the dogfood mascot detects an issue worth fixing (failed assertion, hook crash, etc.), the daemon files a Linear ticket so the work is captured even when the human isn't watching.

**Substeps.**
1. `Tracker.createIssue?(input: CreateIssueInput): Promise<{ id: string; identifier: string }>` added to interface as optional. `CreateIssueInput`: `{ title, description, labels?: string[], priority?: number | null, teamId?: string }`.
2. `LinearTracker.createIssue` via Linear's `issueCreate` mutation. Team id defaulted to the project's primary team (already resolved for state-name caching). Labels resolved from name→id via a new `cachedLabelIdByName` map (similar pattern to states).
3. `MockTracker.createIssue` appends to its in-memory issue list with a synthetic id; tests inspect via the existing `claimedAssignees()`-style accessor.
4. HTTP endpoint `POST /trackers/issues` — body `{ title, description, labels?, priority? }`. Returns `{ id, identifier }`. Calls `tracker.createIssue` if present, else 501.
5. MCP tool `dispatch__file_ticket(title, description, labels?, priority?)` — wraps the HTTP endpoint so any agent (triage, mascot, or a regular session that decides to spawn its own scope) can file a ticket.
6. Triage workflow: `WORKFLOW.md` ships a `prompt_template` that emphasizes grooming + filing + labeling, and runs only against issues in a `triage_states: ['Triage']` set. Same orchestrator, just a different prompt + state filter.
7. Tests: a) Linear `createIssue` posts `issueCreate` mutation, b) MCP tool blocks until tracker write succeeds, c) HTTP endpoint 501 when tracker doesn't implement.

**Risk.** Triage agents loop. Backstop: `tracker.create_on_dispatch_max_per_hour` rate-limit knob in `WORKFLOW.md`, enforced in the MCP tool handler. Default 10/hour.

### v1.4.12 (planned) — Linear → Radar full mirror as draft workstreams (option #3)

**Goal.** Today the Radar shows only workstreams the human (or orchestrator) has explicitly created. Linear-tracked work that hasn't started yet is invisible. v1.4.12 surfaces every Linear issue in the project as a `status='draft'` workstream; human promotes draft → active to spawn an agent.

**Substeps.**
1. `Workstream.status` enum gains `'draft'` (after `'backlog'`). macOS Codable already has unknown-value fallback; client-side update layered in v1.4.12.0.
2. New ticker `TrackerMirror` (mirrors `LinearCommentSyncer` shape) that runs every N seconds: fetch all candidate issues, ensure each has a corresponding workstream in `workstream_links` table with `status='draft'` if not already linked. Decisions: don't auto-create workstreams that are already linked (idempotent), don't downgrade existing `active` workstreams to `draft`.
3. Kanban gets a new "Drafts" column to the left of Backlog. Drag draft → Backlog or Active triggers the existing PATCH path; orchestrator picks them up on the next tick if `status='active'` AND `claim_on_dispatch=true`.
4. macOS app: `KanbanColumn.draft` adds. `KanbanBoardView` enum case. `WorkstreamDragPayload.status` accepts the new value.
5. `WORKFLOW.md` knob `tracker.mirror_to_radar: bool` (default false). Pairs poorly with `claim_on_dispatch` — if both are on, mirror creates draft, drag-to-active triggers claim. Document the combined flow.
6. Tests: a) mirror creates draft workstream for new Linear issue, b) doesn't downgrade an existing active workstream, c) idempotent on second tick, d) issue closed in Linear → workstream `retired` (existing reverse-sync).

**Risk.** Burst on first run — a project with 5000 historical issues materializes 5000 draft workstreams. Mitigation: `tracker.mirror_max_age_days` cutoff (default 90). Issues older than the cutoff stay invisible until manually linked.

### v1.4.13 (planned, deferred) — `TrackerWriter` abstraction for Jira / GH Issues swap

**Problem.** Today the Linear write paths (`claimIssue`, `releaseIssue`, `resolveStateIdByName`, future `createIssue`) live as optional methods directly on the `Tracker` interface. Adding Jira would mean a Jira impl of every method, but those methods are Linear-shaped (e.g., `stateId` is a Linear concept; Jira has `transitionId`). The abstraction is leaking.

**Fix.** Split `Tracker` (read-side) from `TrackerWriter` (write-side). Each adapter exports both; CLI + orchestrator look up `tracker.writer` (optional) for write paths. Concepts get normalized:
- `claimIssue(issueId, { actor })` — actor is whatever the tracker wants (user id, transition id).
- `applyTransition(issueId, transitionName)` — generalizes `setIssueState` + Jira's transition concept.

**Substeps.**
1. New file `daemon/src/trackers/writer.ts` defining `TrackerWriter` interface.
2. `LinearTrackerWriter` extracted from `LinearTracker`. Tracker keeps a `writer: TrackerWriter | null` getter.
3. CLI / orchestrator probe for `tracker.writer?.claim` instead of `tracker.claimIssue?`.
4. Stub `JiraTrackerWriter` + `GitHubIssuesTrackerWriter` (return `not_implemented` for now — just proves the abstraction holds).
5. Tests: existing v1.4.10.x tests get refactored to call `tracker.writer.claim(...)`. No behavior change, just shape.

**Risk.** Big refactor — touches the orchestrator + CLI + workflow loader. Worth doing only if a second tracker is concretely on the roadmap. **Defer this until either Jira or GH Issues has a clear product ask.** For now, `Tracker` stays mixed read+write and we live with the Linear-shaped abstraction.

---

## Cross-cutting open questions

- **Auth for write paths from remote/mobile clients.** Today everything is localhost-only. v1.5 adds remote API access; that's when the question of "can a mobile client mark a ticket Done in Linear via Dispatch" actually matters. Not blocking v1.4.x.
- **Idempotency on partial writes.** If `claimIssue` mutation succeeds but the daemon crashes before recording the local `running` entry, the next tick re-claims (idempotent — assignee already self, mutation no-ops). But if `releaseIssue` succeeds and the daemon crashes before terminal-state propagates to the workstream registry, we'd have a workstream still in `active` with no Linear claim. Reverse-sync (`LinearCommentSyncer`) catches this on the next tick. Acceptable.
- **What happens when `claim_state` is set on a non-Linear tracker.** Today: the resolver returns `null` (mock returns name-as-id; future Jira would need its own implementation). The CLI logs a warning but still claims. Document this behavior in the Jira adapter when it ships.
- **Whether to surface Linear write errors in the Radar UI.** Today they go to stderr. A `tracker_write_failed` event type would let the macOS app show a banner. Worth doing once write paths are heavily relied on — not yet.

---

## How to continue this work in a fresh session

The original three-tier "Dispatch manages Linear" thread is **done**. v1.4.10 → v1.4.10.5 → v1.4.11 → v1.4.12 are all shipped and pushed. There is no obvious next substep — what comes next depends on a product signal. The candidates worth picking up if/when one arrives:

1. **Triage-agent prompt template** (extends v1.4.11). Curated `WORKFLOW.md` that biases the agent toward grooming + filing tickets. Pair with a `tracker.create_max_per_hour` rate-limit knob inside `dispatch__file_ticket` so a runaway agent can't spam Linear. Small (~half-day).
2. **Macos Drafts column** (extends v1.4.12). Visual separation of mirrored vs human-created backlog cards. Requires SwiftUI changes (`KanbanColumn` enum, `KanbanBoardView` switch, `WorkstreamDragPayload`). Cosmetic — defer until a user asks.
3. **`TrackerWriter` abstraction** (v1.4.13). Only when a second tracker (Jira / GH Issues) has a real product ask. See "When to revisit v1.4.13" above.
4. **Heartbeat for stale-claim TTL** (v1.4.10.6). Currently a long-running healthy daemon's claim could be falsely released by another instance's sweeper if the ticket hasn't received a touch in TTL minutes. Fix is a lightweight `addIssueComment` (or `noOp issueUpdate`) every TTL/2 from the orchestrator. Small.

Process for any of these:

1. Read this doc.
2. `cat TODO.md` (per-version sections are the source of truth for what's shipped).
3. Run `cd daemon && npx vitest run --reporter=basic` to confirm green baseline (currently 351 tests).
4. Implement against the matching substep plan above. If the plan is wrong, update this doc in the same commit.
5. Commit per substep with the conventional format used in `git log` (e.g., `feat: ... (vX.Y.Z)`).
6. Push when a milestone lands.

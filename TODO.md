# Project TODO

Substep-level task list for shipped + in-flight milestones. Roadmap context lives in [`docs/ROADMAP.md`](docs/ROADMAP.md).

Conventions: `[x]` shipped, `[~]` in progress, `[ ]` pending, `[-]` deferred. Each top-level group corresponds to a roadmap milestone.

---

## v1.2 — Code-layer Dispatch rename + Kanban + Linear

- [x] Code-layer rename Manager → Dispatch (daemon binary, env vars, state dir, launchd label, Xcode project, bundle id, custom logo, Swift module name workaround for system libdispatch).
- [x] **Kanban board** — 4-column `KanbanBoardView` (Backlog / Active / Paused / Retired) with `.draggable(WorkstreamDragPayload)` cards + `.dropDestination` PATCH calls. Pod auto-grouping kicks in on the Active column above 12 cards (`shouldGroupPod`). The old `LazyVGrid`-based `TeamFloorView` is removed entirely. Digest filter dims non-matching cards in place rather than reflowing columns.
- [x] **Linear.app integration** — `workstream_links` SQLite table + 4 HTTP endpoints (GET/PUT/DELETE `/workstreams/:id/link`, GET `/links`); macOS `LinearChip` in the agent-detail header opens `LinkLinearSheet` when unlinked, surfaces Open-in-Linear / Unlink when linked. Settings → Providers gains a `linearApiKey` SecureField. Bidirectional sync ticker `LinearCommentSyncer` posts high-confidence decisions as Markdown comments (forward) and reflects Linear state transitions back into Dispatch status (reverse, with user-override respect).
  - Fulfills the v1.4.3 deferred item *"workstream_links SQLite table — folds in when v1.2 Link UI ships"*. The orchestrator still uses sanitized identifier as workstream id directly; the link table is for the manual link UI + sync ticker.

---

## v1.3 — MLX local LLM + `/dispatcher` slash command + MANAGER_* removal ✅

- [x] **MLX-backed local LLM** — replaced Ollama-only `/api/chat` path with generic OpenAI-compatible `/v1/chat/completions` keyed on `DISPATCH_LLM_BASE_URL`. Default `http://localhost:8080/v1` (mlx_lm.server). `OLLAMA_URL` honored as legacy alias; bare `http://localhost:11434` auto-promoted to `/v1`. Pure-Swift MLX inside the macOS app remains a stretch goal.
- [x] **`/dispatcher` slash command + URL scheme** — `dispatch://workstream/<slug>` registered in `Info.plist` `CFBundleURLTypes`. `commands/dispatcher.md` derives the slug from the current git root and runs `open dispatch://workstream/<slug>`. `bin/install.sh` copies it to `~/.claude/commands/` and runs `lsregister -f` after the `.app` lands. Parser ships in both `daemon/src/url-scheme.ts` (canonical) and `client-macos/Dispatch/Daemon/DispatchURLParser.swift` (Swift port).
- [x] **Remove `MANAGER_*` env-var fallbacks** — `readEnvWithLegacy` helper deleted, six daemon read sites + the POSIX-shell `dispatch__legacy_env` helper + the macOS `MANAGER_DAEMON` lookup all removed. Filesystem state migration `~/.claude/manager → ~/.claude/dispatch` in `bin/install.sh` is preserved.
- [x] **Tooltips + UX polish** — shipped in v1.4.5 (see below).
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

## v1.4.5 — UX feedback wave (Feedback.md) ✅ shipped 2026-05-06

Driven entirely by `Feedback.md`. No architectural changes — additive fields only, all backwards compatible. Full notes in [`RELEASE_NOTES.md`](RELEASE_NOTES.md). Tag [`v1.4.5`](https://github.com/S-KSM/Manager/releases/tag/v1.4.5).

- [x] **Settings → Providers tab** — new `GET/PATCH /settings` endpoint backed by `~/.claude/dispatch/settings.json` (key redacted on the wire); `PreferencesView` Providers tab with provider/model/Ollama-URL/key fields + reachability probe. Env vars remain a fallback.
- [x] **Sleeping Robot mascot** — daemon emits `live_session: bool` per workstream (latest `session_start` newer than `session_end`); `digest.live_sessions[]` for the rollup. `RobotMascot` gains `Asleep` state (dim + desaturate + closed-eye sleep arc + floating `Zzz`). Wired in HomeView card + AgentDetailView header.
- [x] **First-launch demo data race** — `DaemonResolver` was seeded with the fixture `MockDaemonClient()`; now seeds `MockDaemonClient.empty()` so the Radar shows the WelcomeView empty state during the `/health` resolve window. Cmd-Shift-M toggle and SwiftUI previews still construct the fixture client.
- [x] **`AgentDetailView` autoscale** — HSplitView pane mins reduced (640 → 500) so panes reflow below 820 width. Header truncates; status pill fixed-size.
- [x] **`DigestRailView` chips** — wrapped in horizontal `ScrollView` so chips no longer clip at narrow widths.
- [x] **`WelcomeView` rewrite** — lead sentence + 3 numbered steps + copy-able `claude` snippet + Tutorial / Settings → Providers / Architecture links; daemon-down recovery copy tightened.
- [x] **Tooltips** — `.help(...)` added to every previously-tooltip-less Button across `HomeView` (4), `WelcomeView` (5), `PreferencesView` (2). Other view files audited and were already complete.
- [x] **Tutorial + Help docs** — `docs/TUTORIAL.md` refreshed for v1.4 (autonomous mode + Settings → Providers + version refresh); `docs/LOCAL_MODELS.md` mentions Settings → Providers and confirms `claude` + `ollama` providers (MLX still v1.3-deferred); README pointer to in-app Help menu and `docs/TUTORIAL.md`.
- [x] **Version bump** — `CFBundleShortVersionString 0.1.0 → 1.4.5`, `MARKETING_VERSION → 1.4.5`, `daemon/package.json 0.0.1 → 1.4.5`. `RELEASE_NOTES.md` introduced.

---

## v1.4.6 — Diagnostics tab (kill / restart) ✅ shipped 2026-05-07

Lands on top of v1.2 (Kanban + Linear UI) and v1.3 (MLX + URL scheme + MANAGER_* removal) — all three milestones bundled under binary tag [`v1.4.6`](https://github.com/S-KSM/Manager/releases/tag/v1.4.6). Wire schema additive — new field on `GET/PATCH /settings`, three new POST endpoints under `/admin/`. Full notes in [`RELEASE_NOTES.md`](RELEASE_NOTES.md).

- [x] **Settings → Diagnostics tab** — Four buttons: Kill Local LLM, Restart Local LLM, Restart Daemon — Soft, Restart Daemon — Hard. Destructive actions confirm via `confirmationDialog`; each surfaces last-result text inline.
- [x] **Daemon admin endpoints** — `POST /admin/llm/kill` (lsof + SIGTERM with 3s grace → SIGKILL), `POST /admin/llm/restart` (kill flow + `bash -lc <localLLMStartCommand>` detached), `POST /admin/restart` (cancel + re-instantiate Headliner / SubgoalSynthesizer / LinearCommentSyncer in place). Pure helpers in `daemon/src/admin.ts` (parseHostPort / findPidOnPort / killWithEscalation / spawnDetached) take injectable side-effect mocks.
- [x] **`localLLMStartCommand` settings field** — Cleartext on the wire (not a credential). New TextField on the Providers tab. Empty string → Restart-Model button disabled with "Set a start command first" tooltip.
- [x] **`LaunchctlController.kickstart()`** — Hard restart shells out to `launchctl kickstart -k gui/<uid>/com.dispatch.daemon` rather than hitting a daemon endpoint (the daemon would die mid-response). `Result<Void, KickstartError>` surfaces non-zero exits with the stderr tail.

---

## v1.4.10 — Tracker write-back: daemon claims Linear tickets on dispatch (in flight)

Smallest escalation toward "Dispatch manages Linear" (option 1 of 3 — daemon writes to existing tickets; ticket creation + full-mirror are deferred to v1.4.8 / v1.4.9). Wire schema additive — new optional `tracker.claim_*` block in `WORKFLOW.md`, new methods on the `Tracker` interface, no breaking change to existing observation-only setups. Without `claim_on_dispatch: true`, behavior is identical to v1.4.6.

- [x] **Tracker interface gains write ops** — `claimIssue(issueId, { stateId?, assigneeId? })` + `releaseIssue(issueId, { stateId? })` added to `Tracker` (`daemon/src/trackers/index.ts`) as optional methods (orchestrator probes for presence). Mock impl is an in-memory assignee map keyed by issue.id (test inspection via `claimedAssignees()`). Linear impl maps to a generalized `issueUpdate` mutation. New `TrackerError` codes: `linear_assignee_taken` (claim collided — different user already assigned) + `linear_self_user_failed` (viewer query returned no id).
- [x] **Linear viewer cache** — `LinearTracker.selfUserId()` resolves `query { viewer { id } }` lazily on first call, caches in-memory. Used for assigning + the `assignee=self` GraphQL filter.
- [x] **Assignee filter on `fetchCandidateIssues`** — optional second arg `{ assigneeFilter?: 'any' | 'unassigned' | 'self' }`. Default `'any'` (current behavior). Mock filters in-memory; Linear inlines the clause as a string fragment (`assignee: { null: { eq: true } }` or `assignee: { id: { eq: "<selfId>" } }`) since GraphQL typed variables can't carry "is null". Multi-daemon races bounded — strict `unassigned` filter means a second daemon won't even see a ticket the first one has claimed.
- [x] **WORKFLOW.md `tracker.claim_*` block** — `claim_on_dispatch: bool` (default false), `assign_to_self: bool` (defaults true when claim is on), `claim_state: string | null` (optional Linear state name; resolved at boot via `tracker.resolveStateIdByName` in v1.4.10.1), `unassigned_only: bool` (defaults true when claim is on). `coerceTracker` in `workflow-loader.ts` resolves them; v1.4.10.3 makes the watcher rebuild claim/release hooks + re-resolve `claim_state` (only when changed) so toggling `claim_on_dispatch` live no longer requires a daemon restart.
- [x] **Orchestrator claim-before-spawn** — pre-dispatch `claimHook` runs inside `dispatchInternal`'s async IIFE BEFORE `dispatchOne`. On `{ ok:false, collided:true }` (TrackerError code `linear_assignee_taken`) the orchestrator drops local `running`/`claimed` state and logs `orchestrator.claim_collided` — next tick re-evaluates from scratch. On `{ ok:false, error }` it logs `orchestrator.claim_failed` and skips. The retry-fire path bypasses the assignee filter (uses `'any'`) so a known issue id we already hold can still be re-fetched after the assignee was set.
- [x] **Orchestrator release-on-terminal** — `reconcileRunning` fires `releaseHook({ issueId, identifier })` as best-effort fire-and-forget when an issue moves to a terminal state. Failures log `orchestrator.release_failed` but never block reconciliation. (Initial design considered release-on-worker-failure; rejected because the next retry re-claims cleanly and the failed-then-retried sequence is more common than a permanent abort.)
- [x] **Tests** — `daemon/test/trackers/linear.test.ts` +7 cases (viewer cache, viewer-null error, claim success, claim collision, release clears assignee, unassigned filter clause, self filter clause). `daemon/test/orchestrator.test.ts` +3 cases (claim collision skips dispatch, claim ok → release on terminal, claim throw → `claim_failed` log). `workflow-loader.test.ts` +1 case (default-off, opt-in flips assign_to_self + unassigned_only). 320 / 320 daemon tests green.
- [x] **Docs** — `docs/ARCHITECTURE.md` Orchestrator section gains "Tracker write-back (v1.4.10)" subsection. `RELEASE_NOTES.md` v1.4.10 entry. `CLAUDE.md` status block bumped.

### v1.4.16 — Triage workflow template + file_ticket rate limit + ollama-not-installed hint ✅

Bundles two small follow-ups that close the v1.4.11 and v1.4.13/.14 loops. Single tag.

- [x] `examples/WORKFLOW.triage.md` — first opinionated triage-agent template. All v1.4.10.x / v1.4.11 / v1.4.12 knobs in one annotated config + 4-step grooming/file/handoff prompt.
- [x] `POST /trackers/issues` rate limit — `BuildOptions.fileTicketMaxPerHour` (default 30/hour). 429 with `{code: 'file_ticket_rate_limited', retry_after_ms, limit}`. Failed writes don't consume a slot. CLI threads `DISPATCH_FILE_TICKET_MAX_PER_HOUR` env override. +3 http-server tests.
- [x] `LLMErrorView.detectsMissingOllamaCLI(in:)` — second failure-mode detection. Shows a `Get Ollama` Link to ollama.com/download when the error is "ollama CLI not found on PATH" / "ollama: command not found" / "spawn ollama ENOENT". Model-not-found takes priority when both patterns are present. +5 macOS unit tests.
- [x] 361/361 daemon + 13/13 macOS LLMErrorView tests green.

Realistic finding while shipping this: there's only ONE LLM-error surface in the macOS app today (GenerateReportSheet, already wired in v1.4.14). UpdatesView/HomeView/InterventionPanel error paths carry daemon-API errors, not LLM. Future LLM-error surfaces should use `LLMErrorView` instead of bare `Label` so the Pull and Get-Ollama actions come for free.

### v1.4.14 — Actionable model-not-found error toasts ✅

Closes the dogfood loop from v1.4.13. The error toast itself now offers the Pull action — no navigation required.

- [x] New `LLMErrorView` wraps any error string, regex-detects `model '<name>' not found` across single/double/backtick quote variants, inlines a "Pull <name>" button that calls `client.pullModel(name)` directly. Status (spinner / check / exclaim) renders alongside without dismissing the dialog.
- [x] `GenerateReportSheet` rewritten to use `LLMErrorView` (the actual surface that prompted the v1.4.13 screenshot).
- [x] Defense-in-depth: model-name regex pattern matches the same `[A-Za-z0-9._:/-]` character class daemon-side `pullOllamaModel` validates. Shell-metacharacter injection rejected.
- [x] +8 macOS unit tests (3 quote styles, case-insensitive, HuggingFace path-style, unrelated errors → nil, shell-injection rejected, lastNonEmptyLine helper).

Future: same enrichment for `Headliner` debug toasts + a HuggingFace-style "Fetch from HF" button for mlx_lm.server / llama.cpp users (their runtimes don't have a CLI pull command — model lands on first inference).

### v1.4.13 — Pull-model button (one-click `ollama pull` from Settings) ✅

Surfaced after a `model 'qwen3:8b' not found` 404 in dogfood — users shouldn't have to drop to a terminal to download a missing model.

- [x] `pullOllamaModel(model)` helper in `daemon/src/admin.ts`. Spawns `ollama pull <model>`, captures truncated stdout+stderr tail (~4 KB), validates model name pattern, maps ENOENT to a clear hint.
- [x] `POST /admin/llm/pull-model` endpoint. 400 missing-model, always 200 otherwise so the UI can show the failure tail without treating the request itself as failed.
- [x] macOS Settings → Providers tab "Pull" button next to Model field. Ollama-only; disabled when model empty or provider is `.claude`. `ProgressView` while pulling; result line with colored icon below.
- [x] `LiveDaemonClient.pullModel(_:)` + `PullModelResult` Codable + `MockDaemonClient` stub.
- [x] +7 tests (4 admin helper, 3 http endpoint). 358/358 daemon tests green. macOS app build succeeds.

Future: a similar one-click "fetch from HuggingFace" button for mlx_lm.server, plus an action button on the in-app `model not found` error toast that deep-links to Settings → Providers and pre-fills the model name.

### v1.4.12 — Linear → Radar full mirror as backlog workstreams ✅

Option #3 of the original three-tier escalation. Surfaces all Linear work in the Radar without manual linking.

- [x] `daemon/src/tracker-mirror.ts` — new `TrackerMirror` ticker. Creates `status='backlog'` workstream + link for each unlinked candidate issue. Never demotes existing `active`/`paused` workstreams. Idempotent via `WorkstreamLinksStore.findByIssueId`.
- [x] `WorkstreamLinksStore.findByIssueId(issueId)` reverse lookup added (uses existing `idx_links_issue` index).
- [x] `WORKFLOW.md` `tracker.mirror_to_radar` / `mirror_states` / `mirror_interval_ms` / `mirror_max_age_days` knobs. Defaults off; `mirror_states` falls back to `active_states ∪ ['Backlog', 'Triage']` when unset.
- [x] CLI lifecycle: instantiate when enabled at boot, hot-swap (start/stop) on workflow reload, stop alongside orchestrator on shutdown.
- [x] macOS app: zero changes — mirrored issues appear as new cards in the existing Backlog Kanban column; user drags to Active to promote.
- [x] +6 tests across `tracker-mirror` + `workflow-loader`. 351/351 daemon tests green.

### v1.4.11 — Tracker.createIssue + file_ticket MCP tool ✅

Option #2 of the original three-tier escalation. Daemon now files new tickets, not just claims existing ones.

- [x] `Tracker.createIssue?(input)` interface method added; `CreateIssueInput` + `CreateIssueResult` types.
- [x] `LinearTracker.createIssue` via `issueCreate` mutation. Caches primary team id + label name→id map on first call. Unknown label names silently dropped. Empty title rejected before network call.
- [x] `MockTracker.createIssue` returns synthetic `MOCK-N` identifier + exposes `createdIssues()` for test inspection.
- [x] `POST /trackers/issues` HTTP endpoint with full status-code matrix (404 / 501 / 400 / 502 / 201).
- [x] `dispatch__file_ticket` MCP tool POSTs to daemon over `DISPATCH_PORT`, mirrors a `decision` event on success so the Radar surfaces the action.
- [x] Tracker late-bound into `buildHttpServer` via closure-getter (same pattern as orchestrator).
- [x] +10 tests across `linear` / `http-server` / `mcp-server`. 345/345 daemon tests green.

Triage-agent **workflow** (a `WORKFLOW.md` template that biases the agent toward grooming + filing) and rate-limiting on `file_ticket` are deferred to v1.4.11.x — the plumbing this ships unblocks both.

### v1.4.10.5 — stale-claim TTL sweeper ✅

- [x] `Tracker.fetchStaleSelfClaimedIssues?(activeStates, ttlMs)` added as optional interface method.
- [x] `LinearTracker` impl runs a GraphQL filter on `assignee.id = self AND state in active AND updatedAt < cutoff` (page cap 100). Mock returns all self-claimed active issues regardless of age (mock has no `updatedAt`).
- [x] Orchestrator `staleClaimTtlMs` option (default 0/disabled). After every tick's dispatch loop, sweeps stale-self issues not in `running`/`claimed` and fires `releaseHook` (best-effort fire-and-forget). Failures log `orchestrator.stale_sweep_failed` / `orchestrator.release_failed`, never abort.
- [x] `WORKFLOW.md` `tracker.stale_claim_ttl_ms` parsed in `coerceTracker`, threaded through `applyConfig` (hot-reloadable).
- [x] +5 tests (Linear stale query shape + ttl=0 short-circuit, orchestrator releases not-in-running stale, orchestrator skips in-running stale, workflow loader default + opt-in). 335/335 daemon tests green.

### v1.4.10.4 — multi-team claim_state resolution ✅

- [x] `Tracker.resolveStateIdByName?(name, opts?: { teamId? })` extended; `ClaimOptions` gains `stateName`.
- [x] `LinearTracker` adds `cachedStateIdByNameByTeam` + `TeamStates` GraphQL query. `ISSUE_ASSIGNEE_QUERY` peek now fetches `team.id`. `claimIssue` resolves `stateName` per issue's team and falls back to caller-supplied `stateId` on miss.
- [x] CLI's `buildClaimHook` passes both `stateName` and the eager `stateId`.
- [x] +3 Linear tests (per-team cache, multi-team prefers stateName, stateName miss → stateId fallback). 330/330 daemon tests green.

### v1.4.10.3 — hot-swap claim/release hooks on WORKFLOW.md reload ✅

- [x] `Orchestrator.applyConfig` swaps `claimHook` / `releaseHook` via `'claimHook' in opts` presence check (passing `null` clears; omitting leaves alone). `OrchestratorOptions.claimHook` / `.releaseHook` widened to `ClaimHook | null` so the same shape propagates through `Partial<>`. Fields made mutable on the class.
- [x] CLI workflow watcher rebuilds `claimConfig` from reloaded `WORKFLOW.md`, re-resolves `claim_state` only when name changed (preserves cached `claimStateId` otherwise — no round-trip on every save), pipes new hooks + assignee filter through `applyConfig`.
- [x] +1 orchestrator test (hot-swap collision hook in, then clear it back to null). 327/327 daemon tests green.

### v1.4.10.2 — stale-claim re-discovery ✅

- [x] New `AssigneeFilter` value `'unassigned_or_self'`. Linear inlines `or: [{...null...}, {...id eq selfId...}]`; mock matches `null OR == selfId`.
- [x] CLI's `assigneeFilterFor` defaults to the new variant when `unassigned_only` is on. Strict `'unassigned'` retained on the union for callers that want hard "leave already-claimed alone" semantics.
- [x] +2 tests (Linear `or:` clause assertion, mock cross-user filter). 326/326 daemon tests green.
- Solves the common single-user-restart case. Multi-instance with shared Linear creds would still race — but that scenario was always going to need stale-claim TTL or per-instance user accounts; deferred to v1.4.11+.

### v1.4.10.1 — claim_state resolver ✅

- [x] `Tracker.resolveStateIdByName?(name): Promise<string | null>` added as optional interface method.
- [x] `LinearTracker.resolveStateIdByName` runs `issues(filter: project, first: 1) { team { states } }`, caches the full lowercased name→id map for the project's primary team. Returns null on empty project (won't cache; retries next call).
- [x] `MockTracker.resolveStateIdByName` returns name back as id (identity) so JSON-fixture tests don't need a separate state directory.
- [x] CLI eager-resolves `cfg.tracker.claim_state` once at boot via `resolveClaimStateId(tracker, name)` helper; populates `claimConfig.claimStateId`. Resolution miss / resolver-not-implemented / thrown error all degrade to assignee-only claim with a one-line stderr warning.
- [x] `buildClaimHook` passes `stateId` to `tracker.claimIssue` only when `claimStateId !== null`.
- [x] +4 Linear tests (cache hit on call #2, empty-project null, unknown-name null, claim with stateId writes assignee + state in one mutation). 324/324 daemon tests green.

Deferred (no concrete product driver):
- **v1.4.13 TrackerWriter abstraction** — splitting `Tracker` into read+write halves and adding stub Jira / GH Issues adapters. Would touch orchestrator + CLI + workflow loader. Per `docs/LINEAR_INTEGRATION.md`: don't ship until a second tracker has a real product ask. The current Linear-shaped optional methods (`claimIssue?`, `releaseIssue?`, `resolveStateIdByName?`, `createIssue?`, `fetchStaleSelfClaimedIssues?`) are good enough for one-tracker land.
- **v1.4.11.x triage-agent workflow template** — a `WORKFLOW.md` opinionated for grooming + filing tickets, plus rate-limiting on `file_ticket` (e.g. `tracker.create_max_per_hour`). The plumbing in v1.4.11 already supports this; the missing piece is a curated prompt template + a small RPS guard inside `dispatch__file_ticket`.
- **macOS Drafts column** — today mirrored Linear issues land in `Backlog`. A dedicated `Drafts` column visually separates "tracker-mirrored, not yet promoted" from "human-created, not yet active." Cosmetic; defer until a user asks.

Other v1.4.11+ items (no longer relevant after the v1.4.10.x / .11 / .12 thread closed):
- Ticket creation (`tracker.createIssue`) for triage-agent + Mascot-emitted bug reports — the next escalation tier (option #2 of the original three "Dispatch manages Linear" choices).
- Full Linear → Radar draft-workstream mirror — option #3 of the original three.
- Multi-tracker write abstraction (Jira / GH Issues swap-in).

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
- [ ] **Mouse-pointer context Q&A** (Feedback.md round 1, long-term) — cursor's hover target becomes context; user can ask questions about whatever the pointer is on. Likely needs accessibility-API hover capture + a chat affordance pinned to the pointer + LLM round-trip with the captured element as context. Defer until the runtime-expansion shim exists, since the chat surface should reuse the same emit path.

---

## Out of scope (deferred indefinitely)

- True session-state rollback (KV / model-state restoration). Replay-with-hint suffices until proven otherwise.
- Multi-machine workstreams (laptop + cloud).
- Multi-human teams (more than one VP / CEO).
- Billing, usage analytics, cost dashboards.

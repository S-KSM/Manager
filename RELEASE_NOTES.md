# Release Notes

Versions are anchored on the macOS app's `CFBundleShortVersionString` (the Info.plist value before `bin/stamp-app-version.sh` appends `+<sha>`). The daemon's `package.json` version tracks the same string.

---

## v1.4.10 — 2026-05-09 — feat: tracker write-back (orchestrator claims Linear tickets on dispatch)

Not yet tagged. Daemon-only change; macOS app + wire schema unchanged. Behind a `WORKFLOW.md` opt-in (`tracker.claim_on_dispatch: true`); absent that flag, daemon behavior is identical to v1.4.9.

### What's new

- **`Tracker` interface gains optional write ops** — `claimIssue(issueId, { stateId?, assigneeId? })` and `releaseIssue(issueId, opts?)`. Observation-only adapters skip them; the orchestrator probes for presence before calling. New `TrackerError` codes: `linear_assignee_taken` (claim collided), `linear_self_user_failed` (viewer query returned no id).
- **`LinearTracker.selfUserId()`** — resolves `query { viewer { id } }` lazily on first use, caches in-memory. Used both for assigning the current user and for the `assignee=self` GraphQL filter.
- **`fetchCandidateIssues` assignee filter** — optional `{ assigneeFilter: 'any' | 'unassigned' | 'self' }`. Default `'any'` (current behavior). Linear inlines the clause as a string fragment because typed GraphQL variables can't carry "is null".
- **`WORKFLOW.md` `tracker.claim_*` block** — `claim_on_dispatch` / `assign_to_self` / `unassigned_only` / `claim_state`. Defaults off; flipping `claim_on_dispatch: true` flips `assign_to_self` + `unassigned_only` to true unless explicitly overridden. Hot-reload threads the assignee filter through `applyConfig`; toggling `claim_on_dispatch` itself still requires daemon restart (claim/release hook closures aren't hot-swappable yet). `claim_state` is parsed but not yet acted on — state-name → state-id resolver is a v1.4.10.x follow-up.
- **Orchestrator claim-before-spawn** — `dispatchInternal`'s async IIFE awaits `claimHook(issue)` BEFORE `dispatchOne`. Collisions (`{ ok:false, collided:true }`) drop local state + log `orchestrator.claim_collided` + skip-this-issue. Other claim errors log `orchestrator.claim_failed` + skip-this-tick. The retry-fire path bypasses the assignee filter so a known issue id stays re-fetchable after the assignee was set.
- **Orchestrator release-on-terminal** — `reconcileRunning` fires `releaseHook({ issueId, identifier })` as best-effort fire-and-forget when an issue moves into `terminal_states`. Failures log `orchestrator.release_failed` but never block reconciliation.

### Tests

- 320/320 daemon tests pass (+11 across `trackers/linear` / `orchestrator` / `workflow-loader`).
- macOS app unchanged; no UI work.

### v1.4.12 — Linear → Radar mirror as backlog workstreams (2026-05-09)

Option #3 of the original three-tier "Dispatch manages Linear" plan. Daemon now surfaces every Linear issue in a configured state set as a `status='backlog'` workstream the moment it appears in the tracker — no manual link required. Pairs with the existing `LinearCommentSyncer` reverse-sync that mirrors tracker-state → workstream-status transitions.

- **`daemon/src/tracker-mirror.ts`** — new `TrackerMirror` ticker. Fetches `mirror_states` issues every `intervalMs` and, for each issue NOT already linked, creates a workstream + link. Never demotes existing `active`/`paused` workstreams. Logs `mirror.workstream_created` per insertion, `mirror.fetch_failed` on tracker error (best-effort — never aborts the daemon).
- **`WorkstreamLinksStore.findByIssueId(issueId)`** — new reverse-lookup using the existing `idx_links_issue` index. O(log N) idempotency check.
- **`WORKFLOW.md` `tracker.mirror_*` knobs** — `mirror_to_radar: bool` (default off), `mirror_states: [...]` (defaults to `active_states ∪ ['Backlog', 'Triage']`), `mirror_interval_ms` (default 60_000), `mirror_max_age_days` (default null = no cutoff). All hot-reloadable; flipping `mirror_to_radar` in/out starts/stops the ticker.
- **macOS app**: zero changes needed. Mirrored issues appear as new cards in the existing Backlog Kanban column; user drags to Active to spawn (orchestrator picks them up if `claim_on_dispatch` is on).
- +6 tests: `tracker-mirror.test.ts` (creates / idempotent / no downgrade / age cutoff / fetch error) + workflow-loader (mirror knobs default off + opt-in). 351/351 daemon tests green.

### v1.4.11 — `Tracker.createIssue` + `file_ticket` MCP tool (2026-05-09)

Option #2 of the original three-tier "Dispatch manages Linear" plan: daemon now files **new** tickets, not just operates on existing ones. Same opt-in posture as v1.4.10.x — without a wired tracker, the new HTTP endpoint 404s and the MCP tool errors. Triage-agent workflow remains a v1.4.11.x follow-up; this ships the plumbing the triage agent will use.

- **`Tracker.createIssue?(input): Promise<{id, identifier, url}>`** added as optional interface method. Input: `{title, description?, labels?, priority?, teamId?}`.
- **`LinearTracker.createIssue`** runs Linear's `issueCreate` mutation. Resolves the project's primary team + label-name → id map on first call (cached); unknown label names silently dropped. Validates non-empty title before any network call.
- **`MockTracker.createIssue`** returns a synthetic `mock-N` / `MOCK-N` identifier and exposes `createdIssues()` for test inspection.
- **`POST /trackers/issues`** — body `{title, description?, labels?, priority?}`. 404 when no tracker is wired (observation-only setup); 501 when tracker doesn't implement; 400 missing title; 502 on `TrackerError`; 201 + `{id, identifier, url}` on success.
- **`dispatch__file_ticket` MCP tool** — POSTs to the daemon over the URL resolved from `DISPATCH_PORT`. On success, mirrors a `decision` event with `choice='file_ticket'` so the Radar shows the agent filed a ticket without a separate event type.
- Tracker late-bound into `buildHttpServer` via the same closure-getter pattern as orchestrator (so the http-server module stays free of construction details).
- +10 tests across `linear` (3) / `http-server` (4) / `mcp-server` (3). 345/345 daemon tests green.

### v1.4.10.5 — stale-claim TTL sweeper for multi-instance crash recovery (2026-05-09, same day)

When two daemons share a Linear API key, the v1.4.10.2 `unassigned_or_self` filter saw each other's claims as "self" and raced. v1.4.10.5 lets you opt into a periodic sweep that releases tickets owned by an apparently-dead instance.

- `Tracker.fetchStaleSelfClaimedIssues?(activeStates, ttlMs)` interface method (optional). Linear runs a GraphQL query filtering by `assignee.id = self AND state in active AND updatedAt < cutoff`. Mock returns all self-claimed active issues regardless of age (no `updatedAt` notion).
- Orchestrator gains `staleClaimTtlMs` option (default 0/disabled). Every tick, after the dispatch loop, sweeps stale-self issues that are NOT in `running` or `claimed` and fires `releaseHook` for each. Failures log `orchestrator.stale_sweep_failed` / `orchestrator.release_failed` but never abort the tick.
- `WORKFLOW.md` `tracker.stale_claim_ttl_ms` (number, default 0). Threaded through `coerceTracker` + `applyConfig`; hot-reloadable.
- +5 tests (Linear stale query shape, ttl=0 short-circuits, orchestrator releases stale not-in-running, orchestrator skips stale that ARE in running, workflow loader default + opt-in). 335/335 daemon tests green.

### v1.4.10.4 — multi-team `claim_state` resolution (2026-05-09, same day)

- `Tracker.resolveStateIdByName?(name, opts?: { teamId? })` interface extended; `ClaimOptions` gains `stateName` so callers can ask the adapter to resolve at claim time rather than committing to a pre-resolved id.
- `LinearTracker` adds `cachedStateIdByNameByTeam` (keyed by `team.id`) and a `TeamStates` GraphQL query. `ISSUE_ASSIGNEE_QUERY` peek now also fetches `team.id`, so `claimIssue` can resolve the right state for the issue's actual team in multi-team projects. Resolution miss falls back to caller-supplied `stateId` (the eager v1.4.10.1 path).
- CLI `buildClaimHook` passes both `stateName` and the eager `stateId`.
- +3 Linear tests (per-team cache, multi-team prefers stateName, stateName miss falls back to stateId). 330/330 daemon tests green.

### v1.4.10.3 — hot-swap claim/release hooks on WORKFLOW.md reload (2026-05-09, same day)

- `Orchestrator.applyConfig` extended to swap `claimHook` and `releaseHook` via an `'claimHook' in opts` presence check (passing `null` clears, omitting leaves the current value alone). `OrchestratorOptions.claimHook` / `.releaseHook` widened to `ClaimHook | null` so the same shape propagates through `Partial<>`.
- CLI workflow watcher rebuilds `claimConfig` from the reloaded WORKFLOW.md and pipes new claim/release hooks through `applyConfig`. `claim_state` only re-resolves when the name actually changed — same-name reloads keep the cached `claimStateId` to avoid a Linear round-trip on every save.
- Toggling `tracker.claim_on_dispatch` in WORKFLOW.md now takes effect without a daemon restart.
- +1 orchestrator test (hot-swap collision hook in, then clear it). 327/327 daemon tests green.

### v1.4.10.2 — stale-claim re-discovery via `unassigned_or_self` filter (2026-05-09, same day)

- New `AssigneeFilter` value `'unassigned_or_self'`. Linear inlines an `or:` clause combining `assignee.null=true` and `assignee.id=<self>`; mock matches `null` OR `== selfUserId`.
- CLI's `assigneeFilterFor` defaults to the new variant when `unassigned_only` is on. A daemon that crashed mid-claim now re-discovers its own zombie tickets on the next boot (selfUserId is stable across boots).
- Strict `'unassigned'` stays on the union for callers that explicitly want "leave already-claimed alone" semantics.
- +2 tests (Linear `or:` clause, mock cross-user filtering). 326/326 daemon tests green.

### v1.4.10.1 — claim_state resolver (2026-05-09, same day)

- `LinearTracker.resolveStateIdByName(name)` queries `issues(filter: project, first: 1) { team { states } }` once and caches the lowercased name→id map for the project's primary team.
- `MockTracker.resolveStateIdByName` returns name back as id (identity) for tests.
- CLI eager-resolves `cfg.tracker.claim_state` once at boot; populates `claimConfig.claimStateId`. Resolution miss / resolver-not-implemented / thrown error all degrade to assignee-only claim with a one-line stderr warning.
- `buildClaimHook` passes `stateId` to `tracker.claimIssue` only when `claimStateId !== null`. Single Linear `issueUpdate` mutation per claim writes assignee + state together.
- +4 Linear tests; 324/324 daemon tests green.

### Known limits (deferred to v1.4.10.x / v1.4.11)

- Multi-team project support: `resolveStateIdByName` only sees the primary team.
- Multi-instance crash recovery: if Daemon A claims and dies, Daemon B's strict `unassigned` filter never re-discovers the ticket. Need either a stale-claim TTL or an `unassigned_or_self` filter variant.
- Hot-swap of claim/release hooks on `WORKFLOW.md` reload.

---

## v1.4.9 — 2026-05-07 — feat: reactivate retired workstreams from Kanban context menu

Tag [`v1.4.9`](https://github.com/S-KSM/Manager/releases/tag/v1.4.9). DMG + zip attached.

Patch release. Retired Kanban cards already accepted drag-back-to-Active (every card is `.draggable(WorkstreamDragPayload)`, every column has `.dropDestination`, `handleDrop` PATCHes via the same path used by every other status flip), but the affordance was undiscoverable — the retired-card context menu rendered `EmptyView()` while every other status had a status-flip button. v1.4.9 replaces that with **Move to Active**, wired to the existing `.resume` lifecycle action which already maps to `status=.active` in `ContentView.applyLifecycleAction`. No daemon, schema, or wire-format change. `daemon/package.json` was drifting at 1.4.6; bumped to 1.4.9 to re-sync with `CFBundleShortVersionString`.

---

## v1.4.8 — 2026-05-07 — fix: sidebar selection unresponsive

Tag [`v1.4.8`](https://github.com/S-KSM/Manager/releases/tag/v1.4.8). DMG + zip attached.

Patch release. Sidebar rows (Home, workstreams, Team handbook, Updates) refused to register clicks or arrow-key selection — only buttons and disclosure groups inside the List worked. Cause was `List(selection: Binding<SidebarSelection?>)` paired with `.tag(Optional(SidebarSelection.x))` wrappers; SwiftUI on the current macOS SDK silently failed to match the wrapped-Optional tags against the optional binding, so selection writes never reached `@State`. Fix is to make the selection non-optional (`@State selection: SidebarSelection = .home`) and drop the `Optional(...)` wrapper on every tag — six call sites, one detail-pane switch simplified to plain enum cases. No daemon, hooks, or schema change.

---

## v1.4.7 — 2026-05-07 — ask_user MCP + Updates UX rework + CHECK-constraint migration

Tag [`v1.4.7`](https://github.com/S-KSM/Manager/releases/tag/v1.4.7). DMG + zip attached.

Two product threads bundled with one urgent migration. The product threads fix the same complaint surfaced in dogfood — the human couldn't get an agent's question without leaving the Claude Code terminal, and the Updates surface looked blank on first open so the on-demand draft flow stayed hidden. The migration unblocks any DB that survived from before v1.4.4.

### `ask_user` MCP tool (`mcp__dispatch__ask_user`)

- New `question_required` intervention kind + `answerQuestion()` queue helper + `get(id)` lookup; mirrors the v1.4.4 approval bridge.
- `POST /workstreams/:id/interventions/:intId/answer` validates the choice against the original options list and rejects freetext when `allow_freetext` was off.
- MCP tool blocks on a 1s poll loop; default 300s timeout, agent-overridable up to 1h. Emits `intervention_enqueued` + `intervention_delivered` events so the WS stream notifies the macOS QuestionStrip without a separate channel.
- macOS `QuestionStrip` renders next to `ApprovalStrip` in `AgentDetailView`. Option buttons fire instantly; optional freetext field shows when `allow_freetext: true`.

### Updates UX rework

- Empty-state CTA card replaces the silent "No drafts / No saved reports" pair on first open, with a `Generate your first update` button + auto-draft link.
- Header uses `ViewThatFits` so action buttons stack under the title at narrow widths instead of clipping. `cmd-N` shortcut on `New update`.
- `GenerateReportSheet` adds `Last 24h` / `Today` / `Yesterday` periods and switches from segmented to a wrapping chip strip so 8 options fit.
- `SchedulerSettings` translates the canonical preset crons to plain English ("Every Monday, 8:00 AM") and rewrites the intro to point at on-demand as the alternative to scheduling.

### Legacy CHECK-constraint migration

v1.4.4 dropped the `CHECK(kind IN …)` clause from the source DDL but `CREATE TABLE IF NOT EXISTS` is a no-op on existing tables — any DB that survived from before v1.4.4 still rejects `approval_required` and `question_required` rows. v1.4.7 detects the legacy constraint via `sqlite_master.sql` and rebuilds the table inside a single transaction (create new without CHECK, copy rows, drop old, rename). Caught while running the install + e2e smoke for the ask_user wire-up.

### Tests

- 306/306 daemon tests pass (+9 across `intervention-queue` / `http-server` / `mcp-server`).
- macOS Debug build clean. `xcodebuild build-for-testing` succeeds; the GUI host app still can't launch under the sandboxed XCTest runner (same limitation as v1.4.6).

### Migration

None at the wire level — `question_required` is additive. The CHECK-constraint rebuild runs automatically at daemon start when a legacy table is detected; a fresh install hits the rebuilt DDL directly and no-ops.

---

## v1.4.6 — 2026-05-07 — Diagnostics tab (kill / restart)

Tag [`v1.4.6`](https://github.com/S-KSM/Manager/releases/tag/v1.4.6). DMG + zip attached.

This binary tag bundles three milestones merged the same day: **v1.2** (Kanban board + Linear-link UI), **v1.3** (MLX OpenAI-compatible local LLM + `dispatch://` URL scheme + `/dispatcher` slash command + `MANAGER_*` env-var fallback removed), and **v1.4.6** itself. See the v1.2 + v1.3 entries below for the milestone-level changelogs.

Operational hygiene: the macOS Settings window grows a third tab — **Diagnostics** — with four buttons that let the user recover from the two failure modes that have shown up most often in v1.4.x dogfooding (a wedged local-LLM server, and a daemon that has read a stale settings.json). Wire schema additive; no migration required.

### New buttons

- **Kill Local LLM** — `POST /admin/llm/kill`. Daemon resolves the configured base URL via the existing env > settings > default chain, parses host:port out of it, runs `lsof -i tcp:<port> -sTCP:LISTEN -t` to find the listener PID, and sends SIGTERM. After a 3-second grace period it escalates to SIGKILL. Returns `{killed: pid|null, escalated: bool}`. 200 even when nothing was running.
- **Restart Local LLM** — `POST /admin/llm/restart`. Same kill flow, then runs the user's configured `localLLMStartCommand` via `bash -lc <cmd>` detached + `unref()`. 400 with `code: 'no_start_command'` when the command is empty so the macOS UI can disable the button.
- **Restart Daemon — Soft** — `POST /admin/restart`. Cancels + re-instantiates Headliner / SubgoalSynthesizer / LinearCommentSyncer in place so a Settings change takes effect without a process exit. Returns the list of restarted ticker names. The daemon process keeps its PID.
- **Restart Daemon — Hard** — macOS-side only. `LaunchctlController.kickstart()` shells out to `launchctl kickstart -k gui/<uid>/com.dispatch.daemon`. Not a daemon endpoint because the daemon would die mid-response — instead the existing `DaemonResolver` `/health` poll catches the new daemon when launchd brings it back.

### Wire schema additions (additive, backwards compatible)

- `GET/PATCH /settings` gains `localLLMStartCommand: string`. Cleartext on the wire — it's a user-facing command, not a credential. Empty string when unset; PATCH accepts the value verbatim (no redaction). Older daemons predating v1.4.6 are forward-compatible: the macOS Codable mirror defaults the field to `""`.
- `POST /admin/llm/kill` → `{killed, escalated, error?}`.
- `POST /admin/llm/restart` → `{killed_pid, started, error?}` on 200; 400 + `code: 'no_start_command'` when missing.
- `POST /admin/restart` → `{restarted: string[]}`.

### Providers tab

The Providers tab grows a fifth field, "Local LLM start command", under the URL field. Cleartext (no SecureField) since it's not a credential. Configure once → Restart-Model button lights up.

### Tests

- 305/305 daemon tests pass (19 new `admin.test.ts` cases — `parseHostPort` / `findPidOnPort` / `killWithEscalation` / `spawnDetached`; 11 new `http-server.test.ts` cases for the three admin endpoints + the `localLLMStartCommand` round-trip).
- 7 new `MockDaemonClientTests` cases (kill/restart call counts + arg shape, error propagation, `localLLMStartCommand` patch round-trip, LaunchctlController exit-code → error mapping). Tests build clean. The XCTest runner in this build environment couldn't launch the GUI host app (same sandbox limitation as v1.2 / v1.3); `xcodebuild build-for-testing` succeeds.

### Migration

None. New field `localLLMStartCommand` defaults to empty in both the daemon's `settings.json` and the macOS Codable mirror. Existing settings files keep working unchanged.

---

## v1.3 — 2026-05-07 — MLX local LLM + /dispatcher URL scheme + MANAGER_* removal

Three deliverables. Wire schema additive; the env-var removal is a hard break for anyone still relying on `MANAGER_*` (`bin/install.sh` has been emitting a deprecation breadcrumb since v1.2).

### MLX-backed local LLM (generic OpenAI-compatible)

The local-LLM provider transport switched from Ollama's native `/api/chat` to OpenAI-compatible `/v1/chat/completions`, so the daemon can talk to Apple's `mlx_lm.server` (the recommended default on M-series silicon) as readily as to Ollama, llama.cpp, or any other server speaking the chat-completions API. The provider name stays `ollama` as the family name for "any OpenAI-compatible local server". New env var `DISPATCH_LLM_BASE_URL` overrides the default `http://localhost:8080/v1`; the legacy `OLLAMA_URL` is honored as a fallback. Bare `http://localhost:11434` and any URL whose path doesn't include `/v1` get auto-normalized so existing v1.2 Ollama setups upgrade transparently. The macOS Settings → Providers tab relabels the field to "Local LLM URL"; the reachability probe swaps `/api/tags` for `GET /models` with a TCP-ish fallback for non-API endpoints. See `docs/LOCAL_MODELS.md` for the rewritten setup guide.

### `/dispatcher` slash command + `dispatch://` URL scheme

`commands/dispatcher.md` ships a Claude Code slash command that derives a workstream slug from the current git root (or `$PWD`) using the same rules as `hooks/_common.sh:dispatch__slugify`, then runs `open dispatch://workstream/<slug>`. The macOS app registers `dispatch://` in `CFBundleURLTypes` and routes the URL through a new `URLRouter` ObservableObject into `ContentView`'s selection state. Strict parser on both sides (`daemon/src/url-scheme.ts` + `client-macos/Dispatch/Daemon/DispatchURLParser.swift`) — `[a-z0-9-]` only, path traversal rejected. ContentView surfaces a one-line banner if the URL targets a workstream id the daemon hasn't seen yet ("open `claude` here to register"). `bin/install.sh` copies the slash-command file into `~/.claude/commands/` and runs `lsregister -f` after the `.app` lands so the URL scheme is live immediately, no logout required.

### `MANAGER_*` env-var fallback removed

The deprecation breadcrumb fired for one release. `readEnvWithLegacy` helper deleted; six daemon read sites (`config.ts`, `headliner.ts`, `subgoal-synthesizer.ts`, `settings-store.ts`, `http-server.ts`, `mcp-server.ts`) inlined to direct `process.env['DISPATCH_*']`. POSIX-shell `dispatch__legacy_env` helper deleted; `hooks/_common.sh` and the two scripts that called it now read `${DISPATCH_*:-}` directly. `bin/install.sh` PORT line drops the legacy fallback. macOS `DaemonResolver` no longer honors `MANAGER_DAEMON`; the env-mode pickup was extracted into a `nonisolated static pickModeFromEnv(_ env:)` helper that's covered by the new `DaemonResolverTests`. Filesystem state migration `~/.claude/manager → ~/.claude/dispatch` in `bin/install.sh` is preserved (file path, not env var).

### Tests

- 240/240 daemon tests pass (236 + 4 new `config.test.ts` cases; `url-scheme.test.ts` adds 8; `openai-compat.test.ts` adds 6; `ollama.test.ts` revised in place).
- macOS `DispatchURLParserTests` (8) + `DaemonResolverTests` (5) added; tests build clean. The XCTest runner in this build environment couldn't launch the GUI host app, but `xcodebuild build-for-testing` succeeds.

### Migration

- If you were still relying on `MANAGER_*` env vars, set `DISPATCH_*` instead. (`bin/install.sh` has emitted a deprecation breadcrumb since v1.2.)
- If your `OLLAMA_URL` pointed at a bare `http://localhost:11434`, no action — auto-promoted to `/v1`. Otherwise, point `DISPATCH_LLM_BASE_URL` at the right OpenAI-compat URL.

---

## v1.2 — 2026-05-07 — Kanban board + Linear-link UI

(Note: v1.2 ships *after* v1.4.5 calendar-wise — the v1.2 milestone is the Kanban + Linear-link UI roadmap entry from `TODO.md`, originally deferred while v1.4 autonomous-mode work landed first. Daemon and macOS app stay on `MARKETING_VERSION = 1.4.5`; v1.2 here refers to the milestone, not the binary version.)

### New features

- **4-column Kanban board** — `HomeView` swaps the v1.1 `LazyVGrid` team-floor for a `KanbanBoardView` with Backlog / Active / Paused / Retired columns. Cards are `.draggable(WorkstreamDragPayload)`; columns `.dropDestination` call `PATCH /workstreams/:id` with the new status. Active column auto-folds into a "Pod-grouped" disclosure when it holds more than 12 cards (`shouldGroupPod` boundary). Digest filter dims non-matching cards in place rather than reflowing columns.
- **Linear-link UI** — every workstream can now be linked to a Linear issue from the agent-detail header. New SQLite table `workstream_links` (FK to `workstreams(id)`) + 4 endpoints: `GET/PUT/DELETE /workstreams/:id/link` and `GET /links`. Linking resolves the identifier via `LinearTracker.fetchIssueByIdentifier`. `LinearChip` renders linked (link icon + identifier + Open-in-Linear / Unlink menu) vs unlinked (a "Link…" button opening `LinkLinearSheet`). Settings → Providers gains a `linearApiKey` SecureField with the same redaction as the Anthropic key.
- **Bidirectional Linear sync ticker** — `LinearCommentSyncer` runs every 60s while a Linear key is configured. Forward: `decision` events with `payload.confidence ≥ DISPATCH_LINEAR_COMMENT_MIN_CONFIDENCE` (default 0.8) post a deterministic Markdown comment via `addIssueComment`, deduped via `linear_comments_posted`. Reverse: `fetchIssueStatesByIds` flips the workstream's status when Linear's state changes, *only* if the user hasn't manually overridden it (state map: `Done|Closed|Cancelled→retired`, `In Progress→active`, `Backlog|Todo→backlog`, `On Hold|Paused→paused`, anything else → silent skip + log once). Disable via `DISPATCH_LINEAR_SYNC_ENABLED=0`.

### Wire schema additions (additive, backwards compatible)

- `Workstream.status` enum gains `'backlog'`. macOS Codable falls back to `.active` for unknown future values.
- `GET /settings` returns `linearApiKeyConfigured: boolean`. `PATCH /settings` accepts `linearApiKey: string` (empty string clears, omit to leave untouched).
- `GET /workstreams/:id/link` → `WorkstreamLink | null`. `PUT /workstreams/:id/link` body `{tracker_kind: 'linear', issue_identifier: string}`. `DELETE /workstreams/:id/link` is idempotent. `GET /links` lists every persisted link.
- New `TrackerErrorCode` values: `linear_unknown_identifier`, `linear_state_not_found`, `linear_comment_failed`.

### Tests

- 247/247 daemon tests pass (29 new — workstream-links-store + LinearCommentSyncer + extended LinearTracker mutations + link HTTP endpoints + backlog status digest assertion).
- 66/66 macOS tests pass (KanbanLogicTests + WorkstreamCodableTests + WorkstreamLinkCodableTests + 4 link-flow MockDaemonClient tests + the existing 48 pre-v1.2 cases).

### Migration

None. New `workstream_links` + `linear_comments_posted` tables are created on first boot; existing daemons keep working with no link rows. Per-workstream status is unchanged for everything that isn't currently `'backlog'`.

---

## v1.4.5 — 2026-05-06 — UX feedback wave + Provider settings + Sleeping Robot

First release driven entirely by user feedback on the v1.4 build (`Feedback.md`). No architectural changes; v1.5 (auth for remote/mobile) is still next on the roadmap.

### New features

- **Settings → Providers tab** (`PreferencesView.swift`). Choose `claude` vs `ollama`, set the model name, point Ollama at any URL, paste/clear an Anthropic API key. "Test now" probes daemon health and the selected provider. Backed by a new `GET /settings` + `PATCH /settings` endpoint that persists to `~/.claude/dispatch/settings.json` and redacts the API key on the wire (only `anthropicApiKeyConfigured: bool` is returned). Existing `DISPATCH_HEADLINE_*` / `OLLAMA_URL` / `ANTHROPIC_API_KEY` env vars still work as a fallback.
- **Sleeping Robot mascot.** Daemon emits a new per-workstream `live_session` boolean (true while the latest `session_start` is newer than the latest `session_end`). When the underlying `claude` session exits, the workstream's `RobotMascot` dims, desaturates, closes its eyes, and gets a small floating `Zzz` overlay. Lifecycle state ("Active" / paused / retired) is unchanged — awake/asleep is a separate presentational dimension.

### Fixes

- **First-launch demo data race.** `DaemonResolver` was seeded with the fixture `MockDaemonClient()` so the Radar painted demo workstreams during the ~3s window before `/health` resolved. Now seeds `MockDaemonClient.empty()`; demo fixtures stay reachable via Cmd-Shift-M and SwiftUI previews.
- **`AgentDetailView` reflow below 820px.** HSplitView pane mins (`360 + 280 = 640`) exceeded the available width on narrow windows so the panes refused to shrink. Lowered to `280 + 220`. Header title/subtitle truncate; status pill no longer collides with the Intervene button.
- **`DigestRailView` chip overflow.** Four stat chips clipped at narrow detail widths. Wrapped in a horizontal `ScrollView`; headline gains `layoutPriority(1)` + 2-line cap.

### UX polish

- **`WelcomeView` rewrite.** Lead sentence with the "open a terminal, run `claude`" instruction → 3 numbered steps → copy-able snippet → links to Tutorial / Settings → Providers / Architecture. Daemon-down recovery copy tightened, button relabeled "Start daemon".
- **Tooltips.** Added `.help(...)` on every previously-tooltip-less Button across `HomeView`, `WelcomeView`, `PreferencesView`. Other views (`GenerateReportSheet`, `InterventionPanel`, `UpdatesView`, `AgentDetailView`) already had complete coverage.
- **Tutorial + Help docs.** `docs/TUTORIAL.md` refreshed for v1.4 (autonomous mode section, Settings → Providers reference, version refresh). `docs/LOCAL_MODELS.md` mentions Settings → Providers and confirms `claude` + `ollama` providers (MLX still v1.3-deferred). README has a one-line pointer to the in-app Help menu and to `docs/TUTORIAL.md`. The Help menu's bundled-doc links were verified — they already worked; they just weren't discoverable.

### Wire schema additions (additive, backwards compatible)

- `GET /workstreams` + `GET /workstreams/:id` now include `live_session: boolean`.
- `GET /digest` now includes `live_sessions: string[]` (workstream ids with a live `claude` session).
- `GET /settings` returns `{ headlineProvider, headlineModel, ollamaUrl, anthropicApiKeyConfigured }` (404 if no settings store is configured). `PATCH /settings` accepts the same shape (sans the configured-bool) plus `anthropicApiKey: string | null` to set/clear the key.

### Tests

- 218/218 daemon tests pass (4 new for `/settings`, plus `live_session` coverage in `projections.test.ts` and `digest.test.ts`).
- 48/48 macOS tests pass.
- `bin/package.sh` produces a working ad-hoc-signed DMG.

### Migration

None. All env-var-based config keeps working unchanged. Settings → Providers takes precedence over env vars when set.

---

## v1.4 — 2026-05-03 — Symphony orchestration

(Historical — see commit `b3aae28` and `docs/ROADMAP.md` for the orchestrator state machine, workspace manager + hooks, Claude Code agent runner, `WORKFLOW.md` loader, Linear adapter, and approval-required intervention kind.)

# Release Notes

Versions are anchored on the macOS app's `CFBundleShortVersionString` (the Info.plist value before `bin/stamp-app-version.sh` appends `+<sha>`). The daemon's `package.json` version tracks the same string.

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

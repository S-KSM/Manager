# Release Notes

Versions are anchored on the macOS app's `CFBundleShortVersionString` (the Info.plist value before `bin/stamp-app-version.sh` appends `+<sha>`). The daemon's `package.json` version tracks the same string.

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

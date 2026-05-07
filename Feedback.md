# Feedback

## Round 1 — shipped in v1.4.5 (2026-05-06)

See [`RELEASE_NOTES.md`](RELEASE_NOTES.md) and the [`v1.4.5 GitHub release`](https://github.com/S-KSM/Manager/releases/tag/v1.4.5).

- [x] I can't seem to know how I can add a local model for the summary section. → Settings → Providers tab.
- [x] Write a step by step tutorial on how to use this app. → `docs/TUTORIAL.md` (also in-app via Help → Tutorial).
- [x] When loaded for the first time it still shows the demo projects. → `DaemonResolver` race fix.
- [x] When loaded for the first time it is not clear how I should use this app. → `WelcomeView` rewrite.
- [x] Add tooltip to buttons so that we know what they are for. → `.help()` added across HomeView / WelcomeView / PreferencesView.
- [x] Make the panels to be reactive to the size of the window pane and autoscale them. → `AgentDetailView` HSplitView reflow + `DigestRailView` chip horizontal-scroll.
- [x] Also there is no help available currently. → Help menu links verified + `WelcomeView` surfaces them on first launch.
- [x] When we kill the claude sessions the robots should become inactive with a zzzz sign. → Sleeping Robot mascot + daemon `live_session` projection.

## Backlog — long-term

- [ ] **Mouse-pointer context Q&A** — the cursor's hover target becomes context; the user can ask questions about whatever the pointer is on. (Tracked in TODO.md under v2+.)

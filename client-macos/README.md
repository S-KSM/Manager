# Dispatch — macOS client

SwiftUI front-end for the Dispatch daemon. Renders **The Radar** — the three-zone home view (digest rail, team floor, live ticker) — and an **agent detail view** with **The Trace** (methodology timeline) + **Dossier** pane (workstream memory). Intercept controls (nudge / redirect / rollback) live on the agent-detail toolbar; Protocol promotion happens from the decision rows in the Trace.

> Codenamed **Manager** through v1.1.x. As of v1.2 the Xcode project, Swift module, bundle identifier (`com.dispatch.app`), `CFBundleDisplayName`, and the env-var override (`DISPATCH_DAEMON`) all carry the new name. The legacy `MANAGER_DAEMON` env var is still honored for one release with a deprecation log line — set `DISPATCH_DAEMON` instead.
>
> The contract this client speaks to is documented in [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) at the repo root; treat that as the source of truth.

## Stack

- Swift 5, SwiftUI, macOS 14+ deployment target
- Apple-only dependencies — `URLSession` for HTTP and the WebSocket client
- App-style Xcode project (produces a real `.app`, not a Swift Package)

No third-party dependencies. Everything the client needs ships in the OS.

## Open / build / run

```sh
open client-macos/Dispatch.xcodeproj
```

…then **Run** (Cmd-R). The app opens with mock data populated; you should see
the digest rail, five workstream cards, and the live ticker.

Build from the command line:

```sh
cd client-macos
xcodebuild -project Dispatch.xcodeproj \
           -scheme Dispatch \
           -destination 'platform=macOS' \
           -configuration Debug build
```

Run the unit tests:

```sh
cd client-macos
xcodebuild -project Dispatch.xcodeproj \
           -scheme Dispatch \
           -destination 'platform=macOS' \
           test
```

## Live updates

As of v0.5.1, both the home-view ticker and the agent-detail timeline
subscribe to the daemon's WebSocket event stream
(`WS /workstreams/{id}/events/stream`) in addition to their initial
historical fetch:

- `LiveTickerView` — seeds from `GET /workstreams/{id}/events` once per
  workstream, then opens one WS subscription per workstream and merges new
  events into a 50-entry ring buffer (newest first).
- `AgentDetailView` — `reload()` does the historical events + memory fetch,
  then a single WS subscription appends new events into the timeline as the
  agent emits them. `.task(id: workstream.id)` cancels the prior stream
  cleanly when the user navigates between workstreams.

**Reconnect on transport failure is intentionally a v1 deliverable.** If
the WS stream finishes (daemon restart, network hiccup, etc.) the
corresponding feeder task ends and that surface stops receiving new events
until the view is re-mounted. For v0.5.1 a Cmd-R back to Home and re-open
of the agent is the workaround.

`MockDaemonClient.streamEvents` returns a short, finite stream (~8 entries,
400 ms apart) so previews and offline launches exercise the merge code
without hanging.

### Intervention toast (v0.5.1)

`InterventionPanel`'s nudge / redirect / rollback sheets now show a small
inline confirmation (`Nudge queued` / `Redirect queued` /
`Rollback to <decision-id> queued`) for ~1.2 s after a successful POST
before auto-dismissing. The Send button is disabled while the toast is
visible to prevent double-sends. Inline error labels still appear on
failure exactly as before.

## Mock vs. live daemon

The app picks at startup:

1. If the daemon at `http://localhost:9876/health` answers with 2xx → use the
   live `LiveDaemonClient`.
2. Otherwise → fall back to `MockDaemonClient` so the UI is always populated.

The chosen mode is shown in the toolbar (green dot = live, yellow dot = mock)
and logged on launch via `os_log` (subsystem `com.dispatch.app`, category
`DaemonResolver`).

Two ways to override:

- **Env var** — set `DISPATCH_DAEMON=mock` in the Xcode scheme (Edit Scheme →
  Run → Arguments → Environment Variables) to force mock mode even when a
  daemon is running. The legacy `MANAGER_DAEMON` env var is still read as a
  fallback for one release; switching produces an `os_log` deprecation
  notice but otherwise keeps working.
- **Menu** — `Dispatch → Toggle Mock / Live Daemon` (`⌘⇧M`) flips at runtime.

The base URL `http://localhost:9876` is the default; change it in
`LiveDaemonClient.defaultBaseURL` if the daemon binds elsewhere.

## What's where

```
Dispatch/
  DispatchApp.swift           @main app, env-injects DaemonResolver.
  ContentView.swift           NavigationSplitView; sidebar + detail.
  Models/
    Workstream.swift          Mirrors the daemon Workstream record.
    Event.swift               Codable Event with a typed payload enum
                              (decision, subgoal_push/pop, confidence,
                              tool_use, blocked, memory_update,
                              session_start/end, intervention_delivered).
    Memory.swift               Parses the workstream Markdown memory.
  Daemon/
    DaemonClient.swift         DaemonClientProtocol + LiveDaemonClient
                               (HTTP + URLSessionWebSocketTask).
    MockDaemonClient.swift     In-process fixture-backed implementation.
    DaemonResolver.swift       Health-probe → live or mock at launch.
  Views/
    HomeView.swift             DigestRailView, TeamFloorView (cards),
                               LiveTickerView.
    AgentDetailView.swift      MethodologyTimelineView, MemoryPaneView.
  Mock/
    MockData.swift             5 mock workstreams, ~30 events,
                               5 mock memory blobs.
  Resources/
    Info.plist
    Dispatch.entitlements     App sandbox + outgoing network.
    Assets.xcassets

DispatchTests/
  EventCodableTests.swift     ARCHITECTURE.md JSON round-trip,
                              all-variant payload coverage.
  MockDaemonClientTests.swift Fixtures, decision-tree consistency,
                              streamEvents termination, memory parse.
```

## Daemon API the client expects

These are the routes `LiveDaemonClient` calls. The daemon agent (working in
`daemon/`) is the owner of this contract; this client only consumes it.

| Method | Path | Returns |
|---|---|---|
| `GET` | `/health` | 2xx if reachable |
| `GET` | `/workstreams` | `[Workstream]` JSON |
| `GET` | `/workstreams/{id}` | `Workstream` JSON |
| `GET` | `/workstreams/{id}/memory` | raw Markdown body |
| `GET` | `/workstreams/{id}/events` | `[Event]` JSON |
| `WS`  | `/workstreams/{id}/events/stream` | one `Event` JSON per message |

Field names follow the snake_case shape from `docs/ARCHITECTURE.md`
(`workstream_id`, `parent_id`, etc.). Timestamps are ISO-8601, fractional
seconds optional.

The `Workstream` shape ships a few projection fields the daemon will need to
synthesize for the home view (`current_subgoal`, `latest_confidence`,
`needs_attention`, `last_event_at`). They're optional — the client
gracefully degrades to a leaner card if they're absent.

## SwiftUI previews

Both major surfaces have previews backed by `MockData`:

- `HomeView` — preview "HomeView (mock)", `width: 1200, height: 760`.
- `AgentDetailView` — preview "AgentDetailView (decision tree)" using the
  `frontend-refactor` workstream which has a `dec_07 → dec_09 → dec_12`
  parent_id chain so the indent rendering exercises something non-trivial.
- `ContentView` — preview "ContentView (mock)" with a `forcedMode: .mock`
  resolver.

## Known limitations / TODO

- **Markdown rendering** is intentionally minimal — the memory pane uses
  `AttributedString(markdown:)` per line, which preserves inline emphasis
  and links but not block lists or code blocks. The spec excludes a heavy
  Markdown package for v0; revisit in v0.5 if memory becomes hard to read.
- **WebSocket reconnect** is not yet wired in — `LiveDaemonClient.streamEvents`
  finishes its `AsyncStream` on transport failure rather than retrying.
  Acceptable for v0 (one workstream, mostly observation), but TODO for v1.
- **Intervention controls** are explicitly out of scope per `docs/ROADMAP.md`
  — the agent detail view is read-only in v0.
- **App sandbox icon** — `AppIcon.appiconset` ships only a `Contents.json`
  manifest, no actual PNGs. Xcode will warn but builds succeed.

## Contract drift from `docs/ARCHITECTURE.md`

None substantive. Two minor judgment calls:

1. The `Workstream` model adds optional projection fields
   (`current_subgoal`, `latest_confidence`, `needs_attention`, `last_event_at`)
   that ARCHITECTURE.md does not enumerate explicitly. They are needed for
   the team-floor cards. Treat them as a request to the daemon — if the daemon
   chooses different names, update `Workstream.CodingKeys` and the
   client adjusts.
2. The HTTP route names (`/workstreams`, `/workstreams/{id}/memory`, etc.)
   are an inference from the architecture document's API description; the
   exact paths are not pinned there. If the daemon settles on different
   paths, change `LiveDaemonClient.getJSON(path:)` call sites.

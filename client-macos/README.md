# Manager — macOS client (v0)

SwiftUI front-end for the Manager daemon. Renders the **three-zone home view**
(digest rail, team floor, live ticker) and an **agent detail view** with a
**methodology timeline** and **memory pane**.

> Scope is observation only — no intervention controls in v0. Those land in v0.5.
> The contract this client speaks to is documented in `docs/ARCHITECTURE.md` at
> the repo root; treat that as the source of truth.

## Stack

- Swift 5, SwiftUI, macOS 14+ deployment target
- Apple-only dependencies — `URLSession` for HTTP and the WebSocket client
- App-style Xcode project (produces a real `.app`, not a Swift Package)

No third-party dependencies. Everything the client needs ships in the OS.

## Open / build / run

```sh
open client-macos/Manager.xcodeproj
```

…then **Run** (Cmd-R). The app opens with mock data populated; you should see
the digest rail, five workstream cards, and the live ticker.

Build from the command line:

```sh
cd client-macos
xcodebuild -project Manager.xcodeproj \
           -scheme Manager \
           -destination 'platform=macOS' \
           -configuration Debug build
```

Run the unit tests:

```sh
cd client-macos
xcodebuild -project Manager.xcodeproj \
           -scheme Manager \
           -destination 'platform=macOS' \
           test
```

## Mock vs. live daemon

The app picks at startup:

1. If the daemon at `http://localhost:9876/health` answers with 2xx → use the
   live `LiveDaemonClient`.
2. Otherwise → fall back to `MockDaemonClient` so the UI is always populated.

The chosen mode is shown in the toolbar (green dot = live, yellow dot = mock)
and logged on launch via `os_log` (subsystem `com.manager.app`, category
`DaemonResolver`).

Two ways to override:

- **Env var** — set `MANAGER_DAEMON=mock` in the Xcode scheme (Edit Scheme →
  Run → Arguments → Environment Variables) to force mock mode even when a
  daemon is running.
- **Menu** — `Manager → Toggle Mock / Live Daemon` (`⌘⇧M`) flips at runtime.

The base URL `http://localhost:9876` is the default; change it in
`LiveDaemonClient.defaultBaseURL` if the daemon binds elsewhere.

## What's where

```
Manager/
  ManagerApp.swift            @main app, env-injects DaemonResolver.
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
    Manager.entitlements      App sandbox + outgoing network.
    Assets.xcassets

ManagerTests/
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

import SwiftUI

/// Three-zone home view (see docs/ARCHITECTURE.md > "Three-zone home view"):
///
///   ┌──────────────────────────────────────────────────────────────┐
///   │ MockModeBanner  — only when running on mock data             │
///   ├──────────────────────────────────────────────────────────────┤
///   │ DigestRailView  — aggregate summary across the team          │
///   ├────────────────────────────────────────────┬─────────────────┤
///   │                                            │                 │
///   │ TeamFloorView — grid of WorkstreamCard     │ LiveTickerView  │
///   │ or RadarEmptyStateView when no workstreams │ (right rail)    │
///   │                                            │                 │
///   └────────────────────────────────────────────┴─────────────────┘
///
/// First-launch behaviour:
/// - Live daemon up + has workstreams → standard grid.
/// - Live daemon up + zero workstreams → `RadarEmptyStateView` ("Radar is
///   clear" onboarding card with the `claude` instructions).
/// - Live daemon unreachable → mock client serves demo data, but a
///   `MockModeBanner` strip across the top makes it obvious we're not
///   showing the user's real workstreams.
struct HomeView: View {
    let workstreams: [Workstream]
    let client: DaemonClientProtocol
    /// Tap handler for both the team-floor cards and the digest highlight rows.
    let onSelect: (Workstream) -> Void
    /// Lifecycle action callback used by the card context menus
    /// (Pause / Resume / Retire / Edit title…). Wired by `ContentView`.
    let onLifecycleAction: (Workstream, LifecycleAction) -> Void

    /// Resolver is read from the environment (injected by `DispatchApp`) so
    /// HomeView can render the mock-mode banner and the live-empty onboarding
    /// state without ContentView having to thread mode info through. When the
    /// view is hosted somewhere without an environment object (older
    /// previews) the banner just stays hidden — the empty state still works.
    @EnvironmentObject private var resolver: DaemonResolver

    enum LifecycleAction: Hashable {
        case pause
        case resume
        case retire
        case editTitle
    }

    /// Radar filter driven by the digest strip. Tapping a stat sets the
    /// filter; tapping it again clears back to `.all`. The team floor
    /// applies the predicate to its visible workstreams.
    enum RadarFilter: Hashable {
        case all
        case shipped
        case blocked
        case needsYou
        case active
    }

    @State private var filter: RadarFilter = .all
    @State private var lastBuckets: DigestBuckets = DigestBuckets()

    /// v1.4.20 — autonomous-mode snapshot. `nil` = observation-only daemon
    /// (404) → the fleet strip stays hidden and cards show no run info.
    @State private var orchestrator: OrchestratorState?
    /// v1.4.20 — tracker links keyed by workstream id, fetched once per poll
    /// (`GET /links`) so every card can render its tracker chip.
    @State private var links: [String: WorkstreamLink] = [:]

    private func refreshFleetState() async {
        orchestrator = (try? await client.getOrchestratorState()) ?? nil
        if let fetched = try? await client.listLinks() {
            links = Dictionary(fetched.map { ($0.workstreamID, $0) }, uniquingKeysWith: { _, b in b })
        }
    }

    /// What occupies the team-floor area. Three exclusive states:
    /// - `.cards`: render the workstream grid.
    /// - `.welcome`: live daemon up, zero workstreams — onboarding card.
    /// - `.daemonDown`: probe failed — recovery card with Retry button.
    private enum FloorState {
        case cards
        case welcome
        case daemonDown
    }

    private var floorState: FloorState {
        let hasReal = workstreams.contains(where: { $0.status != .retired })
        switch resolver.modeReason {
        case .liveHealthy:
            return hasReal ? .cards : .welcome
        case .liveUnreachable:
            return .daemonDown
        case .envOverride, .userToggled, .forced:
            return hasReal ? .cards : .welcome
        case .unknown:
            // Pre-resolve, render whatever cards exist (none on first call).
            return hasReal ? .cards : .welcome
        }
    }

    /// MockModeBanner is now reserved for the "you explicitly asked for mock"
    /// cases — env override, manual toggle, preview override. The
    /// liveUnreachable case is owned by the WelcomeView.daemonDown card and
    /// doesn't need a redundant banner on top.
    private var showMockBanner: Bool {
        switch resolver.modeReason {
        case .envOverride, .userToggled, .forced: return true
        case .liveHealthy, .liveUnreachable, .unknown: return false
        }
    }

    /// Set of workstream ids that match the current digest filter. Empty
    /// when `.all` is active. Passed to the kanban so cards outside the set
    /// dim in place rather than reflowing the columns.
    private var filteredIDs: Set<String> {
        switch filter {
        case .all:
            return []
        case .blocked:
            return !lastBuckets.blocked.isEmpty
                ? Set(lastBuckets.blocked)
                : Set(workstreams.filter { $0.needsAttention }.map(\.id))
        case .needsYou:
            return !lastBuckets.needsAttention.isEmpty
                ? Set(lastBuckets.needsAttention)
                : Set(workstreams.filter { $0.needsAttention }.map(\.id))
        case .active:
            return !lastBuckets.active.isEmpty
                ? Set(lastBuckets.active)
                : Set(workstreams.filter { $0.status == .active }.map(\.id))
        case .shipped:
            return Set(lastBuckets.shipped)
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            if showMockBanner {
                MockModeBanner(reason: resolver.modeReason) {
                    Task { await resolver.retryConnection() }
                }
            }

            DigestRailView(
                client: client,
                workstreams: workstreams,
                onHighlightSelect: onSelect,
                filter: $filter,
                onBucketsUpdate: { lastBuckets = $0 }
            )
            .padding(.horizontal, 20)
            .padding(.vertical, 14)
            .background(Resona.Palette.parchment.opacity(0.85))

            Divider()
                .overlay(Resona.Palette.stone)

            // v1.4.20 — autonomous-mode strip. Only when the daemon runs a
            // WORKFLOW.md loop; observation-only daemons never see it.
            if let orchestrator, floorState == .cards {
                FleetStripView(state: orchestrator) { wsID in
                    if let ws = workstreams.first(where: { $0.id == wsID }) { onSelect(ws) }
                }
                Divider()
                    .overlay(Resona.Palette.stone)
            }

            HStack(alignment: .top, spacing: 0) {
                Group {
                    switch floorState {
                    case .welcome:
                        WelcomeView(mode: .welcome)
                    case .daemonDown:
                        WelcomeView(mode: .daemonDown(retry: {
                            Task { await resolver.retryConnection() }
                        }))
                    case .cards:
                        // v1.2: 4-column kanban replaces the old LazyVGrid.
                        // Cards are draggable between columns; drop fires
                        // PATCH /workstreams/:id with the new status. Filter
                        // dimming is applied in-place rather than hiding
                        // cards so columns don't reflow on every tap.
                        KanbanBoardView(
                            workstreams: workstreams,
                            client: client,
                            onCardTap: onSelect,
                            onLifecycleAction: onLifecycleAction,
                            activeFilter: filter,
                            filteredIDs: filteredIDs,
                            links: links,
                            orchestrator: orchestrator
                        )
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                if floorState == .cards {
                    Divider()
                        .overlay(Resona.Palette.stone)
                    LiveTickerView(client: client, workstreams: workstreams)
                        .frame(minWidth: 240, idealWidth: 320, maxWidth: 380)
                }
            }
        }
        .navigationTitle("Dispatch")
        // v1.4.20 — poll the orchestrator snapshot + links alongside the
        // existing workstream refresh cadence. Cheap (two small GETs), and
        // it's what turns "Autonomous" badges on/off as runs start and end.
        .task(id: workstreams.map(\.id)) {
            await refreshFleetState()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                if Task.isCancelled { break }
                await refreshFleetState()
            }
        }
    }
}

// MARK: - Mock-mode banner

/// Thin strip across the top of HomeView when the app is running on the
/// mock client. Reason-aware copy + a Retry button (when it makes sense)
/// so first-launch users immediately understand "what they see is fake"
/// and have a one-click path back to live data once the daemon is up.
private struct MockModeBanner: View {
    let reason: DaemonResolver.ModeReason
    let onRetry: () -> Void

    @State private var retrying: Bool = false

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: iconName)
                .foregroundStyle(Resona.Palette.butter)
            VStack(alignment: .leading, spacing: 1) {
                Text(headline)
                    .font(.callout.weight(.semibold))
                Text(subhead)
                    .font(Resona.Typography.caption)
                    .foregroundStyle(Resona.Palette.inkSoft)
            }
            Spacer(minLength: 12)
            if showsRetry {
                Button {
                    retrying = true
                    Task {
                        onRetry()
                        // The retry call is async-fire-and-forget from the
                        // view's perspective; we just want to debounce the
                        // button briefly so it can't be hammered.
                        try? await Task.sleep(for: .milliseconds(800))
                        retrying = false
                    }
                } label: {
                    if retrying {
                        ProgressView().controlSize(.small)
                    } else {
                        Label(retryButtonLabel, systemImage: "play.circle.fill")
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(retrying)
                .help("Try to reach the live daemon and switch off mock data")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Resona.Palette.butter.opacity(0.18))
        .overlay(
            Rectangle()
                .frame(height: 1)
                .foregroundStyle(Resona.Palette.butter.opacity(0.45)),
            alignment: .bottom
        )
    }

    private var iconName: String {
        switch reason {
        case .liveUnreachable: return "antenna.radiowaves.left.and.right.slash"
        case .envOverride:     return "wrench.and.screwdriver.fill"
        case .userToggled:     return "hand.tap.fill"
        case .forced:          return "eyeglasses"
        case .liveHealthy, .unknown:
            // Shouldn't render in these states (banner is mock-only) but
            // we still need a fallback glyph for the type checker.
            return "exclamationmark.bubble.fill"
        }
    }

    private var headline: String {
        switch reason {
        case .liveUnreachable: return "Showing demo data — daemon is offline."
        case .envOverride:     return "Mock mode forced via DISPATCH_DAEMON env var."
        case .userToggled:     return "Mock mode — toggled manually."
        case .forced, .liveHealthy, .unknown:
            return "Showing demo data."
        }
    }

    private var subhead: String {
        switch reason {
        case .liveUnreachable:
            return "These workstreams aren't real. Click Start daemon to bring it back up."
        case .envOverride:
            return "Unset DISPATCH_DAEMON in your scheme to use the live daemon."
        case .userToggled:
            return "Press ⌘⇧M or click Retry to switch back to the live daemon."
        case .forced, .liveHealthy, .unknown:
            return "These workstreams aren't real."
        }
    }

    private var retryButtonLabel: String {
        switch reason {
        case .liveUnreachable: return "Start daemon"
        case .userToggled:     return "Switch to live"
        default:               return "Retry connection"
        }
    }

    /// Only show Retry when flipping back to live mode is sensible — i.e.
    /// not when the env var or constructor explicitly locked us into mock.
    private var showsRetry: Bool {
        switch reason {
        case .liveUnreachable, .userToggled: return true
        case .envOverride, .forced, .liveHealthy, .unknown: return false
        }
    }
}

// MARK: - Empty Radar onboarding

/// Centered onboarding card shown on the team floor when the live daemon
/// is reachable but reports zero workstreams. First-launch users land here
/// instead of staring at a blank window.
///
/// Copy uses the Dispatch lexicon ("Radar") per CLAUDE.md. The code block
/// is selectable and has a copy-to-clipboard affordance so the user can
/// grab the snippet in one click.
private struct RadarEmptyStateView: View {
    @State private var copied: Bool = false

    private static let snippet = "cd ~/Code/your-project\nclaude"

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                Spacer(minLength: 40)
                card
                    .frame(maxWidth: 520)
                    .padding(.horizontal, 32)
                Spacer(minLength: 40)
            }
            .frame(maxWidth: .infinity)
        }
        .background(Resona.Palette.cream)
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 10) {
                Image(systemName: "dot.radiowaves.left.and.right")
                    .imageScale(.large)
                    .foregroundStyle(Resona.Palette.success)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Radar is clear")
                        .font(Resona.Typography.headline)
                    Text("No workstreams yet — let's get one on screen.")
                        .font(.callout)
                        .foregroundStyle(Resona.Palette.inkSoft)
                }
            }

            Divider()
                .overlay(Resona.Palette.stone)

            VStack(alignment: .leading, spacing: 8) {
                Text("How to start a workstream")
                    .font(Resona.Typography.headline)
                Text("`cd` into any project directory and run `claude`. Dispatch's hooks register the session automatically and a card will appear here within a few seconds.")
                    .font(.callout)
                    .foregroundStyle(Resona.Palette.inkSoft)
                    .fixedSize(horizontal: false, vertical: true)
            }

            codeBlock

            HStack(spacing: 6) {
                Image(systemName: "info.circle")
                    .imageScale(.small)
                    .foregroundStyle(Resona.Palette.inkFaint)
                Text("See `docs/TUTORIAL.md` for the full walk-through.")
                    .font(Resona.Typography.caption)
                    .foregroundStyle(Resona.Palette.inkSoft)
            }
        }
        .resonaCard(tint: Resona.Palette.parchment, corner: 18, padding: 24)
    }

    private var codeBlock: some View {
        ZStack(alignment: .topTrailing) {
            Text(Self.snippet)
                .font(.system(.callout, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .padding(.trailing, 64) // leave room for the copy button
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Resona.Palette.mist)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(Resona.Palette.stone, lineWidth: 1)
                )

            Button {
                copyToClipboard()
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    Text(copied ? "Copied" : "Copy")
                }
                .font(.caption.weight(.medium))
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .padding(8)
            .help("Copy this snippet to the clipboard")
        }
    }

    private func copyToClipboard() {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(Self.snippet, forType: .string)
        copied = true
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.5))
            copied = false
        }
    }
}

// MARK: - Digest rail

/// Populated digest rail backed by `client.getDigest(since:)`. Refreshes on
/// view appear and every 5 minutes after that. The body's `.task` cancels its
/// child task on view disappear, which terminates the refresh loop cleanly.
struct DigestRailView: View {
    let client: DaemonClientProtocol
    let workstreams: [Workstream]
    let onHighlightSelect: (Workstream) -> Void
    /// Two-way binding to the parent's RadarFilter — taps on a `DigestStat`
    /// set/clear the filter. `.all` is the cleared state.
    @Binding var filter: HomeView.RadarFilter
    /// Notifies the parent when `digest.buckets` updates so it can build
    /// exact-membership predicates for the filtered team floor.
    var onBucketsUpdate: (DigestBuckets) -> Void

    @State private var digest: Digest?
    @State private var loading = true
    @State private var lastError: String?

    private static let refreshInterval: Duration = .seconds(60 * 5)

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 16) {
                VStack(alignment: .leading, spacing: 2) {
                    ResonaEyebrow(text: "Today")
                    Text(headline)
                        .font(.title3.weight(.semibold))
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .layoutPriority(1)
                Spacer(minLength: 8)
                // Narrow windows can't fit four stats + the headline on one
                // row; let the stats scroll horizontally instead of clipping.
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        if let totals = digest?.totals {
                            DigestStat(
                                label: "Shipped",
                                value: "\(totals.shipped)",
                                systemImage: "checkmark.seal",
                                tint: Resona.Palette.sky,
                                isSelected: filter == .shipped,
                                onTap: { toggle(.shipped) }
                            )
                            DigestStat(
                                label: "Blocked",
                                value: "\(totals.blocked)",
                                systemImage: "exclamationmark.octagon.fill",
                                tint: Resona.Palette.coral,
                                isSelected: filter == .blocked,
                                onTap: { toggle(.blocked) }
                            )
                            DigestStat(
                                label: "Needs you",
                                value: "\(totals.needsAttention)",
                                systemImage: "exclamationmark.bubble.fill",
                                tint: Resona.Palette.apricot,
                                isSelected: filter == .needsYou,
                                onTap: { toggle(.needsYou) }
                            )
                            DigestStat(
                                label: "Active",
                                value: "\(totals.active)",
                                systemImage: "bolt.horizontal.fill",
                                tint: Resona.Palette.mint,
                                isSelected: filter == .active,
                                onTap: { toggle(.active) }
                            )
                        } else if loading {
                            ProgressView().controlSize(.small)
                        }
                    }
                    .fixedSize()
                }
            }

            if !highlights.isEmpty {
                VStack(spacing: 4) {
                    ForEach(highlights) { hl in
                        HighlightRow(highlight: hl) {
                            if let ws = workstreams.first(where: { $0.id == hl.workstreamID }) {
                                onHighlightSelect(ws)
                            }
                        }
                    }
                }
            } else if !loading && digest != nil {
                Text("Quiet morning — nothing new to flag.")
                    .font(Resona.Typography.caption)
                    .foregroundStyle(Resona.Palette.inkFaint)
            }

            if let lastError {
                Label(lastError, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption2)
                    .foregroundStyle(Resona.Palette.coral)
            }
        }
        .task {
            // .task cancels on view disappear. Loop sleeps + refetches; the
            // sleep throws on cancellation so we exit cleanly.
            await refreshOnce()
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: Self.refreshInterval)
                } catch {
                    break
                }
                await refreshOnce()
            }
        }
        // Live refresh: ContentView already debounces a workstream-list
        // re-fetch on every WS event (intervention_enqueued / blocked /
        // session_end / etc.). Piggy-back on that signal so the digest
        // counters track real-time instead of waiting up to 5 minutes for
        // the polling tick.
        .onChange(of: refreshKey) {
            Task { await refreshOnce() }
        }
    }

    /// Token that flips whenever any workstream-level state the digest cares
    /// about changes. Includes status + needsAttention + the new headline so
    /// transient tool_use bursts don't churn — but blocked flips, status
    /// changes, and lifecycle events do.
    private var refreshKey: String {
        workstreams
            .map { "\($0.id):\($0.status.rawValue):\($0.needsAttention ? 1 : 0):\($0.activityHeadlineAt?.timeIntervalSince1970 ?? 0)" }
            .joined(separator: "|")
    }

    private var highlights: [DigestHighlight] {
        Array((digest?.highlights ?? []).prefix(5))
    }

    private var headline: String {
        guard let totals = digest?.totals else {
            return "Loading digest…"
        }
        let needs = totals.needsAttention
        let active = totals.active
        if needs > 0 {
            return "\(active) agent\(active == 1 ? "" : "s") working, \(needs) need\(needs == 1 ? "s" : "") you."
        }
        return "\(active) agent\(active == 1 ? "" : "s") working."
    }

    private func refreshOnce() async {
        loading = true
        defer { loading = false }
        do {
            let next = try await client.getDigest(since: nil)
            digest = next
            onBucketsUpdate(next.buckets)
            lastError = nil
        } catch {
            lastError = (error as? LocalizedError)?.errorDescription
                ?? "Could not load digest."
        }
    }

    /// Tap → set this filter; tap again on the same one → clear back to .all.
    private func toggle(_ tapped: HomeView.RadarFilter) {
        filter = (filter == tapped) ? .all : tapped
    }
}

private struct DigestStat: View {
    let label: String
    let value: String
    let systemImage: String
    let tint: Color
    let isSelected: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .center, spacing: 2) {
                HStack(spacing: 4) {
                    Image(systemName: systemImage)
                        .imageScale(.small)
                        .foregroundStyle(tint)
                    Text(value)
                        .font(.title2.monospacedDigit().weight(.semibold))
                        .foregroundStyle(tint)
                }
                Text(label)
                    .font(.caption2)
                    .foregroundStyle(Resona.Palette.inkSoft)
                    .textCase(.uppercase)
            }
            .frame(minWidth: 64)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(isSelected ? tint.opacity(0.45) : Color.white.opacity(0.6))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(isSelected ? tint : Color.white.opacity(0.8), lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
        .help(isSelected ? "Tap to clear filter" : "Filter Radar to \(label)")
    }
}

private struct HighlightRow: View {
    let highlight: DigestHighlight
    let onTap: () -> Void

    var body: some View {
        Button {
            onTap()
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "arrow.right.circle.fill")
                    .imageScale(.small)
                    .foregroundStyle(Resona.Palette.lavender)
                Text(highlight.title)
                    .font(.callout.weight(.medium))
                    .lineLimit(1)
                Text("·")
                    .foregroundStyle(Resona.Palette.inkFaint)
                Text(highlight.summary)
                    .font(Resona.Typography.caption)
                    .foregroundStyle(Resona.Palette.inkSoft)
                    .lineLimit(1)
                Spacer()
            }
            .padding(.vertical, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Jump to this workstream's detail view")
    }
}

// MARK: - Card

struct WorkstreamCard: View {
    let workstream: Workstream
    /// v1.4.20 — tracker link for the chip (Linear issue or team-brain plan).
    var link: WorkstreamLink? = nil
    /// v1.4.20 — the orchestrator's in-flight entry, when this workstream is
    /// being driven autonomously right now. Carries the tmux attach info.
    var run: OrchestratorState.RunningEntry? = nil

    private var isAutonomous: Bool { workstream.autonomousRunning || run != nil }

    /// What to render in the "Currently:" line. Resolution order:
    ///  1. LLM-generated `activityHeadline` from the daemon (best — full sentence).
    ///  2. The in-progress todo from TodoWrite (Feature B). Prefers
    ///     `activeForm` ("Migrating billing queries") over `content`.
    ///  3. Else `latestActivity` (Feature A — humanized last tool_use).
    ///  4. Else nil (no row rendered).
    private var currentActivityLine: String? {
        if let headline = workstream.activityHeadline, !headline.isEmpty {
            return headline
        }
        if let todos = workstream.todos, !todos.isEmpty,
           let active = todos.first(where: { $0.status == .inProgress }) {
            return active.activeForm ?? active.content
        }
        return workstream.latestActivity
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline) {
                    Text(workstream.title)
                        .font(Resona.Typography.headline)
                        .lineLimit(1)
                    if workstream.status == .paused {
                        Image(systemName: "pause.fill")
                            .imageScale(.small)
                            .foregroundStyle(Resona.Palette.butter)
                            .help("Paused")
                    }
                    Spacer()
                    if isAutonomous {
                        AutonomousBadge(attachable: run?.attach != nil)
                    }
                    StatusPill(workstream: workstream)
                }

                HStack(spacing: 6) {
                    Text(workstream.id)
                        .font(Resona.Typography.caption)
                        .foregroundStyle(Resona.Palette.inkFaint)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let link {
                        TrackerChip(link: link, compact: true)
                    }
                }

                if let goal = workstream.currentSubgoal {
                    HStack(alignment: .top, spacing: 6) {
                        Image(systemName: "arrow.turn.down.right")
                            .imageScale(.small)
                            .foregroundStyle(Resona.Palette.inkFaint)
                        Text(goal)
                            .font(.callout)
                            .lineLimit(2)
                    }
                }

                // "Currently:" line (Features A + B). Prefer the in-progress
                // todo (TodoWrite is the agent's actual planning surface);
                // fall back to the humanized last tool_use; render nothing
                // when neither signal is available. Single-line, .secondary
                // styling so it sits visually below the subgoal row.
                if let activity = currentActivityLine {
                    HStack(alignment: .firstTextBaseline, spacing: 5) {
                        Image(systemName: "hammer.fill")
                            .imageScale(.small)
                            .foregroundStyle(Resona.Palette.inkFaint)
                        Text(activity)
                            .font(Resona.Typography.caption)
                            .foregroundStyle(Resona.Palette.inkSoft)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                }

                HStack {
                    if let c = workstream.latestConfidence {
                        ConfidenceBar(value: c)
                    }
                    Spacer()
                    if workstream.needsAttention {
                        Label("Needs you", systemImage: "exclamationmark.bubble.fill")
                            .font(.caption.weight(.semibold))
                            .labelStyle(.titleAndIcon)
                            .foregroundStyle(Resona.Palette.coral)
                    }
                }
            }
            // Robot mascot on the right side of the card. State derives from
            // the workstream projection (last_event_at, needs_attention, status).
            RobotMascot(workstream: workstream, size: 40)
                .padding(.top, 2)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .opacity(workstream.status == .paused ? 0.6 : 1.0)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Resona.Palette.parchment)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(workstream.needsAttention ? Resona.Palette.coral.opacity(0.6) : Color.white.opacity(0.7),
                              lineWidth: workstream.needsAttention ? 1.5 : 1)
        )
        .shadow(color: Resona.Palette.lavender.opacity(0.18), radius: 12, x: 0, y: 6)
    }
}

private struct StatusPill: View {
    let workstream: Workstream

    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(ResonaStatusTint.forWorkstreamStatus(workstream.status.rawValue)).frame(width: 6, height: 6)
            Text(workstream.statusLabel)
                .font(.caption2.weight(.medium))
                .foregroundStyle(Resona.Palette.inkSoft)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(
            Capsule().fill(ResonaStatusTint.forWorkstreamStatus(workstream.status.rawValue).opacity(0.3))
        )
    }
}

private struct ConfidenceBar: View {
    let value: Double           // 0...1
    var body: some View {
        let pct = max(0, min(1, value))
        VStack(alignment: .leading, spacing: 3) {
            Text("Confidence \(Int((pct * 100).rounded()))%")
                .font(.caption2)
                .foregroundStyle(Resona.Palette.inkSoft)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Resona.Palette.stone.opacity(0.5))
                    Capsule()
                        .fill(barTint(for: pct))
                        .frame(width: geo.size.width * pct)
                }
            }
            .frame(height: 4)
            .frame(width: 120)
        }
    }

    private func barTint(for v: Double) -> Color {
        switch v {
        case ..<0.4:  return Resona.Palette.coral
        case ..<0.7:  return Resona.Palette.butter
        default:      return Resona.Palette.success
        }
    }
}

// MARK: - Live ticker

/// Live, WebSocket-driven ticker buffer.
///
/// On first load (or whenever the workstream set changes) it seeds itself
/// from `getEvents(workstreamID:)` per workstream, then opens an
/// `AsyncStream<Event>` per workstream via `streamEvents(...)` and merges
/// new events into the buffer (newest first, capped at `bufferCap`).
///
/// Reconnect on transport failure is intentionally deferred to v1 — if a
/// stream finishes the corresponding feeder task simply ends; the ticker
/// keeps the entries it already has.
@MainActor
final class LiveTickerViewModel: ObservableObject {
    @Published private(set) var entries: [LiveTickerView.TickerEntry] = []

    private static let bufferCap = 50

    private var feederTasks: [Task<Void, Never>] = []
    private var titlesByID: [String: String] = [:]
    private var seededKey: [String]? = nil

    func start(client: DaemonClientProtocol, workstreams: [Workstream]) async {
        let key = workstreams.map(\.id)
        // Re-seed only when the set of workstream IDs actually changes.
        if seededKey == key { return }
        await stop()
        seededKey = key
        titlesByID = Dictionary(uniqueKeysWithValues: workstreams.map { ($0.id, $0.title) })

        // Seed pass: one historical fetch per workstream, merged.
        var seeded: [LiveTickerView.TickerEntry] = []
        for ws in workstreams {
            if let evs = try? await client.getEvents(workstreamID: ws.id) {
                seeded.append(contentsOf: evs.map {
                    LiveTickerView.TickerEntry(event: $0, workstreamTitle: ws.title)
                })
            }
        }
        seeded.sort { $0.event.ts > $1.event.ts }
        entries = Array(seeded.prefix(Self.bufferCap))

        // Live pass: one WS subscription per workstream.
        feederTasks = workstreams.map { ws in
            Task { [weak self] in
                let stream = client.streamEvents(workstreamID: ws.id)
                for await event in stream {
                    if Task.isCancelled { break }
                    await self?.merge(event: event, workstreamID: ws.id)
                }
                // Stream finished (transport failure or normal end). v1 reconnect.
            }
        }
    }

    func stop() async {
        for task in feederTasks { task.cancel() }
        feederTasks.removeAll()
    }

    private func merge(event: Event, workstreamID: String) {
        // Skip duplicates by event id.
        if entries.contains(where: { $0.event.id == event.id }) { return }
        let title = titlesByID[workstreamID] ?? workstreamID
        var next = entries
        next.append(LiveTickerView.TickerEntry(event: event, workstreamTitle: title))
        next.sort { $0.event.ts > $1.event.ts }
        if next.count > Self.bufferCap { next = Array(next.prefix(Self.bufferCap)) }
        entries = next
    }
}

struct LiveTickerView: View {
    let client: DaemonClientProtocol
    let workstreams: [Workstream]

    @StateObject private var model = LiveTickerViewModel()

    private static let timeFormatter: DateFormatter = {
        let df = DateFormatter()
        df.dateFormat = "HH:mm"
        return df
    }()

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Image(systemName: "dot.radiowaves.left.and.right")
                Text("Live ticker")
                    .font(Resona.Typography.headline)
                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Resona.Palette.parchment.opacity(0.85))

            Divider()
                .overlay(Resona.Palette.stone)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 6) {
                    ForEach(model.entries) { entry in
                        TickerRow(entry: entry)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .background(Resona.Palette.mist.opacity(0.9))
        .task(id: workstreams.map(\.id)) {
            // .task(id:) cancels the previous body task when the id changes,
            // and cancels on view disappear. We chain that into the feeder
            // tasks via `stop()` in the cancellation handler below.
            await model.start(client: client, workstreams: workstreams)
            // Block until cancellation so feeders stay alive while the view
            // is on-screen for this workstream set.
            await waitUntilCancelled()
            await model.stop()
        }
    }

    private func waitUntilCancelled() async {
        // Sleeps in a loop; each `Task.sleep` throws when the enclosing task
        // is cancelled, ending the loop cleanly.
        while !Task.isCancelled {
            do {
                try await Task.sleep(for: .seconds(60))
            } catch {
                break
            }
        }
    }

    struct TickerEntry: Identifiable {
        let event: Event
        let workstreamTitle: String
        var id: String { event.id }
    }

    private struct TickerRow: View {
        let entry: TickerEntry

        var body: some View {
            HStack(alignment: .top, spacing: 8) {
                Text(LiveTickerView.timeFormatter.string(from: entry.event.ts))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(Resona.Palette.inkSoft)
                    .frame(width: 38, alignment: .leading)
                VStack(alignment: .leading, spacing: 1) {
                    Text(entry.workstreamTitle)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.primary)
                    Text(entry.event.tickerSummary)
                        .font(Resona.Typography.caption)
                        .foregroundStyle(Resona.Palette.inkSoft)
                        .lineLimit(2)
                }
            }
        }
    }
}

#Preview("WorkstreamCard — todos vs activity") {
    // Two cards side-by-side: one with a TodoWrite plan (uses the
    // in-progress todo's activeForm), one without (falls back to the
    // humanized latest_activity).
    let withTodos = MockData.workstreams.first { $0.id == "frontend-refactor" }
    let withActivity = MockData.workstreams.first { $0.id == "auth-hardening" }
    return HStack(spacing: 16) {
        if let withTodos {
            WorkstreamCard(workstream: withTodos)
                .frame(width: 320)
        }
        if let withActivity {
            WorkstreamCard(workstream: withActivity)
                .frame(width: 320)
        }
    }
    .padding(20)
    .background(Resona.Palette.cream)
}

#Preview("HomeView (mock)") {
    HomeView(
        workstreams: MockData.workstreams,
        client: MockDaemonClient(),
        onSelect: { _ in },
        onLifecycleAction: { _, _ in }
    )
    .environmentObject(DaemonResolver(forcedMode: .mock))
    .frame(width: 1200, height: 760)
}

#Preview("HomeView (live, empty)") {
    // Empty live daemon — exercises the RadarEmptyStateView onboarding.
    HomeView(
        workstreams: [],
        client: MockDaemonClient(workstreams: []),
        onSelect: { _ in },
        onLifecycleAction: { _, _ in }
    )
    .environmentObject(DaemonResolver(forcedMode: .live))
    .frame(width: 1200, height: 760)
}

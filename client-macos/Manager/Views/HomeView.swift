import SwiftUI

/// Three-zone home view (see docs/ARCHITECTURE.md > "Three-zone home view"):
///
///   ┌──────────────────────────────────────────────────────────────┐
///   │ DigestRailView  — aggregate summary across the team          │
///   ├────────────────────────────────────────────┬─────────────────┤
///   │                                            │                 │
///   │ TeamFloorView — grid of WorkstreamCard     │ LiveTickerView  │
///   │                                            │ (right rail)    │
///   │                                            │                 │
///   └────────────────────────────────────────────┴─────────────────┘
struct HomeView: View {
    let workstreams: [Workstream]
    let client: DaemonClientProtocol
    /// Tap handler for both the team-floor cards and the digest highlight rows.
    let onSelect: (Workstream) -> Void
    /// Lifecycle action callback used by the card context menus
    /// (Pause / Resume / Retire / Edit title…). Wired by `ContentView`.
    let onLifecycleAction: (Workstream, LifecycleAction) -> Void

    enum LifecycleAction: Hashable {
        case pause
        case resume
        case retire
        case editTitle
    }

    var body: some View {
        VStack(spacing: 0) {
            DigestRailView(
                client: client,
                workstreams: workstreams,
                onHighlightSelect: onSelect
            )
            .padding(.horizontal, 20)
            .padding(.vertical, 14)
            .background(.thinMaterial)

            Divider()

            HStack(alignment: .top, spacing: 0) {
                TeamFloorView(
                    workstreams: workstreams,
                    onSelect: onSelect,
                    onLifecycleAction: onLifecycleAction
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                Divider()

                LiveTickerView(client: client, workstreams: workstreams)
                    .frame(width: 320)
            }
        }
        .navigationTitle("Manager")
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

    @State private var digest: Digest?
    @State private var loading = true
    @State private var lastError: String?

    private static let refreshInterval: Duration = .seconds(60 * 5)

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 24) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Today")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textCase(.uppercase)
                    Text(headline)
                        .font(.title3.weight(.semibold))
                }
                Spacer()
                if let totals = digest?.totals {
                    DigestStat(
                        label: "Shipped",
                        value: "\(totals.shipped)",
                        systemImage: "checkmark.seal",
                        tint: .blue
                    )
                    DigestStat(
                        label: "Blocked",
                        value: "\(totals.blocked)",
                        systemImage: "exclamationmark.octagon.fill",
                        tint: .red
                    )
                    DigestStat(
                        label: "Needs you",
                        value: "\(totals.needsAttention)",
                        systemImage: "exclamationmark.bubble.fill",
                        tint: .orange
                    )
                    DigestStat(
                        label: "Active",
                        value: "\(totals.active)",
                        systemImage: "bolt.horizontal.fill",
                        tint: .green
                    )
                } else if loading {
                    ProgressView().controlSize(.small)
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
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }

            if let lastError {
                Label(lastError, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption2)
                    .foregroundStyle(.red)
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
            lastError = nil
        } catch {
            lastError = (error as? LocalizedError)?.errorDescription
                ?? "Could not load digest."
        }
    }
}

private struct DigestStat: View {
    let label: String
    let value: String
    let systemImage: String
    let tint: Color

    var body: some View {
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
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
        }
        .frame(minWidth: 56)
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
                    .foregroundStyle(.secondary)
                Text(highlight.title)
                    .font(.callout.weight(.medium))
                    .lineLimit(1)
                Text("·")
                    .foregroundStyle(.tertiary)
                Text(highlight.summary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer()
            }
            .padding(.vertical, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Team floor

struct TeamFloorView: View {
    let workstreams: [Workstream]
    let onSelect: (Workstream) -> Void
    let onLifecycleAction: (Workstream, HomeView.LifecycleAction) -> Void

    private let columns = [
        GridItem(.adaptive(minimum: 280, maximum: 360), spacing: 16, alignment: .top)
    ]

    /// Floor renders only active + paused workstreams; retired ones live in
    /// the sidebar's "Retired" disclosure group.
    private var visibleWorkstreams: [Workstream] {
        workstreams.filter { $0.status != .retired }
    }

    var body: some View {
        ScrollView {
            LazyVGrid(columns: columns, alignment: .leading, spacing: 16) {
                ForEach(visibleWorkstreams) { ws in
                    Button {
                        onSelect(ws)
                    } label: {
                        WorkstreamCard(workstream: ws)
                    }
                    .buttonStyle(.plain)
                    .contextMenu {
                        cardMenu(for: ws)
                    }
                }
            }
            .padding(20)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    @ViewBuilder
    private func cardMenu(for ws: Workstream) -> some View {
        switch ws.status {
        case .active:
            Button {
                onLifecycleAction(ws, .pause)
            } label: {
                Label("Pause", systemImage: "pause.circle")
            }
        case .paused:
            Button {
                onLifecycleAction(ws, .resume)
            } label: {
                Label("Resume", systemImage: "play.circle")
            }
        case .retired:
            EmptyView()
        }
        Button {
            onLifecycleAction(ws, .editTitle)
        } label: {
            Label("Edit title…", systemImage: "pencil")
        }
        Divider()
        Button(role: .destructive) {
            onLifecycleAction(ws, .retire)
        } label: {
            Label("Retire", systemImage: "archivebox")
        }
    }
}

struct WorkstreamCard: View {
    let workstream: Workstream

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(workstream.title)
                    .font(.headline)
                    .lineLimit(1)
                if workstream.status == .paused {
                    Image(systemName: "pause.fill")
                        .imageScale(.small)
                        .foregroundStyle(.yellow)
                        .help("Paused")
                }
                Spacer()
                StatusPill(workstream: workstream)
            }

            Text(workstream.id)
                .font(.caption)
                .foregroundStyle(.secondary)

            if let goal = workstream.currentSubgoal {
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: "arrow.turn.down.right")
                        .imageScale(.small)
                        .foregroundStyle(.tertiary)
                    Text(goal)
                        .font(.callout)
                        .lineLimit(2)
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
                        .foregroundStyle(.orange)
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .opacity(workstream.status == .paused ? 0.6 : 1.0)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color(nsColor: .controlBackgroundColor))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(workstream.needsAttention ? Color.orange.opacity(0.6) : Color.gray.opacity(0.18),
                        lineWidth: workstream.needsAttention ? 1.5 : 1)
        )
    }
}

private struct StatusPill: View {
    let workstream: Workstream

    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(workstream.statusColor).frame(width: 6, height: 6)
            Text(workstream.statusLabel)
                .font(.caption2.weight(.medium))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(
            Capsule().fill(workstream.statusColor.opacity(0.12))
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
                .foregroundStyle(.secondary)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.gray.opacity(0.18))
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
        case ..<0.4:  return .red
        case ..<0.7:  return .yellow
        default:      return .green
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
                    .font(.headline)
                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(.thinMaterial)

            Divider()

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
        .background(Color(nsColor: .underPageBackgroundColor))
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
                    .foregroundStyle(.secondary)
                    .frame(width: 38, alignment: .leading)
                VStack(alignment: .leading, spacing: 1) {
                    Text(entry.workstreamTitle)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.primary)
                    Text(entry.event.tickerSummary)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
        }
    }
}

#Preview("HomeView (mock)") {
    HomeView(
        workstreams: MockData.workstreams,
        client: MockDaemonClient(),
        onSelect: { _ in },
        onLifecycleAction: { _, _ in }
    )
    .frame(width: 1200, height: 760)
}

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
    let onSelect: (Workstream) -> Void

    var body: some View {
        VStack(spacing: 0) {
            DigestRailView(workstreams: workstreams)
                .padding(.horizontal, 20)
                .padding(.vertical, 14)
                .background(.thinMaterial)

            Divider()

            HStack(alignment: .top, spacing: 0) {
                TeamFloorView(workstreams: workstreams, onSelect: onSelect)
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

struct DigestRailView: View {
    let workstreams: [Workstream]

    private var shipped: Int {
        workstreams.filter { $0.status == .retired }.count
    }
    private var blocked: Int {
        workstreams.filter { $0.needsAttention }.count
    }
    private var active: Int {
        workstreams.filter { $0.status == .active }.count
    }

    var body: some View {
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
            DigestStat(label: "Active",  value: "\(active)",  tint: .green)
            DigestStat(label: "Blocked", value: "\(blocked)", tint: .orange)
            DigestStat(label: "Shipped", value: "\(shipped)", tint: .blue)
        }
    }

    private var headline: String {
        if blocked > 0 {
            return "\(active) agent\(active == 1 ? "" : "s") working, \(blocked) need\(blocked == 1 ? "s" : "") you."
        }
        return "\(active) agent\(active == 1 ? "" : "s") working."
    }
}

private struct DigestStat: View {
    let label: String
    let value: String
    let tint: Color

    var body: some View {
        VStack(alignment: .center, spacing: 2) {
            Text(value)
                .font(.title2.monospacedDigit().weight(.semibold))
                .foregroundStyle(tint)
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
        }
        .frame(minWidth: 56)
    }
}

// MARK: - Team floor

struct TeamFloorView: View {
    let workstreams: [Workstream]
    let onSelect: (Workstream) -> Void

    private let columns = [
        GridItem(.adaptive(minimum: 280, maximum: 360), spacing: 16, alignment: .top)
    ]

    var body: some View {
        ScrollView {
            LazyVGrid(columns: columns, alignment: .leading, spacing: 16) {
                ForEach(workstreams) { ws in
                    Button {
                        onSelect(ws)
                    } label: {
                        WorkstreamCard(workstream: ws)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(20)
        }
        .background(Color(nsColor: .windowBackgroundColor))
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

struct LiveTickerView: View {
    let client: DaemonClientProtocol
    let workstreams: [Workstream]

    @State private var events: [TickerEntry] = []

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
                    ForEach(events) { entry in
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
            await loadInitial()
        }
    }

    private func loadInitial() async {
        var combined: [TickerEntry] = []
        for ws in workstreams {
            if let evs = try? await client.getEvents(workstreamID: ws.id) {
                combined.append(contentsOf: evs.map {
                    TickerEntry(event: $0, workstreamTitle: ws.title)
                })
            }
        }
        combined.sort { $0.event.ts > $1.event.ts }
        events = Array(combined.prefix(60))
    }

    private struct TickerEntry: Identifiable {
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
        onSelect: { _ in }
    )
    .frame(width: 1200, height: 760)
}

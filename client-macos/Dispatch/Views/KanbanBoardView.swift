import SwiftUI

/// Threshold above which the Active column auto-folds workstreams under a
/// "Pod auto-grouped" disclosure rather than rendering every card inline.
/// Exposed so `KanbanLogicTests` can pin the boundary.
let kanbanActivePodThreshold: Int = 12

/// Pure helper: bucket a flat list into the four kanban columns. Order
/// within each bucket preserves caller order (so the parent's filter /
/// digest sort drives the visible order; the kanban view itself doesn't
/// re-sort). Lives outside the view so `KanbanLogicTests` can exercise it
/// without spinning up SwiftUI.
func partitionWorkstreamsByStatus(_ workstreams: [Workstream]) -> [Workstream.Status: [Workstream]] {
    var buckets: [Workstream.Status: [Workstream]] = [
        .backlog: [],
        .active: [],
        .paused: [],
        .retired: [],
    ]
    for ws in workstreams {
        buckets[ws.status, default: []].append(ws)
    }
    return buckets
}

/// Pure helper: should the Active column collapse into a "pod-grouped"
/// disclosure? `count > threshold` rather than `>=` so the threshold itself
/// is the last value rendered inline.
func shouldGroupPod(count: Int, threshold: Int = kanbanActivePodThreshold) -> Bool {
    count > threshold
}

/// 4-column kanban: Backlog / Active / Paused / Retired. Each column
/// supports drag-and-drop to flip a workstream's status server-side.
///
/// Replaces the v1.1 `LazyVGrid`-based `TeamFloorView`. The digest filter
/// still applies — non-matching cards dim in place rather than disappearing
/// from their column, so the columns themselves don't reflow when the user
/// taps a stat.
struct KanbanBoardView: View {
    let workstreams: [Workstream]
    let client: DaemonClientProtocol
    let onCardTap: (Workstream) -> Void
    let onLifecycleAction: (Workstream, HomeView.LifecycleAction) -> Void
    /// `.all` means no filter; other values dim the cards that don't match.
    var activeFilter: HomeView.RadarFilter = .all
    /// Membership lookups so the filter can match the daemon's bucket
    /// projections (preferred) before falling back to model-level predicates.
    var filteredIDs: Set<String> = []

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ForEach(Workstream.Status.allCases, id: \.self) { status in
                KanbanColumnView(
                    status: status,
                    workstreams: buckets[status] ?? [],
                    activeFilter: activeFilter,
                    filteredIDs: filteredIDs,
                    onCardTap: onCardTap,
                    onLifecycleAction: onLifecycleAction,
                    onDrop: { payload in
                        handleDrop(payload: payload, into: status)
                    }
                )
                .frame(maxWidth: .infinity, alignment: .top)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    private var buckets: [Workstream.Status: [Workstream]] {
        partitionWorkstreamsByStatus(workstreams)
    }

    private func handleDrop(payload: WorkstreamDragPayload, into status: Workstream.Status) {
        guard payload.currentStatus != status else { return }
        Task {
            _ = try? await client.updateWorkstream(
                id: payload.id,
                status: status,
                title: nil
            )
        }
    }
}

// MARK: - Column

struct KanbanColumnView: View {
    let status: Workstream.Status
    let workstreams: [Workstream]
    let activeFilter: HomeView.RadarFilter
    let filteredIDs: Set<String>
    let onCardTap: (Workstream) -> Void
    let onLifecycleAction: (Workstream, HomeView.LifecycleAction) -> Void
    let onDrop: (WorkstreamDragPayload) -> Void

    @State private var isTargeted: Bool = false
    @State private var podExpanded: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            if shouldFold {
                podDisclosure
            } else {
                cards(workstreams)
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .top)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(columnTint)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(isTargeted ? Color.accentColor : Color.white.opacity(0.7),
                              lineWidth: isTargeted ? 2 : 1)
        )
        .dropDestination(for: WorkstreamDragPayload.self) { items, _ in
            guard let payload = items.first else { return false }
            onDrop(payload)
            return true
        } isTargeted: { isTargeted = $0 }
    }

    private var shouldFold: Bool {
        // Pod auto-grouping is Active-only — keep Backlog / Paused / Retired
        // un-collapsed so users can scan them at full height.
        status == .active && shouldGroupPod(count: workstreams.count)
    }

    @ViewBuilder
    private var header: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(headerTint)
                .frame(width: 8, height: 8)
            Text(headerLabel)
                .font(Resona.Typography.headline)
            Spacer()
            Text("\(workstreams.count)")
                .font(.caption.monospacedDigit())
                .foregroundStyle(Resona.Palette.inkSoft)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(
                    Capsule().fill(Color.white.opacity(0.6))
                )
                .overlay(
                    Capsule().strokeBorder(Color.white.opacity(0.8), lineWidth: 1)
                )
        }
        .padding(.horizontal, 4)
        .padding(.bottom, 2)
    }

    @ViewBuilder
    private var podDisclosure: some View {
        DisclosureGroup(isExpanded: $podExpanded) {
            cards(workstreams)
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "rectangle.stack.fill")
                    .imageScale(.small)
                    .foregroundStyle(Resona.Palette.inkSoft)
                Text("Pod-grouped — \(workstreams.count) workstreams")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(Resona.Palette.inkSoft)
            }
        }
        .padding(.horizontal, 4)
    }

    @ViewBuilder
    private func cards(_ list: [Workstream]) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 8) {
                ForEach(list) { ws in
                    Button { onCardTap(ws) } label: {
                        WorkstreamCard(workstream: ws)
                    }
                    .buttonStyle(.plain)
                    .opacity(dim(ws) ? 0.35 : 1.0)
                    .draggable(WorkstreamDragPayload(id: ws.id, currentStatus: ws.status))
                    .help("Drag this card to a different column to change its status")
                    .contextMenu { cardMenu(for: ws) }
                }
            }
            .padding(.horizontal, 2)
            .padding(.vertical, 2)
        }
    }

    /// Dim a card when an active filter is set and this workstream is not in
    /// the matched set. We dim instead of hiding so columns don't reflow on
    /// every filter tap.
    private func dim(_ ws: Workstream) -> Bool {
        guard activeFilter != .all else { return false }
        if !filteredIDs.isEmpty {
            return !filteredIDs.contains(ws.id)
        }
        switch activeFilter {
        case .blocked, .needsYou:
            return !ws.needsAttention
        case .active:
            return ws.status != .active
        case .shipped:
            // No reliable model-level predicate; keep cards visible if no
            // bucket membership is supplied.
            return false
        case .all:
            return false
        }
    }

    private var headerLabel: String {
        switch status {
        case .backlog: return "Backlog"
        case .active:  return "Active"
        case .paused:  return "Paused"
        case .retired: return "Retired"
        }
    }

    private var headerTint: Color {
        switch status {
        case .backlog: return Resona.Palette.lavender
        case .active:  return Resona.Palette.mint
        case .paused:  return Resona.Palette.butter
        case .retired: return Resona.Palette.stone
        }
    }

    private var columnTint: Color {
        switch status {
        case .backlog: return Resona.Palette.lilac.opacity(0.35)
        case .active:  return Resona.Palette.mint.opacity(0.18)
        case .paused:  return Resona.Palette.butter.opacity(0.22)
        case .retired: return Resona.Palette.mist
        }
    }

    @ViewBuilder
    private func cardMenu(for ws: Workstream) -> some View {
        switch ws.status {
        case .backlog:
            Button {
                onLifecycleAction(ws, .resume)
            } label: {
                Label("Move to Active", systemImage: "play.circle")
            }
            .help("Promote this workstream out of the backlog into the active column")
        case .active:
            Button {
                onLifecycleAction(ws, .pause)
            } label: {
                Label("Pause", systemImage: "pause.circle")
            }
            .help("Pause this workstream — agents stop being scheduled, history is preserved")
        case .paused:
            Button {
                onLifecycleAction(ws, .resume)
            } label: {
                Label("Resume", systemImage: "play.circle")
            }
            .help("Resume this workstream — agents become eligible to run again")
        case .retired:
            Button {
                onLifecycleAction(ws, .resume)
            } label: {
                Label("Move to Active", systemImage: "play.circle")
            }
            .help("Reactivate this workstream — moves it back into the active column")
        }
        Button {
            onLifecycleAction(ws, .editTitle)
        } label: {
            Label("Edit title…", systemImage: "pencil")
        }
        .help("Rename this workstream")
        Divider()
        Button(role: .destructive) {
            onLifecycleAction(ws, .retire)
        } label: {
            Label("Retire", systemImage: "archivebox")
        }
        .help("Archive this workstream — moves it out of the active grid")
    }
}

#Preview("KanbanBoardView (mock)") {
    KanbanBoardView(
        workstreams: MockData.workstreams,
        client: MockDaemonClient(simulatedLatency: .zero),
        onCardTap: { _ in },
        onLifecycleAction: { _, _ in }
    )
    .frame(width: 1200, height: 720)
}

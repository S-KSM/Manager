import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var resolver: DaemonResolver
    @State private var workstreams: [Workstream] = []
    @State private var selectedWorkstreamID: String? = nil
    @State private var loading: Bool = true

    var body: some View {
        NavigationSplitView {
            sidebar
                .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 320)
        } detail: {
            detail
        }
        .task(id: resolver.modeToken) {
            await reload()
        }
        .toolbar {
            ToolbarItem(placement: .principal) {
                ModeBadge(mode: resolver.mode)
            }
            ToolbarItem(placement: .primaryAction) {
                Button {
                    Task { await reload() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
            }
        }
    }

    @ViewBuilder
    private var sidebar: some View {
        List(selection: $selectedWorkstreamID) {
            Section("Workstreams") {
                if loading && workstreams.isEmpty {
                    ProgressView().controlSize(.small)
                }
                ForEach(workstreams) { ws in
                    WorkstreamRow(workstream: ws)
                        .tag(Optional(ws.id))
                }
            }
        }
        .listStyle(.sidebar)
    }

    @ViewBuilder
    private var detail: some View {
        if let id = selectedWorkstreamID,
           let ws = workstreams.first(where: { $0.id == id }) {
            AgentDetailView(workstream: ws, client: resolver.client)
                .id(ws.id)
        } else {
            HomeView(workstreams: workstreams,
                     client: resolver.client,
                     onSelect: { selectedWorkstreamID = $0.id })
        }
    }

    private func reload() async {
        loading = true
        defer { loading = false }
        do {
            workstreams = try await resolver.client.listWorkstreams()
        } catch {
            // On any error, fall back to the in-process mock so the UI is never empty.
            workstreams = MockData.workstreams
        }
    }
}

private struct WorkstreamRow: View {
    let workstream: Workstream

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            Circle()
                .fill(workstream.statusColor)
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 2) {
                Text(workstream.title)
                    .font(.callout)
                    .lineLimit(1)
                Text(workstream.id)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            if workstream.needsAttention {
                Image(systemName: "exclamationmark.bubble.fill")
                    .foregroundStyle(.orange)
                    .imageScale(.small)
            }
        }
        .padding(.vertical, 2)
    }
}

private struct ModeBadge: View {
    let mode: DaemonResolver.Mode

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(mode == .live ? Color.green : Color.yellow)
                .frame(width: 8, height: 8)
            Text(mode == .live ? "Live daemon" : "Mock data")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

#Preview("ContentView (mock)") {
    let resolver = DaemonResolver(forcedMode: .mock)
    return ContentView()
        .environmentObject(resolver)
        .frame(width: 1200, height: 760)
}

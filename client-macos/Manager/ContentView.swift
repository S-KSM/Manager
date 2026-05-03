import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var resolver: DaemonResolver
    @State private var workstreams: [Workstream] = []
    @State private var selection: SidebarSelection? = nil
    @State private var loading: Bool = true

    @State private var showNewWorkstreamSheet = false
    @State private var editingTitleFor: Workstream? = nil
    @State private var editTitleDraft: String = ""
    @State private var lifecycleError: String? = nil

    /// What the sidebar can have selected. Workstream id, the team handbook,
    /// the Updates surface, the explicit Home entry, or nothing (which also
    /// falls back to the home view).
    enum SidebarSelection: Hashable {
        case home
        case workstream(String)
        case handbook
        case updates
    }

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
                .help("Reload the radar from the daemon")
            }
        }
        .sheet(isPresented: $showNewWorkstreamSheet) {
            NewWorkstreamSheet(
                client: resolver.client,
                onCreated: { ws in
                    await reload()
                    selection = .workstream(ws.id)
                },
                onDismiss: { showNewWorkstreamSheet = false }
            )
        }
        .alert(
            "Rename workstream",
            isPresented: Binding(
                get: { editingTitleFor != nil },
                set: { if !$0 { editingTitleFor = nil } }
            ),
            presenting: editingTitleFor
        ) { ws in
            TextField("Title", text: $editTitleDraft)
            Button("Save") {
                let target = ws
                let title = editTitleDraft
                editingTitleFor = nil
                Task { await applyTitleEdit(workstream: target, title: title) }
            }
            Button("Cancel", role: .cancel) { editingTitleFor = nil }
        } message: { ws in
            Text("New title for \(ws.id)")
        }
        .alert(
            "Lifecycle action failed",
            isPresented: Binding(
                get: { lifecycleError != nil },
                set: { if !$0 { lifecycleError = nil } }
            ),
            presenting: lifecycleError
        ) { _ in
            Button("OK") { lifecycleError = nil }
        } message: { msg in
            Text(msg)
        }
    }

    // MARK: - Sidebar

    @ViewBuilder
    private var sidebar: some View {
        let active = workstreams.filter { $0.status != .retired }
        let retired = workstreams.filter { $0.status == .retired }

        List(selection: $selection) {
            // "Home" is the explicit back-to-landing affordance: selecting it
            // clears the workstream selection so the detail area falls back
            // to HomeView (digest + team floor + ticker). It lives in its
            // own section above the workstream list so the bold separator
            // visually distinguishes it from the workstream rows below.
            Section {
                Label("Home", systemImage: "house.fill")
                    .tag(Optional(SidebarSelection.home))
            }
            .listSectionSeparator(.visible)

            Section {
                if loading && workstreams.isEmpty {
                    ProgressView().controlSize(.small)
                }
                ForEach(active) { ws in
                    WorkstreamRow(workstream: ws)
                        .tag(Optional(SidebarSelection.workstream(ws.id)))
                }
            } header: {
                HStack {
                    Text("Workstreams")
                    Spacer()
                    Button {
                        showNewWorkstreamSheet = true
                    } label: {
                        Image(systemName: "plus.circle.fill")
                    }
                    .buttonStyle(.borderless)
                    .help("Create a new workstream so the radar starts tracking it")
                }
            }

            Section("Reference") {
                Label("Team handbook", systemImage: "book")
                    .tag(Optional(SidebarSelection.handbook))
                Label("Updates", systemImage: "doc.text.image")
                    .tag(Optional(SidebarSelection.updates))
            }

            if !retired.isEmpty {
                Section("Retired") {
                    DisclosureGroup {
                        ForEach(retired) { ws in
                            WorkstreamRow(workstream: ws)
                                .tag(Optional(SidebarSelection.workstream(ws.id)))
                        }
                    } label: {
                        Text("\(retired.count) retired")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .listStyle(.sidebar)
    }

    // MARK: - Detail

    @ViewBuilder
    private var detail: some View {
        switch selection {
        case .some(.workstream(let id)):
            if let ws = workstreams.first(where: { $0.id == id }) {
                AgentDetailView(workstream: ws, client: resolver.client)
                    .id(ws.id)
            } else {
                placeholderHome
            }
        case .some(.handbook):
            HandbookView(client: resolver.client)
        case .some(.updates):
            UpdatesView(client: resolver.client, workstreams: workstreams)
        case .some(.home), .none:
            placeholderHome
        }
    }

    @ViewBuilder
    private var placeholderHome: some View {
        HomeView(
            workstreams: workstreams,
            client: resolver.client,
            onSelect: { selection = .workstream($0.id) },
            onLifecycleAction: { ws, action in
                Task { await applyLifecycleAction(ws, action) }
            }
        )
    }

    // MARK: - Lifecycle

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

    private func applyLifecycleAction(_ ws: Workstream, _ action: HomeView.LifecycleAction) async {
        switch action {
        case .pause:
            await patch(ws: ws, status: .paused, title: nil)
        case .resume:
            await patch(ws: ws, status: .active, title: nil)
        case .retire:
            await patch(ws: ws, status: .retired, title: nil)
        case .editTitle:
            editTitleDraft = ws.title
            editingTitleFor = ws
        }
    }

    private func applyTitleEdit(workstream ws: Workstream, title: String) async {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != ws.title else { return }
        await patch(ws: ws, status: nil, title: trimmed)
    }

    private func patch(ws: Workstream, status: Workstream.Status?, title: String?) async {
        do {
            let updated = try await resolver.client.updateWorkstream(
                id: ws.id,
                status: status,
                title: title
            )
            // Optimistic local update so the UI reflects the change without
            // waiting for a full reload round-trip.
            if let idx = workstreams.firstIndex(where: { $0.id == updated.id }) {
                workstreams[idx] = updated
            }
        } catch {
            lifecycleError = (error as? LocalizedError)?.errorDescription
                ?? "Could not update \(ws.id)."
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
            if workstream.status == .paused {
                Image(systemName: "pause.fill")
                    .foregroundStyle(.yellow)
                    .imageScale(.small)
            }
        }
        .padding(.vertical, 2)
        .opacity(workstream.status == .retired ? 0.6 : 1.0)
        .saturation(workstream.status == .retired ? 0.0 : 1.0)
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

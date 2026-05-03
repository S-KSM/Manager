import SwiftUI

/// Modal for generating a new update.
///
/// Flow (mirrors `InterventionPanel` shape):
///   1. Form: period + workstreams + audience + provider + model.
///   2. "Generate" → `client.generateReport(...)` with `save=false`.
///   3. Preview + Save / Save as draft / Cancel.
///
/// Errors from the LLM provider surface inline so the user can retry without
/// losing form state.
struct GenerateReportSheet: View {
    let client: DaemonClientProtocol
    let workstreams: [Workstream]
    /// Called after a Save / Save as draft round-trip lands. The returned
    /// `Report` carries server-assigned `id` + `saved_at`.
    let onPersisted: (Report) async -> Void
    let onDismiss: () -> Void

    // MARK: - Form state

    @State private var period: Period = .thisWeek
    @State private var customSince: Date = Calendar.current.date(byAdding: .day, value: -7, to: Date()) ?? Date()
    @State private var customUntil: Date = Date()

    @State private var selectedWorkstreamIDs: Set<String>
    @State private var presets: [ReportPreset] = []
    @State private var selectedPresetID: String? = "executive"
    @State private var freetextOverride: String = ""
    @State private var showFreetext = false

    @State private var providerKind: ProviderKind = .claude
    @State private var modelText: String = ""

    // MARK: - Preview / submission state

    @State private var generating = false
    @State private var savePending = false
    @State private var generatedReport: Report?
    @State private var errorText: String?

    // MARK: - Cancellation

    @State private var generateTask: Task<Void, Never>?
    @State private var saveTask: Task<Void, Never>?

    enum Period: String, CaseIterable, Identifiable {
        case thisWeek = "This week"
        case lastWeek = "Last week"
        case thisMonth = "This month"
        case lastMonth = "Last month"
        case custom = "Custom"
        var id: Self { self }
    }

    enum ProviderKind: String, CaseIterable, Identifiable {
        case claude = "Claude"
        case ollama = "Local (Ollama)"
        var id: Self { self }
        var wireValue: String { self == .claude ? "claude" : "ollama" }
        var defaultModel: String { self == .claude ? "claude-sonnet-4-7" : "qwen3:8b" }
    }

    init(
        client: DaemonClientProtocol,
        workstreams: [Workstream],
        onPersisted: @escaping (Report) async -> Void,
        onDismiss: @escaping () -> Void
    ) {
        self.client = client
        self.workstreams = workstreams
        self.onPersisted = onPersisted
        self.onDismiss = onDismiss
        // Default: all active (non-retired) workstreams selected.
        _selectedWorkstreamIDs = State(initialValue: Set(workstreams.filter {
            $0.status != .retired
        }.map(\.id)))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 16) {
                header
                if generatedReport == nil {
                    formContent
                } else if let r = generatedReport {
                    previewContent(report: r)
                }
                if let errorText {
                    Label(errorText, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
            .padding(20)
            Divider()
            footer
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
        }
        .frame(
            minWidth: generatedReport == nil ? 540 : 720,
            idealWidth: generatedReport == nil ? 600 : 800,
            maxWidth: .infinity,
            minHeight: generatedReport == nil ? 520 : 620,
            maxHeight: .infinity
        )
        .task {
            await loadPresets()
        }
        .onDisappear {
            generateTask?.cancel()
            saveTask?.cancel()
        }
    }

    // MARK: - Header

    @ViewBuilder
    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: "doc.text.image")
                .foregroundStyle(.blue)
            Text(generatedReport == nil ? "Generate update" : "Preview update")
                .font(.headline)
            Spacer()
            if let preset = selectedPresetID, freetextOverride.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text(preset.replacingOccurrences(of: "_", with: " ").capitalized)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            if !freetextOverride.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text("Override")
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(Color.purple.opacity(0.18)))
                    .foregroundStyle(.purple)
            }
        }
    }

    // MARK: - Form

    @ViewBuilder
    private var formContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                periodSection
                workstreamsSection
                audienceSection
                providerSection
            }
        }
    }

    @ViewBuilder
    private var periodSection: some View {
        sectionLabel("Period")
        Picker("Period", selection: $period) {
            ForEach(Period.allCases) { p in
                Text(p.rawValue).tag(p)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()

        if period == .custom {
            HStack(spacing: 12) {
                DatePicker("From", selection: $customSince, displayedComponents: [.date])
                    .datePickerStyle(.field)
                DatePicker("To", selection: $customUntil, in: customSince..., displayedComponents: [.date])
                    .datePickerStyle(.field)
            }
            .font(.caption)
        }
    }

    @ViewBuilder
    private var workstreamsSection: some View {
        sectionLabel("Workstreams")
        if workstreams.isEmpty {
            Text("No active workstreams.")
                .font(.caption)
                .foregroundStyle(.secondary)
        } else {
            FlowLayout(spacing: 6) {
                ForEach(workstreams) { ws in
                    let active = selectedWorkstreamIDs.contains(ws.id)
                    Button {
                        if active {
                            selectedWorkstreamIDs.remove(ws.id)
                        } else {
                            selectedWorkstreamIDs.insert(ws.id)
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: active ? "checkmark.circle.fill" : "circle")
                                .imageScale(.small)
                            Text(ws.title)
                                .font(.caption)
                                .lineLimit(1)
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(
                            Capsule().fill((active ? Color.accentColor : Color.gray).opacity(0.15))
                        )
                        .foregroundStyle(active ? Color.accentColor : Color.primary)
                    }
                    .buttonStyle(.plain)
                    .help(active
                          ? "Exclude \(ws.title) from this update"
                          : "Include \(ws.title) in this update")
                }
            }
        }
    }

    @ViewBuilder
    private var audienceSection: some View {
        sectionLabel("Audience")
        Picker("Audience", selection: $selectedPresetID) {
            ForEach(presets) { preset in
                Text(preset.name).tag(Optional(preset.id))
            }
            if presets.isEmpty {
                Text("Executive").tag(Optional("executive"))
            }
        }
        .pickerStyle(.menu)
        .labelsHidden()

        Button {
            withAnimation { showFreetext.toggle() }
        } label: {
            Label(
                showFreetext ? "Hide custom audience" : "Add custom audience…",
                systemImage: showFreetext ? "chevron.up" : "chevron.down"
            )
        }
        .buttonStyle(.borderless)
        .controlSize(.small)
        .help(showFreetext
              ? "Hide the free-text audience override"
              : "Override the audience preset with free-text instructions")

        if showFreetext {
            ZStack(alignment: .topLeading) {
                if freetextOverride.isEmpty {
                    Text("e.g. Series A investors, focus on traction metrics")
                        .foregroundStyle(.tertiary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 8)
                }
                TextEditor(text: $freetextOverride)
                    .frame(minHeight: 64)
                    .scrollContentBackground(.hidden)
            }
            .padding(4)
            .overlay(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .stroke(Color.gray.opacity(0.25), lineWidth: 1)
            )
            Text("If non-empty, overrides the audience preset's tone.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    @ViewBuilder
    private var providerSection: some View {
        sectionLabel("Provider")
        Picker("Provider", selection: $providerKind) {
            ForEach(ProviderKind.allCases) { p in
                Text(p.rawValue).tag(p)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()

        sectionLabel("Model")
        TextField(providerKind.defaultModel, text: $modelText)
            .textFieldStyle(.roundedBorder)
        Text("Leave blank to use the default for the chosen provider.")
            .font(.caption2)
            .foregroundStyle(.tertiary)
    }

    // MARK: - Preview

    @ViewBuilder
    private func previewContent(report: Report) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Text(report.title)
                    .font(.title3.weight(.semibold))
                HStack(spacing: 8) {
                    AudienceBadge(report: report)
                    Text(report.provider.capitalized)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    if let m = report.model {
                        Text(m)
                            .font(.caption2.monospaced())
                            .foregroundStyle(.tertiary)
                    }
                }
                Divider()
                Text(renderMarkdownLines(report.bodyMD))
                    .textSelection(.enabled)
                    .font(.callout)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.bottom, 8)
        }
        .frame(maxHeight: .infinity)
    }

    // MARK: - Footer

    @ViewBuilder
    private var footer: some View {
        HStack {
            Spacer()
            Button("Cancel", role: .cancel) {
                generateTask?.cancel()
                saveTask?.cancel()
                onDismiss()
            }
            .keyboardShortcut(.cancelAction)
            .disabled(generating || savePending)
            .help("Discard this update and close the sheet")

            if let report = generatedReport {
                Button {
                    saveTask = Task { await persist(generated: report, save: false) }
                } label: {
                    if savePending {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Save as draft")
                    }
                }
                .buttonStyle(.bordered)
                .disabled(savePending)
                .help("Keep this update in the Drafts inbox for later review")

                Button {
                    saveTask = Task { await persist(generated: report, save: true) }
                } label: {
                    if savePending {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Save")
                    }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(savePending)
                .help("Save this update to the Saved reports list")
            } else {
                Button {
                    generateTask = Task { await generate() }
                } label: {
                    if generating {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Generate")
                    }
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .disabled(generating || selectedWorkstreamIDs.isEmpty)
                .help("Run the LLM to generate a draft summary across the selected workstreams")
            }
        }
    }

    // MARK: - Helpers

    @ViewBuilder
    private func sectionLabel(_ text: String) -> some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .textCase(.uppercase)
    }

    private func loadPresets() async {
        if let list = try? await client.listReportPresets() {
            presets = list
            // If executive isn't present, fall back to the first preset.
            if !list.contains(where: { $0.id == selectedPresetID }) {
                selectedPresetID = list.first?.id
            }
        }
    }

    private func generate() async {
        generating = true
        errorText = nil
        defer { generating = false }
        let (since, until) = currentWindow()
        // Persist as a draft on first generate. The expensive half of the
        // call is the LLM round-trip; persisting immediately means Save
        // becomes a single PATCH and Save-as-draft is a zero-RTT no-op.
        let params = GenerateReportParams(
            workstreamIDs: Array(selectedWorkstreamIDs).sorted(),
            since: since,
            until: until,
            audiencePreset: selectedPresetID,
            audienceFreetext: freetextOverride
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .nonEmptyOrNil,
            provider: providerKind.wireValue,
            model: modelText.trimmingCharacters(in: .whitespacesAndNewlines).nonEmptyOrNil,
            save: true,
            title: nil
        )
        do {
            let report = try await client.generateReport(params)
            if Task.isCancelled { return }
            // Daemon returns status=saved when save=true; we want a draft
            // for the preview state, so PATCH back to draft. (Cheap PATCH;
            // happens once per Generate.)
            let asDraft: Report
            if report.status == .saved {
                asDraft = (try? await client.updateReport(
                    id: report.id,
                    fields: ReportUpdateFields(status: .draft)
                )) ?? report
            } else {
                asDraft = report
            }
            generatedReport = asDraft
        } catch {
            if Task.isCancelled { return }
            errorText = (error as? LocalizedError)?.errorDescription
                ?? "Could not generate: \(error)"
        }
    }

    /// Finalise the previewed draft. `save == true` flips status to `.saved`;
    /// `save == false` leaves it as a draft (already persisted by Generate).
    private func persist(generated draft: Report, save: Bool) async {
        savePending = true
        errorText = nil
        defer { savePending = false }
        do {
            let persisted: Report
            if save && draft.status != .saved {
                persisted = try await client.updateReport(
                    id: draft.id,
                    fields: ReportUpdateFields(status: .saved)
                )
            } else {
                persisted = draft
            }
            if Task.isCancelled { return }
            await onPersisted(persisted)
            onDismiss()
        } catch {
            if Task.isCancelled { return }
            errorText = (error as? LocalizedError)?.errorDescription
                ?? "Could not save: \(error)"
        }
    }

    private func currentWindow() -> (Date?, Date?) {
        let cal = Calendar.current
        let now = Date()
        switch period {
        case .thisWeek:
            let since = cal.date(byAdding: .day, value: -7, to: now)
            return (since, now)
        case .lastWeek:
            let until = cal.date(byAdding: .day, value: -7, to: now)
            let since = cal.date(byAdding: .day, value: -14, to: now)
            return (since, until)
        case .thisMonth:
            let since = cal.date(byAdding: .day, value: -30, to: now)
            return (since, now)
        case .lastMonth:
            let until = cal.date(byAdding: .day, value: -30, to: now)
            let since = cal.date(byAdding: .day, value: -60, to: now)
            return (since, until)
        case .custom:
            return (customSince, customUntil)
        }
    }
}

// MARK: - Helpers

private extension String {
    /// `nil` when self is empty, otherwise self. Convenience for
    /// optional-coalescing chains in form-submit code.
    var nonEmptyOrNil: String? { isEmpty ? nil : self }
}

// MARK: - Markdown render helper

/// Line-by-line `AttributedString(markdown:)` (matches `MemoryPaneView` /
/// `HandbookView`). Inline emphasis + links work; block structure does not.
func renderMarkdownLines(_ md: String) -> AttributedString {
    let lines = md.split(separator: "\n", omittingEmptySubsequences: false)
    var result = AttributedString()
    for (idx, line) in lines.enumerated() {
        if let attr = try? AttributedString(
            markdown: String(line),
            options: AttributedString.MarkdownParsingOptions(
                interpretedSyntax: .inlineOnlyPreservingWhitespace
            )
        ) {
            result.append(attr)
        } else {
            result.append(AttributedString(String(line)))
        }
        if idx < lines.count - 1 {
            result.append(AttributedString("\n"))
        }
    }
    return result
}

// MARK: - Tiny flow layout for chip rows

/// Minimal flow layout — wraps children to additional rows when they exceed
/// the container width. Used by the workstream chip toggles.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var totalHeight: CGFloat = 0
        var widest: CGFloat = 0
        for sub in subviews {
            let s = sub.sizeThatFits(.unspecified)
            if x + s.width > maxWidth {
                totalHeight += rowHeight + spacing
                x = 0
                rowHeight = 0
            }
            x += s.width + spacing
            widest = max(widest, x)
            rowHeight = max(rowHeight, s.height)
        }
        totalHeight += rowHeight
        return CGSize(width: min(widest, maxWidth), height: totalHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let maxWidth = bounds.width
        var x: CGFloat = bounds.minX
        var y: CGFloat = bounds.minY
        var rowHeight: CGFloat = 0
        for sub in subviews {
            let s = sub.sizeThatFits(.unspecified)
            if x + s.width - bounds.minX > maxWidth {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            sub.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(s))
            x += s.width + spacing
            rowHeight = max(rowHeight, s.height)
        }
    }
}

// MARK: - Preview

#Preview("GenerateReportSheet (mock)") {
    GenerateReportSheet(
        client: MockDaemonClient(simulatedLatency: .zero),
        workstreams: MockData.workstreams,
        onPersisted: { _ in },
        onDismiss: {}
    )
}

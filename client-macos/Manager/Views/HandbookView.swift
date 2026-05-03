import SwiftUI

/// Team handbook viewer + pending-proposals queue.
///
/// Two sections:
///   - **Pending proposals** — proposals from agents waiting for the manager
///     to Promote (into the handbook) or Dismiss.
///   - **Team handbook** — the read-only Markdown body the agents see at
///     SessionStart.
///
/// Reuses the line-by-line `AttributedString(markdown:)` pattern from
/// `MemoryPaneView` so we render inline emphasis without taking on a
/// dedicated Markdown package.
struct HandbookView: View {
    let client: DaemonClientProtocol

    @State private var handbookRaw: String = ""
    @State private var proposals: [SkillProposal] = []
    @State private var loadingHandbook = true
    @State private var loadingProposals = true
    @State private var pendingActionID: String? = nil
    @State private var actionError: String? = nil

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                proposalsSection
                Divider()
                handbookSection
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .navigationTitle("Team handbook")
        .task {
            await reload()
        }
    }

    // MARK: - Sections

    @ViewBuilder
    private var proposalsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "tray.full")
                Text("Pending proposals")
                    .font(.headline)
                if !proposals.isEmpty {
                    Text("\(proposals.count)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(Color.gray.opacity(0.18)))
                }
                Spacer()
                Button {
                    Task { await reload() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .help("Refresh proposals")
            }

            if loadingProposals && proposals.isEmpty {
                ProgressView().controlSize(.small).padding(.vertical, 8)
            } else if proposals.isEmpty {
                Text("No pending proposals. Agents will surface skills here as they discover them.")
                    .foregroundStyle(.secondary)
                    .font(.callout)
                    .padding(.vertical, 8)
            } else {
                VStack(spacing: 8) {
                    ForEach(proposals) { proposal in
                        ProposalRow(
                            proposal: proposal,
                            isWorking: pendingActionID == proposal.id,
                            onPromote: { await promote(proposal) },
                            onDismiss: { await dismiss(proposal) }
                        )
                    }
                }
            }

            if let actionError {
                Label(actionError, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
    }

    @ViewBuilder
    private var handbookSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "book")
                Text("Team handbook")
                    .font(.headline)
                Spacer()
                Text("read-only")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }

            if loadingHandbook && handbookRaw.isEmpty {
                ProgressView().controlSize(.small).padding(.vertical, 8)
            } else if handbookRaw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text("The handbook is empty. Promote a skill from the queue above to seed it.")
                    .foregroundStyle(.secondary)
                    .font(.callout)
                    .padding(.vertical, 8)
            } else {
                Text(renderMarkdown(handbookRaw))
                    .textSelection(.enabled)
                    .font(.callout)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    // MARK: - Reload + actions

    private func reload() async {
        loadingHandbook = true
        loadingProposals = true
        async let bookFetch: String = (try? await client.getHandbook()) ?? ""
        async let propFetch: [SkillProposal] = (try? await client.listProposedSkills()) ?? []
        let (book, props) = await (bookFetch, propFetch)
        handbookRaw = book
        proposals = props.filter { $0.status == .proposed }
        loadingHandbook = false
        loadingProposals = false
    }

    private func promote(_ proposal: SkillProposal) async {
        pendingActionID = proposal.id
        actionError = nil
        do {
            _ = try await client.promoteSkill(id: proposal.id)
            await reload()
        } catch {
            actionError = (error as? LocalizedError)?.errorDescription
                ?? "Could not promote: \(error)"
        }
        pendingActionID = nil
    }

    private func dismiss(_ proposal: SkillProposal) async {
        pendingActionID = proposal.id
        actionError = nil
        do {
            _ = try await client.dismissSkill(id: proposal.id)
            await reload()
        } catch {
            actionError = (error as? LocalizedError)?.errorDescription
                ?? "Could not dismiss: \(error)"
        }
        pendingActionID = nil
    }

    /// Line-by-line `AttributedString(markdown:)` (matches the
    /// `MemoryPaneView` pattern in `AgentDetailView.swift`) — we don't render
    /// block structure, but inline emphasis and links work.
    private func renderMarkdown(_ md: String) -> AttributedString {
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
}

// MARK: - Proposal row

private struct ProposalRow: View {
    let proposal: SkillProposal
    let isWorking: Bool
    let onPromote: () async -> Void
    let onDismiss: () async -> Void

    private static let timeFormatter: DateFormatter = {
        let df = DateFormatter()
        df.dateFormat = "MMM d, HH:mm"
        return df
    }()

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(proposal.title)
                    .font(.callout.weight(.semibold))
                Spacer(minLength: 8)
                Text(Self.timeFormatter.string(from: proposal.proposedAt))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.tertiary)
            }
            Text(proposal.body)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(4)
            HStack(spacing: 8) {
                Image(systemName: "arrow.up.forward.app")
                    .imageScale(.small)
                    .foregroundStyle(.tertiary)
                Text("from \(proposal.workstreamID)")
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tertiary)
                if let dec = proposal.sourceDecisionID {
                    Text("/ \(dec)")
                        .font(.caption2.monospaced())
                        .foregroundStyle(.tertiary)
                }
                Spacer()
                if isWorking {
                    ProgressView().controlSize(.small)
                } else {
                    Button("Dismiss") {
                        Task { await onDismiss() }
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .help("Reject this proposal — it will not be added to the team handbook")
                    Button("Promote") {
                        Task { await onPromote() }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .help("Add this skill to the team handbook so every agent sees it at SessionStart (Protocol broadcast)")
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color(nsColor: .controlBackgroundColor))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(Color.gray.opacity(0.18), lineWidth: 1)
        )
    }
}

// MARK: - Promote skill sheet

/// Sheet for promoting a decision into a handbook skill. Pre-filled with the
/// decision's choice + rationale; the user can edit before saving. Mirrors
/// the `InterventionPanel` toast pattern (~1.2s green confirmation, then
/// auto-dismiss).
struct PromoteSkillSheet: View {
    let workstream: Workstream
    let sourceDecisionID: String?
    let initialTitle: String
    let initialBody: String
    let client: DaemonClientProtocol
    let onSaved: () async -> Void
    let onDismiss: () -> Void

    @State private var title: String
    @State private var bodyText: String
    @State private var saving = false
    @State private var errorText: String?
    @State private var savedMessage: String?

    init(
        workstream: Workstream,
        sourceDecisionID: String?,
        initialTitle: String,
        initialBody: String,
        client: DaemonClientProtocol,
        onSaved: @escaping () async -> Void,
        onDismiss: @escaping () -> Void
    ) {
        self.workstream = workstream
        self.sourceDecisionID = sourceDecisionID
        self.initialTitle = initialTitle
        self.initialBody = initialBody
        self.client = client
        self.onSaved = onSaved
        self.onDismiss = onDismiss
        _title = State(initialValue: initialTitle)
        _bodyText = State(initialValue: initialBody)
    }

    private var canSubmit: Bool {
        let trimmedT = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedB = bodyText.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmedT.isEmpty && !trimmedB.isEmpty && !saving && savedMessage == nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Image(systemName: "books.vertical.fill")
                    .foregroundStyle(.purple)
                Text("Promote to handbook").font(.headline)
                Spacer()
                Text(workstream.id)
                    .font(.caption.monospaced())
                    .foregroundStyle(.tertiary)
            }
            Text("Save this as a team skill. All agents will see it at SessionStart.")
                .font(.caption)
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 4) {
                Text("Title")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)
                TextField("Skill title", text: $title)
                    .textFieldStyle(.roundedBorder)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("Body")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)
                TextEditor(text: $bodyText)
                    .frame(minHeight: 140)
                    .padding(4)
                    .scrollContentBackground(.hidden)
                    .overlay(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .stroke(Color.gray.opacity(0.25), lineWidth: 1)
                    )
            }

            if let dec = sourceDecisionID {
                Text("Source: \(workstream.id) / \(dec)")
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tertiary)
            }

            if let errorText {
                Label(errorText, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            if let savedMessage {
                Label(savedMessage, systemImage: "checkmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.green)
            }

            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { onDismiss() }
                    .keyboardShortcut(.cancelAction)
                    .disabled(savedMessage != nil)
                    .help("Discard this skill draft and close the panel")
                Button {
                    Task { await save() }
                } label: {
                    if saving {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Save to handbook")
                    }
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .disabled(!canSubmit)
                .help("Append this skill to the team handbook so every agent picks it up at SessionStart")
            }
        }
        .padding(20)
        .frame(minWidth: 480, idealWidth: 540, maxWidth: .infinity, minHeight: 360, maxHeight: .infinity)
    }

    private func save() async {
        saving = true
        errorText = nil
        do {
            try await client.appendHandbookSkill(
                title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                body: bodyText.trimmingCharacters(in: .whitespacesAndNewlines),
                sourceWorkstreamID: workstream.id,
                sourceDecisionID: sourceDecisionID
            )
            saving = false
            savedMessage = "Promoted to handbook"
            try? await Task.sleep(for: .milliseconds(1200))
            await onSaved()
            onDismiss()
        } catch {
            saving = false
            errorText = (error as? LocalizedError)?.errorDescription
                ?? "Could not promote: \(error)"
        }
    }
}

#Preview("HandbookView") {
    HandbookView(client: MockDaemonClient(simulatedLatency: .zero))
        .frame(width: 720, height: 600)
}

#Preview("PromoteSkillSheet") {
    let ws = MockData.workstreams.first(where: { $0.id == "frontend-refactor" })
        ?? MockData.workstreams[0]
    return PromoteSkillSheet(
        workstream: ws,
        sourceDecisionID: "dec_12",
        initialTitle: "per-feature query modules",
        initialBody: "matches existing API package structure; easier code review per feature owner",
        client: MockDaemonClient(simulatedLatency: .zero),
        onSaved: {},
        onDismiss: {}
    )
    .frame(width: 540)
}

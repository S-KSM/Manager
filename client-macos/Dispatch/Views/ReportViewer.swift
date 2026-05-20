import SwiftUI
import AppKit

/// Read / edit / save / delete viewer for a single `Report`.
///
/// Toolbar actions:
///   - **Edit** → toggles the body into a `TextEditor`. Save / Cancel.
///   - **Save** → flips status to `.saved` (PATCH). No-op when already saved.
///   - **Copy MD** → places `body_md` on the system pasteboard.
///   - **Delete** → soft-delete (PATCH status=archived) and dismisses.
struct ReportViewer: View {
    let client: DaemonClientProtocol
    let report: Report
    let onChanged: (Report) async -> Void
    let onDeleted: (Report) async -> Void
    let onDismiss: () -> Void

    @State private var localReport: Report
    @State private var editing = false
    @State private var editingBody: String = ""
    @State private var editingTitle: String = ""
    @State private var pendingAction: PendingAction?
    @State private var actionError: String?
    @State private var savedFlash: String?
    @State private var actionTask: Task<Void, Never>?

    private enum PendingAction: Hashable {
        case savingEdit
        case markingSaved
        case deleting
    }

    init(
        client: DaemonClientProtocol,
        report: Report,
        onChanged: @escaping (Report) async -> Void,
        onDeleted: @escaping (Report) async -> Void,
        onDismiss: @escaping () -> Void
    ) {
        self.client = client
        self.report = report
        self.onChanged = onChanged
        self.onDeleted = onDeleted
        self.onDismiss = onDismiss
        _localReport = State(initialValue: report)
        _editingBody = State(initialValue: report.bodyMD)
        _editingTitle = State(initialValue: report.title)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().overlay(Resona.Palette.stone)
            ScrollView {
                if editing {
                    editView
                } else {
                    readView
                }
            }
            if let actionError {
                Label(actionError, systemImage: "exclamationmark.triangle.fill")
                    .font(Resona.Typography.caption)
                    .foregroundStyle(Resona.Palette.coral)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 6)
            }
            if let savedFlash {
                Label(savedFlash, systemImage: "checkmark.circle.fill")
                    .font(Resona.Typography.caption)
                    .foregroundStyle(Resona.Palette.success)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 6)
            }
        }
        .background(Resona.Gradients.appBackground.ignoresSafeArea())
        .frame(minWidth: 560, idealWidth: 760, maxWidth: .infinity, minHeight: 480, maxHeight: .infinity)
        .onDisappear {
            actionTask?.cancel()
        }
    }

    // MARK: - Header

    private static let dateFmt: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .short
        return f
    }()

    private static let periodFmt: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM d"
        return f
    }()

    @ViewBuilder
    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                if editing {
                    TextField("Title", text: $editingTitle)
                        .textFieldStyle(.roundedBorder)
                        .font(Resona.Typography.title)
                } else {
                    Text(localReport.title)
                        .font(Resona.Typography.title)
                }
                Spacer()
                Button("Done", action: onDismiss)
                    .keyboardShortcut(.cancelAction)
                    .controlSize(.small)
                    .help("Close this update")
            }
            HStack(spacing: 8) {
                AudienceBadge(report: localReport)
                Text(Self.dateFmt.string(from: localReport.generatedAt))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(Resona.Palette.inkFaint)
                Text(periodSummary)
                    .font(.caption2)
                    .foregroundStyle(Resona.Palette.inkSoft)
                Text(localReport.provider.capitalized)
                    .font(.caption2)
                    .foregroundStyle(Resona.Palette.inkSoft)
                if let model = localReport.model {
                    Text(model)
                        .font(.caption2.monospaced())
                        .foregroundStyle(Resona.Palette.inkFaint)
                }
                Spacer()
                statusBadge
            }
            actionRow
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
    }

    @ViewBuilder
    private var statusBadge: some View {
        Text(localReport.status.rawValue.capitalized)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(statusTint.opacity(0.18)))
            .foregroundStyle(statusTint)
    }

    private var statusTint: Color {
        switch localReport.status {
        case .draft:    return Resona.Palette.coral
        case .saved:    return Resona.Palette.success
        case .archived: return Resona.Palette.stone
        }
    }

    @ViewBuilder
    private var actionRow: some View {
        HStack(spacing: 8) {
            if editing {
                Button("Cancel edit") {
                    editing = false
                    editingBody = localReport.bodyMD
                    editingTitle = localReport.title
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(pendingAction != nil)
                .help("Discard your edits and return to the read view")

                Button {
                    actionTask = Task { await saveEdits() }
                } label: {
                    if pendingAction == .savingEdit {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("Save edits", systemImage: "tray.and.arrow.down")
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(pendingAction != nil)
                .help("Persist your edits to this update")
            } else {
                Button {
                    editing = true
                    editingBody = localReport.bodyMD
                    editingTitle = localReport.title
                } label: {
                    Label("Edit", systemImage: "pencil")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(pendingAction != nil)
                .help("Edit the title and body of this update")

                Button {
                    actionTask = Task { await markSaved() }
                } label: {
                    if pendingAction == .markingSaved {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("Save", systemImage: "checkmark.seal")
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(pendingAction != nil || localReport.status == .saved)
                .help("Promote this draft into the Saved reports list")

                Button {
                    copyMarkdown()
                } label: {
                    Label("Copy MD", systemImage: "doc.on.clipboard")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(pendingAction != nil)
                .help("Copy the Markdown body to the clipboard")

                Spacer(minLength: 0)

                Button(role: .destructive) {
                    actionTask = Task { await delete() }
                } label: {
                    if pendingAction == .deleting {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("Delete", systemImage: "trash")
                    }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(pendingAction != nil)
                .help("Archive this update — it stops appearing in Drafts and Saved")
            }
        }
    }

    private var periodSummary: String {
        "\(Self.periodFmt.string(from: localReport.periodSince)) – \(Self.periodFmt.string(from: localReport.periodUntil))"
    }

    // MARK: - Read / edit body

    @ViewBuilder
    private var readView: some View {
        Text(renderMarkdownLines(localReport.bodyMD))
            .textSelection(.enabled)
            .font(.callout)
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var editView: some View {
        TextEditor(text: $editingBody)
            .font(.system(.callout, design: .monospaced))
            .frame(minHeight: 360)
            .padding(8)
            .scrollContentBackground(.hidden)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Resona.Palette.parchment)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(Resona.Palette.stone, lineWidth: 1)
            )
            .padding(18)
    }

    // MARK: - Actions

    private func saveEdits() async {
        pendingAction = .savingEdit
        actionError = nil
        defer { pendingAction = nil }
        let trimmedTitle = editingTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        let fields = ReportUpdateFields(
            title: trimmedTitle.isEmpty ? nil : trimmedTitle,
            bodyMD: editingBody,
            status: nil
        )
        do {
            let updated = try await client.updateReport(id: localReport.id, fields: fields)
            if Task.isCancelled { return }
            localReport = updated
            editing = false
            await onChanged(updated)
            flash("Saved")
        } catch {
            if Task.isCancelled { return }
            actionError = (error as? LocalizedError)?.errorDescription
                ?? "Could not save edits: \(error)"
        }
    }

    private func markSaved() async {
        pendingAction = .markingSaved
        actionError = nil
        defer { pendingAction = nil }
        do {
            let updated = try await client.updateReport(
                id: localReport.id,
                fields: ReportUpdateFields(status: .saved)
            )
            if Task.isCancelled { return }
            localReport = updated
            await onChanged(updated)
            flash("Marked saved")
        } catch {
            if Task.isCancelled { return }
            actionError = (error as? LocalizedError)?.errorDescription
                ?? "Could not save: \(error)"
        }
    }

    private func delete() async {
        pendingAction = .deleting
        actionError = nil
        defer { pendingAction = nil }
        do {
            let archived = try await client.deleteReport(id: localReport.id)
            if Task.isCancelled { return }
            await onDeleted(archived)
            onDismiss()
        } catch {
            if Task.isCancelled { return }
            actionError = (error as? LocalizedError)?.errorDescription
                ?? "Could not delete: \(error)"
        }
    }

    private func copyMarkdown() {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(localReport.bodyMD, forType: .string)
        flash("Copied Markdown")
    }

    private func flash(_ msg: String) {
        savedFlash = msg
        Task {
            try? await Task.sleep(for: .milliseconds(1200))
            if savedFlash == msg { savedFlash = nil }
        }
    }
}

// MARK: - Preview

#Preview("ReportViewer (mock saved)") {
    let mock = MockDaemonClient(simulatedLatency: .zero)
    let report = MockData.reports.first(where: { $0.status == .saved })
        ?? MockData.reports[0]
    return ReportViewer(
        client: mock,
        report: report,
        onChanged: { _ in },
        onDeleted: { _ in },
        onDismiss: {}
    )
}

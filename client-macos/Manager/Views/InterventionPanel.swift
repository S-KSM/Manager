import SwiftUI

/// Human-driven intervention surface for a single workstream.
///
/// Three modes (see docs/ARCHITECTURE.md > "Intervention semantics"):
///   - **Nudge**: advisory note injected at next turn.
///   - **Redirect**: hard course-correct.
///   - **Rollback**: frame as "we are back at decision X — reconsider".
///
/// Picks one of three buttons → opens a modal sheet → POSTs to the daemon
/// via `DaemonClientProtocol.postIntervention`. Rollback additionally
/// requires picking a prior `decision` event from `events`.
///
/// On success, dismisses and calls `onSent` so the parent can reload — the
/// resulting `intervention_delivered` event will land on the timeline once
/// the agent's hook acks.
struct InterventionPanel: View {
    let workstream: Workstream
    let events: [Event]
    let client: DaemonClientProtocol
    let onSent: () async -> Void

    @State private var activeMode: Mode?

    enum Mode: Identifiable, Hashable {
        case nudge
        case redirect
        case rollback
        var id: Self { self }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Image(systemName: "wand.and.stars")
                    .foregroundStyle(.purple)
                Text("Intervene")
                    .font(.headline)
                Spacer()
                Text(workstream.id)
                    .font(.caption.monospaced())
                    .foregroundStyle(.tertiary)
            }
            Text("Steer this workstream. The agent picks up your message on its next turn.")
                .font(.caption)
                .foregroundStyle(.secondary)

            HStack(spacing: 10) {
                modeButton(
                    mode: .nudge,
                    title: "Nudge",
                    systemImage: "bubble.left",
                    tint: .blue,
                    help: "Advisory note. Agent may or may not change course."
                )
                modeButton(
                    mode: .redirect,
                    title: "Redirect",
                    systemImage: "arrow.uturn.right",
                    tint: .orange,
                    help: "Hard course-correct. Agent must respond."
                )
                modeButton(
                    mode: .rollback,
                    title: "Rollback",
                    systemImage: "arrow.uturn.backward.circle",
                    tint: .pink,
                    help: "Re-decide from a prior decision branch."
                )
            }
        }
        .padding(20)
        .frame(minWidth: 460)
        .sheet(item: $activeMode) { mode in
            switch mode {
            case .nudge:
                MessageInterventionSheet(
                    title: "Send a nudge",
                    subtitle: "An advisory note. The agent will see it on its next turn.",
                    placeholder: "e.g. consider whether react-query handles your offline case",
                    sendLabel: "Send nudge",
                    workstream: workstream,
                    client: client,
                    kind: .nudge,
                    onSent: onSent,
                    onDismiss: { activeMode = nil }
                )
            case .redirect:
                MessageInterventionSheet(
                    title: "Redirect the agent",
                    subtitle: "A hard course-correct. The agent must address this before continuing.",
                    placeholder: "e.g. stop the migration; first fix the failing billing tests",
                    sendLabel: "Send redirect",
                    workstream: workstream,
                    client: client,
                    kind: .redirect,
                    onSent: onSent,
                    onDismiss: { activeMode = nil }
                )
            case .rollback:
                RollbackInterventionSheet(
                    workstream: workstream,
                    decisions: events.filter {
                        if case .decision = $0.payload { return true } else { return false }
                    },
                    client: client,
                    onSent: onSent,
                    onDismiss: { activeMode = nil }
                )
            }
        }
    }

    @ViewBuilder
    private func modeButton(
        mode: Mode,
        title: String,
        systemImage: String,
        tint: Color,
        help: String
    ) -> some View {
        Button {
            activeMode = mode
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Image(systemName: systemImage)
                        .foregroundStyle(tint)
                    Text(title).font(.callout.weight(.semibold))
                }
                Text(help)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.leading)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(tint.opacity(0.10))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(tint.opacity(0.25), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Nudge / redirect message sheet

private struct MessageInterventionSheet: View {
    let title: String
    let subtitle: String
    let placeholder: String
    let sendLabel: String
    let workstream: Workstream
    let client: DaemonClientProtocol
    let kind: InterventionKind
    let onSent: () async -> Void
    let onDismiss: () -> Void

    @State private var message: String = ""
    @State private var sending = false
    @State private var errorText: String?
    @State private var sentMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Image(systemName: kind == .nudge ? "bubble.left" : "arrow.uturn.right")
                    .foregroundStyle(kind == .nudge ? .blue : .orange)
                Text(title).font(.headline)
                Spacer()
            }
            Text(subtitle)
                .font(.caption)
                .foregroundStyle(.secondary)

            ZStack(alignment: .topLeading) {
                if message.isEmpty {
                    Text(placeholder)
                        .foregroundStyle(.tertiary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 8)
                }
                TextEditor(text: $message)
                    .frame(minHeight: 120)
                    .scrollContentBackground(.hidden)
            }
            .padding(4)
            .overlay(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .stroke(Color.gray.opacity(0.25), lineWidth: 1)
            )

            if let errorText {
                Label(errorText, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            if let sentMessage {
                Label(sentMessage, systemImage: "checkmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.green)
            }

            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { onDismiss() }
                    .keyboardShortcut(.cancelAction)
                    .disabled(sentMessage != nil)
                Button {
                    Task { await send() }
                } label: {
                    if sending {
                        ProgressView().controlSize(.small)
                    } else {
                        Text(sendLabel)
                    }
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .disabled(sending
                          || sentMessage != nil
                          || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(20)
        .frame(minWidth: 460, idealWidth: 520, minHeight: 260)
    }

    private func send() async {
        sending = true
        errorText = nil
        do {
            _ = try await client.postIntervention(
                workstreamID: workstream.id,
                kind: kind,
                message: message,
                rollbackToDecisionID: nil
            )
            sending = false
            sentMessage = (kind == .nudge) ? "Nudge queued" : "Redirect queued"
            try? await Task.sleep(for: .milliseconds(1200))
            await onSent()
            onDismiss()
        } catch {
            sending = false
            errorText = (error as? LocalizedError)?.errorDescription ?? "Could not send: \(error)"
        }
    }
}

// MARK: - Rollback sheet

private struct RollbackInterventionSheet: View {
    let workstream: Workstream
    let decisions: [Event]
    let client: DaemonClientProtocol
    let onSent: () async -> Void
    let onDismiss: () -> Void

    @State private var pickedDecisionID: String?
    @State private var hint: String = ""
    @State private var sending = false
    @State private var errorText: String?
    @State private var sentMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Image(systemName: "arrow.uturn.backward.circle")
                    .foregroundStyle(.pink)
                Text("Roll back to a prior decision")
                    .font(.headline)
                Spacer()
            }
            Text("The agent will be told it is back at this decision branch and asked to reconsider.")
                .font(.caption)
                .foregroundStyle(.secondary)

            if decisions.isEmpty {
                Text("No decisions yet on this workstream — nothing to roll back to.")
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 12)
            } else {
                List(selection: $pickedDecisionID) {
                    ForEach(decisions) { event in
                        decisionRow(event)
                            .tag(event.id)
                    }
                }
                .listStyle(.plain)
                .frame(minHeight: 180, maxHeight: 240)
                .overlay(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .stroke(Color.gray.opacity(0.20), lineWidth: 1)
                )
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("Optional hint (what to consider this time around)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                ZStack(alignment: .topLeading) {
                    if hint.isEmpty {
                        Text("e.g. revisit the offline-cache trade-off; we want SWR after all")
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 8)
                    }
                    TextEditor(text: $hint)
                        .frame(minHeight: 70)
                        .scrollContentBackground(.hidden)
                }
                .padding(4)
                .overlay(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .stroke(Color.gray.opacity(0.25), lineWidth: 1)
                )
            }

            if let errorText {
                Label(errorText, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            if let sentMessage {
                Label(sentMessage, systemImage: "checkmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.green)
            }

            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { onDismiss() }
                    .keyboardShortcut(.cancelAction)
                    .disabled(sentMessage != nil)
                Button {
                    Task { await send() }
                } label: {
                    if sending {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Roll back to this decision")
                    }
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .disabled(sending
                          || sentMessage != nil
                          || pickedDecisionID == nil
                          || decisions.isEmpty)
            }
        }
        .padding(20)
        .frame(minWidth: 520, idealWidth: 600, minHeight: 440)
    }

    @ViewBuilder
    private func decisionRow(_ event: Event) -> some View {
        if case .decision(let d) = event.payload {
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline) {
                    Text(d.choice)
                        .font(.callout.weight(.medium))
                    Spacer(minLength: 8)
                    Text(event.id)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.tertiary)
                }
                Text(d.rationale)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            .padding(.vertical, 2)
        }
    }

    private func send() async {
        guard let decisionID = pickedDecisionID else { return }
        sending = true
        errorText = nil
        do {
            _ = try await client.postIntervention(
                workstreamID: workstream.id,
                kind: .rollback,
                message: hint,            // empty string is fine — payload encodes nil
                rollbackToDecisionID: decisionID
            )
            sending = false
            sentMessage = "Rollback to \(decisionID) queued"
            try? await Task.sleep(for: .milliseconds(1200))
            await onSent()
            onDismiss()
        } catch {
            sending = false
            errorText = (error as? LocalizedError)?.errorDescription ?? "Could not send: \(error)"
        }
    }
}

// MARK: - Preview

#Preview("InterventionPanel — frontend-refactor (rollback exercises decision tree)") {
    let ws = MockData.workstreams.first(where: { $0.id == "frontend-refactor" })
        ?? MockData.workstreams[0]
    let events = MockData.eventsByWorkstream["frontend-refactor"] ?? []
    return InterventionPanel(
        workstream: ws,
        events: events,
        client: MockDaemonClient(simulatedLatency: .zero),
        onSent: {}
    )
    .frame(width: 520)
}

/// Preview of the toast confirmation state. Tap "Send nudge" with any
/// non-empty body to see the green "Nudge queued" label appear before the
/// sheet auto-dismisses ~1.2s later.
#Preview("InterventionPanel — nudge sheet (toast)") {
    let ws = MockData.workstreams.first(where: { $0.id == "frontend-refactor" })
        ?? MockData.workstreams[0]
    return InterventionPanel(
        workstream: ws,
        events: [],
        client: MockDaemonClient(simulatedLatency: .zero),
        onSent: {}
    )
    .frame(width: 520)
}

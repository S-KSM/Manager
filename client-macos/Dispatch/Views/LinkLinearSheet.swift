import SwiftUI

/// Modal that captures a Linear identifier (e.g. `ENG-123`) and links it to
/// the current workstream. Surfaces 503 (no key) / 400 (unknown identifier)
/// errors inline rather than dumping a generic alert.
struct LinkLinearSheet: View {
    let workstream: Workstream
    let client: DaemonClientProtocol
    /// Called with the persisted link after a successful PUT so the parent
    /// can update its chip state without a separate re-fetch.
    let onLinked: (WorkstreamLink) -> Void
    let onCancel: () -> Void

    @State private var identifier: String = ""
    @State private var submitting = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                Image(systemName: "link")
                    .imageScale(.large)
                    .foregroundStyle(Resona.Palette.lavender)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Link to a Linear issue")
                        .font(Resona.Typography.title)
                    Text("Workstream: \(workstream.title)")
                        .font(Resona.Typography.caption)
                        .foregroundStyle(Resona.Palette.inkSoft)
                        .lineLimit(1)
                }
            }
            Divider().overlay(Resona.Palette.stone)
            VStack(alignment: .leading, spacing: 6) {
                ResonaEyebrow(text: "Issue identifier")
                TextField("ENG-123", text: $identifier)
                    .textFieldStyle(.roundedBorder)
                    .disableAutocorrection(true)
                    .onSubmit { Task { await submit() } }
                Text("Use the identifier shown on the Linear issue page (project key + number).")
                    .font(.caption2)
                    .foregroundStyle(Resona.Palette.inkFaint)
            }
            if let error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(Resona.Typography.caption)
                    .foregroundStyle(Resona.Palette.coral)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Spacer()
                Button("Cancel") { onCancel() }
                    .keyboardShortcut(.cancelAction)
                    .disabled(submitting)
                Button {
                    Task { await submit() }
                } label: {
                    if submitting {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Link")
                    }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(submitting || trimmedIdentifier.isEmpty)
                .help("Resolve this identifier on Linear and persist the link")
            }
        }
        .padding(20)
        .background(Resona.Gradients.appBackground.ignoresSafeArea())
        .frame(width: 460)
    }

    private var trimmedIdentifier: String {
        identifier.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func submit() async {
        let id = trimmedIdentifier
        guard !id.isEmpty else { return }
        submitting = true
        error = nil
        defer { submitting = false }
        do {
            let link = try await client.linkWorkstream(
                workstreamID: workstream.id,
                trackerKind: "linear",
                issueIdentifier: id
            )
            onLinked(link)
        } catch let DaemonError.badResponse(code, _) where code == 503 {
            error = "Linear API key isn't configured. Open Settings → Providers to set it."
        } catch let DaemonError.badResponse(code, _) where code == 400 {
            error = "Linear couldn't find issue \(id). Double-check the identifier."
        } catch let err {
            error = (err as? LocalizedError)?.errorDescription
                ?? "Couldn't link: \(err.localizedDescription)"
        }
    }
}

#if DEBUG
#Preview("LinkLinearSheet") {
    LinkLinearSheet(
        workstream: MockData.workstreams[0],
        client: MockDaemonClient(simulatedLatency: .zero),
        onLinked: { _ in },
        onCancel: {}
    )
}
#endif

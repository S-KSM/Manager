import SwiftUI

/// Sheet for creating a new workstream from the sidebar `+` button.
///
/// Two text fields — id slug + title — plus Create / Cancel. On Create we call
/// `client.createWorkstream(...)`, signal the parent via `onCreated` so it can
/// refresh its workstream list, then dismiss.
struct NewWorkstreamSheet: View {
    let client: DaemonClientProtocol
    let onCreated: (Workstream) async -> Void
    let onDismiss: () -> Void

    @State private var slug: String = ""
    @State private var title: String = ""
    @State private var creating = false
    @State private var errorText: String?

    private var trimmedSlug: String {
        slug.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private var trimmedTitle: String {
        title.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private var slugLooksValid: Bool {
        // Lowercase, dashes, digits — same shape as the existing workstream ids
        // (frontend-refactor, auth-hardening, ...). Keep it permissive: an
        // empty string is invalid; otherwise just check there are no spaces.
        guard !trimmedSlug.isEmpty else { return false }
        return !trimmedSlug.contains(" ")
    }
    private var canSubmit: Bool {
        slugLooksValid && !trimmedTitle.isEmpty && !creating
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Image(systemName: "plus.circle.fill")
                    .foregroundStyle(.accent)
                Text("New workstream").font(Resona.Typography.headline)
                Spacer()
            }
            Text("Spin up a fresh workstream. The id is a slug used in URLs and on disk; the title is for humans.")
                .font(Resona.Typography.caption)
                .foregroundStyle(Resona.Palette.inkSoft)

            VStack(alignment: .leading, spacing: 4) {
                ResonaEyebrow(text: "Id slug")
                TextField("e.g. billing-migration", text: $slug)
                    .textFieldStyle(.roundedBorder)
                    .disableAutocorrection(true)
                    .onChange(of: slug) { _, new in
                        // Soft-canonicalise as the user types: lowercase + spaces→dashes.
                        let lowered = new.lowercased().replacingOccurrences(of: " ", with: "-")
                        if lowered != new { slug = lowered }
                    }
                if !trimmedSlug.isEmpty && !slugLooksValid {
                    Text("Slug can't contain spaces.")
                        .font(.caption2)
                        .foregroundStyle(Resona.Palette.coral)
                }
            }

            VStack(alignment: .leading, spacing: 4) {
                ResonaEyebrow(text: "Title")
                TextField("e.g. Billing migration to Stripe", text: $title)
                    .textFieldStyle(.roundedBorder)
            }

            if let errorText {
                Label(errorText, systemImage: "exclamationmark.triangle.fill")
                    .font(Resona.Typography.caption)
                    .foregroundStyle(Resona.Palette.coral)
            }

            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { onDismiss() }
                    .keyboardShortcut(.cancelAction)
                    .help("Discard this workstream draft and close the sheet")
                Button {
                    Task { await create() }
                } label: {
                    if creating {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Create")
                    }
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .disabled(!canSubmit)
                .help("Create this workstream so the agent radar starts tracking it")
            }
        }
        .padding(20)
        .background(Resona.Gradients.appBackground.ignoresSafeArea())
        .frame(minWidth: 420, idealWidth: 480, maxWidth: .infinity, minHeight: 240, maxHeight: .infinity)
    }

    private func create() async {
        creating = true
        errorText = nil
        do {
            let ws = try await client.createWorkstream(
                id: trimmedSlug,
                title: trimmedTitle
            )
            await onCreated(ws)
            creating = false
            onDismiss()
        } catch {
            creating = false
            errorText = (error as? LocalizedError)?.errorDescription
                ?? "Could not create workstream: \(error)"
        }
    }
}

#Preview("NewWorkstreamSheet") {
    NewWorkstreamSheet(
        client: MockDaemonClient(simulatedLatency: .zero),
        onCreated: { _ in },
        onDismiss: {}
    )
    .frame(width: 480)
}

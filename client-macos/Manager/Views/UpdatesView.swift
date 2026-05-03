import SwiftUI

/// Updates surface (see docs/ARCHITECTURE.md > "Reports" / Track B v1.1).
///
/// Two sections backed by `client.listReports(status:)`:
///   - **Drafts** (status=draft) — typically scheduler output awaiting review.
///   - **Saved reports** (status=saved) — user-kept summaries.
///
/// Toolbar:
///   - "Scheduler…" gear — opens `SchedulerSettings`.
///   - "+ New report" — opens `GenerateReportSheet`.
///
/// Refreshes on `.task` (cancels on disappear) and after every generate / save
/// / delete round-trip.
struct UpdatesView: View {
    let client: DaemonClientProtocol
    let workstreams: [Workstream]

    @State private var drafts: [Report] = []
    @State private var saved: [Report] = []
    @State private var loading = true
    @State private var loadError: String?

    @State private var showGenerateSheet = false
    @State private var showSchedulerSheet = false
    @State private var openReport: Report?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header
                if loading && drafts.isEmpty && saved.isEmpty {
                    HStack {
                        Spacer()
                        ProgressView().controlSize(.small)
                        Spacer()
                    }
                    .padding(.vertical, 24)
                } else {
                    section(
                        title: "Drafts",
                        systemImage: "tray",
                        empty: "No drafts. Scheduled jobs land here for review.",
                        reports: drafts
                    )
                    Divider()
                    section(
                        title: "Saved reports",
                        systemImage: "tray.full",
                        empty: "No saved reports yet. Generate one to start.",
                        reports: saved
                    )
                }
                if let loadError {
                    Label(loadError, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .navigationTitle("Updates")
        .task {
            await reload()
        }
        .sheet(isPresented: $showGenerateSheet) {
            GenerateReportSheet(
                client: client,
                workstreams: workstreams.filter { $0.status != .retired },
                onPersisted: { _ in
                    await reload()
                },
                onDismiss: { showGenerateSheet = false }
            )
        }
        .sheet(isPresented: $showSchedulerSheet) {
            SchedulerSettings(
                client: client,
                onDismiss: { showSchedulerSheet = false }
            )
        }
        .sheet(item: $openReport) { report in
            ReportViewer(
                client: client,
                report: report,
                onChanged: { _ in
                    await reload()
                },
                onDeleted: { _ in
                    await reload()
                },
                onDismiss: { openReport = nil }
            )
        }
    }

    // MARK: - Sections

    @ViewBuilder
    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Updates")
                    .font(.title2.weight(.semibold))
                Text("Generate, save, and schedule team summaries.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                showSchedulerSheet = true
            } label: {
                Label("Scheduler…", systemImage: "gearshape")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .help("Configure weekly + monthly draft generation.")

            Button {
                showGenerateSheet = true
            } label: {
                Label("New report", systemImage: "plus")
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
        }
    }

    @ViewBuilder
    private func section(title: String, systemImage: String, empty: String, reports: [Report]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: systemImage)
                Text(title).font(.headline)
                if !reports.isEmpty {
                    Text("\(reports.count)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(Color.gray.opacity(0.18)))
                }
            }
            if reports.isEmpty {
                Text(empty)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 6)
            } else {
                VStack(spacing: 8) {
                    ForEach(reports) { report in
                        Button {
                            openReport = report
                        } label: {
                            ReportRow(report: report)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    // MARK: - Reload

    private func reload() async {
        loading = true
        loadError = nil
        async let draftFetch: [Report] = (try? await client.listReports(status: .draft)) ?? []
        async let savedFetch: [Report] = (try? await client.listReports(status: .saved)) ?? []
        let (d, s) = await (draftFetch, savedFetch)
        drafts = d.sorted { $0.generatedAt > $1.generatedAt }
        saved = s.sorted { ($0.savedAt ?? $0.generatedAt) > ($1.savedAt ?? $1.generatedAt) }
        loading = false
    }
}

// MARK: - Row

private struct ReportRow: View {
    let report: Report

    private static let dateFmt: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .short
        return f
    }()

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                Text(report.title)
                    .font(.callout.weight(.semibold))
                    .lineLimit(1)
                HStack(spacing: 6) {
                    AudienceBadge(report: report)
                    Text(Self.dateFmt.string(from: report.generatedAt))
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.tertiary)
                    if !report.workstreamIDs.isEmpty {
                        Text("· \(report.workstreamIDs.count) workstream\(report.workstreamIDs.count == 1 ? "" : "s")")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
            Spacer()
            Image(systemName: "chevron.right")
                .imageScale(.small)
                .foregroundStyle(.tertiary)
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
        .contentShape(Rectangle())
    }
}

/// Compact "Executive" / "Custom" / preset id badge. Defensive about
/// `audience_preset` being null on free-text-only saved reports.
struct AudienceBadge: View {
    let report: Report

    var body: some View {
        let label = audienceLabel
        let isOverride = (report.audienceFreetext?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false)
        HStack(spacing: 4) {
            Image(systemName: isOverride ? "person.crop.circle.badge.questionmark" : "person.crop.circle")
                .imageScale(.small)
            Text(label)
                .font(.caption2.weight(.medium))
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(
            Capsule().fill((isOverride ? Color.purple : Color.blue).opacity(0.12))
        )
        .foregroundStyle(isOverride ? Color.purple : Color.blue)
    }

    private var audienceLabel: String {
        if let freetext = report.audienceFreetext?.trimmingCharacters(in: .whitespacesAndNewlines),
           !freetext.isEmpty {
            return "Custom"
        }
        switch report.audiencePreset {
        case "executive":         return "Executive"
        case "business_partner":  return "Business partner"
        case "engineer_peer":     return "Engineer peer"
        case "sponsor":           return "Sponsor"
        case let other?:          return other.replacingOccurrences(of: "_", with: " ").capitalized
        case nil:                 return "Audience: —"
        }
    }
}

// MARK: - Preview

#Preview("UpdatesView (mock)") {
    UpdatesView(
        client: MockDaemonClient(simulatedLatency: .zero),
        workstreams: MockData.workstreams
    )
    .frame(width: 760, height: 640)
}

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
                } else if drafts.isEmpty && saved.isEmpty {
                    emptyStateCTA
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
                        .font(Resona.Typography.caption)
                        .foregroundStyle(Resona.Palette.coral)
                }
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
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
        // ViewThatFits collapses the action buttons under the title when the
        // detail pane is narrower than ~520pt — otherwise the "+ New report"
        // button gets clipped, which made the surface look broken on first
        // open.
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline) {
                titleBlock
                Spacer()
                actionButtons
            }
            VStack(alignment: .leading, spacing: 10) {
                titleBlock
                actionButtons
            }
        }
    }

    @ViewBuilder
    private var titleBlock: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Updates")
                .font(Resona.Typography.title)
            Text("Generate, save, and schedule team summaries.")
                .font(Resona.Typography.caption)
                .foregroundStyle(Resona.Palette.inkSoft)
        }
    }

    @ViewBuilder
    private var actionButtons: some View {
        HStack(spacing: 8) {
            Button {
                showSchedulerSheet = true
            } label: {
                Label("Auto-draft schedule…", systemImage: "calendar.badge.clock")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .help("Configure recurring weekly / monthly draft generation.")

            Button {
                showGenerateSheet = true
            } label: {
                Label("New update", systemImage: "plus")
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .keyboardShortcut("n", modifiers: [.command])
            .help("Generate a fresh update across the workstreams you pick")
        }
    }

    @ViewBuilder
    private var emptyStateCTA: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Image(systemName: "doc.text.image")
                    .font(.title2)
                    .foregroundStyle(Resona.Palette.sky)
                VStack(alignment: .leading, spacing: 2) {
                    Text("No updates yet")
                        .font(Resona.Typography.headline)
                    Text("Generate an LLM-rendered summary across the workstreams you pick. Choose a time window — last 24h, this week, or pick exact dates.")
                        .font(.callout)
                        .foregroundStyle(Resona.Palette.inkSoft)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            HStack(spacing: 10) {
                Button {
                    showGenerateSheet = true
                } label: {
                    Label("Generate your first update", systemImage: "sparkles")
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                Button {
                    showSchedulerSheet = true
                } label: {
                    Label("Or set up auto-drafts…", systemImage: "calendar.badge.clock")
                }
                .buttonStyle(.bordered)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .resonaCard(tint: Resona.Palette.sky.opacity(0.18), corner: 18, padding: 18)
    }

    @ViewBuilder
    private func section(title: String, systemImage: String, empty: String, reports: [Report]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: systemImage)
                Text(title).font(Resona.Typography.headline)
                if !reports.isEmpty {
                    Text("\(reports.count)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(Resona.Palette.inkSoft)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(Resona.Palette.lavender.opacity(0.35)))
                }
            }
            if reports.isEmpty {
                Text(empty)
                    .font(.callout)
                    .foregroundStyle(Resona.Palette.inkSoft)
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
                        .help("Open this update to read, edit, save, or delete it")
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
                        .foregroundStyle(Resona.Palette.inkFaint)
                    if !report.workstreamIDs.isEmpty {
                        Text("· \(report.workstreamIDs.count) workstream\(report.workstreamIDs.count == 1 ? "" : "s")")
                            .font(.caption2)
                            .foregroundStyle(Resona.Palette.inkFaint)
                    }
                }
            }
            Spacer()
            Image(systemName: "chevron.right")
                .imageScale(.small)
                .foregroundStyle(Resona.Palette.inkFaint)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .resonaCard(tint: Resona.Palette.parchment, corner: 14, padding: 12)
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
            Capsule().fill((isOverride ? Resona.Palette.lavender : Resona.Palette.sky).opacity(0.35))
        )
        .foregroundStyle(Resona.Palette.ink)
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

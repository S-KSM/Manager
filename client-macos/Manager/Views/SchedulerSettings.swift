import SwiftUI

/// Scheduler config sheet — toggle the weekly + monthly draft jobs and edit
/// their cron / audience / provider / model.
///
/// Backed by `client.listSchedulerJobs()` and `client.updateSchedulerJob(...)`.
struct SchedulerSettings: View {
    let client: DaemonClientProtocol
    let onDismiss: () -> Void

    @State private var jobs: [SchedulerJob] = []
    @State private var loading = true
    @State private var loadError: String?
    @State private var editingJob: SchedulerJob?
    @State private var presets: [ReportPreset] = []
    @State private var loadTask: Task<Void, Never>?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 6) {
                    Image(systemName: "calendar.badge.clock")
                        .foregroundStyle(.blue)
                    Text("Scheduled drafts").font(.headline)
                    Spacer()
                    Button("Done", action: onDismiss)
                        .keyboardShortcut(.cancelAction)
                        .controlSize(.small)
                }
                Text("The daemon generates a draft on each fire and drops it into the Drafts inbox for you to review. Both jobs are off by default.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if loading && jobs.isEmpty {
                    HStack { Spacer(); ProgressView().controlSize(.small); Spacer() }
                        .padding(.vertical, 12)
                }
                ForEach(jobs) { job in
                    JobRow(
                        job: job,
                        onToggle: { newEnabled in
                            await applyToggle(job: job, enabled: newEnabled)
                        },
                        onConfigure: {
                            editingJob = job
                        }
                    )
                }
                if let loadError {
                    Label(loadError, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
            .padding(20)
        }
        .frame(minWidth: 520, idealWidth: 580, minHeight: 360)
        .task {
            await reload()
        }
        .onDisappear {
            loadTask?.cancel()
        }
        .sheet(item: $editingJob) { job in
            JobEditor(
                job: job,
                presets: presets,
                onSave: { fields in
                    await applyEdit(jobID: job.id, fields: fields)
                },
                onDismiss: { editingJob = nil }
            )
        }
    }

    // MARK: - Reload + actions

    private func reload() async {
        loading = true
        loadError = nil
        async let jobsFetch: [SchedulerJob] = (try? await client.listSchedulerJobs()) ?? []
        async let presetsFetch: [ReportPreset] = (try? await client.listReportPresets()) ?? []
        let (j, p) = await (jobsFetch, presetsFetch)
        jobs = j.sorted { $0.id < $1.id }
        presets = p
        loading = false
    }

    private func applyToggle(job: SchedulerJob, enabled: Bool) async {
        do {
            let updated = try await client.updateSchedulerJob(
                id: job.id,
                fields: SchedulerJobUpdateFields(enabled: enabled)
            )
            if let idx = jobs.firstIndex(where: { $0.id == updated.id }) {
                jobs[idx] = updated
            }
        } catch {
            loadError = (error as? LocalizedError)?.errorDescription
                ?? "Could not update \(job.id)."
        }
    }

    private func applyEdit(jobID: String, fields: SchedulerJobUpdateFields) async {
        do {
            let updated = try await client.updateSchedulerJob(id: jobID, fields: fields)
            if let idx = jobs.firstIndex(where: { $0.id == updated.id }) {
                jobs[idx] = updated
            }
            editingJob = nil
        } catch {
            loadError = (error as? LocalizedError)?.errorDescription
                ?? "Could not update \(jobID)."
        }
    }
}

// MARK: - Job row

private struct JobRow: View {
    let job: SchedulerJob
    let onToggle: (Bool) async -> Void
    let onConfigure: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Toggle(isOn: Binding(
                get: { job.enabled },
                set: { newValue in Task { await onToggle(newValue) } }
            )) {
                Text("")
            }
            .labelsHidden()
            .toggleStyle(.switch)

            VStack(alignment: .leading, spacing: 4) {
                Text(label)
                    .font(.callout.weight(.semibold))
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let next = job.nextFireAt {
                    Text("Next: \(next.formatted(date: .abbreviated, time: .shortened))")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            Spacer()
            Button("Configure…", action: onConfigure)
                .buttonStyle(.bordered)
                .controlSize(.small)
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

    private var label: String {
        switch job.id {
        case "weekly_report":  return "Weekly draft"
        case "monthly_report": return "Monthly draft"
        default:               return job.id
        }
    }

    private var detail: String {
        let audience = job.audiencePreset?.replacingOccurrences(of: "_", with: " ").capitalized ?? "—"
        return "cron `\(job.cron)` · \(audience) · \(job.provider.capitalized)"
    }
}

// MARK: - Editor

private struct JobEditor: View {
    let job: SchedulerJob
    let presets: [ReportPreset]
    let onSave: (SchedulerJobUpdateFields) async -> Void
    let onDismiss: () -> Void

    @State private var cron: String
    @State private var audiencePresetID: String?
    @State private var provider: String
    @State private var model: String
    @State private var saving = false

    init(
        job: SchedulerJob,
        presets: [ReportPreset],
        onSave: @escaping (SchedulerJobUpdateFields) async -> Void,
        onDismiss: @escaping () -> Void
    ) {
        self.job = job
        self.presets = presets
        self.onSave = onSave
        self.onDismiss = onDismiss
        _cron = State(initialValue: job.cron)
        _audiencePresetID = State(initialValue: job.audiencePreset)
        _provider = State(initialValue: job.provider)
        _model = State(initialValue: job.model ?? "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Configure \(job.id)").font(.headline)
                Spacer()
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("Cron").font(.caption.weight(.semibold)).foregroundStyle(.secondary).textCase(.uppercase)
                TextField("0 8 * * 1", text: $cron)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.callout, design: .monospaced))
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("Audience").font(.caption.weight(.semibold)).foregroundStyle(.secondary).textCase(.uppercase)
                Picker("Audience", selection: $audiencePresetID) {
                    ForEach(presets) { p in
                        Text(p.name).tag(Optional(p.id))
                    }
                    if presets.isEmpty {
                        Text("Executive").tag(Optional("executive"))
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("Provider").font(.caption.weight(.semibold)).foregroundStyle(.secondary).textCase(.uppercase)
                Picker("Provider", selection: $provider) {
                    Text("Claude").tag("claude")
                    Text("Local (Ollama)").tag("ollama")
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("Model").font(.caption.weight(.semibold)).foregroundStyle(.secondary).textCase(.uppercase)
                TextField(provider == "claude" ? "claude-sonnet-4-7" : "qwen3:8b", text: $model)
                    .textFieldStyle(.roundedBorder)
            }
            Spacer()
            HStack {
                Spacer()
                Button("Cancel", role: .cancel, action: onDismiss)
                    .keyboardShortcut(.cancelAction)
                    .disabled(saving)
                Button {
                    Task {
                        saving = true
                        defer { saving = false }
                        let trimmedModel = model.trimmingCharacters(in: .whitespacesAndNewlines)
                        let fields = SchedulerJobUpdateFields(
                            enabled: nil,
                            cron: cron.trimmingCharacters(in: .whitespacesAndNewlines),
                            audiencePreset: audiencePresetID,
                            provider: provider,
                            model: trimmedModel.isEmpty ? nil : trimmedModel
                        )
                        await onSave(fields)
                    }
                } label: {
                    if saving {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Save")
                    }
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .disabled(saving)
            }
        }
        .padding(20)
        .frame(minWidth: 460, idealWidth: 520, minHeight: 380)
    }
}

// MARK: - Preview

#Preview("SchedulerSettings (mock)") {
    SchedulerSettings(
        client: MockDaemonClient(simulatedLatency: .zero),
        onDismiss: {}
    )
}

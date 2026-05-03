import Foundation

private extension String {
    /// `nil` when the string is empty, otherwise `self`. Convenience for
    /// optional-coalescing chains that prefer "no value" over "empty value".
    var nonEmpty: String? { isEmpty ? nil : self }
}

/// In-process implementation of `DaemonClientProtocol` backed by `MockData`.
///
/// Used by:
///  - SwiftUI previews,
///  - the app at launch when the live daemon is unreachable,
///  - unit tests that don't want to spin up a daemon.
final class MockDaemonClient: DaemonClientProtocol, @unchecked Sendable {
    private let eventsByWorkstream: [String: [Event]]
    private let memoryByWorkstream: [String: String]
    private let simulatedLatency: Duration

    /// Mutable state. Guarded by `lock` so concurrent UI taps stay safe.
    private var _workstreams: [Workstream]
    private var _interventions: [Intervention] = []
    private var _proposedSkills: [SkillProposal]
    private var _handbook: String
    private var _reports: [Report]
    private var _schedulerJobs: [SchedulerJob]
    private let _reportPresets: [ReportPreset]
    private let lock = NSLock()

    init(
        workstreams: [Workstream] = MockData.workstreams,
        eventsByWorkstream: [String: [Event]] = MockData.eventsByWorkstream,
        memoryByWorkstream: [String: String] = MockData.memoryByWorkstream,
        proposedSkills: [SkillProposal] = MockData.proposedSkills,
        handbook: String = MockData.handbook,
        reports: [Report] = MockData.reports,
        schedulerJobs: [SchedulerJob] = MockData.schedulerJobs,
        reportPresets: [ReportPreset] = MockData.reportPresets,
        simulatedLatency: Duration = .milliseconds(50)
    ) {
        self._workstreams = workstreams
        self.eventsByWorkstream = eventsByWorkstream
        self.memoryByWorkstream = memoryByWorkstream
        self._proposedSkills = proposedSkills
        self._handbook = handbook
        self._reports = reports
        self._schedulerJobs = schedulerJobs
        self._reportPresets = reportPresets
        self.simulatedLatency = simulatedLatency
    }

    /// Read-only snapshot of every intervention this mock has accepted, in
    /// insertion order. Test-only helper; not part of the protocol.
    var interventions: [Intervention] {
        lock.lock()
        defer { lock.unlock() }
        return _interventions
    }

    /// Read-only snapshot of the current handbook contents (mock only).
    var handbookSnapshot: String {
        lock.lock()
        defer { lock.unlock() }
        return _handbook
    }

    func health() async -> Bool { true }

    func listWorkstreams() async throws -> [Workstream] {
        try? await Task.sleep(for: simulatedLatency)
        lock.lock()
        defer { lock.unlock() }
        return _workstreams
    }

    func getWorkstream(id: String) async throws -> Workstream {
        try? await Task.sleep(for: simulatedLatency)
        lock.lock()
        let ws = _workstreams.first(where: { $0.id == id })
        lock.unlock()
        guard let ws else {
            throw DaemonError.badResponse(404)
        }
        return ws
    }

    func getMemory(workstreamID: String) async throws -> String {
        try? await Task.sleep(for: simulatedLatency)
        return memoryByWorkstream[workstreamID]
            ?? "# Workstream: \(workstreamID)\n\n_(no memory yet)_\n"
    }

    func getEvents(workstreamID: String) async throws -> [Event] {
        try? await Task.sleep(for: simulatedLatency)
        return eventsByWorkstream[workstreamID] ?? []
    }

    /// Always succeeds. Appends a synthetic `Intervention` (with a generated
    /// `id` and `created_at = now`, `delivered_at = nil`) into the in-memory
    /// store and returns it so the UI can roundtrip exactly like the live
    /// daemon does.
    func postIntervention(workstreamID: String,
                          kind: InterventionKind,
                          message: String,
                          rollbackToDecisionID: String?) async throws -> Intervention {
        try? await Task.sleep(for: simulatedLatency)
        let intervention = Intervention(
            id: "int_mock_\(UUID().uuidString.prefix(8))",
            workstreamID: workstreamID,
            kind: kind,
            payload: InterventionPayload(
                message: message.isEmpty ? nil : message,
                rollbackToDecisionID: rollbackToDecisionID
            ),
            createdAt: Date(),
            deliveredAt: nil
        )
        lock.lock()
        _interventions.append(intervention)
        lock.unlock()
        return intervention
    }

    func listPendingInterventions(workstreamID: String) async throws -> [Intervention] {
        try? await Task.sleep(for: simulatedLatency)
        lock.lock()
        defer { lock.unlock() }
        return _interventions.filter {
            $0.workstreamID == workstreamID && $0.deliveredAt == nil
        }
    }

    func decideApproval(workstreamID: String,
                        interventionID: String,
                        approved: Bool) async throws -> Intervention {
        try? await Task.sleep(for: simulatedLatency)
        lock.lock()
        defer { lock.unlock() }
        guard let idx = _interventions.firstIndex(where: { $0.id == interventionID }),
              _interventions[idx].kind == .approvalRequired,
              _interventions[idx].deliveredAt == nil
        else {
            throw DaemonError.transport(NSError(domain: "MockDaemon", code: 404))
        }
        let prior = _interventions[idx]
        let updated = Intervention(
            id: prior.id,
            workstreamID: prior.workstreamID,
            kind: prior.kind,
            payload: InterventionPayload(
                message: prior.payload.message,
                rollbackToDecisionID: prior.payload.rollbackToDecisionID,
                approvalRequest: prior.payload.approvalRequest,
                approvalDecision: ApprovalDecision(approved: approved)
            ),
            createdAt: prior.createdAt,
            deliveredAt: Date()
        )
        _interventions[idx] = updated
        return updated
    }

    // MARK: - v1: lifecycle

    func createWorkstream(id: String, title: String) async throws -> Workstream {
        try? await Task.sleep(for: simulatedLatency)
        let ws = Workstream(
            id: id,
            title: title,
            createdAt: Date(),
            status: .active,
            sessions: [],
            currentSubgoal: nil,
            latestConfidence: nil,
            needsAttention: false,
            todos: nil,
            latestActivity: nil,
            lastEventAt: nil
        )
        lock.lock()
        // If a workstream with this id already exists, replace it. Otherwise
        // append. Mirrors the daemon's "create or no-op" semantics.
        if let idx = _workstreams.firstIndex(where: { $0.id == id }) {
            _workstreams[idx] = ws
        } else {
            _workstreams.append(ws)
        }
        lock.unlock()
        return ws
    }

    func updateWorkstream(id: String,
                          status: Workstream.Status?,
                          title: String?) async throws -> Workstream {
        try? await Task.sleep(for: simulatedLatency)
        lock.lock()
        defer { lock.unlock() }
        guard let idx = _workstreams.firstIndex(where: { $0.id == id }) else {
            throw DaemonError.badResponse(404)
        }
        let old = _workstreams[idx]
        let updated = Workstream(
            id: old.id,
            title: title ?? old.title,
            createdAt: old.createdAt,
            status: status ?? old.status,
            memoryPath: old.memoryPath,
            sessions: old.sessions,
            currentSubgoal: old.currentSubgoal,
            latestConfidence: old.latestConfidence,
            needsAttention: old.needsAttention,
            todos: old.todos,
            latestActivity: old.latestActivity,
            lastEventAt: old.lastEventAt
        )
        _workstreams[idx] = updated
        return updated
    }

    // MARK: - v1: digest

    func getDigest(since: Date?) async throws -> Digest {
        try? await Task.sleep(for: simulatedLatency)
        lock.lock()
        let snapshot = _workstreams
        lock.unlock()

        let cutoff = since ?? Date().addingTimeInterval(-24 * 60 * 60)
        // shipped: workstreams emitting at least one decision in the window
        // active:  workstreams with at least one event in the window
        // blocked / needs_attention: workstreams with the attention flag set
        let shipped = snapshot.filter { ws in
            let evs = eventsByWorkstream[ws.id] ?? []
            return evs.contains { e in
                e.ts >= cutoff && e.type == .decision
            }
        }.count

        let active = snapshot.filter { ws in
            ws.status == .active &&
                (eventsByWorkstream[ws.id] ?? []).contains { $0.ts >= cutoff }
        }.count

        let blocked = snapshot.filter { $0.needsAttention }.count
        let needsAttention = blocked

        // Highlights: prioritise needs_attention, then by event count in window.
        let scored: [(Workstream, Int)] = snapshot.map { ws in
            let evs = eventsByWorkstream[ws.id] ?? []
            let inWindow = evs.filter { $0.ts >= cutoff }.count
            return (ws, inWindow)
        }
        let prioritised = scored.sorted { lhs, rhs in
            if lhs.0.needsAttention != rhs.0.needsAttention {
                return lhs.0.needsAttention && !rhs.0.needsAttention
            }
            return lhs.1 > rhs.1
        }

        let highlights: [DigestHighlight] = prioritised.prefix(5).compactMap { (ws, count) in
            // Skip workstreams with literally nothing happening in the window
            // and no attention flag.
            if !ws.needsAttention && count == 0 { return nil }
            let summary: String
            if ws.needsAttention {
                summary = "needs you" + (ws.currentSubgoal.map { " — \($0)" } ?? "")
            } else {
                let plural = count == 1 ? "" : "s"
                let conf = ws.latestConfidence
                    .map { "; confidence \(Int(($0 * 100).rounded()))%" } ?? ""
                summary = "\(count) event\(plural)\(conf)"
            }
            return DigestHighlight(
                workstreamID: ws.id,
                title: ws.title,
                summary: summary
            )
        }

        return Digest(
            since: cutoff,
            totals: DigestTotals(
                shipped: shipped,
                blocked: blocked,
                needsAttention: needsAttention,
                active: active
            ),
            highlights: highlights
        )
    }

    // MARK: - v1: handbook + skills

    func getHandbook() async throws -> String {
        try? await Task.sleep(for: simulatedLatency)
        lock.lock()
        defer { lock.unlock() }
        return _handbook
    }

    func appendHandbookSkill(title: String,
                             body: String,
                             sourceWorkstreamID: String?,
                             sourceDecisionID: String?) async throws {
        try? await Task.sleep(for: simulatedLatency)
        lock.lock()
        defer { lock.unlock() }
        let footer: String
        if let ws = sourceWorkstreamID, let dec = sourceDecisionID {
            footer = "\n\n_from \(ws) / \(dec)_\n"
        } else if let ws = sourceWorkstreamID {
            footer = "\n\n_from \(ws)_\n"
        } else {
            footer = "\n"
        }
        let separator = _handbook.isEmpty || _handbook.hasSuffix("\n\n") ? "" : "\n\n"
        _handbook += "\(separator)## \(title)\n\n\(body)\(footer)"
    }

    func listProposedSkills() async throws -> [SkillProposal] {
        try? await Task.sleep(for: simulatedLatency)
        lock.lock()
        defer { lock.unlock() }
        return _proposedSkills.filter { $0.status == .proposed }
    }

    func promoteSkill(id: String) async throws -> SkillProposal {
        try? await Task.sleep(for: simulatedLatency)
        lock.lock()
        guard let idx = _proposedSkills.firstIndex(where: { $0.id == id }) else {
            lock.unlock()
            throw DaemonError.badResponse(404)
        }
        let old = _proposedSkills[idx]
        let updated = SkillProposal(
            id: old.id,
            workstreamID: old.workstreamID,
            title: old.title,
            body: old.body,
            sourceDecisionID: old.sourceDecisionID,
            proposedAt: old.proposedAt,
            status: .promoted
        )
        _proposedSkills[idx] = updated
        // Append into the handbook so the mock matches the live daemon's
        // promote-into-handbook contract.
        let footer = "\n\n_from \(old.workstreamID)" +
            (old.sourceDecisionID.map { " / \($0)" } ?? "") + "_\n"
        let separator = _handbook.isEmpty || _handbook.hasSuffix("\n\n") ? "" : "\n\n"
        _handbook += "\(separator)## \(old.title)\n\n\(old.body)\(footer)"
        lock.unlock()
        return updated
    }

    func dismissSkill(id: String) async throws -> SkillProposal {
        try? await Task.sleep(for: simulatedLatency)
        lock.lock()
        defer { lock.unlock() }
        guard let idx = _proposedSkills.firstIndex(where: { $0.id == id }) else {
            throw DaemonError.badResponse(404)
        }
        let old = _proposedSkills[idx]
        let updated = SkillProposal(
            id: old.id,
            workstreamID: old.workstreamID,
            title: old.title,
            body: old.body,
            sourceDecisionID: old.sourceDecisionID,
            proposedAt: old.proposedAt,
            status: .dismissed
        )
        _proposedSkills[idx] = updated
        return updated
    }

    // MARK: - v1.1: reports + scheduler

    /// Read-only snapshot of the current reports list (mock only).
    var reportsSnapshot: [Report] {
        lock.lock()
        defer { lock.unlock() }
        return _reports
    }

    /// Read-only snapshot of the current scheduler config (mock only).
    var schedulerJobsSnapshot: [SchedulerJob] {
        lock.lock()
        defer { lock.unlock() }
        return _schedulerJobs
    }

    func listReportPresets() async throws -> [ReportPreset] {
        try? await Task.sleep(for: simulatedLatency)
        return _reportPresets
    }

    /// Always succeeds. Synthesises a realistic-looking report from the given
    /// workstream ids + audience preset/freetext, persists it (with whatever
    /// status the params imply: saved=true ⇒ .saved, otherwise .draft), and
    /// returns the persisted record. Mirrors the live daemon's contract.
    func generateReport(_ params: GenerateReportParams) async throws -> Report {
        try? await Task.sleep(for: simulatedLatency)
        lock.lock()
        let workstreamSnapshot = _workstreams
        lock.unlock()

        let now = Date()
        let since = params.since ?? now.addingTimeInterval(-7 * 24 * 60 * 60)
        let until = params.until ?? now

        let titleWindowFmt = DateFormatter()
        titleWindowFmt.dateFormat = "yyyy-MM-dd"

        let pickedTitles: [String] = params.workstreamIDs.compactMap { id in
            workstreamSnapshot.first(where: { $0.id == id })?.title
        }

        let bodyMD = Self.synthesiseBody(
            workstreamIDs: params.workstreamIDs,
            workstreamTitles: pickedTitles,
            audiencePreset: params.audiencePreset,
            audienceFreetext: params.audienceFreetext,
            since: since,
            until: until
        )

        let title = params.title?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
            ?? "Weekly update — \(titleWindowFmt.string(from: until))"

        let status: ReportStatus = params.save ? .saved : .draft

        let report = Report(
            id: "rep_mock_\(UUID().uuidString.prefix(8))",
            title: title,
            audiencePreset: params.audiencePreset,
            audienceFreetext: params.audienceFreetext,
            periodSince: since,
            periodUntil: until,
            workstreamIDs: params.workstreamIDs,
            provider: params.provider,
            model: params.model,
            bodyMD: bodyMD,
            status: status,
            generatedAt: now,
            savedAt: params.save ? now : nil
        )

        if params.save {
            lock.lock()
            _reports.insert(report, at: 0)
            lock.unlock()
        }
        return report
    }

    func listReports(status: ReportStatus?) async throws -> [Report] {
        try? await Task.sleep(for: simulatedLatency)
        lock.lock()
        defer { lock.unlock() }
        let filtered: [Report]
        if let status {
            filtered = _reports.filter { $0.status == status }
        } else {
            filtered = _reports
        }
        return filtered.sorted {
            ($0.savedAt ?? $0.generatedAt) > ($1.savedAt ?? $1.generatedAt)
        }
    }

    func getReport(id: String) async throws -> Report {
        try? await Task.sleep(for: simulatedLatency)
        lock.lock()
        defer { lock.unlock() }
        guard let report = _reports.first(where: { $0.id == id }) else {
            throw DaemonError.badResponse(404)
        }
        return report
    }

    func updateReport(id: String, fields: ReportUpdateFields) async throws -> Report {
        try? await Task.sleep(for: simulatedLatency)
        lock.lock()
        defer { lock.unlock() }
        guard let idx = _reports.firstIndex(where: { $0.id == id }) else {
            throw DaemonError.badResponse(404)
        }
        let old = _reports[idx]
        let nextStatus = fields.status ?? old.status
        let nextSavedAt: Date?
        if let newStatus = fields.status, newStatus == .saved, old.status != .saved {
            nextSavedAt = Date()
        } else if let newStatus = fields.status, newStatus != .saved {
            // Moving away from saved — clear savedAt to mirror the daemon.
            nextSavedAt = nil
        } else {
            nextSavedAt = old.savedAt
        }
        let updated = Report(
            id: old.id,
            title: fields.title ?? old.title,
            audiencePreset: old.audiencePreset,
            audienceFreetext: old.audienceFreetext,
            periodSince: old.periodSince,
            periodUntil: old.periodUntil,
            workstreamIDs: old.workstreamIDs,
            provider: old.provider,
            model: old.model,
            bodyMD: fields.bodyMD ?? old.bodyMD,
            status: nextStatus,
            generatedAt: old.generatedAt,
            savedAt: nextSavedAt
        )
        _reports[idx] = updated
        return updated
    }

    func deleteReport(id: String) async throws -> Report {
        // Soft-delete: flip to archived, mirror updateReport(.archived).
        return try await updateReport(id: id, fields: ReportUpdateFields(status: .archived))
    }

    func listSchedulerJobs() async throws -> [SchedulerJob] {
        try? await Task.sleep(for: simulatedLatency)
        lock.lock()
        defer { lock.unlock() }
        return _schedulerJobs
    }

    func updateSchedulerJob(id: String,
                            fields: SchedulerJobUpdateFields) async throws -> SchedulerJob {
        try? await Task.sleep(for: simulatedLatency)
        lock.lock()
        defer { lock.unlock() }
        guard let idx = _schedulerJobs.firstIndex(where: { $0.id == id }) else {
            throw DaemonError.badResponse(404)
        }
        let old = _schedulerJobs[idx]
        let updated = SchedulerJob(
            id: old.id,
            enabled: fields.enabled ?? old.enabled,
            cron: fields.cron ?? old.cron,
            audiencePreset: fields.audiencePreset ?? old.audiencePreset,
            provider: fields.provider ?? old.provider,
            model: fields.model ?? old.model,
            nextFireAt: old.nextFireAt
        )
        _schedulerJobs[idx] = updated
        return updated
    }

    /// Realistic-ish stub. Builds a few sections of plausible Markdown so the
    /// preview / Updates surface have something to show without a daemon.
    private static func synthesiseBody(
        workstreamIDs: [String],
        workstreamTitles: [String],
        audiencePreset: String?,
        audienceFreetext: String?,
        since: Date,
        until: Date
    ) -> String {
        let dayFmt = DateFormatter()
        dayFmt.dateFormat = "MMM d"

        let audienceLine: String
        if let freetext = audienceFreetext?.trimmingCharacters(in: .whitespacesAndNewlines),
           !freetext.isEmpty {
            audienceLine = "_For: \(freetext)_"
        } else if let preset = audiencePreset {
            audienceLine = "_Audience: \(preset.replacingOccurrences(of: "_", with: " "))_"
        } else {
            audienceLine = "_Audience: executive_"
        }

        let bullets: [String]
        if workstreamTitles.isEmpty {
            bullets = ["- No workstreams selected — empty draft."]
        } else {
            bullets = workstreamTitles.prefix(6).enumerated().map { (i, title) in
                let progress = ["shipping", "in flight", "blocked on review", "ramping",
                                "stalled", "wrapping up"][i % 6]
                return "- **\(title)** — \(progress); 2 decisions landed this week."
            }
        }

        return """
        # Weekly update

        \(audienceLine)
        _Window: \(dayFmt.string(from: since)) – \(dayFmt.string(from: until))_

        ## Highlights

        \(bullets.joined(separator: "\n"))

        ## Risks & asks

        - One workstream is blocked on a cross-team review — I'll chase tomorrow.
        - No infra incidents this week.

        ## Next week

        - Land the open decisions on \(workstreamTitles.first ?? "the active workstream").
        - Begin scoping the next cross-team migration.
        """
    }

    func streamEvents(workstreamID: String) -> AsyncStream<Event> {
        let events = eventsByWorkstream[workstreamID] ?? []
        return AsyncStream { continuation in
            let task = Task {
                for e in events.suffix(8) {
                    try? await Task.sleep(for: .milliseconds(400))
                    if Task.isCancelled { break }
                    continuation.yield(e)
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

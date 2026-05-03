import Foundation

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
    private let lock = NSLock()

    init(
        workstreams: [Workstream] = MockData.workstreams,
        eventsByWorkstream: [String: [Event]] = MockData.eventsByWorkstream,
        memoryByWorkstream: [String: String] = MockData.memoryByWorkstream,
        proposedSkills: [SkillProposal] = MockData.proposedSkills,
        handbook: String = MockData.handbook,
        simulatedLatency: Duration = .milliseconds(50)
    ) {
        self._workstreams = workstreams
        self.eventsByWorkstream = eventsByWorkstream
        self.memoryByWorkstream = memoryByWorkstream
        self._proposedSkills = proposedSkills
        self._handbook = handbook
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

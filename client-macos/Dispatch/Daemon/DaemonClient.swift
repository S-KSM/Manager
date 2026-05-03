import Foundation

/// Abstract surface for talking to the Dispatch daemon.
///
/// Both the live `LiveDaemonClient` (HTTP + WS over `URLSession`) and the
/// in-process `MockDaemonClient` conform to this. Views depend only on this
/// protocol so previews/tests/offline-launches can swap in mock data without
/// changing call sites.
protocol DaemonClientProtocol: Sendable {
    func listWorkstreams() async throws -> [Workstream]
    func getWorkstream(id: String) async throws -> Workstream
    func getMemory(workstreamID: String) async throws -> String
    func getEvents(workstreamID: String) async throws -> [Event]
    func streamEvents(workstreamID: String) -> AsyncStream<Event>
    /// Submit a human-issued intervention (nudge / redirect / rollback) to
    /// the daemon's per-workstream queue. The returned `Intervention` is the
    /// persisted record (with `id` and `created_at` filled by the daemon).
    /// `rollbackToDecisionID` is required when `kind == .rollback`, ignored
    /// otherwise.
    func postIntervention(workstreamID: String,
                          kind: InterventionKind,
                          message: String,
                          rollbackToDecisionID: String?) async throws -> Intervention

    // MARK: - v1: workstream lifecycle

    /// `POST /workstreams` — creates a new workstream from an id slug + title.
    /// Returns the persisted `Workstream` record.
    func createWorkstream(id: String, title: String) async throws -> Workstream
    /// `PATCH /workstreams/:id` — partial update. Pass `nil` for fields you
    /// don't want to change. The daemon appends a `workstream_status_changed`
    /// event to the JSONL log when status changes.
    func updateWorkstream(id: String,
                          status: Workstream.Status?,
                          title: String?) async throws -> Workstream

    // MARK: - v1: digest

    /// `GET /digest?since=<iso8601>` — aggregate summary across all
    /// workstreams since the timestamp. Default `since` (when nil) = 24h ago.
    func getDigest(since: Date?) async throws -> Digest

    // MARK: - v1: handbook + skills

    /// `GET /handbook` — returns the team handbook as raw Markdown.
    func getHandbook() async throws -> String
    /// `POST /handbook/skills` — append a new skill section to the handbook.
    /// `sourceWorkstreamID` and `sourceDecisionID` annotate where the skill
    /// came from; both are optional.
    func appendHandbookSkill(title: String,
                             body: String,
                             sourceWorkstreamID: String?,
                             sourceDecisionID: String?) async throws
    /// `GET /skills/proposed` — pending skill proposals from agents.
    func listProposedSkills() async throws -> [SkillProposal]
    /// `POST /skills/proposed/:id/promote` — moves a proposal into the
    /// handbook and flips its status to `promoted`.
    func promoteSkill(id: String) async throws -> SkillProposal
    /// `POST /skills/proposed/:id/dismiss` — drops a proposal without
    /// promoting; flips its status to `dismissed`.
    func dismissSkill(id: String) async throws -> SkillProposal

    // MARK: - v1.1: reports + scheduler

    /// `GET /report-presets` — list the daemon's built-in audience presets.
    func listReportPresets() async throws -> [ReportPreset]

    /// `POST /reports/generate` — synthesises an update from the given
    /// workstreams + window. When `params.save == true` the daemon persists
    /// the resulting `Report` with status=saved; otherwise it returns a
    /// transient draft (status=draft) that the UI can choose to keep.
    func generateReport(_ params: GenerateReportParams) async throws -> Report

    /// `GET /reports?status=...` — list saved reports filtered by status.
    /// Pass `nil` to fetch every status.
    func listReports(status: ReportStatus?) async throws -> [Report]

    /// `GET /reports/:id` — single report.
    func getReport(id: String) async throws -> Report

    /// `PATCH /reports/:id` — partial update. Setting `status = .saved` on a
    /// draft also stamps `saved_at` server-side.
    func updateReport(id: String, fields: ReportUpdateFields) async throws -> Report

    /// `DELETE /reports/:id` — soft-delete; the daemon flips status=archived
    /// and returns the updated record so the UI can confirm the change.
    func deleteReport(id: String) async throws -> Report

    /// `GET /scheduler/jobs` — current weekly/monthly draft-generator config.
    func listSchedulerJobs() async throws -> [SchedulerJob]

    /// `PATCH /scheduler/jobs/:id` — partial update + reschedule.
    func updateSchedulerJob(id: String,
                            fields: SchedulerJobUpdateFields) async throws -> SchedulerJob

    /// Returns `false` on connection error; never throws. Used by
    /// `DaemonResolver` to choose live vs mock at startup.
    func health() async -> Bool
}

enum DaemonError: Error, LocalizedError {
    case badURL
    case badResponse(Int)
    case decoding(Error)
    case transport(Error)

    var errorDescription: String? {
        switch self {
        case .badURL:                 return "Bad daemon URL."
        case .badResponse(let code):  return "Daemon returned HTTP \(code)."
        case .decoding(let e):        return "Could not decode daemon response: \(e)"
        case .transport(let e):       return "Transport error: \(e)"
        }
    }
}

/// HTTP + WebSocket client for the local daemon.
///
/// API contract (docs/ARCHITECTURE.md):
///   GET    /workstreams
///   POST   /workstreams                     (create — v1)
///   GET    /workstreams/{id}
///   PATCH  /workstreams/{id}                (status / title — v1)
///   GET    /workstreams/{id}/memory         (raw Markdown body)
///   GET    /workstreams/{id}/events         (JSON array of envelope events)
///   POST   /interventions                   (queue a nudge/redirect/rollback)
///   GET    /digest?since=<iso8601>          (v1 — aggregate)
///   GET    /handbook                        (v1 — raw Markdown body)
///   POST   /handbook/skills                 (v1 — append skill)
///   GET    /skills/proposed                 (v1 — pending proposals)
///   POST   /skills/proposed/{id}/promote    (v1)
///   POST   /skills/proposed/{id}/dismiss    (v1)
///   GET    /health                          (200 OK)
///   WS     /workstreams/{id}/events/stream
final class LiveDaemonClient: DaemonClientProtocol, @unchecked Sendable {
    static let defaultBaseURL = URL(string: "http://localhost:9876")!

    private let baseURL: URL
    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    init(baseURL: URL = LiveDaemonClient.defaultBaseURL,
                session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601WithFractionalSeconds
        self.decoder = d
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        self.encoder = e
    }

    func health() async -> Bool {
        let url = baseURL.appendingPathComponent("health")
        var req = URLRequest(url: url)
        req.timeoutInterval = 1.0
        do {
            let (_, response) = try await session.data(for: req)
            guard let http = response as? HTTPURLResponse else { return false }
            return (200..<300).contains(http.statusCode)
        } catch {
            return false
        }
    }

    func listWorkstreams() async throws -> [Workstream] {
        try await getJSON(path: "workstreams")
    }

    func getWorkstream(id: String) async throws -> Workstream {
        try await getJSON(path: "workstreams/\(id)")
    }

    func getMemory(workstreamID: String) async throws -> String {
        let url = baseURL.appendingPathComponent("workstreams/\(workstreamID)/memory")
        let (data, response) = try await session.data(from: url)
        try Self.assertOK(response)
        return String(data: data, encoding: .utf8) ?? ""
    }

    func getEvents(workstreamID: String) async throws -> [Event] {
        try await getJSON(path: "workstreams/\(workstreamID)/events")
    }

    func postIntervention(workstreamID: String,
                          kind: InterventionKind,
                          message: String,
                          rollbackToDecisionID: String?) async throws -> Intervention {
        let url = baseURL.appendingPathComponent("interventions")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")

        // The wire body is `{workstream_id, kind, payload}`. We don't reuse
        // `Intervention` here because the daemon owns id/created_at/delivered_at.
        let body = InterventionRequestBody(
            workstreamID: workstreamID,
            kind: kind,
            payload: InterventionPayload(
                message: message.isEmpty ? nil : message,
                rollbackToDecisionID: rollbackToDecisionID
            )
        )
        do {
            req.httpBody = try encoder.encode(body)
        } catch {
            throw DaemonError.decoding(error)
        }

        do {
            let (data, response) = try await session.data(for: req)
            try Self.assertOK(response)
            do {
                return try decoder.decode(Intervention.self, from: data)
            } catch {
                throw DaemonError.decoding(error)
            }
        } catch let e as DaemonError {
            throw e
        } catch {
            throw DaemonError.transport(error)
        }
    }

    // MARK: - v1: lifecycle

    func createWorkstream(id: String, title: String) async throws -> Workstream {
        let body = CreateWorkstreamBody(workstreamID: id, title: title)
        return try await sendJSON(method: "POST", path: "workstreams", body: body)
    }

    func updateWorkstream(id: String,
                          status: Workstream.Status?,
                          title: String?) async throws -> Workstream {
        let body = UpdateWorkstreamBody(status: status, title: title)
        return try await sendJSON(method: "PATCH", path: "workstreams/\(id)", body: body)
    }

    // MARK: - v1: digest

    func getDigest(since: Date?) async throws -> Digest {
        var components = URLComponents(
            url: baseURL.appendingPathComponent("digest"),
            resolvingAgainstBaseURL: false
        ) ?? URLComponents()
        if let since {
            // ISO-8601 with fractional seconds, matching the daemon's wire
            // format for inbound query strings.
            let fmt = ISO8601DateFormatter()
            fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            components.queryItems = [URLQueryItem(name: "since", value: fmt.string(from: since))]
        }
        guard let url = components.url else { throw DaemonError.badURL }
        do {
            let (data, response) = try await session.data(from: url)
            try Self.assertOK(response)
            do {
                return try decoder.decode(Digest.self, from: data)
            } catch {
                throw DaemonError.decoding(error)
            }
        } catch let e as DaemonError {
            throw e
        } catch {
            throw DaemonError.transport(error)
        }
    }

    // MARK: - v1: handbook + skills

    func getHandbook() async throws -> String {
        let url = baseURL.appendingPathComponent("handbook")
        do {
            let (data, response) = try await session.data(from: url)
            try Self.assertOK(response)
            return String(data: data, encoding: .utf8) ?? ""
        } catch let e as DaemonError {
            throw e
        } catch {
            throw DaemonError.transport(error)
        }
    }

    func appendHandbookSkill(title: String,
                             body: String,
                             sourceWorkstreamID: String?,
                             sourceDecisionID: String?) async throws {
        let request = AppendSkillBody(
            title: title,
            body: body,
            source: (sourceWorkstreamID == nil && sourceDecisionID == nil)
                ? nil
                : AppendSkillBody.Source(
                    workstreamID: sourceWorkstreamID,
                    decisionID: sourceDecisionID
                )
        )
        let _: AppendSkillResponse = try await sendJSON(
            method: "POST",
            path: "handbook/skills",
            body: request
        )
    }

    func listProposedSkills() async throws -> [SkillProposal] {
        try await getJSON(path: "skills/proposed")
    }

    func promoteSkill(id: String) async throws -> SkillProposal {
        try await sendJSON(
            method: "POST",
            path: "skills/proposed/\(id)/promote",
            body: EmptyBody()
        )
    }

    func dismissSkill(id: String) async throws -> SkillProposal {
        try await sendJSON(
            method: "POST",
            path: "skills/proposed/\(id)/dismiss",
            body: EmptyBody()
        )
    }

    // MARK: - v1.1: reports + scheduler

    func listReportPresets() async throws -> [ReportPreset] {
        try await getJSON(path: "report-presets")
    }

    func generateReport(_ params: GenerateReportParams) async throws -> Report {
        try await sendJSON(method: "POST", path: "reports/generate", body: params)
    }

    func listReports(status: ReportStatus?) async throws -> [Report] {
        var components = URLComponents(
            url: baseURL.appendingPathComponent("reports"),
            resolvingAgainstBaseURL: false
        ) ?? URLComponents()
        if let status {
            components.queryItems = [URLQueryItem(name: "status", value: status.rawValue)]
        }
        guard let url = components.url else { throw DaemonError.badURL }
        do {
            let (data, response) = try await session.data(from: url)
            try Self.assertOK(response)
            do {
                return try decoder.decode([Report].self, from: data)
            } catch {
                throw DaemonError.decoding(error)
            }
        } catch let e as DaemonError {
            throw e
        } catch {
            throw DaemonError.transport(error)
        }
    }

    func getReport(id: String) async throws -> Report {
        try await getJSON(path: "reports/\(id)")
    }

    func updateReport(id: String, fields: ReportUpdateFields) async throws -> Report {
        try await sendJSON(method: "PATCH", path: "reports/\(id)", body: fields)
    }

    func deleteReport(id: String) async throws -> Report {
        let url = baseURL.appendingPathComponent("reports/\(id)")
        var req = URLRequest(url: url)
        req.httpMethod = "DELETE"
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let (data, response) = try await session.data(for: req)
            try Self.assertOK(response)
            do {
                return try decoder.decode(Report.self, from: data)
            } catch {
                throw DaemonError.decoding(error)
            }
        } catch let e as DaemonError {
            throw e
        } catch {
            throw DaemonError.transport(error)
        }
    }

    func listSchedulerJobs() async throws -> [SchedulerJob] {
        try await getJSON(path: "scheduler/jobs")
    }

    func updateSchedulerJob(id: String,
                            fields: SchedulerJobUpdateFields) async throws -> SchedulerJob {
        try await sendJSON(method: "PATCH", path: "scheduler/jobs/\(id)", body: fields)
    }

    func streamEvents(workstreamID: String) -> AsyncStream<Event> {
        // Build a ws:// URL alongside the http base.
        var components = URLComponents(url: baseURL,
                                       resolvingAgainstBaseURL: false) ?? URLComponents()
        components.scheme = (baseURL.scheme == "https") ? "wss" : "ws"
        components.path = "/workstreams/\(workstreamID)/events/stream"
        guard let wsURL = components.url else {
            return AsyncStream { $0.finish() }
        }

        let task = session.webSocketTask(with: wsURL)
        let decoder = self.decoder

        return AsyncStream { continuation in
            task.resume()

            func receiveNext() {
                task.receive { result in
                    switch result {
                    case .failure:
                        continuation.finish()
                        task.cancel(with: .goingAway, reason: nil)
                    case .success(let message):
                        let data: Data?
                        switch message {
                        case .string(let s): data = s.data(using: .utf8)
                        case .data(let d):   data = d
                        @unknown default:    data = nil
                        }
                        if let data,
                           let event = try? decoder.decode(Event.self, from: data) {
                            continuation.yield(event)
                        }
                        receiveNext()
                    }
                }
            }
            receiveNext()

            continuation.onTermination = { _ in
                task.cancel(with: .goingAway, reason: nil)
            }
        }
    }

    // MARK: - private

    private func getJSON<T: Decodable>(path: String) async throws -> T {
        let url = baseURL.appendingPathComponent(path)
        do {
            let (data, response) = try await session.data(from: url)
            try Self.assertOK(response)
            do {
                return try decoder.decode(T.self, from: data)
            } catch {
                throw DaemonError.decoding(error)
            }
        } catch let e as DaemonError {
            throw e
        } catch {
            throw DaemonError.transport(error)
        }
    }

    /// JSON-in / JSON-out helper. Encodes `body` as the request body and
    /// decodes the response as `T`. Used by POST/PATCH endpoints.
    private func sendJSON<Body: Encodable, T: Decodable>(
        method: String,
        path: String,
        body: Body
    ) async throws -> T {
        let url = baseURL.appendingPathComponent(path)
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            req.httpBody = try encoder.encode(body)
        } catch {
            throw DaemonError.decoding(error)
        }
        do {
            let (data, response) = try await session.data(for: req)
            try Self.assertOK(response)
            do {
                return try decoder.decode(T.self, from: data)
            } catch {
                throw DaemonError.decoding(error)
            }
        } catch let e as DaemonError {
            throw e
        } catch {
            throw DaemonError.transport(error)
        }
    }

    private static func assertOK(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else {
            throw DaemonError.badResponse(-1)
        }
        guard (200..<300).contains(http.statusCode) else {
            throw DaemonError.badResponse(http.statusCode)
        }
    }
}

/// Wire shape for `POST /interventions`. Intentionally separate from
/// `Intervention` because the request omits server-owned fields
/// (`id`, `created_at`, `delivered_at`).
private struct InterventionRequestBody: Encodable {
    let workstreamID: String
    let kind: InterventionKind
    let payload: InterventionPayload

    enum CodingKeys: String, CodingKey {
        case workstreamID = "workstream_id"
        case kind
        case payload
    }
}

/// Wire shape for `POST /workstreams`.
private struct CreateWorkstreamBody: Encodable {
    let workstreamID: String
    let title: String

    enum CodingKeys: String, CodingKey {
        case workstreamID = "workstream_id"
        case title
    }
}

/// Wire shape for `PATCH /workstreams/:id`. Both fields optional — only the
/// keys present in the encoded JSON will be applied by the daemon.
private struct UpdateWorkstreamBody: Encodable {
    let status: Workstream.Status?
    let title: String?
}

/// Wire shape for `POST /handbook/skills`.
private struct AppendSkillBody: Encodable {
    let title: String
    let body: String
    let source: Source?

    struct Source: Encodable {
        let workstreamID: String?
        let decisionID: String?

        enum CodingKeys: String, CodingKey {
            case workstreamID = "workstream_id"
            case decisionID = "decision_id"
        }
    }
}

/// Wire shape for the `POST /handbook/skills` 201 response.
private struct AppendSkillResponse: Decodable {
    let title: String
}

/// Empty JSON body (`{}`) used for promote/dismiss POSTs that take no params.
private struct EmptyBody: Encodable {}

extension JSONDecoder.DateDecodingStrategy {
    /// ISO-8601 with optional fractional seconds, matching the daemon's
    /// `2026-05-02T22:30:14.123Z` shape.
    static let iso8601WithFractionalSeconds: JSONDecoder.DateDecodingStrategy = .custom { decoder in
        let container = try decoder.singleValueContainer()
        let raw = try container.decode(String.self)

        let fmtFractional = ISO8601DateFormatter()
        fmtFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = fmtFractional.date(from: raw) { return d }

        let fmtPlain = ISO8601DateFormatter()
        fmtPlain.formatOptions = [.withInternetDateTime]
        if let d = fmtPlain.date(from: raw) { return d }

        throw DecodingError.dataCorruptedError(
            in: container,
            debugDescription: "Not an ISO-8601 timestamp: \(raw)"
        )
    }
}

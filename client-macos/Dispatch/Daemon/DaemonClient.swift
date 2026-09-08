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
    /// v1.4.4 — pending interventions for a workstream (oldest first).
    /// Powers the approval-required strip in AgentDetailView.
    func listPendingInterventions(workstreamID: String) async throws -> [Intervention]
    /// v1.4.4 — record manager's Approve/Deny on an `approval_required`
    /// intervention. Server merges `payload.approval_decision = {approved}`
    /// and marks delivered atomically; emits an `intervention_delivered`
    /// event so the methodology timeline shows the decision.
    func decideApproval(workstreamID: String,
                        interventionID: String,
                        approved: Bool) async throws -> Intervention
    /// v1.4.7 — answer a `question_required` intervention. Pass either a
    /// `choice` matching one of the question's options or a `freetext`
    /// reply (only valid when the agent set `allow_freetext`). Server
    /// merges `payload.question_answer` and marks delivered atomically.
    func answerQuestion(workstreamID: String,
                        interventionID: String,
                        choice: String?,
                        freetext: String?) async throws -> Intervention

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

    // MARK: - v1.5: provider settings

    /// `GET /settings` — fetch the daemon's persisted LLM provider config.
    /// The response redacts the Anthropic API key to a boolean
    /// (`anthropicApiKeyConfigured`) so credentials never round-trip back to
    /// the client. The macOS Settings → Providers tab uses this to populate
    /// the form on open.
    func getSettings() async throws -> ProviderSettings

    /// `PATCH /settings` — partial update of the persisted LLM provider
    /// config. Pass `anthropicApiKey` cleartext to set, empty string to
    /// clear, or `nil` to leave untouched. Returns the redacted wire shape
    /// (same as GET).
    func patchSettings(_ patch: ProviderSettingsPatch) async throws -> ProviderSettings

    // MARK: - v1.4.20: orchestrator (autonomous mode)

    /// `GET /orchestrator/state` — snapshot of the autonomous loop: tracker
    /// kind, agent runtime, workflow file, counts, and per-run entries (with
    /// a tmux attach command when the runtime is `claude-code-tmux`).
    /// Returns `nil` when the daemon is observation-only (404).
    func getOrchestratorState() async throws -> OrchestratorState?

    /// `GET /links` — every persisted tracker link, keyed client-side by
    /// workstream id so the Radar can render a tracker chip per card with
    /// one request instead of N. Empty (not an error) when links aren't
    /// enabled on the daemon.
    func listLinks() async throws -> [WorkstreamLink]

    // MARK: - v1.2: Linear-link UI

    /// `GET /workstreams/:id/link` — current link for the workstream, or
    /// `nil` when no link exists. Powers the `LinearChip`'s linked vs
    /// unlinked state.
    func getWorkstreamLink(workstreamID: String) async throws -> WorkstreamLink?

    /// `PUT /workstreams/:id/link` — resolve a tracker identifier (e.g.
    /// `ENG-123`) to an issue and persist the link. Throws on 503 (no
    /// Linear key), 400 (unknown identifier), 404 (unknown workstream).
    func linkWorkstream(workstreamID: String,
                        trackerKind: String,
                        issueIdentifier: String) async throws -> WorkstreamLink

    /// `DELETE /workstreams/:id/link` — idempotent unlink. The daemon
    /// returns 200 even when no prior link existed.
    func unlinkWorkstream(workstreamID: String) async throws

    /// Returns `false` on connection error; never throws. Used by
    /// `DaemonResolver` to choose live vs mock at startup.
    func health() async -> Bool

    // MARK: - v1.4.6: Diagnostics tab

    /// `POST /admin/llm/kill` — find the PID listening on the configured
    /// local-LLM port and SIGTERM it (with a 3s grace period before
    /// SIGKILL). Returns the daemon's wire shape: `killed` is the PID we
    /// sent the signal to, or `nil` if nothing was running. `escalated`
    /// is true when SIGTERM didn't take and we had to SIGKILL.
    func killLLM() async throws -> KillLLMResult

    /// `POST /admin/llm/restart` — kill, then run `localLLMStartCommand`
    /// (configured in Settings → Providers) via `bash -lc` detached. Throws
    /// when the daemon returns 400 with `code: 'no_start_command'` so the
    /// UI can disable the button + show the configuration hint.
    func restartLLM() async throws -> RestartLLMResult

    /// `POST /admin/restart` — soft daemon restart: re-read settings.json,
    /// cancel + re-instantiate the background tickers (Headliner /
    /// SubgoalSynthesizer / LinearCommentSyncer). Process does NOT exit.
    func restartDaemon() async throws -> RestartDaemonResult

    /// `POST /admin/llm/pull-model` — v1.4.13. Synchronously runs
    /// `ollama pull <model>` and returns the captured tail of its
    /// output + exit code. The HTTP layer always returns 200 (even on a
    /// non-zero ollama exit) so the UI can surface the error message
    /// from `output` rather than a generic HTTP failure.
    func pullModel(_ model: String) async throws -> PullModelResult
}

// MARK: - v1.4.6 Diagnostics wire shapes

/// Wire shape of `POST /admin/llm/kill`. Always 200; `killed == nil`
/// means nothing was listening on the configured port.
struct KillLLMResult: Codable, Equatable, Sendable {
    var killed: Int?
    var escalated: Bool
    var error: String?
}

/// Wire shape of `POST /admin/llm/pull-model` 200. `ok` is true only
/// when ollama exited 0; non-zero exits surface as `ok=false` with the
/// stderr tail in `output`.
struct PullModelResult: Codable, Equatable, Sendable {
    var ok: Bool
    var exitCode: Int?
    var output: String
    var error: String?

    enum CodingKeys: String, CodingKey {
        case ok
        case exitCode = "exit_code"
        case output
        case error
    }
}

/// Wire shape of `POST /admin/llm/restart` 200. The daemon reports the
/// PID it killed (or nil) and a `started` boolean. The 400 path
/// (`code: 'no_start_command'`) surfaces as `DaemonError.badResponse(400)`
/// from the LiveDaemonClient — the Diagnostics view inspects the original
/// daemon response in the UI; the protocol-level type only carries 200s.
struct RestartLLMResult: Codable, Equatable, Sendable {
    /// Snake-case on the wire; camel-case on the Swift side.
    var killedPID: Int?
    var started: Bool
    var error: String?

    enum CodingKeys: String, CodingKey {
        case killedPID = "killed_pid"
        case started
        case error
    }
}

/// Wire shape of `POST /admin/restart`. The list of ticker names that the
/// daemon stopped + re-instantiated.
struct RestartDaemonResult: Codable, Equatable, Sendable {
    var restarted: [String]
}

/// Redacted wire shape of `GET /settings`. Mirrors the daemon's
/// `SettingsWire` (see `daemon/src/settings-store.ts`). Note the API key is
/// represented only as a boolean — there is no `anthropicApiKey` field on
/// this type by design.
struct ProviderSettings: Codable, Equatable, Sendable {
    enum Provider: String, Codable, Sendable, CaseIterable, Identifiable {
        case claude
        case ollama
        var id: Self { self }
        var displayName: String { self == .claude ? "Claude" : "Ollama (local)" }
    }

    var headlineProvider: Provider
    var headlineModel: String
    var ollamaURL: String
    var anthropicAPIKeyConfigured: Bool
    /// v1.2 — true when the daemon has a Linear key on file (settings
    /// file or DISPATCH_LINEAR_API_KEY env). Drives the Providers tab
    /// "Linear API key" section's "configured" hint.
    var linearAPIKeyConfigured: Bool = false
    /// v1.4.6 — the shell command the Diagnostics tab's "Restart Local
    /// LLM" button runs. Cleartext on the wire (it's a command, not a
    /// credential). Empty string when unset.
    var localLLMStartCommand: String = ""

    enum CodingKeys: String, CodingKey {
        case headlineProvider
        case headlineModel
        case ollamaURL = "ollamaUrl"
        case anthropicAPIKeyConfigured = "anthropicApiKeyConfigured"
        case linearAPIKeyConfigured = "linearApiKeyConfigured"
        case localLLMStartCommand = "localLLMStartCommand"
    }

    init(
        headlineProvider: Provider,
        headlineModel: String,
        ollamaURL: String,
        anthropicAPIKeyConfigured: Bool,
        linearAPIKeyConfigured: Bool = false,
        localLLMStartCommand: String = ""
    ) {
        self.headlineProvider = headlineProvider
        self.headlineModel = headlineModel
        self.ollamaURL = ollamaURL
        self.anthropicAPIKeyConfigured = anthropicAPIKeyConfigured
        self.linearAPIKeyConfigured = linearAPIKeyConfigured
        self.localLLMStartCommand = localLLMStartCommand
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.headlineProvider = try c.decode(Provider.self, forKey: .headlineProvider)
        self.headlineModel = try c.decode(String.self, forKey: .headlineModel)
        self.ollamaURL = try c.decode(String.self, forKey: .ollamaURL)
        self.anthropicAPIKeyConfigured = try c.decode(Bool.self, forKey: .anthropicAPIKeyConfigured)
        // Older daemons predating the linear key field default to false.
        self.linearAPIKeyConfigured =
            try c.decodeIfPresent(Bool.self, forKey: .linearAPIKeyConfigured) ?? false
        // Older daemons predating v1.4.6 don't ship localLLMStartCommand;
        // default to "" so the UI treats it as unconfigured.
        self.localLLMStartCommand =
            try c.decodeIfPresent(String.self, forKey: .localLLMStartCommand) ?? ""
    }
}

/// Wire shape of `PATCH /settings`. Each field is optional; only present
/// keys are applied. Pass `anthropicAPIKey = ""` to clear the stored key.
struct ProviderSettingsPatch: Codable, Equatable, Sendable {
    var headlineProvider: ProviderSettings.Provider?
    var headlineModel: String?
    var ollamaURL: String?
    var anthropicAPIKey: String?
    /// v1.2 — same redaction pattern as `anthropicAPIKey`. Empty string
    /// clears the stored value; `nil` leaves it untouched.
    var linearAPIKey: String?
    /// v1.4.6 — the local-LLM start command. Cleartext on the wire
    /// (not a credential). Empty string clears the value; `nil` leaves
    /// it untouched (so the existing Save button doesn't clobber the
    /// user's stored command on every save).
    var localLLMStartCommand: String?

    enum CodingKeys: String, CodingKey {
        case headlineProvider
        case headlineModel
        case ollamaURL = "ollamaUrl"
        case anthropicAPIKey = "anthropicApiKey"
        case linearAPIKey = "linearApiKey"
        case localLLMStartCommand = "localLLMStartCommand"
    }
}

enum DaemonError: Error, LocalizedError {
    case badURL
    case badResponse(Int, message: String? = nil)
    case decoding(Error)
    case transport(Error)

    var errorDescription: String? {
        switch self {
        case .badURL:
            return "Bad daemon URL."
        case .badResponse(let code, let message):
            if let message, !message.isEmpty { return message }
            return "Daemon returned HTTP \(code)."
        case .decoding(let e):
            return "Could not decode daemon response: \(e)"
        case .transport(let e):
            return "Transport error: \(e)"
        }
    }
}

/// Wire shape of the daemon's JSON error envelope: `{ "error": "...",
/// "code": "...", "upstream_status": 404 }`. Only `error` is required;
/// other fields are best-effort context for callers that want them.
private struct DaemonErrorBody: Decodable {
    let error: String?
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
        // Lossy decode: skip rows whose payload doesn't fit the Swift
        // event model rather than failing the whole array. Schema drift
        // (e.g. a hook payload key the client hasn't seen yet) shouldn't
        // empty the timeline.
        let arr: [FailableEvent] = try await getJSON(path: "workstreams/\(workstreamID)/events")
        return arr.compactMap(\.event)
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

    func listPendingInterventions(workstreamID: String) async throws -> [Intervention] {
        return try await getJSON(
            path: "workstreams/\(workstreamID)/interventions/pending"
        )
    }

    func decideApproval(workstreamID: String,
                        interventionID: String,
                        approved: Bool) async throws -> Intervention {
        struct Body: Encodable { let approved: Bool }
        let path = "workstreams/\(workstreamID)/interventions/\(interventionID)/decide"
        return try await sendJSON(method: "POST", path: path, body: Body(approved: approved))
    }

    func answerQuestion(workstreamID: String,
                        interventionID: String,
                        choice: String?,
                        freetext: String?) async throws -> Intervention {
        struct Body: Encodable {
            let choice: String?
            let freetext: String?
        }
        let path = "workstreams/\(workstreamID)/interventions/\(interventionID)/answer"
        return try await sendJSON(
            method: "POST",
            path: path,
            body: Body(choice: choice, freetext: freetext)
        )
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

    func getSettings() async throws -> ProviderSettings {
        try await getJSON(path: "settings")
    }

    func patchSettings(_ patch: ProviderSettingsPatch) async throws -> ProviderSettings {
        try await sendJSON(method: "PATCH", path: "settings", body: patch)
    }

    // MARK: - v1.4.20: orchestrator (autonomous mode)

    func getOrchestratorState() async throws -> OrchestratorState? {
        do {
            return try await getJSON(path: "orchestrator/state")
        } catch DaemonError.badResponse(404, _) {
            // Observation-only daemon (no --workflow / --mock-tracker).
            return nil
        }
    }

    func listLinks() async throws -> [WorkstreamLink] {
        do {
            return try await getJSON(path: "links")
        } catch DaemonError.badResponse(404, _) {
            // Daemon built without a links store.
            return []
        }
    }

    // MARK: - v1.2: Linear-link UI

    func getWorkstreamLink(workstreamID: String) async throws -> WorkstreamLink? {
        let url = baseURL.appendingPathComponent("workstreams/\(workstreamID)/link")
        do {
            let (data, response) = try await session.data(from: url)
            try Self.assertOK(response)
            // Empty body or `null` → no link.
            if data.isEmpty {
                return nil
            }
            // The daemon writes `null` as the JSON body when no link exists.
            if let s = String(data: data, encoding: .utf8),
               s.trimmingCharacters(in: .whitespacesAndNewlines) == "null" {
                return nil
            }
            do {
                return try decoder.decode(WorkstreamLink.self, from: data)
            } catch {
                throw DaemonError.decoding(error)
            }
        } catch let e as DaemonError {
            throw e
        } catch {
            throw DaemonError.transport(error)
        }
    }

    func linkWorkstream(workstreamID: String,
                        trackerKind: String,
                        issueIdentifier: String) async throws -> WorkstreamLink {
        let body = LinkWorkstreamBody(trackerKind: trackerKind, issueIdentifier: issueIdentifier)
        return try await sendJSON(
            method: "PUT",
            path: "workstreams/\(workstreamID)/link",
            body: body
        )
    }

    func unlinkWorkstream(workstreamID: String) async throws {
        let url = baseURL.appendingPathComponent("workstreams/\(workstreamID)/link")
        var req = URLRequest(url: url)
        req.httpMethod = "DELETE"
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let (_, response) = try await session.data(for: req)
            try Self.assertOK(response)
        } catch let e as DaemonError {
            throw e
        } catch {
            throw DaemonError.transport(error)
        }
    }

    // MARK: - v1.4.6: Diagnostics tab

    func killLLM() async throws -> KillLLMResult {
        try await sendJSON(method: "POST", path: "admin/llm/kill", body: EmptyBody())
    }

    func restartLLM() async throws -> RestartLLMResult {
        try await sendJSON(method: "POST", path: "admin/llm/restart", body: EmptyBody())
    }

    func restartDaemon() async throws -> RestartDaemonResult {
        try await sendJSON(method: "POST", path: "admin/restart", body: EmptyBody())
    }

    func pullModel(_ model: String) async throws -> PullModelResult {
        struct Body: Encodable { let model: String }
        return try await sendJSON(
            method: "POST",
            path: "admin/llm/pull-model",
            body: Body(model: model)
        )
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
            try Self.assertOK(response, data: data)
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
        try assertOK(response, data: nil)
    }

    private static func assertOK(_ response: URLResponse, data: Data?) throws {
        guard let http = response as? HTTPURLResponse else {
            throw DaemonError.badResponse(-1)
        }
        guard (200..<300).contains(http.statusCode) else {
            let message = data.flatMap(decodeDaemonErrorMessage)
            throw DaemonError.badResponse(http.statusCode, message: message)
        }
    }

    private static func decodeDaemonErrorMessage(_ data: Data) -> String? {
        guard !data.isEmpty,
              let body = try? JSONDecoder().decode(DaemonErrorBody.self, from: data),
              let message = body.error,
              !message.isEmpty else {
            return nil
        }
        return message
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

/// Wire shape for `PUT /workstreams/:id/link`.
private struct LinkWorkstreamBody: Encodable {
    let trackerKind: String
    let issueIdentifier: String

    enum CodingKeys: String, CodingKey {
        case trackerKind = "tracker_kind"
        case issueIdentifier = "issue_identifier"
    }
}

/// Wrapper that decodes an `Event` if possible and stores `nil` otherwise.
/// Used when the daemon returns an array of events: a single bad row
/// shouldn't blank out the entire timeline.
private struct FailableEvent: Decodable {
    let event: Event?
    init(from decoder: Decoder) throws {
        self.event = try? Event(from: decoder)
    }
}

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

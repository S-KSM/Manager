import Foundation

/// Mirrors `GET /orchestrator/state` (Symphony §13.7.2 snapshot + the v1.4.20
/// enrichment). `nil` client-side means the daemon answered 404 — it was
/// started without `--workflow` / `--mock-tracker` and is observation-only.
///
/// Everything beyond `counts`/`running`/`retrying` is optional so a pre-1.4.20
/// daemon (no `tracker_kind` / `agent_runtime` / `workflow_path` / per-entry
/// `workstream_id` + `attach`) still decodes.
struct OrchestratorState: Codable, Hashable, Sendable {
    struct Counts: Codable, Hashable, Sendable {
        let running: Int
        let retrying: Int
        let claimed: Int
        let completed: Int
    }

    struct Attach: Codable, Hashable, Sendable {
        let tmuxSession: String
        /// Paste-ready `tmux attach -t …`.
        let command: String

        enum CodingKeys: String, CodingKey {
            case tmuxSession = "tmux_session"
            case command
        }
    }

    struct RunningEntry: Codable, Hashable, Sendable, Identifiable {
        let issueID: String
        let identifier: String
        let workspacePath: String?
        let startedAt: Date
        let attempt: Int?
        /// Radar workstream id this run maps to (same derivation as
        /// `DISPATCH_WORKSTREAM`). Absent on pre-1.4.20 daemons.
        let workstreamID: String?
        /// Present only for the `claude-code-tmux` runtime while the pane is
        /// alive — the human can take the wheel mid-flight.
        let attach: Attach?

        var id: String { issueID }

        enum CodingKeys: String, CodingKey {
            case issueID = "issue_id"
            case identifier
            case workspacePath = "workspace_path"
            case startedAt = "started_at"
            case attempt
            case workstreamID = "workstream_id"
            case attach
        }
    }

    struct RetryEntry: Codable, Hashable, Sendable, Identifiable {
        let issueID: String
        let identifier: String
        let attempt: Int
        let dueAtMs: Double
        let error: String?

        var id: String { issueID }

        enum CodingKeys: String, CodingKey {
            case issueID = "issue_id"
            case identifier
            case attempt
            case dueAtMs = "due_at_ms"
            case error
        }
    }

    let pollIntervalMs: Int
    let maxConcurrentAgents: Int
    let counts: Counts
    let running: [RunningEntry]
    let retrying: [RetryEntry]
    let trackerKind: String?
    let agentRuntime: String?
    let workflowPath: String?

    enum CodingKeys: String, CodingKey {
        case pollIntervalMs = "poll_interval_ms"
        case maxConcurrentAgents = "max_concurrent_agents"
        case counts
        case running
        case retrying
        case trackerKind = "tracker_kind"
        case agentRuntime = "agent_runtime"
        case workflowPath = "workflow_path"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pollIntervalMs = try c.decodeIfPresent(Int.self, forKey: .pollIntervalMs) ?? 0
        maxConcurrentAgents = try c.decodeIfPresent(Int.self, forKey: .maxConcurrentAgents) ?? 0
        counts = try c.decode(Counts.self, forKey: .counts)
        running = try c.decodeIfPresent([RunningEntry].self, forKey: .running) ?? []
        retrying = try c.decodeIfPresent([RetryEntry].self, forKey: .retrying) ?? []
        trackerKind = try c.decodeIfPresent(String.self, forKey: .trackerKind)
        agentRuntime = try c.decodeIfPresent(String.self, forKey: .agentRuntime)
        workflowPath = try c.decodeIfPresent(String.self, forKey: .workflowPath)
    }

    init(
        pollIntervalMs: Int = 30_000,
        maxConcurrentAgents: Int = 3,
        counts: Counts,
        running: [RunningEntry] = [],
        retrying: [RetryEntry] = [],
        trackerKind: String? = nil,
        agentRuntime: String? = nil,
        workflowPath: String? = nil
    ) {
        self.pollIntervalMs = pollIntervalMs
        self.maxConcurrentAgents = maxConcurrentAgents
        self.counts = counts
        self.running = running
        self.retrying = retrying
        self.trackerKind = trackerKind
        self.agentRuntime = agentRuntime
        self.workflowPath = workflowPath
    }

    /// The running entry for a Radar workstream, if the orchestrator is
    /// driving it right now.
    func running(for workstreamID: String) -> RunningEntry? {
        running.first { $0.workstreamID == workstreamID }
    }

    /// Human label for the tracker kind on the wire.
    var trackerDisplayName: String {
        switch trackerKind {
        case "linear": return "Linear"
        case "team-brain": return "team-brain"
        case "mock": return "Mock tracker"
        case let other?: return other
        case nil: return "—"
        }
    }

    /// Human label for the agent runtime on the wire.
    var runtimeDisplayName: String {
        switch agentRuntime {
        case "claude-code": return "Claude Code (headless)"
        case "claude-code-tmux": return "Claude Code in tmux"
        case "codex": return "Codex"
        case let other?: return other
        case nil: return "—"
        }
    }

    var isTmuxRuntime: Bool { agentRuntime == "claude-code-tmux" }
}

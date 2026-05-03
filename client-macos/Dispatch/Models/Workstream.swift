import Foundation
import SwiftUI

/// Mirrors the daemon's Workstream record (see docs/ARCHITECTURE.md > "Workstream").
///
/// The persistent on-disk shape lives in the daemon's SQLite index; this struct
/// is the wire-level representation the HTTP API serves to clients. Fields that
/// the daemon may not yet ship (current sub-goal, latest confidence, attention
/// flag) are derived projections kept here as optionals so the client can render
/// them when present and degrade gracefully when not.
struct Workstream: Identifiable, Codable, Hashable, Sendable {
    enum Status: String, Codable, Sendable, CaseIterable {
        case active
        case paused
        case retired
    }

    let id: String                // workstream_id (slug)
    let title: String
    let createdAt: Date
    let status: Status
    let memoryPath: String?
    let sessions: [String]

    // --- projections served by the daemon's `/workstreams` endpoint for the
    // home view. Optional so the model survives a leaner response shape.
    let currentSubgoal: String?
    let latestConfidence: Double?
    let needsAttention: Bool
    /// Latest TodoWrite tool_use's todo array (Feature B). nil = the agent
    /// hasn't called TodoWrite yet on this workstream — fall back to
    /// `latestActivity` for the "Currently:" line.
    let todos: [Todo]?
    /// Humanized one-liner for the most recent tool_use event (Feature A).
    /// Used as the "Currently:" line when `todos` is nil/empty.
    let latestActivity: String?
    let lastEventAt: Date?

    init(
        id: String,
        title: String,
        createdAt: Date,
        status: Status,
        memoryPath: String? = nil,
        sessions: [String] = [],
        currentSubgoal: String? = nil,
        latestConfidence: Double? = nil,
        needsAttention: Bool = false,
        todos: [Todo]? = nil,
        latestActivity: String? = nil,
        lastEventAt: Date? = nil
    ) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.status = status
        self.memoryPath = memoryPath
        self.sessions = sessions
        self.currentSubgoal = currentSubgoal
        self.latestConfidence = latestConfidence
        self.needsAttention = needsAttention
        self.todos = todos
        self.latestActivity = latestActivity
        self.lastEventAt = lastEventAt
    }

    enum CodingKeys: String, CodingKey {
        case id = "workstream_id"
        case title
        case createdAt = "created_at"
        case status
        case memoryPath = "memory_path"
        case sessions
        case currentSubgoal = "current_subgoal"
        case latestConfidence = "latest_confidence"
        case needsAttention = "needs_attention"
        case todos
        case latestActivity = "latest_activity"
        case lastEventAt = "last_event_at"
    }
}

/// Mirrors Claude Code's TodoWrite item shape. Decoded from the daemon's
/// `todos` projection (which strips malformed rows server-side, so this stays
/// a lean Codable struct on the client).
///
/// `Identifiable` uses `content` as the id. TodoWrite items are unique by
/// slot per agent convention; if the agent ever ships duplicate contents the
/// list will collapse them — acceptable for v1, glanceable display only.
struct Todo: Codable, Hashable, Identifiable, Sendable {
    enum Status: String, Codable, Sendable {
        case pending
        case inProgress = "in_progress"
        case completed
    }

    let content: String
    let status: Status
    let activeForm: String?

    var id: String { content }
}

extension Workstream {
    var statusColor: Color {
        switch status {
        case .active:  return .green
        case .paused:  return .yellow
        case .retired: return .gray
        }
    }

    var statusLabel: String {
        switch status {
        case .active:  return "Active"
        case .paused:  return "Paused"
        case .retired: return "Retired"
        }
    }
}

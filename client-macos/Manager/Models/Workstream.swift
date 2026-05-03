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
        case lastEventAt = "last_event_at"
    }
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

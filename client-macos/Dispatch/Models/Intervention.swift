import Foundation

/// Wire-level representation of a human-issued intervention (see
/// docs/ARCHITECTURE.md > "Intervention").
///
/// The daemon persists these records in its SQLite intervention queue and
/// drains them via the agent's `UserPromptSubmit` hook. The macOS client
/// posts them via `POST /interventions` and receives the persisted record
/// back so the UI can show created/delivered timestamps.
enum InterventionKind: String, Codable, CaseIterable, Sendable {
    case nudge
    case redirect
    case rollback
}

struct Intervention: Codable, Identifiable, Sendable, Hashable {
    let id: String
    let workstreamID: String
    let kind: InterventionKind
    let payload: InterventionPayload
    let createdAt: Date
    let deliveredAt: Date?

    init(
        id: String,
        workstreamID: String,
        kind: InterventionKind,
        payload: InterventionPayload,
        createdAt: Date,
        deliveredAt: Date? = nil
    ) {
        self.id = id
        self.workstreamID = workstreamID
        self.kind = kind
        self.payload = payload
        self.createdAt = createdAt
        self.deliveredAt = deliveredAt
    }

    enum CodingKeys: String, CodingKey {
        case id
        case workstreamID = "workstream_id"
        case kind
        case payload
        case createdAt   = "created_at"
        case deliveredAt = "delivered_at"
    }
}

struct InterventionPayload: Codable, Sendable, Hashable {
    let message: String?
    let rollbackToDecisionID: String?

    init(message: String? = nil, rollbackToDecisionID: String? = nil) {
        self.message = message
        self.rollbackToDecisionID = rollbackToDecisionID
    }

    enum CodingKeys: String, CodingKey {
        case message
        case rollbackToDecisionID = "rollback_to_decision_id"
    }
}

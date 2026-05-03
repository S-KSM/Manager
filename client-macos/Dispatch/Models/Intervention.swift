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
    /// v1.4.4 — agent (or runtime) is asking for permission to do something.
    /// The manager must ack with `payload.approval_decision = { approved: bool }`.
    case approvalRequired = "approval_required"
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
    /// v1.4.4 (`approval_required` only) — what the agent wants permission for.
    let approvalRequest: ApprovalRequest?
    /// v1.4.4 (`approval_required` only) — manager's decision attached on ack.
    let approvalDecision: ApprovalDecision?

    init(
        message: String? = nil,
        rollbackToDecisionID: String? = nil,
        approvalRequest: ApprovalRequest? = nil,
        approvalDecision: ApprovalDecision? = nil
    ) {
        self.message = message
        self.rollbackToDecisionID = rollbackToDecisionID
        self.approvalRequest = approvalRequest
        self.approvalDecision = approvalDecision
    }

    enum CodingKeys: String, CodingKey {
        case message
        case rollbackToDecisionID = "rollback_to_decision_id"
        case approvalRequest      = "approval_request"
        case approvalDecision     = "approval_decision"
    }
}

struct ApprovalRequest: Codable, Sendable, Hashable {
    let summary: String?
    let tool: String?
    let detail: String?
}

struct ApprovalDecision: Codable, Sendable, Hashable {
    let approved: Bool
}

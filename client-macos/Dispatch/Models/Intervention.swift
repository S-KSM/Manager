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
    /// v1.4.7 — agent is asking the manager a question (`mcp__dispatch__ask_user`).
    /// The manager answers via `POST /workstreams/:id/interventions/:intId/answer`.
    case questionRequired = "question_required"
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
    /// v1.4.7 (`question_required` only) — agent's question + options.
    let questionRequest: QuestionRequest?
    /// v1.4.7 (`question_required` only) — manager's chosen option / freetext.
    let questionAnswer: QuestionAnswer?

    init(
        message: String? = nil,
        rollbackToDecisionID: String? = nil,
        approvalRequest: ApprovalRequest? = nil,
        approvalDecision: ApprovalDecision? = nil,
        questionRequest: QuestionRequest? = nil,
        questionAnswer: QuestionAnswer? = nil
    ) {
        self.message = message
        self.rollbackToDecisionID = rollbackToDecisionID
        self.approvalRequest = approvalRequest
        self.approvalDecision = approvalDecision
        self.questionRequest = questionRequest
        self.questionAnswer = questionAnswer
    }

    enum CodingKeys: String, CodingKey {
        case message
        case rollbackToDecisionID = "rollback_to_decision_id"
        case approvalRequest      = "approval_request"
        case approvalDecision     = "approval_decision"
        case questionRequest      = "question_request"
        case questionAnswer       = "question_answer"
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

/// v1.4.7 — wire shape of the agent's `ask_user` payload.
struct QuestionRequest: Codable, Sendable, Hashable {
    let question: String
    let options: [String]?
    let allowFreetext: Bool?
    let context: String?

    enum CodingKeys: String, CodingKey {
        case question
        case options
        case allowFreetext = "allow_freetext"
        case context
    }
}

/// v1.4.7 — manager's reply attached to a delivered `question_required`.
struct QuestionAnswer: Codable, Sendable, Hashable {
    let choice: String?
    let freetext: String?
}

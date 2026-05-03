import Foundation

/// Wire-level representation of a proposed skill (see docs/ARCHITECTURE.md >
/// "Skill broadcast").
///
/// Agents call the `propose_skill` MCP tool when they discover a generally
/// useful pattern. The daemon persists the proposal and the manager (human +
/// macOS app) decides whether to promote it into the team handbook so all
/// agents pick it up at SessionStart, or dismiss it.
enum SkillStatus: String, Codable, Sendable, CaseIterable {
    case proposed
    case promoted
    case dismissed
}

struct SkillProposal: Codable, Identifiable, Sendable, Hashable {
    let id: String
    let workstreamID: String
    let title: String
    let body: String
    let sourceDecisionID: String?
    let proposedAt: Date
    let status: SkillStatus

    init(
        id: String,
        workstreamID: String,
        title: String,
        body: String,
        sourceDecisionID: String? = nil,
        proposedAt: Date,
        status: SkillStatus
    ) {
        self.id = id
        self.workstreamID = workstreamID
        self.title = title
        self.body = body
        self.sourceDecisionID = sourceDecisionID
        self.proposedAt = proposedAt
        self.status = status
    }

    enum CodingKeys: String, CodingKey {
        case id
        case workstreamID = "workstream_id"
        case title
        case body
        case sourceDecisionID = "source_decision_id"
        case proposedAt = "proposed_at"
        case status
    }
}

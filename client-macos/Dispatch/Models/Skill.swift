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
    /// v1.4.20 — set on the `POST /skills/proposed/:id/promote` response when
    /// the daemon also mirrored the skill into a team-brain checkout
    /// (`DISPATCH_TEAM_BRAIN_DIR`). Absent otherwise; never on list responses.
    let teamBrainPath: String?

    init(
        id: String,
        workstreamID: String,
        title: String,
        body: String,
        sourceDecisionID: String? = nil,
        proposedAt: Date,
        status: SkillStatus,
        teamBrainPath: String? = nil
    ) {
        self.id = id
        self.workstreamID = workstreamID
        self.title = title
        self.body = body
        self.sourceDecisionID = sourceDecisionID
        self.proposedAt = proposedAt
        self.status = status
        self.teamBrainPath = teamBrainPath
    }

    enum CodingKeys: String, CodingKey {
        case id
        case workstreamID = "workstream_id"
        case title
        case body
        case sourceDecisionID = "source_decision_id"
        case proposedAt = "proposed_at"
        case status
        case teamBrainPath = "team_brain_path"
    }
}

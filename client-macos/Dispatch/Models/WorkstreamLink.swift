import Foundation

/// Mirrors the daemon's `WorkstreamLink` wire shape served by
/// `GET/PUT /workstreams/:id/link` and `GET /links` (snake_case JSON).
struct WorkstreamLink: Codable, Hashable, Identifiable, Sendable {
    let workstreamID: String
    let trackerKind: String
    let issueID: String
    let issueIdentifier: String
    let issueURL: String?
    let lastSeenState: String?
    let lastSyncedAt: Date?
    let createdAt: Date

    /// Identifiable for SwiftUI lists/menus. The workstream is the natural
    /// primary key for a link (a workstream has at most one).
    var id: String { workstreamID }

    enum CodingKeys: String, CodingKey {
        case workstreamID = "workstream_id"
        case trackerKind = "tracker_kind"
        case issueID = "issue_id"
        case issueIdentifier = "issue_identifier"
        case issueURL = "issue_url"
        case lastSeenState = "last_seen_state"
        case lastSyncedAt = "last_synced_at"
        case createdAt = "created_at"
    }
}

/// v1.4.20 — tracker-aware presentation. `tracker_kind` was on the wire
/// since v1.2 but every view assumed Linear; team-brain links (plans as
/// tickets, created by the orchestrator at dispatch) need different copy
/// and a different "open" action (a local `file://` plan, not a web URL).
extension WorkstreamLink {
    var isTeamBrain: Bool { trackerKind == "team-brain" }

    /// Human name for the tracker, used in menus and help text.
    var trackerDisplayName: String {
        switch trackerKind {
        case "linear": return "Linear"
        case "team-brain": return "team-brain"
        default: return trackerKind
        }
    }

    /// What to call the linked thing: an "issue" for a ticket tracker, a
    /// "plan" for team-brain.
    var noun: String { isTeamBrain ? "plan" : "issue" }

    /// Menu label for the open action.
    var openLabel: String { isTeamBrain ? "Open plan" : "Open in \(trackerDisplayName)" }

    /// SF Symbol that distinguishes the tracker at a glance.
    var symbolName: String { isTeamBrain ? "doc.text" : "link" }

    /// Short identifier for chips: team-brain identifiers are plan paths
    /// like `1st10s/mvp/phase-1-foundation` — show the last segment, keep
    /// the full path for the help/tooltip.
    var shortIdentifier: String {
        guard isTeamBrain, let last = issueIdentifier.split(separator: "/").last else {
            return issueIdentifier
        }
        return String(last)
    }

    /// Resolved open target. `file://` URLs open in the default handler
    /// (editor/Finder); everything else is a web link.
    var openURL: URL? { issueURL.flatMap(URL.init(string:)) }
}

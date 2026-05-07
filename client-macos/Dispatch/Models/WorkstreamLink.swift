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

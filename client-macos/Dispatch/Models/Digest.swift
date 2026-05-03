import Foundation

/// Wire-level representation of the morning digest (see docs/ARCHITECTURE.md >
/// "Digest").
///
/// `GET /digest?since=<iso8601>` returns an aggregate summary across all
/// workstreams since the timestamp (default: 24h ago). The macOS client
/// renders this in the home view's digest rail.
struct DigestTotals: Codable, Sendable, Hashable {
    let shipped: Int
    let blocked: Int
    let needsAttention: Int
    let active: Int

    init(shipped: Int, blocked: Int, needsAttention: Int, active: Int) {
        self.shipped = shipped
        self.blocked = blocked
        self.needsAttention = needsAttention
        self.active = active
    }

    enum CodingKeys: String, CodingKey {
        case shipped
        case blocked
        case active
        case needsAttention = "needs_attention"
    }
}

struct DigestHighlight: Codable, Sendable, Identifiable, Hashable {
    let workstreamID: String
    let title: String
    let summary: String

    var id: String { workstreamID }

    init(workstreamID: String, title: String, summary: String) {
        self.workstreamID = workstreamID
        self.title = title
        self.summary = summary
    }

    enum CodingKeys: String, CodingKey {
        case workstreamID = "workstream_id"
        case title
        case summary
    }
}

struct Digest: Codable, Sendable, Hashable {
    let since: Date
    let totals: DigestTotals
    let highlights: [DigestHighlight]

    init(since: Date, totals: DigestTotals, highlights: [DigestHighlight]) {
        self.since = since
        self.totals = totals
        self.highlights = highlights
    }
}

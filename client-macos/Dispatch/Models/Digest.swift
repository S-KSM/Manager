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

/// Per-bucket workstream-id membership matching `DigestTotals`. Daemon side
/// in `daemon/src/digest.ts` (`DigestBuckets`). Lets the client filter the
/// Radar to a single bucket without re-implementing the predicate.
///
/// Optional fields default to empty arrays so a daemon that hasn't been
/// upgraded yet still decodes (the client just falls back to its
/// model-level predicates when the array is empty).
struct DigestBuckets: Codable, Sendable, Hashable {
    let shipped: [String]
    let blocked: [String]
    let needsAttention: [String]
    let active: [String]

    init(shipped: [String] = [], blocked: [String] = [], needsAttention: [String] = [], active: [String] = []) {
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

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.shipped = try c.decodeIfPresent([String].self, forKey: .shipped) ?? []
        self.blocked = try c.decodeIfPresent([String].self, forKey: .blocked) ?? []
        self.needsAttention = try c.decodeIfPresent([String].self, forKey: .needsAttention) ?? []
        self.active = try c.decodeIfPresent([String].self, forKey: .active) ?? []
    }
}

struct Digest: Codable, Sendable, Hashable {
    let since: Date
    let totals: DigestTotals
    let buckets: DigestBuckets
    let highlights: [DigestHighlight]
    /// Workstream ids whose latest `session_start` is newer than its latest
    /// `session_end` — i.e. there's a Claude Code session running right now.
    /// Empty when no daemon ever wrote the field (pre-feature build), which
    /// the client treats as "unknown — render robots awake".
    let liveSessions: [String]

    init(
        since: Date,
        totals: DigestTotals,
        buckets: DigestBuckets = DigestBuckets(),
        highlights: [DigestHighlight],
        liveSessions: [String] = []
    ) {
        self.since = since
        self.totals = totals
        self.buckets = buckets
        self.highlights = highlights
        self.liveSessions = liveSessions
    }

    enum CodingKeys: String, CodingKey {
        case since
        case totals
        case buckets
        case highlights
        case liveSessions = "live_sessions"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.since = try c.decode(Date.self, forKey: .since)
        self.totals = try c.decode(DigestTotals.self, forKey: .totals)
        // Backwards-compat: pre-bucket daemon responses won't include this.
        self.buckets = try c.decodeIfPresent(DigestBuckets.self, forKey: .buckets) ?? DigestBuckets()
        self.highlights = try c.decode([DigestHighlight].self, forKey: .highlights)
        self.liveSessions = try c.decodeIfPresent([String].self, forKey: .liveSessions) ?? []
    }
}

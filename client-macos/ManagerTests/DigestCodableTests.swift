import XCTest
@testable import Manager

final class DigestCodableTests: XCTestCase {

    func testDigestDecodesFromWireSchema() throws {
        // Verbatim from docs/ARCHITECTURE.md > "Digest"
        let json = #"""
        {
          "since": "2026-05-02T08:00:00Z",
          "totals": {"shipped": 2, "blocked": 1, "needs_attention": 1, "active": 5},
          "highlights": [
            {"workstream_id": "frontend-refactor", "title": "Frontend refactor",
             "summary": "shipped 3 decisions, current confidence 0.78"},
            {"workstream_id": "auth-hardening", "title": "Auth hardening",
             "summary": "blocked: refresh-token reuse window"}
          ]
        }
        """#

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601WithFractionalSeconds
        let digest = try decoder.decode(Digest.self, from: Data(json.utf8))

        XCTAssertEqual(digest.totals.shipped, 2)
        XCTAssertEqual(digest.totals.blocked, 1)
        XCTAssertEqual(digest.totals.needsAttention, 1)
        XCTAssertEqual(digest.totals.active, 5)
        XCTAssertEqual(digest.highlights.count, 2)
        XCTAssertEqual(digest.highlights.first?.workstreamID, "frontend-refactor")

        let expected = ISO8601DateFormatter().date(from: "2026-05-02T08:00:00Z")!
        XCTAssertEqual(
            digest.since.timeIntervalSince1970,
            expected.timeIntervalSince1970,
            accuracy: 1.0
        )
    }

    func testDigestRoundTripsAndUsesSnakeCaseKeys() throws {
        let original = Digest(
            since: ISO8601DateFormatter().date(from: "2026-05-02T08:00:00Z")!,
            totals: DigestTotals(shipped: 3, blocked: 1, needsAttention: 2, active: 4),
            highlights: [
                DigestHighlight(
                    workstreamID: "infra-cost",
                    title: "Infra cost audit",
                    summary: "compute audit complete; storage next"
                ),
                DigestHighlight(
                    workstreamID: "auth-hardening",
                    title: "Auth hardening",
                    summary: "blocked on rotation strategy call"
                )
            ]
        )

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(original)

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601WithFractionalSeconds
        let decoded = try decoder.decode(Digest.self, from: data)
        XCTAssertEqual(decoded, original)

        // Snake-case wire keys.
        let raw = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        let totals = try XCTUnwrap(raw["totals"] as? [String: Any])
        XCTAssertNotNil(totals["needs_attention"])
        XCTAssertNotNil(totals["shipped"])
        let highlights = try XCTUnwrap(raw["highlights"] as? [[String: Any]])
        XCTAssertNotNil(highlights.first?["workstream_id"])
    }

    func testEmptyHighlightsArrayDecodes() throws {
        let json = #"""
        {
          "since": "2026-05-02T00:00:00Z",
          "totals": {"shipped": 0, "blocked": 0, "needs_attention": 0, "active": 0},
          "highlights": []
        }
        """#
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601WithFractionalSeconds
        let digest = try decoder.decode(Digest.self, from: Data(json.utf8))
        XCTAssertTrue(digest.highlights.isEmpty)
        XCTAssertEqual(digest.totals.active, 0)
    }
}

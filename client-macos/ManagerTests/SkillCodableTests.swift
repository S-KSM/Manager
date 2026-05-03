import XCTest
@testable import Manager

final class SkillCodableTests: XCTestCase {

    func testProposalDecodesFromWireSchema() throws {
        // Verbatim wire shape from docs/ARCHITECTURE.md > "Skill broadcast"
        let json = #"""
        {
          "id": "skill_77",
          "workstream_id": "frontend-refactor",
          "title": "Co-locate query keys with components",
          "body": "Centralised key registries are an anti-pattern; co-locate keys with the component that owns the query.",
          "source_decision_id": "dec_12",
          "proposed_at": "2026-05-02T22:30:14.123Z",
          "status": "proposed"
        }
        """#

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601WithFractionalSeconds
        let proposal = try decoder.decode(SkillProposal.self, from: Data(json.utf8))

        XCTAssertEqual(proposal.id, "skill_77")
        XCTAssertEqual(proposal.workstreamID, "frontend-refactor")
        XCTAssertEqual(proposal.title, "Co-locate query keys with components")
        XCTAssertEqual(proposal.sourceDecisionID, "dec_12")
        XCTAssertEqual(proposal.status, .proposed)

        let expected = ISO8601DateFormatter().date(from: "2026-05-02T22:30:14Z")!
        XCTAssertEqual(
            proposal.proposedAt.timeIntervalSince1970,
            expected.timeIntervalSince1970,
            accuracy: 1.0
        )
    }

    func testProposalRoundTripsAllFields() throws {
        let original = SkillProposal(
            id: "skill_88",
            workstreamID: "auth-hardening",
            title: "Reuse-window detection",
            body: "Hit the refresh endpoint twice; second one must be rejected.",
            sourceDecisionID: "dec_03",
            proposedAt: ISO8601DateFormatter().date(from: "2026-05-01T10:00:00Z")!,
            status: .proposed
        )

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(original)

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601WithFractionalSeconds
        let decoded = try decoder.decode(SkillProposal.self, from: data)

        XCTAssertEqual(decoded, original)

        // Wire keys must be snake_case.
        let raw = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        XCTAssertNotNil(raw["workstream_id"])
        XCTAssertNotNil(raw["source_decision_id"])
        XCTAssertNotNil(raw["proposed_at"])
    }

    func testProposalRoundTripsWithNilSourceDecision() throws {
        let original = SkillProposal(
            id: "skill_42",
            workstreamID: "marketing-copy",
            title: "Lead with the problem, not the product",
            body: "Landing pages convert better when the headline names the user's pain.",
            sourceDecisionID: nil,
            proposedAt: Date(timeIntervalSince1970: 1_746_224_300),
            status: .proposed
        )

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(original)

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601WithFractionalSeconds
        let decoded = try decoder.decode(SkillProposal.self, from: data)

        XCTAssertEqual(decoded, original)
        XCTAssertNil(decoded.sourceDecisionID)
    }

    func testSkillStatusDecodesAllValues() throws {
        let decoder = JSONDecoder()
        for raw in ["proposed", "promoted", "dismissed"] {
            let data = Data("\"\(raw)\"".utf8)
            let status = try decoder.decode(SkillStatus.self, from: data)
            XCTAssertEqual(status.rawValue, raw)
        }
        XCTAssertEqual(SkillStatus.allCases.count, 3)
    }
}

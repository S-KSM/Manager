import XCTest
@testable import Manager

final class InterventionCodableTests: XCTestCase {

    func testNudgeDecodesFromArchitectureSchema() throws {
        // Verbatim from docs/ARCHITECTURE.md > "Intervention"
        let json = #"""
        {
          "id": "int_42",
          "workstream_id": "frontend-refactor",
          "kind": "nudge",
          "payload": {"message": "consider whether react-query handles your offline case"},
          "created_at": "2026-05-02T22:30:14Z",
          "delivered_at": null
        }
        """#

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601WithFractionalSeconds
        let intervention = try decoder.decode(Intervention.self, from: Data(json.utf8))

        XCTAssertEqual(intervention.id, "int_42")
        XCTAssertEqual(intervention.workstreamID, "frontend-refactor")
        XCTAssertEqual(intervention.kind, .nudge)
        XCTAssertEqual(
            intervention.payload.message,
            "consider whether react-query handles your offline case"
        )
        XCTAssertNil(intervention.payload.rollbackToDecisionID)
        XCTAssertNil(intervention.deliveredAt)

        // 2026-05-02T22:30:14Z as unix epoch.
        let expected = ISO8601DateFormatter().date(from: "2026-05-02T22:30:14Z")!
        XCTAssertEqual(
            intervention.createdAt.timeIntervalSince1970,
            expected.timeIntervalSince1970,
            accuracy: 1.0
        )
    }

    func testNudgeRoundTrips() throws {
        let createdAt = ISO8601DateFormatter().date(from: "2026-05-02T22:30:14Z")!
        let original = Intervention(
            id: "int_42",
            workstreamID: "frontend-refactor",
            kind: .nudge,
            payload: InterventionPayload(
                message: "consider whether react-query handles your offline case",
                rollbackToDecisionID: nil
            ),
            createdAt: createdAt,
            deliveredAt: nil
        )

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(original)

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601WithFractionalSeconds
        let decoded = try decoder.decode(Intervention.self, from: data)

        XCTAssertEqual(decoded, original)

        // Verify the wire keys are snake_case (no convertFromSnakeCase magic).
        // Note: Swift's auto-synthesised Codable omits nil optionals from the
        // output entirely, which is fine — the daemon's wire schema treats a
        // missing `delivered_at` and an explicit null identically.
        let raw = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        XCTAssertNotNil(raw["workstream_id"])
        XCTAssertNotNil(raw["created_at"])
        if let v = raw["delivered_at"] {
            XCTAssertTrue(v is NSNull)
        }
    }

    func testRollbackVariantRoundTrips() throws {
        let json = #"""
        {
          "id": "int_99",
          "workstream_id": "frontend-refactor",
          "kind": "rollback",
          "payload": {
            "message": "revisit the offline-cache trade-off",
            "rollback_to_decision_id": "dec_07"
          },
          "created_at": "2026-05-02T22:31:00.500Z",
          "delivered_at": "2026-05-02T22:31:02Z"
        }
        """#

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601WithFractionalSeconds
        let intervention = try decoder.decode(Intervention.self, from: Data(json.utf8))

        XCTAssertEqual(intervention.kind, .rollback)
        XCTAssertEqual(intervention.payload.rollbackToDecisionID, "dec_07")
        XCTAssertEqual(intervention.payload.message, "revisit the offline-cache trade-off")
        XCTAssertNotNil(intervention.deliveredAt)

        // Re-encode and re-decode so we know the rollback_to_decision_id key
        // round-trips through our explicit CodingKeys mapping.
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(intervention)
        let again = try decoder.decode(Intervention.self, from: data)
        XCTAssertEqual(again.payload.rollbackToDecisionID, "dec_07")
        XCTAssertEqual(again.kind, .rollback)
    }

    func testInterventionKindDecodesAllThreeValues() throws {
        let decoder = JSONDecoder()
        for raw in ["nudge", "redirect", "rollback"] {
            let data = Data("\"\(raw)\"".utf8)
            let kind = try decoder.decode(InterventionKind.self, from: data)
            XCTAssertEqual(kind.rawValue, raw)
        }
        XCTAssertEqual(InterventionKind.allCases.count, 3)
    }

    func testRedirectPayloadOmitsRollbackField() throws {
        let intervention = Intervention(
            id: "int_50",
            workstreamID: "auth-hardening",
            kind: .redirect,
            payload: InterventionPayload(
                message: "stop; first fix the failing refresh-token test",
                rollbackToDecisionID: nil
            ),
            createdAt: Date(timeIntervalSince1970: 1746224300),
            deliveredAt: nil
        )

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(intervention)
        let raw = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        let payload = try XCTUnwrap(raw["payload"] as? [String: Any])
        XCTAssertNotNil(payload["message"])
        // `rollback_to_decision_id` should be absent (or NSNull) when not set —
        // either is acceptable per JSON, but Swift's default encoding of nil
        // optionals omits the key entirely.
        if let v = payload["rollback_to_decision_id"] {
            XCTAssertTrue(v is NSNull)
        }
    }
}

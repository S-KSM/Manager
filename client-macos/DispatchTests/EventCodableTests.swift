import XCTest
@testable import DispatchApp

final class EventCodableTests: XCTestCase {

    func testDecisionEventDecodesFromArchitectureSchema() throws {
        // Verbatim from docs/ARCHITECTURE.md > "Event"
        let json = #"""
        {
          "ts": "2026-05-02T22:30:14.123Z",
          "workstream_id": "frontend-refactor",
          "session_id": "01J9X",
          "type": "decision",
          "id": "dec_07",
          "parent_id": "dec_05",
          "payload": {
            "considered": ["use react-query", "use SWR", "roll our own"],
            "choice": "use react-query",
            "rationale": "team already has a react-query setup in the API package; SWR adds a dep without payoff",
            "confidence": 0.8
          }
        }
        """#

        let data = Data(json.utf8)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601WithFractionalSeconds
        let event = try decoder.decode(Event.self, from: data)

        XCTAssertEqual(event.id, "dec_07")
        XCTAssertEqual(event.parentID, "dec_05")
        XCTAssertEqual(event.type, .decision)
        XCTAssertEqual(event.workstreamID, "frontend-refactor")
        XCTAssertEqual(event.sessionID, "01J9X")

        guard case .decision(let d) = event.payload else {
            return XCTFail("expected decision payload, got \(event.payload)")
        }
        XCTAssertEqual(d.choice, "use react-query")
        XCTAssertEqual(d.confidence, 0.8, accuracy: 0.0001)
        XCTAssertEqual(d.considered.count, 3)
    }

    func testRoundTripPreservesAllFields() throws {
        let original = MockData.eventsByWorkstream["frontend-refactor"]!.first { $0.id == "dec_07" }!

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(original)

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601WithFractionalSeconds
        let decoded = try decoder.decode(Event.self, from: data)

        XCTAssertEqual(decoded.id, original.id)
        XCTAssertEqual(decoded.type, original.type)
        XCTAssertEqual(decoded.parentID, original.parentID)
        XCTAssertEqual(decoded.payload, original.payload)
    }

    func testAllEventTypesRoundTrip() throws {
        // Build one event per case so we know the EventPayload encode/decode
        // path covers every variant.
        let now = Date()
        let cases: [(EventType, EventPayload)] = [
            (.sessionStart,           .sessionStart(.init(sessionID: "s1", runtime: "claude-code"))),
            (.sessionEnd,             .sessionEnd(.init(reason: "done"))),
            (.decision,               .decision(.init(considered: ["a", "b"], choice: "a", rationale: "r", confidence: 0.5))),
            (.subgoalPush,            .subgoalPush(.init(goal: "g"))),
            (.subgoalPop,             .subgoalPop(.init(goal: "g"))),
            (.confidence,             .confidence(.init(value: 0.7, note: "ok"))),
            (.toolUse,                .toolUse(.init(tool: "Bash", phase: "post", summary: "ran ls"))),
            (.blocked,                .blocked(.init(reason: "stuck"))),
            (.memoryUpdate,           .memoryUpdate(.init(section: "Goal", summary: "updated"))),
            (.interventionDelivered,  .interventionDelivered(.init(interventionID: "int_1", kind: "nudge")))
        ]

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601WithFractionalSeconds

        for (type, payload) in cases {
            let original = Event(
                ts: now,
                workstreamID: "ws-1",
                sessionID: "s-1",
                type: type,
                id: "evt-\(type.rawValue)",
                payload: payload
            )
            let data = try encoder.encode(original)
            let decoded = try decoder.decode(Event.self, from: data)
            XCTAssertEqual(decoded.type, original.type, "type mismatch for \(type)")
            XCTAssertEqual(decoded.payload, original.payload, "payload mismatch for \(type)")
        }
    }
}

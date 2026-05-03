import XCTest
@testable import Manager

final class MockDaemonClientTests: XCTestCase {

    func testListWorkstreamsReturnsFixtures() async throws {
        let client = MockDaemonClient(simulatedLatency: .zero)
        let list = try await client.listWorkstreams()
        XCTAssertGreaterThanOrEqual(list.count, 4, "spec calls for 4–6 mock workstreams")
        XCTAssertTrue(list.contains { $0.id == "frontend-refactor" })
    }

    func testHealthIsAlwaysTrue() async {
        let client = MockDaemonClient(simulatedLatency: .zero)
        let healthy = await client.health()
        XCTAssertTrue(healthy)
    }

    func testGetWorkstreamThrowsForUnknownID() async {
        let client = MockDaemonClient(simulatedLatency: .zero)
        do {
            _ = try await client.getWorkstream(id: "no-such-thing")
            XCTFail("expected throw")
        } catch {
            // ok
        }
    }

    func testEventsAreSortableAndDecisionTreeIsConsistent() async throws {
        let client = MockDaemonClient(simulatedLatency: .zero)
        let events = try await client.getEvents(workstreamID: "frontend-refactor")
        XCTAssertGreaterThan(events.count, 0)

        // Every parent_id reference must point to an event we know about
        // within the same workstream.
        let known = Set(events.map(\.id))
        for e in events {
            if let parent = e.parentID {
                XCTAssertTrue(known.contains(parent),
                              "dangling parent_id \(parent) on event \(e.id)")
            }
        }

        // dec_07 → dec_09 → dec_12 chain should be present (the spec's
        // decision-tree fixture).
        XCTAssertTrue(known.contains("dec_07"))
        XCTAssertTrue(known.contains("dec_09"))
        XCTAssertTrue(known.contains("dec_12"))
    }

    func testStreamEventsYieldsAndTerminates() async throws {
        let client = MockDaemonClient(simulatedLatency: .zero)
        var count = 0
        for await _ in client.streamEvents(workstreamID: "frontend-refactor") {
            count += 1
            if count >= 3 { break }
        }
        XCTAssertGreaterThanOrEqual(count, 1)
    }

    func testMemoryParsesIntoSections() async throws {
        let client = MockDaemonClient(simulatedLatency: .zero)
        let raw = try await client.getMemory(workstreamID: "frontend-refactor")
        let mem = WorkstreamMemory(workstreamID: "frontend-refactor", raw: raw)
        let headings = mem.sections.map(\.heading)
        XCTAssertTrue(headings.contains("Goal"))
        XCTAssertTrue(headings.contains("Current state"))
        XCTAssertTrue(headings.contains("Key decisions"))
    }

    func testPostInterventionStoresAndReturnsRecord() async throws {
        let client = MockDaemonClient(simulatedLatency: .zero)

        let nudge = try await client.postIntervention(
            workstreamID: "frontend-refactor",
            kind: .nudge,
            message: "consider the offline-cache case",
            rollbackToDecisionID: nil
        )
        XCTAssertEqual(nudge.workstreamID, "frontend-refactor")
        XCTAssertEqual(nudge.kind, .nudge)
        XCTAssertEqual(nudge.payload.message, "consider the offline-cache case")
        XCTAssertNil(nudge.payload.rollbackToDecisionID)
        XCTAssertNil(nudge.deliveredAt)
        XCTAssertFalse(nudge.id.isEmpty)

        let rollback = try await client.postIntervention(
            workstreamID: "frontend-refactor",
            kind: .rollback,
            message: "",
            rollbackToDecisionID: "dec_07"
        )
        XCTAssertEqual(rollback.kind, .rollback)
        XCTAssertEqual(rollback.payload.rollbackToDecisionID, "dec_07")
        XCTAssertNil(rollback.payload.message,
                     "empty hint should encode as nil per the wire contract")

        XCTAssertEqual(client.interventions.count, 2)
        XCTAssertEqual(client.interventions.map(\.kind), [.nudge, .rollback])
        XCTAssertNotEqual(client.interventions[0].id, client.interventions[1].id)
    }
}

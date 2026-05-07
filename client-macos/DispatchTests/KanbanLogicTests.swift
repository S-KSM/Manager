import XCTest
@testable import DispatchApp

final class KanbanLogicTests: XCTestCase {

    /// 4 statuses → 4 buckets, each with the correct workstreams in
    /// caller-preserved order. Empty status keys are still present so
    /// callers don't have to nil-check before reading a column.
    func testPartitionWorkstreamsAcrossAllFourStatuses() {
        let ws: [Workstream] = [
            makeWS(id: "a", status: .active),
            makeWS(id: "b", status: .backlog),
            makeWS(id: "c", status: .active),
            makeWS(id: "d", status: .paused),
            makeWS(id: "e", status: .retired),
            makeWS(id: "f", status: .active)
        ]
        let buckets = partitionWorkstreamsByStatus(ws)
        XCTAssertEqual(buckets[.backlog]?.map(\.id), ["b"])
        XCTAssertEqual(buckets[.active]?.map(\.id), ["a", "c", "f"])
        XCTAssertEqual(buckets[.paused]?.map(\.id), ["d"])
        XCTAssertEqual(buckets[.retired]?.map(\.id), ["e"])
    }

    /// All four bucket keys are always present, even when empty — so the
    /// kanban view can iterate `Status.allCases` without nil checks.
    func testPartitionAlwaysReturnsAllFourKeys() {
        let buckets = partitionWorkstreamsByStatus([])
        XCTAssertEqual(buckets.keys.sorted(by: { $0.rawValue < $1.rawValue }).count, 4)
        XCTAssertNotNil(buckets[.backlog])
        XCTAssertNotNil(buckets[.active])
        XCTAssertNotNil(buckets[.paused])
        XCTAssertNotNil(buckets[.retired])
    }

    /// 14 active workstreams partition straight through (presentation detail
    /// — counting and grouping are separate concerns).
    func testPartitionPreserves14ActiveCount() {
        let ws = (0..<14).map { makeWS(id: "w\($0)", status: .active) }
        let buckets = partitionWorkstreamsByStatus(ws)
        XCTAssertEqual(buckets[.active]?.count, 14)
    }

    /// Pod-grouping boundary: 12 → render flat, 13 → fold into a disclosure.
    func testShouldGroupPodBoundary() {
        XCTAssertFalse(shouldGroupPod(count: 0))
        XCTAssertFalse(shouldGroupPod(count: 1))
        XCTAssertFalse(shouldGroupPod(count: 11))
        XCTAssertFalse(shouldGroupPod(count: 12))
        XCTAssertTrue(shouldGroupPod(count: 13))
        XCTAssertTrue(shouldGroupPod(count: 50))
    }

    /// Drag payload round-trips through Codable so the Transferable JSON
    /// representation will pick up the same shape on drop.
    func testDragPayloadCodableRoundTrip() throws {
        let payload = WorkstreamDragPayload(id: "frontend-refactor", currentStatus: .active)
        let data = try JSONEncoder().encode(payload)
        let back = try JSONDecoder().decode(WorkstreamDragPayload.self, from: data)
        XCTAssertEqual(back.id, "frontend-refactor")
        XCTAssertEqual(back.currentStatus, .active)
    }

    func testDragPayloadEncodesAllFourStatusValues() throws {
        let encoder = JSONEncoder()
        let decoder = JSONDecoder()
        for s in Workstream.Status.allCases {
            let payload = WorkstreamDragPayload(id: "x", currentStatus: s)
            let data = try encoder.encode(payload)
            let back = try decoder.decode(WorkstreamDragPayload.self, from: data)
            XCTAssertEqual(back.currentStatus, s)
        }
    }

    private func makeWS(id: String, status: Workstream.Status) -> Workstream {
        Workstream(id: id, title: id, createdAt: Date(timeIntervalSince1970: 0), status: status)
    }
}

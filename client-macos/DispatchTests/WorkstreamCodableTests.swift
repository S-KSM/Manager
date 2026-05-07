import XCTest
@testable import DispatchApp

final class WorkstreamCodableTests: XCTestCase {

    /// All four kanban statuses round-trip via the wire JSON shape.
    func testStatusRoundTripsAllFourKanbanColumns() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601WithFractionalSeconds
        let raws: [String] = ["backlog", "active", "paused", "retired"]
        let expected: [Workstream.Status] = [.backlog, .active, .paused, .retired]
        for (i, raw) in raws.enumerated() {
            let json = """
            {
              "workstream_id": "w\(i)",
              "title": "W\(i)",
              "created_at": "2026-05-06T10:00:00Z",
              "status": "\(raw)",
              "sessions": []
            }
            """
            let ws = try decoder.decode(Workstream.self, from: Data(json.utf8))
            XCTAssertEqual(ws.status, expected[i])
        }
    }

    /// Forward-compat: an unknown status string from a future daemon must
    /// decode to `.active` so the client doesn't blank the workstream out.
    func testUnknownStatusFallsBackToActive() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601WithFractionalSeconds
        let json = """
        {
          "workstream_id": "future",
          "title": "Future",
          "created_at": "2026-05-06T10:00:00Z",
          "status": "merged-pending-deploy",
          "sessions": []
        }
        """
        let ws = try decoder.decode(Workstream.self, from: Data(json.utf8))
        XCTAssertEqual(ws.status, .active)
    }

    /// `Status.allCases` is the source of truth for the kanban column order:
    /// backlog → active → paused → retired.
    func testAllCasesOrdering() {
        XCTAssertEqual(
            Workstream.Status.allCases,
            [.backlog, .active, .paused, .retired]
        )
    }

    func testStatusLabelsCoverEveryCase() {
        XCTAssertEqual(makeWorkstream(status: .backlog).statusLabel, "Backlog")
        XCTAssertEqual(makeWorkstream(status: .active).statusLabel, "Active")
        XCTAssertEqual(makeWorkstream(status: .paused).statusLabel, "Paused")
        XCTAssertEqual(makeWorkstream(status: .retired).statusLabel, "Retired")
    }

    private func makeWorkstream(status: Workstream.Status) -> Workstream {
        Workstream(
            id: "x",
            title: "X",
            createdAt: Date(timeIntervalSince1970: 0),
            status: status
        )
    }
}

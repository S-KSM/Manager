import XCTest
@testable import DispatchApp

final class WorkstreamLinkCodableTests: XCTestCase {

    /// Round-trip the daemon's snake_case wire shape, including the optional
    /// fields (`issue_url`, `last_seen_state`, `last_synced_at`) which the
    /// daemon sends as `null` until populated.
    func testDecodesFullWireShape() throws {
        let json = """
        {
          "workstream_id": "frontend-refactor",
          "tracker_kind": "linear",
          "issue_id": "lin_001",
          "issue_identifier": "ENG-7",
          "issue_url": "https://linear.app/x/issue/ENG-7",
          "last_seen_state": "In Progress",
          "last_synced_at": "2026-05-06T12:34:56Z",
          "created_at": "2026-05-06T10:00:00Z"
        }
        """
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601WithFractionalSeconds
        let link = try decoder.decode(WorkstreamLink.self, from: Data(json.utf8))
        XCTAssertEqual(link.workstreamID, "frontend-refactor")
        XCTAssertEqual(link.trackerKind, "linear")
        XCTAssertEqual(link.issueID, "lin_001")
        XCTAssertEqual(link.issueIdentifier, "ENG-7")
        XCTAssertEqual(link.issueURL, "https://linear.app/x/issue/ENG-7")
        XCTAssertEqual(link.lastSeenState, "In Progress")
        XCTAssertNotNil(link.lastSyncedAt)
        XCTAssertNotNil(link.createdAt)
    }

    /// Optional null fields decode to `nil`. Mirrors the daemon's "linked but
    /// never synced" state.
    func testDecodesWithNullOptionalFields() throws {
        let json = """
        {
          "workstream_id": "w",
          "tracker_kind": "linear",
          "issue_id": "lin_a",
          "issue_identifier": "ENG-1",
          "issue_url": null,
          "last_seen_state": null,
          "last_synced_at": null,
          "created_at": "2026-05-06T10:00:00Z"
        }
        """
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601WithFractionalSeconds
        let link = try decoder.decode(WorkstreamLink.self, from: Data(json.utf8))
        XCTAssertNil(link.issueURL)
        XCTAssertNil(link.lastSeenState)
        XCTAssertNil(link.lastSyncedAt)
    }

    /// `id` derives from `workstream_id` so SwiftUI ForEach can use it as
    /// the row identity without any extra wiring.
    func testIdMatchesWorkstreamID() {
        let link = WorkstreamLink(
            workstreamID: "x",
            trackerKind: "linear",
            issueID: "lin_x",
            issueIdentifier: "ENG-9",
            issueURL: nil,
            lastSeenState: nil,
            lastSyncedAt: nil,
            createdAt: Date(timeIntervalSince1970: 0)
        )
        XCTAssertEqual(link.id, "x")
    }
}

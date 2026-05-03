import XCTest
@testable import DispatchApp

final class ReportCodableTests: XCTestCase {

    // MARK: - Report

    func testReportDecodesFromWireSchema() throws {
        let json = #"""
        {
          "id": "rep_xxxxxxxx",
          "title": "Weekly update — 2026-05-03",
          "audience_preset": "executive",
          "audience_freetext": null,
          "period_since": "2026-04-26T00:00:00Z",
          "period_until": "2026-05-03T00:00:00Z",
          "workstream_ids": ["frontend-refactor", "billing-migration"],
          "provider": "claude",
          "model": "claude-sonnet-4-7",
          "body_md": "# Weekly update\n\n...",
          "status": "draft",
          "generated_at": "2026-05-03T08:00:00.123Z",
          "saved_at": null
        }
        """#
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601WithFractionalSeconds
        let report = try decoder.decode(Report.self, from: Data(json.utf8))

        XCTAssertEqual(report.id, "rep_xxxxxxxx")
        XCTAssertEqual(report.audiencePreset, "executive")
        XCTAssertNil(report.audienceFreetext)
        XCTAssertEqual(report.workstreamIDs, ["frontend-refactor", "billing-migration"])
        XCTAssertEqual(report.provider, "claude")
        XCTAssertEqual(report.model, "claude-sonnet-4-7")
        XCTAssertTrue(report.bodyMD.hasPrefix("# Weekly update"))
        XCTAssertEqual(report.status, .draft)
        XCTAssertNil(report.savedAt)
    }

    func testReportRoundTripsWithFreetextOverride() throws {
        let original = Report(
            id: "rep_42",
            title: "Series A snapshot",
            audiencePreset: nil,
            audienceFreetext: "Series A investors, focus on traction metrics",
            periodSince: ISO8601DateFormatter().date(from: "2026-04-01T00:00:00Z")!,
            periodUntil: ISO8601DateFormatter().date(from: "2026-05-01T00:00:00Z")!,
            workstreamIDs: ["growth-experiments"],
            provider: "ollama",
            model: "qwen3:8b",
            bodyMD: "# Investor update\n\n- MRR up 12%.",
            status: .saved,
            generatedAt: ISO8601DateFormatter().date(from: "2026-05-01T09:00:00Z")!,
            savedAt: ISO8601DateFormatter().date(from: "2026-05-01T09:01:00Z")!
        )

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(original)

        // Wire keys must be snake_case. (Nil-valued fields like
        // audience_preset are omitted by JSONEncoder's default; we verify
        // the freetext side carries through and the rest of the snake_case
        // surface area is present.)
        let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(raw["audience_freetext"] as? String,
                       "Series A investors, focus on traction metrics")
        XCTAssertNotNil(raw["period_since"])
        XCTAssertNotNil(raw["period_until"])
        XCTAssertNotNil(raw["workstream_ids"])
        XCTAssertNotNil(raw["body_md"])
        XCTAssertNotNil(raw["generated_at"])
        XCTAssertNotNil(raw["saved_at"])

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601WithFractionalSeconds
        let decoded = try decoder.decode(Report.self, from: data)
        XCTAssertEqual(decoded, original)
    }

    func testReportDecodesWithSavedAtPresent() throws {
        let json = #"""
        {
          "id": "rep_seed",
          "title": "Last week — executive update",
          "audience_preset": "executive",
          "audience_freetext": null,
          "period_since": "2026-04-19T00:00:00Z",
          "period_until": "2026-04-26T00:00:00Z",
          "workstream_ids": ["frontend-refactor"],
          "provider": "claude",
          "model": "claude-sonnet-4-7",
          "body_md": "# Update\n\n- shipped",
          "status": "saved",
          "generated_at": "2026-04-26T08:00:00Z",
          "saved_at": "2026-04-26T08:05:00Z"
        }
        """#
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601WithFractionalSeconds
        let report = try decoder.decode(Report.self, from: Data(json.utf8))
        XCTAssertEqual(report.status, .saved)
        XCTAssertNotNil(report.savedAt)
    }

    // MARK: - ReportPreset

    func testReportPresetRoundTrips() throws {
        let original = ReportPreset(
            id: "executive",
            name: "Executive",
            description: "Lead with outcomes and risks. 5–7 quantified bullets.",
            systemPrompt: "You write a weekly executive summary..."
        )
        let encoder = JSONEncoder()
        let data = try encoder.encode(original)

        // snake_case wire key for systemPrompt.
        let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNotNil(raw["system_prompt"])

        let decoder = JSONDecoder()
        let decoded = try decoder.decode(ReportPreset.self, from: data)
        XCTAssertEqual(decoded, original)
    }

    // MARK: - SchedulerJob

    func testSchedulerJobDecodesWithNextFireAtPresent() throws {
        let json = #"""
        {
          "id": "weekly_report",
          "enabled": true,
          "cron": "0 8 * * 1",
          "audience_preset": "executive",
          "provider": "claude",
          "model": null,
          "next_fire_at": "2026-05-04T08:00:00Z"
        }
        """#
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601WithFractionalSeconds
        let job = try decoder.decode(SchedulerJob.self, from: Data(json.utf8))
        XCTAssertEqual(job.id, "weekly_report")
        XCTAssertTrue(job.enabled)
        XCTAssertEqual(job.cron, "0 8 * * 1")
        XCTAssertEqual(job.audiencePreset, "executive")
        XCTAssertNil(job.model)
        XCTAssertNotNil(job.nextFireAt)
    }

    func testSchedulerJobDecodesWithNextFireAtNull() throws {
        let json = #"""
        {
          "id": "monthly_report",
          "enabled": false,
          "cron": "0 8 1 * *",
          "audience_preset": "executive",
          "provider": "claude",
          "model": null,
          "next_fire_at": null
        }
        """#
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601WithFractionalSeconds
        let job = try decoder.decode(SchedulerJob.self, from: Data(json.utf8))
        XCTAssertNil(job.nextFireAt)
        XCTAssertFalse(job.enabled)
    }

    // MARK: - ReportStatus

    func testReportStatusDecodesAllValues() throws {
        let decoder = JSONDecoder()
        for raw in ["draft", "saved", "archived"] {
            let data = Data("\"\(raw)\"".utf8)
            let status = try decoder.decode(ReportStatus.self, from: data)
            XCTAssertEqual(status.rawValue, raw)
        }
        XCTAssertEqual(ReportStatus.allCases.count, 3)
    }

    // MARK: - GenerateReportParams

    func testGenerateReportParamsEncodesSnakeCase() throws {
        let params = GenerateReportParams(
            workstreamIDs: ["frontend-refactor"],
            since: nil,
            until: nil,
            audiencePreset: "executive",
            audienceFreetext: nil,
            provider: "claude",
            model: nil,
            save: false,
            title: nil
        )
        let encoder = JSONEncoder()
        let data = try encoder.encode(params)
        let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNotNil(raw["workstream_ids"])
        XCTAssertNotNil(raw["audience_preset"])
        XCTAssertEqual(raw["provider"] as? String, "claude")
        XCTAssertEqual(raw["save"] as? Bool, false)
    }
}

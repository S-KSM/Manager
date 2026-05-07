import XCTest
@testable import DispatchApp

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

    func testCreateWorkstreamRoundTripsIntoList() async throws {
        let client = MockDaemonClient(simulatedLatency: .zero)
        let before = try await client.listWorkstreams()
        XCTAssertFalse(before.contains { $0.id == "billing-migration" })

        let created = try await client.createWorkstream(
            id: "billing-migration",
            title: "Billing migration to Stripe"
        )
        XCTAssertEqual(created.id, "billing-migration")
        XCTAssertEqual(created.title, "Billing migration to Stripe")
        XCTAssertEqual(created.status, .active)

        let after = try await client.listWorkstreams()
        XCTAssertEqual(after.count, before.count + 1)
        XCTAssertTrue(after.contains { $0.id == "billing-migration" })
    }

    func testUpdateWorkstreamMutatesStatusAndTitle() async throws {
        let client = MockDaemonClient(simulatedLatency: .zero)

        let paused = try await client.updateWorkstream(
            id: "frontend-refactor",
            status: .paused,
            title: nil
        )
        XCTAssertEqual(paused.status, .paused)
        XCTAssertEqual(paused.title, "Frontend refactor: Redux → react-query")

        // Verify the change is observable through listWorkstreams.
        let list = try await client.listWorkstreams()
        let observed = try XCTUnwrap(list.first { $0.id == "frontend-refactor" })
        XCTAssertEqual(observed.status, .paused)

        let renamed = try await client.updateWorkstream(
            id: "frontend-refactor",
            status: nil,
            title: "Frontend refactor (in progress)"
        )
        XCTAssertEqual(renamed.title, "Frontend refactor (in progress)")
        // Status preserved when not specified.
        XCTAssertEqual(renamed.status, .paused)
    }

    func testUpdateWorkstreamToBacklog() async throws {
        // Kanban drag-from-Active-into-Backlog round-trips. Mock mirrors the
        // daemon's `PATCH /workstreams/:id` shape, so verifying the mock is
        // good proof that the wiring works end-to-end on the client side.
        let client = MockDaemonClient(simulatedLatency: .zero)
        let updated = try await client.updateWorkstream(
            id: "frontend-refactor",
            status: .backlog,
            title: nil
        )
        XCTAssertEqual(updated.status, .backlog)
        XCTAssertEqual(updated.id, "frontend-refactor")

        let list = try await client.listWorkstreams()
        let observed = try XCTUnwrap(list.first { $0.id == "frontend-refactor" })
        XCTAssertEqual(observed.status, .backlog)
    }

    func testUpdateUnknownWorkstreamThrows() async {
        let client = MockDaemonClient(simulatedLatency: .zero)
        do {
            _ = try await client.updateWorkstream(
                id: "no-such-thing",
                status: .paused,
                title: nil
            )
            XCTFail("expected throw")
        } catch {
            // ok
        }
    }

    func testGetDigestSynthesisesFromMockState() async throws {
        let client = MockDaemonClient(simulatedLatency: .zero)
        let digest = try await client.getDigest(since: nil)
        // auth-hardening has needsAttention = true in MockData.
        XCTAssertGreaterThanOrEqual(digest.totals.blocked, 1)
        XCTAssertEqual(digest.totals.needsAttention, digest.totals.blocked)
        XCTAssertGreaterThanOrEqual(digest.totals.active, 1)
        // The first highlight should be the attention-needing one.
        XCTAssertEqual(digest.highlights.first?.workstreamID, "auth-hardening")
        XCTAssertLessThanOrEqual(digest.highlights.count, 5)
    }

    func testAppendHandbookSkillUpdatesHandbookString() async throws {
        let client = MockDaemonClient(simulatedLatency: .zero)
        let before = try await client.getHandbook()
        XCTAssertFalse(before.contains("## Test handbook entry"))

        try await client.appendHandbookSkill(
            title: "Test handbook entry",
            body: "A handy reusable pattern.",
            sourceWorkstreamID: "frontend-refactor",
            sourceDecisionID: "dec_07"
        )

        let after = try await client.getHandbook()
        XCTAssertTrue(after.contains("## Test handbook entry"))
        XCTAssertTrue(after.contains("A handy reusable pattern."))
        XCTAssertTrue(after.contains("frontend-refactor"),
                      "footer should mention the source workstream")
    }

    func testListProposedSkillsReturnsFixture() async throws {
        let client = MockDaemonClient(simulatedLatency: .zero)
        let proposals = try await client.listProposedSkills()
        XCTAssertGreaterThanOrEqual(proposals.count, 1)
        XCTAssertTrue(proposals.allSatisfy { $0.status == .proposed })
    }

    func testPromoteSkillFlipsStatusAndAppendsHandbook() async throws {
        let client = MockDaemonClient(simulatedLatency: .zero)
        let initial = try await client.listProposedSkills()
        let target = try XCTUnwrap(initial.first)

        let handbookBefore = try await client.getHandbook()
        XCTAssertFalse(handbookBefore.contains("## \(target.title)"))

        let promoted = try await client.promoteSkill(id: target.id)
        XCTAssertEqual(promoted.status, .promoted)
        XCTAssertEqual(promoted.id, target.id)

        // The promoted proposal no longer appears in the proposed-only list.
        let after = try await client.listProposedSkills()
        XCTAssertFalse(after.contains { $0.id == target.id })

        // Handbook now contains the promoted skill.
        let handbookAfter = try await client.getHandbook()
        XCTAssertTrue(handbookAfter.contains("## \(target.title)"))
    }

    func testDismissSkillFlipsStatus() async throws {
        let client = MockDaemonClient(simulatedLatency: .zero)
        let initial = try await client.listProposedSkills()
        let target = try XCTUnwrap(initial.first)

        let dismissed = try await client.dismissSkill(id: target.id)
        XCTAssertEqual(dismissed.status, .dismissed)

        let after = try await client.listProposedSkills()
        XCTAssertFalse(after.contains { $0.id == target.id })
    }

    // MARK: - v1.1: reports + scheduler

    func testListReportPresetsReturnsFour() async throws {
        let client = MockDaemonClient(simulatedLatency: .zero)
        let presets = try await client.listReportPresets()
        XCTAssertEqual(presets.count, 4)
        XCTAssertTrue(presets.contains { $0.id == "executive" })
        XCTAssertTrue(presets.contains { $0.id == "business_partner" })
        XCTAssertTrue(presets.contains { $0.id == "engineer_peer" })
        XCTAssertTrue(presets.contains { $0.id == "sponsor" })
    }

    func testGenerateReportWithSaveFalseDoesNotPersist() async throws {
        let client = MockDaemonClient(simulatedLatency: .zero)
        let beforeCount = client.reportsSnapshot.count

        let params = GenerateReportParams(
            workstreamIDs: ["frontend-refactor"],
            audiencePreset: "executive",
            provider: "claude",
            save: false
        )
        let report = try await client.generateReport(params)

        XCTAssertEqual(report.status, .draft)
        XCTAssertNil(report.savedAt)
        XCTAssertFalse(report.bodyMD.isEmpty)
        XCTAssertEqual(client.reportsSnapshot.count, beforeCount,
                       "save=false must not persist a row")
    }

    func testGenerateReportWithSaveTruePersistsAndAppearsInList() async throws {
        let client = MockDaemonClient(simulatedLatency: .zero)

        let params = GenerateReportParams(
            workstreamIDs: ["frontend-refactor"],
            audiencePreset: "executive",
            provider: "claude",
            save: true,
            title: "My saved update"
        )
        let report = try await client.generateReport(params)
        XCTAssertEqual(report.status, .saved)
        XCTAssertNotNil(report.savedAt)
        XCTAssertEqual(report.title, "My saved update")

        let saved = try await client.listReports(status: .saved)
        XCTAssertTrue(saved.contains { $0.id == report.id })
    }

    func testListReportsFiltersByStatus() async throws {
        let client = MockDaemonClient(simulatedLatency: .zero)
        let drafts = try await client.listReports(status: .draft)
        let saved = try await client.listReports(status: .saved)
        XCTAssertTrue(drafts.allSatisfy { $0.status == .draft })
        XCTAssertTrue(saved.allSatisfy { $0.status == .saved })
        XCTAssertGreaterThanOrEqual(drafts.count, 1)
        XCTAssertGreaterThanOrEqual(saved.count, 1)

        let all = try await client.listReports(status: nil)
        XCTAssertGreaterThanOrEqual(all.count, drafts.count + saved.count)
    }

    func testUpdateReportFlipsStatusToSaved() async throws {
        let client = MockDaemonClient(simulatedLatency: .zero)
        let drafts = try await client.listReports(status: .draft)
        let target = try XCTUnwrap(drafts.first)
        XCTAssertNil(target.savedAt)

        let updated = try await client.updateReport(
            id: target.id,
            fields: ReportUpdateFields(status: .saved)
        )
        XCTAssertEqual(updated.status, .saved)
        XCTAssertNotNil(updated.savedAt)

        let savedNow = try await client.listReports(status: .saved)
        XCTAssertTrue(savedNow.contains { $0.id == target.id })
    }

    func testUpdateReportPatchesTitleAndBody() async throws {
        let client = MockDaemonClient(simulatedLatency: .zero)
        let saved = try await client.listReports(status: .saved)
        let target = try XCTUnwrap(saved.first)

        let updated = try await client.updateReport(
            id: target.id,
            fields: ReportUpdateFields(title: "Edited title", bodyMD: "# New body")
        )
        XCTAssertEqual(updated.title, "Edited title")
        XCTAssertEqual(updated.bodyMD, "# New body")
        // Status preserved when not specified.
        XCTAssertEqual(updated.status, target.status)
    }

    func testDeleteReportFlipsToArchived() async throws {
        let client = MockDaemonClient(simulatedLatency: .zero)
        let saved = try await client.listReports(status: .saved)
        let target = try XCTUnwrap(saved.first)

        let archived = try await client.deleteReport(id: target.id)
        XCTAssertEqual(archived.status, .archived)

        let stillSaved = try await client.listReports(status: .saved)
        XCTAssertFalse(stillSaved.contains { $0.id == target.id })

        let archivedList = try await client.listReports(status: .archived)
        XCTAssertTrue(archivedList.contains { $0.id == target.id })
    }

    func testListSchedulerJobsReturnsBothDefaults() async throws {
        let client = MockDaemonClient(simulatedLatency: .zero)
        let jobs = try await client.listSchedulerJobs()
        XCTAssertEqual(jobs.count, 2)
        XCTAssertTrue(jobs.contains { $0.id == "weekly_report" })
        XCTAssertTrue(jobs.contains { $0.id == "monthly_report" })
    }

    func testUpdateSchedulerJobMutates() async throws {
        let client = MockDaemonClient(simulatedLatency: .zero)
        let updated = try await client.updateSchedulerJob(
            id: "weekly_report",
            fields: SchedulerJobUpdateFields(
                enabled: true,
                cron: "*/2 * * * *",
                audiencePreset: "engineer_peer",
                provider: "ollama",
                model: "qwen3:8b"
            )
        )
        XCTAssertTrue(updated.enabled)
        XCTAssertEqual(updated.cron, "*/2 * * * *")
        XCTAssertEqual(updated.audiencePreset, "engineer_peer")
        XCTAssertEqual(updated.provider, "ollama")
        XCTAssertEqual(updated.model, "qwen3:8b")

        let observed = try await client.listSchedulerJobs()
        let weekly = try XCTUnwrap(observed.first { $0.id == "weekly_report" })
        XCTAssertTrue(weekly.enabled)
        XCTAssertEqual(weekly.cron, "*/2 * * * *")
    }

    func testGenerateReportRespectsFreetextAudience() async throws {
        let client = MockDaemonClient(simulatedLatency: .zero)
        let report = try await client.generateReport(
            GenerateReportParams(
                workstreamIDs: ["frontend-refactor"],
                audiencePreset: nil,
                audienceFreetext: "Series A investors",
                provider: "claude",
                save: false
            )
        )
        XCTAssertNil(report.audiencePreset)
        XCTAssertEqual(report.audienceFreetext, "Series A investors")
        XCTAssertTrue(report.bodyMD.contains("Series A investors"),
                      "synthesizer should weave the freetext into the body")
    }

    // MARK: - v1.2: Linear-link UI

    func testGetWorkstreamLinkIsNilWhenUnlinked() async throws {
        let client = MockDaemonClient(simulatedLatency: .zero)
        let got = try await client.getWorkstreamLink(workstreamID: "frontend-refactor")
        XCTAssertNil(got)
    }

    func testLinkWorkstreamThenGetReturnsTheLink() async throws {
        let client = MockDaemonClient(simulatedLatency: .zero)
        let created = try await client.linkWorkstream(
            workstreamID: "frontend-refactor",
            trackerKind: "linear",
            issueIdentifier: "ENG-7"
        )
        XCTAssertEqual(created.workstreamID, "frontend-refactor")
        XCTAssertEqual(created.issueIdentifier, "ENG-7")
        XCTAssertEqual(created.issueID, "lin_ENG-7")
        XCTAssertEqual(created.lastSeenState, "In Progress")

        let fetched = try await client.getWorkstreamLink(workstreamID: "frontend-refactor")
        XCTAssertNotNil(fetched)
        XCTAssertEqual(fetched?.issueIdentifier, "ENG-7")
    }

    func testUnlinkWorkstreamRemovesIt() async throws {
        let client = MockDaemonClient(simulatedLatency: .zero)
        _ = try await client.linkWorkstream(
            workstreamID: "frontend-refactor",
            trackerKind: "linear",
            issueIdentifier: "ENG-7"
        )
        try await client.unlinkWorkstream(workstreamID: "frontend-refactor")
        let after = try await client.getWorkstreamLink(workstreamID: "frontend-refactor")
        XCTAssertNil(after)
    }

    func testLinkWorkstreamUnknownIdentifierThrows() async {
        let client = MockDaemonClient(simulatedLatency: .zero)
        do {
            _ = try await client.linkWorkstream(
                workstreamID: "frontend-refactor",
                trackerKind: "linear",
                issueIdentifier: "ENG-404"
            )
            XCTFail("expected throw on unknown identifier")
        } catch {
            // ok
        }
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

    // MARK: - v1.4.6: Diagnostics tab

    func testKillLLMRecordsCallAndReturnsCannedResult() async throws {
        let client = MockDaemonClient(simulatedLatency: .zero)
        client.setKillLLMResult(KillLLMResult(killed: 4242, escalated: false, error: nil))

        XCTAssertEqual(client.killLLMCallCount, 0)
        let result = try await client.killLLM()
        XCTAssertEqual(result.killed, 4242)
        XCTAssertFalse(result.escalated)
        XCTAssertEqual(client.killLLMCallCount, 1)
    }

    func testKillLLMReturnsNilWhenNothingRunning() async throws {
        let client = MockDaemonClient(simulatedLatency: .zero)
        // Default canned response: nothing was running.
        let result = try await client.killLLM()
        XCTAssertNil(result.killed)
    }

    func testRestartLLMRecordsCallAndReturnsCannedResult() async throws {
        let client = MockDaemonClient(simulatedLatency: .zero)
        client.setRestartLLMResult(
            RestartLLMResult(killedPID: 999, started: true, error: nil)
        )

        XCTAssertEqual(client.restartLLMCallCount, 0)
        let result = try await client.restartLLM()
        XCTAssertEqual(result.killedPID, 999)
        XCTAssertTrue(result.started)
        XCTAssertEqual(client.restartLLMCallCount, 1)
    }

    func testRestartDaemonRecordsCallAndReturnsRestartedTickerNames() async throws {
        let client = MockDaemonClient(simulatedLatency: .zero)
        XCTAssertEqual(client.restartDaemonCallCount, 0)
        let result = try await client.restartDaemon()
        XCTAssertEqual(result.restarted, ["headliner", "subgoal_synth", "linear_sync"])
        XCTAssertEqual(client.restartDaemonCallCount, 1)
    }

    func testDiagnosticsErrorPropagatesFromKillRestartCalls() async {
        let client = MockDaemonClient(simulatedLatency: .zero)
        let injected = NSError(domain: "DiagnosticsTest", code: 42)
        client.setDiagnosticsError(injected)

        do {
            _ = try await client.killLLM()
            XCTFail("expected throw")
        } catch {
            // ok
        }
        do {
            _ = try await client.restartLLM()
            XCTFail("expected throw")
        } catch {
            // ok
        }
        do {
            _ = try await client.restartDaemon()
            XCTFail("expected throw")
        } catch {
            // ok
        }
        XCTAssertEqual(client.killLLMCallCount, 1)
        XCTAssertEqual(client.restartLLMCallCount, 1)
        XCTAssertEqual(client.restartDaemonCallCount, 1)
    }

    func testProviderSettingsLocalLLMStartCommandRoundTrips() async throws {
        let client = MockDaemonClient(simulatedLatency: .zero)
        XCTAssertEqual(client.settingsSnapshot.localLLMStartCommand, "")

        var patch = ProviderSettingsPatch()
        patch.localLLMStartCommand = "mlx_lm.server --port 8080"
        let after = try await client.patchSettings(patch)
        XCTAssertEqual(after.localLLMStartCommand, "mlx_lm.server --port 8080")
        XCTAssertEqual(client.settingsSnapshot.localLLMStartCommand,
                       "mlx_lm.server --port 8080")

        // Empty string clears.
        var clear = ProviderSettingsPatch()
        clear.localLLMStartCommand = ""
        let cleared = try await client.patchSettings(clear)
        XCTAssertEqual(cleared.localLLMStartCommand, "")
    }

    func testLaunchctlControllerSurfacesNonZeroExitAsError() {
        // Pure unit: drive the runner seam with a stub. No /bin/launchctl.
        let runner: LaunchctlController.Runner = { args in
            XCTAssertEqual(args, ["kickstart", "-k", "gui/\(getuid())/com.dispatch.daemon"])
            return (status: 113, stderr: "Operation not permitted")
        }
        let result = LaunchctlController.runLaunchctl(
            ["kickstart", "-k", "gui/\(getuid())/com.dispatch.daemon"],
            runner: runner
        )
        switch result {
        case .success:
            XCTFail("expected failure when launchctl exits non-zero")
        case .failure(let err):
            XCTAssertTrue(err.localizedDescription.contains("113"))
            XCTAssertTrue(err.localizedDescription.contains("Operation not permitted"))
        }
    }

    func testLaunchctlControllerSurfacesZeroExitAsSuccess() {
        let runner: LaunchctlController.Runner = { _ in
            (status: 0, stderr: "")
        }
        let result = LaunchctlController.runLaunchctl(["kickstart"], runner: runner)
        if case .failure = result {
            XCTFail("expected success on exit 0")
        }
    }
}

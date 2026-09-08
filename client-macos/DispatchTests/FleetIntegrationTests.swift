import XCTest
@testable import DispatchApp

/// v1.4.20 — claude-fleet / team-brain integration surface on the client:
/// `OrchestratorState` decoding (enriched + pre-1.4.20 shapes), the
/// `autonomous_running` workstream flag, tracker-aware link helpers, the
/// `team_brain_path` promote response, tmux attach safety, and the mock
/// client's new endpoints.
final class FleetIntegrationTests: XCTestCase {

    private var decoder: JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601WithFractionalSeconds
        return d
    }

    // MARK: - OrchestratorState

    func testOrchestratorStateDecodesEnrichedShape() throws {
        let json = """
        {
          "poll_interval_ms": 30000,
          "max_concurrent_agents": 3,
          "stall_timeout_ms": 300000,
          "counts": { "running": 1, "retrying": 0, "claimed": 1, "completed": 4 },
          "running": [
            {
              "issue_id": "search/mvp/phase-2-rerank",
              "identifier": "search/mvp/phase-2-rerank",
              "workspace_path": "/repo/.worktrees/search_mvp_phase-2-rerank",
              "started_at": "2026-09-07T10:00:00Z",
              "attempt": null,
              "workstream_id": "search_mvp_phase-2-rerank",
              "attach": {
                "tmux_session": "dispatch-search_mvp_phase-2-rerank-sess_9f3a1c2b",
                "command": "tmux attach -t dispatch-search_mvp_phase-2-rerank-sess_9f3a1c2b"
              }
            }
          ],
          "retrying": [
            { "issue_id": "ENG-9", "identifier": "ENG-9", "attempt": 2, "due_at_ms": 1.7e12, "error": "turn_timeout" }
          ],
          "tracker_kind": "team-brain",
          "agent_runtime": "claude-code-tmux",
          "workflow_path": "/repo/WORKFLOW.fleet.md"
        }
        """
        let state = try decoder.decode(OrchestratorState.self, from: Data(json.utf8))
        XCTAssertEqual(state.trackerKind, "team-brain")
        XCTAssertEqual(state.trackerDisplayName, "team-brain")
        XCTAssertEqual(state.runtimeDisplayName, "Claude Code in tmux")
        XCTAssertTrue(state.isTmuxRuntime)
        XCTAssertEqual(state.workflowPath, "/repo/WORKFLOW.fleet.md")
        XCTAssertEqual(state.counts.completed, 4)
        XCTAssertEqual(state.retrying.first?.error, "turn_timeout")

        let run = try XCTUnwrap(state.running(for: "search_mvp_phase-2-rerank"))
        XCTAssertEqual(run.attach?.command, "tmux attach -t dispatch-search_mvp_phase-2-rerank-sess_9f3a1c2b")
        XCTAssertNil(state.running(for: "something-else"))
    }

    /// A pre-1.4.20 daemon ships the bare Symphony snapshot: no tracker /
    /// runtime / workflow fields and no per-entry workstream_id / attach.
    func testOrchestratorStateDecodesPre1420Shape() throws {
        let json = """
        {
          "poll_interval_ms": 5000,
          "max_concurrent_agents": 5,
          "stall_timeout_ms": 1000,
          "counts": { "running": 1, "retrying": 0, "claimed": 0, "completed": 0 },
          "running": [
            { "issue_id": "i1", "identifier": "ENG-1", "workspace_path": null, "started_at": "2026-09-07T10:00:00Z", "attempt": 1 }
          ],
          "retrying": []
        }
        """
        let state = try decoder.decode(OrchestratorState.self, from: Data(json.utf8))
        XCTAssertNil(state.trackerKind)
        XCTAssertEqual(state.trackerDisplayName, "—")
        XCTAssertFalse(state.isTmuxRuntime)
        XCTAssertNil(state.running.first?.workstreamID)
        XCTAssertNil(state.running.first?.attach)
        XCTAssertNil(state.running(for: "eng-1"))
    }

    // MARK: - Workstream.autonomous_running

    func testWorkstreamAutonomousRunningDecodesAndDefaultsFalse() throws {
        let withFlag = """
        { "workstream_id": "a", "title": "A", "created_at": "2026-09-07T10:00:00Z", "status": "active", "sessions": [], "autonomous_running": true }
        """
        let without = """
        { "workstream_id": "b", "title": "B", "created_at": "2026-09-07T10:00:00Z", "status": "active", "sessions": [] }
        """
        XCTAssertTrue(try decoder.decode(Workstream.self, from: Data(withFlag.utf8)).autonomousRunning)
        XCTAssertFalse(try decoder.decode(Workstream.self, from: Data(without.utf8)).autonomousRunning)
    }

    /// `statusColor` now routes through the shared palette so cards, columns
    /// and the detail header agree — pin that it equals `ResonaStatusTint`.
    func testWorkstreamStatusColorMatchesResonaTint() {
        for status in Workstream.Status.allCases {
            let ws = Workstream(id: "x", title: "X", createdAt: Date(timeIntervalSince1970: 0), status: status)
            XCTAssertEqual(ws.statusColor, ResonaStatusTint.forWorkstreamStatus(status.rawValue), "\(status)")
        }
    }

    // MARK: - WorkstreamLink tracker helpers

    func testTeamBrainLinkHelpers() {
        let link = WorkstreamLink(
            workstreamID: "w",
            trackerKind: "team-brain",
            issueID: "1st10s/mvp/phase-1-foundation",
            issueIdentifier: "1st10s/mvp/phase-1-foundation",
            issueURL: "file:///Users/me/team-brain/plans/1st10s/mvp/phase-1-foundation.md",
            lastSeenState: "implemented-pending-pr",
            lastSyncedAt: nil,
            createdAt: Date(timeIntervalSince1970: 0)
        )
        XCTAssertTrue(link.isTeamBrain)
        XCTAssertEqual(link.trackerDisplayName, "team-brain")
        XCTAssertEqual(link.noun, "plan")
        XCTAssertEqual(link.openLabel, "Open plan")
        XCTAssertEqual(link.symbolName, "doc.text")
        XCTAssertEqual(link.shortIdentifier, "phase-1-foundation")
        XCTAssertEqual(link.openURL?.isFileURL, true)
    }

    func testLinearLinkHelpersKeepV12Behavior() {
        let link = WorkstreamLink(
            workstreamID: "w",
            trackerKind: "linear",
            issueID: "lin_1",
            issueIdentifier: "ENG-7",
            issueURL: "https://linear.app/x/issue/ENG-7",
            lastSeenState: "In Progress",
            lastSyncedAt: nil,
            createdAt: Date(timeIntervalSince1970: 0)
        )
        XCTAssertFalse(link.isTeamBrain)
        XCTAssertEqual(link.noun, "issue")
        XCTAssertEqual(link.openLabel, "Open in Linear")
        XCTAssertEqual(link.shortIdentifier, "ENG-7")
        XCTAssertEqual(link.symbolName, "link")
    }

    // MARK: - SkillProposal.team_brain_path

    func testSkillProposalDecodesOptionalTeamBrainPath() throws {
        let json = """
        {
          "id": "prop_1", "workstream_id": "w", "title": "T", "body": "B",
          "source_decision_id": null, "proposed_at": "2026-09-07T10:00:00Z", "status": "promoted",
          "team_brain_path": "/tb/.agents/skills/t/SKILL.md"
        }
        """
        let p = try decoder.decode(SkillProposal.self, from: Data(json.utf8))
        XCTAssertEqual(p.teamBrainPath, "/tb/.agents/skills/t/SKILL.md")

        let bare = """
        { "id": "prop_2", "workstream_id": "w", "title": "T", "body": "B", "proposed_at": "2026-09-07T10:00:00Z", "status": "proposed" }
        """
        XCTAssertNil(try decoder.decode(SkillProposal.self, from: Data(bare.utf8)).teamBrainPath)
    }

    // MARK: - Attach safety

    func testAttachLauncherRejectsUnsafeSessionNames() {
        XCTAssertTrue(AttachLauncher.isSafeSessionName("dispatch-search_rerank-sess_9f3a1c2b"))
        XCTAssertFalse(AttachLauncher.isSafeSessionName(""))
        XCTAssertFalse(AttachLauncher.isSafeSessionName("x; rm -rf ~"))
        XCTAssertFalse(AttachLauncher.isSafeSessionName("name with space"))
        XCTAssertFalse(AttachLauncher.isSafeSessionName("a'b"))
    }

    // MARK: - Mock client

    func testMockOrchestratorStateDefaultsToFleetFixtureAndCanBeCleared() async throws {
        let client = MockDaemonClient(simulatedLatency: .zero)
        let fetched = try await client.getOrchestratorState()
        let state = try XCTUnwrap(fetched)
        XCTAssertEqual(state.trackerKind, "team-brain")
        XCTAssertNotNil(state.running(for: "search-rerank")?.attach)

        client.setOrchestratorState(nil)
        let cleared = try await client.getOrchestratorState()
        XCTAssertNil(cleared)
    }

    func testMockEmptyIsObservationOnly() async throws {
        let client = MockDaemonClient.empty()
        let state = try await client.getOrchestratorState()
        XCTAssertNil(state)
        let links = try await client.listLinks()
        XCTAssertTrue(links.isEmpty)
    }

    func testMockListLinksReflectsLinkAndUnlink() async throws {
        let client = MockDaemonClient(simulatedLatency: .zero)
        let seeded = try await client.listLinks()
        XCTAssertTrue(seeded.contains { $0.workstreamID == "search-rerank" && $0.isTeamBrain })

        _ = try await client.linkWorkstream(workstreamID: "frontend-refactor", trackerKind: "linear", issueIdentifier: "ENG-7")
        let afterLink = try await client.listLinks()
        XCTAssertTrue(afterLink.contains { $0.workstreamID == "frontend-refactor" })
        try await client.unlinkWorkstream(workstreamID: "frontend-refactor")
        let afterUnlink = try await client.listLinks()
        XCTAssertFalse(afterUnlink.contains { $0.workstreamID == "frontend-refactor" })
    }

    func testMockPromoteReportsTeamBrainPathWhenConfigured() async throws {
        let client = MockDaemonClient(simulatedLatency: .zero)
        let proposals = try await client.listProposedSkills()
        let target = try XCTUnwrap(proposals.first)
        let promoted = try await client.promoteSkill(id: target.id)
        let path = try XCTUnwrap(promoted.teamBrainPath)
        XCTAssertTrue(path.hasPrefix("/Users/you/Code/team-brain/.agents/skills/"))
        XCTAssertTrue(path.hasSuffix("/SKILL.md"))

        let plain = MockDaemonClient(teamBrainDir: nil, simulatedLatency: .zero)
        let plainProposals = try await plain.listProposedSkills()
        let target2 = try XCTUnwrap(plainProposals.first)
        let promotedPlain = try await plain.promoteSkill(id: target2.id)
        XCTAssertNil(promotedPlain.teamBrainPath)
    }

    func testMockAutonomousWorkstreamFixtureIsConsistent() async throws {
        let client = MockDaemonClient(simulatedLatency: .zero)
        let ws = try await client.getWorkstream(id: "search-rerank")
        XCTAssertTrue(ws.autonomousRunning)
        XCTAssertTrue(ws.liveSession)
        let fetched = try await client.getOrchestratorState()
        let state = try XCTUnwrap(fetched)
        XCTAssertEqual(state.running(for: ws.id)?.identifier, "search/mvp/phase-2-rerank")
    }
}

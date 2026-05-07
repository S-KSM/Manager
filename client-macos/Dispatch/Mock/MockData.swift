import Foundation

/// Fixture data so the macOS client can run, render, and demo without a
/// daemon. Five workstreams with varied state — active, blocked, paused,
/// retired — each with a sample memory blob and ~5–8 events. The
/// "frontend-refactor" workstream has a small decision tree (parent_id
/// chains) so the timeline view's indent rendering has something to show.
enum MockData {
    private static let now: Date = Date()
    private static func minutesAgo(_ m: Int) -> Date {
        Calendar.current.date(byAdding: .minute, value: -m, to: now) ?? now
    }
    private static func hoursAgo(_ h: Int) -> Date {
        Calendar.current.date(byAdding: .hour, value: -h, to: now) ?? now
    }
    private static func daysAgo(_ d: Int) -> Date {
        Calendar.current.date(byAdding: .day, value: -d, to: now) ?? now
    }

    // MARK: - Workstreams

    static let workstreams: [Workstream] = [
        Workstream(
            id: "frontend-refactor",
            title: "Frontend refactor: Redux → react-query",
            createdAt: daysAgo(3),
            status: .active,
            sessions: ["sess_01J9X...", "sess_01J9Y...", "sess_01JA0..."],
            currentSubgoal: "Migrating billing queries to react-query",
            latestConfidence: 0.78,
            needsAttention: false,
            // Frontend-refactor doubles as the "card has a TodoWrite plan"
            // demo. Mix of completed / in-progress / pending so the Plan
            // section in AgentDetailView exercises every status.
            todos: [
                Todo(content: "Pick query/cache library",
                     status: .completed,
                     activeForm: "Picking query/cache library"),
                Todo(content: "Extract billing queries module",
                     status: .completed,
                     activeForm: "Extracting billing queries module"),
                Todo(content: "Migrate billing queries to react-query",
                     status: .inProgress,
                     activeForm: "Migrating billing queries to react-query"),
                Todo(content: "Plumb optimistic updates",
                     status: .pending,
                     activeForm: "Plumbing optimistic updates"),
                Todo(content: "Drop Redux from non-offline views",
                     status: .pending,
                     activeForm: "Dropping Redux from non-offline views")
            ],
            latestActivity: "Editing src/dashboard/billing/queries.ts",
            lastEventAt: minutesAgo(2),
            liveSession: true
        ),
        Workstream(
            id: "auth-hardening",
            title: "Auth hardening (OIDC + refresh)",
            createdAt: daysAgo(1),
            status: .active,
            sessions: ["sess_01JA1..."],
            currentSubgoal: "Audit refresh-token rotation behaviour",
            latestConfidence: 0.42,
            needsAttention: true,
            // No TodoWrite yet — exercises the latest_activity fallback
            // path in WorkstreamCard.
            todos: nil,
            latestActivity: "Running: ./scripts/replay_refresh_token.sh --concurrent",
            lastEventAt: minutesAgo(7),
            liveSession: true
        ),
        Workstream(
            id: "infra-cost",
            title: "Infra cost audit (Q2)",
            createdAt: daysAgo(2),
            status: .active,
            sessions: ["sess_01JA2..."],
            currentSubgoal: "Profile staging cluster hot paths",
            latestConfidence: 0.65,
            needsAttention: false,
            todos: nil,
            latestActivity: "Running: kubectl top nodes",
            lastEventAt: minutesAgo(18),
            // Lifecycle is still active but the claude session has died —
            // showcases the awake/asleep distinction.
            liveSession: false
        ),
        Workstream(
            id: "marketing-copy",
            title: "Landing page copy v3",
            createdAt: daysAgo(4),
            status: .paused,
            sessions: ["sess_01J9V..."],
            currentSubgoal: "Awaiting brand sign-off on tagline options",
            latestConfidence: 0.55,
            needsAttention: false,
            todos: nil,
            latestActivity: nil,
            lastEventAt: hoursAgo(6),
            // Paused + no live session — the typical "asleep" pairing.
            liveSession: false
        ),
        Workstream(
            id: "search-rerank",
            title: "Search reranker experiment",
            createdAt: daysAgo(7),
            status: .retired,
            sessions: ["sess_01J9R..."],
            currentSubgoal: nil,
            latestConfidence: 0.92,
            needsAttention: false,
            todos: nil,
            latestActivity: nil,
            lastEventAt: daysAgo(1),
            liveSession: false
        ),
        // Two backlog demo workstreams so the kanban Backlog column has data
        // out of the box (shipped in v1.2 alongside the kanban swap).
        Workstream(
            id: "billing-redesign",
            title: "Billing surface redesign (Q3)",
            createdAt: daysAgo(1),
            status: .backlog,
            sessions: [],
            currentSubgoal: nil,
            latestConfidence: nil,
            needsAttention: false,
            todos: nil,
            latestActivity: nil,
            lastEventAt: nil,
            liveSession: false
        ),
        Workstream(
            id: "docs-migrate",
            title: "Docs site → MDX migration",
            createdAt: hoursAgo(20),
            status: .backlog,
            sessions: [],
            currentSubgoal: nil,
            latestConfidence: nil,
            needsAttention: false,
            todos: nil,
            latestActivity: nil,
            lastEventAt: nil,
            liveSession: false
        )
    ]

    // MARK: - Events

    static let eventsByWorkstream: [String: [Event]] = [
        "frontend-refactor":  frontendRefactorEvents,
        "auth-hardening":     authHardeningEvents,
        "infra-cost":         infraCostEvents,
        "marketing-copy":     marketingCopyEvents,
        "search-rerank":      searchRerankEvents
    ]

    // MARK: - Handbook + skill proposals (v1)

    /// Seeded team handbook contents (the read-only surface in HandbookView).
    static let handbook: String = """
# Team handbook

A living collection of patterns and skills the team has learned. New skills are
proposed by agents and promoted by the manager.

## Co-locate query keys with their components

Don't centralise query keys in a `keys.ts` registry. Co-locating them with the
component that owns the query keeps refactors local and makes the dependency
graph obvious in code review.

_from frontend-refactor / dec_12_

"""

    /// Pending skill proposals (agents proposed, manager hasn't acted on them).
    static let proposedSkills: [SkillProposal] = [
        SkillProposal(
            id: "skill_001",
            workstreamID: "auth-hardening",
            title: "Reuse-window detection for refresh tokens",
            body: """
Refresh-token rotation can have a small reuse window where the old token is
still accepted. Test for it explicitly with a concurrent refresh: hit the
endpoint twice in quick succession and assert the second one is rejected.
""",
            sourceDecisionID: "dec_03",
            proposedAt: minutesAgo(10),
            status: .proposed
        ),
        SkillProposal(
            id: "skill_002",
            workstreamID: "search-rerank",
            title: "Cap rerank windows at top-50",
            body: """
For cross-encoder rerankers on top of BM25, returns diminish past a top-50
window. Going to top-100 doubles the latency for sub-1% MRR gain in our eval.
""",
            sourceDecisionID: "dec_06",
            proposedAt: hoursAgo(20),
            status: .proposed
        )
    ]

    // MARK: - Memory

    static let memoryByWorkstream: [String: String] = [
        "frontend-refactor": """
# Workstream: frontend-refactor

## Goal
Migrate the dashboard package from Redux to react-query.

## Current state
- Phase 2 of 4 — auth queries done, billing queries in progress.
- Module split worked: per-feature query modules instead of a global store.

## Key decisions
- 2026-04-30 — chose react-query over SWR (see decision dec_07).
- 2026-05-01 — keep Redux for offline-cached views, drop it everywhere else (dec_09).

## Open questions
- Whether the offline cache strategy needs `persistQueryClient`.
- How to handle optimistic updates in the billing flow.

## Skills learned
- Pattern for migrating mutation-heavy slices (see dec_12).
- Co-locating query keys with the components that use them is much cleaner than the central registry we had with Redux.
""",
        "auth-hardening": """
# Workstream: auth-hardening

## Goal
Tighten the OIDC integration: refresh-token rotation, idle timeout, replay protection.

## Current state
- Found a refresh-token reuse window of ~4 seconds where the old token is still accepted. Needs human call on whether to harden by storage or by server-side revocation.

## Key decisions
- 2026-05-01 — short-lived access tokens (5 min) over long-lived (1 hr) (dec_03).

## Open questions
- Server-side revocation list vs sliding-window storage at the client.

## Skills learned
- (none yet)
""",
        "infra-cost": """
# Workstream: infra-cost

## Goal
Q2 infrastructure cost audit. Identify the top 3 cost drivers and propose mitigations.

## Current state
- Pulled the last 30 days of cost data.
- Top driver appears to be over-provisioned staging clusters running 24/7.

## Key decisions
- 2026-05-02 — start with compute, defer storage audit (dec_02).

## Open questions
- Are nightly staging clusters worth the cost?

## Skills learned
- (none yet)
""",
        "marketing-copy": """
# Workstream: marketing-copy

## Goal
Rewrite the landing page above-the-fold for the v3 launch.

## Current state
- Three taglines drafted, awaiting brand sign-off.

## Key decisions
- 2026-04-29 — lead with the "VP for AI agents" framing over the "manage your bots" framing (dec_01).

## Open questions
- Do we mention specific agent runtimes (Claude Code) on the landing page?

## Skills learned
- (none yet)
""",
        "search-rerank": """
# Workstream: search-rerank

## Goal
Prototype a learned reranker on top of the existing BM25 retrieval.

## Current state
- Shipped — +14% MRR on the eval set; merged behind a flag.

## Key decisions
- 2026-04-26 — cross-encoder reranker over learning-to-rank ensemble (dec_05).
- 2026-04-27 — keep BM25 as first stage, rerank top-50 (dec_06).

## Open questions
- (none — workstream retired)

## Skills learned
- Top-N rerank windows over 50 don't help; that's where to cap.
"""
    ]

    // MARK: - Per-workstream event lists

    /// frontend-refactor — has a decision-tree shape via parent_id chains
    /// so the timeline indent rendering exercises something non-trivial.
    private static let frontendRefactorEvents: [Event] = [
        Event(
            ts: minutesAgo(180),
            workstreamID: "frontend-refactor",
            sessionID: "sess_01J9X",
            type: .sessionStart,
            id: "evt_001",
            payload: .sessionStart(.init(sessionID: "sess_01J9X", runtime: "claude-code"))
        ),
        Event(
            ts: minutesAgo(178),
            workstreamID: "frontend-refactor",
            sessionID: "sess_01J9X",
            type: .subgoalPush,
            id: "evt_002",
            payload: .subgoalPush(.init(goal: "Pick a query/cache library"))
        ),
        Event(
            ts: minutesAgo(170),
            workstreamID: "frontend-refactor",
            sessionID: "sess_01J9X",
            type: .decision,
            id: "dec_07",
            parentID: nil,
            payload: .decision(.init(
                considered: ["use react-query", "use SWR", "roll our own"],
                choice: "use react-query",
                rationale: "team already has a react-query setup in the API package; SWR adds a dep without payoff",
                confidence: 0.8
            ))
        ),
        Event(
            ts: minutesAgo(120),
            workstreamID: "frontend-refactor",
            sessionID: "sess_01J9Y",
            type: .decision,
            id: "dec_09",
            parentID: "dec_07",
            payload: .decision(.init(
                considered: ["drop Redux entirely", "keep Redux for offline views"],
                choice: "keep Redux for offline views",
                rationale: "offline cache invalidation in react-query needs `persistQueryClient`; risk is too high mid-migration",
                confidence: 0.7
            ))
        ),
        Event(
            ts: minutesAgo(95),
            workstreamID: "frontend-refactor",
            sessionID: "sess_01J9Y",
            type: .toolUse,
            id: "evt_005",
            payload: .toolUse(.init(tool: "Edit", phase: "post", summary: "extracted billing queries module"))
        ),
        Event(
            ts: minutesAgo(60),
            workstreamID: "frontend-refactor",
            sessionID: "sess_01JA0",
            type: .decision,
            id: "dec_12",
            parentID: "dec_09",
            payload: .decision(.init(
                considered: ["per-feature query modules", "central queries.ts", "co-locate with components"],
                choice: "per-feature query modules",
                rationale: "matches existing API package structure; easier code review per feature owner",
                confidence: 0.85
            ))
        ),
        Event(
            ts: minutesAgo(20),
            workstreamID: "frontend-refactor",
            sessionID: "sess_01JA0",
            type: .confidence,
            id: "evt_007",
            payload: .confidence(.init(value: 0.78, note: "billing tests passing locally"))
        ),
        Event(
            ts: minutesAgo(2),
            workstreamID: "frontend-refactor",
            sessionID: "sess_01JA0",
            type: .memoryUpdate,
            id: "evt_008",
            payload: .memoryUpdate(.init(section: "Skills learned",
                                         summary: "co-locating query keys beats a central registry"))
        )
    ]

    /// auth-hardening — currently blocked, so it surfaces in the digest.
    private static let authHardeningEvents: [Event] = [
        Event(
            ts: minutesAgo(75),
            workstreamID: "auth-hardening",
            sessionID: "sess_01JA1",
            type: .sessionStart,
            id: "evt_a01",
            payload: .sessionStart(.init(sessionID: "sess_01JA1", runtime: "claude-code"))
        ),
        Event(
            ts: minutesAgo(70),
            workstreamID: "auth-hardening",
            sessionID: "sess_01JA1",
            type: .subgoalPush,
            id: "evt_a02",
            payload: .subgoalPush(.init(goal: "Audit refresh-token rotation behaviour"))
        ),
        Event(
            ts: minutesAgo(45),
            workstreamID: "auth-hardening",
            sessionID: "sess_01JA1",
            type: .decision,
            id: "dec_03",
            payload: .decision(.init(
                considered: ["5-min access tokens", "1-hour access tokens"],
                choice: "5-min access tokens",
                rationale: "limits blast radius of leaked tokens; refresh path already exists",
                confidence: 0.75
            ))
        ),
        Event(
            ts: minutesAgo(25),
            workstreamID: "auth-hardening",
            sessionID: "sess_01JA1",
            type: .toolUse,
            id: "evt_a04",
            payload: .toolUse(.init(tool: "Bash", phase: "post",
                                    summary: "ran refresh-token replay test — 4-second reuse window"))
        ),
        Event(
            ts: minutesAgo(7),
            workstreamID: "auth-hardening",
            sessionID: "sess_01JA1",
            type: .blocked,
            id: "evt_a05",
            payload: .blocked(.init(
                reason: "Refresh-token reuse window detected (~4s). Need a call: client-side storage rotation vs server-side revocation list."
            ))
        )
    ]

    /// infra-cost — straightforward in-progress audit.
    private static let infraCostEvents: [Event] = [
        Event(
            ts: minutesAgo(90),
            workstreamID: "infra-cost",
            sessionID: "sess_01JA2",
            type: .sessionStart,
            id: "evt_i01",
            payload: .sessionStart(.init(sessionID: "sess_01JA2", runtime: "claude-code"))
        ),
        Event(
            ts: minutesAgo(85),
            workstreamID: "infra-cost",
            sessionID: "sess_01JA2",
            type: .decision,
            id: "dec_02",
            payload: .decision(.init(
                considered: ["compute first", "storage first", "egress first"],
                choice: "compute first",
                rationale: "compute is 62% of last 30d; biggest lever",
                confidence: 0.9
            ))
        ),
        Event(
            ts: minutesAgo(60),
            workstreamID: "infra-cost",
            sessionID: "sess_01JA2",
            type: .subgoalPush,
            id: "evt_i03",
            payload: .subgoalPush(.init(goal: "Profile staging cluster hot paths"))
        ),
        Event(
            ts: minutesAgo(35),
            workstreamID: "infra-cost",
            sessionID: "sess_01JA2",
            type: .toolUse,
            id: "evt_i04",
            payload: .toolUse(.init(tool: "Bash", summary: "kubectl top nodes — staging-east hot"))
        ),
        Event(
            ts: minutesAgo(18),
            workstreamID: "infra-cost",
            sessionID: "sess_01JA2",
            type: .confidence,
            id: "evt_i05",
            payload: .confidence(.init(value: 0.65, note: "rough sizing only; need a longer profile"))
        )
    ]

    private static let marketingCopyEvents: [Event] = [
        Event(
            ts: hoursAgo(8),
            workstreamID: "marketing-copy",
            sessionID: "sess_01J9V",
            type: .sessionStart,
            id: "evt_m01",
            payload: .sessionStart(.init(sessionID: "sess_01J9V", runtime: "claude-code"))
        ),
        Event(
            ts: hoursAgo(7),
            workstreamID: "marketing-copy",
            sessionID: "sess_01J9V",
            type: .decision,
            id: "dec_01",
            payload: .decision(.init(
                considered: ["VP for AI agents", "manage your bots", "your AI team, on one screen"],
                choice: "VP for AI agents",
                rationale: "matches the product framing in CLAUDE.md; the others undersell the methodology angle",
                confidence: 0.6
            ))
        ),
        Event(
            ts: hoursAgo(6),
            workstreamID: "marketing-copy",
            sessionID: "sess_01J9V",
            type: .sessionEnd,
            id: "evt_m03",
            payload: .sessionEnd(.init(reason: "awaiting brand sign-off"))
        )
    ]

    private static let searchRerankEvents: [Event] = [
        Event(
            ts: daysAgo(7),
            workstreamID: "search-rerank",
            sessionID: "sess_01J9R",
            type: .sessionStart,
            id: "evt_s01",
            payload: .sessionStart(.init(sessionID: "sess_01J9R", runtime: "claude-code"))
        ),
        Event(
            ts: daysAgo(7),
            workstreamID: "search-rerank",
            sessionID: "sess_01J9R",
            type: .decision,
            id: "dec_05",
            payload: .decision(.init(
                considered: ["cross-encoder reranker", "learning-to-rank ensemble", "no rerank"],
                choice: "cross-encoder reranker",
                rationale: "small model, strong baseline, fits within latency budget",
                confidence: 0.7
            ))
        ),
        Event(
            ts: daysAgo(6),
            workstreamID: "search-rerank",
            sessionID: "sess_01J9R",
            type: .decision,
            id: "dec_06",
            parentID: "dec_05",
            payload: .decision(.init(
                considered: ["rerank top-25", "rerank top-50", "rerank top-100"],
                choice: "rerank top-50",
                rationale: "diminishing returns past top-50 in the eval set",
                confidence: 0.8
            ))
        ),
        Event(
            ts: daysAgo(2),
            workstreamID: "search-rerank",
            sessionID: "sess_01J9R",
            type: .confidence,
            id: "evt_s04",
            payload: .confidence(.init(value: 0.92, note: "+14% MRR on eval set"))
        ),
        Event(
            ts: daysAgo(1),
            workstreamID: "search-rerank",
            sessionID: "sess_01J9R",
            type: .sessionEnd,
            id: "evt_s05",
            payload: .sessionEnd(.init(reason: "shipped behind flag"))
        )
    ]

    // MARK: - Reports + scheduler (v1.1)

    /// Mirrors the daemon's built-in audience presets. Kept here so previews
    /// and offline launches can render the audience dropdown without the
    /// daemon round-trip.
    static let reportPresets: [ReportPreset] = [
        ReportPreset(
            id: "executive",
            name: "Executive",
            description: "Lead with outcomes and risks. 5–7 quantified bullets.",
            systemPrompt: "You write a weekly executive summary for a busy senior leader. Lead with outcomes and risks, not activity. Use 5-7 bullet points. Quantify when possible. Skip implementation detail unless it explains a risk."
        ),
        ReportPreset(
            id: "business_partner",
            name: "Business partner",
            description: "Commitments and timelines. Plain language.",
            systemPrompt: "You write an update for a business partner who cares about commitments and timelines. Focus on shipped/in-flight commitments and any blockers needing their action. Use plain language."
        ),
        ReportPreset(
            id: "engineer_peer",
            name: "Engineer peer",
            description: "Methodology, what was tried, what was learned.",
            systemPrompt: "You write a peer technical update for engineers on adjacent teams. Include the methodology — what was tried, why a particular path was chosen, what was learned. Useful for cross-pollinating techniques."
        ),
        ReportPreset(
            id: "sponsor",
            name: "Sponsor",
            description: "Traction signals, deliverables, asks.",
            systemPrompt: "You write a status update for an investor or program sponsor. Lead with traction signals, deliverables landed, and risks/asks. Keep tone confident and crisp."
        )
    ]

    /// Two seeded reports — one draft (typically scheduler output awaiting
    /// review) and one saved (user kept it). Body is a few lines of plausible
    /// Markdown so the viewer / list rows render meaningfully.
    static let reports: [Report] = [
        Report(
            id: "rep_seed_draft01",
            title: "Weekly draft — pending review",
            audiencePreset: "executive",
            audienceFreetext: nil,
            periodSince: daysAgo(7),
            periodUntil: now,
            workstreamIDs: ["frontend-refactor", "auth-hardening"],
            provider: "claude",
            model: "claude-sonnet-4-7",
            bodyMD: """
            # Weekly update (draft)

            ## Highlights

            - **Frontend refactor** — first feature module fully migrated to react-query; bundle size down 6%.
            - **Auth hardening** — refresh-token reuse window tightened to 30s; one regression caught in eval.

            ## Risks

            - Pending decision on offline-cache strategy; needs sync with mobile team.

            ## Asks

            - 30 minutes with security to ratify rotation cadence.
            """,
            status: .draft,
            generatedAt: hoursAgo(2),
            savedAt: nil
        ),
        Report(
            id: "rep_seed_saved01",
            title: "Last week — executive update",
            audiencePreset: "executive",
            audienceFreetext: nil,
            periodSince: daysAgo(14),
            periodUntil: daysAgo(7),
            workstreamIDs: ["frontend-refactor", "auth-hardening", "infra-cost"],
            provider: "claude",
            model: "claude-sonnet-4-7",
            bodyMD: """
            # Weekly update — last week

            ## Highlights

            - **Frontend refactor** — landed query-key registry; 3 modules migrated.
            - **Auth hardening** — OIDC flow now hardened against refresh reuse.
            - **Infra cost** — staging cluster right-sized; ~18% monthly savings.

            ## Risks

            - None blocking.

            ## Next week

            - Begin search reranker rollout.
            """,
            status: .saved,
            generatedAt: daysAgo(7),
            savedAt: daysAgo(7)
        )
    ]

    /// Default scheduler config — both jobs disabled until the user opts in.
    static let schedulerJobs: [SchedulerJob] = [
        SchedulerJob(
            id: "weekly_report",
            enabled: false,
            cron: "0 8 * * 1",
            audiencePreset: "executive",
            provider: "claude",
            model: nil,
            nextFireAt: nil
        ),
        SchedulerJob(
            id: "monthly_report",
            enabled: false,
            cron: "0 8 1 * *",
            audiencePreset: "executive",
            provider: "claude",
            model: nil,
            nextFireAt: nil
        )
    ]
}

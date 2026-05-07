import SwiftUI

/// Agent detail surface (see docs/ARCHITECTURE.md > "Agent detail").
///
/// Two panes:
///   - MethodologyTimelineView: the structured decision/sub-goal timeline
///     built from `decision`, `subgoal_push`, `confidence`, and `blocked`
///     events. Decisions expand to show considered/choice/rationale/confidence.
///   - MemoryPaneView: the workstream's Markdown memory file, read-only in v0.
///
/// The header carries the v0.5 "Intervene" button which opens the
/// `InterventionPanel` sheet (nudge / redirect / rollback).
struct AgentDetailView: View {
    let workstream: Workstream
    let client: DaemonClientProtocol
    var onBackToHome: (() -> Void)? = nil

    @State private var events: [Event] = []
    @State private var memoryRaw: String = ""
    @State private var loadingEvents = true
    @State private var loadingMemory = true
    @State private var showInterventionPanel = false
    @State private var promoteTarget: PromoteTarget?
    /// v1.4.4 — pending approval-required interventions polled from the daemon.
    /// Drives the Approve/Deny strip below the header.
    @State private var pendingApprovals: [Intervention] = []

    /// v1.2 — current Linear-link state. nil = not linked. Refreshed on
    /// every workstream change + after Link/Unlink operations.
    @State private var linearLink: WorkstreamLink? = nil
    @State private var showLinkSheet = false

    /// Live copy of the workstream record. Seeded from the parent's snapshot
    /// at view-task time; refreshed on every WS event arrival so daemon-side
    /// projections (todos, latest_activity) flow into the Plan section
    /// without waiting for the user to navigate back to the home view.
    @State private var liveWorkstream: Workstream?

    /// The workstream view is rendered against. Falls through to the parent
    /// snapshot until the first refresh lands.
    private var currentWorkstream: Workstream {
        liveWorkstream ?? workstream
    }

    /// Source decision being promoted into a handbook skill. Drives the
    /// `PromoteSkillSheet` modal.
    struct PromoteTarget: Identifiable, Hashable {
        let decisionID: String
        let title: String
        let body: String
        var id: String { decisionID }
    }

    var body: some View {
        HSplitView {
            VStack(alignment: .leading, spacing: 0) {
                header
                if !pendingApprovals.isEmpty {
                    Divider()
                    ApprovalStrip(
                        pending: pendingApprovals,
                        onDecide: { intv, approved in
                            Task { await decide(intv: intv, approved: approved) }
                        }
                    )
                }
                Divider()
                MethodologyTimelineView(
                    events: events,
                    isLoading: loadingEvents,
                    onPromoteDecision: { decision, eventID in
                        promoteTarget = PromoteTarget(
                            decisionID: eventID,
                            title: decision.choice,
                            body: decision.rationale
                        )
                    }
                )
            }
            .frame(minWidth: 280, idealWidth: 560, maxWidth: .infinity, maxHeight: .infinity)

            VStack(alignment: .leading, spacing: 0) {
                memoryHeader
                Divider()
                // Plan section (Feature B). Glanceable checklist of the
                // agent's current TodoWrite plan, rendered above the
                // Markdown memory body. Omitted entirely when no todos have
                // been seen — no empty placeholder.
                if let todos = currentWorkstream.todos, !todos.isEmpty {
                    PlanSection(todos: todos)
                        .padding(.horizontal, 18)
                        .padding(.top, 14)
                        .padding(.bottom, 6)
                    Divider()
                }
                MemoryPaneView(
                    memory: WorkstreamMemory(
                        workstreamID: workstream.id,
                        raw: memoryRaw
                    ),
                    isLoading: loadingMemory
                )
            }
            .frame(minWidth: 220, idealWidth: 380, maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationTitle(workstream.title)
        .navigationSubtitle(workstream.id)
        .task(id: workstream.id) {
            // Initial historical fetch (events + memory + workstream record).
            liveWorkstream = workstream
            await reload()
            await refreshPendingApprovals()
            await refreshLinearLink()
            // Then live-subscribe to new events for this workstream until
            // `.task(id:)` cancels us (workstream change or view disappear).
            // Cancellation propagates into the AsyncStream, which calls
            // its `onTermination` handler to close the underlying WS task.
            let stream = client.streamEvents(workstreamID: workstream.id)
            for await event in stream {
                if Task.isCancelled { break }
                appendLive(event: event)
                // The Plan section + "Currently:" line are daemon-side
                // projections, so we re-fetch the workstream record so
                // their fields refresh in step with the timeline.
                if let refreshed = try? await client.getWorkstream(id: workstream.id) {
                    liveWorkstream = refreshed
                }
                // Cheap to re-poll on every event; queue is single-digit
                // rows and the request is local-loopback.
                await refreshPendingApprovals()
                // The Linear sync ticker mutates link rows server-side; pick
                // up state changes (last_seen_state, last_synced_at) on the
                // same WS-event cadence as the rest of the header.
                await refreshLinearLink()
            }
            // If we get here, the stream ended (transport failure or
            // cancellation). Reconnect is a v1 deliverable.
        }
        .sheet(isPresented: $showInterventionPanel) {
            InterventionPanel(
                workstream: workstream,
                events: events,
                client: client,
                onSent: { await reload() }
            )
        }
        .sheet(item: $promoteTarget) { target in
            PromoteSkillSheet(
                workstream: workstream,
                sourceDecisionID: target.decisionID,
                initialTitle: target.title,
                initialBody: target.body,
                client: client,
                onSaved: {},
                onDismiss: { promoteTarget = nil }
            )
        }
        .sheet(isPresented: $showLinkSheet) {
            LinkLinearSheet(
                workstream: workstream,
                client: client,
                onLinked: { link in
                    linearLink = link
                    showLinkSheet = false
                },
                onCancel: { showLinkSheet = false }
            )
        }
    }

    private func refreshLinearLink() async {
        linearLink = (try? await client.getWorkstreamLink(workstreamID: workstream.id)) ?? nil
    }

    private func unlink() async {
        try? await client.unlinkWorkstream(workstreamID: workstream.id)
        linearLink = nil
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            if let onBackToHome {
                Button(action: onBackToHome) {
                    Label("Home", systemImage: "chevron.left")
                        .labelStyle(.titleAndIcon)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .help("Back to the radar (home view)")
            }
            // Big animated mascot for the agent detail header — works /
            // thinks / blocks / sleeps based on the workstream's projection.
            RobotMascot(workstream: workstream, size: 56)
            VStack(alignment: .leading, spacing: 2) {
                Text(workstream.title)
                    .font(.title2.weight(.semibold))
                    .lineLimit(1)
                    .truncationMode(.tail)
                HStack(spacing: 6) {
                    Text(workstream.id)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let activity = currentActivityLine {
                        Text("·").foregroundStyle(.tertiary)
                        Image(systemName: "hammer")
                            .imageScale(.small)
                            .foregroundStyle(.secondary)
                        Text(activity)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
            }
            .layoutPriority(1)
            Spacer(minLength: 8)
            HStack(spacing: 6) {
                Circle().fill(workstream.statusColor).frame(width: 8, height: 8)
                Text(workstream.statusLabel)
                    .font(.caption)
                    .lineLimit(1)
                    .fixedSize()
            }
            if workstream.needsAttention {
                Label("Needs you", systemImage: "exclamationmark.bubble.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.orange)
                    .labelStyle(.titleAndIcon)
                    .lineLimit(1)
                    .fixedSize()
            }
            LinearChip(
                link: linearLink,
                onLink: { showLinkSheet = true },
                onUnlink: { Task { await unlink() } }
            )
            .layoutPriority(0)
            Button {
                showInterventionPanel = true
            } label: {
                Label("Intervene", systemImage: "wand.and.stars")
            }
            .buttonStyle(.borderedProminent)
            .tint(.purple)
            .controlSize(.small)
            .help("Send a nudge, redirect, or rollback to this workstream.")
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 14)
    }

    private var memoryHeader: some View {
        HStack {
            Image(systemName: "doc.text")
            Text("Memory")
                .font(.headline)
            Spacer()
            Text("read-only — v0")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.thinMaterial)
    }

    /// Header status line, in priority order:
    ///  1. LLM-generated `activityHeadline` from the daemon (best — full sentence).
    ///  2. The in-progress todo's `activeForm` if a TodoWrite has been seen.
    ///  3. Daemon's deterministic humanized last `tool_use` (`latestActivity`).
    private var currentActivityLine: String? {
        if let headline = workstream.activityHeadline, !headline.isEmpty {
            return headline
        }
        if let todos = workstream.todos {
            if let active = todos.first(where: { $0.status == .inProgress }) {
                return active.activeForm ?? active.content
            }
        }
        return workstream.latestActivity
    }

    private func reload() async {
        loadingEvents = true
        loadingMemory = true
        async let evs: [Event]   = (try? await client.getEvents(workstreamID: workstream.id)) ?? []
        async let mem: String    = (try? await client.getMemory(workstreamID: workstream.id)) ?? ""
        let (e, m) = await (evs, mem)
        events = e.sorted { $0.ts > $1.ts }
        memoryRaw = m
        loadingEvents = false
        loadingMemory = false
    }

    /// Append a live-streamed event into `events`, skipping duplicates by id
    /// and re-sorting by ts so newest stays on top.
    private func appendLive(event: Event) {
        if events.contains(where: { $0.id == event.id }) { return }
        var next = events
        next.append(event)
        next.sort { $0.ts > $1.ts }
        events = next
    }

    private func refreshPendingApprovals() async {
        let all = (try? await client.listPendingInterventions(workstreamID: workstream.id)) ?? []
        pendingApprovals = all.filter { $0.kind == .approvalRequired }
    }

    private func decide(intv: Intervention, approved: Bool) async {
        _ = try? await client.decideApproval(
            workstreamID: workstream.id,
            interventionID: intv.id,
            approved: approved
        )
        await refreshPendingApprovals()
    }
}

// MARK: - v1.2 Linear chip

/// Tracker-link chip rendered in the AgentDetail header. Two states:
///
/// - **Linked**: link icon + identifier + a Menu offering "Open in Linear"
///   and "Unlink" actions. Truncates the identifier so a long custom prefix
///   doesn't push the rest of the header off-screen.
/// - **Unlinked**: a small "Link…" button that opens `LinkLinearSheet`.
struct LinearChip: View {
    let link: WorkstreamLink?
    let onLink: () -> Void
    let onUnlink: () -> Void

    var body: some View {
        if let link {
            Menu {
                if let urlString = link.issueURL,
                   let url = URL(string: urlString) {
                    Link(destination: url) {
                        Label("Open in Linear", systemImage: "arrow.up.right.square")
                    }
                }
                Divider()
                Button(role: .destructive, action: onUnlink) {
                    Label("Unlink", systemImage: "link.badge.plus")
                }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "link")
                        .imageScale(.small)
                    Text(link.issueIdentifier)
                        .font(.caption.weight(.medium))
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(
                    Capsule().fill(Color.purple.opacity(0.15))
                )
                .overlay(
                    Capsule().stroke(Color.purple.opacity(0.45), lineWidth: 1)
                )
                .foregroundStyle(.purple)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Linked to Linear issue \(link.issueIdentifier)")
        } else {
            Button(action: onLink) {
                Label("Link…", systemImage: "link")
                    .labelStyle(.titleAndIcon)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .help("Link this workstream to a Linear issue")
        }
    }
}

// MARK: - v1.4.4 Approval strip

/// Banner rendered between the AgentDetail header and the methodology
/// timeline whenever the workstream has one or more pending
/// `approval_required` interventions. Each row carries its own Approve /
/// Deny pair so a single ack only resolves that specific request.
struct ApprovalStrip: View {
    let pending: [Intervention]
    var onDecide: (Intervention, Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(pending) { intv in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Image(systemName: "hand.raised.fill")
                        .foregroundStyle(.orange)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(intv.payload.approvalRequest?.summary
                             ?? intv.payload.message
                             ?? "Agent is asking for permission")
                            .font(.body.weight(.semibold))
                        if let detail = intv.payload.approvalRequest?.detail, !detail.isEmpty {
                            Text(detail)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                    }
                    Spacer()
                    Button("Deny") { onDecide(intv, false) }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .help("Reject this request — the agent is told not to proceed")
                    Button("Approve") { onDecide(intv, true) }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .keyboardShortcut(.defaultAction)
                        .help("Allow this request — the agent proceeds on its next turn")
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Color.orange.opacity(0.08))
    }
}

// MARK: - Methodology timeline

struct MethodologyTimelineView: View {
    let events: [Event]
    let isLoading: Bool
    /// Called when the user clicks "Promote…" on a decision row. The first
    /// argument is the decision payload and the second is the originating
    /// event id (used as `source_decision_id` when posting to the handbook).
    var onPromoteDecision: ((EventPayload.Decision, String) -> Void)? = nil

    @State private var expandedIDs: Set<String> = []

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if events.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        if isLoading {
                            ProgressView().controlSize(.small)
                        } else {
                            Text("No events yet for this workstream.")
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(20)
                } else {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(timelineItems) { item in
                            switch item {
                            case .event(let event):
                                TimelineRow(
                                    event: event,
                                    indent: indent(for: event),
                                    isExpanded: expandedIDs.contains(event.id),
                                    onToggle: { toggle(event.id) },
                                    onPromote: onPromoteDecision.map { handler in
                                        {
                                            if case .decision(let d) = event.payload {
                                                handler(d, event.id)
                                            }
                                        }
                                    }
                                )
                            case .toolRun(let id, let runEvents):
                                ToolRunPill(
                                    runEvents: runEvents,
                                    isExpanded: expandedIDs.contains("run-\(id)"),
                                    onToggle: { toggle("run-\(id)") }
                                )
                            }
                        }
                    }
                    .padding(.horizontal, 18)
                    .padding(.vertical, 14)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func toggle(_ id: String) {
        if expandedIDs.contains(id) { expandedIDs.remove(id) }
        else                        { expandedIDs.insert(id) }
    }

    /// Group consecutive `tool_use` events into a single `toolRun` item so
    /// the timeline reads as a story (decisions / sub-goals / blocks) with
    /// the low-level tool calls collapsed into a count pill the user can
    /// expand on demand. Operates on `events` in their current display
    /// order (newest first).
    ///
    /// `user-prompt-submit` events are *also* `tool_use` on the wire (the
    /// hook layer routes them through the same envelope), but they carry
    /// the human/system prompt that triggered the next turn — story-level
    /// signal, not bash noise. Render them as their own row.
    private var timelineItems: [TimelineItem] {
        var items: [TimelineItem] = []
        var run: [Event] = []
        let flush = {
            if !run.isEmpty {
                items.append(.toolRun(id: run[0].id, events: run))
                run = []
            }
        }
        for ev in events {
            if case .toolUse(let t) = ev.payload, t.phase != "user-prompt-submit" {
                run.append(ev)
            } else {
                flush()
                items.append(.event(ev))
            }
        }
        flush()
        return items
    }

    /// Visual indent based on `parent_id` chain depth. Bounded so deep trees
    /// don't run off the edge of the pane.
    private func indent(for event: Event) -> Int {
        var depth = 0
        var current: Event? = event
        let byID = Dictionary(uniqueKeysWithValues: events.map { ($0.id, $0) })
        while let e = current, let parentID = e.parentID, let parent = byID[parentID] {
            depth += 1
            current = parent
            if depth > 6 { break }
        }
        return depth
    }
}

private struct TimelineRow: View {
    let event: Event
    let indent: Int
    let isExpanded: Bool
    let onToggle: () -> Void
    /// Tapped via the row's "Promote…" affordance (only present on decision
    /// rows). Nil for non-decision events or when the parent view does not
    /// supply a handler.
    let onPromote: (() -> Void)?

    private static let timeFormatter: DateFormatter = {
        let df = DateFormatter()
        df.dateFormat = "MMM d, HH:mm"
        return df
    }()

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if indent > 0 {
                Color.clear.frame(width: CGFloat(indent) * 18, height: 1)
                Image(systemName: "arrow.turn.down.right")
                    .imageScale(.small)
                    .foregroundStyle(.tertiary)
                    .padding(.top, 4)
            }
            iconBubble
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text(headline)
                        .font(.callout.weight(.medium))
                    Spacer(minLength: 8)
                    if case .decision = event.payload, let onPromote {
                        Button {
                            onPromote()
                        } label: {
                            Label("Promote…", systemImage: "books.vertical")
                                .labelStyle(.titleAndIcon)
                        }
                        .buttonStyle(.borderless)
                        .controlSize(.small)
                        .help("Promote this decision into a team handbook skill.")
                    }
                    Text(Self.timeFormatter.string(from: event.ts))
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.tertiary)
                }
                if let sub = subline {
                    Text(sub)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(isExpanded ? nil : 2)
                }
                if isExpanded, case .decision(let d) = event.payload {
                    DecisionDetail(decision: d)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .contentShape(Rectangle())
        .onTapGesture {
            if case .decision = event.payload {
                onToggle()
            }
        }
        .contextMenu {
            if case .decision = event.payload, let onPromote {
                Button {
                    onPromote()
                } label: {
                    Label("Promote to handbook…", systemImage: "books.vertical")
                }
            }
        }
    }

    @ViewBuilder
    private var iconBubble: some View {
        ZStack {
            Circle()
                .fill(iconTint.opacity(0.18))
            Image(systemName: iconName)
                .imageScale(.small)
                .foregroundStyle(iconTint)
        }
        .frame(width: 22, height: 22)
        .padding(.top, 2)
    }

    private var iconName: String {
        switch event.payload {
        case .decision:               return "sparkles"
        case .subgoalPush:            return "arrow.down.circle"
        case .subgoalPop:             return "arrow.up.circle"
        case .confidence:             return "gauge.with.dots.needle.bottom.50percent"
        case .toolUse(let t):
            return t.phase == "user-prompt-submit" ? "text.bubble" : "wrench.adjustable"
        case .blocked:                return "exclamationmark.octagon.fill"
        case .memoryUpdate:           return "doc.text"
        case .sessionStart:           return "play.circle"
        case .sessionEnd:             return "stop.circle"
        case .interventionDelivered:  return "bubble.left.and.bubble.right"
        }
    }

    private var iconTint: Color {
        switch event.payload {
        case .decision:               return .accentColor
        case .blocked:                return .orange
        case .confidence:             return .blue
        case .memoryUpdate:           return .purple
        case .interventionDelivered:  return .pink
        case .toolUse(let t):
            return t.phase == "user-prompt-submit" ? .accentColor : .secondary
        default:                      return .secondary
        }
    }

    private var headline: String {
        switch event.payload {
        case .decision(let d):
            return "Decision: \(d.choice)"
        case .subgoalPush(let s):
            let prefix = s.source == "synthesized" ? "🤖 " : ""
            return "\(prefix)Sub-goal pushed: \(s.goal)"
        case .subgoalPop(let s):
            return "Sub-goal popped\(s.goal.map { ": \($0)" } ?? "")"
        case .confidence(let c):
            return "Confidence \(Int((c.value * 100).rounded()))%"
        case .toolUse(let t):
            if t.phase == "user-prompt-submit" {
                let body = (t.summary?.isEmpty == false ? t.summary! : t.tool)
                let oneLine = body
                    .replacingOccurrences(of: "\n", with: " ")
                    .trimmingCharacters(in: .whitespaces)
                let truncated = oneLine.count > 120
                    ? oneLine.prefix(119) + "…"
                    : Substring(oneLine)
                return "Prompt: \(truncated)"
            }
            let verb: String
            switch t.phase {
            case "post-tool-use", "post":           verb = "ran"
            default:                                verb = "uses"
            }
            return "\(verb) \(t.tool)"
        case .blocked(let b):
            return "Blocked: \(b.reason)"
        case .memoryUpdate(let m):
            return "Memory updated: \(m.section)"
        case .sessionStart:
            return "Session started"
        case .sessionEnd:
            return "Session ended"
        case .interventionDelivered(let i):
            return "Intervention delivered (\(i.kind))"
        }
    }

    private var subline: String? {
        switch event.payload {
        case .decision(let d):
            return d.rationale
        case .toolUse(let t):
            // The prompt body already became the headline for
            // user-prompt-submit rows — no need to repeat it as subline.
            return t.phase == "user-prompt-submit" ? nil : t.summary
        case .confidence(let c):
            return c.note
        case .memoryUpdate(let m):
            return m.summary
        case .sessionEnd(let s):
            return s.lastAssistantMessage
        default:
            return nil
        }
    }
}

// MARK: - Tool-run grouping

/// One entry in the rendered timeline. Either a story-level event (decision,
/// sub-goal, blocked, …) or a contiguous run of `tool_use` events collapsed
/// into a single expandable pill so the user sees narrative, not bash calls.
private enum TimelineItem: Identifiable {
    case event(Event)
    case toolRun(id: String, events: [Event])

    var id: String {
        switch self {
        case .event(let e):           return e.id
        case .toolRun(let id, _):     return "run-\(id)"
        }
    }
}

/// Compact "12 actions ▸" row that hides a contiguous run of `tool_use`
/// events. Tapping the row expands the run into individual TimelineRows
/// indented underneath.
private struct ToolRunPill: View {
    let runEvents: [Event]
    let isExpanded: Bool
    let onToggle: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button(action: onToggle) {
                HStack(spacing: 8) {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .imageScale(.small)
                        .foregroundStyle(.tertiary)
                    Image(systemName: "wrench.adjustable")
                        .imageScale(.small)
                        .foregroundStyle(.secondary)
                    Text("\(runEvents.count) action\(runEvents.count == 1 ? "" : "s")")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                }
                .padding(.vertical, 4)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(isExpanded
                  ? "Collapse this run of tool calls"
                  : "Expand to see each tool call in this run")

            if isExpanded {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(runEvents) { ev in
                        TimelineRow(
                            event: ev,
                            indent: 1,
                            isExpanded: false,
                            onToggle: {},
                            onPromote: nil
                        )
                    }
                }
            }
        }
    }
}

private struct DecisionDetail: View {
    let decision: EventPayload.Decision

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !decision.considered.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Considered")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .textCase(.uppercase)
                    ForEach(decision.considered, id: \.self) { c in
                        HStack(alignment: .top, spacing: 4) {
                            Text(c == decision.choice ? "✓" : "•")
                                .foregroundStyle(c == decision.choice ? Color.green : Color.gray.opacity(0.6))
                            Text(c)
                                .font(.caption)
                                .foregroundStyle(c == decision.choice ? .primary : .secondary)
                        }
                    }
                }
            }
            HStack(spacing: 4) {
                Text("Confidence")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)
                Text("\(Int((decision.confidence * 100).rounded()))%")
                    .font(.caption.monospacedDigit())
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(Color.gray.opacity(0.08))
        )
        .padding(.top, 2)
    }
}

// MARK: - Plan section (TodoWrite mirror)

/// Glanceable checklist of the agent's current TodoWrite plan.
///
/// Rendered above the Markdown memory body in `AgentDetailView`. Read-only
/// by design — Dispatch is supervisory, not collaborative editing — so this
/// is a single VStack of `Label` rows. The heading reads "Plan" to match
/// what the agent sees in its own TodoWrite UI; intentionally not branded
/// with Dispatch lexicon (Radar / Trace / etc.) per CLAUDE.md.
private struct PlanSection: View {
    let todos: [Todo]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "checklist")
                    .imageScale(.small)
                    .foregroundStyle(.secondary)
                Text("Plan")
                    .font(.headline)
                Spacer()
                Text("\(completedCount)/\(todos.count)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.tertiary)
            }
            VStack(alignment: .leading, spacing: 4) {
                ForEach(todos) { todo in
                    PlanRow(todo: todo)
                }
            }
        }
    }

    private var completedCount: Int {
        todos.lazy.filter { $0.status == .completed }.count
    }
}

private struct PlanRow: View {
    let todo: Todo

    var body: some View {
        Label {
            Text(label)
                .font(.callout)
                .foregroundStyle(textTint)
                .strikethrough(todo.status == .completed, color: .secondary)
                .lineLimit(2)
        } icon: {
            Text(marker)
                .font(.system(.callout, design: .monospaced))
                .foregroundStyle(markerTint)
                .frame(width: 18, alignment: .leading)
        }
        .labelStyle(.titleAndIcon)
    }

    /// Show the active form when the agent provided one and the row is
    /// in_progress (matches what the agent's own TodoWrite UI does); fall
    /// back to `content` everywhere else.
    private var label: String {
        if todo.status == .inProgress, let active = todo.activeForm, !active.isEmpty {
            return active
        }
        return todo.content
    }

    private var marker: String {
        switch todo.status {
        case .pending:    return "[ ]"
        case .inProgress: return "▶"
        case .completed:  return "[x]"
        }
    }

    private var markerTint: Color {
        switch todo.status {
        case .pending:    return .secondary
        case .inProgress: return .accentColor
        case .completed:  return .green
        }
    }

    private var textTint: Color {
        switch todo.status {
        case .pending:    return .secondary
        case .inProgress: return .primary
        case .completed:  return .secondary
        }
    }
}

// MARK: - Memory pane

struct MemoryPaneView: View {
    let memory: WorkstreamMemory
    let isLoading: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if isLoading && memory.raw.isEmpty {
                    ProgressView().controlSize(.small).padding(20)
                } else if memory.sections.isEmpty {
                    // Fallback: render the entire raw blob via AttributedString.
                    Text(renderMarkdown(memory.raw))
                        .textSelection(.enabled)
                        .padding(.horizontal, 18)
                        .padding(.vertical, 14)
                } else {
                    ForEach(memory.sections) { section in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(section.heading)
                                .font(.headline)
                            Text(renderMarkdown(section.body))
                                .textSelection(.enabled)
                                .font(.callout)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 18)
                    }
                    .padding(.vertical, 14)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// Use `AttributedString(markdown:)` for inline emphasis/links. This is
    /// intentionally minimal — full Markdown (lists, headings, code blocks)
    /// requires a dedicated package, which is out of scope for v0 per spec.
    private func renderMarkdown(_ md: String) -> AttributedString {
        // Render line by line so blank lines and list markers are preserved
        // visually, even though `AttributedString(markdown:)` doesn't render
        // block structure on its own.
        let lines = md.split(separator: "\n", omittingEmptySubsequences: false)
        var result = AttributedString()
        for (idx, line) in lines.enumerated() {
            if let attr = try? AttributedString(
                markdown: String(line),
                options: AttributedString.MarkdownParsingOptions(
                    interpretedSyntax: .inlineOnlyPreservingWhitespace
                )
            ) {
                result.append(attr)
            } else {
                result.append(AttributedString(String(line)))
            }
            if idx < lines.count - 1 {
                result.append(AttributedString("\n"))
            }
        }
        return result
    }
}

#Preview("AgentDetailView (decision tree)") {
    let ws = MockData.workstreams.first(where: { $0.id == "frontend-refactor" })
        ?? MockData.workstreams[0]
    return AgentDetailView(
        workstream: ws,
        client: MockDaemonClient()
    )
    .frame(width: 1100, height: 720)
}

#Preview("AgentDetailView (Plan section)") {
    // frontend-refactor is the mock workstream seeded with a TodoWrite plan
    // (mix of completed / in_progress / pending). Renders the Plan section
    // above the Markdown memory body.
    let ws = MockData.workstreams.first(where: { $0.id == "frontend-refactor" })
        ?? MockData.workstreams[0]
    return AgentDetailView(
        workstream: ws,
        client: MockDaemonClient()
    )
    .frame(width: 1100, height: 720)
}

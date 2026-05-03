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
            .frame(minWidth: 360, idealWidth: 560, maxWidth: .infinity, maxHeight: .infinity)

            VStack(alignment: .leading, spacing: 0) {
                memoryHeader
                Divider()
                MemoryPaneView(
                    memory: WorkstreamMemory(
                        workstreamID: workstream.id,
                        raw: memoryRaw
                    ),
                    isLoading: loadingMemory
                )
            }
            .frame(minWidth: 280, idealWidth: 380, maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationTitle(workstream.title)
        .navigationSubtitle(workstream.id)
        .task(id: workstream.id) {
            // Initial historical fetch (events + memory).
            await reload()
            // Then live-subscribe to new events for this workstream until
            // `.task(id:)` cancels us (workstream change or view disappear).
            // Cancellation propagates into the AsyncStream, which calls
            // its `onTermination` handler to close the underlying WS task.
            let stream = client.streamEvents(workstreamID: workstream.id)
            for await event in stream {
                if Task.isCancelled { break }
                appendLive(event: event)
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
                Text(workstream.title).font(.title2.weight(.semibold))
                Text(workstream.id).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            HStack(spacing: 6) {
                Circle().fill(workstream.statusColor).frame(width: 8, height: 8)
                Text(workstream.statusLabel).font(.caption)
            }
            if workstream.needsAttention {
                Label("Needs you", systemImage: "exclamationmark.bubble.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.orange)
            }
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

    private func reload() async {
        loadingEvents = true
        loadingMemory = true
        async let evs: [Event]   = (try? await client.getEvents(workstreamID: workstream.id)) ?? []
        async let mem: String    = (try? await client.getMemory(workstreamID: workstream.id)) ?? ""
        let (e, m) = await (evs, mem)
        events = e.sorted { $0.ts < $1.ts }
        memoryRaw = m
        loadingEvents = false
        loadingMemory = false
    }

    /// Append a live-streamed event into `events`, skipping duplicates by id
    /// and re-sorting by ts so the timeline stays in chronological order.
    private func appendLive(event: Event) {
        if events.contains(where: { $0.id == event.id }) { return }
        var next = events
        next.append(event)
        next.sort { $0.ts < $1.ts }
        events = next
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
                        ForEach(events) { event in
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
        case .toolUse:                return "wrench.adjustable"
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
        default:                      return .secondary
        }
    }

    private var headline: String {
        switch event.payload {
        case .decision(let d):
            return "Decision: \(d.choice)"
        case .subgoalPush(let s):
            return "Sub-goal pushed: \(s.goal)"
        case .subgoalPop(let s):
            return "Sub-goal popped\(s.goal.map { ": \($0)" } ?? "")"
        case .confidence(let c):
            return "Confidence \(Int((c.value * 100).rounded()))%"
        case .toolUse(let t):
            return "Tool: \(t.tool)"
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
            return t.summary
        case .confidence(let c):
            return c.note
        case .memoryUpdate(let m):
            return m.summary
        default:
            return nil
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

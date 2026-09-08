import AppKit
import SwiftUI

// MARK: - Fleet strip (autonomous mode summary)

/// v1.4.20 — one-line summary of the daemon's autonomous loop, rendered
/// between the digest rail and the kanban when `GET /orchestrator/state`
/// answers (i.e. the daemon was started with `--workflow`). Hidden entirely
/// in observation-only mode so the Radar looks exactly like v1.4.19 there.
///
/// Reads left → right the way the loop runs: *what feeds it* (tracker kind +
/// workflow file) → *how it runs* (runtime + concurrency) → *what's in
/// flight* (running / retrying chips, each with an Attach action when the
/// runtime is tmux).
struct FleetStripView: View {
    let state: OrchestratorState
    /// Tap on a running chip → jump to that workstream's detail.
    let onSelectWorkstream: (String) -> Void

    var body: some View {
        HStack(alignment: .center, spacing: 14) {
            Label {
                Text("Autonomous")
                    .font(.caption.weight(.semibold))
            } icon: {
                Image(systemName: "gearshape.2.fill")
            }
            .foregroundStyle(Resona.Palette.ink)
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .background(Capsule().fill(Resona.Palette.mint.opacity(0.45)))
            .help("The daemon is running a WORKFLOW.md loop: it claims tickets and spawns agents by itself.")

            metaChip(systemImage: "tray.full", text: state.trackerDisplayName,
                     help: "Tracker feeding the loop: \(state.trackerDisplayName)")
            if let path = state.workflowPath {
                metaChip(systemImage: "doc.text", text: (path as NSString).lastPathComponent,
                         help: path)
            }
            metaChip(systemImage: state.isTmuxRuntime ? "terminal" : "cpu",
                     text: state.runtimeDisplayName,
                     help: state.isTmuxRuntime
                        ? "Agents run in tmux panes you can attach to mid-flight."
                        : "Agents run as headless subprocesses; nothing to attach to.")

            Divider().frame(height: 16).overlay(Resona.Palette.stone)

            countChip(label: "running", value: state.counts.running,
                      of: state.maxConcurrentAgents, tint: Resona.Palette.mint)
            countChip(label: "retrying", value: state.counts.retrying, tint: Resona.Palette.butter)
            countChip(label: "completed", value: state.counts.completed, tint: Resona.Palette.lavender)

            if !state.running.isEmpty {
                Divider().frame(height: 16).overlay(Resona.Palette.stone)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(state.running) { run in
                            RunningChip(run: run, onSelect: onSelectWorkstream)
                        }
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 8)
        .background(Resona.Palette.mint.opacity(0.10))
    }

    private func metaChip(systemImage: String, text: String, help: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: systemImage).imageScale(.small)
            Text(text).lineLimit(1).truncationMode(.middle)
        }
        .font(Resona.Typography.caption)
        .foregroundStyle(Resona.Palette.inkSoft)
        .help(help)
    }

    private func countChip(label: String, value: Int, of cap: Int? = nil, tint: Color) -> some View {
        HStack(spacing: 4) {
            Text(cap.map { "\(value)/\($0)" } ?? "\(value)")
                .font(.caption.monospacedDigit().weight(.semibold))
                .foregroundStyle(Resona.Palette.ink)
            Text(label)
                .font(.caption2)
                .foregroundStyle(Resona.Palette.inkSoft)
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(Capsule().fill(tint.opacity(value > 0 ? 0.35 : 0.12)))
        .help(cap.map { "\(value) of \($0) agent slots in use" } ?? "\(value) \(label)")
    }
}

/// One in-flight run. Click → detail; the menu carries the tmux attach
/// action when the daemon exposes one.
private struct RunningChip: View {
    let run: OrchestratorState.RunningEntry
    let onSelect: (String) -> Void

    var body: some View {
        Menu {
            if let ws = run.workstreamID {
                Button {
                    onSelect(ws)
                } label: {
                    Label("Open on the Radar", systemImage: "scope")
                }
            }
            if let attach = run.attach {
                AttachMenuItems(attach: attach)
            }
            if let path = run.workspacePath {
                Divider()
                Button {
                    NSWorkspace.shared.open(URL(fileURLWithPath: path))
                } label: {
                    Label("Reveal workspace", systemImage: "folder")
                }
            }
        } label: {
            HStack(spacing: 4) {
                Circle().fill(Resona.Palette.mint).frame(width: 6, height: 6)
                Text(run.identifier.split(separator: "/").last.map(String.init) ?? run.identifier)
                    .font(.caption.weight(.medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let attempt = run.attempt, attempt > 0 {
                    Text("#\(attempt)")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(Resona.Palette.inkFaint)
                }
                if run.attach != nil {
                    Image(systemName: "terminal").imageScale(.small)
                        .foregroundStyle(Resona.Palette.inkFaint)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Capsule().fill(Resona.Palette.parchment))
            .overlay(Capsule().strokeBorder(Resona.Palette.mint, lineWidth: 1))
            .foregroundStyle(Resona.Palette.ink)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("\(run.identifier) — started \(run.startedAt.formatted(date: .omitted, time: .shortened))")
    }
}

// MARK: - Attach actions (shared by the strip, cards and the detail header)

/// Menu items for a tmux-hosted run: copy the `tmux attach` command, or open
/// Terminal already attached. Opening runs `open -a Terminal` on a tiny
/// generated `.command` file so we never shell out with user-controlled
/// text; the session name is validated to tmux's safe charset first.
struct AttachMenuItems: View {
    let attach: OrchestratorState.Attach

    var body: some View {
        Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(attach.command, forType: .string)
        } label: {
            Label("Copy attach command", systemImage: "doc.on.doc")
        }
        .help(attach.command)
        Button {
            AttachLauncher.openTerminalAttached(to: attach.tmuxSession)
        } label: {
            Label("Attach in Terminal", systemImage: "terminal")
        }
        .help("Opens Terminal.app running `\(attach.command)`")
    }
}

enum AttachLauncher {
    /// tmux session names the daemon generates: `dispatch-<slug>-sess_<hex>`.
    static func isSafeSessionName(_ name: String) -> Bool {
        !name.isEmpty && name.unicodeScalars.allSatisfy {
            CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "_"
        }
    }

    static func openTerminalAttached(to session: String) {
        guard isSafeSessionName(session) else { return }
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("dispatch-attach", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("\(session).command")
        let script = "#!/bin/sh\nexec tmux attach -t '\(session)'\n"
        guard (try? script.write(to: file, atomically: true, encoding: .utf8)) != nil else { return }
        try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
        NSWorkspace.shared.open(file)
    }
}

// MARK: - Tracker chip (Linear or team-brain)

/// Tracker-link chip. Replaces the v1.2 Linear-only `LinearChip`: the copy,
/// icon and open action follow `link.trackerKind`, and the linked state's
/// tracker status (`In Progress` / `implemented-pending-pr`) is shown inline
/// so the human can see where the ticket/plan is without opening it.
///
/// - **Linked**: icon + short identifier + state; menu: open, unlink.
/// - **Unlinked** (`link == nil`): a "Link…" button when `onLink` is set.
///   Manual linking is Linear-only server-side, so team-brain workstreams
///   only ever arrive here already linked by the orchestrator.
struct TrackerChip: View {
    let link: WorkstreamLink?
    var compact: Bool = false
    var onLink: (() -> Void)? = nil
    var onUnlink: (() -> Void)? = nil

    var body: some View {
        if let link {
            Menu {
                if let url = link.openURL {
                    Button {
                        NSWorkspace.shared.open(url)
                    } label: {
                        Label(link.openLabel, systemImage: "arrow.up.right.square")
                    }
                }
                if let state = link.lastSeenState {
                    Text("\(link.trackerDisplayName) state: \(state)")
                }
                if let onUnlink {
                    Divider()
                    Button(role: .destructive, action: onUnlink) {
                        Label("Unlink", systemImage: "link.badge.plus")
                    }
                }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: link.symbolName).imageScale(.small)
                    Text(link.shortIdentifier)
                        .font(.caption.weight(.medium))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if !compact, let state = link.lastSeenState {
                        Text(state)
                            .font(.caption2)
                            .foregroundStyle(Resona.Palette.inkSoft)
                            .lineLimit(1)
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, compact ? 2 : 4)
                .background(Capsule().fill(tint.opacity(0.45)))
                .overlay(Capsule().strokeBorder(tint, lineWidth: 1))
                .foregroundStyle(Resona.Palette.ink)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help(helpText(for: link))
        } else if let onLink {
            Button(action: onLink) {
                Label("Link…", systemImage: "link").labelStyle(.titleAndIcon)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .help("Link this workstream to a Linear issue")
        }
    }

    private var tint: Color {
        link?.isTeamBrain == true ? Resona.Palette.sky : Resona.Palette.lavender
    }

    private func helpText(for link: WorkstreamLink) -> String {
        var s = "Linked to \(link.trackerDisplayName) \(link.noun) \(link.issueIdentifier)"
        if let state = link.lastSeenState { s += " — \(state)" }
        return s
    }
}

// MARK: - Autonomous badge

/// Small "Autonomous" pill for cards and the detail header while the
/// orchestrator has a turn in flight on that workstream.
struct AutonomousBadge: View {
    var attachable: Bool = false

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: attachable ? "terminal.fill" : "gearshape.2.fill").imageScale(.small)
            Text("Autonomous")
        }
        .font(.caption2.weight(.semibold))
        .foregroundStyle(Resona.Palette.ink)
        .padding(.horizontal, 7)
        .padding(.vertical, 2)
        .background(Capsule().fill(Resona.Palette.mint.opacity(0.45)))
        .help(attachable
              ? "Driven by the orchestrator in a tmux pane — attach from the card menu to take over."
              : "Driven by the orchestrator right now (headless run).")
    }
}

#if DEBUG
#Preview("FleetStripView") {
    FleetStripView(state: MockData.orchestratorState, onSelectWorkstream: { _ in })
        .frame(width: 900)
        .background(Resona.Gradients.appBackground)
}

#Preview("TrackerChip") {
    HStack {
        TrackerChip(link: MockData.links["search-rerank"], onUnlink: {})
        TrackerChip(link: MockData.links["search-rerank"], compact: true)
        TrackerChip(link: nil, onLink: {})
        AutonomousBadge(attachable: true)
    }
    .padding()
}
#endif

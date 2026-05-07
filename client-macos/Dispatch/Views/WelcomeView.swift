import SwiftUI

/// First-launch / empty-state screen that replaces the old "render mock
/// fixtures" behaviour. Two flavours: `welcome` (daemon up, no workstreams
/// yet — onboarding) and `daemonDown` (we tried, daemon didn't respond —
/// recovery). HomeView picks the flavour from `DaemonResolver.modeReason`.
struct WelcomeView: View {
    enum Mode {
        /// Live daemon healthy, just no workstreams created yet.
        case welcome
        /// Daemon unreachable — bundled .app's launchd agent likely not
        /// up yet. Show a retry button and the bundled-tutorial pointer.
        case daemonDown(retry: () -> Void)
    }

    let mode: Mode
    @State private var copied: Bool = false
    @State private var retrying: Bool = false

    private static let snippet = "cd ~/Code/your-project\nclaude"

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                Spacer(minLength: 40)
                card
                    .frame(maxWidth: 560)
                    .padding(.horizontal, 32)
                Spacer(minLength: 40)
            }
            .frame(maxWidth: .infinity)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 18) {
            header
            Divider()
            body(for: mode)
            Divider()
            footerLinks
        }
        .padding(28)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color(nsColor: .controlBackgroundColor))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color.gray.opacity(0.22), lineWidth: 1)
        )
    }

    @ViewBuilder
    private var header: some View {
        switch mode {
        case .welcome:
            HStack(spacing: 12) {
                Image(systemName: "dot.radiowaves.left.and.right")
                    .imageScale(.large)
                    .foregroundStyle(.green)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Welcome to Dispatch")
                        .font(.title2.weight(.semibold))
                    Text("Mission control for AI agents — open a terminal in any project and run `claude`. This window is the Radar.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        case .daemonDown:
            HStack(spacing: 12) {
                Image(systemName: "antenna.radiowaves.left.and.right.slash")
                    .imageScale(.large)
                    .foregroundStyle(.orange)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Daemon not running")
                        .font(.title2.weight(.semibold))
                    Text("Dispatch couldn't reach the brain on localhost:9876. Run `dispatch start` in a terminal, or check Settings → Daemon.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    @ViewBuilder
    private func body(for mode: Mode) -> some View {
        switch mode {
        case .welcome:
            VStack(alignment: .leading, spacing: 14) {
                step(number: 1,
                     title: "Daemon healthy",
                     detail: "The brain on localhost:9876 is up. You're good to go.")
                step(number: 2,
                     title: "Open a terminal in any project, run `claude`",
                     detail: "Dispatch's hooks register the session automatically — no extra setup.")
                codeBlock
                step(number: 3,
                     title: "Watch the Radar populate",
                     detail: "A workstream card lights up here within seconds. Click it to see the Trace and open an Intercept.")
            }
        case .daemonDown(let retry):
            VStack(alignment: .leading, spacing: 12) {
                Text("Common causes")
                    .font(.headline)
                VStack(alignment: .leading, spacing: 6) {
                    bullet("First launch — the launchd agent is still starting. Click Start daemon below.")
                    bullet("Node 20+ not on PATH. The daemon shells out to `node`; install via `brew install node`.")
                    bullet("Port 9876 occupied by something else.")
                }
                .font(.callout)
                .foregroundStyle(.secondary)

                HStack {
                    Button {
                        retrying = true
                        retry()
                        Task {
                            try? await Task.sleep(for: .milliseconds(800))
                            retrying = false
                        }
                    } label: {
                        if retrying {
                            ProgressView().controlSize(.small)
                        } else {
                            Label("Start daemon", systemImage: "play.circle")
                        }
                    }
                    .controlSize(.large)
                    .disabled(retrying)
                    .help("Re-probe the daemon and kick the launchd agent if needed.")
                    Spacer()
                }
            }
        }
    }

    private var footerLinks: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "book")
                    .foregroundStyle(.tertiary)
                Button("Tutorial") {
                    if let url = bundledDoc("TUTORIAL.md") {
                        NSWorkspace.shared.open(url)
                    }
                }
                .buttonStyle(.link)
                .help("Open the bundled tutorial — also available under Help → Tutorial.")
                Text("·")
                    .foregroundStyle(.tertiary)
                Button("Providers (local model)") {
                    NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
                }
                .buttonStyle(.link)
                .help("Open Settings → Providers (⌘,) to pick a local model or set ANTHROPIC_API_KEY.")
                Text("·")
                    .foregroundStyle(.tertiary)
                Button("Architecture") {
                    if let url = bundledDoc("ARCHITECTURE.md") {
                        NSWorkspace.shared.open(url)
                    }
                }
                .buttonStyle(.link)
                .help("docs/ARCHITECTURE.md — wire contract, event schema, components.")
            }
            .font(.callout)
        }
    }

    private func bullet(_ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("•")
            Text(.init(text))
        }
    }

    private func step(number: Int, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text("\(number)")
                .font(.system(.callout, design: .rounded).weight(.semibold))
                .foregroundStyle(.white)
                .frame(width: 24, height: 24)
                .background(
                    Circle().fill(Color.accentColor)
                )
            VStack(alignment: .leading, spacing: 2) {
                Text(.init(title))
                    .font(.callout.weight(.semibold))
                Text(.init(detail))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var codeBlock: some View {
        ZStack(alignment: .topTrailing) {
            Text(Self.snippet)
                .font(.system(.callout, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .padding(.trailing, 64)
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Color.black.opacity(0.06))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(Color.gray.opacity(0.18), lineWidth: 1)
                )

            Button {
                let pb = NSPasteboard.general
                pb.clearContents()
                pb.setString(Self.snippet, forType: .string)
                copied = true
                Task {
                    try? await Task.sleep(for: .seconds(1.5))
                    copied = false
                }
            } label: {
                Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                    .labelStyle(.titleAndIcon)
                    .font(.caption)
            }
            .buttonStyle(.bordered)
            .padding(8)
            .help("Copy command to the clipboard.")
        }
        .padding(.leading, 36)
    }

    private func bundledDoc(_ name: String) -> URL? {
        guard let resources = Bundle.main.resourceURL else { return nil }
        let candidate = resources
            .appendingPathComponent("docs", isDirectory: true)
            .appendingPathComponent(name)
        return FileManager.default.fileExists(atPath: candidate.path) ? candidate : nil
    }
}

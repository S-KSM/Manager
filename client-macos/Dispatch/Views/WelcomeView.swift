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
                    Text("Mission control for AI agents.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
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
                    Text("Dispatch couldn't reach the brain on localhost:9876.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder
    private func body(for mode: Mode) -> some View {
        switch mode {
        case .welcome:
            VStack(alignment: .leading, spacing: 12) {
                Text("Start a workstream")
                    .font(.headline)
                Text("`cd` into any project and run `claude`. Dispatch's hooks register the session and a card lights up here within seconds.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                codeBlock
            }
        case .daemonDown(let retry):
            VStack(alignment: .leading, spacing: 12) {
                Text("Common causes")
                    .font(.headline)
                VStack(alignment: .leading, spacing: 6) {
                    bullet("First launch — the launchd agent is still starting. Click Retry.")
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
                            Label("Retry", systemImage: "arrow.clockwise")
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
                Button("Open the tutorial") {
                    if let url = bundledDoc("TUTORIAL.md") {
                        NSWorkspace.shared.open(url)
                    }
                }
                .buttonStyle(.link)
                .help("docs/TUTORIAL.md — 30-minute walk-through.")
                Text("·")
                    .foregroundStyle(.tertiary)
                Button("Local model setup") {
                    if let url = bundledDoc("LOCAL_MODELS.md") {
                        NSWorkspace.shared.open(url)
                    }
                }
                .buttonStyle(.link)
                .help("docs/LOCAL_MODELS.md — wire up Ollama or set ANTHROPIC_API_KEY.")
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
            .help("Copy the snippet to the clipboard.")
        }
    }

    private func bundledDoc(_ name: String) -> URL? {
        guard let resources = Bundle.main.resourceURL else { return nil }
        let candidate = resources
            .appendingPathComponent("docs", isDirectory: true)
            .appendingPathComponent(name)
        return FileManager.default.fileExists(atPath: candidate.path) ? candidate : nil
    }
}

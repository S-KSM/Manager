import SwiftUI

/// Cmd-, Settings window. Single tab today (Daemon status). The LLM
/// provider tab is deferred to v1.3 — Help → Local model setup walks the
/// user through Ollama + Anthropic API key in the meantime.
struct PreferencesView: View {
    let client: DaemonClientProtocol

    var body: some View {
        TabView {
            DaemonStatusSettings()
                .tabItem { Label("Daemon", systemImage: "gearshape") }
        }
        .frame(width: 560, height: 360)
    }
}

private struct DaemonStatusSettings: View {
    @EnvironmentObject private var resolver: DaemonResolver

    var body: some View {
        Form {
            Section("Status") {
                LabeledContent("Mode") {
                    Text(resolver.mode == .live ? "Live daemon" : "Mock data")
                }
                LabeledContent("Reason") {
                    Text(reasonText(resolver.modeReason))
                        .foregroundStyle(.secondary)
                }
            }

            Section("Bundled daemon") {
                if let url = LaunchdInstaller.bundledDaemonURL {
                    Text(url.path)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                    Text("First launch writes a launchd agent pointing at this file. Move the .app and the agent rewires itself on next launch.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Text("Running a dev build (no daemon embedded). Use bin/install.sh to register the launchd agent against daemon/dist/index.js.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Section("Local model") {
                Text("Configure Anthropic API key or Ollama via Help → Local model setup. Per-request provider selection lives in the New Update sheet.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            HStack {
                Spacer()
                Button("Retry / Start daemon") { Task { await resolver.retryConnection() } }
                    .help("Re-probe the daemon; if it's down, kick the launchd agent.")
            }
        }
        .padding(20)
    }

    private func reasonText(_ r: DaemonResolver.ModeReason) -> String {
        switch r {
        case .unknown:         return "Probing…"
        case .liveHealthy:     return "Daemon answered /health."
        case .liveUnreachable: return "Daemon did not respond."
        case .envOverride:     return "DISPATCH_DAEMON=mock env var."
        case .userToggled:     return "Toggled via Cmd-Shift-M."
        case .forced:          return "Preview / test override."
        }
    }
}

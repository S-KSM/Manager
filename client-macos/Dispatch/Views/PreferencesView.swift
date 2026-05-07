import SwiftUI

/// Cmd-, Settings window. Two tabs:
///   - Daemon: live/mock status + bundled daemon hint.
///   - Providers: pick the LLM that powers activity headlines + sub-goal
///     synthesis (the "summary" features), and stash an Anthropic API key /
///     Ollama URL without touching env vars.
struct PreferencesView: View {
    let client: DaemonClientProtocol

    var body: some View {
        TabView {
            DaemonStatusSettings()
                .tabItem { Label("Daemon", systemImage: "gearshape") }
            ProvidersSettings(client: client)
                .tabItem { Label("Providers", systemImage: "cpu") }
        }
        .frame(width: 560, height: 420)
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

/// Local-model + API-key settings. Backed by `GET/PATCH /settings`.
///
/// Layout:
///   - Provider segmented picker (Claude / Ollama).
///   - Model TextField (placeholder shows the per-provider default).
///   - Ollama URL TextField (only enabled when Ollama is selected, but
///     always editable so a user can pre-fill before switching).
///   - Anthropic API key SecureField with placeholder reflecting whether the
///     daemon already has a key on file.
///   - Status row: daemon /health probe + a quick provider reachability hint.
private struct ProvidersSettings: View {
    let client: DaemonClientProtocol

    @State private var loaded = false
    @State private var loadingError: String?

    @State private var provider: ProviderSettings.Provider = .ollama
    @State private var model: String = ""
    @State private var ollamaURL: String = "http://localhost:8080/v1"
    @State private var anthropicAPIKey: String = ""
    @State private var anthropicConfigured = false
    @State private var linearAPIKey: String = ""
    @State private var linearConfigured = false

    @State private var saving = false
    @State private var saveError: String?
    @State private var savedAt: Date?

    @State private var daemonReachable: Bool?
    @State private var providerReachable: Bool?
    @State private var probing = false

    var body: some View {
        Form {
            Section("Provider") {
                Picker("Powers summaries", selection: $provider) {
                    ForEach(ProviderSettings.Provider.allCases) { p in
                        Text(p.displayName).tag(p)
                    }
                }
                .pickerStyle(.segmented)

                TextField("Model", text: $model, prompt: Text(modelPlaceholder))
                    .textFieldStyle(.roundedBorder)
                    .help("The model id sent to the provider. Leave blank to use the daemon's default for this provider.")

                if provider == .ollama {
                    TextField("Local LLM URL", text: $ollamaURL,
                              prompt: Text("http://localhost:8080/v1"))
                        .textFieldStyle(.roundedBorder)
                        .help("Base URL for your OpenAI-compatible local LLM server. Defaults to mlx_lm.server (port 8080); for Ollama, use http://localhost:11434.")
                }
            }

            Section("Anthropic API key") {
                SecureField(anthropicConfigured ? "•••• configured" : "sk-ant-…",
                            text: $anthropicAPIKey)
                    .textFieldStyle(.roundedBorder)
                    .help("Required only when Provider = Claude. Stored in ~/.claude/dispatch/settings.json with 0600 permissions; never returned by the daemon once saved.")
                if anthropicConfigured && anthropicAPIKey.isEmpty {
                    Text("A key is on file. Type a new one to replace it; clear and save to remove it.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Section("Linear API key") {
                SecureField(linearConfigured ? "•••• configured" : "lin_api_…",
                            text: $linearAPIKey)
                    .textFieldStyle(.roundedBorder)
                    .help("Required for the Link-to-Linear chip in the agent detail view, plus the bidirectional Linear sync. Same redaction + storage as the Anthropic key.")
                if linearConfigured && linearAPIKey.isEmpty {
                    Text("A key is on file. Type a new one to replace it; clear and save to remove it.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Section("Connectivity") {
                LabeledContent("Daemon") {
                    statusBadge(reachable: daemonReachable, probing: probing,
                                okText: "Connected", failText: "Unreachable")
                }
                LabeledContent(provider == .claude ? "Anthropic" : "Local LLM") {
                    statusBadge(reachable: providerReachable, probing: probing,
                                okText: "Reachable",
                                failText: provider == .ollama ? "Not reachable" : "Key missing")
                }
                Button("Test now") { Task { await probe() } }
                    .disabled(probing)
                    .help("Probe the daemon and the selected provider")
            }

            HStack {
                if let err = loadingError ?? saveError {
                    Text(err)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .lineLimit(2)
                } else if let savedAt {
                    Text("Saved \(savedAt.formatted(date: .omitted, time: .standard)).")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Save") { Task { await save() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(saving || !loaded)
                    .help("Save provider, model, and key changes")
            }
        }
        .padding(20)
        .task {
            await load()
            await probe()
        }
    }

    private var modelPlaceholder: String {
        provider == .claude ? "claude-haiku-4-5-20251001" : "qwen3:4b"
    }

    private func load() async {
        do {
            let s = try await client.getSettings()
            provider = s.headlineProvider
            model = s.headlineModel
            ollamaURL = s.ollamaURL
            anthropicConfigured = s.anthropicAPIKeyConfigured
            linearConfigured = s.linearAPIKeyConfigured
            anthropicAPIKey = ""
            linearAPIKey = ""
            loaded = true
            loadingError = nil
        } catch {
            loadingError = "Couldn't read settings: \(error.localizedDescription)"
            // Still let the user edit + save; PATCH will return the same error
            // shape if the daemon is down.
            loaded = true
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        var patch = ProviderSettingsPatch()
        patch.headlineProvider = provider
        patch.headlineModel = model
        patch.ollamaURL = ollamaURL
        // Only send the key when the user typed something — otherwise we'd
        // either clobber an existing key with `""` or echo the placeholder.
        if !anthropicAPIKey.isEmpty {
            patch.anthropicAPIKey = anthropicAPIKey
        }
        if !linearAPIKey.isEmpty {
            patch.linearAPIKey = linearAPIKey
        }
        do {
            let s = try await client.patchSettings(patch)
            provider = s.headlineProvider
            model = s.headlineModel
            ollamaURL = s.ollamaURL
            anthropicConfigured = s.anthropicAPIKeyConfigured
            linearConfigured = s.linearAPIKeyConfigured
            anthropicAPIKey = ""
            linearAPIKey = ""
            saveError = nil
            savedAt = Date()
            // Probe again now that settings have changed (URL / provider may
            // have moved underneath us).
            await probe()
        } catch {
            saveError = "Save failed: \(error.localizedDescription)"
        }
    }

    /// Cheap reachability check: daemon /health, then a quick HEAD/GET on the
    /// chosen provider. We deliberately keep this off the LLM API surface so
    /// it doesn't burn tokens.
    private func probe() async {
        probing = true
        defer { probing = false }
        daemonReachable = await client.health()

        switch provider {
        case .ollama:
            providerReachable = await probeOllama(url: ollamaURL)
        case .claude:
            // No-cost probe: we treat "key configured OR typed" as reachable.
            // A real round-trip would charge the user a token; surfacing a
            // network probe to api.anthropic.com would also leak that we ran
            // one. The actual auth check happens on the next summary tick.
            providerReachable = anthropicConfigured || !anthropicAPIKey.isEmpty
        }
    }

    /// Cheap reachability probe for any OpenAI-compatible local LLM server
    /// (mlx_lm.server / Ollama / llama.cpp). Hits `GET <baseUrl>/models`,
    /// the OpenAI-compat list endpoint. A 404 means we got a TCP response
    /// from *something* but it doesn't speak the API — treat as reachable
    /// so the user can still see "the box is up" and fix the URL. Network
    /// errors / refusal → not reachable.
    private func probeOllama(url: String) async -> Bool {
        guard let base = URL(string: url) else { return false }
        let modelsURL = base.appendingPathComponent("models")
        var req = URLRequest(url: modelsURL)
        req.timeoutInterval = 1.5
        do {
            let (_, response) = try await URLSession.shared.data(for: req)
            if let http = response as? HTTPURLResponse {
                if (200..<500).contains(http.statusCode) {
                    return true
                }
                return false
            }
            return false
        } catch {
            // 404 fallback: try a bare TCP-ish check on the host:port via a
            // root GET. If the host answers anything, the server is up.
            if let host = base.host {
                var components = URLComponents()
                components.scheme = base.scheme
                components.host = host
                if let port = base.port { components.port = port }
                components.path = "/"
                if let rootURL = components.url {
                    var rootReq = URLRequest(url: rootURL)
                    rootReq.timeoutInterval = 1.5
                    if let (_, rootResp) = try? await URLSession.shared.data(for: rootReq),
                       rootResp is HTTPURLResponse {
                        return true
                    }
                }
            }
            return false
        }
    }

    @ViewBuilder
    private func statusBadge(reachable: Bool?, probing: Bool,
                             okText: String, failText: String) -> some View {
        if probing {
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text("Checking…").foregroundStyle(.secondary)
            }
        } else if let reachable {
            HStack(spacing: 6) {
                Circle()
                    .fill(reachable ? .green : .red)
                    .frame(width: 8, height: 8)
                Text(reachable ? okText : failText)
                    .foregroundStyle(.secondary)
            }
        } else {
            Text("Unknown").foregroundStyle(.secondary)
        }
    }
}

#if DEBUG
#Preview("Providers — Ollama default") {
    PreferencesView(client: MockDaemonClient(simulatedLatency: .zero))
        .environmentObject(DaemonResolver())
}
#endif
